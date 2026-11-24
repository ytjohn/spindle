import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { MemoryEngine } from "../../src/memory/engine";
import { DaydreamRunner } from "../../src/daydream/runner";
import type {
  EphemeralSession,
  EphemeralSessionFactory,
} from "../../src/daydream/cycle";
import type { CycleResult } from "../../src/daydream/types";

let tmpDir: string;
let engine: MemoryEngine;
let sessionFile: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "spindle-dd-runner-"));
  engine = await MemoryEngine.open({ database_path: join(tmpDir, "memory.db") });
  engine.registerAgent("eliza", "Eliza");
  sessionFile = join(tmpDir, "session.jsonl");
});

afterEach(() => {
  engine.close();
  rmSync(tmpDir, { recursive: true, force: true });
  vi.useRealTimers();
});

/**
 * Build a minimal pi session fixture with N conversational turns.
 * Timestamps are in the FUTURE relative to Date.now() at fixture-write
 * time, so the runner's default "now" watermark (set at construction)
 * is earlier than every entry. That way reads always include the whole
 * fixture. If tests need to use a custom `now` injection, they should
 * set the fixture `baseOffset` to align.
 */
function writeFixture(count: number, baseOffsetMs = 60_000): void {
  const start = Date.now() + baseOffsetMs;
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: "sess",
      timestamp: new Date(start).toISOString(),
      cwd: "/t",
    }),
  ];
  for (let i = 0; i < count; i++) {
    lines.push(
      JSON.stringify({
        type: "message",
        id: `m${i}`,
        parentId: i === 0 ? null : `m${i - 1}`,
        timestamp: new Date(start + i * 1000).toISOString(),
        message: {
          role: i % 2 === 0 ? "user" : "assistant",
          content: [{ type: "text", text: `turn ${i}` }],
        },
      })
    );
  }
  writeFileSync(sessionFile, lines.join("\n") + "\n");
}

/** Minimal mock session that fires N memory_store + message_end + agent_end. */
function makeMockFactory(storeCount = 0): {
  factory: EphemeralSessionFactory;
  callCount: () => number;
} {
  let calls = 0;
  const factory: EphemeralSessionFactory = async () => {
    calls++;
    const subs: Array<(e: unknown) => void> = [];
    const session: EphemeralSession = {
      async prompt() {
        for (let i = 0; i < storeCount; i++) {
          for (const cb of [...subs]) {
            cb({
              type: "tool_execution_end",
              toolCallId: `c${i}`,
              toolName: "spindle_memory_store",
              result: { id: i + 1 },
              isError: false,
            });
          }
        }
        for (const cb of [...subs]) cb({ type: "message_end", message: {} });
        // cycle.ts waits for agent_end (pi's terminal event) — see the
        // matching note in tests/daydream/cycle.test.ts.
        for (const cb of [...subs]) cb({ type: "agent_end", messages: [] });
      },
      subscribe(cb) {
        subs.push(cb);
        return () => {
          const idx = subs.indexOf(cb);
          if (idx !== -1) subs.splice(idx, 1);
        };
      },
      close() {},
    };
    return session;
  };
  return { factory, callCount: () => calls };
}

// ============================================================================
// Basic lifecycle
// ============================================================================

describe("DaydreamRunner — lifecycle", () => {
  it("isRunning is false before start and after stop", async () => {
    const { factory } = makeMockFactory();
    const runner = new DaydreamRunner({
      engine,
      agentId: "eliza",
      sessionFile,
      config: { interval_minutes: 30 },
      sessionFactory: factory,
    });
    expect(runner.isRunning).toBe(false);
    runner.start();
    expect(runner.isRunning).toBe(true);
    await runner.stop();
    expect(runner.isRunning).toBe(false);
  });

  it("start() is idempotent", () => {
    const { factory } = makeMockFactory();
    const runner = new DaydreamRunner({
      engine,
      agentId: "eliza",
      sessionFile,
      config: { interval_minutes: 30 },
      sessionFactory: factory,
    });
    runner.start();
    runner.start();
    // Only one interval should be active — verify by the test below
    // that cycles don't double-fire
    expect(runner.isRunning).toBe(true);
  });

  it("stop() is idempotent and safe to call before start", async () => {
    const { factory } = makeMockFactory();
    const runner = new DaydreamRunner({
      engine,
      agentId: "eliza",
      sessionFile,
      config: {},
      sessionFactory: factory,
    });
    await expect(runner.stop()).resolves.toBeUndefined();
    runner.start();
    await runner.stop();
    await runner.stop();
    expect(runner.isRunning).toBe(false);
  });
});

