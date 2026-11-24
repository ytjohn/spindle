import type { InboxEngine } from "./engine";

/**
 * Process-wide binding for the InboxEngine.
 *
 * Same rationale as `src/memory/binding.ts`: pi-agent re-imports
 * extension modules inside createAgentSession, so a module-level `let`
 * won't survive the second import. Symbol-on-globalThis does.
 *
 * The `spindle-inbox` extension reads `getBoundInboxEngine()` at
 * register time. If the binding is null (extension loaded outside
 * spindle, or spindle booted with inbox disabled), the extension
 * registers no tools and logs a warning.
 */

interface SpindleInboxBinding {
  engine: InboxEngine | null;
  agentId: string | null;
}

const BINDING_KEY = Symbol.for("@spindle/inbox-binding");

type GlobalSlot = { [BINDING_KEY]?: SpindleInboxBinding };

function slot(): SpindleInboxBinding {
  const g = globalThis as unknown as GlobalSlot;
  if (!g[BINDING_KEY]) {
    g[BINDING_KEY] = { engine: null, agentId: null };
  }
  return g[BINDING_KEY];
}

export function bindInboxEngine(engine: InboxEngine | null): void {
  slot().engine = engine;
}

export function getBoundInboxEngine(): InboxEngine | null {
  return slot().engine;
}

export function bindInboxAgentId(id: string | null): void {
  slot().agentId = id;
}

export function getBoundInboxAgentId(): string | null {
  return slot().agentId;
}

/** Test-only: clear bindings. */
export function resetInboxBinding(): void {
  const s = slot();
  s.engine = null;
  s.agentId = null;
}
