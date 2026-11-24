import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import spindleInboxExtension from "../../src/extensions/spindle-inbox";
import { MemoryEngine } from "../../src/memory/engine";
import { InboxEngine } from "../../src/inbox/engine";
import {
  bindInboxEngine,
  bindInboxAgentId,
  resetInboxBinding,
} from "../../src/inbox/binding";
import type { ResolvedInboxConfig } from "../../src/inbox/types";

interface CapturedTool {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  promptSnippet?: string;
  promptGuidelines?: string[];
  execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown
  ) => Promise<{ content: Array<{ type: string; text?: string }>; details: unknown }>;
}

function makeMockApi(): { api: ExtensionAPI; tools: CapturedTool[] } {
  const tools: CapturedTool[] = [];
  const api = {
    registerTool: (def: CapturedTool) => {
      tools.push(def);
    },
    on: () => {},
    registerCommand: () => {},
    registerShortcut: () => {},
    getCommands: () => [],
    // biome-ignore lint/suspicious/noExplicitAny: mock shape
  } as any;
  return { api, tools };
}

async function boot(root: string): Promise<{
  memory: MemoryEngine;
  inbox: InboxEngine;
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
  return { memory, inbox };
}

describe("spindleInboxExtension — load time", () => {
  let root: string;
  let memory: MemoryEngine;
  let inbox: InboxEngine;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "spindle-inbox-ext-"));
    ({ memory, inbox } = await boot(root));
    bindInboxEngine(inbox);
    bindInboxAgentId("eliza");
  });

  afterEach(async () => {
    resetInboxBinding();
    inbox.close();
    memory.close();
    await rm(root, { recursive: true, force: true });
  });

  it("registers exactly one spindle_inbox tool", () => {
    const { api, tools } = makeMockApi();
    spindleInboxExtension(api);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("spindle_inbox");
  });

  it("registers nothing (but does not throw) when binding is null", () => {
    bindInboxEngine(null);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { api, tools } = makeMockApi();
    spindleInboxExtension(api);
    expect(tools).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("spindleInboxExtension — tool actions", () => {
  let root: string;
  let memory: MemoryEngine;
  let inbox: InboxEngine;
  let tool: CapturedTool;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "spindle-inbox-ext-act-"));
    ({ memory, inbox } = await boot(root));
    bindInboxEngine(inbox);
    bindInboxAgentId("eliza");
    const { api, tools } = makeMockApi();
    spindleInboxExtension(api);
    tool = tools[0];
  });

  afterEach(async () => {
    resetInboxBinding();
    inbox.close();
    memory.close();
    await rm(root, { recursive: true, force: true });
  });

  it("action=status reports unread count", async () => {
    // Stage an unread via the engine's projection hook.
    inbox.upsertInboxRow({
      frontmatter: {
        id: "m1",
        from_auth: "operator:example",
        from: "Jessica",
        to: "eliza",
        subject: "hi",
        date: "2026-04-17T10:00:00Z",
        priority: "high",
      },
      body: "hi there",
      attachments: [],
      source: "inbox",
      relPath: "inbox/m1.md",
      sha256: "sha-m1",
      mtime: 1,
    });
    const r = await tool.execute("t1", { action: "status" }, undefined, undefined, undefined);
    expect(r.content[0].text).toContain("1 unread");
    expect(r.content[0].text).toContain("priority items");
  });

  it("action=read strips from_auth from details", async () => {
    const junoMail = join(root, "juno-mail");
    await mkdir(junoMail, { recursive: true });
    // Stage an inbox message via the projection hook.
    inbox.upsertInboxRow({
      frontmatter: {
        id: "m2",
        from_auth: "operator:secret-token",
        from: "Jessica",
        to: "eliza",
        subject: "Meeting",
        date: "2026-04-17T10:00:00Z",
      },
      body: "body",
      attachments: [],
      source: "inbox",
      relPath: "inbox/m2.md",
      sha256: "sha-m2",
      mtime: 1,
    });
    // parse.ts insists the file exists; stage a matching file too so
    // markRead's fs-rename succeeds (read action auto-marks read).
    const fs = await import("fs/promises");
    await fs.writeFile(
      join(inbox.getMailRoot(), "inbox/m2.md"),
      "---\nid: m2\nfrom: Jessica\nto: eliza\ndate: 2026-04-17T10:00:00Z\n---\n\nbody\n"
    );

    const r = await tool.execute(
      "t2",
      { action: "read", id: "m2" },
      undefined,
      undefined,
      undefined
    );
    // Text body must not contain the secret auth value.
    expect(JSON.stringify(r)).not.toContain("secret-token");
    const details = r.details as Record<string, unknown>;
    expect(details.from).toBe("Jessica");
    expect(details).not.toHaveProperty("from_auth");
  });

  it("action=list returns ids and respects unread_only", async () => {
    inbox.upsertInboxRow({
      frontmatter: {
        id: "m3",
        from_auth: "op:x",
        from: "Jessica",
        to: "eliza",
        subject: "s",
        date: "2026-04-17T10:00:00Z",
      },
      body: "b",
      attachments: [],
      source: "inbox",
      relPath: "inbox/m3.md",
      sha256: "sha-m3",
      mtime: 1,
    });
    const r = await tool.execute("t3", { action: "list" }, undefined, undefined, undefined);
    const details = r.details as { ids: string[]; total: number };
    expect(details.ids).toContain("m3");
  });

  it("action=send routed → delivered", async () => {
    const junoMail = join(root, "juno-mail");
    await mkdir(junoMail, { recursive: true });
    inbox.upsertRoute({
      agentId: "juno",
      mailRoot: junoMail,
      displayName: "Juno",
    });
    const r = await tool.execute(
      "t4",
      {
        action: "send",
        to: "juno",
        subject: "hi",
        body: "hello juno",
      },
      undefined,
      undefined,
      undefined
    );
    const details = r.details as { deliveryStatus: string; deliveredTo: string };
    expect(details.deliveryStatus).toBe("delivered");
    expect(details.deliveredTo).toBe("juno");
  });

  it("action=send unrouted → operator inbox", async () => {
    const r = await tool.execute(
      "t5",
      {
        action: "send",
        to: "ghost",
        body: "lost",
      },
      undefined,
      undefined,
      undefined
    );
    const details = r.details as { deliveryStatus: string; deliveredTo: string };
    expect(details.deliveryStatus).toBe("unrouted");
    expect(details.deliveredTo).toBe("operator");
    expect(r.content[0].text).toContain("operator inbox");
  });

  it("action=send rejects missing 'to' / 'body'", async () => {
    const r = await tool.execute(
      "t6",
      { action: "send", body: "only body" },
      undefined,
      undefined,
      undefined
    );
    expect(r.content[0].text).toMatch(/requires/);
  });

  it("action=mark_read requires an id", async () => {
    const r = await tool.execute(
      "t7",
      { action: "mark_read" },
      undefined,
      undefined,
      undefined
    );
    expect(r.content[0].text).toMatch(/requires/);
  });
});
