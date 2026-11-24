/**
 * What a channel tells the rest of the process about itself.
 *
 * Some behaviour in one extension depends on which channel opened the
 * current run: a reply to someone reading the session in a workspace
 * should not also be texted to their phone; speech can be streamed when
 * someone is listening live. The extension does not need to know which
 * channel that is — only that the run's channel declared the trait.
 *
 * A channel declares its capabilities when it is constructed, which is
 * before the pi session exists, so extensions can read them at register
 * time and bake any prompt text in once (a prompt that changes between
 * runs defeats prefix caching).
 *
 * Process-wide via Symbol.for: extensions load in pi's own module graph.
 */

export interface ChannelCapabilities {
  /**
   * The person on this channel reads the agent's reply where they wrote.
   * Tools that would send the same reply somewhere else refuse during a
   * run this channel opened.
   */
  answersInPlace?: {
    /** One guideline for tools that send elsewhere: what a message from this channel is and how to answer it. */
    guideline?: string;
    /** The tool result when such a send is refused. */
    refusal: string;
  };
  /** Someone on this channel can hear speech while it is being generated. */
  liveAudio?: boolean;
}

const KEY = Symbol.for("@spindle/channel-capabilities");

function slot(): Map<string, ChannelCapabilities> {
  const g = globalThis as unknown as { [KEY]?: Map<string, ChannelCapabilities> };
  return (g[KEY] ??= new Map());
}

/** Declare (or replace) what the channel named `channel` can do. */
export function declareChannelCapabilities(channel: string, capabilities: ChannelCapabilities): void {
  slot().set(channel, capabilities);
}

export function channelCapabilities(channel: string | undefined | null): ChannelCapabilities | undefined {
  return channel ? slot().get(channel) : undefined;
}

/** Every declared channel, in the order declared. */
export function declaredChannels(): Array<[string, ChannelCapabilities]> {
  return [...slot().entries()];
}

/** Test-only. */
export function _resetChannelCapabilities(): void {
  slot().clear();
}
