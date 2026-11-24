import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, rename, unlink, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { MemoryEngine } from "../../src/memory/engine";
import { InboxEngine } from "../../src/inbox/engine";
import { InboxProjector } from "../../src/inbox/projector";
import type { ResolvedInboxConfig } from "../../src/inbox/types";

const AGENT_ID = "eliza";

async function bootFixture(root: string): Promise<{
  memory: MemoryEngine;
  inbox: InboxEngine;
  projector: InboxProjector;
  mailRoot: string;
}> {
  const memory = await MemoryEngine.open(
    { enabled: true, database_path: join(root, "memory.db") },
    {},
    root
  );
  memory.registerAgent(AGENT_ID, "Eliza");
  const mailRoot = join(root, "mail");
  const operatorMailRoot = join(root, "operator-mail");
  const config: ResolvedInboxConfig = {
    agentId: AGENT_ID,
    agentDisplayName: "Eliza",
    mailRoot,
    operatorMailRoot,
    pollIntervalMs: 30000,
    contacts: [],
  };
  const inbox = await InboxEngine.open({ memory, config });
  const projector = new InboxProjector({
    engine: inbox,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  return { memory, inbox, projector, mailRoot };
}

function fixtureFile(id: string, opts: Partial<{ from: string; body: string }> = {}): string {
  return `---
id: ${id}
from_auth: operator:example
from: ${opts.from ?? "Jessica"}
to: eliza
subject: ${id}-subject
date: 2026-04-17T10:00:00Z
---

${opts.body ?? `body for ${id}`}
`;
}

describe("InboxProjector", () => {
  let root: string;
  let memory: MemoryEngine;
  let inbox: InboxEngine;
  let projector: InboxProjector;
  let mailRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "spindle-inbox-projector-"));
    ({ memory, inbox, projector, mailRoot } = await bootFixture(root));
  });

  afterEach(async () => {
    await projector.stop();
    inbox.close();
    memory.close();
    await rm(root, { recursive: true, force: true });
  });

  it("backfill projects new inbox + outbox + drafts files", async () => {
    await writeFile(join(mailRoot, "inbox/a.md"), fixtureFile("a"));
    await writeFile(join(mailRoot, "inbox/b.md"), fixtureFile("b"));
    await writeFile(
      join(mailRoot, "outbox/o1.md"),
      `---
id: o1
from_auth: agent:eliza
from: Eliza
to: juno
subject: reply
date: 2026-04-17T11:00:00Z
delivery_status: delivered
to_mail_root: /tmp/juno-mail
---

sent out
`
    );
    await writeFile(
      join(mailRoot, "drafts/d1.md"),
      `---
id: d1
from_auth: agent:eliza
from: Eliza
to: juno
subject: wip
date: 2026-04-17T11:30:00Z
draft_status: draft
---

work in progress
`
    );

    const r = await projector.backfill();
    expect(r.scanned).toBe(4);
    expect(r.added).toBe(4);
    expect(r.updated).toBe(0);
    expect(r.skippedMalformed).toBe(0);
    expect(inbox.listInbox().total).toBe(2);
    expect(inbox.listOutbox().total).toBe(1);
    expect(inbox.listDrafts().total).toBe(1);
  });

  it("picks up a file edited in place", async () => {
    const path = join(mailRoot, "inbox/c.md");
    await writeFile(path, fixtureFile("c", { body: "original body" }));
    await projector.backfill();

    // Rewrite with new body.
    await writeFile(path, fixtureFile("c", { body: "rewritten body" }));
    const r = await projector.projectOnce();
    expect(r.updated).toBe(1);
    const msg = inbox.getMessage("c");
    expect(msg?.body).toBe("rewritten body");
  });

  it("handles status transitions via file rename (inbox → inbox/read)", async () => {
    const src = join(mailRoot, "inbox/d.md");
    await writeFile(src, fixtureFile("d"));
    await projector.backfill();
    expect(inbox.getMessage("d")?.status).toBe("unread");

    // Someone (operator, another agent) manually moves the file.
    await rename(src, join(mailRoot, "inbox/read/d.md"));
    const r = await projector.projectOnce();
    expect(r.updated).toBe(1);
    expect(inbox.getMessage("d")?.status).toBe("read");
    expect(inbox.getMessage("d")?.relPath).toBe("inbox/read/d.md");
  });

  it("removes rows when files disappear", async () => {
    await writeFile(join(mailRoot, "inbox/e.md"), fixtureFile("e"));
    await projector.backfill();
    expect(inbox.getMessage("e")).not.toBeNull();

    await unlink(join(mailRoot, "inbox/e.md"));
    const r = await projector.projectOnce();
    expect(r.removed).toBe(1);
    expect(inbox.getMessage("e")).toBeNull();
  });

  it("skips malformed files + logs once", async () => {
    const warns: string[] = [];
    await projector.stop();
    projector = new InboxProjector({
      engine: inbox,
      logger: {
        info: () => {},
        warn: (m) => warns.push(m),
        error: () => {},
      },
    });

    await writeFile(
      join(mailRoot, "inbox/bad.md"),
      "no frontmatter here\n"
    );
    const r1 = await projector.projectOnce();
    expect(r1.skippedMalformed).toBe(1);
    expect(warns.length).toBe(1);

    // A well-formed file next to it still projects.
    await writeFile(join(mailRoot, "inbox/good.md"), fixtureFile("good"));
    const r2 = await projector.projectOnce();
    expect(r2.added).toBe(1);
    expect(r2.skippedMalformed).toBe(1);
  });

  it("handles multi-file message dirs with attachments", async () => {
    const msgDir = join(mailRoot, "inbox/with-att");
    await mkdir(msgDir, { recursive: true });
    await writeFile(join(msgDir, "message.md"), fixtureFile("with-att"));
    await writeFile(join(msgDir, "order.pdf"), "pdf-bytes");

    const r = await projector.backfill();
    expect(r.added).toBe(1);

    const msg = inbox.getMessage("with-att");
    expect(msg?.attachments).toHaveLength(1);
    expect(msg?.attachments[0].filename).toBe("order.pdf");
    expect(msg?.attachments[0].contentType).toBe("application/pdf");
  });

  it("is idempotent — an unchanged cycle reports zero changes", async () => {
    await writeFile(join(mailRoot, "inbox/f.md"), fixtureFile("f"));
    await projector.backfill();
    const r = await projector.projectOnce();
    expect(r.added).toBe(0);
    expect(r.updated).toBe(0);
    expect(r.removed).toBe(0);
  });
});
