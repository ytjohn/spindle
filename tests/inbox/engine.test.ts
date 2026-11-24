import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir, stat } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { MemoryEngine } from "../../src/memory/engine";
import { InboxEngine } from "../../src/inbox/engine";
import type { ResolvedInboxConfig } from "../../src/inbox/types";

const AGENT_ID = "eliza";
const AGENT_NAME = "Eliza";

async function bootEngines(root: string): Promise<{
  memory: MemoryEngine;
  inbox: InboxEngine;
  mailRoot: string;
  operatorMailRoot: string;
}> {
  const memory = await MemoryEngine.open(
    { enabled: true, database_path: join(root, "memory.db") },
    {},
    root
  );
  memory.registerAgent(AGENT_ID, AGENT_NAME);
  const mailRoot = join(root, "mail");
  const operatorMailRoot = join(root, "operator-mail");
  const config: ResolvedInboxConfig = {
    agentId: AGENT_ID,
    agentDisplayName: AGENT_NAME,
    mailRoot,
    operatorMailRoot,
    pollIntervalMs: 30000,
    contacts: [],
  };
  const inbox = await InboxEngine.open({ memory, config });
  return { memory, inbox, mailRoot, operatorMailRoot };
}

describe("InboxEngine — routing", () => {
  let root: string;
  let memory: MemoryEngine;
  let inbox: InboxEngine;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "spindle-inbox-engine-routing-"));
    ({ memory, inbox } = await bootEngines(root));
  });

  afterEach(async () => {
    inbox.close();
    memory.close();
    await rm(root, { recursive: true, force: true });
  });

  it("seeds self, owner-agent-id, and operator routes on open", () => {
    const routes = inbox.listRoutes();
    const ids = routes.map((r) => r.agentId).sort();
    expect(ids).toEqual(["eliza", "operator", "self"].sort());
    const self = inbox.getRoute("self")!;
    expect(self.mailRoot).toBe(inbox.getMailRoot());
    expect(self.createdBy).toBe("self");
    const operator = inbox.getRoute("operator")!;
    expect(operator.mailRoot).toBe(inbox.getOperatorMailRoot());
  });

  it("resolves 'self' and owner agent id to the same route", () => {
    const a = inbox.resolveRoute("self");
    const b = inbox.resolveRoute("eliza");
    expect(a?.mailRoot).toBe(b?.mailRoot);
  });

  it("returns null for unknown recipients", () => {
    expect(inbox.resolveRoute("totally-unknown")).toBeNull();
  });

  it("upserts + updates a contact route", () => {
    const first = inbox.upsertRoute({
      agentId: "juno",
      mailRoot: "/tmp/juno-mail",
      displayName: "Juno",
      capabilities: ["tasks"],
    });
    expect(first.agentId).toBe("juno");
    expect(first.capabilities).toEqual(["tasks"]);

    const second = inbox.upsertRoute({
      agentId: "juno",
      mailRoot: "/tmp/juno-mail-new",
      displayName: "Juno (updated)",
    });
    expect(second.mailRoot).toBe("/tmp/juno-mail-new");
    expect(second.displayName).toBe("Juno (updated)");
  });

  it("rejects deletion of reserved routes", () => {
    expect(() => inbox.deleteRoute("self")).toThrow();
    expect(() => inbox.deleteRoute("operator")).toThrow();
    expect(() => inbox.deleteRoute("eliza")).toThrow();
  });

  it("deletes a non-reserved route", () => {
    inbox.upsertRoute({
      agentId: "bob",
      mailRoot: "/tmp/bob-mail",
      displayName: "Bob",
    });
    expect(inbox.getRoute("bob")).not.toBeNull();
    expect(inbox.deleteRoute("bob")).toBe(true);
    expect(inbox.getRoute("bob")).toBeNull();
  });

  it("touchRouteLastSeen updates last_seen_at only", () => {
    inbox.upsertRoute({
      agentId: "juno",
      mailRoot: "/tmp/juno-mail",
      displayName: "Juno",
    });
    const before = inbox.getRoute("juno")!;
    expect(before.lastSeenAt).toBeNull();
    inbox.touchRouteLastSeen("juno", 1745000000000);
    const after = inbox.getRoute("juno")!;
    expect(after.lastSeenAt).toBe(1745000000000);
  });
});

