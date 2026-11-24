/**
 * Resolve the compaction context cap from `spindle.compact`.
 *
 * `compact.context_limit` is the canonical key: an absolute CONTEXT size,
 * in tokens, at which the nudge runner compacts. It used to be called
 * `compact.max_tokens`, which collided with a model's `maxTokens` in
 * ~/.pi/agent/models.json — the RESPONSE budget, i.e. how many tokens the
 * model may generate in one turn. Same name, opposite ends of the request.
 *
 * `max_tokens` still works as a deprecated alias. If both are set,
 * `context_limit` wins. Each case logs once per process.
 */

export interface CompactLimitConfig {
  context_limit?: number;
  /** @deprecated use `context_limit`. */
  max_tokens?: number;
}

type Logger = (message: string) => void;

const warned = new Set<string>();

function warnOnce(key: string, message: string, log: Logger): void {
  if (warned.has(key)) return;
  warned.add(key);
  log(message);
}

/** Test hook: forget which one-time warnings have been logged. */
export function resetContextLimitWarnings(): void {
  warned.clear();
}

export function resolveContextLimit(
  compact: CompactLimitConfig | undefined,
  log: Logger = (m) => console.warn(m)
): number | undefined {
  const contextLimit = compact?.context_limit;
  const legacy = compact?.max_tokens;

  if (contextLimit !== undefined) {
    if (legacy !== undefined) {
      warnOnce(
        "both",
        `[compact] both spindle.compact.context_limit (${contextLimit}) and the deprecated ` +
          `spindle.compact.max_tokens (${legacy}) are set; using context_limit. ` +
          `Remove max_tokens from agent.yaml.`,
        log
      );
    }
    return contextLimit;
  }

  if (legacy !== undefined) {
    warnOnce(
      "legacy",
      `[compact] spindle.compact.max_tokens is deprecated; rename it to ` +
        `spindle.compact.context_limit (same meaning: context size that triggers ` +
        `compaction, not the model's response budget).`,
      log
    );
    return legacy;
  }

  return undefined;
}
