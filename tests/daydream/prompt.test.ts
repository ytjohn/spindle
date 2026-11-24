import { describe, it, expect } from "vitest";
import {
  buildDaydreamPrompt,
  formatLocalTime,
  formatCycleContext,
  formatElapsed,
  type DaydreamPromptInputs,
} from "../../src/daydream/prompt";

// Fixed wall-clock anchor for deterministic tests.
const NOW = Date.parse("2026-04-12T14:25:00.000Z"); // 14:25 UTC

function baseInputs(overrides: Partial<DaydreamPromptInputs> = {}): DaydreamPromptInputs {
  return {
    now: NOW,
    lastCycleAt: Date.parse("2026-04-12T13:25:00.000Z"), // 1h ago
    agentId: "eliza-memory",
    agentDisplayName: "Eliza",
    activitySummary:
      "Recent activity (2 turns over the last 5m):\n\n[14:20] user: my cat is named Pixel\n[14:20] assistant: got it",
    existingMemories: [],
    maxStore: 5,
    timezone: "UTC",
    ...overrides,
  };
}

// ============================================================================
// formatElapsed
// ============================================================================

describe("formatElapsed", () => {
  it("sub-minute returns seconds", () => {
    expect(formatElapsed(0)).toBe("1s"); // clamps to 1s
    expect(formatElapsed(30_000)).toBe("30s");
    expect(formatElapsed(59_000)).toBe("59s");
    expect(formatElapsed(60_000)).toBe("1m"); // minute bucket starts exactly at 60s
  });

  it("minutes for < 1h", () => {
    expect(formatElapsed(60_000)).toBe("1m");
    expect(formatElapsed(15 * 60_000)).toBe("15m");
    expect(formatElapsed(59 * 60_000)).toBe("59m");
  });

  it("hours + minutes for < 1d", () => {
    expect(formatElapsed(60 * 60_000)).toBe("1h");
    expect(formatElapsed(90 * 60_000)).toBe("1h 30m");
    expect(formatElapsed(3 * 60 * 60_000)).toBe("3h");
    expect(formatElapsed(23 * 60 * 60_000 + 45 * 60_000)).toBe("23h 45m");
  });

  it("days + hours for >= 1d", () => {
    expect(formatElapsed(24 * 60 * 60_000)).toBe("1d");
    expect(formatElapsed(25 * 60 * 60_000)).toBe("1d 1h");
    expect(formatElapsed(3 * 24 * 60 * 60_000 + 14 * 60 * 60_000)).toBe("3d 14h");
  });

  it("clamps negative (clock jumped backward) to 'just now'", () => {
    expect(formatElapsed(-1000)).toBe("just now");
    expect(formatElapsed(-60 * 60_000)).toBe("just now");
  });
});

// ============================================================================
// formatLocalTime + formatCycleContext
// ============================================================================

describe("formatLocalTime", () => {
  it("renders UTC for the deterministic test anchor", () => {
    const out = formatLocalTime(NOW, "UTC");
    expect(out).toContain("2026-04-12");
    expect(out).toContain("14:25");
    expect(out).toContain("UTC");
  });

  it("renders in a different tz correctly", () => {
    const out = formatLocalTime(NOW, "America/New_York");
    // 14:25 UTC on 2026-04-12 is 10:25 EDT (daylight saving active)
    expect(out).toContain("2026-04-12");
    expect(out).toContain("10:25");
    // The short tz name is locale-dependent but should be non-empty
    expect(out.length).toBeGreaterThan("2026-04-12 10:25".length);
  });
});

describe("formatCycleContext", () => {
  it("reports first cycle when lastCycleAt is null", () => {
    const out = formatCycleContext(NOW, null, "UTC");
    expect(out).toContain("first cycle");
    expect(out).toContain("spindle started");
  });

  it("reports the last cycle time + elapsed", () => {
    const oneHourAgo = Date.parse("2026-04-12T13:25:00.000Z");
    const out = formatCycleContext(NOW, oneHourAgo, "UTC");
    expect(out).toContain("13:25");
    expect(out).toContain("1h ago");
  });

  it("handles a backward clock jump gracefully", () => {
    const future = Date.parse("2026-04-12T15:25:00.000Z"); // 1h after NOW
    const out = formatCycleContext(NOW, future, "UTC");
    expect(out).toContain("just now");
  });
});

