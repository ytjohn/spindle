import { describe, it, expect } from "vitest";
import { parseLine } from "../../../src/channels/stub/channel";

describe("stub channel line protocol", () => {
  it("defaults to followUp", () => {
    expect(parseLine("hello there")).toEqual({ mode: "followUp", text: "hello there" });
  });
  it("parses explicit modes case-insensitively", () => {
    expect(parseLine("steer: stop")).toEqual({ mode: "steer", text: "stop" });
    expect(parseLine("FollowUp: later")).toEqual({ mode: "followUp", text: "later" });
    expect(parseLine("prompt: now")).toEqual({ mode: "prompt", text: "now" });
  });
  it("ignores blank lines and empty bodies", () => {
    expect(parseLine("   ")).toBeNull();
    expect(parseLine("steer:   ")).toBeNull();
  });
  it("passes slash commands through as text", () => {
    expect(parseLine("/status")).toEqual({ mode: "followUp", text: "/status" });
  });
});
