import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { SlashCommandInfo } from "../types";
import { getBoundTelemetryRecorder } from "../../telemetry/binding";

/**
 * Commands that the Telegram channel handles directly — intercepted
 * before pi's prompt() ever sees them. These exist because pi's
 * session management (newSession, compact, switchSession) lives on
 * the AgentSession object, not as registered extension commands, so
 * pi's slash-command router can't invoke them.
 *
 * This is the same split TelePi uses in src/bot.ts: `TELEPI_LOCAL_COMMAND_NAMES`
 * is intercepted at the bot layer and routed via `bot.command()` handlers
 * instead of `session.prompt()`.
 */

export interface LocalCommandContext {
  session: AgentSession;
  /** Caller-supplied sink for user-visible output. The channel wires this
   *  to its own sendResponse (which splits and sends Telegram messages). */
  reply: (text: string) => void;
}

export interface LocalCommand {
  /** Command name without leading `/`. Must match Telegram command regex [a-z0-9_]{1,32}. */
  name: string;
  description: string;
  /**
   * Run immediately even while a turn is in flight, instead of queueing
   * behind it. Only for commands whose whole point is to act ON the running
   * turn (/stop); anything else must wait so order is preserved.
   */
  whileBusy?: boolean;
  handler: (args: string, ctx: LocalCommandContext) => Promise<void>;
}

