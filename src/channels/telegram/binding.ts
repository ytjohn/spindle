/**
 * Global binding for the process-wide TelegramChannel.
 *
 * Same rationale as src/memory/binding.ts: pi-agent's extension loader
 * can re-import the same extension file multiple times within one
 * process (main session's resourceLoader vs a daydream ephemeral
 * session's fresh resourceLoader), and depending on how pi invokes
 * `import()`, a re-imported instance may start with a fresh
 * module-level state. A symbol-on-globalThis slot is shared across
 * every module instance, so the bound channel survives re-imports.
 *
 * Used by the spindle-telegram pi extension to find the running
 * TelegramChannel instance at extension load time so it can register
 * outbound `telegram_send_message` / `telegram_send_image` tools and
 * wire an auto-send listener for image-generation tool results.
 *
 * See CLAUDE.md's "Pi re-imports extension modules" note and the
 * memory/binding.ts docstring for the longer version.
 */

import type { TelegramChannel } from "./channel";

interface SpindleTelegramBinding {
  channel: TelegramChannel | null;
  /**
   * Which kind of pi session is currently being constructed. Main
   * sessions default to 'main'; daydream sessions should not be
   * registering telegram-send tools. The spindle-memory binding has
   * the same concept (see memory/binding.ts) — we reuse its symbol for
   * consistency.
   */
  loadContext: "main" | "daydream" | "scheduler";
  /**
   * Tool names whose successful results should be auto-forwarded to
   * the channel as images. Default matches a typical image extension. An
   * agent that wants a different set overrides via
   * channels.telegram.auto_send_tools in agent.yaml.
   */
  autoSendTools: string[];
  /**
   * Whether the spindle-telegram extension should register outbound
   * tools for this load. Derived from
   * channels.telegram.outbound_tools (default true). The binding caches
   * it so the extension can read a single flag at register time.
   */
  outboundToolsEnabled: boolean;
  /**
   * Timestamp (ms) when the current Telegram-triggered turn started, or
   * 0 when no Telegram turn is in flight. Set by
   * TelegramChannel.dispatchToSession, cleared on agent_end / flush
   * fallback. Read by a game channel's flush() to hold its inbound
   * events while the agent is mid-reply. A
   * timestamp rather than a boolean so the reader can enforce a
   * max-hold safety valve if the clear is ever missed.
   */
  telegramTurnStartedAt: number;
  /**
   * Timestamp (ms) when the oldest Telegram message still waiting in the
   * channel's queue was queued, or 0 when nothing is waiting. The channel
   * only releases a queued message once the session is idle, and a game
   * channel once kept an agent busy for an hour (216 of 224 runs began
   * within 100ms of the last ending), so two texts from the operator waited
   * that whole hour. A game channel's flush() reads this and holds its own
   * events while a text waits, so the running turn can end and the text
   * goes next.
   */
  telegramPendingSince: number;
}

const BINDING_KEY = Symbol.for("@spindle/telegram-binding");

type GlobalSlot = { [BINDING_KEY]?: SpindleTelegramBinding };

function slot(): SpindleTelegramBinding {
  const g = globalThis as unknown as GlobalSlot;
  if (!g[BINDING_KEY]) {
    g[BINDING_KEY] = {
      channel: null,
      loadContext: "main",
      autoSendTools: ["imagine", "image_edit", "image_combine"],
      outboundToolsEnabled: true,
      telegramTurnStartedAt: 0,
      telegramPendingSince: 0,
    };
  }
  return g[BINDING_KEY];
}

export function bindTelegramTurnActive(active: boolean): void {
  slot().telegramTurnStartedAt = active ? Date.now() : 0;
}

/** Mark whether a Telegram message is waiting in the channel queue. Keeps
 *  the oldest timestamp while messages keep arriving. */
export function bindTelegramPending(pending: boolean): void {
  const s = slot();
  if (!pending) s.telegramPendingSince = 0;
  else if (s.telegramPendingSince === 0) s.telegramPendingSince = Date.now();
}

/** Ms the oldest queued Telegram message has waited, or 0 if none. */
export function getTelegramPendingMs(): number {
  const since = slot().telegramPendingSince;
  return since > 0 ? Date.now() - since : 0;
}

/** Ms since the in-flight Telegram turn started, or 0 if none. */
export function getTelegramTurnActiveMs(): number {
  const startedAt = slot().telegramTurnStartedAt;
  return startedAt > 0 ? Date.now() - startedAt : 0;
}

export function bindTelegramChannel(channel: TelegramChannel | null): void {
  slot().channel = channel;
}

export function getBoundTelegramChannel(): TelegramChannel | null {
  return slot().channel;
}

export function bindTelegramLoadContext(context: "main" | "daydream" | "scheduler"): void {
  slot().loadContext = context;
}

export function getTelegramLoadContext(): "main" | "daydream" | "scheduler" {
  return slot().loadContext;
}

export function bindAutoSendTools(tools: string[]): void {
  slot().autoSendTools = [...tools];
}

export function getAutoSendTools(): string[] {
  return slot().autoSendTools;
}

export function bindOutboundToolsEnabled(enabled: boolean): void {
  slot().outboundToolsEnabled = enabled;
}

export function isOutboundToolsEnabled(): boolean {
  return slot().outboundToolsEnabled;
}

/** Test-only reset. */
export function resetTelegramBinding(): void {
  const s = slot();
  s.channel = null;
  s.loadContext = "main";
  s.autoSendTools = ["imagine", "image_edit", "image_combine"];
  s.outboundToolsEnabled = true;
  s.telegramTurnStartedAt = 0;
  s.telegramPendingSince = 0;
}

const QUIET_KEY = Symbol.for("@spindle/telegram-quiet-tools");
function quietTools(): Set<string> {
  const g = globalThis as unknown as { [QUIET_KEY]?: Set<string> };
  return (g[QUIET_KEY] ??= new Set());
}

/**
 * Tools whose calls are not shown in Telegram's progress message, even in
 * a run Telegram opened. For another channel's plumbing — moving and
 * looking around in a game, say — which tells the person on the phone
 * nothing. A name ending in `*` matches by prefix.
 */
export function hideToolProgress(names: readonly string[]): void {
  const quiet = quietTools();
  for (const n of names) if (/^\w+\*?$/.test(n)) quiet.add(n);
}

export function isToolProgressHidden(toolName: string): boolean {
  for (const n of quietTools()) {
    if (n.endsWith("*") ? toolName.startsWith(n.slice(0, -1)) : toolName === n) return true;
  }
  return false;
}

/** Test-only. */
export function _resetHiddenToolProgress(): void {
  quietTools().clear();
}
