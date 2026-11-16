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
    expect(db.prepare("SELECT value FROM settings WHERE key='password_emergenza'").get()).toBeUndefined();
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

  it("i codici di emergenza del setup entrano al posto della password, una volta sola", async () => {
    const c = makeClient(base);
    const setup = await c.setup();
    const codici = setup.body.codici as string[];
    expect(codici).toHaveLength(8);
    for (const codice of codici) {
      expect(codice.startsWith("em-")).toBe(true);
      expect(codice.length).toBeGreaterThan(30);
    }

    // Il primo entra come la password...
    expect((await makeClient(base).request("/api/login", { password: codici[0] })).status).toBe(200);
    // ...ma il primo uso lo consuma: lo stesso codice non vale due volte.
    expect((await makeClient(base).request("/api/login", { password: codici[0] })).status).toBe(400);
    // Gli altri restano indipendenti, e la password normale non viene toccata.
    expect((await makeClient(base).request("/api/login", { password: codici[1] })).status).toBe(200);
    expect((await makeClient(base).request("/api/login", { password: "Test-password-123!" })).status).toBe(200);

    // Due consumati: restano sei hash, e nessun codice è salvato in chiaro.
    const salvati = await sql("SELECT value FROM settings WHERE key = 'password_emergenza'");
    const righe = JSON.parse(salvati[0].value) as unknown[];
    expect(righe).toHaveLength(6);
    expect(JSON.stringify(righe)).not.toContain(codici[2]);

    // Non sono leggibili dall'app: né nelle impostazioni né nello stato.
    const stato = await c.state();
    expect(stato.settings.password_emergenza).toBeUndefined();
    expect(JSON.stringify(stato)).not.toContain(codici[2]);

    // E non viaggiano nemmeno nel backup.
    const backup = await c.request("/api/backup");
    const { sql: dump } = await extractBackup(backup.bytes);
    expect(dump).not.toContain(codici[2]);
    expect(dump).not.toContain("password_emergenza");
  });

  it("gli accessi riusciti restano registrati con IP e credenziale", async () => {
    const c = makeClient(base);
    const setup = await c.setup();
    const codici = setup.body.codici as string[];

    // Un accesso col codice, poi un errore che non deve entrare nello storico.
    expect((await makeClient(base).request("/api/login", { password: codici[0] })).status).toBe(200);
    expect((await makeClient(base).request("/api/login", { password: "sbagliata" })).status).toBe(400);

    const accessi = (await c.state()).accessi as { ip: string; via: string; nuovo: boolean }[];
    expect(accessi).toHaveLength(2);
    expect(accessi[0].via).toBe("codice");
    expect(accessi[1].via).toBe("password");
    expect(accessi.every((a) => a.ip === "127.0.0.1")).toBe(true);
    // Il primo accesso in assoluto non è «nuovo»: non c'è un prima con cui confrontarlo.
    expect(accessi[1].nuovo).toBe(false);

    // Un IP mai visto prima viene segnalato.
    await sql("INSERT INTO login_events (at, ip, via) VALUES ($1, '203.0.113.7', 'password')", [
      Date.now(),
    ]);
    const dopo = (await c.state()).accessi as { ip: string; nuovo: boolean }[];
    expect(dopo[0].ip).toBe("203.0.113.7");
    expect(dopo[0].nuovo).toBe(true);

    // È storia dell'istanza, non un dato del CRM: non viaggia nel backup.
    const backup = await c.request("/api/backup");
    const { sql: dump } = await extractBackup(backup.bytes);
    expect(dump).not.toContain("203.0.113.7");
  });

  it("dieci errori non bloccano la password giusta e azzerano il contatore", async () => {
    await fresh();
    const sbagliata = makeClient(base);

    for (let i = 0; i < 9; i++) {
      const r = await sbagliata.request("/api/login", { password: "password-sbagliata" });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("Password non corretta.");
    }

    // Il decimo errore supera il limite: il messaggio dice quanto manca.
    const decimo = await sbagliata.request("/api/login", { password: "password-sbagliata" });
    expect(decimo.status).toBe(400);
    expect(String(decimo.body.error)).toMatch(
      /^Troppi tentativi\. Riprova tra (\d+ minuti|meno di un minuto)\.$/,
    );

    // La password corretta entra anche con il contatore oltre il limite, e lo azzera.
    const giusta = await makeClient(base).request("/api/login", { password: "Test-password-123!" });
    expect(giusta.status).toBe(200);
    expect((await sql("SELECT COUNT(*)::int AS n FROM login_attempts"))[0].n).toBe(0);
  });

  it("il blocco riporta i minuti che restano, non sempre quindici", async () => {
    await fresh();
    // Un errore crea la riga dell'IP, poi la si porta oltre il limite con due
    // minuti di finestra residua: il messaggio deve dire 2, non 15.
    await makeClient(base).request("/api/login", { password: "password-sbagliata" });
    const [{ ip }] = await sql("SELECT ip FROM login_attempts");
    await sql("UPDATE login_attempts SET count = 10, reset = $1 WHERE ip = $2", [
      Date.now() / 1000 + 120,
      ip,
    ]);

    const risposta = await makeClient(base).request("/api/login", { password: "password-sbagliata" });
    expect(risposta.status).toBe(400);
    expect(risposta.body.error).toBe("Troppi tentativi. Riprova tra 2 minuti.");
  });

  it("cambio password: richiede quella attuale e chiude le altre sessioni", async () => {
    const a = await fresh();
    const b = makeClient(base);
    expect((await b.request("/api/login", { password: "Test-password-123!" })).status).toBe(200);
    expect((await b.request("/api/state")).status).toBe(200);

    // Senza sessione il cambio non è raggiungibile.
    const anonimo = await makeClient(base).request(
      "/api/password",
      { current: "Test-password-123!", password: "Nuova-password-456!" },
      { public: true },
    );
    expect(anonimo.status).toBe(400);

    // Password attuale sbagliata: non cambia niente.
    const sbagliata = await a.request("/api/password", {
      current: "non-questa",
      password: "Nuova-password-456!",
    });
    expect(sbagliata.status).toBe(400);
    expect(sbagliata.body.error).toBe("La password attuale non è corretta.");
    expect((await makeClient(base).request("/api/login", { password: "Test-password-123!" })).status).toBe(200);

    // Nuova password troppo corta.
    const corta = await a.request("/api/password", {
      current: "Test-password-123!",
      password: "corta",
    });
    expect(corta.status).toBe(400);
    expect((await makeClient(base).request("/api/login", { password: "Test-password-123!" })).status).toBe(200);

    const cambio = await a.request("/api/password", {
      current: "Test-password-123!",
      password: "Nuova-password-456!",
    });
    expect(cambio.status).toBe(200);

    // Il browser che ha chiesto il cambio ha una sessione nuova...
    expect((await a.request("/api/state")).status).toBe(200);
    // ...le altre sono chiuse...
    expect((await b.request("/api/state")).status).toBe(401);
    // ...e la vecchia password non entra più.
    expect((await makeClient(base).request("/api/login", { password: "Test-password-123!" })).status).toBe(400);
    expect((await makeClient(base).request("/api/login", { password: "Nuova-password-456!" })).status).toBe(200);
  });

  it("il cambio password accetta un codice di emergenza al posto di quella attuale", async () => {
    const c = makeClient(base);
    const setup = await c.setup();
    const codici = setup.body.codici as string[];

    // Si rientra col codice, come chi non ricorda più la password.
    const conCodice = makeClient(base);
    expect((await conCodice.request("/api/login", { password: codici[0] })).status).toBe(200);

    const cambio = await conCodice.request("/api/password", {
      current: codici[1],
      password: "Nuova-password-456!",
    });
    expect(cambio.status).toBe(200);

    // La password nuova entra, la vecchia no.
    expect((await makeClient(base).request("/api/login", { password: "Nuova-password-456!" })).status).toBe(200);
    expect((await makeClient(base).request("/api/login", { password: "Test-password-123!" })).status).toBe(400);
    // Il cambio rigenera i codici: quelli di prima non valgono più, i nuovi sì.
    const nuovi = cambio.body.codici as string[];
    expect(nuovi).toHaveLength(8);
    expect((await makeClient(base).request("/api/login", { password: codici[1] })).status).toBe(400);
    expect((await makeClient(base).request("/api/login", { password: codici[2] })).status).toBe(400);
    expect((await makeClient(base).request("/api/login", { password: nuovi[0] })).status).toBe(200);

    // Una credenziale attuale sbagliata resta rifiutata.
    const sbagliata = await conCodice.request("/api/password", {
      current: "non-e-la-mia-password",
      password: "Altra-password-789!",
    });
    expect(sbagliata.status).toBe(400);
  });

  it("le sessioni attive si vedono e si chiudono una per una", async () => {
    const a = await fresh();
    const b = makeClient(base);
    expect((await b.request("/api/login", { password: "Test-password-123!" })).status).toBe(200);

    const sessioni = (await a.state()).sessioni as { id: string; ip: string; corrente: boolean }[];
    expect(sessioni).toHaveLength(2);
    expect(sessioni.filter((s) => s.corrente)).toHaveLength(1);
    const altra = sessioni.find((s) => !s.corrente)!;
    expect(altra.ip).toBe("127.0.0.1");
    expect(altra.id).toMatch(/^[a-f0-9]{12}$/);

    expect((await a.request("/api/sessions/revoke", { id: altra.id })).status).toBe(200);
    // L'altro browser è fuori, questo resta dentro.
    expect((await b.request("/api/state")).status).toBe(401);
    expect((await a.request("/api/state")).status).toBe(200);
    // Un id che non è una sessione viene rifiutato.
    expect((await a.request("/api/sessions/revoke", { id: "non-un-id" })).status).toBe(400);
  });

  it("«disconnetti le altre sessioni» lascia dentro solo questo browser", async () => {
    const a = await fresh();
    const b = makeClient(base);
    expect((await b.request("/api/login", { password: "Test-password-123!" })).status).toBe(200);

    const chiusura = await a.request("/api/sessions/revoke-others", {});
    expect(chiusura.status).toBe(200);
    expect(chiusura.body.chiuse).toBe(1);
    expect((await b.request("/api/state")).status).toBe(401);
    expect((await a.request("/api/state")).status).toBe(200);
  });

  it("i codici di emergenza si possono rigenerare dal pannello", async () => {
    const c = makeClient(base);
    const setup = await c.setup();
    const vecchi = setup.body.codici as string[];
    expect((await c.state()).codici_emergenza).toBe(8);

    // Senza sessione la rigenerazione non è raggiungibile.
    expect((await makeClient(base).request("/api/emergenza", {}, { public: true })).status).toBe(400);

    const nuovo = await c.request("/api/emergenza", {});
    expect(nuovo.status).toBe(200);
    const codici = nuovo.body.codici as string[];
    expect(codici).toHaveLength(8);
    expect(codici[0]).not.toBe(vecchi[0]);

    // I vecchi non valgono più, i nuovi sì.
    expect((await makeClient(base).request("/api/login", { password: vecchi[0] })).status).toBe(400);
    expect((await makeClient(base).request("/api/login", { password: codici[0] })).status).toBe(200);
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
