# Plugins

A plugin adds a channel to a spindle process from outside this repository.
The channels that ship with spindle are built the same way
(`src/channels/builtin.ts`), so that file is the reference example.

## Turning one on

```yaml
# agent.yaml
plugins:
  - module: ../my-plugin/plugin.ts   # ./ or ../ is relative to the agent directory
  - module: /abs/path/plugin.ts      # absolute paths work
  - module: some-package/plugin      # anything else goes to the module resolver

channels:
  mychannel:                         # the plugin's key; its presence turns the channel on
    whatever: the channel wants
```

Naming a plugin loads it. A channel it provides only runs when its key is
present under `channels:`. Spindle does not validate what is under that
key — the channel does.

## Writing one

```ts
import type { ChannelPlugin, SpindlePlugin } from "spindle/api";

// The default export is a plugin object, or a function that receives the
// public API and returns one. Taking the API as an argument means the
// plugin needs no import path to spindle at run time; `import type`
// disappears when the file is loaded.
export default function plugin(api: typeof import("spindle/api")): SpindlePlugin {
  const channel: ChannelPlugin = {
    key: "mychannel",
    label: "My",                       // "My channel started" in the log
    order: 500,                        // start order; built-ins use 100–400
    create(channelConfig, host) {
      return new MyChannel(channelConfig, host, api);
    },
    extensionPaths: () => ["/abs/path/to/a/pi-extension"],
  };
  return { name: "my-plugin", channels: [channel] };
}
```

### When things happen

| Moment | What runs | What exists |
|---|---|---|
| Before the pi session | `plugin(api)`, then `create()` for each configured channel | Config, agent directory. **No session.** `host.sessionDeps()` throws. |
| Session creation | pi loads every extension, including the ones from `extensionPaths()` | The channel object, so an extension can find it at register time |
| After the session | `channel.start(session, config, getSlashCommands)`, in `order` | Everything. `host.channels()` lists the channels started so far. |
| Shutdown | `beforeShutdown()` on every channel, then `stop()` on every channel | — |

A channel is constructed before the session exists because pi loads
extensions while it builds the session, and a channel's extension normally
looks for its channel right then to decide which tools to register.

A `create()` that throws stops the boot. A `start()` that throws is
logged, the plugin's `onStartFailure` is called, and the agent carries on
without that channel.

### Helper sessions

Daydream, scheduler runs and one-off sessions are built from the main
session's extension list, so every extension's `register()` runs again
inside them. An extension that owns something there can only be one of —
a channel's inbound handler, a prompt splice — checks first:

```ts
if (!api.isMainSession()) return;      // or api.getSessionKind()
```

### Reaching the API from a pi extension

A pi extension is loaded by pi and handed only pi's own object. It can
`import ... from "spindle/api"` where spindle is installed or linked;
otherwise the same object is at
`globalThis[Symbol.for("@spindle/api")]` once spindle has booted.

`src/api.ts` is the whole public surface. Anything not exported there is
internal.
