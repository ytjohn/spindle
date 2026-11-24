import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { UserAccess } from "./types";

/**
 * Resolves which AgentSession handles a message from a given user in a
 * given chat. Phase 3 only implements `SingleSessionRouter` — one shared
 * session across all allowed users — but the interface is in place so
 * future routers can add per-user sessions, locked-session users, or
 * chat-room mode without changing the channel's call sites.
 */
export interface SessionRouter {
  resolve(userId: number, chatId: number): AgentSession | null;
}

/**
 * Parses the `allowed_users` config (which accepts both simple string
 * form and the extended object form) into a normalized `UserAccess[]`.
 * Unknown / unparseable entries are dropped with a console warning.
 */
export function parseAllowedUsers(
  raw: Array<string | { id: string; session?: string; access?: "full" | "single" | "room" }> | undefined
): UserAccess[] {
  if (!raw) return [];
  const result: UserAccess[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      const id = Number(entry);
      if (Number.isFinite(id)) result.push({ id, access: "full" });
      else console.warn(`[spindle] invalid allowed_users id: ${entry}`);
    } else {
      const id = Number(entry.id);
      if (Number.isFinite(id)) {
        result.push({
          id,
          session: entry.session,
          access: entry.access ?? "full",
        });
      } else {
        console.warn(`[spindle] invalid allowed_users id: ${entry.id}`);
      }
    }
  }
  return result;
}

/**
 * Phase 3 router: all allowed users share the single boot session.
 * Unrecognized users get null (which the channel treats as "drop").
 */
export class SingleSessionRouter implements SessionRouter {
  constructor(
    private readonly session: AgentSession,
    private readonly allowedUsers: UserAccess[]
  ) {}

  resolve(userId: number, _chatId: number): AgentSession | null {
    const user = this.allowedUsers.find((u) => u.id === userId);
    return user ? this.session : null;
  }
}
