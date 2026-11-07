// Porting di tests/test_crm.py: stessi casi, stessi asserzioni, stessi messaggi.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startServer, type RunningServer } from "../scripts/dev-server.js";
import {
  makeClient,
  resetDb,
  createProject,
  configureFiscal,
  finalizeInvoice,
  extractBackup,
  loadSqliteDump,
  tomorrowRome,
  in30Days,
  sql,
  type TestClient,
} from "./helpers.js";

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

/** Fixture setUp(): setup completo e client autenticato. */
async function fresh(): Promise<TestClient> {
  const c = makeClient(base);
  const r = await c.setup();
  if (r.status !== 200) throw new Error(`setup ${r.status}: ${JSON.stringify(r.body)}`);
  return c;
}

describe("CRM", () => {
  it("ciclo preventivo → fattura e snapshot", async () => {
    const c = await fresh();
    const [cid, pid] = await createProject(c);
    const data = {
      project_id: pid,
      title: "Portale",
      valid_until: "2027-01-30",
      vat_rate: "22",
      items: [
        { description: "Sviluppo", hours: "10.25", rate: "65", factor: "1.2", extra: "25.50" },
      ],
    };
    const created = await c.request("/api/quotes", data);
    expect(created.status).toBe(200);
    const quote = (await c.state()).quotes[0];
    expect([quote.subtotal, quote.vat, quote.total]).toEqual([82500, 18150, 100650]);

    expect((await c.request("/api/quotes/status", { id: created.body.id, status: "accepted" })).status).toBe(200);
    expect((await c.request("/api/quotes/status", { id: created.body.id, status: "accepted" })).status).toBe(400);
    expect((await c.state()).invoices).toHaveLength(1);
    expect((await c.request("/api/quotes", { ...data, id: created.body.id })).status).toBe(400);

    const invoice = (await c.state()).invoices[0];
    expect((await c.request("/api/invoices/status", { id: invoice.id, status: "issued" })).status).toBe(400);

    expect((await c.request("/api/settings", {
      business_name: "Studio test", address: "Roma", vat_number: "123",
      email: "studio@example.test", tax_label: "Configurazione test",
    })).status).toBe(200);
    await configureFiscal(c, cid);
    await finalizeInvoice(c, invoice.id);

    await c.request("/api/clients", { id: cid, name: "Nome nuovo", email: "new@example.test" });
    await c.request("/api/settings", { business_name: "Nome nuovo" });

    const updated = (await c.state()).invoices[0];
    expect(updated.snapshot.client.name).toBe("Ada");
    expect(updated.snapshot.business.business_name).toBe("Studio test");
    expect(updated.number.endsWith("/00001")).toBe(true);
    expect((await c.request("/api/invoices/status", { id: updated.id, status: "paid" })).status).toBe(200);
    expect((await c.request("/api/invoices/status", { id: updated.id, status: "issued" })).status).toBe(400);
  });

  it("documenti, backup, ripristino e accessi", async () => {
    const c = await fresh();
    const [cid, pid] = await createProject(c);
    const content = Buffer.from("Contratto riservato\u0000\uffff", "latin1");
    const uploaded = await c.request("/api/documents", {
      client_id: cid, project_id: pid, name: "contratto.pdf",
      content: content.toString("base64"),
    });
    expect(uploaded.status).toBe(200);

    const fetched = await c.request(`/api/documents/${uploaded.body.id}`);
    expect(Buffer.compare(fetched.bytes, content)).toBe(0);
    expect((await c.request(`/api/documents/${uploaded.body.id}`, undefined, { public: true })).status).toBe(401);

    const backup = await c.request("/api/backup");
    expect(backup.status).toBe(200);
    const { sql, files } = await extractBackup(backup.bytes);
    const docFiles = Object.keys(files).filter((n) => n.startsWith("documents/"));
    expect(docFiles).toHaveLength(1);

    const db = loadSqliteDump(sql);
    const clients = db.prepare("SELECT COUNT(*) AS n FROM clients").get() as any;
    expect(clients.n).toBe(1);
    const password = db.prepare("SELECT value FROM settings WHERE key='password'").get();
    expect(password).toBeUndefined();
    db.close();
    expect(sql).not.toContain("Test-password");
  });

  it("corsa prenotazione, blocco e annullamento", async () => {
    const c = await fresh();
    expect((await c.request("/api/settings", {
      booking_days: [0, 1, 2, 3, 4, 5, 6], booking_notice: 0,
    })).status).toBe(200);
    const slug = (await c.state()).settings.booking_slug;
    const day = tomorrowRome();
    const url = `/api/booking/${slug}`;
    const slots = (await c.request(`${url}?day=${day}`, undefined, { public: true })).body.slots;
    expect(slots.length).toBeGreaterThan(0);

    const data = { name: "Cliente", email: "test@example.test", start: slots[0].start };
    const results = await Promise.all([
      c.request(url, data, { public: true }),
      c.request(url, data, { public: true }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    const successful = results.find((r) => r.status === 200)!.body;

    const afterBooking = (await c.request(`${url}?day=${day}`, undefined, { public: true })).body.slots;
    expect(afterBooking).not.toContainEqual(slots[0]);

    const cancelled = await c.request("/api/cancel-booking", { token: successful.cancel_token }, { public: true });
    expect(cancelled.status).toBe(200);
    const afterCancel = (await c.request(`${url}?day=${day}`, undefined, { public: true })).body.slots;
    expect(afterCancel).toContainEqual(slots[0]);

    expect((await c.request("/api/blocks", {
      start: slots[0].start, end: slots[0].end, reason: "Pausa",
    })).status).toBe(200);
    const afterBlock = (await c.request(`${url}?day=${day}`, undefined, { public: true })).body.slots;
    expect(afterBlock).not.toContainEqual(slots[0]);
    expect((await c.request(url, data, { public: true })).status).toBe(400);

    const info = (await c.request(url, undefined, { public: true })).body;
    expect(info).not.toHaveProperty("email");
  });

  it("stima per scope → preventivo → fattura", async () => {
    const c = await fresh();
    const [cid, pid] = await createProject(c);
    await c.request("/api/projects", {
      id: pid, client_id: cid, title: "Portale clienti",
      description: "Cinque schermate e integrazione catalogo.",
    });
    const scope = {
      kind: "application",
      modules: [
        { key: "screens", quantity: 5, hours: "6" },
        { key: "integrations", quantity: 1, hours: "8" },
      ],
      complexity: "1.25", testing: "20", coordination: "10",
      contingency: "15", weekly_hours: "20", expenses: "50",
    };
    const payload = {
      project_id: pid, scope, rate: "60", vat_rate: "22",
      title: "Proposta portale", valid_until: in30Days(),
      generation_key: "estimate-test-request-1234",
    };
    const preview = await c.request("/api/estimates/preview", payload);
    expect(preview.status).toBe(200);
    expect((await c.state()).quotes).toHaveLength(0);
    expect(preview.body.total_hours).toBe("71.01");
    expect(preview.body.workload_weeks).toBe("3.55");
    expect(preview.body.subtotal).toBe(431060);
    expect(preview.body.vat).toBe(94833);
    expect(preview.body.total).toBe(525893);

    const saved = await c.request("/api/estimates", payload);
    expect(saved.status).toBe(200);
    expect((await c.request("/api/estimates", payload)).body).toEqual(saved.body);
    expect((await c.state()).quotes).toHaveLength(1);
    let quote = (await c.state()).quotes[0];
    expect(quote.items).toEqual(preview.body.items);
    expect(quote.total).toBe(preview.body.total);
    expect(quote.estimate.scope.complexity).toBe("1.25");
    expect(quote.notes).toContain("Cinque schermate");

    const edited = {
      ...quote, title: "Proposta rivista",
      items: [{ description: "Accordo rivisto", hours: "1", rate: "100" }],
    };
    expect((await c.request("/api/quotes", edited)).status).toBe(200);
    const revised = (await c.state()).quotes[0];
    expect(revised.total).toBe(12200);
    expect(revised.estimate.total).toBe(525893);
    expect((await c.request("/api/quotes/status", { id: saved.body.id, status: "accepted" })).status).toBe(200);
    expect((await c.state()).invoices[0].total).toBe(12200);

    // app.init() idempotente su database popolato.
    const { ensureDefaults } = await import("../src/db.js");
    await ensureDefaults();
    expect((await c.state()).quotes[0].estimate.total).toBe(525893);
  });

  it("validazione stime, accessi e backup", async () => {
    const c = await fresh();
    const [, pid] = await createProject(c);
    const payload = {
      project_id: pid, title: "Consulenza", valid_until: in30Days(),
      generation_key: "estimate-retry-abcdef", rate: "75", vat_rate: "0",
      scope: { kind: "consulting", modules: [{ key: "audit", quantity: 1, hours: "4" }] },
    };
    expect((await c.request("/api/estimates/catalog", undefined, { public: true })).status).toBe(401);
    expect((await c.request("/api/estimates", payload, { public: true })).status).toBe(400);

    const invalidScopes: any[] = [
      null, {}, { kind: "unknown" },
      { kind: "consulting", modules: [{ key: "audit", quantity: 0, hours: "4" }] },
      { kind: "consulting", modules: [{ key: "audit", quantity: 1.5, hours: "4" }] },
      { kind: "consulting", modules: [{ key: "screens", quantity: 1, hours: "4" }] },
      { ...payload.scope, complexity: "NaN" },
      { ...payload.scope, weekly_hours: "0" },
      { ...payload.scope, modules: [...payload.scope.modules, ...payload.scope.modules] },
    ];
    for (const scope of invalidScopes) {
      const r = await c.request("/api/estimates/preview", { ...payload, scope });
      expect(r.status, JSON.stringify(scope)).toBe(400);
    }
    expect((await c.request("/api/estimates", { ...payload, valid_until: "2000-01-01" })).status).toBe(400);

    const results = await Promise.all([
      c.request("/api/estimates", payload),
      c.request("/api/estimates", payload),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(results[0].body).toEqual(results[1].body);
    expect((await c.state()).quotes).toHaveLength(1);

    const backup = await c.request("/api/backup");
    expect(backup.status).toBe(200);
    const { sql } = await extractBackup(backup.bytes);
    const db = loadSqliteDump(sql);
    const stored = db.prepare("SELECT estimate FROM quotes").get() as any;
    db.close();
    expect(JSON.parse(stored.estimate).total).toBe(30000);
  });

  it("setup simultanei configurano l'account una volta sola", async () => {
    // Tre prime configurazioni in parallelo: la verifica "esiste già la
    // password?" e l'INSERT sono due passi distinti, quindi la corsa è reale.
    // Qualunque cosa rispondano i perdenti, devono restare un solo account.
    const passwords = ["Simultanea-uno-123!", "Simultanea-due-456!", "Simultanea-tre-789!"];
    const esiti = await Promise.all(passwords.map((password) => makeClient(base).setup(password)));

    expect(esiti.filter((r) => r.status === 200)).toHaveLength(1);
    for (const esito of esiti.filter((r) => r.status !== 200)) {
      // Chi perde trova l'account già configurato: un messaggio comprensibile,
      // non la violazione di unicità (409) che l'INSERT non atomico produceva.
      expect(
        esito.status,
        `risposta inattesa a un setup perdente: ${esito.status} ${JSON.stringify(esito.body)}`,
      ).toBe(400);
      expect(esito.body.error).toBe("Configurazione già completata.");
    }

    // Una sola password salvata, ed è quella della richiesta che ha vinto.
    const rows = await sql("SELECT COUNT(*)::int AS n FROM settings WHERE key = 'password'");
    expect(rows[0].n).toBe(1);

    const winner = esiti.findIndex((r) => r.status === 200);
    const login = await makeClient(base).request("/api/login", { password: passwords[winner] });
    expect(login.status).toBe(200);

    // La password di un setup perdente non è quella rimasta salvata.
    const loser = passwords.findIndex((_, i) => i !== winner);
    const denied = await makeClient(base).request("/api/login", { password: passwords[loser] });
    expect(denied.status).toBe(400);
  });

  it("sicurezza e validazione", async () => {
    const c = await fresh();
    expect((await c.request("/api/state", undefined, { public: true })).status).toBe(401);
    expect((await c.request("/api/backup", undefined, { public: true })).status).toBe(401);
    expect((await c.request("/api/setup", { password: "another-long-password" }, { public: true })).status).toBe(400);
    expect((await c.request("/api/settings", { business_name: "Hostile" }, {
      headers: { "Content-Type": "application/json", Origin: "https://evil.test" },
    })).status).toBe(403);

    for (const value of ["NaN", "Infinity", "-1"]) {
      const r = await c.request("/api/quotes/calculate", {
        items: [{ description: "test", hours: value, rate: "20" }],
      });
      expect(r.status, value).toBe(400);
    }
    expect((await c.request("/api/projects", { client_id: 999, title: "Missing client" })).status).toBe(400);

    expect((await c.request("/api/logout", {})).status).toBe(200);
    expect((await c.request("/api/state")).status).toBe(401);
    expect((await c.request("/api/login", { password: "Test-password-123!" })).status).toBe(200);
  });
});
