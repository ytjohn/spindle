/**
 * Spindle extension loader.
 *
 * Loads agent.yaml `extensions:` entries at boot time by dynamic import,
 * calls each module's register(runtime) function, and returns a composite
 * teardown that calls them all in reverse order on shutdown.
 *
 * Unlike pi extensions (which are re-imported by pi's resource loader on
 * each fresh session), spindle extensions are loaded exactly once by
 * spindle's boot code. They receive the SpindleRuntime directly as a
 * parameter — no globalThis binding required on the extension side.
 */

import { resolve } from "path";
import type { SpindleRuntime, SpindleExtensionModule } from "./runtime";

export interface SpindleExtensionDef {
  module: string;
}

/**
 * Load all spindle extensions defined in `defs`, call their register()
 * functions with `runtime`, and return a composite teardown function.
 *
 * Throws immediately on load or register errors — a misconfigured
 * extension is a boot failure, not a soft warning.
 *
 * Teardowns are called in reverse-load order (last loaded, first torn down).
 */
export async function loadSpindleExtensions(
  agentDir: string,
  defs: SpindleExtensionDef[],
  runtime: SpindleRuntime
): Promise<() => Promise<void>> {
  const teardowns: Array<() => Promise<void>> = [];

  for (const def of defs) {
    const modulePath = resolve(agentDir, def.module);

    let mod: SpindleExtensionModule;
    try {
      mod = (await import(modulePath)) as SpindleExtensionModule;
    } catch (err) {
      throw new Error(
        `[spindle] Failed to load extension "${def.module}" from ${modulePath}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (typeof mod.register !== "function") {
      throw new Error(
        `[spindle] Extension "${def.module}" does not export a register() function. ` +
        `Found exports: ${Object.keys(mod).join(", ") || "(none)"}`
      );
    }

    let teardown: (() => Promise<void>) | void;
    try {
      teardown = await mod.register(runtime);
    } catch (err) {
      throw new Error(
        `[spindle] Extension "${def.module}" register() threw: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (typeof teardown === "function") {
      teardowns.push(teardown);
    }

    console.log(`[spindle] Extension loaded: ${def.module}`);
  }

  return async () => {
    for (const fn of [...teardowns].reverse()) {
      try {
        await fn();
      } catch (err) {
        console.error(`[spindle] Extension teardown error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
}