// ============================================================================
// Scheduling — tested via an injected setIntervalFn so we can verify
// the timing contract without fighting fake-timer promise flushing.
// Cycle execution correctness is covered via runner.tick() directly.
// ============================================================================

interface MockIntervalHandle {
  readonly id: number;
  readonly handler: () => void;
  readonly delayMs: number;
  cleared: boolean;
}

function makeMockScheduler(): {
  setIntervalFn: typeof setInterval;
  clearIntervalFn: typeof clearInterval;
  handles: MockIntervalHandle[];
  /** Invoke a registered interval's handler N times (as if the timer fired). */
  fire: (id: number, times?: number) => void;
} {
  const handles: MockIntervalHandle[] = [];
  let nextId = 1;
  const setIntervalFn = ((fn: () => void, ms: number) => {
    const h: MockIntervalHandle = {
      id: nextId++,
      handler: fn,
      delayMs: ms,
      cleared: false,
    };
    handles.push(h);
    return h.id as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  const clearIntervalFn = ((id: unknown) => {
    const h = handles.find((h) => h.id === id);
    if (h) h.cleared = true;
  }) as typeof clearInterval;
  return {
    setIntervalFn,
    clearIntervalFn,
    handles,
    fire: (id: number, times = 1) => {
      const h = handles.find((x) => x.id === id);
      if (!h || h.cleared) throw new Error(`no active interval handle ${id}`);
      for (let i = 0; i < times; i++) h.handler();
    },
  };
}

describe("DaydreamRunner — scheduling", () => {
  it("registers a setInterval at the configured interval_minutes", () => {
    writeFixture(4);
    const { factory } = makeMockFactory();
    const sched = makeMockScheduler();
    const runner = new DaydreamRunner({
      engine,
      agentId: "eliza",
      sessionFile,
      config: { interval_minutes: 10 },
      sessionFactory: factory,
      setIntervalFn: sched.setIntervalFn,
      clearIntervalFn: sched.clearIntervalFn,
    });
    runner.start();
    expect(sched.handles).toHaveLength(1);
    expect(sched.handles[0].delayMs).toBe(10 * 60_000);
    expect(sched.handles[0].cleared).toBe(false);
    // No cycle runs at start time — only when the handler fires
    void runner.stop();
  });

  it("defaults to 30-minute interval when unset", () => {
    writeFixture(4);
    const { factory } = makeMockFactory();
    const sched = makeMockScheduler();
    const runner = new DaydreamRunner({
      engine,
      agentId: "eliza",
      sessionFile,
      config: {},
      sessionFactory: factory,
      setIntervalFn: sched.setIntervalFn,
      clearIntervalFn: sched.clearIntervalFn,
    });
    runner.start();
    expect(sched.handles[0].delayMs).toBe(30 * 60_000);
    void runner.stop();
  });

  it("stop() clears the registered interval", async () => {
    const { factory } = makeMockFactory();
    const sched = makeMockScheduler();
    const runner = new DaydreamRunner({
      engine,
      agentId: "eliza",
      sessionFile,
      config: { interval_minutes: 5 },
      sessionFactory: factory,
      setIntervalFn: sched.setIntervalFn,
      clearIntervalFn: sched.clearIntervalFn,
    });
    runner.start();
    expect(sched.handles[0].cleared).toBe(false);
    await runner.stop();
    expect(sched.handles[0].cleared).toBe(true);
  });

  it("tick handler firing runs one cycle per call", async () => {
    writeFixture(4);
    const { factory, callCount } = makeMockFactory(2);
    const sched = makeMockScheduler();
    const runner = new DaydreamRunner({
      engine,
      agentId: "eliza",
      sessionFile,
      config: { interval_minutes: 5 },
      sessionFactory: factory,
      setIntervalFn: sched.setIntervalFn,
      clearIntervalFn: sched.clearIntervalFn,
    });
    runner.start();

    // Manually fire the interval handler three times and let the
    // async onTick chains drain between each
    sched.fire(sched.handles[0].id);
    await new Promise((r) => setTimeout(r, 0));
    sched.fire(sched.handles[0].id);
    await new Promise((r) => setTimeout(r, 0));
    sched.fire(sched.handles[0].id);
    await new Promise((r) => setTimeout(r, 0));
    // And one more tick to fully drain
    await new Promise((r) => setTimeout(r, 5));

    expect(callCount()).toBe(3);
    await runner.stop();
  });
});

describe("DaydreamRunner — tick() execution", () => {
  it("runs a single cycle and reports the result", async () => {
    writeFixture(4);
    const { factory, callCount } = makeMockFactory(2);
    const runner = new DaydreamRunner({
      engine,
      agentId: "eliza",
      sessionFile,
      config: {},
      sessionFactory: factory,
    });
    runner.start();
    const result = await runner.tick();
    expect(result).not.toBeNull();
    expect(result?.skipped).toBe(false);
    expect(result?.errored).toBe(false);
    expect(result?.stored).toBe(2);
    expect(callCount()).toBe(1);
    await runner.stop();
  });

  it("drops overlapping tick() calls when a cycle is still running", async () => {
    writeFixture(4);
    let release: (() => void) | null = null;
    const factory: EphemeralSessionFactory = async () => {
      const subs: Array<(e: unknown) => void> = [];
      return {
        async prompt() {
          // Hang until explicitly released
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          for (const cb of [...subs]) cb({ type: "message_end", message: {} });
          for (const cb of [...subs]) cb({ type: "agent_end", messages: [] });
        },
        subscribe(cb) {
          subs.push(cb);
          return () => {};
        },
        close() {},
      };
    };

    const runner = new DaydreamRunner({
      engine,
      agentId: "eliza",
      sessionFile,
      config: {},
      sessionFactory: factory,
    });
    runner.start();

    // Launch cycle #1 — it hangs
    const cycle1 = runner.tick();
    await new Promise((r) => setTimeout(r, 0));

    // Cycle #2 while #1 is running — should return null (no new cycle started)
    const cycle2Promise = runner.tick();
    await new Promise((r) => setTimeout(r, 0));

    // Release the hung cycle
    release!();
    const [r1, r2] = await Promise.all([cycle1, cycle2Promise]);
    expect(r1?.skipped).toBe(false);
    // The second call returns null because no NEW cycle was started
    expect(r2).toBeNull();
    await runner.stop();
  });

  it("continues after an errored cycle", async () => {
    writeFixture(4);
    let cycleNum = 0;
    const factory: EphemeralSessionFactory = async () => {
      cycleNum++;
      const subs: Array<(e: unknown) => void> = [];
      return {
        async prompt() {
          if (cycleNum === 1) {
            for (const cb of [...subs])
              cb({
                type: "message_end",
                message: { errorMessage: "simulated" },
              });
            for (const cb of [...subs]) cb({ type: "agent_end", messages: [] });
            return;
          }
          for (const cb of [...subs]) cb({ type: "message_end", message: {} });
          for (const cb of [...subs]) cb({ type: "agent_end", messages: [] });
        },
        subscribe(cb) {
          subs.push(cb);
          return () => {};
        },
        close() {},
      };
    };
    const results: CycleResult[] = [];
    const runner = new DaydreamRunner({
      engine,
      agentId: "eliza",
      sessionFile,
      config: {},
      sessionFactory: factory,
      onCycleComplete: (r) => results.push(r),
    });
    runner.start();
    await runner.tick();
    await runner.tick();
    await runner.tick();
    expect(cycleNum).toBe(3);
    expect(results[0].errored).toBe(true);
    expect(results[1].errored).toBe(false);
    expect(results[2].errored).toBe(false);
    await runner.stop();
  });
});

// ============================================================================
// Watermark + clock-jump handling
// ============================================================================

describe("DaydreamRunner — watermark", () => {
  it("advances watermark on successful cycles", async () => {
    writeFixture(4);
    const { factory } = makeMockFactory(0);

    let t = Date.parse("2026-04-12T10:00:00.000Z");
    const runner = new DaydreamRunner({
      engine,
      agentId: "eliza",
      sessionFile,
      config: {},
      sessionFactory: factory,
      now: () => t,
    });
    runner.start();
    const initialWatermark = runner.currentWatermark;

    // Advance the virtual clock and fire a cycle manually
    t = Date.parse("2026-04-12T10:30:00.000Z");
    const result = await runner.tick();
    expect(result?.skipped).toBe(false);
    expect(result?.errored).toBe(false);
    expect(runner.currentWatermark).toBeGreaterThan(initialWatermark);
    expect(runner.currentWatermark).toBe(t);

    await runner.stop();
  });

  it("does NOT advance watermark on skipped cycles", async () => {
    writeFixture(1); // below default min_turns=2
    const { factory } = makeMockFactory(0);
    const runner = new DaydreamRunner({
      engine,
      agentId: "eliza",
      sessionFile,
      config: {},
      sessionFactory: factory,
    });
    runner.start();
    const before = runner.currentWatermark;
    const result = await runner.tick();
    expect(result?.skipped).toBe(true);
    expect(runner.currentWatermark).toBe(before);
    await runner.stop();
  });

  it("does NOT advance watermark on errored cycles", async () => {
    writeFixture(4);
    const factory: EphemeralSessionFactory = async () => {
      const subs: Array<(e: unknown) => void> = [];
      return {
        async prompt() {
          for (const cb of [...subs])
            cb({ type: "message_end", message: { errorMessage: "boom" } });
          for (const cb of [...subs]) cb({ type: "agent_end", messages: [] });
        },
        subscribe(cb) {
          subs.push(cb);
          return () => {};
        },
        close() {},
      };
    };

    const runner = new DaydreamRunner({
      engine,
      agentId: "eliza",
      sessionFile,
      config: {},
      sessionFactory: factory,
    });
    runner.start();
    const before = runner.currentWatermark;
    const result = await runner.tick();
    expect(result?.errored).toBe(true);
    expect(runner.currentWatermark).toBe(before);
    await runner.stop();
  });

  it("resets watermark on backward clock jump", async () => {
    writeFixture(4);
    const { factory } = makeMockFactory(0);

    let t = Date.parse("2026-04-12T10:00:00.000Z");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const runner = new DaydreamRunner({
      engine,
      agentId: "eliza",
      sessionFile,
      config: {},
      sessionFactory: factory,
      now: () => t,
    });
    runner.start();
    const initialWatermark = runner.currentWatermark; // = t at construction

    // Jump the clock backward
    t = Date.parse("2026-04-12T09:00:00.000Z");
    await runner.tick();

    expect(runner.currentWatermark).toBeLessThanOrEqual(t);
    expect(
      warnSpy.mock.calls.some((c) =>
        (c[0] as string).includes("clock moved backward")
      )
    ).toBe(true);

    warnSpy.mockRestore();
    await runner.stop();
  });

  it("only warns once on repeated backward clock jumps", async () => {
    writeFixture(4);
    const { factory } = makeMockFactory(0);

    let t = Date.parse("2026-04-12T10:00:00.000Z");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const runner = new DaydreamRunner({
      engine,
      agentId: "eliza",
      sessionFile,
      config: {},
      sessionFactory: factory,
      now: () => t,
    });
    runner.start();

    t = Date.parse("2026-04-12T09:00:00.000Z");
    await runner.tick();
    t = Date.parse("2026-04-12T08:00:00.000Z");
    await runner.tick();
    t = Date.parse("2026-04-12T07:00:00.000Z");
    await runner.tick();

    const backwardWarnings = warnSpy.mock.calls.filter((c) =>
      (c[0] as string).includes("clock moved backward")
    );
    expect(backwardWarnings).toHaveLength(1);

    warnSpy.mockRestore();
    await runner.stop();
  });
});

// ============================================================================
// Observer hook
// ============================================================================

describe("DaydreamRunner — onCycleComplete", () => {
  it("invokes the observer with cycle results", async () => {
    writeFixture(4);
    const { factory } = makeMockFactory(2);
    const results: CycleResult[] = [];
    const runner = new DaydreamRunner({
      engine,
      agentId: "eliza",
      sessionFile,
      config: {},
      sessionFactory: factory,
      onCycleComplete: (r) => results.push(r),
    });
    runner.start();
    await runner.tick();
    expect(results).toHaveLength(1);
    expect(results[0].stored).toBe(2);
    expect(results[0].errored).toBe(false);
    await runner.stop();
  });

  it("catches observer throws without killing the cycle", async () => {
    writeFixture(4);
    const { factory } = makeMockFactory(1);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runner = new DaydreamRunner({
      engine,
      agentId: "eliza",
      sessionFile,
      config: {},
      sessionFactory: factory,
      onCycleComplete: () => {
        throw new Error("observer bug");
      },
    });
    runner.start();
    const result = await runner.tick();
    expect(result?.errored).toBe(false);
    expect(result?.stored).toBe(1);
    expect(
      warnSpy.mock.calls.some((c) =>
        (c[0] as string).includes("observer threw")
      )
    ).toBe(true);
    warnSpy.mockRestore();
    await runner.stop();
  });
});
