/**
 * Daydream cycle pipeline — one tick.
 *
 * Reads recent session activity since a watermark, builds a daydream
 * prompt, spawns an ephemeral pi session via an injected factory,
 * runs the prompt, counts memory_store tool calls that fire during
 * the turn, and closes the session cleanly.
 *
 * The ephemeral session is abstracted behind `EphemeralSession` so
 * tests can pass a mock without pulling in pi types. Production
 * wiring happens in `src/index.ts` (Task 6) where we build a factory
 * that creates real pi sessions with the same `MemoryEngine` binding
 * as the main user-facing session.
 *
 * The cycle NEVER touches the main session. It reads the session
 * file from disk as its input and writes to the memory engine as
 * its output — both of which are already shared with the main
 * session via Phase 2's binding pattern.
 */

import type { MemoryEngine } from "../memory/engine";
import type { DaydreamConfig, CycleResult } from "./types";
import type { DaydreamPrompt } from "./prompt";
import { buildDaydreamPrompt } from "./prompt";
import {
  readSessionEntriesSince,
  summarizeActivity,
  type ActivityTurn,
} from "./activity";

/**
 * Minimal interface the cycle needs from an ephemeral pi session.
 * Real pi sessions from `createAgentSession` satisfy this shape;
 * tests can provide a mock that records prompt calls and fires
 * synthetic tool events via the subscribe callback.
 */
export interface EphemeralSession {
  /** Send a user message and await the turn completion. */
  prompt(text: string): Promise<void>;
  /**
   * Subscribe to session events. The callback receives pi's
   * `AgentSessionEvent` union — the cycle listens for `message_end`
   * (turn complete) and `tool_execution_end` (for memory_store calls).
   * Returns an unsubscribe function.
   */
  subscribe(callback: (event: unknown) => void): () => void;
  /** Close the ephemeral session and release resources. */
  close(): Promise<void> | void;
  /**
   * The underlying pi session's computed system prompt. Optional
   * because mocked test sessions don't need to implement it; real
   * sessions expose it via the pi AgentSession getter. Used by the
   * cycle's SPINDLE_DAYDREAM_DEBUG=1 mode to dump what the LLM is
   * actually seeing.
   */
  readonly systemPrompt?: string;
  /**
   * Active tool names the pi session has registered. Same caveat as
   * `systemPrompt` — test mocks may not populate it.
   */
  readonly activeTools?: readonly string[];
  /** Whether the session is currently streaming an LLM response. */
  readonly isStreaming?: boolean;
}

/**
 * Factory that builds an ephemeral session from a daydream prompt.
 * The factory is responsible for:
 *   - Calling pi's `createAgentSession` with an in-memory session manager
 *   - Installing the daydream system prompt via the createAgentSession
 *     systemPrompt option
 *   - Selecting the configured daydream model (or falling back to main)
 *   - Auto-loading the spindle-memory extension so memory_store exists
 *
 * All of that wiring lives in Task 6 (`src/index.ts`); the cycle just
 * receives an already-built factory.
 */
export type EphemeralSessionFactory = (
  prompt: DaydreamPrompt
) => Promise<EphemeralSession>;

export interface CycleOptions {
  engine: MemoryEngine;
  agentId: string;
  agentDisplayName?: string;
  /** Path to the pi session JSONL file for the main session being observed. */
  sessionFile: string;
  /**
   * Unix ms — only process session entries at or after this timestamp.
   * Typically the runner's last-cycle-start time.
   */
  watermark: number;
  /** Daydream-specific config (intervals, caps, model override). */
  config: DaydreamConfig;
  /** Factory for the ephemeral pi session. Injected for testability. */
  sessionFactory: EphemeralSessionFactory;
  /**
   * Clock injection for deterministic tests. Defaults to `Date.now`.
   * The cycle's `startedAt` and prompt `now` come from here.
   */
  now?: () => number;
  /** Max turns to include in the existing-memories context. Default 20. */
  maxExistingMemories?: number;
}

const DEFAULT_MIN_TURNS = 2;
const DEFAULT_MAX_STORE = 5;

