import type { ContextTelemetryRecorder } from "./recorder";

/**
 * Process-wide binding for the ContextTelemetryRecorder.
 *
 * Same re-import-safe pattern as src/memory/binding.ts (see that file
 * for the full rationale). Briefly: pi-agent may re-import extension
 * and channel modules across different resourceLoaders within one
 * process, and a module-level `let` would reset on re-import. The
 * global symbol registry survives those re-imports.
 *
 * This binding is consumed by code that needs to bracket externally-
 * triggered compactions (Telegram's `/compact`, PR 2's CompactNudgeRunner,
 * PR 3's daydream-cadence trigger) so their runs land in the
 * `compact_events` table with the right trigger label. Without
 * bracketing, pi's `session.compact()` call does not emit the
 * `auto_compaction_start/end` events the recorder subscribes to, and
 * the compaction would go unrecorded.
 */

interface SpindleTelemetryBinding {
  recorder: ContextTelemetryRecorder | null;
}

const BINDING_KEY = Symbol.for("@spindle/telemetry-binding");

type GlobalSlot = { [BINDING_KEY]?: SpindleTelemetryBinding };

function slot(): SpindleTelemetryBinding {
  const g = globalThis as unknown as GlobalSlot;
  if (!g[BINDING_KEY]) {
    g[BINDING_KEY] = { recorder: null };
  }
  return g[BINDING_KEY];
}

export function bindTelemetryRecorder(
  recorder: ContextTelemetryRecorder | null
): void {
  slot().recorder = recorder;
}

export function getBoundTelemetryRecorder(): ContextTelemetryRecorder | null {
  return slot().recorder;
}

/** Test-only: reset the binding. */
export function resetTelemetryBinding(): void {
  slot().recorder = null;
}
