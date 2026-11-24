#!/usr/bin/env bun
/**
 * provenance-show — read a pi session .jsonl and print its timeline with
 * origins and run ownership resolved the way a history reader must:
 * from the adjacent `den.origin` / `den.run` entries, never from the
 * body prefix.
 *
 *   bun run src/provenance/show.ts <session.jsonl>
 *
 * A user message with no `den.origin` prints as `origin=?`. That is the
 * honest fallback the contract asks for, and on a session this code has
 * been running against it is a bug worth chasing.
 */

import { readFileSync } from "node:fs";
import { ORIGIN_ENTRY_TYPE, RUN_END_ENTRY_TYPE, RUN_ENTRY_TYPE } from "./types";
import type { OriginEntryData, RunEndEntryData, RunEntryData, Origin } from "./types";

const file = process.argv[2];
if (!file) {
  console.error("usage: provenance-show <session.jsonl>");
  process.exit(2);
}

type Entry = {
  type: string;
  id?: string;
  customType?: string;
  data?: unknown;
  message?: { role?: string; content?: unknown };
  timestamp?: string;
};

const entries: Entry[] = readFileSync(file, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as Entry);

const originsFor = new Map<string, OriginEntryData>();
for (const e of entries) {
  if (e.type === "custom" && e.customType === ORIGIN_ENTRY_TYPE) {
    const d = e.data as OriginEntryData;
    originsFor.set(d.for, d);
  }
}

function fmtOrigin(o: Origin | null | undefined): string {
  if (!o) return "?";
  const actor = o.actor.id ? `${o.actor.kind}:${o.actor.id}` : o.actor.kind;
  return `${o.channel}/${actor}${o.ref ? `#${o.ref}` : ""}`;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c && typeof c === "object" && (c as { type?: string }).type === "text")
    .map((c) => (c as { text: string }).text)
    .join("");
}

function preview(s: string, n = 90): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n) + "…" : one;
}

for (const e of entries) {
  const ts = e.timestamp?.slice(11, 19) ?? "        ";
  if (e.type === "custom" && e.customType === RUN_ENTRY_TYPE) {
    const d = e.data as RunEntryData;
    console.log(`${ts} ▶ run ${d.id}  owner=${fmtOrigin(d.owner)}`);
  } else if (e.type === "custom" && e.customType === RUN_END_ENTRY_TYPE) {
    const d = e.data as RunEndEntryData;
    console.log(`${ts} ■ run ${d.id}  origins=[${d.origins.map(fmtOrigin).join(", ")}]`);
  } else if (e.type === "message" && e.message?.role === "user") {
    const o = e.id ? originsFor.get(e.id) : undefined;
    const tag = o ? `${fmtOrigin(o.origin)} ${o.delivery}` : "origin=?";
    console.log(`${ts}   user  [${tag}]  ${preview(textOf(e.message.content))}`);
  } else if (e.type === "message" && e.message?.role === "assistant") {
    console.log(`${ts}   asst  ${preview(textOf(e.message.content))}`);
  } else if (e.type === "message" && e.message?.role === "toolResult") {
    console.log(`${ts}   tool  ${preview(textOf(e.message.content), 60)}`);
  } else if (e.type === "custom" && e.customType === ORIGIN_ENTRY_TYPE) {
    // Folded into its user message above.
  } else if (e.type === "session") {
    // Header line.
  } else {
    console.log(`${ts}   ${e.type}${e.customType ? `:${e.customType}` : ""}`);
  }
}
