import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { FastifyInstance } from "fastify";
import { createWebServer, type ResolvedWebConfig } from "../../src/web/server";
import { MemoryEngine } from "../../src/memory/engine";
import { InboxEngine } from "../../src/inbox/engine";
import type { ResolvedInboxConfig } from "../../src/inbox/types";

const AGENT = "eliza";
const TOKEN = "web-inbox-token";

function resolved(): ResolvedWebConfig {
  return {
    enabled: true,
    host: "127.0.0.1",
    port: 0,
    tokenEnv: "SPINDLE_WEB_TOKEN",
    token: TOKEN,
    uiEnabled: false,
  };
}

function auth() {
  return { authorization: `Bearer ${TOKEN}` };
}

async function boot(root: string): Promise<{
  memory: MemoryEngine;
  inbox: InboxEngine;
  app: FastifyInstance;
  mailRoot: string;
  operatorMailRoot: string;
}> {
  const memory = await MemoryEngine.open(
    { enabled: true, database_path: join(root, "memory.db") },
    {},
    root
  );
  memory.registerAgent(AGENT, "Eliza");
  const mailRoot = join(root, "mail");
  const operatorMailRoot = join(root, "operator-mail");
  const config: ResolvedInboxConfig = {
    agentId: AGENT,
    agentDisplayName: "Eliza",
    mailRoot,
    operatorMailRoot,
    pollIntervalMs: 30000,
    contacts: [],
  };
  const inbox = await InboxEngine.open({ memory, config });
  const app = createWebServer(resolved(), {
    agentId: AGENT,
    agentName: "Eliza",
    sessionFile: undefined,
    memoryEnabled: true,
    daydreamEnabled: false,
    replEnabled: false,
    uiEnabled: false,
    version: "test",
    engine: memory,
    inboxEngine: inbox,
    inboxEnabled: true,
  });
  return { memory, inbox, app, mailRoot, operatorMailRoot };
}

describe("inbox HTTP routes — auth + basic flow", () => {
  let root: string;
  let memory: MemoryEngine;
  let inbox: InboxEngine;
  let app: FastifyInstance;
  let mailRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "spindle-web-inbox-"));
    ({ memory, inbox, app, mailRoot } = await boot(root));
  });

  afterEach(async () => {
    await app.close();
    inbox.close();
    memory.close();
    await rm(root, { recursive: true, force: true });
  });

  it("401 without bearer token", async () => {
    const res = await app.inject({ method: "GET", url: "/spindle/inbox" });
    expect(res.statusCode).toBe(401);
  });

  it("GET /spindle/inbox returns empty envelope on fresh agent", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/spindle/inbox",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("GET /spindle/inbox/status reports zero unread on fresh agent", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/spindle/inbox/status",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.unread_count).toBe(0);
    expect(body.has_priority).toBe(false);
  });

  it("POST /spindle/outbox/send delivers routed + retains outbox", async () => {
    const junoMail = join(root, "juno-mail");
    await mkdir(junoMail, { recursive: true });
    inbox.upsertRoute({
      agentId: "juno",
      mailRoot: junoMail,
      displayName: "Juno",
    });
    const res = await app.inject({
      method: "POST",
      url: "/spindle/outbox/send",
      headers: { ...auth(), "content-type": "application/json" },
      payload: JSON.stringify({
        to: "juno",
        from: "Eliza",
        subject: "hi",
        body: "hello juno",
      }),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.delivery_status).toBe("delivered");
    expect(body.delivered_to).toBe("juno");
    expect(body.outbox_retained).toBe(true);

    const listRes = await app.inject({
      method: "GET",
      url: "/spindle/outbox",
      headers: auth(),
    });
    expect(listRes.json().total).toBe(0); // projector hasn't run — outbox is file-backed
  });

  it("GET /spindle/operator-inbox surfaces unrouted messages", async () => {
    const sendRes = await app.inject({
      method: "POST",
      url: "/spindle/outbox/send",
      headers: { ...auth(), "content-type": "application/json" },
      payload: JSON.stringify({
        to: "ghost",
        from: "Eliza",
        body: "lost in the void",
      }),
    });
    expect(sendRes.statusCode).toBe(201);
    const opRes = await app.inject({
      method: "GET",
      url: "/spindle/operator-inbox",
      headers: auth(),
    });
    expect(opRes.statusCode).toBe(200);
    const body = opRes.json();
    expect(body.total).toBeGreaterThanOrEqual(1);
    const lost = body.items.find(
      (i: { original_recipient?: string }) => i.original_recipient === "ghost"
    );
    expect(lost).toBeTruthy();
  });

  it("POST /spindle/outbox/send validates required fields", async () => {
    const r1 = await app.inject({
      method: "POST",
      url: "/spindle/outbox/send",
      headers: { ...auth(), "content-type": "application/json" },
      payload: JSON.stringify({ body: "only body" }),
    });
    expect(r1.statusCode).toBe(400);
    expect(r1.json().error).toBe("to_required");

    const r2 = await app.inject({
      method: "POST",
      url: "/spindle/outbox/send",
      headers: { ...auth(), "content-type": "application/json" },
      payload: JSON.stringify({ to: "juno" }),
    });
    expect(r2.statusCode).toBe(400);
  });
});

