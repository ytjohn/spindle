import { beforeEach, describe, expect, it } from "vitest";
import { registerKnownToolNames as registerNames } from "./fake-tool-calls";

// The names below are example extension tools, as an extension would
// register them. Spindle's built-in list holds only its own tools.
beforeEach(() => {
  registerNames([
    "mud_look", "mud_move", "mud_say", "mud_emote", "mud_cmd", "mud_recall", "mud_note", "mud_wait",
    "imagine", "image_edit", "image_combine", "list_images",
    "recall", "note", "note_list", "phone_text",
  ]);
});
import {
  containsFakeToolCall,
  maskFakeToolCalls,
  parseFakeToolCalls,
  primaryArg,
} from "./fake-tool-calls";

// The exact text an agent once emitted, which was relayed to the user
// over Telegram as a raw prompt string.
const REAL_LEAK =
  '\n\nimagine(prompt="Night patrol in the old city, dark rainy streets with neon ' +
  'signs reflecting in puddles, elevated train tracks overhead, gargoyles on ' +
  'buildings, lone figure in leather jacket scanning the rooftops with cybernetic ' +
  'neck glowing faint blue, atmospheric cinematic shot, moody lighting, cityscape ' +
  'with art deco architecture")';

describe("detection", () => {
  it("detects the real imagine leak", () => {
    expect(containsFakeToolCall(REAL_LEAK)).toBe(true);
  });

  it("detects positional mud_* calls", () => {
    expect(containsFakeToolCall('mud_move("south")')).toBe(true);
    expect(containsFakeToolCall("mud_look()")).toBe(true);
  });

  it("is not stateful across calls", () => {
    // A shared /g regex would advance lastIndex and miss the second call.
    const t = 'mud_move("south")';
    expect(containsFakeToolCall(t)).toBe(true);
    expect(containsFakeToolCall(t)).toBe(true);
  });

  it("does not fire on ordinary prose with parentheses", () => {
    expect(containsFakeToolCall("I checked the alley (twice) and found nothing.")).toBe(false);
    expect(containsFakeToolCall('"It is the city(ish) weather," she said.')).toBe(false);
  });
});

describe("masking", () => {
  it("leaves nothing of the leaked prompt behind", () => {
    const masked = maskFakeToolCalls(REAL_LEAK);
    expect(masked.trim()).toBe("");
    expect(masked).not.toContain("Night patrol");
    expect(masked).not.toContain("prompt=");
  });

  it("preserves length so offsets stay valid", () => {
    const t = 'before mud_move("south") after';
    expect(maskFakeToolCalls(t)).toHaveLength(t.length);
  });

  it("keeps real speech that surrounds a call", () => {
    const t = '"Heading out." mud_move("south")';
    expect(maskFakeToolCalls(t).trim()).toBe('"Heading out."');
  });

  it("masks parens nested inside a quoted argument", () => {
    const t = 'imagine(prompt="a lit sign (closed) in rain") done';
    const masked = maskFakeToolCalls(t);
    expect(masked).not.toContain("closed");
    expect(masked).not.toContain('")');
    expect(masked.trim()).toBe("done");
  });

  it("truncates an unterminated call — the token-cliff signature", () => {
    const t = 'Sure. imagine(prompt="Night patrol in the old city';
    expect(maskFakeToolCalls(t).trim()).toBe("Sure.");
  });

  it("masks every call when several appear", () => {
    const t = 'mud_emote("nods") then mud_move("out")';
    expect(maskFakeToolCalls(t).trim()).toBe("then");
  });

  it("swallows bracket wrappers around a call", () => {
    const t = 'Nothing I can\'t handle. [mud_emote("shrugs")]';
    expect(maskFakeToolCalls(t).trim()).toBe("Nothing I can't handle.");
    expect(maskFakeToolCalls(t)).toHaveLength(t.length);
  });

  it("swallows backtick wrappers around a call", () => {
    const t = 'Sure. `mud_cmd("navigate casey\'s workshop")` done';
    expect(maskFakeToolCalls(t).replace(/\s+/g, " ").trim()).toBe("Sure. done");
    expect(maskFakeToolCalls(t)).not.toContain("`");
  });

  it("trims a dangling opening bracket before a truncated call", () => {
    const t = 'Nothing I can\'t handle. [mud_emote("watches the';
    expect(maskFakeToolCalls(t)).toBe("Nothing I can't handle.");
  });
});

