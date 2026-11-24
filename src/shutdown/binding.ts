/**
 * Process-wide shutdown signal binding.
 *
 * Spindle sets this to an AbortController's signal before SIGTERM/SIGINT
 * fires. Extensions with background setInterval loops should check
 * `getShutdownSignal()?.aborted` before spawning subprocesses or doing
 * expensive work — this lets them drain cleanly without systemd force-killing.
 *
 * Same symbol-on-globalThis pattern as src/memory/binding.ts. Extensions
 * are re-imported by pi's resource loader; a module-level let would reset
 * to null on each re-import. The globalThis symbol survives.
 */

const BINDING_KEY = Symbol.for("@spindle/shutdown-signal");

interface ShutdownGlobal {
  [key: symbol]: AbortSignal | null;
}

export function bindShutdownSignal(signal: AbortSignal | null): void {
  (globalThis as unknown as ShutdownGlobal)[BINDING_KEY] = signal;
}

export function getShutdownSignal(): AbortSignal | null {
  return (globalThis as unknown as ShutdownGlobal)[BINDING_KEY] ?? null;
}
