import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, readFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { MemoryEngine } from "../../src/memory/engine";
import { InboxEngine } from "../../src/inbox/engine";
import type { ResolvedInboxConfig } from "../../src/inbox/types";

async function boot(root: string): Promise<{
  memory: MemoryEngine;
  inbox: InboxEngine;
  mailRoot: string;
}> {
  const memory = await MemoryEngine.open(
    { enabled: true, database_path: join(root, "memory.db") },
    {},
    root
  );
  memory.registerAgent("eliza", "Eliza");
  const mailRoot = join(root, "mail");
  const operatorMailRoot = join(root, "operator-mail");
  const config: ResolvedInboxConfig = {
    agentId: "eliza",
    agentDisplayName: "Eliza",
    mailRoot,
    operatorMailRoot,
    pollIntervalMs: 30000,
    contacts: [],
  };
  const inbox = await InboxEngine.open({ memory, config });
  return { memory, inbox, mailRoot };
}

describe("draft attachments", () => {
  let root: string;
  let memory: MemoryEngine;
  let inbox: InboxEngine;
  let mailRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "spindle-draft-att-"));
    ({ memory, inbox, mailRoot } = await boot(root));
  });

  afterEach(async () => {
    inbox.close();
    memory.close();
    await rm(root, { recursive: true, force: true });
  });

  it("converts single-file draft to dir layout on first attachment", async () => {
    const d = inbox.saveDraft({
      to: "juno",
      from: "Eliza",
      fromAuth: "agent:eliza",
      subject: "hi",
      body: "body",
    });
    expect(d.relPath).toBe(`drafts/${d.id}.md`);
    expect(existsSync(join(mailRoot, d.relPath))).toBe(true);

    const att = inbox.addDraftAttachment(
      d.id,
      "report.pdf",
      Buffer.from("pdf-bytes"),
      "application/pdf"
    );
    expect(att.filename).toBe("report.pdf");
    expect(att.sizeBytes).toBe(9);

    // Old bare file is gone, new dir layout is in place
    expect(existsSync(join(mailRoot, "drafts", `${d.id}.md`))).toBe(false);
    expect(existsSync(join(mailRoot, "drafts", d.id, "message.md"))).toBe(true);
    expect(existsSync(join(mailRoot, "drafts", d.id, "report.pdf"))).toBe(true);

    const updated = inbox.getDraft(d.id);
    expect(updated?.relPath).toBe(`drafts/${d.id}/message.md`);
  });

  it("lists attachments + supports add/remove", async () => {
    const d = inbox.saveDraft({
      to: "juno",
      fromAuth: "agent:eliza",
      body: "body",
    });
    inbox.addDraftAttachment(d.id, "a.txt", Buffer.from("aaa"));
    inbox.addDraftAttachment(d.id, "b.txt", Buffer.from("bbb"));

    const atts = inbox.listDraftAttachments(d.id);
    expect(atts.map((a) => a.filename).sort()).toEqual(["a.txt", "b.txt"]);

    expect(inbox.removeDraftAttachment(d.id, "a.txt")).toBe(true);
    const after = inbox.listDraftAttachments(d.id);
    expect(after.map((a) => a.filename)).toEqual(["b.txt"]);
  });

  it("rejects path-traversal filenames", () => {
    const d = inbox.saveDraft({
      to: "juno",
      fromAuth: "agent:eliza",
      body: "body",
    });
    expect(() =>
      inbox.removeDraftAttachment(d.id, "../../../etc/passwd")
    ).toThrow(/invalid/);
  });

  it("de-dupes filename on repeat uploads with a -2 suffix", () => {
    const d = inbox.saveDraft({
      to: "juno",
      fromAuth: "agent:eliza",
      body: "body",
    });
    const a = inbox.addDraftAttachment(d.id, "file.txt", Buffer.from("one"));
    const b = inbox.addDraftAttachment(d.id, "file.txt", Buffer.from("two"));
    expect(a.filename).toBe("file.txt");
    expect(b.filename).toBe("file-2.txt");
  });

  it("sendDraft includes attachments in the delivered multi-file dir", async () => {
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
      subject: "with attachments",
      body: "see attached",
    });
    inbox.addDraftAttachment(d.id, "report.pdf", Buffer.from("pdf"));
    inbox.addDraftAttachment(d.id, "notes.txt", Buffer.from("notes"));

    const result = inbox.sendDraft(d.id);
    expect(result?.deliveryStatus).toBe("delivered");
    // The recipient's inbox should have a dir for the message + its attachments
    const junoEntries = await readdir(join(junoMail, "inbox"));
    const msgDir = junoEntries.find((e) => !e.endsWith(".md"))!;
    const inDir = await readdir(join(junoMail, "inbox", msgDir));
    expect(inDir.sort()).toEqual(["message.md", "notes.txt", "report.pdf"].sort());
    // Draft is gone
    expect(inbox.getDraft(d.id)).toBeNull();
    expect(existsSync(join(mailRoot, "drafts", d.id))).toBe(false);
  });

  it("cancelDraft removes the dir when attachments were added", () => {
    const d = inbox.saveDraft({
      to: "juno",
      fromAuth: "agent:eliza",
      body: "body",
    });
    inbox.addDraftAttachment(d.id, "x.txt", Buffer.from("x"));
    expect(existsSync(join(mailRoot, "drafts", d.id))).toBe(true);
    inbox.cancelDraft(d.id);
    expect(existsSync(join(mailRoot, "drafts", d.id))).toBe(false);
    expect(inbox.getDraft(d.id)).toBeNull();
  });
});