describe("InboxEngine — send", () => {
  let root: string;
  let memory: MemoryEngine;
  let inbox: InboxEngine;
  let mailRoot: string;
  let operatorMailRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "spindle-inbox-engine-send-"));
    ({ memory, inbox, mailRoot, operatorMailRoot } = await bootEngines(root));
  });

  afterEach(async () => {
    inbox.close();
    memory.close();
    await rm(root, { recursive: true, force: true });
  });

  it("delivers to a routed recipient and retains an outbox copy", async () => {
    const junoMail = join(root, "juno-mail");
    await mkdir(junoMail, { recursive: true });
    inbox.upsertRoute({
      agentId: "juno",
      mailRoot: junoMail,
      displayName: "Juno",
    });
    const result = inbox.send({
      to: "juno",
      from: "Eliza",
      fromAuth: "agent:eliza",
      subject: "ping",
      body: "hello juno",
      now: Date.parse("2026-04-17T10:00:00Z"),
    });
    expect(result.deliveryStatus).toBe("delivered");
    expect(result.deliveredTo).toBe("juno");
    expect(result.outboxRetained).toBe(true);
    // Delivered file exists at the recipient's inbox/{id}.md.
    const junoFiles = await readdir(join(junoMail, "inbox"));
    expect(junoFiles.some((f) => f.endsWith(".md"))).toBe(true);
    // Outbox copy exists.
    const outFiles = await readdir(join(mailRoot, "outbox"));
    expect(outFiles.some((f) => f.endsWith(".md"))).toBe(true);
  });

  it("falls through to operator inbox when recipient is unknown", async () => {
    const result = inbox.send({
      to: "ghost-agent",
      from: "Eliza",
      fromAuth: "agent:eliza",
      subject: "lost message",
      body: "where am i?",
    });
    expect(result.deliveryStatus).toBe("unrouted");
    expect(result.deliveredTo).toBe("operator");
    // File landed in operator inbox.
    const opFiles = await readdir(join(operatorMailRoot, "inbox"));
    expect(opFiles.some((f) => f.endsWith(".md"))).toBe(true);
    // Outbox copy has the unrouted delivery_status.
    const outFiles = await readdir(join(mailRoot, "outbox"));
    const out = outFiles.find((f) => f.endsWith(".md"))!;
    const contents = await readFile(join(mailRoot, "outbox", out), "utf8");
    expect(contents).toContain("delivery_status: unrouted");
    expect(contents).toContain("original_recipient: ghost-agent");
  });

  it("writes multi-file message dir + attachments", async () => {
    // Prepare attachment source bytes on disk.
    const attDir = join(root, "source-att");
    await mkdir(attDir, { recursive: true });
    await writeFile(join(attDir, "report.pdf"), "pdf-bytes");
    await writeFile(join(attDir, "notes.txt"), "note-bytes");

    const junoMail = join(root, "juno-mail");
    await mkdir(junoMail, { recursive: true });
    inbox.upsertRoute({
      agentId: "juno",
      mailRoot: junoMail,
      displayName: "Juno",
    });

    const result = inbox.send({
      to: "juno",
      from: "Eliza",
      fromAuth: "agent:eliza",
      subject: "with attachments",
      body: "see attached",
      attachments: [
        { filename: "report.pdf", sourceAbsPath: join(attDir, "report.pdf") },
        { filename: "notes.txt", sourceAbsPath: join(attDir, "notes.txt") },
      ],
    });
    expect(result.deliveryStatus).toBe("delivered");
    // Delivered to a directory (multi-file).
    const junoEntries = await readdir(join(junoMail, "inbox"));
    const msgDir = junoEntries.find((e) => !e.endsWith(".md"))!;
    const junoFiles = await readdir(join(junoMail, "inbox", msgDir));
    expect(junoFiles.sort()).toEqual(
      ["message.md", "notes.txt", "report.pdf"].sort()
    );
    // Outbox retained copy exists with same structure.
    const outEntries = await readdir(join(mailRoot, "outbox"));
    const outDir = outEntries.find((e) => !e.endsWith(".md"))!;
    const outFiles = await readdir(join(mailRoot, "outbox", outDir));
    expect(outFiles.sort()).toEqual(
      ["message.md", "notes.txt", "report.pdf"].sort()
    );
  });

  it("does not put duplicate attachment names in the same message dir", async () => {
    const attDir = join(root, "source-att");
    await mkdir(attDir, { recursive: true });
    await writeFile(join(attDir, "a.pdf"), "one");
    const copy = join(root, "source-att-2");
    await mkdir(copy, { recursive: true });
    await writeFile(join(copy, "a.pdf"), "two");

    const junoMail = join(root, "juno-mail");
    await mkdir(junoMail, { recursive: true });
    inbox.upsertRoute({
      agentId: "juno",
      mailRoot: junoMail,
      displayName: "Juno",
    });

    inbox.send({
      to: "juno",
      from: "Eliza",
      fromAuth: "agent:eliza",
      subject: "dup names",
      body: "two attachments same name",
      attachments: [
        { filename: "a.pdf", sourceAbsPath: join(attDir, "a.pdf") },
        { filename: "a.pdf", sourceAbsPath: join(copy, "a.pdf") },
      ],
    });
    const junoEntries = await readdir(join(junoMail, "inbox"));
    const msgDir = junoEntries.find((e) => !e.endsWith(".md"))!;
    const files = await readdir(join(junoMail, "inbox", msgDir));
    expect(files.sort()).toContain("a.pdf");
    expect(files.some((f) => /a-2\.pdf/.test(f))).toBe(true);
  });
});

