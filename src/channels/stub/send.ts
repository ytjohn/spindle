#!/usr/bin/env bun
/**
 * stub-send — talk to a StubChannel socket from the shell.
 *
 *   bun run src/channels/stub/send.ts <socket> [--steer|--followup|--prompt] <text...>
 *   bun run src/channels/stub/send.ts <socket> --listen
 *
 * Sends one line and prints everything the channel says until the run
 * that consumed the message ends (a `[done <run>]` line), or 180 s pass.
 * `--no-wait` returns right after sending. `--listen` never sends; it
 * tails the channel, which is the easiest way to watch a second door.
 */

import { connect } from "node:net";

const args = process.argv.slice(2);
const socketPath = args.shift();
if (!socketPath) {
  console.error("usage: stub-send <socket> [--steer|--followup|--prompt|--listen|--no-wait] <text...>");
  process.exit(2);
}

let mode: "steer" | "followup" | "prompt" | null = null;
let listen = false;
let wait = true;
const words: string[] = [];
for (const a of args) {
  if (a === "--steer") mode = "steer";
  else if (a === "--followup") mode = "followup";
  else if (a === "--prompt") mode = "prompt";
  else if (a === "--listen") listen = true;
  else if (a === "--no-wait") wait = false;
  else words.push(a);
}
const text = words.join(" ").trim();
if (!listen && !text) {
  console.error("nothing to send");
  process.exit(2);
}

const sock = connect(socketPath);
sock.setEncoding("utf8");
let buf = "";
const timer = listen ? null : setTimeout(() => {
  console.error("(timed out waiting for run end)");
  sock.destroy();
  process.exit(1);
}, 180_000);

sock.on("connect", () => {
  if (listen) return;
  sock.write((mode ? `${mode}: ${text}` : text) + "\n");
  if (!wait) {
    sock.end();
    process.exit(0);
  }
});
sock.on("data", (chunk: string) => {
  buf += chunk;
  let nl: number;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (line.startsWith("[done ")) {
      if (!listen) {
        if (timer) clearTimeout(timer);
        sock.end();
        process.exit(0);
      }
      continue;
    }
    console.log(line);
  }
});
sock.on("error", (err) => {
  console.error(`socket error: ${err.message}`);
  process.exit(1);
});
sock.on("close", () => process.exit(0));
