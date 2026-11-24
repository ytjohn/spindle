import { describe, it, expect, vi, afterEach } from "vitest";
import { sendUserMessageFrom } from "../../src/provenance/extension";
import { bindProvenanceTracker } from "../../src/provenance/binding";
import type { Origin } from "../../src/provenance/types";

const origin: Origin = {
  channel: "mud",
  actor: { kind: "system", id: "room" },
  at: "2026-09-25T14:09:40.000Z",
};
const COMPACTING = new Error(
  "Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.",
);

describe("sendUserMessageFrom during compaction", () => {
  afterEach(() => {
    vi.useRealTimers();
    bindProvenanceTracker(null);
  });

  // A channel message arrived while /compact ran; pi's prompt()
  // threw, the fire-and-forget caller left the rejection unhandled, and bun
  // exited — the agent restarted and the compaction was lost.
  it("waits for compaction to finish and delivers, instead of rejecting", async () => {
    vi.useFakeTimers();
    const sendUserMessage = vi
      .fn()
      .mockRejectedValueOnce(COMPACTING)
      .mockRejectedValueOnce(COMPACTING)
      .mockResolvedValueOnce(undefined);
    const p = sendUserMessageFrom({ sendUserMessage }, "[mud] hi", origin, {
      deliverAs: "followUp",
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(p).resolves.toBeUndefined();
    expect(sendUserMessage).toHaveBeenCalledTimes(3);
    expect(sendUserMessage).toHaveBeenLastCalledWith("[mud] hi", { deliverAs: "followUp" });
  });

  it("gives up after the wait limit with the original error", async () => {
    vi.useFakeTimers();
    const sendUserMessage = vi.fn().mockRejectedValue(COMPACTING);
    const p = sendUserMessageFrom({ sendUserMessage }, "x", origin);
    const settled = expect(p).rejects.toThrow(/compaction is in progress/);
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    await settled;
  });

  it("does not retry other errors", async () => {
    const sendUserMessage = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(sendUserMessageFrom({ sendUserMessage }, "x", origin)).rejects.toThrow("boom");
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("retries through the tracker path too", async () => {
    vi.useFakeTimers();
    const dispatch = vi.fn().mockRejectedValueOnce(COMPACTING).mockResolvedValueOnce(undefined);
    bindProvenanceTracker({ dispatch, ownsSessionManager: () => true } as never);
    const p = sendUserMessageFrom({ sendUserMessage: vi.fn() }, "y", origin);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(p).resolves.toBeUndefined();
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
});
