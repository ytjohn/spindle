import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { MemoryEngine } from "../../src/memory/engine";
import { InboxEngine } from "../../src/inbox/engine";
import { InboxProjector } from "../../src/inbox/projector";
import type { ResolvedInboxConfig } from "../../src/inbox/types";

/**
 * Phase 4.4b — cross-agent routing polish.
 *
 *   1. Projector bumps `agent_routes.last_seen_at` when an inbox row's
 *      `from_auth = "agent:<id>"` matches a known route.
 *   2. `send()` returns `availableRoutes` (peer ids + capabilities) when
 *      delivery falls through to operator (unrouted).
 */
async function boot(root: string, extraContacts: ResolvedInboxConfig["contacts"] = []): Promise<{
  memory: MemoryEngine;
  inbox: InboxEngine;
  mailRoot: string;
}> {
  const memory = await MemoryEngine.open(
    { enabled: true, database_path: join(root, "memory.db") },
    {},
    root
  );
  memory.registerAgent("eliza-inbox", "Eliza");
  const mailRoot = join(root, "mail");
  const operatorMailRoot = join(root, "operator-mail");
  const config: ResolvedInboxConfig = {
    agentId: "eliza-inbox",
    agentDisplayName: "Eliza",
    mailRoot,
    operatorMailRoot,
    pollIntervalMs: 30000,
    contacts: extraContacts,
  };
  const inbox = await InboxEngine.open({ memory, config });
  return { memory, inbox, mailRoot };
}

describe("projector — last_seen_at bump on agent-authored inbound", () => {
  let root: string;
  let memory: MemoryEngine;
  let inbox: InboxEngine;
  let mailRoot: string;
  let projector: InboxProjector;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "spindle-4.4b-lastseen-"));
    ({ memory, inbox, mailRoot } = await boot(root, [
      {
        agentId: "eliza-alice",
        mailRoot: "/tmp/does-not-exist-alice",
        displayName: "Alice",
        capabilities: ["chat"],
        createdBy: "config",
      },
    ]));
    projector = new InboxProjector({
      engine: inbox,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
  });

  afterEach(async () => {
    await projector.stop();
    inbox.close();
    memory.close();
    await rm(root, { recursive: true, force: true });
  });

  it("bumps last_seen_at when projecting a message from a known peer agent", async () => {
    const before = inbox.getRoute("eliza-alice");
    expect(before?.lastSeenAt).toBeNull();

    // Stage a fixture file "from" Alice — the projector will see
    // from_auth: agent:eliza-alice and bump its last_seen_at.
    await writeFile(
      join(mailRoot, "inbox/from-alice.md"),
      `---
id: from-alice
from_auth: agent:eliza-alice
from: Alice
to: eliza-inbox
subject: hi
date: 2026-04-18T10:00:00Z
---

hey eliza
`
    );
    await projector.projectOnce();

    const after = inbox.getRoute("eliza-alice");
    expect(after?.lastSeenAt).not.toBeNull();
    expect(after!.lastSeenAt!).toBeGreaterThan(0);
  });

  it("does NOT bump when sender is an operator (no route match)", async () => {
    await writeFile(
      join(mailRoot, "inbox/from-op.md"),
      `---
id: from-op
from_auth: operator:example
from: example
to: eliza-inbox
subject: hi
date: 2026-04-18T10:00:00Z
---

operator note
`
    );
    await projector.projectOnce();
    // No Alice touch (its row's last_seen_at stays null).
    const alice = inbox.getRoute("eliza-alice");
    expect(alice?.lastSeenAt).toBeNull();
  });

  it("does NOT bump when the agent id in from_auth has no route entry", async () => {
    // Sender claims to be agent "stranger" but we don't have a route
    // for them. No bump, no crash.
    await writeFile(
      join(mailRoot, "inbox/from-stranger.md"),
      `---
id: from-stranger
from_auth: agent:stranger
from: Stranger
to: eliza-inbox
subject: hi
date: 2026-04-18T10:00:00Z
---

surprise
`
    );
    await projector.projectOnce();
    expect(inbox.getRoute("stranger")).toBeNull();
    expect(inbox.getRoute("eliza-alice")?.lastSeenAt).toBeNull();
  });
});

describe("send — availableRoutes on unrouted fallback", () => {
  let root: string;
  let memory: MemoryEngine;
  let inbox: InboxEngine;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "spindle-4.4b-unrouted-"));
    ({ memory, inbox } = await boot(root, [
      {
        agentId: "eliza-alice",
        mailRoot: "/tmp/alice-mail",
        displayName: "Alice",
        capabilities: ["chat", "inbox-demo"],
        createdBy: "config",
      },
      {
        agentId: "juno",
        mailRoot: "/tmp/juno-mail",
        displayName: "Juno",
        capabilities: ["tasks"],
        createdBy: "config",
      },
    ]));
  });

  afterEach(async () => {
    inbox.close();
    memory.close();
    await rm(root, { recursive: true, force: true });
  });

  it("routed send does not populate availableRoutes", async () => {
    // Use operator's mail_root as the target for a known route (the
    // spindle always has an `operator` route seeded). The delivery is
    // "delivered", not "unrouted".
    const r = inbox.send({
      to: "operator",
      from: "Eliza",
      fromAuth: "agent:eliza-inbox",
      body: "hi operator",
    });
    expect(r.deliveryStatus).toBe("delivered");
    expect(r.availableRoutes).toBeUndefined();
  });

  it("unrouted send returns non-reserved peer routes with capabilities", async () => {
    const r = inbox.send({
      to: "ghost-agent",
      from: "Eliza",
      fromAuth: "agent:eliza-inbox",
      body: "lost in the void",
    });
    expect(r.deliveryStatus).toBe("unrouted");
    expect(r.availableRoutes).toBeDefined();
    const ids = (r.availableRoutes ?? []).map((p) => p.agentId).sort();
    // Should be the two peer routes, NOT self/operator/eliza-inbox.
    expect(ids).toEqual(["eliza-alice", "juno"]);
    const alice = r.availableRoutes!.find((p) => p.agentId === "eliza-alice");
    expect(alice?.capabilities).toEqual(["chat", "inbox-demo"]);
    const juno = r.availableRoutes!.find((p) => p.agentId === "juno");
    expect(juno?.capabilities).toEqual(["tasks"]);
  });

  it("availableRoutes is empty when no peer routes exist (only self/operator)", async () => {
    // Boot a fresh engine with no contacts.
    const rootB = await mkdtemp(join(tmpdir(), "spindle-4.4b-empty-"));
    const { memory: mB, inbox: iB } = await boot(rootB, []);
    try {
      const r = iB.send({
        to: "anyone",
        from: "E",
        fromAuth: "agent:eliza-inbox",
        body: "lost",
      });
      expect(r.deliveryStatus).toBe("unrouted");
      expect(r.availableRoutes).toEqual([]);
    } finally {
      iB.close();
      mB.close();
      await rm(rootB, { recursive: true, force: true });
    }
  });
});