describe("InboxEngine — state transitions", () => {
  let root: string;
  let memory: MemoryEngine;
  let inbox: InboxEngine;
  let mailRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "spindle-inbox-engine-state-"));
    ({ memory, inbox, mailRoot } = await bootEngines(root));
    // Pre-stage an inbox message manually by calling upsertInboxRow.
    // (We simulate what the projector would do.)
    const fm = `---
id: fixture-1
from_auth: operator:example
from: Jessica
to: eliza
subject: hi
date: 2026-04-17T10:00:00Z
---

Body.
`;
    await writeFile(join(mailRoot, "inbox/fixture-1.md"), fm);
    inbox.upsertInboxRow({
      frontmatter: {
        id: "fixture-1",
        from_auth: "operator:example",
        from: "Jessica",
        to: "eliza",
        subject: "hi",
        date: "2026-04-17T10:00:00Z",
      },
      body: "Body.",
      attachments: [],
      source: "inbox",
      relPath: "inbox/fixture-1.md",
      sha256: "sha-fixture-1",
      mtime: 1745000000000,
    });
  });

  afterEach(async () => {
    inbox.close();
    memory.close();
    await rm(root, { recursive: true, force: true });
  });

  it("markRead moves the file to inbox/read/ and updates status", () => {
    const result = inbox.markRead("fixture-1");
    expect(result?.status).toBe("read");
    expect(existsSync(join(mailRoot, "inbox/fixture-1.md"))).toBe(false);
    expect(existsSync(join(mailRoot, "inbox/read/fixture-1.md"))).toBe(true);
    expect(result?.relPath).toBe("inbox/read/fixture-1.md");
  });

  it("markUnread moves the file back from inbox/read/", () => {
    inbox.markRead("fixture-1");
    const result = inbox.markUnread("fixture-1");
    expect(result?.status).toBe("unread");
    expect(existsSync(join(mailRoot, "inbox/fixture-1.md"))).toBe(true);
  });

  it("tombstone moves the file + persists reason in metadata", () => {
    const result = inbox.tombstone("fixture-1", "user_requested");
    expect(result?.status).toBe("tombstoned");
    expect(existsSync(join(mailRoot, "inbox/fixture-1.md"))).toBe(false);
    expect(existsSync(join(mailRoot, "inbox/tombstoned/fixture-1.md"))).toBe(true);
    expect(result?.metadata).toMatchObject({ tombstone_reason: "user_requested" });
  });

  it("restoreTombstoned moves the file back to inbox/", () => {
    inbox.tombstone("fixture-1");
    const result = inbox.restoreTombstoned("fixture-1");
    expect(result?.status).toBe("unread");
    expect(existsSync(join(mailRoot, "inbox/fixture-1.md"))).toBe(true);
  });

  it("state transitions are null-no-op for wrong current state", () => {
    // Already unread — markUnread is a no-op
    expect(inbox.markUnread("fixture-1")).toBeNull();
    // Unknown id
    expect(inbox.markRead("does-not-exist")).toBeNull();
  });
});

