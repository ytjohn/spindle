/**
 * spindle-inbox pi extension.
 *
 * Auto-loaded by spindle when `inbox.enabled: true` in agent.yaml.
 * Registers a single action-dispatched `spindle_inbox` tool. The LLM
 * uses it to list/read/mark-read/send inbox messages (matches the shape
 * of an earlier `inbox` tool so the prompt-side migration is minimal).
 *
 * `from_auth` stripping: the `list` and `read` actions omit the
 * `from_auth` frontmatter field from tool output. The field stays in
 * the DB and in the raw file — only the LLM-facing text strips it, so
 * the pseudonym in `from` is what the model sees. This is convention,
 * not a security boundary.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import {
  getBoundInboxEngine,
  getBoundInboxAgentId,
} from "../../inbox/binding";
import type { InboxMessage, MessagePriority } from "../../inbox/types";

const InboxToolParams = Type.Object({
  action: Type.Union(
    [
      Type.Literal("list"),
      Type.Literal("read"),
      Type.Literal("mark_read"),
      Type.Literal("send"),
      Type.Literal("status"),
    ],
    { description: "What to do with the inbox." }
  ),
  // list / read / mark_read parameters
  id: Type.Optional(
    Type.String({
      description:
        "Message id (for action=read or action=mark_read). Take this from a prior list result.",
    })
  ),
  unread_only: Type.Optional(
    Type.Boolean({
      description:
        "For action=list: show only unread messages. Default true.",
    })
  ),
  show_tombstoned: Type.Optional(
    Type.Boolean({
      description: "For action=list: include tombstoned messages. Default false.",
    })
  ),
  limit: Type.Optional(
    Type.Integer({
      description: "For action=list: max messages to return. Default 20, max 200.",
      minimum: 1,
      maximum: 200,
    })
  ),
  // send parameters
  to: Type.Optional(
    Type.String({
      description:
        "For action=send: recipient agent id (e.g. 'jane', 'operator'). Unknown recipients fall through to the operator inbox.",
    })
  ),
  subject: Type.Optional(Type.String({ description: "For action=send: message subject." })),
  body: Type.Optional(Type.String({ description: "For action=send: message body (markdown OK)." })),
  priority: Type.Optional(
    Type.Union(
      [
        Type.Literal("low"),
        Type.Literal("normal"),
        Type.Literal("high"),
        Type.Literal("urgent"),
      ],
      { description: "For action=send: optional priority." }
    )
  ),
  from_override: Type.Optional(
    Type.String({
      description:
        "For action=send: override the displayed 'from' name. Default is your agent name. Operator callers may use this for pseudonyms (e.g. 'Front Desk').",
    })
  ),
});

export default function spindleInboxExtension(pi: ExtensionAPI): void {
  const engine = getBoundInboxEngine();
  if (!engine) {
    console.warn(
      "[spindle-inbox] loaded without a bound InboxEngine — inbox tool disabled."
    );
    return;
  }
  const agentId = getBoundInboxAgentId() ?? engine.getOwnerAgentId();
  const fromAuthSelf = `agent:${agentId}`;
  console.log(
    `[spindle-inbox] registered spindle_inbox tool for agent ${agentId}`
  );

  pi.registerTool({
    name: "spindle_inbox",
    label: "Inbox",
    description:
      "Your addressed-delivery inbox. People send you notes, updates, and requests. " +
      "Use action='list' to see what's waiting, action='read' to open a specific " +
      "message, action='mark_read' to clear it from unread, action='send' to send " +
      "a message to another contact, action='status' for a quick unread summary.",
    promptSnippet:
      "Check your addressed inbox — messages from other agents or the operator.",
    promptGuidelines: [
      "Call spindle_inbox(action='status') at the start of a new session to see if anything is waiting.",
      "When replying to a message, use its id in 'in_reply_to' (if known) and the sender's agent id in 'to'. If the sender is a pseudonym (e.g. 'Front Desk'), reply via the operator inbox unless the user says otherwise.",
    ],
    parameters: InboxToolParams,
    async execute(
      _toolCallId,
      params: Static<typeof InboxToolParams>,
      _signal,
      _onUpdate,
      _ctx
    ) {
      try {
        switch (params.action) {
          case "status": {
            const s = engine.getInboxStatus();
            if (s.unreadCount === 0) {
              return {
                content: [
                  { type: "text", text: "Inbox is empty — no unread messages." },
                ],
                details: s,
              };
            }
            const priorityFlag = s.hasPriority ? " (priority items)" : "";
            const senders = s.unreadSenders.slice(0, 5).join(", ");
            return {
              content: [
                {
                  type: "text",
                  text: `${s.unreadCount} unread message${s.unreadCount === 1 ? "" : "s"} from: ${senders}${priorityFlag}.`,
                },
              ],
              details: s,
            };
          }
          case "list": {
            const unreadOnly = params.unread_only !== false;
            const statusFilter =
              params.show_tombstoned === true ? "all" : unreadOnly ? "unread" : "all";
            const list = engine.listInbox({
              status: statusFilter,
              limit: params.limit ?? 20,
            });
            if (list.items.length === 0) {
              return {
                content: [
                  { type: "text", text: "No messages matched." },
                ],
                details: { total: list.total, count: 0 },
              };
            }
            const lines = list.items.map((m) => formatListLine(m));
            return {
              content: [
                {
                  type: "text",
                  text: `Found ${list.total} message${list.total === 1 ? "" : "s"}:\n${lines.join("\n")}`,
                },
              ],
              details: {
                total: list.total,
                count: list.items.length,
                ids: list.items.map((m) => m.id),
              },
            };
          }
          case "read": {
            if (!params.id) {
              return errorResult("read action requires 'id'");
            }
            const msg = engine.getMessage(params.id);
            if (!msg) {
              return errorResult(`no message found: ${params.id}`);
            }
            // Auto-mark as read when opened.
            if (msg.status === "unread") engine.markRead(params.id);
            const text = formatFullMessage(msg);
            return {
              content: [{ type: "text", text }],
              details: {
                id: msg.id,
                // from_auth deliberately NOT returned — convention is
                // that LLMs see the pseudonym, not the audit layer.
                from: msg.fromDisplay,
                subject: msg.subject,
                priority: msg.priority,
                thread_id: msg.threadId,
                attachments: msg.attachments.map((a) => ({
                  filename: a.filename,
                  size_bytes: a.sizeBytes,
                })),
              },
            };
          }
          case "mark_read": {
            if (!params.id) {
              return errorResult("mark_read action requires 'id'");
            }
            const msg = engine.markRead(params.id);
            if (!msg) {
              return errorResult(
                `no unread message with id ${params.id} (already read or doesn't exist)`
              );
            }
            return {
              content: [{ type: "text", text: `Marked ${params.id} as read.` }],
              details: { id: params.id, status: msg.status },
            };
          }
          case "send": {
            if (!params.to || !params.body) {
              return errorResult(
                "send action requires 'to' and 'body'"
              );
            }
            const result = engine.send({
              to: params.to,
              from: params.from_override ?? agentId,
              fromAuth: fromAuthSelf,
              subject: params.subject,
              body: params.body,
              priority: params.priority as MessagePriority | undefined,
            });
            if (result.deliveryStatus === "unrouted") {
              const peers = result.availableRoutes ?? [];
              const peersText =
                peers.length > 0
                  ? ` Known peer routes: ${peers
                      .map((p) =>
                        p.capabilities && p.capabilities.length > 0
                          ? `${p.agentId} (${p.capabilities.join(", ")})`
                          : p.agentId
                      )
                      .join(", ")}.`
                  : " No peer routes configured — add one via /spindle/routes or the agent.yaml contacts block.";
              return {
                content: [
                  {
                    type: "text",
                    text: `Message sent to operator inbox (no route for '${params.to}'). Message id: ${result.messageId}.${peersText}`,
                  },
                ],
                details: result,
              };
            }
            return {
              content: [
                {
                  type: "text",
                  text: `Sent ${result.messageId} to ${result.deliveredTo}.`,
                },
              ],
              details: result,
            };
          }
          default:
            return errorResult(`unknown action: ${String(params.action)}`);
        }
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  });
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    details: { error: message },
  };
}

function formatListLine(m: InboxMessage): string {
  const flag = m.status === "unread" ? " [NEW]" : m.status === "read" ? " [read]" : " [tombstoned]";
  const priority = m.priority ? ` ⚡${m.priority}` : "";
  const subject = m.subject ? `: ${m.subject}` : "";
  return `${m.id}${flag}${priority}\n  From: ${m.fromDisplay}${subject}\n  Date: ${m.dateIso}`;
}

function formatFullMessage(m: InboxMessage): string {
  const header: string[] = [
    `From: ${m.fromDisplay}`,
    `To: ${m.toAgent}`,
  ];
  if (m.subject) header.push(`Subject: ${m.subject}`);
  header.push(`Date: ${m.dateIso}`);
  if (m.priority) header.push(`Priority: ${m.priority}`);
  if (m.threadId) header.push(`Thread: ${m.threadId}`);
  if (m.inReplyTo) header.push(`In-Reply-To: ${m.inReplyTo}`);
  if (m.attachments.length > 0) {
    header.push(
      `Attachments: ${m.attachments
        .map((a) => `${a.filename} (${a.sizeBytes}B)`)
        .join(", ")}`
    );
  }
  return `${header.join("\n")}\n---\n\n${m.body}`;
}
