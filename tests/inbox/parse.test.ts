import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  discoverMailFiles,
  parseMailFile,
  serializeMailFile,
  hashBytes,
  MailParseError,
} from "../../src/inbox/parse";
import type { MailFrontmatter } from "../../src/inbox/types";

describe("parseMailFile", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "spindle-inbox-parse-"));
    await mkdir(join(root, "inbox"), { recursive: true });
    await mkdir(join(root, "inbox/read"), { recursive: true });
    await mkdir(join(root, "inbox/tombstoned"), { recursive: true });
    await mkdir(join(root, "outbox"), { recursive: true });
    await mkdir(join(root, "drafts"), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("parses a full-frontmatter single-file inbox message", async () => {
    const path = join(root, "inbox/2026-04-17-jessica-firmware-a1b2.md");
    await writeFile(
      path,
      `---
id: 2026-04-17-jessica-firmware-a1b2
from_auth: operator:example
from: Jessica
to: casey
subject: Firmware update
date: 2026-04-17T14:12:00-04:00
priority: high
kind: message
thread_id: firmware-42
metadata:
  source: web-ui
  campaign: spring-2026
---

Hey Casey,

We need the firmware update by Friday.

— Jessica
`
    );
    const parsed = parseMailFile(path, root, "inbox");
    expect(parsed.frontmatter.id).toBe("2026-04-17-jessica-firmware-a1b2");
    expect(parsed.frontmatter.from).toBe("Jessica");
    expect(parsed.frontmatter.from_auth).toBe("operator:example");
    expect(parsed.frontmatter.to).toBe("casey");
    expect(parsed.frontmatter.priority).toBe("high");
    expect(parsed.frontmatter.kind).toBe("message");
    expect(parsed.frontmatter.thread_id).toBe("firmware-42");
    expect(parsed.frontmatter.metadata).toEqual({
      source: "web-ui",
      campaign: "spring-2026",
    });
    expect(parsed.body).toContain("firmware update by Friday");
    expect(parsed.attachments).toHaveLength(0);
    expect(parsed.source).toBe("inbox");
    expect(parsed.relPath).toBe("inbox/2026-04-17-jessica-firmware-a1b2.md");
    expect(parsed.sha256).toHaveLength(64);
  });

  it("is backwards-compatible with the legacy frontmatter shape", async () => {
    // The legacy shape uses: from, subject, date, priority. No id, no from_auth, no kind.
    const path = join(root, "inbox/2026-04-15-jessica-meeting.md");
    await writeFile(
      path,
      `---
from: Jessica
subject: Monday sync
date: 2026-04-15
priority: normal
---

Hey, see you at 10am?
`
    );
    const parsed = parseMailFile(path, root, "inbox");
    // id synthesized from filename
    expect(parsed.frontmatter.id).toBe("2026-04-15-jessica-meeting");
    expect(parsed.frontmatter.from).toBe("Jessica");
    expect(parsed.frontmatter.subject).toBe("Monday sync");
    // from_auth / kind / metadata absent as expected
    expect(parsed.frontmatter.from_auth).toBeUndefined();
    expect(parsed.frontmatter.kind).toBeUndefined();
  });

  it("picks up sibling files as attachments on a multi-file message dir", async () => {
    const msgDir = join(root, "inbox/2026-04-17-acme-orders");
    await mkdir(msgDir, { recursive: true });
    await writeFile(
      join(msgDir, "message.md"),
      `---
id: 2026-04-17-acme-orders
from_auth: operator:example
from: Acme Orders
to: casey
date: 2026-04-17T12:00:00Z
---

See attached.
`
    );
    await writeFile(join(msgDir, "order-4421.pdf"), "pdf-bytes");
    await writeFile(join(msgDir, "changelog.txt"), "changes go here");

    const parsed = parseMailFile(
      join(msgDir, "message.md"),
      root,
      "inbox"
    );
    expect(parsed.attachments).toHaveLength(2);
    const filenames = parsed.attachments.map((a) => a.filename).sort();
    expect(filenames).toEqual(["changelog.txt", "order-4421.pdf"]);
    const pdf = parsed.attachments.find((a) => a.filename === "order-4421.pdf")!;
    expect(pdf.contentType).toBe("application/pdf");
    expect(pdf.sha256).toBe(hashBytes("pdf-bytes"));
    expect(pdf.relPath).toBe(
      "inbox/2026-04-17-acme-orders/order-4421.pdf"
    );
  });

  it("throws MailParseError on missing frontmatter", async () => {
    const path = join(root, "inbox/bad.md");
    await writeFile(path, "Just a body, no frontmatter");
    expect(() => parseMailFile(path, root, "inbox")).toThrow(MailParseError);
  });

  it("throws MailParseError on invalid YAML in frontmatter", async () => {
    const path = join(root, "inbox/broken.md");
    await writeFile(
      path,
      `---
from: Jessica
to: casey
  invalid: : : yaml here
---

Body.
`
    );
    expect(() => parseMailFile(path, root, "inbox")).toThrow(MailParseError);
  });

  it("throws MailParseError when required fields are missing", async () => {
    const path = join(root, "inbox/no-from.md");
    await writeFile(
      path,
      `---
to: casey
date: 2026-04-17
---

Body.
`
    );
    expect(() => parseMailFile(path, root, "inbox")).toThrow(/from/);
  });

  it("throws on invalid priority", async () => {
    const path = join(root, "inbox/bad-priority.md");
    await writeFile(
      path,
      `---
from: Jessica
to: casey
date: 2026-04-17
priority: super-duper-urgent
---

body
`
    );
    expect(() => parseMailFile(path, root, "inbox")).toThrow(/priority/);
  });

  it("falls back to legacy line parser when YAML rejects unquoted colons", async () => {
    // Legacy compat. `subject: RE: Series 7 grip sensor reading high`
    // is a hand-rolled-parser artifact; strict YAML sees the inner
    // colon as a nested-mapping indicator and throws. Fallback parser
    // recovers the flat scalar view.
    const path = join(root, "inbox/jessica-response.md");
    await writeFile(
      path,
      `---
from: Jessica
subject: RE: Series 7 grip sensor reading high
date: 2026-04-10
priority: high
---

Got your note — taking a look now.
`
    );
    const parsed = parseMailFile(path, root, "inbox");
    expect(parsed.frontmatter.from).toBe("Jessica");
    expect(parsed.frontmatter.subject).toBe("RE: Series 7 grip sensor reading high");
    expect(parsed.frontmatter.priority).toBe("high");
    // Missing id → synthesized from filename.
    expect(parsed.frontmatter.id).toBe("jessica-response");
    expect(parsed.body).toContain("Got your note");
  });

  it("throws on invalid kind", async () => {
    const path = join(root, "inbox/bad-kind.md");
    await writeFile(
      path,
      `---
from: Jessica
to: casey
date: 2026-04-17
kind: bogus
---

body
`
    );
    expect(() => parseMailFile(path, root, "inbox")).toThrow(/kind/);
  });
});

