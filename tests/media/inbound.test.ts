import { describe, expect, it } from "vitest";
import { voiceSentinel, voiceSentinelUntranscribed } from "../../src/media/inbound";

describe("voice sentinels", () => {
  it("is the line Telegram voice notes have always produced — clients parse it verbatim", () => {
    expect(voiceSentinel({ filename: "tg-41-AgADxyz.ogg", durationS: 13.6, model: "asr-small", transcript: "call the vet" })).toBe(
      "[User sent a voice note: 14s, files/tg-41-AgADxyz.ogg — transcribed by asr-small, treat proper nouns as approximate and ask rather than act on a name that looks wrong]\ncall the vet",
    );
    // No duration reported: the clause is left out, not written as 0s.
    expect(voiceSentinel({ filename: "a.ogg", durationS: null, model: "m", transcript: "x" })).toMatch(/^\[User sent a voice note: files\/a\.ogg — transcribed by m,/);
    expect(voiceSentinel({ filename: "a.ogg", durationS: 0, model: "m", transcript: "x" })).toMatch(/^\[User sent a voice note: files\/a\.ogg — /);
  });

  it("an untranscribed note is one line, with no transcript and no model to trust", () => {
    const line = voiceSentinelUntranscribed({ filename: "up-md_0123456789ab.webm", durationS: 3 });
    expect(line).toMatch(/^\[User sent a voice note: 3s, files\/up-md_0123456789ab\.webm — not transcribed: .*\]$/);
    expect(line).not.toContain("\n");
    expect(line).not.toContain("transcribed by");
    // The tail must not contain "]": a client's line pattern ends at the first one.
    expect(line.slice(1, -1)).not.toContain("]");
  });
});
