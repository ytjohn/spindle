/**
 * StubChannel — a hand-driven channel for proving multi-channel behaviour.
 *
 * Not a product transport. It exists so an operator can push messages
 * into a live session from two or more independent "doors" and watch
 * how provenance, ownership, and output routing behave — steer and
 * followUp included — without a Telegram bot or a MUD server. Configure
 * two of them on one agent and you have the chassy shape on a throwaway.
 *
 * Transport: a Unix domain socket per instance, newline-delimited text.
 *
 *   inbound line                      → what happens
 *   ─────────────────────────────────────────────────────────────────
 *   hello there                       → dispatch, streamingBehavior followUp
 *   followup: hello there             → same, explicit
 *   steer: stop and do X              → dispatch, streamingBehavior steer
 *   prompt: hello there               → dispatch with NO streamingBehavior;
 *                                       pi throws "Agent is already
 *                                       processing" if a run is in flight.
 *                                       Kept on purpose — that error class
 *                                       is one we want reproducible.
 *   /slash args                       → dispatched untagged so pi routes it
 *
 * Every connected client receives the channel's log: run boundaries with
 * their owner, each origin as it is persisted, and the assistant text of
 * runs THIS channel owns. Runs owned by another channel are noted and
 * suppressed, which is exactly the Telegram rule, expressed through the
 * tracker instead of a private boolean.
 *
 * Body prefix: `[<name>] ` mirrors the Telegram convention. It is for the
 * model. Nothing in this file reads it back.
 */

import { createServer, type Server, type Socket } from "node:net";
import { appendFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../../types";
import type { Channel, ChannelLiveness, SlashCommandInfo } from "../types";
import { getProvenanceTracker } from "../../provenance/binding";
import { origin as makeOrigin, type ProvenanceTracker } from "../../provenance/tracker";
import type { ProvenanceEvent } from "../../provenance/types";

export interface StubChannelConfig {
  /** Channel name; also the origin.channel value and the body prefix. */
  name: string;
  /** Socket path, absolute or agent-relative. Default `<agentDir>/<name>.sock`. */
  socket?: string;
  /** Log file, absolute or agent-relative. Default `<agentDir>/<name>.log`. */
  log?: string;
}

type Mode = "followUp" | "steer" | "prompt";

/** Parse one inbound line into a delivery mode and the text to send. */
export function parseLine(line: string): { mode: Mode; text: string } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const m = /^(steer|followup|prompt)\s*:\s*(.*)$/is.exec(trimmed);
  if (m) {
    const mode = m[1].toLowerCase() === "steer" ? "steer" : m[1].toLowerCase() === "prompt" ? "prompt" : "followUp";
    const text = m[2].trim();
    return text ? { mode, text } : null;
  }
  return { mode: "followUp", text: trimmed };
}

export class StubChannel implements Channel {
  readonly name: string;
  private readonly socketPath: string;
  private readonly logPath: string;
  private server: Server | null = null;
  private readonly clients = new Set<Socket>();
  private session: AgentSession | null = null;
  private tracker: ProvenanceTracker | null = null;
  private unsubscribeSession: (() => void) | null = null;
  private unsubscribeTracker: (() => void) | null = null;
  private seq = 0;
  private lastActivityAt: string | null = null;

  // Per-run render state. Reset on run_start.
  private owned = false;
  private suppressedNoted = false;
  private text = "";

  constructor(opts: { agentDir: string; config: StubChannelConfig }) {
    this.name = opts.config.name;
    this.socketPath = resolve(opts.agentDir, opts.config.socket ?? `${this.name}.sock`);
    this.logPath = resolve(opts.agentDir, opts.config.log ?? `${this.name}.log`);
  }

  getLiveness(): ChannelLiveness {
    return {
      connected: this.server !== null,
      last_activity_at: this.lastActivityAt,
      detail: `${this.clients.size} client(s) on ${this.socketPath}`,
    };
  }

  async start(
    session: AgentSession,
    _config: AgentConfig,
    _getSlashCommands?: () => SlashCommandInfo[]
  ): Promise<void> {
    this.session = session;
    this.tracker = getProvenanceTracker();
    if (!this.tracker) {
      throw new Error(`[stub:${this.name}] no ProvenanceTracker bound — start it after the tracker`);
    }
    this.unsubscribeSession = session.subscribe((ev) => this.onSessionEvent(ev));
    this.unsubscribeTracker = this.tracker.subscribe((ev) => this.onProvenance(ev));

    if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
    this.server = createServer((sock) => this.onConnection(sock));
    await new Promise<void>((res, rej) => {
      this.server!.once("error", rej);
      this.server!.listen(this.socketPath, () => {
        this.server!.off("error", rej);
        res();
      });
    });
    this.emitLine(`listening on ${this.socketPath}`);
  }