describe("parsing", () => {
  it("parses the named-kwarg form used by imagine", () => {
    const [call] = parseFakeToolCalls(REAL_LEAK);
    expect(call!.name).toBe("imagine");
    expect(call!.named.prompt).toContain("Night patrol in the old city");
    expect(call!.named.prompt).toContain("art deco architecture");
    expect(call!.positional).toEqual([]);
  });

  it("parses the positional form used by mud_*", () => {
    const [call] = parseFakeToolCalls('mud_move("south")');
    expect(call!.name).toBe("mud_move");
    expect(call!.positional).toEqual(["south"]);
  });

  it("parses mixed positional and named arguments", () => {
    const [call] = parseFakeToolCalls('imagine(prompt="a cat", width=1024, steps=20)');
    expect(call!.named).toEqual({ prompt: "a cat", width: "1024", steps: "20" });
  });

  it("accepts colon-style named arguments", () => {
    const [call] = parseFakeToolCalls('imagine(prompt: "a cat")');
    expect(call!.named.prompt).toBe("a cat");
  });

  it("does not split a quoted argument on its internal comma", () => {
    const [call] = parseFakeToolCalls('mud_say("wait, no")');
    expect(call!.positional).toEqual(["wait, no"]);
  });

  it("keeps '=' inside a positional MUD command", () => {
    // `page someone = hi` must stay one positional arg, not become named.
    const [call] = parseFakeToolCalls('mud_cmd("page someone = hi")');
    expect(call!.positional).toEqual(["page someone = hi"]);
    expect(call!.named).toEqual({});
  });

  it("returns calls in written order", () => {
    const calls = parseFakeToolCalls('mud_say("bye") and mud_move("out")');
    expect(calls.map((c) => c.name)).toEqual(["mud_say", "mud_move"]);
  });

  it("parses a zero-arg call", () => {
    const [call] = parseFakeToolCalls("mud_look()");
    expect(call!.name).toBe("mud_look");
    expect(call!.positional).toEqual([]);
  });
});

describe("primaryArg", () => {
  it("prefers a named key when present", () => {
    const [call] = parseFakeToolCalls('imagine(prompt="a cat")');
    expect(primaryArg(call!, "prompt")).toBe("a cat");
  });

  it("falls back to the first positional", () => {
    const [call] = parseFakeToolCalls('imagine("a cat")');
    expect(primaryArg(call!, "prompt")).toBe("a cat");
  });

  it("returns empty string when there is no argument", () => {
    const [call] = parseFakeToolCalls("mud_look()");
    expect(primaryArg(call!, "x")).toBe("");
  });
});

describe("coverage of the in-scope tool set", () => {
  // Every tool reachable on an agent's telegram path (agent.yaml
  // extra_mud_tools + an image extension) must be maskable, or a
  // faked call to it leaks to the user as prose.
  const IN_SCOPE = [
    'imagine(prompt="x")',
    'image_edit(path="a.png", prompt="x")',
    'image_combine(image1="a.png", image2="b.png", prompt="x")',
    "list_images()",
    'telegram_send_image(path="a.png", caption="hi")',
    'telegram_send_message(message="hi")',
    "mud_look()",
    'mud_recall(character="someone")',
  ];

  for (const call of IN_SCOPE) {
    it(`masks ${call.slice(0, call.indexOf("("))}`, () => {
      expect(containsFakeToolCall(call)).toBe(true);
      expect(maskFakeToolCalls(call).trim()).toBe("");
    });
  }

  it("does not let image_combine be shadowed by a shorter name", () => {
    const [call] = parseFakeToolCalls('image_combine(image1="a.png", prompt="x")');
    expect(call!.name).toBe("image_combine");
    expect(call!.named.image1).toBe("a.png");
  });

  it("extracts a caption for a faked telegram_send_image", () => {
    const [call] = parseFakeToolCalls('telegram_send_image(path="f.png", caption="on patrol")');
    expect(primaryArg(call!, "path")).toBe("f.png");
    expect(call!.named.caption).toBe("on patrol");
  });
});

// ─── Leak fixtures (verbatim from an agent's session) ───
import { hasCallShapedContent } from "./fake-tool-calls";

describe("malformed-close spans (missing paren, bracket-closed)", () => {
  const emote = `[mud_emote("glances at phone, smirks at the message"]`;

  it("hasCallShapedContent catches the malformed emote (relay gate)", () => {
    expect(containsFakeToolCall(emote)).toBe(false); // why the old gate leaked
    expect(hasCallShapedContent(emote)).toBe(true);
  });

  it("masking removes the malformed span entirely", () => {
    const masked = maskFakeToolCalls(emote).trim();
    expect(/\w/.test(masked)).toBe(false);
  });

  it("prose around a malformed span survives", () => {
    const masked = maskFakeToolCalls(
      `sounds good. [mud_emote("smirks at the phone"] anyway, how was the drive?`,
    );
    expect(masked).toContain("sounds good.");
    expect(masked).toContain("how was the drive?");
    expect(masked).not.toContain("mud_emote");
  });
});

