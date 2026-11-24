import type { TelegramApi, BotCommand } from "./api";
import type { SlashCommandInfo } from "../types";

// Telegram's constraints: ^[a-z0-9_]{1,32}$ (hyphens NOT allowed)
const TELEGRAM_COMMAND_NAME = /^[a-z0-9_]{1,32}$/;
// Telegram cap: max 100 commands per scope
const MAX_COMMANDS_PER_SCOPE = 100;
// Description limit: 256 chars
const MAX_DESCRIPTION_LENGTH = 256;

/**
 * A command already shaped for Telegram's setMyCommands API, paired
 * with its original (possibly hyphenated) name so callers can round-trip
 * the user's tap in autocomplete back to the pi-registered command name.
 */
export interface NormalizedCommand {
  /** The name to register with Telegram (underscore-form, lowercase). */
  command: string;
  description: string;
  /**
   * The original command name before normalization. Only set when a
   * rewrite actually happened (e.g. `my-command` → `my_command`).
   * When the registered name was already underscore-form, this is
   * undefined and no rewrite is needed on the way back.
   */
  originalName?: string;
}

export interface BuildBotCommandsResult {
  commands: BotCommand[];
  /**
   * Map from normalized (underscore) name → original name. Only contains
   * entries where a rewrite happened. Used by the channel to translate
   * user taps on Telegram autocomplete back to the original pi command
   * name before dispatch.
   */
  rewriteMap: Map<string, string>;
}

/**
 * Convert pi-agent's `SlashCommandInfo[]` into Telegram's `BotCommand[]`
 * format. Hyphens in names are rewritten to underscores so pi extensions
 * that register `my-command` surface as `/my_command` in Telegram's
 * autocomplete. The returned `rewriteMap` lets callers translate back
 * before handing the text to pi's slash router.
 *
 * Filtering:
 *   - Drops names that still don't match Telegram's regex after rewrite
 *   - Dedupes case-insensitively on the normalized name (first wins)
 *   - Caps output at Telegram's 100-per-scope limit
 *
 * When two registered commands normalize to the same name
 * (e.g. `foo-bar` and `foo_bar`), the first one wins and the collision
 * is logged. This is improbable but worth flagging if it happens.
 */
export function buildBotCommands(slashCommands: SlashCommandInfo[]): BuildBotCommandsResult {
  const seen = new Set<string>();
  const commands: BotCommand[] = [];
  const rewriteMap = new Map<string, string>();

  for (const cmd of slashCommands) {
    const originalName = cmd.name.replace(/^\/+/, "").trim();
    if (originalName.length === 0) continue;

    // Normalize: lowercase + hyphens → underscores
    const normalized = originalName.toLowerCase().replace(/-/g, "_");
    if (!TELEGRAM_COMMAND_NAME.test(normalized)) continue;
    if (seen.has(normalized)) {
      // Collision after normalization: two distinct registered commands
      // map to the same telegram name. Rare, but log so it's diagnosable.
      console.warn(
        `[spindle] Telegram command collision: "${originalName}" normalizes to "${normalized}" which is already registered`
      );
      continue;
    }
    seen.add(normalized);

    const description = trimLine(
      cmd.description ?? `Pi: ${cmd.source ?? normalized}`,
      MAX_DESCRIPTION_LENGTH
    );
    commands.push({ command: normalized, description });

    // Track the rewrite only when it changes the name — avoids polluting
    // the map with no-op entries and keeps channel-side lookups fast.
    if (normalized !== originalName.toLowerCase() || originalName !== originalName.toLowerCase()) {
      rewriteMap.set(normalized, originalName);
    }
  }

  const capped = commands.slice(0, MAX_COMMANDS_PER_SCOPE);
  // If we capped, trim the rewriteMap too so we don't hold entries for
  // commands we didn't actually register.
  if (capped.length < commands.length) {
    const keptNames = new Set(capped.map((c) => c.command));
    for (const key of [...rewriteMap.keys()]) {
      if (!keptNames.has(key)) rewriteMap.delete(key);
    }
  }
  return { commands: capped, rewriteMap };
}

function trimLine(text: string, maxLength: number): string {
  const flattened = text.replace(/\s+/g, " ").trim();
  if (flattened.length <= maxLength) return flattened;
  return flattened.slice(0, maxLength - 1) + "…";
}

/**
 * Registers pi-agent slash commands with Telegram's setMyCommands API
 * scoped to specific chats. Caches the last-registered signature per chat
 * to avoid redundant API calls when commands haven't changed.
 *
 * Also tracks the per-chat hyphen-rewrite map so the channel can
 * translate user taps on `/my_command` (underscore-form in Telegram
 * autocomplete) back to `/my-command` (the pi-registered name) before
 * dispatch.
 */
export class CommandRegistrar {
  private readonly signatureCache = new Map<number, string>();
  private readonly rewriteMaps = new Map<number, Map<string, string>>();

  constructor(private readonly api: TelegramApi) {}

  async syncForChat(chatId: number, slashCommands: SlashCommandInfo[]): Promise<void> {
    const { commands, rewriteMap } = buildBotCommands(slashCommands);

    // Don't push an empty command list — that would delete any previously
    // registered commands for this chat. If the agent has no commands to
    // expose, leave whatever is already there untouched.
    if (commands.length === 0) return;

    const signature = JSON.stringify(commands);
    // Always update the rewrite map even when we skip the API call —
    // a re-sync with the same shape still needs the lookup table on the
    // receiving side (e.g. after a process restart with a hot cache).
    this.rewriteMaps.set(chatId, rewriteMap);

    if (this.signatureCache.get(chatId) === signature) return;

    await this.api.setMyCommands(commands, { type: "chat", chat_id: chatId });
    this.signatureCache.set(chatId, signature);
  }

  /**
   * Look up the original pi-registered command name for a normalized
   * (underscore) name the user tapped in Telegram autocomplete. Returns
   * undefined when no rewrite was needed or the chat isn't registered.
   */
  getOriginalName(chatId: number, normalizedName: string): string | undefined {
    return this.rewriteMaps.get(chatId)?.get(normalizedName.toLowerCase());
  }

  /** Clear the cache — forces the next sync to re-register. */
  reset(): void {
    this.signatureCache.clear();
    this.rewriteMaps.clear();
  }
}
