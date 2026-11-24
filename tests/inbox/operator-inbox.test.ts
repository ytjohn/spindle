import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { MemoryEngine } from "../../src/memory/engine";
import { InboxEngine } from "../../src/inbox/engine";
import type { ResolvedInboxConfig } from "../../src/inbox/types";

async function boot(root: string): Promise<{
  memory: MemoryEngine;
  inbox: InboxEngine;
  operatorRoot: string;
}> {
  const memory = await MemoryEngine.open(
    { enabled: true, database_path: join(root, "memory.db") },
    {},
    root
  );
  memory.registerAgent("eliza-inbox", "Eliza");
  const mailRoot = join(root, "mail");
  const operatorRoot = join(root, "operator-mail");
  const config: ResolvedInboxConfig = {
    agentId: "eliza-inbox",
    agentDisplayName: "Eliza",
    mailRoot,
    operatorMailRoot: operatorRoot,
    pollIntervalMs: 30000,
    contacts: [],
  };
  const inbox = await InboxEngine.open({ memory, config });
  return { memory, inbox, operatorRoot };
}

describe("operator inbox view", () => {
  let root: string;
  let memory: MemoryEngine;
  let inbox: InboxEngine;
  let operatorRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "spindle-op-inbox-"));
    ({ memory, inbox, operatorRoot } = await boot(root));
  });

  afterEach(async () => {
    inbox.close();
    memory.close();
    await rm(root, { recursive: true, force: true });
  });

  it("surfaces operator-addressed sends + falls unrouted through to operator", async () => {
    // 1) direct to operator
    inbox.send({
      to: "operator",
      from: "Eliza",
      fromAuth: "agent:eliza-inbox",
      subject: "direct",
      body: "a direct note",
    });
    // 2) unrouted recipient
    inbox.send({
      to: "ghost-agent",
      from: "Eliza",
      fromAuth: "agent:eliza-inbox",
      subject: "lost",
      body: "where am I",
    });

    const items = inbox.listOperatorInbox();
    expect(items).toHaveLength(2);
    const subjects = items.map((i) => i.subject).sort();
    expect(subjects).toEqual(["direct", "lost"]);
    const unrouted = items.find((i) => i.subject === "lost")!;
    expect(unrouted.originalRecipient).toBe("ghost-agent");
    const direct = items.find((i) => i.subject === "direct")!;
    expect(direct.originalRecipient).toBeNull();

    // Status summary.
    const status = inbox.getOperatorInboxStatus();
    expect(status.unreadCount).toBe(2);
    expect(status.unreadSenders).toEqual(["Eliza"]);
  });

  it("supports markRead + markUnread + tombstone + restore via fs moves", async () => {
    inbox.send({
      to: "operator",
      from: "Eliza",
      fromAuth: "agent:eliza-inbox",
      body: "hi",
    });
    const initial = inbox.listOperatorInbox();
    expect(initial).toHaveLength(1);
    const id = initial[0].id;

    const read = inbox.markOperatorRead(id);
    expect(read?.status).toBe("read");
    expect(existsSync(join(operatorRoot, "inbox", `${id}.md`))).toBe(false);
    expect(existsSync(join(operatorRoot, "inbox/read", `${id}.md`))).toBe(true);

    const unread = inbox.markOperatorUnread(id);
    expect(unread?.status).toBe("unread");
    expect(existsSync(join(operatorRoot, "inbox", `${id}.md`))).toBe(true);

    const tombstoned = inbox.tombstoneOperator(id);
    expect(tombstoned?.status).toBe("tombstoned");
    expect(existsSync(join(operatorRoot, "inbox/tombstoned", `${id}.md`))).toBe(true);

    const restored = inbox.restoreOperator(id);
    expect(restored?.status).toBe("unread");
    expect(existsSync(join(operatorRoot, "inbox", `${id}.md`))).toBe(true);
  });

  it("returns null for missing id / wrong current status", () => {
    expect(inbox.markOperatorRead("does-not-exist")).toBeNull();
    expect(inbox.markOperatorUnread("does-not-exist")).toBeNull();
    expect(inbox.tombstoneOperator("does-not-exist")).toBeNull();
    expect(inbox.restoreOperator("does-not-exist")).toBeNull();
  });

  it("getOperatorAttachment streams attachment bytes when present", async () => {
    // Write a multi-file message directly into operator inbox
    const msgDir = join(operatorRoot, "inbox", "msg-with-att");
    await mkdir(msgDir, { recursive: true });
    await writeFile(
      join(msgDir, "message.md"),
      `---
id: msg-with-att
from_auth: agent:eliza-inbox
from: Eliza
to: operator
subject: with attachment
date: 2026-04-18T12:00:00Z
---

see attached
`
    );
    await writeFile(join(msgDir, "report.pdf"), "pdf-bytes");

    const items = inbox.listOperatorInbox();
    expect(items).toHaveLength(1);
    expect(items[0].attachments).toHaveLength(1);
    expect(items[0].attachments[0].filename).toBe("report.pdf");

    const att = inbox.getOperatorAttachment("msg-with-att", "report.pdf");
    expect(att).not.toBeNull();
    expect(att!.contentType).toBe("application/pdf");
    expect(att!.sizeBytes).toBe(9);
  });

  it("getOperatorAttachment rejects path-traversal filenames", () => {
    expect(
      inbox.getOperatorAttachment("whatever", "../../../etc/passwd")
    ).toBeNull();
  });
});
