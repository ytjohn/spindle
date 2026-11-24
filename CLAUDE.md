# CLAUDE.md

Guidance for AI coding agents (and people) working in this repository.

## What this is

Spindle runs a [pi](https://github.com/earendil-works/pi) coding agent as a
long-lived service. It does not implement an agent loop; pi does. Spindle
reads an agent directory (`agent.yaml` + `AGENTS.md`), builds one pi session
from it, attaches channels and background work to that session, and keeps
it running. `README.md` describes it from a user's side.

## Commands

```bash
bun install                               # also applies patches/
bun run start -- <agent-dir>              # run an agent, e.g. examples/eliza
bun run test                              # the whole suite (vitest)
bun --bun run vitest run <file>           # one file; add -t "name" for one test
bun run typecheck                         # tsc --noEmit
```

Use Bun throughout (`bun`, `bunx`, `bun:sqlite`). There is no build step.
Tests run under **vitest**, not `bun test`.

Before calling a change done: typecheck is clean and the suite passes.

## Layout

```
src/
  index.ts        CLI and boot sequence — read this first
  api.ts          the public surface for plugins and extensions
  agent/          building the pi session; helper sessions; session kind
  config/         agent.yaml loading and its TypeBox schema
  channels/       the Channel interface, the plugin registry, built-in channels
  plugins/        loading plugins named in agent.yaml
  extensions/     pi extensions that ship with spindle (spindle-*), and the
                  loader for spindle extensions
  provenance/     who sent each message, and who owns the current run
  memory/         SQLite memory engine, scoring, visibility
  daydream/       background loop that files conversation into memory
  scheduler/      cron entries run in throwaway sessions
  inbox/          addressed mail between agents, files on disk
  compact/        compaction on spindle's terms, ahead of pi's own
  outbound/       deliveries to the operator, and the log of them
  media/ speech/  files sent and received; speech recognition and synthesis
  sessions/       projecting pi's session files into SQLite
  telemetry/ state/   per-turn stats; the state file for outside monitors
  web/            HTTP API and the built-in UI
tests/            mirrors src/; a few module tests sit beside their module
examples/         one small agent per feature
docs/             plugins.md is the reference for adding a channel
```

## Things that are easy to get wrong

**Boot order is load-bearing.** pi loads extensions synchronously while it
builds the session, and an extension usually looks for what it serves at
that moment — the memory engine, its channel — to decide what to register.
So those are created and published *before* `createSpindleSession()`, and
channels are *started* after it. If an extension finds nothing, it
registers nothing and says little. `src/index.ts` is in the required order;
keep it that way.

**State an extension reads lives on `globalThis`.** pi loads extensions
through its own module loader, and loads them again for every helper
session, so a module-level variable in `src/` is not the one an extension
sees. Anything shared is kept in a slot keyed by `Symbol.for("@spindle/…")`
— see `src/memory/binding.ts` for the pattern. Do not turn one of these
into a module-level `let`.

**Helper sessions run every extension's `register()` again.** Daydream,
scheduled runs and one-off sessions are built from the main session's
extension list. An extension that owns something there can only be one of
(a channel's inbound handler, a prompt splice) checks
`isMainSession()` / `getSessionKind()` first. A factory that builds a
helper session sets the kind before pi loads extensions and restores
`"main"` in a `finally`.

**A run has an owner.** `provenance/` records which channel and actor
opened the current run. Behaviour that depends on who is being answered
reads that, never the text of the message.

**Core does not name a channel it does not ship.** Behaviour that depends
on a channel goes through something the channel declares
(`channels/capabilities.ts`) or registers (outbound destinations, known
tool names), so a plugin can take part without core knowing it exists.

**The system prompt must be the same every run.** Providers cache on a
strict prefix. Text that changes per turn goes in a message, not the
system prompt; text an extension adds to the system prompt is computed
once at register time.

**pi's edges are partly untyped.** Where spindle reaches into pi
(`session.sessionManager`, the follow-up queue), keep the cast narrow, say
why in a comment, and fail soft if the shape is not what was expected.

## Conventions

- Config is validated with TypeBox in `src/config/schema.ts`; add a key
  there and in `src/types.ts`. A channel's own block under `channels:` is
  checked by the channel, not the schema.
- A new channel is a `ChannelPlugin` (`src/channels/registry.ts`). Built-in
  ones are listed in `src/channels/builtin.ts`; anything else is a plugin
  (`docs/plugins.md`).
- Anything a plugin or outside extension may use is exported from
  `src/api.ts`. If it is not exported there, it is internal.
- Comments explain why the code is the way it is — usually the failure it
  prevents — not what it does. Keep that reasoning when you change the
  code, and update it when it stops being true.
- A bug fix comes with a test that fails without it.
