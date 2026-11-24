import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import spindleTelegramExtension from "../../src/extensions/spindle-telegram";
import {
  bindTelegramChannel,
  bindTelegramLoadContext,
  bindAutoSendTools,
  bindOutboundToolsEnabled,
  resetTelegramBinding,
} from "../../src/channels/telegram/binding";
import type { TelegramChannel } from "../../src/channels/telegram/channel";
import { bindProvenanceTracker } from "../../src/provenance/binding";
import { _resetChannelCapabilities, declareChannelCapabilities } from "../../src/channels/capabilities";

/**
 * Unit tests for the spindle-telegram pi extension. Exercises:
 *   - outbound_tools=false → no tool registration
 *   - daydream load context → no tool registration
 *   - missing binding → graceful no-op with warning
 *   - happy path registers three tools and subscribes tool_execution_end
 *   - auto-send forwards image results to channel.sendImage
 *   - auto-send routes audio results to channel.sendAudio with player metadata
 *   - auto-send honors suppress_auto_send on either args or result details
 *   - auto-send skips non-configured tool names and errored results
 *
 * Uses a minimal mock ExtensionAPI shaped to match the slice of the
 * interface the extension actually touches. We don't exercise pi's
 * actual runtime — just verify the extension registers what it should.
 */

interface RegisteredTool {
  name: string;
  execute: (
    toolCallId: string,
    params: any,
    signal: any,
    onUpdate: any,
    ctx: any
  ) => Promise<{ content: unknown; details: unknown }>;
}

interface MockPi {
  registerTool: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  tools: RegisteredTool[];
  listeners: Map<string, (event: unknown, ctx: unknown) => Promise<void>>;
}

function makePi(): MockPi {
  const tools: RegisteredTool[] = [];
  const listeners = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
  const registerTool = vi.fn((tool: RegisteredTool) => {
    tools.push(tool);
  });
  const on = vi.fn((event: string, handler: (e: unknown, ctx: unknown) => Promise<void>) => {
    listeners.set(event, handler);
  });
  return { registerTool, on, tools, listeners };
}

function fakeChannel(): {
  channel: TelegramChannel;
  sendText: ReturnType<typeof vi.fn>;
  sendImage: ReturnType<typeof vi.fn>;
  sendAudio: ReturnType<typeof vi.fn>;
  sendVoice: ReturnType<typeof vi.fn>;
} {
  const sendText = vi.fn(async () => {});
  const sendImage = vi.fn(async () => {});
  const sendAudio = vi.fn(async () => {});
  const sendVoice = vi.fn(async () => {});
  const channel = {
    sendText,
    sendImage,
    sendAudio,
    sendVoice,
  } as unknown as TelegramChannel;
  return { channel, sendText, sendImage, sendAudio, sendVoice };
}

