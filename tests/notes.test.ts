// Sezione Note: CRUD autenticato su /api/notes.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startServer, type RunningServer } from "../scripts/dev-server.js";
import { makeClient, resetDb, type TestClient } from "./helpers.js";

let server: RunningServer;
let base: string;

beforeAll(async () => {
  server = await startServer(0);
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
});

beforeEach(async () => {
  await resetDb();
});

async function fresh(): Promise<TestClient> {
  const c = makeClient(base);
  const r = await c.setup();
  if (r.status !== 200) throw new Error(`setup ${r.status}`);
  return c;
}

describe("accessi /api/notes", () => {
  it("GET senza sessione → 401, POST senza sessione → 400", async () => {
    const c = makeClient(base);
    const get = await c.request("/api/notes", undefined, { public: true });
    expect(get.status).toBe(401);
    const post = await c.request("/api/notes", { title: "x" }, { public: true });
    expect(post.status).toBe(400);
    const del = await c.request("/api/notes/delete", { id: 1 }, { public: true });
    expect(del.status).toBe(400);
  });
});

describe("/api/notes CRUD", () => {
  it("crea, elenca, aggiorna, ripina ed elimina", async () => {
    const c = await fresh();

    const empty = await c.request("/api/notes");
    expect(empty.status).toBe(200);
    expect(empty.body.notes).toEqual([]);

    const created = await c.request("/api/notes", {
      title: "Idea portale",
      body: "Dettagli della proposta",
      pinned: true,
    });
    expect(created.status).toBe(200);

    const list1 = await c.request("/api/notes");
    expect(list1.body.notes).toHaveLength(1);
    expect(list1.body.notes[0]).toMatchObject({
      title: "Idea portale",
      body: "Dettagli della proposta",
      pinned: true,
      client_id: null,
      project_id: null,
    });
    const id = list1.body.notes[0].id;

    const updated = await c.request("/api/notes", { id, title: "Idea rivista", pinned: false });
    expect(updated.status).toBe(200);
    const list2 = await c.request("/api/notes");
    expect(list2.body.notes[0].title).toBe("Idea rivista");
    expect(list2.body.notes[0].pinned).toBe(false);

    const deleted = await c.request("/api/notes/delete", { id });
    expect(deleted.status).toBe(200);
    expect((await c.request("/api/notes")).body.notes).toEqual([]);

    expect((await c.request("/api/notes/delete", { id })).status).toBe(404);
    expect((await c.request("/api/notes", { id: id + 999, title: "fantasma" })).status).toBe(404);
  });

  it("validazione: title obbligatorio, riferimenti devono esistere", async () => {
    const c = await fresh();
    expect((await c.request("/api/notes", { title: "" })).status).toBe(400);
    expect((await c.request("/api/notes", { title: "x".repeat(201) })).status).toBe(400);
    expect((await c.request("/api/notes", { title: "ok", client_id: 999 })).status).toBe(400);
    expect((await c.request("/api/notes", { title: "ok", project_id: 999 })).status).toBe(400);
    expect((await c.request("/api/notes/delete", { id: 999999 })).status).toBe(404);
  });

  it("le note fissate escono prima di quelle normali", async () => {
    const c = await fresh();
    await c.request("/api/notes", { title: "normale" });
    await c.request("/api/notes", { title: "fissa", pinned: true });
    const list = await c.request("/api/notes");
    expect(list.body.notes.map((n: any) => n.title)).toEqual(["fissa", "normale"]);
  });
});
