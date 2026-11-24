/**
 * ContextTelemetryRecorder — subscribes to a main pi AgentSession's
 * event stream and writes one `context_stats` row per completed turn
 * plus `compact_events` rows bracketing auto-compaction runs.
 *
 * Design notes:
 *   - One instance per spindle process, attached BEFORE any channel
 *     starts processing inbound messages so the first user turn is
 *     captured (boot-order contract enforced in src/index.ts).
 *   - The recorder is a read-only consumer of the session: it never
 *     calls prompt(), compact(), or anything mutating. All state lives
 *     in the Turn accumulator + the DB.
 *   - Pi already brackets auto-compaction with
 *     `auto_compaction_start` / `auto_compaction_end` (see
 *     node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts:41-48),
 *     so compaction detection is event-driven — no polling, no
 *     heuristics.
 *   - External callers (e.g. PR 2's CompactNudgeRunner, the Telegram
 *     /compact command) can report their own compact events via
 *     `recordExternalCompact(...)` so every compaction shows up in
 *     the `compact_events` table with the right `trigger` label.
 */

import type { Database } from "bun:sqlite";
import type {
  AgentSession,
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import {
  insertCompactEventStart,
  insertContextStat,
  updateCompactEventEnd,
  type CompactTrigger,
  type InstructionsSource,
} from "./store";

interface TurnAccumulator {
  userPromptAt: number | null;
  firstTokenAt: number | null;
  toolCallCount: number;
  compactedThisTurn: boolean;
  lastCompactTrigger: CompactTrigger | null;
  lastCompactTokensBefore: number | null;
  errorMessage: string | null;
}

function makeAccumulator(): TurnAccumulator {
  return {
    userPromptAt: null,
    firstTokenAt: null,
    toolCallCount: 0,
    compactedThisTurn: false,
    lastCompactTrigger: null,
    lastCompactTokensBefore: null,
    errorMessage: null,
  };
}

export interface ContextTelemetryRecorderOptions {
  session: AgentSession;
  db: Database;
  agentId: string;
  /** Defaults to Date.now; injectable for tests. */
  now?: () => number;
  /**
   * Optional observer called after each `context_stats` row is written.
   * Used by tests to assert row contents without re-querying the DB.
   */
  onStatWritten?: (row: { id: number; totalTokens: number | null }) => void;
}

/**
 * Minimal view of the pi session-manager surface we read. Kept narrow
 * and cast through `unknown` where the API is informal (pi-agent's
 * session.sessionManager is not fully typed in its public surface).
 */
interface SessionMetaView {
  sessionManager?: {
    getSessionId?: () => string;
    getSessionFile?: () => string | undefined;
  };
}

export class ContextTelemetryRecorder {
  private readonly session: AgentSession;
  private readonly db: Database;
  private readonly agentId: string;
  private readonly nowFn: () => number;
  private readonly onStatWritten?: (row: {
    id: number;
    totalTokens: number | null;
  }) => void;

  private unsubscribe: (() => void) | null = null;
  private turn: TurnAccumulator = makeAccumulator();
  private turnIndex: number = 0;

  // pi_auto compact bracketing: set on auto_compaction_start, cleared
  // on auto_compaction_end. If an auto_compaction_end arrives without
  // a matching start (shouldn't happen but defensive), we ignore it.
  private openAutoCompactEventId: number | null = null;
  private openAutoCompactStartedAt: number | null = null;
  private openAutoCompactReason: string | null = null;

  constructor(opts: ContextTelemetryRecorderOptions) {
    this.session = opts.session;
    this.db = opts.db;
    this.agentId = opts.agentId;
    this.nowFn = opts.now ?? Date.now;
    this.onStatWritten = opts.onStatWritten;
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.session.subscribe((event) => {
      try {
        this.onEvent(event);
      } catch (err) {
        // Telemetry must never crash the main event loop. Log and drop.
        console.warn(
          `[telemetry] recorder event handler threw: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    });
  }

  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  /**
   * Report a compaction that was kicked off by code outside the
   * recorder (CompactNudgeRunner in PR 2, /compact slash command in
   * Telegram, daydream cadence in PR 3). Returns the compact_events
   * row id so the caller can close it with `endExternalCompact`.
   */
  recordExternalCompactStart(
    trigger: CompactTrigger,
    options: {
      reason?: string | null;
      instructionsSource?: InstructionsSource | null;
    } = {}
  ): number {
    this.turn.compactedThisTurn = true;
    this.turn.lastCompactTrigger = trigger;
    return insertCompactEventStart(this.db, {
      agentId: this.agentId,
      sessionId: this.currentSessionId(),
      startedAt: this.nowFn(),
      trigger,
      reason: options.reason ?? null,
      instructionsSource: options.instructionsSource ?? null,
    });
  }

  recordExternalCompactEnd(
    id: number,
    options: {
      tokensBefore?: number | null;
      tokensAfter?: number | null;
      aborted?: boolean;
      error?: string | null;
    } = {}
  ): void {
    if (typeof options.tokensBefore === "number") {
      this.turn.lastCompactTokensBefore = options.tokensBefore;
    }
    updateCompactEventEnd(this.db, {
      id,
      endedAt: this.nowFn(),
      tokensBefore: options.tokensBefore ?? null,
      tokensAfter: options.tokensAfter ?? null,
      aborted: options.aborted ?? false,
      error: options.error ?? null,
    });
  }

  private onEvent(event: AgentSessionEvent): void {
    switch (event.type) {
      case "message_start":
        this.onMessageStart(event);
        break;
      case "message_update":
        this.onMessageUpdate(event);
        break;
      case "tool_execution_start":
        this.turn.toolCallCount += 1;
        break;
      case "message_end":
        this.onMessageEnd(event);
        break;
      case "agent_end":
        this.writeTurnRow();
        break;
      case "compaction_start":
        this.onAutoCompactStart(event);
        break;
      case "compaction_end":
        this.onAutoCompactEnd(event);
        break;
      default:
        break;
    }
  }

  private onMessageStart(
    event: Extract<AgentSessionEvent, { type: "message_start" }>
  ): void {
    const msg = event.message as unknown as { role?: string };
    if (msg?.role === "user" && this.turn.userPromptAt === null) {
      this.turn.userPromptAt = this.nowFn();
    }
  }

  private onMessageUpdate(
    event: Extract<AgentSessionEvent, { type: "message_update" }>
  ): void {
    const ev = event.assistantMessageEvent as unknown as { type?: string };
    if (ev?.type === "text_delta" && this.turn.firstTokenAt === null) {
      this.turn.firstTokenAt = this.nowFn();
    }
  }

  private onMessageEnd(
    event: Extract<AgentSessionEvent, { type: "message_end" }>
  ): void {
    const msg = event.message as unknown as {
      errorMessage?: string;
    };
    if (msg?.errorMessage) {
      this.turn.errorMessage = msg.errorMessage;
    }
  }

  private onAutoCompactStart(
    event: Extract<AgentSessionEvent, { type: "compaction_start" }>
  ): void {
    this.openAutoCompactStartedAt = this.nowFn();
    this.openAutoCompactReason = event.reason ?? null;
    this.openAutoCompactEventId = insertCompactEventStart(this.db, {
      agentId: this.agentId,
      sessionId: this.currentSessionId(),
      startedAt: this.openAutoCompactStartedAt,
      trigger: "pi_auto",
      reason: this.openAutoCompactReason,
      instructionsSource: "none",
    });
    this.turn.compactedThisTurn = true;
    this.turn.lastCompactTrigger = "pi_auto";
  }

  private onAutoCompactEnd(
    event: Extract<AgentSessionEvent, { type: "compaction_end" }>
  ): void {
    if (this.openAutoCompactEventId === null) return;
    const tokensBefore = event.result?.tokensBefore ?? null;
    if (typeof tokensBefore === "number") {
      this.turn.lastCompactTokensBefore = tokensBefore;
    }
    updateCompactEventEnd(this.db, {
      id: this.openAutoCompactEventId,
      endedAt: this.nowFn(),
      tokensBefore,
      tokensAfter: null,
      aborted: Boolean(event.aborted),
      error: event.errorMessage ?? null,
    });
    this.openAutoCompactEventId = null;
    this.openAutoCompactStartedAt = null;
    this.openAutoCompactReason = null;
  }

  private writeTurnRow(): void {
    const recordedAt = this.nowFn();

    const usage = this.readContextUsage();
    const stats = this.readSessionStats();
    const model = this.readModel();
    const sessionId = stats?.sessionId ?? this.currentSessionId();
    const sessionFile =
      stats?.sessionFile ??
      (this.session as unknown as SessionMetaView).sessionManager?.getSessionFile?.() ??
      null;

    const msSincePrompt =
      this.turn.userPromptAt !== null
        ? recordedAt - this.turn.userPromptAt
        : null;
    const msSinceFirstToken =
      this.turn.firstTokenAt !== null
        ? recordedAt - this.turn.firstTokenAt
        : null;

    const id = insertContextStat(this.db, {
      agentId: this.agentId,
      sessionId,
      sessionFile,
      turnIndex: this.turnIndex,
      recordedAt,
      msSincePrompt,
      msSinceFirstToken,
      inputTokens: stats?.tokens.input ?? null,
      outputTokens: stats?.tokens.output ?? null,
      cacheRead: stats?.tokens.cacheRead ?? null,
      cacheWrite: stats?.tokens.cacheWrite ?? null,
      totalTokens: stats?.tokens.total ?? null,
      contextTokens: usage?.tokens ?? null,
      contextWindow: usage?.contextWindow ?? null,
      contextPercent: usage?.percent ?? null,
      toolCalls: this.turn.toolCallCount,
      compactedThisTurn: this.turn.compactedThisTurn,
      compactTrigger: this.turn.lastCompactTrigger,
      compactTokensBefore: this.turn.lastCompactTokensBefore,
      error: this.turn.errorMessage,
      model: model.id,
      modelProvider: model.provider,
    });

    this.onStatWritten?.({ id, totalTokens: stats?.tokens.total ?? null });

    this.turnIndex += 1;
    this.turn = makeAccumulator();
  }

  /**
   * Model identity for the turn just completed.
   *
   * Read at turn END rather than turn start: an agent can swap models
   * mid-session (a scheduled command can override it per task), and what
   * we want to attribute the latency to is whatever actually served the
   * turn.
   *
   * Same shape as src/state/writer.ts readModel(). `session.model` is
   * typed `Model<any> | undefined` and is undefined before a model is
   * selected, so both fields are independently nullable and any throw
   * degrades to nulls — telemetry must never break a turn.
   */
  private readModel(): { id: string | null; provider: string | null } {
    try {
      const raw = this.session as unknown as {
        model?: { id?: string; provider?: string };
      };
      return {
        id: raw.model?.id ?? null,
        provider: raw.model?.provider ?? null,
      };
    } catch {
      return { id: null, provider: null };
    }
  }

  private readContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined {
    try {
      const usage = this.session.getContextUsage();
      return usage ?? undefined;
    } catch {
      return undefined;
    }
  }

  private readSessionStats(): {
    sessionFile: string | undefined;
    sessionId: string;
    tokens: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      total: number;
    };
  } | undefined {
    try {
      return this.session.getSessionStats();
    } catch {
      return undefined;
    }
  }

  private currentSessionId(): string {
    const stats = this.readSessionStats();
    if (stats?.sessionId) return stats.sessionId;
    const sm = (this.session as unknown as SessionMetaView).sessionManager;
    return sm?.getSessionId?.() ?? "unknown";
  }
}
