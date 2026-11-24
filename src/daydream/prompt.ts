/**
 * Daydream prompt builder — pure function.
 *
 * Builds the system + user prompt pair for one daydream cycle. The
 * system prompt is opinionated and detailed: it tells the LLM what
 * daydream is, bakes in wall-clock/elapsed awareness, lists existing
 * memories to avoid duplicates, and spells out what to store vs skip.
 *
 * The user prompt is a short trigger — most of the content lives in
 * the system prompt so pi's prompt cache reuses it across cycles
 * within a single spindle process.
 *
 * The function is pure: same inputs produce the same outputs. No
 * `Date.now()`, no I/O. Callers pass `now` explicitly — the runner
 * provides it, tests fix it for determinism.
 */

export interface DaydreamPromptInputs {
  /** Unix ms — "current time" from the caller's perspective. */
  now: number;
  /** Unix ms of the last completed cycle, or null if this is the first. */
  lastCycleAt: number | null;
  /** Agent id for the system prompt framing. */
  agentId: string;
  /** Optional friendly name. Falls back to agentId. */
  agentDisplayName?: string;
  /**
   * Pre-built activity summary string from `summarizeActivity`.
   * Passed in rather than built here so prompt.ts stays a pure string
   * builder with no filesystem dependency.
   */
  activitySummary: string;
  /**
   * Memories the agent already has, so the LLM can avoid storing
   * near-duplicates AND so the curator has concrete ids to reference
   * when calling `spindle_memory_forget`. Ordered by recency descending.
   * The builder caps the rendered list at `maxExistingMemories` to
   * keep the prompt compact — callers decide how many to pass.
   */
  existingMemories: Array<{
    id: number;
    content: string;
    visibility: string;
  }>;
  /** Max number of new memories the LLM is instructed to store. */
  maxStore: number;
  /**
   * IANA timezone id (e.g. "America/New_York"). Defaults to the
   * runtime's system timezone via `undefined` in `toLocaleString`.
   */
  timezone?: string;
  /** Max existing memories to render in-line for dedup context. Default 20. */
  maxExistingMemories?: number;
}

export interface DaydreamPrompt {
  systemPrompt: string;
  userPrompt: string;
}

export function buildDaydreamPrompt(inputs: DaydreamPromptInputs): DaydreamPrompt {
  const displayName = inputs.agentDisplayName ?? inputs.agentId;
  const nowLabel = formatLocalTime(inputs.now, inputs.timezone);
  const cycleLabel = formatCycleContext(
    inputs.now,
    inputs.lastCycleAt,
    inputs.timezone
  );
  const memoryContext = formatExistingMemories(
    inputs.existingMemories,
    inputs.maxExistingMemories ?? 20
  );

  const systemPrompt = [
    `You are the memory curator for agent "${displayName}" (id: ${inputs.agentId}).`,
    ``,
    `Your job is to review recent conversation activity and decide what — if anything — is worth storing as a persistent memory. You run in a short ephemeral session every ~30 minutes. The main agent session is unaffected by your work.`,
    ``,
    `Time context:`,
    `- Current local time: ${nowLabel}`,
    cycleLabel,
    ``,
    inputs.activitySummary,
    ``,
    memoryContext,
    ``,
    `What to store:`,
    `- Durable facts the user stated: names, preferences, projects, relationships, locations, dates`,
    `- Ongoing situations the user is tracking (a move, a health thing, a project deadline)`,
    `- Things the user explicitly said to remember`,
    ``,
    `What NOT to store:`,
    `- Single-session chit-chat or casual acknowledgments ("hello", "thanks", "ok")`,
    `- Your own interpretations or inferences about the user that weren't stated`,
    `- Facts that duplicate an entry in the "existing memories" list above — skip these`,
    `- Tool calls, system events, errors, or retry attempts`,
    `- Ambiguous snippets that need conversation context to make sense later`,
    ``,
    `How to phrase each memory:`,
    `- Third-person factual statements the agent would benefit from recalling later`,
    `- Good: "user's cat is named Pixel"`,
    `- Good: "user recently moved to Lisbon"`,
    `- Bad:  "I remember you told me your cat is Pixel" (first-person framing)`,
    `- Bad:  "the user seems nice" (interpretation, not fact)`,
    ``,
    `Forgetting memories (spindle_memory_forget):`,
    `- You can tombstone an outdated or contradicted memory by calling spindle_memory_forget(ids, reason). Tombstoned memories are hidden from every future recall but stay on disk so a human can restore them later.`,
    `- Use ONLY for unambiguous cases:`,
    `  • The user explicitly asked you to forget something ("forget I told you X")`,
    `  • A new fact directly contradicts an old one AND the old one is clearly wrong (example: user corrected their dog's name from Rex to Satiann)`,
    `  • A fact with a stated expiration has passed`,
    `- When in doubt, store the correction as a NEW memory instead of tombstoning the old one. Newer memories outrank older ones in recall, and tombstoning is a one-way commit from your perspective.`,
    `- Cap: tombstone AT MOST 3 memories this cycle. The tool enforces this, but treat 3 as a hard ceiling rather than a target — most cycles should forget zero.`,
    `- Reference memories by their #id from the "existing memories" list above.`,
    ``,
    `Rules:`,
    `- Store AT MOST ${inputs.maxStore} new memories this cycle. Prefer quality over quantity.`,
    `- Use visibility "private" by default. Only use "shared" if the user explicitly asked to share the fact across agents.`,
    `- Call spindle_memory_store(content, visibility?) once for each memory worth keeping.`,
    `- If nothing in the recent activity is worth storing, say so in plain text and do NOT call any tools. A zero-store cycle is a valid outcome.`,
  ].join("\n");

  const userPrompt =
    "Please review the recent activity above and store any memories worth keeping. If nothing is worth storing, say so and make no tool calls.";

  return { systemPrompt, userPrompt };
}