describe("qwen XML tool-call artifacts", () => {
  const leaked = `[mud_say("Let me check the Gazette") </parameter> </function> </tool_call>`;
  const bare = `[ </parameter> </function> </tool_call>`;

  it("gate catches XML fragments", () => {
    expect(hasCallShapedContent(leaked)).toBe(true);
    expect(hasCallShapedContent(bare)).toBe(true);
  });

  it("masking removes call + all XML tags", () => {
    const masked = maskFakeToolCalls(leaked);
    expect(masked).not.toContain("mud_say");
    expect(masked).not.toContain("tool_call");
    expect(masked).not.toContain("parameter");
    expect(/\w/.test(masked)).toBe(false);
  });

  it("bare XML fragment masks to nothing", () => {
    expect(/\w/.test(maskFakeToolCalls(bare))).toBe(false);
  });

  it("prose mentioning tags in backticks is untouched", () => {
    const t = "the parser emits `tool_call` wrappers sometimes";
    expect(hasCallShapedContent(t)).toBe(false);
    expect(maskFakeToolCalls(t)).toBe(t);
  });
});

describe("malformed-close spans parse for rescue", () => {
  it("recovers the emote argument", () => {
    const calls = parseFakeToolCalls(`[mud_emote("watches him head back to the lobby, gives a small nod"]`);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("mud_emote");
    expect(calls[0]!.positional[0]).toBe("watches him head back to the lobby, gives a small nod");
  });

  it("does not double-parse a well-formed bracketed call", () => {
    const calls = parseFakeToolCalls(`[mud_emote("nods")]`);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.positional[0]).toBe("nods");
  });
});

describe("mud_wait written as text", () => {
  it("parses with and without arguments", () => {
    const [a] = parseFakeToolCalls('[mud_wait(for="20m", reason="a visitor")]');
    expect(a.name).toBe("mud_wait");
    expect(a.named.for).toBe("20m");
    expect(a.named.reason).toBe("a visitor");
    const [b] = parseFakeToolCalls("mud_wait()");
    expect(b?.name).toBe("mud_wait");
  });
  it("is masked, so it is never spoken", () => {
    expect(containsFakeToolCall('mud_wait(for="1h")')).toBe(true);
  });
});

import {
  _resetKnownToolNames,
  isRelayToolName,
  knownToolNames,
  registerKnownToolNames,
  registerRelayToolNames,
  KNOWN_TOOL_NAMES as BASE_NAMES,
  fakeToolCallRegex as fakeRe,
} from "./fake-tool-calls";

describe("tool names registered by extensions", () => {
  it("spindle's own list holds only spindle's tools", () => {
    expect([...BASE_NAMES].sort()).toEqual(
      ["spindle_memory_recall", "spindle_memory_store", "telegram_send_image", "telegram_send_message"],
    );
  });

  it("a relay tool is also a known tool, and only what was registered as one is a relay", () => {
    _resetKnownToolNames();
    expect(isRelayToolName("text_owner")).toBe(false);
    registerRelayToolNames(["text_owner"]);
    expect(isRelayToolName("text_owner")).toBe(true);
    expect(isRelayToolName("telegram_send_message")).toBe(false);
    expect(knownToolNames()).toContain("text_owner");
    _resetKnownToolNames();
    expect(isRelayToolName("text_owner")).toBe(false);
  });

  it("are masked like the built-in ones, from the moment they are registered", () => {
    _resetKnownToolNames();
    expect(knownToolNames()).toBe(BASE_NAMES);
    expect(fakeRe().test('garden_water(plot="north")')).toBe(false);

    registerKnownToolNames(["garden_water", "mud_look", "not a name", "x)|(.*"]);
    expect(knownToolNames()).toContain("garden_water");
    expect(knownToolNames().filter((n) => n === "mud_look")).toHaveLength(1);
    // Only identifier-shaped names: these go into a regex.
    expect(knownToolNames()).not.toContain("not a name");
    expect(knownToolNames()).not.toContain("x)|(.*");
    expect(fakeRe().test('garden_water(plot="north")')).toBe(true);

    _resetKnownToolNames();
    expect(fakeRe().test('garden_water(plot="north")')).toBe(false);
  });
});