/**
 * Run one daydream cycle. Returns a CycleResult describing what happened.
 *
 * Never throws for expected failure modes (no activity, ephemeral session
 * create errors, prompt errors) — those are reported in the result so the
 * runner can keep scheduling. Throws only for programmer errors in the
 * config shape.
 */
export async function runDaydreamCycle(opts: CycleOptions): Promise<CycleResult> {
  const nowFn = opts.now ?? Date.now;
  const startedAt = nowFn();

  const minTurns = opts.config.min_turns_since_last ?? DEFAULT_MIN_TURNS;
  const maxStore = opts.config.max_store_per_cycle ?? DEFAULT_MAX_STORE;

  // --- 1. Read activity since the watermark -------------------------------
  let turns: ActivityTurn[];
  try {
    turns = readSessionEntriesSince(opts.sessionFile, opts.watermark);
  } catch (err) {
    return {
      startedAt,
      skipped: true,
      skipReason: "read_session_failed",
      errored: false,
      errorMessage: err instanceof Error ? err.message : String(err),
      stored: 0,
      durationMs: nowFn() - startedAt,
    };
  }

  // We only count USER + ASSISTANT turns toward the min-turns check —
  // tool result turns don't count as real activity (they're artifacts
  // of the assistant's own tool calls).
  const conversationalTurns = turns.filter(
    (t) => t.role === "user" || t.role === "assistant"
  );
  if (conversationalTurns.length < minTurns) {
    return {
      startedAt,
      skipped: true,
      skipReason: `below_min_turns (${conversationalTurns.length} < ${minTurns})`,
      errored: false,
      stored: 0,
      durationMs: nowFn() - startedAt,
    };
  }

  // --- 2. Pull existing memories for dedup context ------------------------
  const existing = opts.engine.listRecent(
    opts.agentId,
    opts.maxExistingMemories ?? 20
  );
  const existingForPrompt = existing.map((m) => ({
    id: m.id,
    content: m.content,
    visibility: m.visibility,
  }));

  // --- 3. Build the prompt ------------------------------------------------
  const activitySummary = summarizeActivity(turns, startedAt);
  const prompt = buildDaydreamPrompt({
    now: startedAt,
    lastCycleAt: opts.watermark > 0 ? opts.watermark : null,
    agentId: opts.agentId,
    agentDisplayName: opts.agentDisplayName,
    activitySummary,
    existingMemories: existingForPrompt,
    maxStore,
  });

  // --- 4. Spawn ephemeral session -----------------------------------------
  let session: EphemeralSession;
  try {
    session = await opts.sessionFactory(prompt);
  } catch (err) {
    return {
      startedAt,
      skipped: true,
      skipReason: "session_create_failed",
      errored: false,
      errorMessage: err instanceof Error ? err.message : String(err),
      stored: 0,
      durationMs: nowFn() - startedAt,
    };
  }

  // --- 5. Subscribe to events, count tool calls, run prompt, wait for end -
  let stored = 0;
  let turnEnded = false;
  let turnError: string | undefined;

  // Set SPINDLE_DAYDREAM_DEBUG=1 to see every session event during a
  // cycle. Useful for figuring out why the daydream LLM isn't calling
  // tools you expect it to.
  const debug = process.env.SPINDLE_DAYDREAM_DEBUG === "1";
  let assistantText = "";
  const toolCallsSeen: string[] = [];

  const endPromise = new Promise<void>((resolve) => {
    const unsubscribe = session.subscribe((rawEvent) => {
      const event = rawEvent as {
        type?: string;
        toolName?: string;
        isError?: boolean;
        message?: unknown;
        assistantMessageEvent?: { type?: string; delta?: string };
      };
      if (debug) {
        console.log(`[daydream:debug] event ${event.type ?? "?"}`);
      }

      // Accumulate assistant text so we can see what the LLM said (if
      // anything) when debug mode is on.
      if (debug && event.type === "message_update") {
        const a = event.assistantMessageEvent;
        if (a?.type === "text_delta" && typeof a.delta === "string") {
          assistantText += a.delta;
        }
      }

      if (event.type === "tool_execution_start") {
        const name = event.toolName ?? "?";
        toolCallsSeen.push(name);
        if (debug) console.log(`[daydream:debug] tool_execution_start ${name}`);
      }

      if (event.type === "tool_execution_end") {
        if (debug) {
          console.log(
            `[daydream:debug] tool_execution_end ${event.toolName ?? "?"} isError=${event.isError ?? false}`
          );
        }
        if (event.toolName === "spindle_memory_store" && !event.isError) {
          stored++;
        }
      } else if (event.type === "message_end") {
        // Capture per-message error text as it arrives — pi surfaces
        // generation errors on the assistant message, and we want to
        // report the LAST one seen (later messages overwrite earlier).
        const msg = event.message as { errorMessage?: string } | undefined;
        if (msg?.errorMessage) turnError = msg.errorMessage;
      } else if (event.type === "agent_end") {
        // agent_end is the TRUE terminal event for a full pi run —
        // pi's agent-loop emits message_end for the user prompt's own
        // message BEFORE the LLM runs (see agent-loop.js), then again
        // for the assistant message, then tool_execution_start/end
        // fire as tools run, then another message_end for the tool-
        // result message, possibly another assistant turn, and finally
        // turn_end + agent_end. Unsubscribing on the first message_end
        // means we detach BEFORE any tool_execution events arrive and
        // lose the store count — exactly the bug daydream hit where
        // cycles reported stored=0 while memories did land in SQLite
        // because the extension's execute handler ran independently.
        turnEnded = true;
        if (debug) {
          console.log(
            `[daydream:debug] agent_end — tool_calls=[${toolCallsSeen.join(", ") || "(none)"}] errorMessage=${turnError ?? "(none)"}`
          );
          if (assistantText.trim()) {
            const preview = assistantText
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 400);
            console.log(`[daydream:debug] assistant text: ${preview}`);
          } else {
            console.log(`[daydream:debug] assistant text: (empty)`);
          }
        }
        unsubscribe();
        resolve();
      }
    });
  });

  if (debug) {
    // Dump what the LLM actually sees. Helpful for figuring out why
    // prompts don't work — the computed system prompt depends on
    // pi's base builder + our appendSystemPrompt + any agent context
    // files (AGENTS.md) + promptGuidelines from registered tools,
    // and we don't always intuit the shape right.
    const sp = session.systemPrompt;
    if (typeof sp === "string") {
      console.log(
        `[daydream:debug] computed system prompt length=${sp.length} chars`
      );
      // Print the prompt in chunks so it's scannable in the terminal.
      // Splitting at ~600-char lines keeps it greppable without being
      // one giant blob.
      const chunkSize = 600;
      for (let i = 0; i < sp.length; i += chunkSize) {
        const chunk = sp.slice(i, i + chunkSize).replace(/\n/g, "\\n");
        console.log(`[daydream:debug] prompt[${i}]: ${chunk}`);
      }
    } else {
      console.log("[daydream:debug] session.systemPrompt unavailable");
    }
    if (session.activeTools) {
      console.log(
        `[daydream:debug] active tools: ${session.activeTools.join(", ")}`
      );
    }
    console.log(
      `[daydream:debug] user prompt: ${prompt.userPrompt.replace(/\s+/g, " ")}`
    );
  }

  try {
    await session.prompt(prompt.userPrompt);
    // The prompt call may return before the turn fires message_end —
    // wait on the event subscription to signal completion.
    await endPromise;
  } catch (err) {
    return {
      startedAt,
      skipped: false,
      errored: true,
      errorMessage: err instanceof Error ? err.message : String(err),
      stored,
      durationMs: nowFn() - startedAt,
    };
  } finally {
    try {
      await session.close();
    } catch (err) {
      console.warn("[daydream] ephemeral session close failed:", err);
    }
  }

  if (turnError) {
    return {
      startedAt,
      skipped: false,
      errored: true,
      errorMessage: turnError,
      stored,
      durationMs: nowFn() - startedAt,
    };
  }

  if (!turnEnded) {
    return {
      startedAt,
      skipped: false,
      errored: true,
      errorMessage: "session.prompt resolved without firing agent_end",
      stored,
      durationMs: nowFn() - startedAt,
    };
  }

  return {
    startedAt,
    skipped: false,
    errored: false,
    stored,
    durationMs: nowFn() - startedAt,
  };
}