/** Parse "/name rest of args" → `{ name, args }`. Returns null if not a slash command. */
export function parseLocalCommand(text: string): { name: string; args: string } | null {
  if (!text.startsWith("/")) return null;
  // Drop leading slashes, then split on first whitespace.
  const stripped = text.replace(/^\/+/, "");
  const match = stripped.match(/^([a-z0-9_]+)(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  return {
    name: match[1].toLowerCase(),
    args: (match[2] ?? "").trim(),
  };
}

/**
 * Registry of local commands. Lookup is case-insensitive via name
 * normalization in `parseLocalCommand`.
 */
export class LocalCommandRegistry {
  private readonly commands = new Map<string, LocalCommand>();

  register(command: LocalCommand): void {
    this.commands.set(command.name.toLowerCase(), command);
  }

  get(name: string): LocalCommand | undefined {
    return this.commands.get(name.toLowerCase());
  }

  has(name: string): boolean {
    return this.commands.has(name.toLowerCase());
  }

  /** Return all registered commands as SlashCommandInfo for registration with Telegram. */
  asSlashCommandInfo(): SlashCommandInfo[] {
    return [...this.commands.values()].map((cmd) => ({
      name: cmd.name,
      description: cmd.description,
      source: "extension" as const, // Close enough — Telegram doesn't care about the source field
    }));
  }
}

// ==================== Built-in local commands ====================

/**
 * Command to start a fresh session, discarding current history.
 *
 * NOT included in `createDefaultLocalCommands` because in the typical
 * "one persistent session per user" workflow, /new is a footgun that
 * drops context the user would want to keep. Use /compact instead for
 * context management. Callers who want /new can explicitly register it:
 *
 *     channel.localCommands.register(newSessionCommand);
 *
 * Session resets at boot time (`spindle run --new`) remain the canonical
 * way to start fresh for a given agent.
 */
export const newSessionCommand: LocalCommand = {
  name: "new",
  description: "Start a new session (clears conversation history)",
  handler: async (_args, ctx) => {
    // AgentSession.newSession() was removed in pi 0.70+. New session creation
    // is now handled via ExtensionCommandContextActions which is not wired into
    // the local command context. Inform the user and suggest restarting spindle.
    ctx.reply(
      "⚠️ /new is not supported in this version. Restart spindle with --new to start a fresh session."
    );
  },
};

export const compactCommand: LocalCommand = {
  name: "compact",
  description: "Compact session context. Optional: /compact <instructions>",
  handler: async (args, ctx) => {
    const instructions = args.length > 0 ? args : undefined;
    ctx.reply("🧹 Compacting…");

    // Bracket the compaction with telemetry so it lands in
    // compact_events. pi's session.compact() does not emit the
    // auto_compaction_start/end events the recorder subscribes to —
    // without explicit bracketing, operator-triggered /compact runs go
    // unrecorded.
    const recorder = getBoundTelemetryRecorder();
    const eventId = recorder?.recordExternalCompactStart("user_manual", {
      reason: "telegram /compact",
      instructionsSource: instructions ? "static" : "none",
    });

    try {
      const result = await ctx.session.compact(instructions);

      // Read post-compact context usage for tokens_after. pi's
      // session.compact() return shape only carries tokensBefore, so
      // we sample getContextUsage() immediately after to capture the
      // new context size. Wrapped because getContextUsage may not be
      // implemented on every provider — treat as best-effort, matching
      // the recorder's own usage-read policy at recorder.ts:325.
      let tokensAfter: number | null = null;
      try {
        const usage = ctx.session.getContextUsage();
        tokensAfter = usage?.tokens ?? null;
      } catch {
        // best-effort
      }

      if (recorder && typeof eventId === "number") {
        recorder.recordExternalCompactEnd(eventId, {
          tokensBefore: result.tokensBefore ?? null,
          tokensAfter,
        });
      }

      const before = result.tokensBefore;
      const haveBefore = typeof before === "number";
      const haveAfter = typeof tokensAfter === "number";
      let saved = "";
      if (haveBefore && haveAfter) {
        const reduction =
          before! > 0
            ? Math.round(((before! - tokensAfter!) / before!) * 100)
            : null;
        saved =
          reduction !== null
            ? ` (${before!.toLocaleString()} → ${tokensAfter!.toLocaleString()} tokens, ${reduction}% reduction)`
            : ` (${before!.toLocaleString()} → ${tokensAfter!.toLocaleString()} tokens)`;
      } else if (haveBefore) {
        saved = ` (${before!.toLocaleString()} tokens compacted)`;
      }
      ctx.reply(`✅ Session compacted${saved}.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (recorder && typeof eventId === "number") {
        recorder.recordExternalCompactEnd(eventId, {
          aborted: true,
          error: msg,
        });
      }
      ctx.reply(`❌ Compaction failed: ${msg}`);
    }
  },
};

export const sessionInfoCommand: LocalCommand = {
  name: "session",
  description: "Show current session info (id, name, message count)",
  handler: async (_args, ctx) => {
    const sm = (
      ctx.session as unknown as {
        sessionManager?: {
          getSessionId?: () => string;
          getSessionName?: () => string | undefined;
          getSessionFile?: () => string | undefined;
          getEntries?: () => unknown[];
          getLeafId?: () => string | undefined;
        };
      }
    ).sessionManager;

    if (!sm) {
      ctx.reply("Session manager not available.");
      return;
    }
    const id = sm.getSessionId?.() ?? "?";
    const name = sm.getSessionName?.() ?? "(unnamed)";
    const file = sm.getSessionFile?.() ?? "(in-memory)";
    const entries = sm.getEntries?.()?.length ?? 0;
    const leaf = sm.getLeafId?.() ?? "(none)";

    ctx.reply(
      [
        "📄 Session info",
        `• id: ${id}`,
        `• name: ${name}`,
        `• file: ${file}`,
        `• entries: ${entries}`,
        `• leaf: ${leaf}`,
      ].join("\n")
    );
  },
};

export const reloadCommand: LocalCommand = {
  name: "reload",
  description: "Reload extensions (picks up edits; won't add new extensions)",
  handler: async (_args, ctx) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = ctx.session as any;
    if (typeof raw.reloadExtensions !== "function") {
      ctx.reply("⚠️ Extension reload not available in this version of pi.");
      return;
    }
    ctx.reply("🔄 Reloading extensions…");
    try {
      await raw.reloadExtensions();
      ctx.reply("✅ Extensions reloaded.");
    } catch (err) {
      ctx.reply(
        `❌ Reload failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  },
};

/**
 * Default command set for the Telegram channel. Deliberately excludes
 * `/new` — see `newSessionCommand` docstring for rationale.
 */
/**
 * Abort the turn in progress. Without this there is no way to do it from
 * Telegram at all: an agent once ran a 37-minute tool loop and the only way
 * out was restarting the service. Messages already queued behind the turn
 * are kept and go through once it has stopped.
 */
export const stopCommand: LocalCommand = {
  name: "stop",
  description: "Stop the turn in progress (queued messages still go through)",
  whileBusy: true,
  handler: async (_args, ctx) => {
    const session = ctx.session;
    if (session.isCompacting) {
      session.abortCompaction();
      ctx.reply("⏹ Compaction stopped.");
      return;
    }
    if (!session.isStreaming) {
      ctx.reply("Nothing running.");
      return;
    }
    await session.abort();
    ctx.reply("⏹ Stopped.");
  },
};

export function createDefaultLocalCommands(): LocalCommand[] {
  return [compactCommand, sessionInfoCommand, reloadCommand, stopCommand];
}
