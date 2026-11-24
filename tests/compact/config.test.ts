import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  resolveContextLimit,
  resetContextLimitWarnings,
} from "../../src/compact/config";
import { validateAgentConfig } from "../../src/config/loader";

describe("resolveContextLimit", () => {
  beforeEach(() => resetContextLimitWarnings());

  it("returns undefined and logs nothing when neither key is set", () => {
    const log = vi.fn();
    expect(resolveContextLimit(undefined, log)).toBeUndefined();
    expect(resolveContextLimit({}, log)).toBeUndefined();
    expect(log).not.toHaveBeenCalled();
  });

  it("uses context_limit silently when only it is set", () => {
    const log = vi.fn();
    expect(resolveContextLimit({ context_limit: 150000 }, log)).toBe(150000);
    expect(log).not.toHaveBeenCalled();
  });

  it("honors the deprecated max_tokens alias with a deprecation note", () => {
    const log = vi.fn();
    expect(resolveContextLimit({ max_tokens: 150000 }, log)).toBe(150000);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/max_tokens is deprecated/);
    expect(log.mock.calls[0][0]).toMatch(/context_limit/);
  });

  it("prefers context_limit when both are set and warns", () => {
    const log = vi.fn();
    expect(
      resolveContextLimit({ context_limit: 120000, max_tokens: 150000 }, log)
    ).toBe(120000);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/both/);
    expect(log.mock.calls[0][0]).toMatch(/using context_limit/);
  });

  it("logs each warning only once per process", () => {
    const log = vi.fn();
    resolveContextLimit({ max_tokens: 1 }, log);
    resolveContextLimit({ max_tokens: 2 }, log);
    resolveContextLimit({ context_limit: 3, max_tokens: 4 }, log);
    resolveContextLimit({ context_limit: 5, max_tokens: 6 }, log);
    expect(log).toHaveBeenCalledTimes(2);
  });
});

describe("compact config schema", () => {
  const base = { agent: { id: "t" } };

  it("accepts compact.context_limit", () => {
    const r = validateAgentConfig({
      ...base,
      spindle: { compact: { enabled: true, context_limit: 150000 } },
    });
    expect(r.success).toBe(true);
  });

  it("still accepts the deprecated compact.max_tokens", () => {
    const r = validateAgentConfig({
      ...base,
      spindle: { compact: { enabled: true, max_tokens: 150000 } },
    });
    expect(r.success).toBe(true);
  });

  it("rejects a non-positive context_limit", () => {
    const r = validateAgentConfig({
      ...base,
      spindle: { compact: { enabled: true, context_limit: 0 } },
    });
    expect(r.success).toBe(false);
  });
});
