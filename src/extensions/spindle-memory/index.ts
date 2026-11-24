/**
 * spindle-memory pi extension.
 *
 * Auto-loaded by spindle when `memory.enabled: true` in agent.yaml.
 * Registers `spindle_memory_store` and `spindle_memory_recall` tools
 * the LLM can call. Prefixed with `spindle_` for namespace hygiene so
 * they don't collide with agent-specific memory tools from other
 * extensions (e.g. a hypothetical `chassy_memory_*` world-lore store).
 *
 * Talks to the MemoryEngine via a module-level binding set by spindle
 * BEFORE pi's extension loader runs. When loaded standalone (outside
 * spindle) the binding is null and the extension registers no tools —
 * logs a warning and returns cleanly.
 *
 * Design decisions baked in (see the Phase 2 plan):
 *   - LLM tool does NOT expose `kind` — defaults to 'semantic'
 *   - LLM tool does NOT expose `thread_id` — threads are for code,
 *     not LLMs (LLMs are bad at consistent tagging)
 *   - LLM tool does NOT expose `threadPattern` on recall for the
 *     same reason — pattern building is a code responsibility
 *   - LLM CAN optionally set `visibility: 'private' | 'shared'` when
 *     storing, with private as the default
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import {
  getBoundMemoryEngine,
  getBoundAgentId,
  bindMemoryAgentId,
  isDaydreamActive,
  isMainStoreEnabled,
  getLoadContext,
} from "../../memory/binding";
import type { Visibility } from "../../memory/types";

// ============================================================================
// Tool parameter schemas
// ============================================================================

const MemoryStoreParams = Type.Object({
  content: Type.String({
    description: "The fact, observation, or detail to remember",
    minLength: 1,
  }),
  visibility: Type.Optional(
    Type.Union(
      [Type.Literal("private"), Type.Literal("shared")],
      {
        description:
          "Who can recall this memory. 'private' (default) is only you; 'shared' is any agent reading the same store.",
      }
    )
  ),
});

const MemoryRecallParams = Type.Object({
  query: Type.String({
    description: "Keywords to search memories for",
    minLength: 1,
  }),
  limit: Type.Optional(
    Type.Integer({
      description: "Max number of memories to return (default 10)",
      minimum: 1,
      maximum: 50,
    })
  ),
});

const MemoryAssociateParams = Type.Object({
  memory_ids: Type.Array(Type.Integer({ minimum: 1 }), {
    description:
      "Two to ten memory ids that belong together. Every unordered pair will be reinforced. Ids you cannot see are silently skipped.",
    minItems: 2,
    maxItems: 10,
  }),
});

const MemoryForgetParams = Type.Object({
  ids: Type.Array(Type.Integer({ minimum: 1 }), {
    description:
      "One to three memory ids to tombstone. Tombstoned memories are hidden from recall but can be restored by a human reviewer — this is a one-way commit for you.",
    minItems: 1,
    maxItems: 3,
  }),
  reason: Type.String({
    description:
      "Short machine-parseable reason the memory is being forgotten (e.g. 'user_correction', 'outdated_location', 'explicit_forget_request').",
    minLength: 1,
    maxLength: 200,
  }),
});

// ============================================================================
// Extension entry point
// ============================================================================

/**
 * Pi extension default export. Pi's loader calls this with the
 * ExtensionAPI for the current session at extension load time.
 */
