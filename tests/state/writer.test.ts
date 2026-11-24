import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AgentStateWriter, classifyTurnError } from "../../src/state/writer";
import type { AgentState } from "../../src/state/types";

/** Minimal session stub: only what AgentStateWriter actually reads. */
function makeSession(usage: { tokens: number; contextWindow: number; percent: number } | null) {
  let current = usage;
  return {
    session: {
      getContextUsage: () => current,
      subscribe: () => () => {},
      model: { id: "default-model", provider: "local-vllm" },
      thinkingLevel: "low",
    } as never,
    setUsage(u: { tokens: number; contextWindow: number; percent: number }) {
      current = u;
    },
  };
}

describe("AgentStateWriter", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-state-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const read = (): AgentState =>
    JSON.parse(readFileSync(join(dir, ".pi", "agent-state.json"), "utf-8"));

  it("writes a file with the heartbeat and declares its own staleness budget", () => {
    const { session } = makeSession({ tokens: 8000, contextWindow: 131072, percent: 6.1 });
    const w = new AgentStateWriter({ session, agentId: "test", agentDir: dir });
    w.write();
    const s = read();
    expect(existsSync(join(dir, ".pi", "agent-state.json"))).toBe(true);
    expect(s.agent_id).toBe("test");
    // Readers must not need out-of-band knowledge of the write cadence.
    expect(s.stale_after_s).toBeGreaterThan(0);
    expect(Date.parse(s.heartbeat_at)).not.toBeNaN();
    expect(s.model).toBe("default-model");
    expect(s.thinking_level).toBe("low");
  });

  it("reproduces the alive-but-failing signature: heartbeat fresh while turns fail", () => {
    // The whole reason this file exists. An agent's PROCESS was healthy for
    // four hours — a single-timestamp heartbeat would have reported it fine
    // the entire time. The detector is the divergence between the two clocks.
    const { session } = makeSession({ tokens: 126977, contextWindow: 131072, percent: 96.9 });
    const w = new AgentStateWriter({ session, agentId: "mud-agent", agentDir: dir });

    w.recordTurn({ text: "ok", toolCalls: [] }); // one good turn, then it dies
    const healthy = read();
    expect(healthy.last_turn_ok_at).not.toBeNull();

    for (let i = 0; i < 6; i++) {
      w.recordTurn({
        error:
          "400 You passed 126977 input tokens and requested 4096 output tokens. However, the model's context length is only 131072 tokens",
      });
    }

    const s = read();
    // Process clock still ticking...
    expect(Date.now() - Date.parse(s.heartbeat_at)).toBeLessThan(5000);
    // ...while the thinking clock has not moved since the last good turn.
    expect(s.last_turn_ok_at).toBe(healthy.last_turn_ok_at);
    // And attempts ARE happening, which is what separates this from an idle
    // agent. GreaterThanOrEqual, not GreaterThan: these stamps have
    // millisecond resolution and the whole loop above can land inside one
    // millisecond, which flaked roughly 1 run in 8. The error streak below
    // is the assertion that actually proves attempts happened.
    expect(Date.parse(s.last_turn_attempt_at!)).toBeGreaterThanOrEqual(
      Date.parse(s.last_turn_ok_at!),
    );
    expect(s.consecutive_turn_errors).toBe(6);
    expect(s.last_error_class).toBe("context_length_exceeded");
    expect(s.verdict).toBe("unhealthy");
  });

  it("resets the error streak on a successful turn", () => {
    const { session } = makeSession(null);
    const w = new AgentStateWriter({ session, agentId: "t", agentDir: dir });
    w.recordTurn({ error: "boom" });
    w.recordTurn({ error: "boom" });
    expect(read().consecutive_turn_errors).toBe(2);
    w.recordTurn({ text: "fine", toolCalls: [] });
    const s = read();
    expect(s.consecutive_turn_errors).toBe(0);
    expect(s.verdict).toBe("healthy");
  });

  it("tracks tool and text health separately", () => {
    const { session } = makeSession(null);
    const w = new AgentStateWriter({ session, agentId: "t", agentDir: dir });
    w.recordTurn({ toolCalls: ["mud_look"] }); // tool only, no prose
    const s1 = read();
    expect(s1.last_tool_call_ok_at).not.toBeNull();
    expect(s1.last_text_ok_at).toBeNull();
    w.recordTurn({ text: "hello", toolCalls: [] }); // prose only
    const s2 = read();
    expect(s2.last_text_ok_at).not.toBeNull();
  });

  it("derives rate from context history, not from a single level", () => {
    // One agent went 77,616 -> 126,785 in 31 minutes. A level threshold sampled
    // every 10 minutes can be jumped clean over at that speed.
    const h = makeSession({ tokens: 10000, contextWindow: 131072, percent: 7.6 });
    let t = Date.parse("2026-08-27T10:00:00Z");
    const w = new AgentStateWriter({
      session: h.session,
      agentId: "t",
      agentDir: dir,
      nowFn: () => new Date(t),
    });
    w.write();
    t += 10 * 60_000; // ten minutes later
    h.setUsage({ tokens: 60000, contextWindow: 131072, percent: 45.8 });
    w.write();
    const s = read();
    expect(s.context_history.length).toBeGreaterThanOrEqual(2);
    expect(s.context_tokens).toBe(60000);
    // Rate is positive and a projection exists once it is climbing.
    // 50,000 tokens over 10 minutes = 5,000/min.
    expect(s.context_rate_per_min).toBe(5000);
    expect(s.projected_limit_at).not.toBeNull();
    // 71,072 remaining at 5,000/min ~= 14.2 min out.
    const minsOut = (Date.parse(s.projected_limit_at!) - t) / 60_000;
    expect(minsOut).toBeGreaterThan(13);
    expect(minsOut).toBeLessThan(15);
  });

  it("caps context history so the file cannot grow without bound", () => {
    const h = makeSession({ tokens: 1000, contextWindow: 131072, percent: 0.8 });
    const w = new AgentStateWriter({
      session: h.session,
      agentId: "t",
      agentDir: dir,
      historyLength: 3,
    });
    for (let i = 1; i <= 8; i++) {
      h.setUsage({ tokens: 1000 * i, contextWindow: 131072, percent: i });
      w.write();
    }
    expect(read().context_history.length).toBe(3);
  });

  it("reports channel liveness, and connected is not inferred from logged_in", () => {
    const { session } = makeSession(null);
    const w = new AgentStateWriter({
      session,
      agentId: "t",
      agentDir: dir,
      channels: [
        {
          name: "mud",
          start: async () => {},
          stop: async () => {},
          // A state seen in practice: socket open, login never completed.
          getLiveness: () => ({ connected: true, logged_in: false, last_activity_at: null }),
        },
      ],
    });
    w.write();
    const s = read();
    expect(s.channels.mud.connected).toBe(true);
    expect(s.channels.mud.logged_in).toBe(false);
  });

  it("survives a channel whose getLiveness throws", () => {
    const { session } = makeSession(null);
    const w = new AgentStateWriter({
      session,
      agentId: "t",
      agentDir: dir,
      channels: [
        {
          name: "bad",
          start: async () => {},
          stop: async () => {},
          getLiveness: () => {
            throw new Error("nope");
          },
        },
      ],
    });
    w.write();
    expect(read().channels.bad.connected).toBe(false);
  });

  it("never lets a broken session take the agent down", () => {
    const session = {
      getContextUsage: () => {
        throw new Error("session exploded");
      },
      subscribe: () => () => {},
    } as never;
    const w = new AgentStateWriter({ session, agentId: "t", agentDir: dir });
    expect(() => w.write()).not.toThrow();
    expect(read().context_tokens).toBeNull();
  });
});