describe("InboxEngine — drafts", () => {
  let root: string;
  let memory: MemoryEngine;
  let inbox: InboxEngine;
  let mailRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "spindle-inbox-engine-drafts-"));
    ({ memory, inbox, mailRoot } = await bootEngines(root));
  });

  afterEach(async () => {
    inbox.close();
    memory.close();
    await rm(root, { recursive: true, force: true });
  });

  it("saves a draft to mail/drafts/ and projects into the DB", async () => {
    const d = inbox.saveDraft({
      to: "juno",
      from: "Eliza",
      fromAuth: "agent:eliza",
      subject: "hello",
      body: "draft body",
    });
    expect(d.id).toBeTruthy();
    expect(d.status).toBe("draft");
    const filePath = join(mailRoot, d.relPath);
    expect(existsSync(filePath)).toBe(true);
    const contents = await readFile(filePath, "utf8");
    expect(contents).toContain("draft body");
    const list = inbox.listDrafts();
    expect(list.total).toBe(1);
    expect(list.items[0].id).toBe(d.id);
  });

  it("updateDraft edits + re-serializes the file", async () => {
    const d = inbox.saveDraft({
      to: "juno",
      fromAuth: "agent:eliza",
      body: "first",
    });
    const updated = inbox.updateDraft(d.id, { body: "second", subject: "new" });
    expect(updated?.body).toBe("second");
    expect(updated?.subject).toBe("new");
    const contents = await readFile(join(mailRoot, d.relPath), "utf8");
    expect(contents).toContain("second");
    expect(contents).not.toContain("first");
  });

  it("cancelDraft deletes file and DB row", () => {
    const d = inbox.saveDraft({
      to: "juno",
      fromAuth: "agent:eliza",
      body: "tbd",
    });
    expect(inbox.cancelDraft(d.id)).toBe(true);
    expect(existsSync(join(mailRoot, d.relPath))).toBe(false);
    expect(inbox.getDraft(d.id)).toBeNull();
  });

  it("sendDraft delivers + deletes the draft", async () => {
    const junoMail = join(root, "juno-mail");
    await mkdir(junoMail, { recursive: true });
    inbox.upsertRoute({
      agentId: "juno",
      mailRoot: junoMail,
      displayName: "Juno",
    });
    const d = inbox.saveDraft({
      to: "juno",
      from: "Eliza",
      fromAuth: "agent:eliza",
      subject: "committed",
      body: "go time",
    });
    const result = inbox.sendDraft(d.id);
    expect(result?.deliveryStatus).toBe("delivered");
    expect(inbox.getDraft(d.id)).toBeNull();
    // Delivered copy lives in the recipient's inbox.
    const junoFiles = await readdir(join(junoMail, "inbox"));
    expect(junoFiles.some((f) => f.endsWith(".md"))).toBe(true);
  });

  it("sendDraft rejects drafts with no recipient", () => {
    const d = inbox.saveDraft({
      fromAuth: "agent:eliza",
      body: "nowhere",
    });
    expect(() => inbox.sendDraft(d.id)).toThrow(/recipient/);
  });
});

describe("InboxEngine — reads", () => {
  let root: string;
  let memory: MemoryEngine;
  let inbox: InboxEngine;
  let mailRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "spindle-inbox-engine-reads-"));
    ({ memory, inbox, mailRoot } = await bootEngines(root));

    // Populate a few inbox rows via the projection hook.
    const entries = [
      { id: "m1", from: "Jessica", subject: "hi", priority: "normal" as const },
      { id: "m2", from: "Jessica", subject: "reminder", priority: "high" as const },
      { id: "m3", from: "Wexford", subject: "order", priority: "normal" as const },
      { id: "m4", from: "Jessica", subject: "bye", priority: null },
    ];
    for (const e of entries) {
      const path = join(mailRoot, `inbox/${e.id}.md`);
      await writeFile(
        path,
        `---
id: ${e.id}
from_auth: operator:example
from: ${e.from}
to: eliza
subject: ${e.subject}
date: 2026-04-17T10:00:00Z
${e.priority ? `priority: ${e.priority}\n` : ""}---

body for ${e.id}
`
      );
      inbox.upsertInboxRow({
        frontmatter: {
          id: e.id,
          from_auth: "operator:example",
          from: e.from,
          to: "eliza",
          subject: e.subject,
          date: "2026-04-17T10:00:00Z",
          priority: e.priority ?? undefined,
        },
        body: `body for ${e.id}`,
        attachments: [],
        source: "inbox",
        relPath: `inbox/${e.id}.md`,
        sha256: `sha-${e.id}`,
        mtime: 1745000000000,
      });
    }
  });

  afterEach(async () => {
    inbox.close();
    memory.close();
    await rm(root, { recursive: true, force: true });
  });

  it("listInbox returns unread by default", () => {
    const list = inbox.listInbox();
    expect(list.total).toBe(4);
    expect(list.items.every((i) => i.status === "unread")).toBe(true);
  });

  it("listInbox filters by from", () => {
    const wayne = inbox.listInbox({ from: "Wexford" });
    expect(wayne.total).toBe(1);
    expect(wayne.items[0].id).toBe("m3");
  });

  it("listInbox filters by priority list", () => {
    const high = inbox.listInbox({ priority: ["high"] });
    expect(high.total).toBe(1);
    expect(high.items[0].id).toBe("m2");
  });

  it("searchInbox hits the FTS index", () => {
    const r = inbox.searchInbox({ q: "order" });
    expect(r.total).toBe(1);
    expect(r.items[0].id).toBe("m3");
  });

  it("getInboxStatus reports unread count + senders + has_priority", () => {
    const s = inbox.getInboxStatus();
    expect(s.unreadCount).toBe(4);
    expect(s.unreadSenders.sort()).toEqual(["Jessica", "Wexford"]);
    expect(s.hasPriority).toBe(true);
  });

  it("markRead excludes from default listInbox and includes when status=all", () => {
    inbox.markRead("m1");
    expect(inbox.listInbox().total).toBe(3);
    expect(inbox.listInbox({ status: "read" }).total).toBe(1);
    expect(inbox.listInbox({ status: "all" }).total).toBe(4);
  });
});
