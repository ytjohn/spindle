import { describe, it, expect } from "vitest";
import { validateAgentConfig } from "../../src/config/loader";
import { resolveInboxConfig } from "../../src/inbox/config";

describe("inbox config schema", () => {
  it("accepts a minimal enabled block", () => {
    const config = {
      agent: { id: "eliza" },
      inbox: { enabled: true },
    };
    const result = validateAgentConfig(config);
    expect(result.success).toBe(true);
  });

  it("accepts contacts list", () => {
    const config = {
      agent: { id: "eliza" },
      inbox: {
        enabled: true,
        poll_interval_seconds: 15,
        contacts: [
          {
            agent_id: "juno",
            mail_root: "/tmp/juno-mail",
            display_name: "Juno",
            capabilities: ["tasks"],
          },
        ],
      },
    };
    const result = validateAgentConfig(config);
    expect(result.success).toBe(true);
  });

  it("rejects invalid contact missing agent_id", () => {
    const config = {
      agent: { id: "eliza" },
      inbox: {
        enabled: true,
        contacts: [{ mail_root: "/tmp/x" }],
      },
    };
    const result = validateAgentConfig(config);
    expect(result.success).toBe(false);
  });
});

describe("resolveInboxConfig", () => {
  it("returns null when inbox block is absent", () => {
    const resolved = resolveInboxConfig(
      { agent: { id: "eliza" } },
      "/tmp/agent",
      {}
    );
    expect(resolved).toBeNull();
  });

  it("returns null when enabled is not true", () => {
    const resolved = resolveInboxConfig(
      { agent: { id: "eliza" }, inbox: {} },
      "/tmp/agent",
      {}
    );
    expect(resolved).toBeNull();
  });

  it("defaults mail_root to {agent-dir}/.pi/mail", () => {
    const resolved = resolveInboxConfig(
      { agent: { id: "eliza" }, inbox: { enabled: true } },
      "/home/user/agent",
      { HOME: "/home/user", XDG_DATA_HOME: "/home/user/.local/share" }
    );
    expect(resolved?.mailRoot).toBe("/home/user/agent/.pi/mail");
  });

  it("uses XDG_DATA_HOME for default operator_mail_root", () => {
    const resolved = resolveInboxConfig(
      { agent: { id: "eliza" }, inbox: { enabled: true } },
      "/tmp/agent",
      {
        HOME: "/home/user",
        XDG_DATA_HOME: "/data",
      }
    );
    expect(resolved?.operatorMailRoot).toBe("/data/spindle/operator/mail");
  });

  it("falls back to ~/.local/share when XDG_DATA_HOME is unset", () => {
    const resolved = resolveInboxConfig(
      { agent: { id: "eliza" }, inbox: { enabled: true } },
      "/tmp/agent",
      { HOME: "/home/user" }
    );
    expect(resolved?.operatorMailRoot).toBe(
      "/home/user/.local/share/spindle/operator/mail"
    );
  });

  it("honors SPINDLE_OPERATOR_MAIL_ROOT env override", () => {
    const resolved = resolveInboxConfig(
      { agent: { id: "eliza" }, inbox: { enabled: true } },
      "/tmp/agent",
      { HOME: "/home/user", SPINDLE_OPERATOR_MAIL_ROOT: "/custom/op-mail" }
    );
    expect(resolved?.operatorMailRoot).toBe("/custom/op-mail");
  });

  it("resolves relative contact mail_root against agent dir", () => {
    const resolved = resolveInboxConfig(
      {
        agent: { id: "eliza" },
        inbox: {
          enabled: true,
          contacts: [
            {
              agent_id: "sibling",
              mail_root: "../sibling-agent/.pi/mail",
            },
          ],
        },
      },
      "/home/user/eliza-agent",
      { HOME: "/home/user" }
    );
    expect(resolved?.contacts[0].mailRoot).toBe(
      "/home/user/sibling-agent/.pi/mail"
    );
  });
});