describe("inbox HTTP routes — mark read / tombstone / restore", () => {
  let root: string;
  let memory: MemoryEngine;
  let inbox: InboxEngine;
  let app: FastifyInstance;
  let mailRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "spindle-web-inbox-state-"));
    ({ memory, inbox, app, mailRoot } = await boot(root));

    // Stage a message directly (file + DB projection).
    const path = join(mailRoot, "inbox/test-msg.md");
    await writeFile(
      path,
      `---
id: test-msg
from_auth: operator:example
from: Jessica
to: eliza
subject: hi
date: 2026-04-17T10:00:00Z
---

body
`
    );
    inbox.upsertInboxRow({
      frontmatter: {
        id: "test-msg",
        from_auth: "operator:example",
        from: "Jessica",
        to: "eliza",
        subject: "hi",
        date: "2026-04-17T10:00:00Z",
      },
      body: "body",
      attachments: [],
      source: "inbox",
      relPath: "inbox/test-msg.md",
      sha256: "sha",
      mtime: 1,
    });
  });

  afterEach(async () => {
    await app.close();
    inbox.close();
    memory.close();
    await rm(root, { recursive: true, force: true });
  });

  it("GET /spindle/inbox/:id returns the message + strips nothing", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/spindle/inbox/test-msg",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe("test-msg");
    expect(body.from).toBe("Jessica");
    // The HTTP route keeps from_auth — the stripping convention only
    // applies to the LLM-facing tool (operator + UI may inspect it).
    expect(body.from_auth).toBe("operator:example");
  });

  it("POST /spindle/inbox/:id/read transitions + POST /:id/unread reverts", async () => {
    const readRes = await app.inject({
      method: "POST",
      url: "/spindle/inbox/test-msg/read",
      headers: auth(),
    });
    expect(readRes.statusCode).toBe(200);
    expect(readRes.json().status).toBe("read");
    const unreadRes = await app.inject({
      method: "POST",
      url: "/spindle/inbox/test-msg/unread",
      headers: auth(),
    });
    expect(unreadRes.statusCode).toBe(200);
    expect(unreadRes.json().status).toBe("unread");
  });

  it("DELETE + restore cycle", async () => {
    const delRes = await app.inject({
      method: "DELETE",
      url: "/spindle/inbox/test-msg?reason=spam",
      headers: auth(),
    });
    expect(delRes.statusCode).toBe(200);
    expect(delRes.json().status).toBe("tombstoned");

    const restoreRes = await app.inject({
      method: "POST",
      url: "/spindle/inbox/test-msg/restore",
      headers: auth(),
    });
    expect(restoreRes.statusCode).toBe(200);
    expect(restoreRes.json().status).toBe("unread");
  });

  it("404 on wrong id", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/spindle/inbox/nope",
      headers: auth(),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("draft routes", () => {
  let root: string;
  let memory: MemoryEngine;
  let inbox: InboxEngine;
  let app: FastifyInstance;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "spindle-web-inbox-drafts-"));
    ({ memory, inbox, app } = await boot(root));
  });

  afterEach(async () => {
    await app.close();
    inbox.close();
    memory.close();
    await rm(root, { recursive: true, force: true });
  });

  it("full CRUD: create → patch → send → list", async () => {
    const junoMail = join(root, "juno-mail");
    await mkdir(junoMail, { recursive: true });
    inbox.upsertRoute({
      agentId: "juno",
      mailRoot: junoMail,
      displayName: "Juno",
    });

    const createRes = await app.inject({
      method: "POST",
      url: "/spindle/drafts",
      headers: { ...auth(), "content-type": "application/json" },
      payload: JSON.stringify({
        to: "juno",
        from: "Eliza",
        subject: "initial",
        body: "draft v1",
      }),
    });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json();
    expect(created.status).toBe("draft");

    const patchRes = await app.inject({
      method: "PATCH",
      url: `/spindle/drafts/${created.id}`,
      headers: { ...auth(), "content-type": "application/json" },
      payload: JSON.stringify({ body: "draft v2", subject: "edited" }),
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().body).toBe("draft v2");
    expect(patchRes.json().subject).toBe("edited");

    const sendRes = await app.inject({
      method: "POST",
      url: `/spindle/drafts/${created.id}/send`,
      headers: auth(),
    });
    expect(sendRes.statusCode).toBe(201);
    expect(sendRes.json().delivery_status).toBe("delivered");

    const listRes = await app.inject({
      method: "GET",
      url: "/spindle/drafts",
      headers: auth(),
    });
    expect(listRes.json().total).toBe(0); // draft deleted post-send
  });

  it("attachment upload + list + delete + send flow", async () => {
    const junoMail = join(root, "juno-mail");
    await mkdir(junoMail, { recursive: true });
    inbox.upsertRoute({
      agentId: "juno",
      mailRoot: junoMail,
      displayName: "Juno",
    });

    // 1) create draft
    const draftRes = await app.inject({
      method: "POST",
      url: "/spindle/drafts",
      headers: { ...auth(), "content-type": "application/json" },
      payload: JSON.stringify({ to: "juno", body: "see attached" }),
    });
    expect(draftRes.statusCode).toBe(201);
    const id = draftRes.json().id;

    // 2) upload a PDF via raw body
    const pdfBytes = Buffer.from("pdf-content-here");
    const uploadRes = await app.inject({
      method: "POST",
      url: `/spindle/drafts/${id}/attachments`,
      headers: {
        ...auth(),
        "content-type": "application/pdf",
        "x-filename": "report.pdf",
      },
      payload: pdfBytes,
    });
    expect(uploadRes.statusCode).toBe(201);
    expect(uploadRes.json().filename).toBe("report.pdf");
    expect(uploadRes.json().size_bytes).toBe(pdfBytes.length);

    // 3) list attachments
    const listRes = await app.inject({
      method: "GET",
      url: `/spindle/drafts/${id}/attachments`,
      headers: auth(),
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().total).toBe(1);

    // 4) upload a second one + delete the first
    await app.inject({
      method: "POST",
      url: `/spindle/drafts/${id}/attachments`,
      headers: {
        ...auth(),
        "content-type": "application/octet-stream",
        "x-filename": "notes.txt",
      },
      payload: Buffer.from("notes"),
    });
    const delRes = await app.inject({
      method: "DELETE",
      url: `/spindle/drafts/${id}/attachments/report.pdf`,
      headers: auth(),
    });
    expect(delRes.statusCode).toBe(204);
    const finalList = await app.inject({
      method: "GET",
      url: `/spindle/drafts/${id}/attachments`,
      headers: auth(),
    });
    expect(finalList.json().total).toBe(1);
    expect(finalList.json().items[0].filename).toBe("notes.txt");

    // 5) send the draft — attachment rides along
    const sendRes = await app.inject({
      method: "POST",
      url: `/spindle/drafts/${id}/send`,
      headers: auth(),
    });
    expect(sendRes.statusCode).toBe(201);
    expect(sendRes.json().delivery_status).toBe("delivered");
  });

  it("attachment upload rejects missing X-Filename", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/spindle/drafts",
      headers: { ...auth(), "content-type": "application/json" },
      payload: JSON.stringify({ to: "x", body: "x" }),
    });
    const id = createRes.json().id;
    const r = await app.inject({
      method: "POST",
      url: `/spindle/drafts/${id}/attachments`,
      headers: { ...auth(), "content-type": "application/octet-stream" },
      payload: Buffer.from("data"),
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("x_filename_header_required");
  });

  it("attachment upload rejects path-traversal filename", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/spindle/drafts",
      headers: { ...auth(), "content-type": "application/json" },
      payload: JSON.stringify({ to: "x", body: "x" }),
    });
    const id = createRes.json().id;
    const r = await app.inject({
      method: "POST",
      url: `/spindle/drafts/${id}/attachments`,
      headers: {
        ...auth(),
        "content-type": "application/octet-stream",
        "x-filename": "../../etc/passwd",
      },
      payload: Buffer.from("x"),
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("invalid_filename");
  });

  it("DELETE /spindle/drafts/:id cancels", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/spindle/drafts",
      headers: { ...auth(), "content-type": "application/json" },
      payload: JSON.stringify({ body: "throwaway" }),
    });
    const id = createRes.json().id;
    const delRes = await app.inject({
      method: "DELETE",
      url: `/spindle/drafts/${id}`,
      headers: auth(),
    });
    expect(delRes.statusCode).toBe(204);
  });
});