describe("classifyTurnError", () => {
  it("separates a permanent entitlement loss from a transient fault", () => {
    // A real failure: the Copilot seat stopped listing sonnet-4.6.
    expect(
      classifyTurnError(
        '400 {"error":{"message":"The requested model is not available for integrator \\"vscode-chat\\".","code":"model_not_available_for_integrator","type":"invalid_request_error"}}',
      ),
    ).toBe("model_unavailable");
    expect(
      classifyTurnError('400 {"error":{"message":"The requested model is not supported.","code":"model_not_supported"}}'),
    ).toBe("model_unavailable");
  });

  it("classifies a malformed-request 400 as bad_request, not unknown", () => {
    // A real failure: pi sent the legacy thinking form to Claude 5.
    expect(
      classifyTurnError(
        '400 {"type":"error","error":{"type":"invalid_request_error","message":"\\"thinking.type.enabled\\" is not supported for this model."}}',
      ),
    ).toBe("bad_request");
  });

  it("still prefers the more specific class when both could match", () => {
    // Rate limiting is transient and must not be shadowed by the 400 rules.
    expect(classifyTurnError("429 rate limit exceeded")).toBe("rate_limited");
    expect(classifyTurnError("400 context length exceeded")).toBe("context_length_exceeded");
  });

  it("classifies a context-length overflow", () => {
    expect(
      classifyTurnError(
        "400 You passed 126977 input tokens and requested 4096 output tokens. However, the model's context length is only 131072 tokens",
      ),
    ).toBe("context_length_exceeded");
  });
  it("classifies the rest coarsely", () => {
    expect(classifyTurnError("429 rate limit exceeded")).toBe("rate_limited");
    expect(classifyTurnError("request timed out")).toBe("timeout");
    expect(classifyTurnError("401 Unauthorized")).toBe("auth");
    expect(classifyTurnError("fetch failed")).toBe("network");
    expect(classifyTurnError("503 Service Unavailable")).toBe("upstream_5xx");
    expect(classifyTurnError("something odd")).toBe("unknown");
  });
});
