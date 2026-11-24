/**
 * Channel plugins: how a transport gets into a spindle process.
 *
 * A channel has three moments, and each plugin supplies what happens at
 * them:
 *
 *   1. create()          — BEFORE the pi session exists. pi loads
 *                          extensions synchronously while the session is
 *                          built, and a channel's own extension usually
 *                          looks for the channel at register time (to
 *                          decide which tools to offer), so the channel
 *                          has to be constructed and published first.
 *   2. extensionPaths()  — pi extensions to load into that session.
 *   3. channel.start()   — after the session exists.
 *
 * The built-in channels are plugins like any other; they are listed in
 * builtin.ts. A plugin from outside this repository is named in
 * agent.yaml under `plugins:` (see ../plugins/loader.ts).
 *
 * A plugin is consulted only when `channels.<key>` is present in the
 * agent's config.
 */

import type { AgentConfig } from "../types";
import type { SharedSessionDeps } from "../agent/session";
import type { Channel } from "./types";

/** What the host gives a plugin. Stable across create/start/stop. */
export interface ChannelHost {
  readonly agentDir: string;
  readonly config: AgentConfig;
  /**
   * The channels that have started, in start order. The live list, by
   * reference: a channel that reports on its siblings (presence) calls
   * this each time rather than keeping the result.
   */
  channels(): Channel[];
  /**
   * What is needed to build a helper session beside the main one. Only
   * available once the main session exists — call it from start() or
   * later, never from create(). Throws before then.
   */
  sessionDeps(): SharedSessionDeps;
}

export interface ChannelPlugin {
  /** The key under `channels:` in agent.yaml that turns this plugin on. */
  readonly key: string;
  /**
   * Name used in the start/stop log lines ("Telegram channel started").
   * Defaults to the key.
   */
  readonly label?: string;
  /**
   * Start order among channels; lower starts first and stops first.
   * Built-ins use 100–400. Default 500, i.e. after the built-ins.
   */
  readonly order?: number;
  /**
   * Construct the channel(s) for this config value. Called once, before
   * the pi session is created. Return an array when one config value
   * describes several channels.
   */
  create(channelConfig: unknown, host: ChannelHost): Channel | Channel[] | Promise<Channel | Channel[]>;
  /** pi extension paths (absolute) to load into the session. */
  extensionPaths?(channelConfig: unknown, host: ChannelHost): string[];
  /**
   * Called when a channel's start() throws, after the error is logged.
   * The process keeps running either way; this is for saying something
   * more useful than the stack trace.
   */
  onStartFailure?(err: unknown, channel: Channel): void;
}

export const DEFAULT_CHANNEL_ORDER = 500;

/** A channel that was constructed, with the plugin that made it. */
export interface CreatedChannel {
  plugin: ChannelPlugin;
  channel: Channel;
  /** True when the plugin's create() returned an array. */
  oneOfMany: boolean;
}

function configured(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * Check a set of plugins before use: every key once. Two plugins
 * answering the same `channels.<key>` would both construct a channel and
 * both claim its bindings, so it is refused rather than resolved.
 */
export function assertUniqueKeys(plugins: readonly ChannelPlugin[]): void {
  const seen = new Set<string>();
  for (const p of plugins) {
    if (!p.key || typeof p.key !== "string") {
      throw new Error("[spindle] channel plugin without a key");
    }
    if (seen.has(p.key)) {
      throw new Error(`[spindle] two channel plugins claim channels.${p.key}`);
    }
    seen.add(p.key);
  }
}

/** The plugins this agent's config turns on, in start order. */
export function activePlugins(
  plugins: readonly ChannelPlugin[],
  config: AgentConfig,
): ChannelPlugin[] {
  const channels = (config.channels ?? {}) as Record<string, unknown>;
  return plugins
    .map((plugin, i) => ({ plugin, i }))
    .filter(({ plugin }) => configured(channels[plugin.key]))
    .sort(
      (a, b) =>
        (a.plugin.order ?? DEFAULT_CHANNEL_ORDER) - (b.plugin.order ?? DEFAULT_CHANNEL_ORDER) ||
        a.i - b.i,
    )
    .map(({ plugin }) => plugin);
}

/**
 * Construct every configured channel and collect the pi extension paths
 * they ask for. A plugin whose create() throws stops the boot: a channel
 * the config asks for and cannot be built is a configuration error, and
 * the built-in channels have always failed the boot here.
 */
export async function createChannels(
  plugins: readonly ChannelPlugin[],
  host: ChannelHost,
): Promise<{ created: CreatedChannel[]; extensionPaths: string[] }> {
  const channels = (host.config.channels ?? {}) as Record<string, unknown>;
  const created: CreatedChannel[] = [];
  const extensionPaths: string[] = [];
  for (const plugin of activePlugins(plugins, host.config)) {
    const value = channels[plugin.key];
    const made = await plugin.create(value, host);
    const list = Array.isArray(made) ? made : [made];
    for (const channel of list) {
      created.push({ plugin, channel, oneOfMany: Array.isArray(made) });
    }
    extensionPaths.push(...(plugin.extensionPaths?.(value, host) ?? []));
  }
  return { created, extensionPaths };
}

/** "Telegram channel" / `Stub channel "alpha"` — the name in log lines. */
export function channelLogName(c: CreatedChannel): string {
  const label = c.plugin.label ?? c.plugin.key;
  return c.oneOfMany ? `${label} channel "${c.channel.name}"` : `${label} channel`;
}

/**
 * Keys under `channels:` that no plugin answers for. A config that asks
 * for a channel nobody provides would otherwise boot a quieter agent with
 * no word of why — most likely a plugin missing from `plugins:`.
 */
export function unclaimedChannelKeys(
  plugins: readonly ChannelPlugin[],
  config: AgentConfig,
): string[] {
  const channels = (config.channels ?? {}) as Record<string, unknown>;
  const claimed = new Set(plugins.map((p) => p.key));
  return Object.keys(channels).filter((key) => configured(channels[key]) && !claimed.has(key));
}
