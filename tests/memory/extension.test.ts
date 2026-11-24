import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import spindleMemoryExtension from "../../src/extensions/spindle-memory";
import {
  bindMemoryEngine,
  bindMemoryAgentId,
  bindDaydreamActive,
  bindMainStoreEnabled,
  bindLoadContext,
  resetMemoryBinding,
} from "../../src/memory/binding";
import { MemoryEngine } from "../../src/memory/engine";

/**
 * A thin ExtensionAPI mock that captures registered tools so tests
 * can drive them directly without running a full pi session. Only
 * implements registerTool (other methods are no-ops / throws) since
 * that's all spindle-memory uses at load time.
 */
interface CapturedTool {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown
  ) => Promise<{
    content: Array<{ type: string; text?: string }>;
    details: unknown;
  }>;
}

function makeMockApi(): {
  api: ExtensionAPI;
  tools: CapturedTool[];
} {
  const tools: CapturedTool[] = [];
  const api = {
    registerTool: (def: CapturedTool) => {
      tools.push(def);
    },
    // Other ExtensionAPI methods: stub as no-ops/throws. We only exercise
    // registerTool in Phase 2.0 so anything else signals a bug.
    on: () => {},
    registerCommand: () => {},
    registerShortcut: () => {},
    getCommands: () => [],
    // biome-ignore lint/suspicious/noExplicitAny: mock shape
  } as any;
  return { api, tools };
}

let tmpDir: string;
let dbPath: string;
let engine: MemoryEngine;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "spindle-ext-test-"));
  dbPath = join(tmpDir, "memory.db");
  engine = await MemoryEngine.open({ database_path: dbPath });
  engine.registerAgent("test-agent", "Test");
  bindMemoryEngine(engine);
  bindMemoryAgentId("test-agent");
});