describe("discoverMailFiles", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "spindle-inbox-discover-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns [] when mail root is empty / non-existent", () => {
    const files = discoverMailFiles(join(root, "does-not-exist"));
    expect(files).toEqual([]);
  });

  it("finds files across all five source subdirs", async () => {
    await mkdir(join(root, "inbox"), { recursive: true });
    await mkdir(join(root, "inbox/read"), { recursive: true });
    await mkdir(join(root, "inbox/tombstoned"), { recursive: true });
    await mkdir(join(root, "outbox"), { recursive: true });
    await mkdir(join(root, "drafts"), { recursive: true });

    await writeFile(join(root, "inbox/msg-a.md"), minimalFile("a", "casey"));
    await writeFile(join(root, "inbox/read/msg-b.md"), minimalFile("b", "casey"));
    await writeFile(
      join(root, "inbox/tombstoned/msg-c.md"),
      minimalFile("c", "casey")
    );
    await writeFile(join(root, "outbox/msg-d.md"), minimalFile("d", "casey"));
    await writeFile(join(root, "drafts/msg-e.md"), minimalFile("e", "casey"));

    const files = discoverMailFiles(root);
    expect(files).toHaveLength(5);
    const bySource = new Map(files.map((f) => [f.source, f.relPath]));
    expect(bySource.get("inbox")).toBe("inbox/msg-a.md");
    expect(bySource.get("inbox/read")).toBe("inbox/read/msg-b.md");
    expect(bySource.get("inbox/tombstoned")).toBe(
      "inbox/tombstoned/msg-c.md"
    );
    expect(bySource.get("outbox")).toBe("outbox/msg-d.md");
    expect(bySource.get("drafts")).toBe("drafts/msg-e.md");
  });

  it("does not walk inbox/read or inbox/tombstoned as inbox sources", async () => {
    // A message in inbox/read/ must be tagged source='inbox/read', never
    // 'inbox'. Walks must not recurse into source subdirs from the inbox
    // loop itself.
    await mkdir(join(root, "inbox/read"), { recursive: true });
    await writeFile(join(root, "inbox/read/msg.md"), minimalFile("r", "casey"));

    const files = discoverMailFiles(root);
    expect(files).toHaveLength(1);
    expect(files[0].source).toBe("inbox/read");
  });

  it("detects multi-file message dirs (message.md + siblings)", async () => {
    const msgDir = join(root, "inbox/wayne-order");
    await mkdir(msgDir, { recursive: true });
    await writeFile(join(msgDir, "message.md"), minimalFile("w", "casey"));
    await writeFile(join(msgDir, "invoice.pdf"), "pdf-bytes");

    const files = discoverMailFiles(root);
    expect(files).toHaveLength(1);
    expect(files[0].relPath).toBe("inbox/wayne-order/message.md");
    expect(files[0].messageDir).toBe(msgDir);
  });

  it("skips stray .md-less files at the top of a mail dir", async () => {
    await mkdir(join(root, "inbox"), { recursive: true });
    await writeFile(join(root, "inbox/readme.txt"), "ignore me");
    await writeFile(join(root, "inbox/msg-a.md"), minimalFile("a", "casey"));
    const files = discoverMailFiles(root);
    expect(files).toHaveLength(1);
    expect(files[0].relPath).toBe("inbox/msg-a.md");
  });
});

