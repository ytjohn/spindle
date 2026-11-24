import { describe, it, expect } from "vitest";
import { startWebServer } from "../../src/web/server";

const baseDeps = {
  agentId: "eliza",
  agentName: "Eliza",
  sessionFile: undefined,
  memoryEnabled: false,
  daydreamEnabled: false,
  replEnabled: false,
  uiEnabled: false,
  version: "0.4.0-test",
  engine: null,
};

describe("web server lifecycle", () => {
  it("starts, serves /health, and stops cleanly", async () => {
    const handle = await startWebServer(
      {
        enabled: true,
        host: "127.0.0.1",
        port: 0,
        tokenEnv: "SPINDLE_WEB_TOKEN",
        token: "lifecycle-token",
        uiEnabled: false,
      },
      baseDeps
    );

    try {
      const address = handle.app.server.address();
      expect(address).not.toBeNull();
      const port =
        typeof address === "object" && address ? address.port : handle.port;
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toMatchObject({ ok: true, agent_id: "eliza" });
    } finally {
      await handle.stop();
    }
  });

  it("stop() releases the port", async () => {
    const handle = await startWebServer(
      {
        enabled: true,
        host: "127.0.0.1",
        port: 0,
        tokenEnv: "SPINDLE_WEB_TOKEN",
        token: "release-token",
        uiEnabled: false,
      },
      baseDeps
    );
    const address = handle.app.server.address();
    const port =
      typeof address === "object" && address ? address.port : handle.port;
    await handle.stop();

    await expect(
      fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) })
    ).rejects.toBeDefined();
  });
});