describe("spindle-telegram extension", () => {
  beforeEach(() => {
    resetTelegramBinding();
  });
  afterEach(() => {
    resetTelegramBinding();
  });

  it("registers nothing when outbound_tools is disabled", () => {
    bindOutboundToolsEnabled(false);
    const { channel } = fakeChannel();
    bindTelegramChannel(channel);
    const pi = makePi();
    spindleTelegramExtension(pi as any);
    expect(pi.tools).toHaveLength(0);
    expect(pi.listeners.size).toBe(0);
  });

  it("registers nothing in a daydream load context", () => {
    bindTelegramLoadContext("daydream");
    const { channel } = fakeChannel();
    bindTelegramChannel(channel);
    const pi = makePi();
    spindleTelegramExtension(pi as any);
    expect(pi.tools).toHaveLength(0);
    expect(pi.listeners.size).toBe(0);
  });

  it("warns and degrades gracefully when the binding is unset", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pi = makePi();
    spindleTelegramExtension(pi as any);
    expect(pi.tools).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("without a bound TelegramChannel"));
    warn.mockRestore();
  });

  it("registers the four outbound send tools, and subscribes tool_execution events", () => {
    const { channel } = fakeChannel();
    bindTelegramChannel(channel);
    const pi = makePi();
    spindleTelegramExtension(pi as any);
    expect(pi.tools.map((t) => t.name)).toEqual([
      "telegram_send_message",
      "telegram_send_image",
      "telegram_send_audio",
      "telegram_send_voice",
    ]);
    expect(pi.listeners.has("tool_execution_start")).toBe(true);
    expect(pi.listeners.has("tool_execution_end")).toBe(true);
  });

  it("telegram_send_message tool routes to channel.sendText", async () => {
    const { channel, sendText } = fakeChannel();
    bindTelegramChannel(channel);
    const pi = makePi();
    spindleTelegramExtension(pi as any);
    const tool = pi.tools.find((t) => t.name === "telegram_send_message")!;
    const result = await tool.execute("c1", { message: "hi there" }, {}, () => {}, {});
    expect(sendText).toHaveBeenCalledWith("hi there");
    expect(result.details).toEqual({ sent: true });
  });

  it("telegram_send_message reports an error when the channel throws", async () => {
    const { channel, sendText } = fakeChannel();
    sendText.mockRejectedValueOnce(new Error("chat not yet locked in"));
    bindTelegramChannel(channel);
    const pi = makePi();
    spindleTelegramExtension(pi as any);
    const tool = pi.tools.find((t) => t.name === "telegram_send_message")!;
    const result = await tool.execute("c1", { message: "hi" }, {}, () => {}, {});
    expect((result.details as { error: string }).error).toMatch(/not yet locked in/);
  });

  it("telegram_send_image tool routes to channel.sendImage with caption", async () => {
    const { channel, sendImage } = fakeChannel();
    bindTelegramChannel(channel);
    const pi = makePi();
    spindleTelegramExtension(pi as any);
    const tool = pi.tools.find((t) => t.name === "telegram_send_image")!;
    await tool.execute(
      "c2",
      { path: "files/cat.png", caption: "a cat" },
      {},
      () => {},
      {}
    );
    expect(sendImage).toHaveBeenCalledWith("files/cat.png", "a cat");
  });

  /**
   * Helper: drive a complete tool_execution_start/end pair through the
   * extension's listeners. Matches pi's real event ordering.
   */
  async function fireToolCall(
    pi: MockPi,
    opts: {
      toolCallId?: string;
      toolName: string;
      isError?: boolean;
      args?: Record<string, unknown>;
      result: unknown;
    }
  ): Promise<void> {
    const start = pi.listeners.get("tool_execution_start")!;
    const end = pi.listeners.get("tool_execution_end")!;
    const id = opts.toolCallId ?? "t1";
    await start(
      {
        type: "tool_execution_start",
        toolCallId: id,
        toolName: opts.toolName,
        args: opts.args ?? {},
      },
      {}
    );
    await end(
      {
        type: "tool_execution_end",
        toolCallId: id,
        toolName: opts.toolName,
        isError: opts.isError ?? false,
        result: opts.result,
      },
      {}
    );
  }

  it("auto-send forwards imagine results to sendImage", async () => {
    const { channel, sendImage } = fakeChannel();
    bindTelegramChannel(channel);
    const pi = makePi();
    spindleTelegramExtension(pi as any);
    await fireToolCall(pi, {
      toolName: "imagine",
      args: { prompt: "a cat" },
      result: { details: { filename: "generated.png" } },
    });
    expect(sendImage).toHaveBeenCalledWith("generated.png", undefined);
  });

  it("telegram_send_audio tool routes to channel.sendAudio with player metadata", async () => {
    const { channel, sendAudio } = fakeChannel();
    bindTelegramChannel(channel);
    const pi = makePi();
    spindleTelegramExtension(pi as any);
    const tool = pi.tools.find((t) => t.name === "telegram_send_audio")!;
    const result = await tool.execute(
      "c1",
      {
        path: "files/song.mp3",
        caption: "wrote this about today",
        title: "Tuesday, Late",
        performer: "Casey",
        duration: 120,
      },
      {},
      () => {},
      {}
    );
    expect(sendAudio).toHaveBeenCalledWith("files/song.mp3", "wrote this about today", {
      title: "Tuesday, Late",
      performer: "Casey",
      duration: 120,
    });
    expect(result.details).toEqual({ sent: true, path: "files/song.mp3" });
  });

  it("telegram_send_audio reports an error when the channel throws", async () => {
    const { channel, sendAudio } = fakeChannel();
    sendAudio.mockRejectedValueOnce(new Error("outside filesDir"));
    bindTelegramChannel(channel);
    const pi = makePi();
    spindleTelegramExtension(pi as any);
    const tool = pi.tools.find((t) => t.name === "telegram_send_audio")!;
    const result = await tool.execute("c1", { path: "../../etc/passwd.mp3" }, {}, () => {}, {});
    expect(result.details).toEqual({ error: "outside filesDir" });
  });

  it("auto-send routes an audio result to sendAudio, not sendImage", async () => {
    const { channel, sendImage, sendAudio } = fakeChannel();
    bindTelegramChannel(channel);
    bindAutoSendTools(["imagine", "compose"]);
    const pi = makePi();
    spindleTelegramExtension(pi as any);
    await fireToolCall(pi, {
      toolName: "compose",
      args: { tags: "dream pop" },
      result: {
        details: {
          filename: "casey-song_00001_.mp3",
          caption: "about today",
          title: "Tuesday, Late",
          performer: "Casey",
          duration: 120,
        },
      },
    });
    expect(sendAudio).toHaveBeenCalledWith("casey-song_00001_.mp3", "about today", {
      title: "Tuesday, Late",
      performer: "Casey",
      duration: 120,
    });
    expect(sendImage).not.toHaveBeenCalled();
  });

  it("auto-send tolerates an audio result with no player metadata", async () => {
    const { channel, sendAudio } = fakeChannel();
    bindTelegramChannel(channel);
    bindAutoSendTools(["compose"]);
    const pi = makePi();
    spindleTelegramExtension(pi as any);
    await fireToolCall(pi, {
      toolName: "compose",
      result: { details: { filename: "song.wav" } },
    });
    expect(sendAudio).toHaveBeenCalledWith("song.wav", undefined, {
      title: undefined,
      performer: undefined,
      duration: undefined,
    });
  });

  it("telegram_send_voice tool routes to channel.sendVoice", async () => {
    const { channel, sendVoice } = fakeChannel();
    bindTelegramChannel(channel);
    const pi = makePi();
    spindleTelegramExtension(pi as any);
    const tool = pi.tools.find((t) => t.name === "telegram_send_voice")!;
    const res = await tool.execute("c1", {
      path: "files/say.ogg",
      caption: "thinking out loud",
      duration: 9,
    });
    expect(sendVoice).toHaveBeenCalledWith("files/say.ogg", "thinking out loud", {
      duration: 9,
    });
    expect((res as any).details.sent).toBe(true);
  });

  it("telegram_send_voice reports an error when the channel throws", async () => {
    const { channel, sendVoice } = fakeChannel();
    sendVoice.mockRejectedValueOnce(new Error("outside filesDir"));
    bindTelegramChannel(channel);
    const pi = makePi();
    spindleTelegramExtension(pi as any);
    const tool = pi.tools.find((t) => t.name === "telegram_send_voice")!;
    const res = await tool.execute("c1", { path: "../escape.ogg" });
    expect((res as any).details.error).toContain("outside filesDir");
  });

  it("auto-send routes a voice_note result to sendVoice, not sendAudio", async () => {
    const { channel, sendAudio, sendVoice } = fakeChannel();
    bindTelegramChannel(channel);
    bindAutoSendTools(["speak"]);
    const pi = makePi();
    spindleTelegramExtension(pi as any);
    await fireToolCall(pi, {
      toolName: "speak",
      result: {
        details: {
          filename: "say_0001.ogg",
          caption: "about today",
          duration: 9,
          voice_note: true,
        },
      },
    });
    expect(sendVoice).toHaveBeenCalledWith("say_0001.ogg", "about today", {
      duration: 9,
    });
    expect(sendAudio).not.toHaveBeenCalled();
  });

  // The flag, not the extension, is what separates speech from music: an
  // .ogg song must keep its player metadata rather than becoming a bubble.
  it("auto-send leaves an ogg without voice_note on sendAudio", async () => {
    const { channel, sendAudio, sendVoice } = fakeChannel();
    bindTelegramChannel(channel);
    bindAutoSendTools(["compose"]);
    const pi = makePi();
    spindleTelegramExtension(pi as any);
    await fireToolCall(pi, {
      toolName: "compose",
      result: {
        details: { filename: "song.ogg", performer: "Casey", duration: 120 },
      },
    });
    expect(sendAudio).toHaveBeenCalled();
    expect(sendVoice).not.toHaveBeenCalled();
  });

  // voice_note is a rendering hint, not a bypass: a non-audio file must
  // still fall through to sendImage rather than reach the voice endpoint.
  it("auto-send ignores voice_note on a non-audio file", async () => {
    const { channel, sendImage, sendVoice } = fakeChannel();
    bindTelegramChannel(channel);
    bindAutoSendTools(["speak"]);
    const pi = makePi();
    spindleTelegramExtension(pi as any);
    await fireToolCall(pi, {
      toolName: "speak",
      result: { details: { filename: "chart.png", voice_note: true } },
    });
    expect(sendVoice).not.toHaveBeenCalled();
    expect(sendImage).toHaveBeenCalledWith("chart.png", undefined);
  });

  it("auto-send honors suppress_auto_send for a voice note", async () => {
    const { channel, sendVoice } = fakeChannel();
    bindTelegramChannel(channel);
    bindAutoSendTools(["speak"]);
    const pi = makePi();
    spindleTelegramExtension(pi as any);
    await fireToolCall(pi, {
      toolName: "speak",
      result: {
        details: {
          filename: "say.ogg",
          voice_note: true,
          suppress_auto_send: true,
        },
      },
    });
    expect(sendVoice).not.toHaveBeenCalled();
  });

  it("auto-send honors suppress_auto_send for compose too", async () => {
    const { channel, sendAudio } = fakeChannel();
    bindTelegramChannel(channel);
    bindAutoSendTools(["compose"]);
    const pi = makePi();
    spindleTelegramExtension(pi as any);
    await fireToolCall(pi, {
      toolName: "compose",
      args: { suppress_auto_send: true },
      result: { details: { filename: "song.mp3" } },
    });
    expect(sendAudio).not.toHaveBeenCalled();
  });

  it("auto-send picks up caption when result.details.caption is set", async () => {
    const { channel, sendImage } = fakeChannel();
    bindTelegramChannel(channel);
    const pi = makePi();
    spindleTelegramExtension(pi as any);
    await fireToolCall(pi, {
      toolName: "imagine",
      result: { details: { filename: "g.png", caption: "captioned" } },
    });
    expect(sendImage).toHaveBeenCalledWith("g.png", "captioned");
  });

  it("auto-send respects suppress_auto_send on args (cached from tool_execution_start)", async () => {
    const { channel, sendImage } = fakeChannel();
    bindTelegramChannel(channel);
    const pi = makePi();
    spindleTelegramExtension(pi as any);
    await fireToolCall(pi, {
      toolName: "image_edit",
      args: { suppress_auto_send: true },
      result: { details: { filename: "edited.png" } },
    });
    expect(sendImage).not.toHaveBeenCalled();
  });

  it("auto-send respects suppress_auto_send on result details", async () => {
    const { channel, sendImage } = fakeChannel();
    bindTelegramChannel(channel);
    const pi = makePi();
    spindleTelegramExtension(pi as any);
    await fireToolCall(pi, {
      toolName: "image_combine",
      result: { details: { filename: "c.png", suppress_auto_send: true } },
    });
    expect(sendImage).not.toHaveBeenCalled();
  });

  it("auto-send skips non-configured tool names", async () => {
    const { channel, sendImage } = fakeChannel();
    bindTelegramChannel(channel);
    const pi = makePi();
    spindleTelegramExtension(pi as any);
    await fireToolCall(pi, {
      toolName: "unrelated_tool",
      result: { details: { filename: "x.png" } },
    });
    expect(sendImage).not.toHaveBeenCalled();
  });

  it("auto-send skips errored tool results", async () => {
    const { channel, sendImage } = fakeChannel();
    bindTelegramChannel(channel);
    const pi = makePi();
    spindleTelegramExtension(pi as any);
    await fireToolCall(pi, {
      toolName: "imagine",
      isError: true,
      result: { details: { filename: "x.png" } },
    });
    expect(sendImage).not.toHaveBeenCalled();
  });

  it("auto-send honors an agent-configured auto_send_tools list", async () => {
    bindAutoSendTools(["custom_image_tool"]);
    const { channel, sendImage } = fakeChannel();
    bindTelegramChannel(channel);
    const pi = makePi();
    spindleTelegramExtension(pi as any);
    // imagine is no longer in the list
    await fireToolCall(pi, {
      toolCallId: "t1",
      toolName: "imagine",
      result: { details: { filename: "x.png" } },
    });
    expect(sendImage).not.toHaveBeenCalled();
    // custom_image_tool IS
    await fireToolCall(pi, {
      toolCallId: "t2",
      toolName: "custom_image_tool",
      result: { details: { filename: "y.png" } },
    });
    expect(sendImage).toHaveBeenCalledWith("y.png", undefined);
  });

  it("auto-send accepts result.details.path when filename is missing", async () => {
    const { channel, sendImage } = fakeChannel();
    bindTelegramChannel(channel);
    const pi = makePi();
    spindleTelegramExtension(pi as any);
    await fireToolCall(pi, {
      toolName: "imagine",
      result: { details: { path: "/abs/img.png" } },
    });
    expect(sendImage).toHaveBeenCalledWith("/abs/img.png", undefined);
  });

  it("auto-send drops results that have neither filename nor path", async () => {
    const { channel, sendImage } = fakeChannel();
    bindTelegramChannel(channel);
    const pi = makePi();
    spindleTelegramExtension(pi as any);
    await fireToolCall(pi, {
      toolName: "imagine",
      result: { details: {} },
    });
    expect(sendImage).not.toHaveBeenCalled();
  });

  it("pending args are cleared after each tool execution (no leak across calls)", async () => {
    const { channel, sendImage } = fakeChannel();
    bindTelegramChannel(channel);
    const pi = makePi();
    spindleTelegramExtension(pi as any);
    // Call 1: suppress_auto_send
    await fireToolCall(pi, {
      toolCallId: "a",
      toolName: "imagine",
      args: { suppress_auto_send: true },
      result: { details: { filename: "a.png" } },
    });
    expect(sendImage).not.toHaveBeenCalled();
    // Call 2: same toolCallId reused (shouldn't happen in practice, but
    // if it did, the old args must already be cleared)
    await fireToolCall(pi, {
      toolCallId: "a",
      toolName: "imagine",
      args: {},
      result: { details: { filename: "b.png" } },
    });
    expect(sendImage).toHaveBeenCalledWith("b.png", undefined);
  });

  describe("a run opened from a channel that is answered in place", () => {
    const WORKSPACE = {
      answersInPlace: {
        guideline: "A message starting with [desk] is read at the desk; answer it in your reply.",
        refusal: "Not sent: they are reading your reply at the desk. Put it in your plain text reply instead.",
      },
    };
    const setup = () => {
      const { channel } = fakeChannel();
      bindTelegramChannel(channel);
      const pi = makePi();
      spindleTelegramExtension(pi as any);
      return pi;
    };
    const fire = async (channelName: string | null, toolName = "telegram_send_message") => {
      bindProvenanceTracker({
        currentRun: () => (channelName === null ? null : { owner: { channel: channelName, actor: { kind: "human", id: "someone" } } }),
      } as any);
      const handler = setup().listeners.get("tool_call")!;
      return (await handler({ type: "tool_call", toolCallId: "c1", toolName, input: { message: "hi" } }, {})) as unknown;
    };
    beforeEach(() => declareChannelCapabilities("desk", WORKSPACE));
    afterEach(() => {
      bindProvenanceTracker(null as any);
      _resetChannelCapabilities();
    });

    it("refuses telegram_send_message in a run that channel opened, with the channel's own reason", async () => {
      expect(await fire("desk")).toEqual({ block: true, reason: WORKSPACE.answersInPlace.refusal });
    });
    it("allows it in a Telegram run, a scheduled run, a run from an undeclared channel, or with no run", async () => {
      expect(await fire("telegram")).toBeUndefined();
      expect(await fire("extension")).toBeUndefined();
      expect(await fire("elsewhere")).toBeUndefined();
      expect(await fire(null)).toBeUndefined();
    });
    it("leaves the other send tools alone", async () => {
      expect(await fire("desk", "telegram_send_image")).toBeUndefined();
    });
    it("puts each such channel's guideline on telegram_send_message, and none when there is no such channel", () => {
      const guidelines = (pi: ReturnType<typeof makePi>) =>
        (pi.tools.find((t) => t.name === "telegram_send_message") as unknown as { promptGuidelines?: string[] }).promptGuidelines;
      expect(guidelines(setup())).toEqual([WORKSPACE.answersInPlace.guideline]);
      declareChannelCapabilities("audio-only", { liveAudio: true });
      expect(guidelines(setup())).toEqual([WORKSPACE.answersInPlace.guideline]);
      _resetChannelCapabilities();
      expect(guidelines(setup())).toEqual([]);
    });
  });
});