// ============================================================================
// buildDaydreamPrompt — end-to-end prompt assembly
// ============================================================================

describe("buildDaydreamPrompt", () => {
  it("includes the agent id and display name in the framing", () => {
    const out = buildDaydreamPrompt(
      baseInputs({ agentId: "juno", agentDisplayName: "Juno Doe" })
    );
    expect(out.systemPrompt).toContain('"Juno Doe"');
    expect(out.systemPrompt).toContain("id: juno");
  });

  it("falls back to agentId when no display name is provided", () => {
    const out = buildDaydreamPrompt(
      baseInputs({ agentId: "bare", agentDisplayName: undefined })
    );
    expect(out.systemPrompt).toContain('"bare"');
    expect(out.systemPrompt).toContain("id: bare");
  });

  it("includes the current local time and cycle context", () => {
    const out = buildDaydreamPrompt(baseInputs());
    expect(out.systemPrompt).toContain("Current local time:");
    expect(out.systemPrompt).toContain("14:25");
    expect(out.systemPrompt).toContain("1h ago");
  });

  it("embeds the activity summary verbatim", () => {
    const out = buildDaydreamPrompt(
      baseInputs({
        activitySummary: "Recent activity (1 turn over the last 1m):\n\n[14:24] user: hello",
      })
    );
    expect(out.systemPrompt).toContain("[14:24] user: hello");
  });

  it("renders empty existing-memories list as a friendly notice", () => {
    const out = buildDaydreamPrompt(baseInputs({ existingMemories: [] }));
    expect(out.systemPrompt).toContain("memory store is empty");
  });

  it("renders existing memories with ids and visibility labels", () => {
    const out = buildDaydreamPrompt(
      baseInputs({
        existingMemories: [
          { id: 42, content: "user's cat is named Pixel", visibility: "private" },
          { id: 43, content: "user prefers short responses", visibility: "shared" },
        ],
      })
    );
    expect(out.systemPrompt).toContain("#42 [private] user's cat is named Pixel");
    expect(out.systemPrompt).toContain("#43 [shared] user prefers short responses");
    expect(out.systemPrompt).toContain("do not duplicate");
  });

  it("caps existing memories at maxExistingMemories and notes the truncation", () => {
    const mems = Array.from({ length: 30 }, (_, i) => ({
      id: i + 1,
      content: `fact ${i}`,
      visibility: "private" as const,
    }));
    const out = buildDaydreamPrompt(
      baseInputs({
        existingMemories: mems,
        maxExistingMemories: 5,
      })
    );
    expect(out.systemPrompt).toContain("#1 [private] fact 0");
    expect(out.systemPrompt).toContain("#5 [private] fact 4");
    expect(out.systemPrompt).not.toContain("#6 [private] fact 5");
    expect(out.systemPrompt).toContain("25 more not shown");
  });

  it("includes the max_store cap in the instructions", () => {
    const out = buildDaydreamPrompt(baseInputs({ maxStore: 3 }));
    expect(out.systemPrompt).toContain("AT MOST 3");
  });

  it("mentions spindle_memory_store (not memory_store)", () => {
    const out = buildDaydreamPrompt(baseInputs());
    expect(out.systemPrompt).toContain("spindle_memory_store");
    expect(out.systemPrompt).not.toMatch(/\bmemory_store\b/);
  });

  it("includes forget guidance with the 3-per-cycle cap and conservative framing", () => {
    const out = buildDaydreamPrompt(baseInputs());
    expect(out.systemPrompt).toContain("spindle_memory_forget");
    // Cap enforced in the prompt (the tool also caps; belt + suspenders)
    expect(out.systemPrompt).toMatch(/AT MOST 3 memor/);
    // Conservative default: stacking beats tombstoning when in doubt
    expect(out.systemPrompt).toMatch(/(When in doubt|NEW memory instead)/);
    // One-way framing so the curator internalizes the cost
    expect(out.systemPrompt).toContain("one-way commit");
  });

  it("instructs the LLM to make no tool calls on a nothing-worth-storing cycle", () => {
    const out = buildDaydreamPrompt(baseInputs());
    // System prompt uses "do NOT call any tools"
    expect(out.systemPrompt).toMatch(/do NOT call any tools/);
    // User prompt uses "make no tool calls"
    expect(out.userPrompt).toContain("make no tool calls");
  });

  it("user prompt is short and distinct from the system prompt", () => {
    const out = buildDaydreamPrompt(baseInputs());
    expect(out.userPrompt.length).toBeLessThan(300);
    expect(out.systemPrompt.length).toBeGreaterThan(out.userPrompt.length * 3);
  });

  it("is deterministic for deterministic inputs (snapshot-ish)", () => {
    const first = buildDaydreamPrompt(baseInputs());
    const second = buildDaydreamPrompt(baseInputs());
    expect(first.systemPrompt).toBe(second.systemPrompt);
    expect(first.userPrompt).toBe(second.userPrompt);
  });

  it("snapshot: first cycle with empty memories", () => {
    const out = buildDaydreamPrompt(
      baseInputs({
        lastCycleAt: null,
        existingMemories: [],
        activitySummary:
          "Recent activity (1 turn over the last 2m):\n\n[14:23] user: hello there",
      })
    );
    // Snapshot critical sections — not the whole thing, so small
    // wording tweaks don't force churn, but structural changes do.
    expect(out.systemPrompt).toMatchInlineSnapshot(`
      "You are the memory curator for agent "Eliza" (id: eliza-memory).

      Your job is to review recent conversation activity and decide what — if anything — is worth storing as a persistent memory. You run in a short ephemeral session every ~30 minutes. The main agent session is unaffected by your work.

      Time context:
      - Current local time: 2026-04-12 14:25 UTC
      - Last consolidation cycle: (none — this is the first cycle since spindle started)

      Recent activity (1 turn over the last 2m):

      [14:23] user: hello there

      Existing memories already stored: (none yet — this agent's memory store is empty)

      What to store:
      - Durable facts the user stated: names, preferences, projects, relationships, locations, dates
      - Ongoing situations the user is tracking (a move, a health thing, a project deadline)
      - Things the user explicitly said to remember

      What NOT to store:
      - Single-session chit-chat or casual acknowledgments ("hello", "thanks", "ok")
      - Your own interpretations or inferences about the user that weren't stated
      - Facts that duplicate an entry in the "existing memories" list above — skip these
      - Tool calls, system events, errors, or retry attempts
      - Ambiguous snippets that need conversation context to make sense later

      How to phrase each memory:
      - Third-person factual statements the agent would benefit from recalling later
      - Good: "user's cat is named Pixel"
      - Good: "user recently moved to Lisbon"
      - Bad:  "I remember you told me your cat is Pixel" (first-person framing)
      - Bad:  "the user seems nice" (interpretation, not fact)

      Forgetting memories (spindle_memory_forget):
      - You can tombstone an outdated or contradicted memory by calling spindle_memory_forget(ids, reason). Tombstoned memories are hidden from every future recall but stay on disk so a human can restore them later.
      - Use ONLY for unambiguous cases:
        • The user explicitly asked you to forget something ("forget I told you X")
        • A new fact directly contradicts an old one AND the old one is clearly wrong (example: user corrected their dog's name from Rex to Satiann)
        • A fact with a stated expiration has passed
      - When in doubt, store the correction as a NEW memory instead of tombstoning the old one. Newer memories outrank older ones in recall, and tombstoning is a one-way commit from your perspective.
      - Cap: tombstone AT MOST 3 memories this cycle. The tool enforces this, but treat 3 as a hard ceiling rather than a target — most cycles should forget zero.
      - Reference memories by their #id from the "existing memories" list above.

      Rules:
      - Store AT MOST 5 new memories this cycle. Prefer quality over quantity.
      - Use visibility "private" by default. Only use "shared" if the user explicitly asked to share the fact across agents.
      - Call spindle_memory_store(content, visibility?) once for each memory worth keeping.
      - If nothing in the recent activity is worth storing, say so in plain text and do NOT call any tools. A zero-store cycle is a valid outcome."
    `);
  });
});