export default function spindleMemoryExtension(pi: ExtensionAPI): void {
  const engine = getBoundMemoryEngine();

  if (!engine) {
    console.warn(
      "[spindle-memory] loaded without a bound MemoryEngine — memory tools disabled. " +
        "This extension is only functional when loaded inside spindle with memory.enabled=true."
    );
    return;
  }

  // The agent id for this extension comes from the cwd-derived pi agent
  // identity in the extension context at execute time. But we want it at
  // register time so the closure binds it once. For now, the extension
  // uses a placeholder that the execute handler resolves dynamically via
  // the context's session path or a pi-provided identity field.
  //
  // Simpler approach for Phase 2.0: read the agent id from a second
  // module-level binding that spindle sets alongside the engine. The
  // engine already tracks registered agents, so we just need to know
  // which id to pass.
  const agentId = getBoundAgentId();
  if (!agentId) {
    console.warn(
      "[spindle-memory] loaded without a bound agent id — memory tools disabled."
    );
    return;
  }

  const daydream = isDaydreamActive();
  const context = getLoadContext();
  const mainStoreEnabled = isMainStoreEnabled();

  // Should the store tool be registered for this extension load?
  //
  //   context=daydream  → YES, always (daydream needs it to do its job)
  //   context=main      → follows mainStoreEnabled flag, which was set
  //                        at spindle boot from config.memory.main_session_store_tool
  //                        (or the default `!daydreamActive` when unset)
  //
  // This lets an operator choose any combination:
  //   - daydream on, mainStoreEnabled=false (default): daydream is sole writer
  //   - daydream off, mainStoreEnabled=true (default): Phase 2 backwards compat
  //   - daydream off, mainStoreEnabled=false: read-only agent
  //   - daydream on, mainStoreEnabled=true: both paths write, daydream dedupes
  const shouldRegisterStore = context === "daydream" || mainStoreEnabled;

  const storeLabel = shouldRegisterStore
    ? "spindle_memory_store + spindle_memory_recall"
    : "spindle_memory_recall only (store tool withheld)";
  console.log(
    `[spindle-memory] ${context} session: registered ${storeLabel} for agent ${agentId} ` +
      `(daydream ${daydream ? "ACTIVE" : "inactive"}, mainStoreEnabled=${mainStoreEnabled})`
  );

  // Recall guidelines apply in all cases — every session needs to
  // know it should check memory before asking the user to repeat.
  const recallGuidelines: string[] = [
    "Call spindle_memory_recall BEFORE asking the user to repeat information. If they've told you something in an earlier session, the memory tool probably knows about it.",
    "Trust the recall results. Your memory persists across spindle restarts; don't claim amnesia when you can see stored memories in a recall result.",
  ];

  // Store guidelines only apply when the store tool is actually
  // registered AND when it's the main session (the daydream session
  // has its own self-contained curator prompt via systemPromptOverride,
  // so tool-level guidelines are redundant there).
  const storeGuidelines: string[] =
    shouldRegisterStore && context === "main"
      ? [
          "When the user tells you a durable fact worth remembering across sessions (their name, preferences, ongoing projects, relationships), call spindle_memory_store to record it. Don't overthink it — just store the raw observation.",
          "Default visibility is 'private' (only this agent can recall it). Use visibility: 'shared' only when the user explicitly asks to share the fact across agents.",
        ]
      : [];

  if (shouldRegisterStore) {
    pi.registerTool({
      name: "spindle_memory_store",
      label: "Store Memory",
      description:
        "Record a fact, observation, or detail about the user or the current context " +
        "so you can recall it later — even across sessions. Use for persistent information " +
        "you want to reference in future conversations. You do not need to call this for " +
        "short-term context within the current conversation; the session already has that.",
      promptSnippet:
        "Store a persistent memory. Use for facts worth remembering across sessions.",
      promptGuidelines: storeGuidelines,
      parameters: MemoryStoreParams,
      async execute(
        _toolCallId,
        params: Static<typeof MemoryStoreParams>,
        _signal,
        _onUpdate,
        _ctx
      ) {
        const visibility: Visibility = params.visibility ?? "private";
        try {
          const id = await engine.store(agentId, {
            content: params.content,
            visibility,
          });
          return {
            content: [
              {
                type: "text",
                text: `Stored memory #${id} (${visibility}).`,
              },
            ],
            details: { id, visibility },
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text", text: `Failed to store memory: ${message}` }],
            details: { error: message },
          };
        }
      },
    });
  }

  // Phase 2.1: spindle_memory_associate is daydream-only by design.
  // The main session never sees it because every LLM-facing tool adds
  // permanent per-turn prompt overhead, and co-recall reinforcement
  // already covers main-session link growth at zero extra latency.
  // Daydream curation is the right place for explicit associations.
  if (context === "daydream") {
    pi.registerTool({
      name: "spindle_memory_associate",
      label: "Associate Memories",
      description:
        "Strengthen the Hebbian connection between two or more memories that " +
        "belong together. Every unordered pair in memory_ids gets reinforced. " +
        "Use when you've identified a cluster of related memories during " +
        "curation — e.g. multiple facts about the same project, person, or " +
        "ongoing topic. Memories you cannot see are silently skipped.",
      promptSnippet:
        "Strengthen the connection between memories that belong together.",
      promptGuidelines: [],
      parameters: MemoryAssociateParams,
      async execute(
        _toolCallId,
        params: Static<typeof MemoryAssociateParams>,
        _signal,
        _onUpdate,
        _ctx
      ) {
        try {
          const result = engine.associate(agentId, params.memory_ids);
          const text =
            result.skipped === 0
              ? `Reinforced ${result.reinforced} pair${result.reinforced === 1 ? "" : "s"}.`
              : `Reinforced ${result.reinforced} pair${result.reinforced === 1 ? "" : "s"}; skipped ${result.skipped} (memories not visible).`;
          return {
            content: [{ type: "text", text }],
            details: result,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text", text: `Failed to associate: ${message}` }],
            details: { error: message },
          };
        }
      },
    });
  }

  // Phase 5.1: spindle_memory_forget is daydream-only by design.
  // Rationale (same category as spindle_memory_associate):
  //   - per-turn prompt overhead on every main-session turn is expensive
  //     for a tool the curator is the right caller for
  //   - a main-session LLM with forget could tombstone mid-turn in
  //     response to ambiguous user input; curator-only inserts an
  //     activity-window delay where the full context is available
  //   - tool-surface absence is a guaranteed non-call; prose guidance
  //     is not
  if (context === "daydream") {
    pi.registerTool({
      name: "spindle_memory_forget",
      label: "Forget Memory",
      description:
        "Tombstone an outdated or contradicted memory. Tombstoned memories are hidden " +
        "from every future recall but stay on disk so a human reviewer can restore them. " +
        "Use ONLY for unambiguous cases: the user explicitly asked to forget something, " +
        "a new fact directly contradicts an old one, or an explicitly dated fact has " +
        "expired. When in doubt, store the correction as a new memory instead — " +
        "tombstoning is a one-way commit from your perspective.",
      promptSnippet:
        "Tombstone an outdated or contradicted memory (unambiguous cases only).",
      promptGuidelines: [],
      parameters: MemoryForgetParams,
      async execute(
        _toolCallId,
        params: Static<typeof MemoryForgetParams>,
        _signal,
        _onUpdate,
        _ctx
      ) {
        try {
          // Visibility-check each id against the curator's agent BEFORE
          // tombstoning. engine.tombstone itself is unconditional by
          // design (it trusts the caller); this is where that trust is
          // earned. Skipped ids are surfaced in the response so the
          // curator can see that a forget attempt was rejected.
          const visibleIds: number[] = [];
          const skippedIds: number[] = [];
          for (const id of params.ids) {
            const row = engine.getById(agentId, id);
            if (row && row.agentId === agentId) {
              visibleIds.push(id);
            } else {
              skippedIds.push(id);
            }
          }

          const tombstoned =
            visibleIds.length > 0
              ? engine.tombstone(visibleIds, params.reason)
              : 0;

          const parts: string[] = [];
          parts.push(
            `Tombstoned ${tombstoned} memor${tombstoned === 1 ? "y" : "ies"}` +
              (tombstoned > 0 ? ` (${params.reason}).` : ".")
          );
          if (skippedIds.length > 0) {
            parts.push(
              `Skipped ${skippedIds.length} id${skippedIds.length === 1 ? "" : "s"} ` +
                `(not owned by this agent or not found): ${skippedIds.join(", ")}.`
            );
          }

          return {
            content: [{ type: "text", text: parts.join(" ") }],
            details: {
              tombstoned,
              skipped: skippedIds.length,
              skipped_ids: skippedIds,
              reason: params.reason,
            },
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text", text: `Failed to forget: ${message}` }],
            details: { error: message },
          };
        }
      },
    });
  }

  pi.registerTool({
    name: "spindle_memory_recall",
    label: "Recall Memories",
    description:
      "Search previously stored memories for relevant facts or context. " +
      "Returns a ranked list of matching memories. Use before asking the user to " +
      "repeat information — you may already know it. Searches your private memories " +
      "and any memories shared across agents.",
    promptSnippet: "Search persistent memories by keyword before asking the user to repeat facts.",
    promptGuidelines: recallGuidelines,
    parameters: MemoryRecallParams,
    async execute(
      _toolCallId,
      params: Static<typeof MemoryRecallParams>,
      _signal,
      _onUpdate,
      _ctx
    ) {
      try {
        const results = await engine.recall(agentId, {
          query: params.query,
          limit: params.limit ?? 10,
        });
        if (results.length === 0) {
          return {
            content: [{ type: "text", text: "No memories matched that query." }],
            details: { count: 0 },
          };
        }
        const lines = results.map(
          (r, i) =>
            `${i + 1}. [${r.score.toFixed(2)}] ${r.memory.content}`
        );
        return {
          content: [
            {
              type: "text",
              text: `Found ${results.length} memor${results.length === 1 ? "y" : "ies"}:\n${lines.join("\n")}`,
            },
          ],
          details: {
            count: results.length,
            ids: results.map((r) => r.memory.id),
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Failed to recall: ${message}` }],
          details: { error: message },
        };
      }
    },
  });
}

// Re-export the agent id binding from memory/binding.ts so callers
// that already import `bindMemoryAgentId` from this module continue
// to work. The actual storage is in binding.ts via globalThis
// symbols — see there for why a module-level let was insufficient.
export { bindMemoryAgentId };
