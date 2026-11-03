// Calendario/Planner: /api/events (eventi uniti + proiezione prenotazioni).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startServer, type RunningServer } from "../scripts/dev-server.js";
import { makeClient, resetDb, tomorrowRome, type TestClient } from "./helpers.js";

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

describe("accessi /api/events", () => {
  it("GET senza sessione → 401, POST senza sessione → 400", async () => {
    const c = makeClient(base);
    const get = await c.request("/api/events", undefined, { public: true });
    expect(get.status).toBe(401);
    const post = await c.request("/api/events", { title: "x" }, { public: true });
    expect(post.status).toBe(400);
    const del = await c.request("/api/events/delete", { id: 1 }, { public: true });
    expect(del.status).toBe(400);
  });
});

describe("/api/events CRUD", () => {
  it("crea, filtra per intervallo, aggiorna, elimina", async () => {
    const c = await fresh();

    const empty = await c.request("/api/events?from=2026-11-01&to=2026-11-30");
    expect(empty.status).toBe(200);
    expect(empty.body.events).toEqual([]);

    const created = await c.request("/api/events", {
      title: "Call cliente",
      start: "2026-11-10T10:00:00.000Z",
      end: "2026-11-10T11:00:00.000Z",
      description: "Retrospettiva",
      location: "Telefono",
    });
    expect(created.status).toBe(200);
    const id = created.body.id;

    const inRange = await c.request("/api/events?from=2026-11-01&to=2026-11-30");
    expect(inRange.body.events).toHaveLength(1);
    expect(inRange.body.events[0]).toMatchObject({
      kind: "event",
      id,
      title: "Call cliente",
      description: "Retrospettiva",
      location: "Telefono",
    });

    const outRange = await c.request("/api/events?from=2027-01-01&to=2027-01-31");
    expect(outRange.body.events).toEqual([]);

    const updated = await c.request("/api/events", {
      id,
      title: "Call cliente (ripianificata)",
      start: "2026-11-12T10:00:00.000Z",
      end: "2026-11-12T11:00:00.000Z",
    });
    expect(updated.status).toBe(200);
    const after = await c.request("/api/events?from=2026-11-01&to=2026-11-30");
    expect(after.body.events[0].title).toBe("Call cliente (ripianificata)");

    const deleted = await c.request("/api/events/delete", { id });
    expect(deleted.status).toBe(200);
    const gone = await c.request("/api/events?from=2026-11-01&to=2026-11-30");
    expect(gone.body.events).toEqual([]);
    expect((await c.request("/api/events/delete", { id })).status).toBe(404);
    expect((await c.request("/api/events/delete", { id: "x" })).status).toBe(400);
  });

  it("validazione: date obbligatorie e ordine coerente", async () => {
    const c = await fresh();
    const bad = await c.request("/api/events", {
      title: "Non valido",
      start: "2026-11-10T11:00:00.000Z",
      end: "2026-11-10T10:00:00.000Z",
    });
    expect(bad.status).toBe(400);
    expect((await c.request("/api/events", { title: "" , start: "2026-11-10T10:00:00.000Z", end: "2026-11-10T11:00:00.000Z" })).status).toBe(400);
    expect((await c.request("/api/events", { title: "x", start: "ieri", end: "domani" })).status).toBe(400);
  });
});

describe("proiezione prenotazioni nel calendario", () => {
  it("un booking genera evento+appuntamento, l'annullamento tumula l'evento", async () => {
    const c = await fresh();
    expect(
      (await c.request("/api/settings", { booking_days: [0, 1, 2, 3, 4, 5, 6], booking_notice: 0 })).status,
    ).toBe(200);
    const slug = (await c.state()).settings.booking_slug;
    const day = tomorrowRome();
    const slots = (await c.request(`/api/booking/${slug}?day=${day}`, undefined, { public: true })).body.slots;
    expect(slots.length).toBeGreaterThan(0);

    const booked = await c.request(`/api/booking/${slug}`, {
      name: "Cliente Prova",
      email: "prova@example.test",
      start: slots[0].start,
    }, { public: true });
    expect(booked.status).toBe(200);

    const list = await c.request("/api/events");
    expect(list.status).toBe(200);
    const kinds = list.body.events.map((e: any) => e.kind);
    expect(kinds).toContain("appointment");
    expect(kinds).toContain("event");

    const projection = list.body.events.find((e: any) => e.kind === "event" && e.appointment_id);
    expect(projection).toBeDefined();
    expect(projection.title).toBe("Appuntamento: Cliente Prova");
    expect(projection.appointment_id).toBeGreaterThan(0);

    const cancelled = await c.request("/api/cancel-booking", { token: booked.body.cancel_token }, { public: true });
    expect(cancelled.status).toBe(200);

    const after = await c.request("/api/events");
    expect(after.body.events.filter((e: any) => e.kind === "event" && e.appointment_id)).toHaveLength(0);
    const appt = after.body.events.find((e: any) => e.kind === "appointment");
    expect(appt.status).toBe("cancelled");
  });
});
