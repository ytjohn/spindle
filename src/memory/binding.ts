import type { MemoryEngine } from "./engine";

/**
 * Global binding for the process-wide MemoryEngine + agent id.
 *
 * Why `globalThis[Symbol.for(...)]` instead of a module-level `let`:
 *
 * Pi-agent's extension loader imports each extension file to get its
 * default export, and pi may re-import the same file multiple times
 * within one process (once for the main session's resourceLoader,
 * again for a daydream ephemeral session's fresh resourceLoader,
 * possibly more on hot-reload). Depending on how pi invokes
 * `import()`, the second load can produce a DIFFERENT module instance
 * with fresh top-level state.
 *
 * A module-level `let currentEngine = null` works for the first load
 * because spindle's boot code sets it before any extension loads. But
 * a re-imported instance starts with `currentEngine = null` — even
 * though the engine is still alive in the process. The extension's
 * "no binding → register nothing" degrade path then kicks in, and
 * daydream silently has no tools.
 *
 * `Symbol.for(name)` is interned in the global symbol registry, so
 * every module instance — no matter how many times it's re-imported —
 * resolves to the same symbol and reads the same `globalThis` slot.
 * That's the cross-module-instance persistence we need.
 *
 * This was found the hard way during Phase 5.0 E2E testing: daydream
 * ran but stored 0 memories because the ephemeral session's extension
 * load reported "loaded without a bound agent id". Switching to the
 * global symbol binding fixed it.
 */

interface SpindleMemoryBinding {
  engine: MemoryEngine | null;
  agentId: string | null;
  /**
   * True when the spindle daydream loop is enabled for this agent.
   * Kept for diagnostic logging; tool registration decisions use
   * `mainStoreEnabled` (which defaults to !daydreamActive).
   */
  daydreamActive: boolean;
  /**
   * Whether to register spindle_memory_store in MAIN sessions. Daydream
   * ephemeral sessions always get store regardless (it's their job).
   *
   * Set at spindle boot from config.memory.main_session_store_tool —
   * falling back to `!daydreamActive` when unset.
   *
   * Use cases:
   *   - daydream on, mainStoreEnabled=false (default when daydream on):
   *     daydream is sole writer; main session gets recall only
   *   - daydream off, mainStoreEnabled=true (default when daydream off):
   *     Phase 2 backwards-compatible — main session stores directly
   *   - daydream off, mainStoreEnabled=false (explicit):
   *     read-only agent that can recall shared memories but never write
   *   - daydream on, mainStoreEnabled=true (explicit):
   *     both paths write; daydream dedupes
   */
  mainStoreEnabled: boolean;
  /**
   * Which kind of pi session is currently being constructed. Main
   * sessions default to 'main' (set once at boot). The daydream
   * factory wraps its `createAgentSession` call in a
   * bind('daydream') / bind('main') pair, so while a daydream
   * ephemeral session loads the extension, getLoadContext() returns
   * 'daydream'.
   *
   * Why runtime context and not just "daydream enabled":
   *   - If daydream is ON, the main session should NOT have the
   *     store tool (lets daydream be the sole writer)
   *   - But the daydream ephemeral session MUST have it (that's its job)
   *   - Both sessions load the same extension module, so we need
   *     per-load-time state to distinguish them
   */
  loadContext: "main" | "daydream";
}

const BINDING_KEY = Symbol.for("@spindle/memory-binding");

type GlobalSlot = { [BINDING_KEY]?: SpindleMemoryBinding };

function slot(): SpindleMemoryBinding {
  const g = globalThis as unknown as GlobalSlot;
  if (!g[BINDING_KEY]) {
    g[BINDING_KEY] = {
      engine: null,
      agentId: null,
      daydreamActive: false,
      mainStoreEnabled: true,
      loadContext: "main",
    };
  }
  return g[BINDING_KEY];
}

export function bindMemoryEngine(engine: MemoryEngine | null): void {
  slot().engine = engine;
}

export function getBoundMemoryEngine(): MemoryEngine | null {
  return slot().engine;
}

export function bindMemoryAgentId(id: string | null): void {
  slot().agentId = id;
}

export function getBoundAgentId(): string | null {
  return slot().agentId;
}

/**
 * Tell the spindle-memory extension whether the daydream loop is
 * active for this agent. Set at spindle boot BEFORE createAgentSession
 * runs, same ordering as the engine + agent id bindings.
 */
export function bindDaydreamActive(active: boolean): void {
  slot().daydreamActive = active;
}

export function isDaydreamActive(): boolean {
  return slot().daydreamActive;
}

/**
 * Set whether the main session's extension load should register the
 * store tool. Daydream sessions ignore this flag — they always get
 * store because they need it.
 */
export function bindMainStoreEnabled(enabled: boolean): void {
  slot().mainStoreEnabled = enabled;
}

export function isMainStoreEnabled(): boolean {
  return slot().mainStoreEnabled;
}

/**
 * Set the current session-construction context. The daydream factory
 * sets this to 'daydream' before its createAgentSession call, then
 * back to 'main' in a finally block. Default is 'main'.
 */
export function bindLoadContext(context: "main" | "daydream"): void {
  slot().loadContext = context;
}

export function getLoadContext(): "main" | "daydream" {
  return slot().loadContext;
}

/**
 * Test-only: reset all bindings.
 */
export function resetMemoryBinding(): void {
  const s = slot();
  s.engine = null;
  s.agentId = null;
  s.daydreamActive = false;
  s.mainStoreEnabled = true;
  s.loadContext = "main";
}