describe("serializeMailFile", () => {
  it("round-trips frontmatter + body through parse → serialize → parse", async () => {
    const fm: MailFrontmatter = {
      id: "2026-04-17-test-round-trip",
      from_auth: "operator:example",
      from: "Jessica",
      to: "casey",
      subject: "Test",
      date: "2026-04-17T14:00:00Z",
      priority: "normal",
      kind: "message",
      metadata: { source: "test" },
    };
    const bytes = serializeMailFile(fm, "Hello Casey.");
    expect(bytes.startsWith("---\n")).toBe(true);
    expect(bytes.endsWith("Hello Casey.\n")).toBe(true);

    // Write and re-parse.
    const root = await mkdtemp(join(tmpdir(), "spindle-inbox-rt-"));
    const path = join(root, "inbox/2026-04-17-test-round-trip.md");
    await mkdir(join(root, "inbox"), { recursive: true });
    await writeFile(path, bytes);
    const parsed = parseMailFile(path, root, "inbox");
    expect(parsed.frontmatter.id).toBe(fm.id);
    expect(parsed.frontmatter.from).toBe(fm.from);
    expect(parsed.frontmatter.metadata).toEqual(fm.metadata);
    expect(parsed.body).toBe("Hello Casey.");
    await rm(root, { recursive: true, force: true });
  });

  it("omits undefined fields instead of emitting `key: undefined`", () => {
    const fm: MailFrontmatter = {
      id: "x",
      from: "j",
      to: "c",
      date: "2026-04-17",
      // subject, priority, metadata, etc. left undefined
    };
    const bytes = serializeMailFile(fm, "b");
    expect(bytes).not.toContain("subject");
    expect(bytes).not.toContain("priority");
    expect(bytes).not.toContain("metadata");
  });
});

function minimalFile(id: string, to: string): string {
  return `---
id: ${id}
from: Sender
to: ${to}
date: 2026-04-17T00:00:00Z
---

body
`;
}