describe("routes CRUD", () => {
  let root: string;
  let memory: MemoryEngine;
  let inbox: InboxEngine;
  let app: FastifyInstance;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "spindle-web-inbox-routes-"));
    ({ memory, inbox, app } = await boot(root));
  });

  afterEach(async () => {
    await app.close();
    inbox.close();
    memory.close();
    await rm(root, { recursive: true, force: true });
  });

  it("GET /spindle/routes lists at least self + operator + owner", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/spindle/routes",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const ids = body.items.map((r: { agent_id: string }) => r.agent_id).sort();
    expect(ids).toContain("self");
    expect(ids).toContain("operator");
    expect(ids).toContain("eliza");
  });

  it("POST + PATCH + DELETE non-reserved route", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/spindle/routes",
      headers: { ...auth(), "content-type": "application/json" },
      payload: JSON.stringify({
        agent_id: "juno",
        mail_root: "/tmp/juno-mail",
        display_name: "Juno",
      }),
    });
    expect(createRes.statusCode).toBe(201);

    const patchRes = await app.inject({
      method: "PATCH",
      url: "/spindle/routes/juno",
      headers: { ...auth(), "content-type": "application/json" },
      payload: JSON.stringify({ display_name: "Juno Updated" }),
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().display_name).toBe("Juno Updated");

    const delRes = await app.inject({
      method: "DELETE",
      url: "/spindle/routes/juno",
      headers: auth(),
    });
    expect(delRes.statusCode).toBe(204);
  });

  it("DELETE on reserved route → 400", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/spindle/routes/operator",
      headers: auth(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("cannot_delete_reserved");
  });
});