afterEach(() => {
  resetMemoryBinding();
  engine.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================================
// Load-time behavior
// ============================================================================

describe("spindleMemoryExtension — load-time", () => {
  it("registers spindle_memory_store and spindle_memory_recall when binding is set", () => {
    const { api, tools } = makeMockApi();
    spindleMemoryExtension(api);
    const names = tools.map((t) => t.name);
    expect(names).toContain("spindle_memory_store");
    expect(names).toContain("spindle_memory_recall");
    expect(tools).toHaveLength(2);
  });

  it("registers NO tools and logs warning when engine binding is missing", () => {
    bindMemoryEngine(null);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { api, tools } = makeMockApi();
    spindleMemoryExtension(api);
    expect(tools).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls[0][0] as string).toMatch(/memory tools disabled/);
    warn.mockRestore();
  });

  it("registers NO tools and logs warning when agent id binding is missing", () => {
    bindMemoryAgentId(null);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { api, tools } = makeMockApi();
    spindleMemoryExtension(api);
    expect(tools).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls[0][0] as string).toMatch(/agent id/);
    warn.mockRestore();
  });

  it("boot-order test: bind BEFORE load, tools register", () => {
    // Simulates the spindle boot sequence:
    //   1. bindMemoryEngine(engine)  — done in beforeEach
    //   2. bindMemoryAgentId(id)     — done in beforeEach
    //   3. pi's extension loader calls the default export
    const { api, tools } = makeMockApi();
    spindleMemoryExtension(api);
    expect(tools).toHaveLength(2);
  });

  it("registers BOTH tools by default (Phase 2 backwards compat)", () => {
    // No daydream, mainStoreEnabled defaults to true
    const { api, tools } = makeMockApi();
    spindleMemoryExtension(api);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["spindle_memory_recall", "spindle_memory_store"]);
  });

  it("main session WITHHOLDS store when mainStoreEnabled=false", () => {
    bindMainStoreEnabled(false);
    const { api, tools } = makeMockApi();
    spindleMemoryExtension(api);
    const names = tools.map((t) => t.name);
    expect(names).toEqual(["spindle_memory_recall"]);
    expect(names).not.toContain("spindle_memory_store");
  });

  it("daydream session gets store + associate EVEN WHEN mainStoreEnabled=false", () => {
    // Simulate the daydream factory's binding sequence: daydream active,
    // main disabled, load context = daydream. The extension should
    // register store + associate anyway because the daydream session
    // needs both. (associate is daydream-only by design — main never
    // sees it.)
    bindDaydreamActive(true);
    bindMainStoreEnabled(false);
    bindLoadContext("daydream");
    const { api, tools } = makeMockApi();
    spindleMemoryExtension(api);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "spindle_memory_associate",
      "spindle_memory_forget",
      "spindle_memory_recall",
      "spindle_memory_store",
    ]);
  });

  it("daydream-context store registration has EMPTY guidelines (curator prompt owns the instructions)", () => {
    bindDaydreamActive(true);
    bindMainStoreEnabled(false);
    bindLoadContext("daydream");
    const { api, tools } = makeMockApi();
    spindleMemoryExtension(api);
    const store = tools.find((t) => t.name === "spindle_memory_store")!;
    expect(store.promptGuidelines).toEqual([]);
  });

  it("main-context store registration has 'proactively store' guidelines", () => {
    // mainStoreEnabled=true by default, context=main by default
    const { api, tools } = makeMockApi();
    spindleMemoryExtension(api);
    const store = tools.find((t) => t.name === "spindle_memory_store")!;
    expect(store.promptGuidelines).toBeDefined();
    const joined = store.promptGuidelines!.join(" ");
    expect(joined).toMatch(/durable fact/);
    expect(joined).toMatch(/call spindle_memory_store/);
  });

  it("recall guidelines are the same regardless of mainStoreEnabled / context", () => {
    const caseA = (() => {
      const { api, tools } = makeMockApi();
      spindleMemoryExtension(api);
      return tools.find((t) => t.name === "spindle_memory_recall")!.promptGuidelines;
    })();
    resetMemoryBinding();
    bindMemoryEngine(engine);
    bindMemoryAgentId("test-agent");
    bindDaydreamActive(true);
    bindMainStoreEnabled(false);
    const caseB = (() => {
      const { api, tools } = makeMockApi();
      spindleMemoryExtension(api);
      return tools.find((t) => t.name === "spindle_memory_recall")!.promptGuidelines;
    })();
    expect(caseA).toEqual(caseB);
  });

  it("log includes daydream state and mainStoreEnabled flag", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    bindDaydreamActive(true);
    bindMainStoreEnabled(false);
    const { api } = makeMockApi();
    spindleMemoryExtension(api);
    const logLine = logSpy.mock.calls.map((c) => c[0] as string).join("\n");
    expect(logLine).toMatch(/daydream ACTIVE/);
    expect(logLine).toMatch(/mainStoreEnabled=false/);
    // Main context with store withheld — should mention "only"
    expect(logLine).toMatch(/recall only|store tool withheld/);
    logSpy.mockRestore();
  });

  it("unbinding after load does NOT break already-registered tools", async () => {
    // The extension captures the engine by closure at load time, so
    // later unbinding the module-level reference shouldn't affect
    // tools that were registered before the unbind.
    const { api, tools } = makeMockApi();
    spindleMemoryExtension(api);
    bindMemoryEngine(null);
    // The captured tool should still work
    const store = tools.find((t) => t.name === "spindle_memory_store")!;
    const result = await store.execute(
      "call-1",
      { content: "survives unbind" },
      undefined,
      undefined,
      {}
    );
    expect(result.content[0].text).toMatch(/Stored memory/);
  });
});

// ============================================================================
// Tool handler behavior
// ============================================================================