// ============================================================================
// Internal formatters (exported for testing)
// ============================================================================

/**
 * Format a ms timestamp as "YYYY-MM-DD HH:MM tz" using `toLocaleString`.
 * Passing `timezone=undefined` uses the runtime's system tz — fine for
 * production, tests pass "UTC" for determinism.
 */
export function formatLocalTime(ms: number, timezone?: string): string {
  const date = new Date(ms);
  // Build a YYYY-MM-DD HH:MM with a short tz name.
  const dateStr = date.toLocaleDateString("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const timeStr = date.toLocaleTimeString("en-US", {
    timeZone: timezone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
  const tzStr = date
    .toLocaleTimeString("en-US", {
      timeZone: timezone,
      timeZoneName: "short",
    })
    .split(" ")
    .pop() ?? "";
  return `${dateStr} ${timeStr} ${tzStr}`.trim();
}

/**
 * Build the "last cycle was N ago" line, or a "first cycle" notice.
 */
export function formatCycleContext(
  now: number,
  lastCycleAt: number | null,
  timezone?: string
): string {
  if (lastCycleAt === null) {
    return `- Last consolidation cycle: (none — this is the first cycle since spindle started)`;
  }
  const lastLabel = formatLocalTime(lastCycleAt, timezone);
  const elapsed = formatElapsed(now - lastCycleAt);
  return `- Last consolidation cycle: ${lastLabel} (${elapsed} ago)`;
}

/**
 * "5m", "45m", "1h 30m", "2d 3h". Always shows the two largest
 * non-zero units. Clamps negatives to "just now" (handles system
 * clock jumps — see the runner's wall-clock edge case handling).
 */
export function formatElapsed(ms: number): string {
  if (ms < 0) return "just now";
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 24) {
    if (minutes === 0) return `${totalHours}h`;
    return `${totalHours}h ${minutes}m`;
  }
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  if (hours === 0) return `${days}d`;
  return `${days}d ${hours}h`;
}

/**
 * Render the existing-memories block. Empty list → explicit "none yet"
 * notice so the LLM understands it has a clean slate rather than
 * thinking the list was truncated.
 */
function formatExistingMemories(
  memories: Array<{ id: number; content: string; visibility: string }>,
  maxRender: number
): string {
  if (memories.length === 0) {
    return `Existing memories already stored: (none yet — this agent's memory store is empty)`;
  }
  const shown = memories.slice(0, maxRender);
  const dropped = memories.length - shown.length;
  const lines = [
    `Existing memories already stored (do not duplicate — ids shown for spindle_memory_forget reference):`,
    ...shown.map((m) => `  #${m.id} [${m.visibility}] ${m.content}`),
  ];
  if (dropped > 0) {
    lines.push(`... and ${dropped} more not shown (older).`);
  }
  return lines.join("\n");
}
