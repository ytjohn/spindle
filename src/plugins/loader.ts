/**
 * Plugins: code from outside this repository that adds to a spindle
 * process before the pi session is built.
 *
 * agent.yaml:
 *
 *   plugins:
 *     - module: ../somewhere/my-plugin.ts     # relative to the agent dir
 *     - module: some-package/plugin           # or a package specifier
 *
 * The module's default export is a SpindlePlugin, or a function that is
 * given the public API (src/api.ts) and returns one. Today a plugin can
 * contribute channels; a channel brings its own pi extensions with it.
 *
 * This is a different stage from agent.yaml `extensions:`, which load
 * AFTER the session and channels exist and receive a SpindleRuntime. A
 * channel has to exist before the session does (see channels/registry.ts),
 * so it cannot come from there.
 */

import { isAbsolute, resolve } from "node:path";
import type { ChannelPlugin } from "../channels/registry";

export interface SpindlePlugin {
  /** For log lines. Defaults to the module string from agent.yaml. */
  name?: string;
  channels?: ChannelPlugin[];
}

export type SpindleApi = typeof import("../api");

export interface SpindlePluginModule {
  default: SpindlePlugin | ((api: SpindleApi) => SpindlePlugin | Promise<SpindlePlugin>);
}

export interface PluginDef {
  module: string;
}

/** A path when it looks like one; otherwise left for the module resolver. */
export function resolvePluginModule(agentDir: string, module: string): string {
  if (isAbsolute(module)) return module;
  if (module.startsWith("./") || module.startsWith("../")) return resolve(agentDir, module);
  return module;
}

/**
 * Load every plugin named in the config. A plugin that cannot be loaded
 * fails the boot: the agent's config asks for something that is not
 * there, and running without it would be a different agent.
 */
export async function loadPlugins(
  agentDir: string,
  defs: readonly PluginDef[],
  api: SpindleApi,
  importer: (specifier: string) => Promise<unknown> = (s) => import(s),
): Promise<SpindlePlugin[]> {
  const plugins: SpindlePlugin[] = [];
  for (const def of defs) {
    const specifier = resolvePluginModule(agentDir, def.module);
    let mod: Partial<SpindlePluginModule>;
    try {
      mod = (await importer(specifier)) as Partial<SpindlePluginModule>;
    } catch (err) {
      throw new Error(
        `[spindle] Failed to load plugin "${def.module}" from ${specifier}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const exported = mod.default;
    if (exported === undefined || exported === null) {
      throw new Error(
        `[spindle] Plugin "${def.module}" has no default export. ` +
          `Found exports: ${Object.keys(mod).join(", ") || "(none)"}`,
      );
    }
    let plugin: SpindlePlugin;
    try {
      plugin = typeof exported === "function" ? await exported(api) : exported;
    } catch (err) {
      throw new Error(
        `[spindle] Plugin "${def.module}" threw while setting up: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!plugin || typeof plugin !== "object") {
      throw new Error(`[spindle] Plugin "${def.module}" did not produce a plugin object`);
    }
    if (plugin.channels !== undefined && !Array.isArray(plugin.channels)) {
      throw new Error(`[spindle] Plugin "${def.module}": channels must be an array`);
    }
    plugins.push({ name: plugin.name ?? def.module, channels: plugin.channels ?? [] });
    const keys = (plugin.channels ?? []).map((c) => c.key).join(", ");
    console.log(`[spindle] Plugin loaded: ${plugin.name ?? def.module}${keys ? ` (channels: ${keys})` : ""}`);
  }
  return plugins;
}

const API_KEY = Symbol.for("@spindle/api");

/** Publish the API for pi extensions that have no import path to it. */
export function publishApi(api: SpindleApi): void {
  (globalThis as unknown as { [API_KEY]?: SpindleApi })[API_KEY] = api;
}