describe("spindle_memory_store tool", () => {
  it("stores with default private visibility", async () => {
    const { api, tools } = makeMockApi();
    spindleMemoryExtension(api);
    const store = tools.find((t) => t.name === "spindle_memory_store")!;
    const result = await store.execute(
      "call-1",
      { content: "the user likes cyberpunk" },
      undefined,
      undefined,
      {}
    );
    expect(result.content[0].text).toMatch(/Stored memory #\d+ \(private\)/);
    expect((result.details as { id: number }).id).toBeGreaterThan(0);
    expect(engine.countVisible("test-agent")).toBe(1);
  });

  it("stores with shared visibility when requested", async () => {
    const { api, tools } = makeMockApi();
    spindleMemoryExtension(api);
    const store = tools.find((t) => t.name === "spindle_memory_store")!;
    const result = await store.execute(
      "call-1",
      { content: "common fact", visibility: "shared" },
      undefined,
      undefined,
      {}
    );
    expect(result.content[0].text).toMatch(/\(shared\)/);
    const details = result.details as { id: number; visibility: string };
    expect(details.visibility).toBe("shared");
  });

  it("returns a friendly error result if the engine throws", async () => {
    // Close the engine out from under the extension — store will throw.
    engine.close();
    const { api, tools } = makeMockApi();
    // Rebind a closed engine so the extension loads successfully but
    // fails on execute.
    bindMemoryEngine(engine);
    spindleMemoryExtension(api);
    const store = tools.find((t) => t.name === "spindle_memory_store")!;
    const result = await store.execute(
      "call-1",
      { content: "test" },
      undefined,
      undefined,
      {}
    );
    expect(result.content[0].text).toMatch(/Failed to store memory/);
    expect((result.details as { error: string }).error).toMatch(/closed/);
    // Reopen for afterEach cleanup (otherwise the close call will throw)
    engine = await MemoryEngine.open({ database_path: dbPath });
  });
});

describe("spindle_memory_recall tool", () => {
  async function seedAndGetTool() {
    await engine.store("test-agent", { content: "the user has a cat named Pixel" });
    await engine.store("test-agent", {
      content: "the user's favorite color is blue",
    });
    await engine.store("test-agent", {
      content: "the user lives in Lisbon",
    });
    const { api, tools } = makeMockApi();
    spindleMemoryExtension(api);
    return tools.find((t) => t.name === "spindle_memory_recall")!;
  }

  it("returns matching memories as a ranked text result", async () => {
    const recall = await seedAndGetTool();
    const result = await recall.execute(
      "call-1",
      { query: "Pixel" },
      undefined,
      undefined,
      {}
    );
    expect(result.content[0].text).toMatch(/Found 1 memory/);
    expect(result.content[0].text).toMatch(/Pixel/);
  });

  it("returns 'No memories matched' when empty", async () => {
    const recall = await seedAndGetTool();
    const result = await recall.execute(
      "call-1",
      { query: "nonexistent" },
      undefined,
      undefined,
      {}
    );
    expect(result.content[0].text).toMatch(/No memories matched/);
    expect((result.details as { count: number }).count).toBe(0);
  });

  it("honors the limit parameter", async () => {
    const recall = await seedAndGetTool();
    const result = await recall.execute(
      "call-1",
      { query: "user", limit: 2 },
      undefined,
      undefined,
      {}
    );
    const details = result.details as { count: number; ids: number[] };
    expect(details.count).toBeLessThanOrEqual(2);
  });

  it("defaults limit to 10 when not provided", async () => {
    // Store 15 memories, check recall returns 10
    for (let i = 0; i < 15; i++) {
      await engine.store("test-agent", { content: `fact number ${i}` });
    }
    const { api, tools } = makeMockApi();
    spindleMemoryExtension(api);
    const recall = tools.find((t) => t.name === "spindle_memory_recall")!;
    const result = await recall.execute(
      "call-1",
      { query: "fact" },
      undefined,
      undefined,
      {}
    );
    const details = result.details as { count: number };
    expect(details.count).toBe(10);
  });
});

describe("spindle_memory_associate tool (Phase 2.1, daydream-only)", () => {
  it("is NOT registered in main context", () => {
    // Default beforeEach state: load context = main. Even with the
    // store tool enabled, the main session never gets associate.
    const { api, tools } = makeMockApi();
    spindleMemoryExtension(api);
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("spindle_memory_associate");
  });

  it("is NOT registered when mainStoreEnabled=false but context is still main", () => {
    bindMainStoreEnabled(false);
    const { api, tools } = makeMockApi();
    spindleMemoryExtension(api);
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("spindle_memory_associate");
  });

  it("IS registered when load context is daydream", () => {
    bindLoadContext("daydream");
    const { api, tools } = makeMockApi();
    spindleMemoryExtension(api);
    const names = tools.map((t) => t.name);
    expect(names).toContain("spindle_memory_associate");
  });

  it("daydream-context associate tool reinforces pairs in the engine", async () => {
    // Seed a few memories first
    const ids = [
      await engine.store("test-agent", { content: "associate target alpha" }),
      await engine.store("test-agent", { content: "associate target beta" }),
      await engine.store("test-agent", { content: "associate target gamma" }),
    ];
    bindLoadContext("daydream");
    const { api, tools } = makeMockApi();
    spindleMemoryExtension(api);
    const associate = tools.find((t) => t.name === "spindle_memory_associate")!;
    const result = await associate.execute(
      "call-1",
      { memory_ids: ids },
      undefined,
      undefined,
      {}
    );
    expect(result.content[0].text).toMatch(/Reinforced 3 pairs/);
    const details = result.details as { reinforced: number; skipped: number };
    expect(details.reinforced).toBe(3);
    expect(details.skipped).toBe(0);

    // Sanity check: links table should have 3 rows.
    const links = engine.getLinks("test-agent", ids[0]);
    expect(links.length).toBe(2); // links to ids[1] and ids[2]
  });

  it("daydream-context associate tool skips pairs with invisible memories", async () => {
    // alice (test-agent) creates one memory; we'll pretend a second id
    // from a different agent's private memory is being passed in.
    engine.registerAgent("other-agent");
    const visible = await engine.store("test-agent", { content: "visible to alice" });
    const invisible = await engine.store("other-agent", {
      content: "private to other",
    });
    bindLoadContext("daydream");
    const { api, tools } = makeMockApi();
    spindleMemoryExtension(api);
    const associate = tools.find((t) => t.name === "spindle_memory_associate")!;
    const result = await associate.execute(
      "call-1",
      { memory_ids: [visible, invisible] },
      undefined,
      undefined,
      {}
    );
    const details = result.details as { reinforced: number; skipped: number };
    expect(details.reinforced).toBe(0);
    expect(details.skipped).toBe(1);
    expect(result.content[0].text).toMatch(/skipped 1/);
  });
});

// ============================================================================
// spindle_memory_forget (Phase 5.1)
// ============================================================================

describe("spindle_memory_forget tool", () => {
  it("is NOT registered in main context", () => {
    const { api, tools } = makeMockApi();
    spindleMemoryExtension(api);
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("spindle_memory_forget");
  });

  it("IS registered in daydream context", () => {
    bindDaydreamActive(true);
    bindLoadContext("daydream");
    const { api, tools } = makeMockApi();
    spindleMemoryExtension(api);
    const names = tools.map((t) => t.name);
    expect(names).toContain("spindle_memory_forget");
  });

  it("tombstones a visible memory owned by the curator agent", async () => {
    const id = await engine.store("test-agent", { content: "outdated fact" });
    bindDaydreamActive(true);
    bindLoadContext("daydream");
    const { api, tools } = makeMockApi();
    spindleMemoryExtension(api);
    const forget = tools.find((t) => t.name === "spindle_memory_forget")!;
    const result = await forget.execute(
      "call-1",
      { ids: [id], reason: "user_correction" },
      undefined,
      undefined,
      {}
    );
    const details = result.details as {
      tombstoned: number;
      skipped: number;
      skipped_ids: number[];
      reason: string;
    };
    expect(details.tombstoned).toBe(1);
    expect(details.skipped).toBe(0);
    expect(details.reason).toBe("user_correction");
    expect(engine.getById("test-agent", id)).toBeNull();
  });

  it("skips ids owned by a different agent without tombstoning anything", async () => {
    engine.registerAgent("other-agent", "Other");
    const mine = await engine.store("test-agent", { content: "mine" });
    const theirs = await engine.store("other-agent", { content: "theirs" });
    bindDaydreamActive(true);
    bindLoadContext("daydream");
    const { api, tools } = makeMockApi();
    spindleMemoryExtension(api);
    const forget = tools.find((t) => t.name === "spindle_memory_forget")!;
    const result = await forget.execute(
      "call-1",
      { ids: [mine, theirs], reason: "test" },
      undefined,
      undefined,
      {}
    );
    const details = result.details as {
      tombstoned: number;
      skipped: number;
      skipped_ids: number[];
    };
    expect(details.tombstoned).toBe(1);
    expect(details.skipped).toBe(1);
    expect(details.skipped_ids).toEqual([theirs]);
    // Other agent's memory must remain active
    expect(engine.getById("other-agent", theirs)).not.toBeNull();
    expect(engine.getById("test-agent", mine)).toBeNull();
  });

  it("reports all-skipped when no ids are owned by the curator agent", async () => {
    engine.registerAgent("other-agent", "Other");
    const theirs = await engine.store("other-agent", { content: "theirs" });
    bindDaydreamActive(true);
    bindLoadContext("daydream");
    const { api, tools } = makeMockApi();
    spindleMemoryExtension(api);
    const forget = tools.find((t) => t.name === "spindle_memory_forget")!;
    const result = await forget.execute(
      "call-1",
      { ids: [theirs], reason: "test" },
      undefined,
      undefined,
      {}
    );
    const details = result.details as { tombstoned: number; skipped: number };
    expect(details.tombstoned).toBe(0);
    expect(details.skipped).toBe(1);
    expect(engine.getById("other-agent", theirs)).not.toBeNull();
  });
});