  async stop(): Promise<void> {
    this.unsubscribeSession?.();
    this.unsubscribeTracker?.();
    for (const c of this.clients) c.destroy();
    this.clients.clear();
    await new Promise<void>((res) => (this.server ? this.server.close(() => res()) : res()));
    this.server = null;
    if (existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch {
        /* ignore */
      }
    }
  }

  // ── Inbound ─────────────────────────────────────────────────────────

  private onConnection(sock: Socket): void {
    this.clients.add(sock);
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        void this.handleLine(line, sock);
      }
    });
    sock.on("close", () => this.clients.delete(sock));
    sock.on("error", () => this.clients.delete(sock));
  }

  async handleLine(line: string, from?: Socket): Promise<void> {
    const parsed = parseLine(line);
    if (!parsed) return;
    const session = this.session;
    const tracker = this.tracker;
    if (!session || !tracker) return;

    this.seq += 1;
    const ref = `${this.name}-${this.seq}`;
    this.lastActivityAt = new Date().toISOString();
    const tagged = parsed.text.startsWith("/") ? parsed.text : `[${this.name}] ${parsed.text}`;
    const origin = makeOrigin(this.name, { kind: "human", id: "operator" }, ref);
    const streaming = session.isStreaming;
    this.emitLine(`<< ${parsed.mode} (${ref}, session ${streaming ? "streaming" : "idle"}): ${parsed.text}`);

    try {
      await tracker.dispatch(tagged, origin, {
        ...(parsed.mode === "prompt" ? {} : { streamingBehavior: parsed.mode }),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emitLine(`!! dispatch ${ref} failed: ${msg}`);
      from?.write(`[${this.name}] error: ${msg}\n`);
    }
  }

  // ── Rendering ───────────────────────────────────────────────────────

  private onProvenance(ev: ProvenanceEvent): void {
    switch (ev.type) {
      case "run_start": {
        this.owned = ev.run.owner?.channel === this.name;
        this.suppressedNoted = false;
        this.text = "";
        const owner = ev.run.owner ? `${ev.run.owner.channel}/${ev.run.owner.actor.kind}` : "none";
        this.emitLine(`▶ run ${ev.run.id} owner=${owner}${this.owned ? " (mine)" : ""}`);
        break;
      }
      case "origin": {
        const o = ev.record.origin;
        this.emitLine(
          `● origin ${o.channel}/${o.actor.kind}${o.ref ? ` ref=${o.ref}` : ""} ` +
            `delivery=${ev.record.delivery} entry=${ev.record.entryId ?? "?"} run=${ev.record.run ?? "-"}`
        );
        break;
      }
      case "run_end": {
        const origins = ev.run.origins.map((o) => o.channel).join(",");
        this.emitLine(`■ run ${ev.run.id} ended origins=[${origins}]`);
        // Machine-readable terminator for stub-send.
        this.broadcast(`[done ${ev.run.id}]\n`);
        break;
      }
    }
  }

  private onSessionEvent(ev: { type: string; [k: string]: unknown }): void {
    switch (ev.type) {
      case "message_update": {
        if (!this.owned) break;
        const a = ev.assistantMessageEvent as { type?: string; delta?: string } | undefined;
        if (a?.type === "text_delta" && typeof a.delta === "string") this.text += a.delta;
        break;
      }
      case "message_end": {
        const msg = ev.message as { role?: string } | undefined;
        if (msg?.role !== "assistant") break;
        if (this.owned) {
          const out = this.text.trim();
          this.text = "";
          if (out) this.emitLine(`>> ${out}`);
        } else if (!this.suppressedNoted) {
          this.suppressedNoted = true;
          const run = this.tracker?.currentRun();
          const owner = run?.owner ? run.owner.channel : "none";
          this.emitLine(`(assistant text suppressed — run owned by ${owner})`);
        }
        break;
      }
      case "tool_execution_start": {
        if (!this.owned) break;
        this.emitLine(`⚙ ${String(ev.toolName)}`);
        break;
      }
    }
  }

  // ── Output plumbing ─────────────────────────────────────────────────

  private emitLine(line: string): void {
    const stamped = `${new Date().toISOString()} [${this.name}] ${line}`;
    console.log(`[stub:${this.name}] ${line}`);
    try {
      appendFileSync(this.logPath, stamped + "\n");
    } catch {
      /* logging must never break the channel */
    }
    this.broadcast(`[${this.name}] ${line}\n`);
  }

  private broadcast(line: string): void {
    for (const c of this.clients) {
      try {
        c.write(line);
      } catch {
        this.clients.delete(c);
      }
    }
  }
}
