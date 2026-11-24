/**
 * The channels that ship with spindle, as plugins.
 *
 * Each create() imports its channel lazily: an agent that does not
 * configure a channel never loads its code.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChannelPlugin } from "./registry";
import type { AgentConfig } from "../types";

const here = dirname(fileURLToPath(import.meta.url));
const builtInExtension = (name: string): string => resolve(here, "..", "extensions", name);

const telegram: ChannelPlugin = {
  key: "telegram",
  label: "Telegram",
  order: 100,
  async create(_cfg, host) {
    const { TelegramChannel } = await import("./telegram/channel");
    return new TelegramChannel({ agentDir: host.agentDir, config: host.config });
  },
  // Outbound tools (telegram_send_message / telegram_send_image) and the
  // auto-send listener, unless the agent turned them off.
  extensionPaths(cfg) {
    const outbound = (cfg as NonNullable<NonNullable<AgentConfig["channels"]>["telegram"]>).outbound_tools;
    return outbound === false ? [] : [builtInExtension("spindle-telegram")];
  },
  onStartFailure() {
    // Reachable only for a genuine auth failure — transient network and
    // transport problems no longer abort start(); the poller retries them
    // itself. A bad token cannot be retried away, so make it unmissable
    // rather than one line in the journal. Deliberately NOT process-fatal:
    // the agent's scheduler and other work are unaffected by a Telegram
    // token problem, and crash-looping would take those down too.
    const bar = "[spindle] ============================================================";
    console.error(bar);
    console.error("[spindle] TELEGRAM IS DISABLED FOR THIS PROCESS. The bot token was");
    console.error("[spindle] rejected. This agent cannot send or receive Telegram");
    console.error("[spindle] messages until the token is fixed and the service is");
    console.error("[spindle] restarted. Everything else keeps running.");
    console.error(bar);
  },
};

const stub: ChannelPlugin = {
  key: "stub",
  label: "Stub",
  order: 400,
  async create(cfg, host) {
    const { StubChannel } = await import("./stub/channel");
    type StubConfig = ConstructorParameters<typeof StubChannel>[0]["config"];
    return (cfg as StubConfig[]).map((config) => new StubChannel({ agentDir: host.agentDir, config }));
  },
};

export const BUILTIN_CHANNEL_PLUGINS: readonly ChannelPlugin[] = [telegram, stub];
