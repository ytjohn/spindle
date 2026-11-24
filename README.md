# Spindle

A runtime that turns a [pi](https://github.com/earendil-works/pi) coding
agent into a long-lived service: something you message, that remembers,
that wakes itself on a schedule, and that you can extend from outside.

Spindle does not implement an agent loop — pi does. Spindle is the part
around it: it reads an agent directory, builds one pi session from it,
attaches channels and background work to that session, and keeps it
running.

> Sessions are threads, memories are the fibres. The spindle is what
> winds them together.

## What it adds to pi

| | |
|---|---|
| **Channels** | Telegram out of the box (text, photos, voice notes, slash commands). A channel is a plugin; you can add your own. |
| **Memory** | A SQLite store with full-text recall, optional embeddings, decay-aware scoring and association between memories — exposed to the agent as tools. |
| **Daydream** | A background loop that reads recent conversation and files what is worth keeping into memory, without the agent having to decide to. |
| **Scheduler** | Cron entries that run a slash command in a throwaway session. |
| **Inbox** | Addressed mail between agents and the operator, as markdown files on disk. |
| **Compaction** | Compacts the context on your terms, with your instructions, before pi's own safety net fires. |
| **Provenance** | Every message records who sent it and through which channel, so a run has an owner and tools can act on that. |
| **Web** | An HTTP API and a small built-in UI over sessions, memories and mail, behind a bearer token. |
| **Speech** | Optional: transcribes inbound voice notes and gives the agent a `speak` tool, against servers you run. |
| **Telemetry** | Per-turn latency, tokens and context use in SQLite; a state file external monitors can read. |

Everything except the pi session itself is off until `agent.yaml` turns
it on.

## Requirements

- [Bun](https://bun.sh) 1.3 or later. Spindle runs TypeScript directly; there is no build step.
- A model pi can use. Spindle uses pi's own configuration: a provider pi
  already knows, or one you define in `~/.pi/agent/models.json`.

## Quick start

```bash
git clone <this repository> spindle && cd spindle
bun install
bun run start -- examples/eliza
```

That starts the smallest agent with a prompt on stdin. `examples/` has one
agent per feature:

| Example | Shows |
|---|---|
| `eliza` | The minimum: an id and a personality. Telegram is there, commented out. |
| `eliza-memory` | Memory tools, scoring, association, daydream. |
| `eliza-inbox`, `eliza-alice` | Two agents that write to each other's inbox. |
| `eliza-web` | The web API, the UI, and an extension that adds its own routes. |

## An agent is a directory

```
my-agent/
├── agent.yaml     # what to turn on
├── AGENTS.md      # who the agent is (pi reads this)
└── .pi/           # sessions, extensions, schedule — created as needed
```

```yaml
# agent.yaml
agent:
  id: my-agent            # required; scopes memory and mail
  name: My Agent

pi:
  provider: my-provider   # omit both to use pi's default model
  model: my-model
  thinking_level: off
  tools: [read]           # which of pi's built-in tools to start with; [] for none.
                          # Omit for pi's default (read, bash, edit, write).
                          # Tools from extensions are not affected.
  load_extensions:        # pi extensions, relative to this directory
    - .pi/extensions

channels:
  telegram:
    bot_token: ${TELEGRAM_BOT_TOKEN}
    allowed_users: ["12345678"]

memory:
  enabled: true
```

`src/config/schema.ts` is the full reference for `agent.yaml`; every key
is documented there.

## Running it

```bash
spindle run <agent-dir>                      # start
spindle run -c <agent-dir>                   # continue the most recent session
spindle run --resume <file.jsonl> <agent-dir>
spindle run --new <agent-dir>                # ignore any resume setting
```

(`bun run start -- <args>` from a checkout is the same thing.)

For a service, set `spindle.repl: false` in `agent.yaml` and run it under
your process supervisor. Spindle shuts down cleanly on SIGTERM.

## Extending it

There are three ways in, for three different jobs:

- **pi extensions** (`pi.load_extensions`) add tools, slash commands and
  event hooks to the agent. This is pi's own mechanism, unchanged.
- **Plugins** (`plugins:`) add a channel — a new way for messages to reach
  the agent. See [docs/plugins.md](docs/plugins.md).
- **Spindle extensions** (`extensions:`) run once at boot with access to
  the memory engine, the inbox and the web server; `examples/eliza-web`
  uses one to add HTTP routes.

`src/api.ts` is the public surface for plugins and extensions. Anything
not exported there is internal.

## Development

```bash
bun install
bun run test         # vitest
bun run typecheck    # tsc --noEmit
```

Tests run under vitest (`bun --bun run vitest run <file>` for one file).

`bun install` applies one patch to a dependency (`patches/`): it adds a
streaming error message to the list pi retries on. The patch file says
what and why.

Two things about the code are worth knowing before changing it:

- **Boot order is deliberate.** Things an extension reads when it loads —
  the memory engine, the channels — must exist before the pi session is
  created, because pi loads extensions while it builds the session.
- **Shared state lives on `globalThis`.** pi loads extensions through its
  own module loader, and loads them again for every helper session, so a
  module-level variable is not shared with them. State an extension reads
  is kept in a slot keyed by `Symbol.for("@spindle/…")`.

## License

MIT. See [LICENSE](LICENSE).
