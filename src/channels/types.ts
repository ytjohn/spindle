import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../types";

export interface SlashCommandInfo {
  name: string;
  description?: string;
  source?: string;
}

/** Per-channel liveness for agent-state.json. */
export interface ChannelLiveness {
  connected: boolean;
  logged_in?: boolean;
  last_activity_at?: string | null;
  detail?: string;

  /**
   * Embodiment, as reported by the server rather than inferred.
   *
   * `connected` is the socket and `logged_in` is authentication; NEITHER
   * means the agent can act. Twelve agents once held open, authenticated
   * sockets while eight of them had no character attached and every
   * command came back "not available". A reader must not infer
   * embodiment from the two fields above.
   *
   * `puppet` null while `logged_in` is true IS the failure. `null` here
   * with `last_ping_at` also null means "never asked", which is not the
   * same thing — distinguish them before alerting.
   */
  puppet?: string | null;
  room?: string | null;
  room_id?: number | null;
  /** When the server last answered a ping. Distinct from heartbeat_at,
   *  which only proves this process is alive. */
  last_ping_at?: string | null;
}

export interface Channel {
  readonly name: string;
  /**
   * Optional: report transport liveness for agent-state.json. Optional so
   * channels that predate it keep compiling; a channel without it simply
   * does not appear in the state file's `channels` block.
   */
  getLiveness?(): ChannelLiveness;
  /**
   * Optional: call `listener` when what getLiveness() reports changes in a
   * way a reader cares about now (for a game channel: puppet, room, socket).
   * Lets another channel push a presence frame the moment the agent changes
   * rooms instead of at its next activity. Returns an unsubscribe.
   */
  onLivenessChange?(listener: () => void): () => void;
  /**
   * Optional: called on every channel at shutdown BEFORE any channel is
   * stopped. For work that needs the other channels still up — ending
   * helper sessions that may be mid-delivery through a sibling.
   */
  beforeShutdown?(): Promise<void>;
  start(
    session: AgentSession,
    config: AgentConfig,
    getSlashCommands?: () => SlashCommandInfo[]
  ): Promise<void>;
  stop(): Promise<void>;
}
