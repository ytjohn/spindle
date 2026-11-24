import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, appendFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { MemoryEngine } from "../../src/memory/engine";
import { SessionIngester } from "../../src/sessions/ingester";

const AGENT_ID = "test-agent";

async function makeEngine(dir: string): Promise<MemoryEngine> {
  const engine = await MemoryEngine.open(
    { enabled: true, database_path: join(dir, "memory.db") },
    {},
    dir
  );
  engine.registerAgent(AGENT_ID, "Test Agent");
  return engine;
}

function sessionLine(overrides: Partial<Record<string, unknown>> = {}): string {
  return (
    JSON.stringify({
      type: "session",
      version: 3,
      id: "hdr-id",
      timestamp: "2026-04-16T12:51:12.973Z",
      ...overrides,
    }) + "\n"
  );
}

function userMessage(text: string, ts = "2026-04-16T12:52:00.000Z"): string {
  return (
    JSON.stringify({
      type: "message",
      id: Math.random().toString(36).slice(2, 10),
      parentId: "hdr-id",
      timestamp: ts,
      message: {
        role: "user",
        content: [{ type: "text", text }],
        timestamp: Date.parse(ts),
      },
    }) + "\n"
  );
}

describe("SessionIngester", () => {
  let dir: string;
  let sessionDir: string;
  let engine: MemoryEngine;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "spindle-ingester-"));
    sessionDir = join(dir, "sessions");
    engine = await makeEngine(dir);
  });

  afterEach(async () => {
    engine.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("backfills an existing session file from byte 0", async () => {
    await writeFile(join(sessionDir, "a.jsonl"), sessionLine() + userMessage("hello world"), {
      flag: "wx",
    }).catch(async (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        const { mkdir } = await import("fs/promises");
        await mkdir(sessionDir, { recursive: true });
        await writeFile(join(sessionDir, "a.jsonl"), sessionLine() + userMessage("hello world"));
      } else throw err;
    });

    const ingester = new SessionIngester({ agentId: AGENT_ID, sessionDir, engine });
    const inserted = await ingester.backfill();
    expect(inserted).toBe(2);

    const s = engine.getSession(AGENT_ID, "a");
    expect(s).not.toBeNull();
    expect(s!.eventCount).toBe(2);
    expect(s!.lastIngestedByteOffset).toBeGreaterThan(0);
    expect(s!.startedAt).not.toBeNull();

    const events = engine.listSessionEvents(AGENT_ID, "a");
    expect(events.total).toBe(2);
    expect(events.items[0].eventType).toBe("session");
    expect(events.items[1].eventType).toBe("message");
    expect(events.items[1].role).toBe("user");
    expect(events.items[1].contentText).toBe("hello world");
  });

  it("re-running backfill is a no-op", async () => {
    const { mkdir } = await import("fs/promises");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "a.jsonl"), sessionLine() + userMessage("one"));

    const ingester = new SessionIngester({ agentId: AGENT_ID, sessionDir, engine });
    const first = await ingester.backfill();
    const second = await ingester.backfill();
    expect(first).toBe(2);
    expect(second).toBe(0);

    const events = engine.listSessionEvents(AGENT_ID, "a");
    expect(events.total).toBe(2);
  });

  it("picks up appended lines on the next cycle", async () => {
    const { mkdir } = await import("fs/promises");
    await mkdir(sessionDir, { recursive: true });
    const path = join(sessionDir, "b.jsonl");
    await writeFile(path, sessionLine());

    const ingester = new SessionIngester({ agentId: AGENT_ID, sessionDir, engine });
    await ingester.backfill();
    expect(engine.getSession(AGENT_ID, "b")!.eventCount).toBe(1);

    await appendFile(path, userMessage("second turn"));
    const added = await ingester.runCycle();
    expect(added).toBe(1);

    const s = engine.getSession(AGENT_ID, "b")!;
    expect(s.eventCount).toBe(2);
    const events = engine.listSessionEvents(AGENT_ID, "b");
    expect(events.items.at(-1)!.contentText).toBe("second turn");
  });

  it("does not advance past a partial trailing line", async () => {
    const { mkdir } = await import("fs/promises");
    await mkdir(sessionDir, { recursive: true });
    const path = join(sessionDir, "c.jsonl");
    const fullMsg = userMessage("partial");
    // Write the session header (complete) plus the first half of a
    // message line (no trailing newline yet).
    const halfway = fullMsg.slice(0, Math.floor(fullMsg.length / 2));
    await writeFile(path, sessionLine() + halfway);

    const ingester = new SessionIngester({ agentId: AGENT_ID, sessionDir, engine });
    await ingester.backfill();
    const s1 = engine.getSession(AGENT_ID, "c")!;
    expect(s1.eventCount).toBe(1); // only the header; partial line not ingested

    // Now flush the rest of the line.
    await appendFile(path, fullMsg.slice(halfway.length));
    await ingester.runCycle();
    const s2 = engine.getSession(AGENT_ID, "c")!;
    expect(s2.eventCount).toBe(2);
  });

  it("logs + skips malformed lines but advances past them", async () => {
    const { mkdir } = await import("fs/promises");
    await mkdir(sessionDir, { recursive: true });
    const path = join(sessionDir, "d.jsonl");
    const warnings: string[] = [];
    await writeFile(
      path,
      sessionLine() + "{not json at all\n" + userMessage("after-bad-line")
    );

    const ingester = new SessionIngester({
      agentId: AGENT_ID,
      sessionDir,
      engine,
      logger: {
        info: () => {},
        warn: (m) => warnings.push(m),
        error: () => {},
      },
    });
    await ingester.backfill();

    const s = engine.getSession(AGENT_ID, "d")!;
    expect(s.eventCount).toBe(2); // header + post-bad-line message
    expect(warnings.some((w) => w.includes("skip line"))).toBe(true);

    const events = engine.listSessionEvents(AGENT_ID, "d");
    expect(events.items.at(-1)!.contentText).toBe("after-bad-line");
  });

  it("persists watermark across ingester restart", async () => {
    const { mkdir } = await import("fs/promises");
    await mkdir(sessionDir, { recursive: true });
    const path = join(sessionDir, "e.jsonl");
    await writeFile(path, sessionLine() + userMessage("one"));

    const first = new SessionIngester({ agentId: AGENT_ID, sessionDir, engine });
    await first.backfill();
    const offset1 = engine.getSession(AGENT_ID, "e")!.lastIngestedByteOffset;

    await appendFile(path, userMessage("two"));

    const second = new SessionIngester({ agentId: AGENT_ID, sessionDir, engine });
    const added = await second.backfill();
    expect(added).toBe(1);
    const offset2 = engine.getSession(AGENT_ID, "e")!.lastIngestedByteOffset;
    expect(offset2).toBeGreaterThan(offset1);
  });

  it("start()/stop() runs poll cycles without leaking", async () => {
    const { mkdir } = await import("fs/promises");
    await mkdir(sessionDir, { recursive: true });
    const path = join(sessionDir, "f.jsonl");
    await writeFile(path, sessionLine());

    const ingester = new SessionIngester({
      agentId: AGENT_ID,
      sessionDir,
      engine,
      pollIntervalMs: 50,
    });
    await ingester.backfill();
    ingester.start();
    await appendFile(path, userMessage("live"));
    // Wait a beat for a tick to fire.
    await new Promise((r) => setTimeout(r, 200));
    await ingester.stop();
    const events = engine.listSessionEvents(AGENT_ID, "f");
    expect(events.total).toBeGreaterThanOrEqual(2);
  });

  it("empty session file registers row with event_count=0", async () => {
    const { mkdir } = await import("fs/promises");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "g.jsonl"), "");

    const ingester = new SessionIngester({ agentId: AGENT_ID, sessionDir, engine });
    await ingester.backfill();
    const s = engine.getSession(AGENT_ID, "g");
    expect(s).not.toBeNull();
    expect(s!.eventCount).toBe(0);
    expect(s!.startedAt).toBeNull();
  });
});
