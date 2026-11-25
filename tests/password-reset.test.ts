// Reimpostazione della password del workspace: l'hash scritto da
// scripts/reimposta-password.ts deve essere accettato dal login vero, le
// sessioni aperte devono chiudersi e i tentativi falliti non devono più
// bloccare l'accesso.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startServer, type RunningServer } from "../scripts/dev-server.js";
import { codiciSuUnaRiga, reimpostaPassword, statoAccesso } from "../scripts/reimposta-password.js";
import { makeClient, resetDb, sql } from "./helpers.js";

const VECCHIA = "Vecchia-password-123!";
const NUOVA = "Nuova-password-456!";

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

/** Connessione della run (tests/helpers.ts l'ha già puntata al database di test). */
function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL assente");
  return url;
}

/** Workspace già configurato con la vecchia password. */
async function protetto(): Promise<void> {
  const c = makeClient(base);
  const r = await c.setup(VECCHIA);
  if (r.status !== 200) throw new Error(`setup ${r.status}: ${JSON.stringify(r.body)}`);
}

describe("reimposta password", () => {
  it("i codici per il Portachiavi stanno su una riga sola e si rileggono interi", () => {
    const codici = ["em-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "em-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"];
    const riga = codiciSuUnaRiga(codici);

    expect(riga).not.toContain("\n");
    expect(riga.split("; ")).toEqual(codici);
  });

  it("la password nuova entra dal login, la vecchia viene rifiutata", async () => {
    await protetto();

    const esito = await reimpostaPassword(databaseUrl(), NUOVA);
    expect(esito.workspaceProtetto).toBe(true);

    const vecchia = await makeClient(base).request("/api/login", { password: VECCHIA });
    expect(vecchia.status).toBe(400);

    const nuova = await makeClient(base).request("/api/login", { password: NUOVA });
    expect(nuova.status).toBe(200);
  });

  it("una password troppo corta non tocca il workspace", async () => {
    await protetto();

    await expect(reimpostaPassword(databaseUrl(), "corta")).rejects.toThrow(/almeno 12/);

    // La password precedente vale ancora: nessuna scrittura è avvenuta.
    const accesso = await makeClient(base).request("/api/login", { password: VECCHIA });
    expect(accesso.status).toBe(200);
  });

  it("chiude le sessioni aperte prima della reimpostazione", async () => {
    const c = makeClient(base);
    await c.setup(VECCHIA);
    expect((await c.request("/api/state")).status).toBe(200);

    const esito = await reimpostaPassword(databaseUrl(), NUOVA);
    expect(esito.sessioniChiuse).toBe(1);

    // Il cookie del browser non vale più: la sessione è stata cancellata.
    expect((await c.request("/api/state")).status).toBe(401);
    expect((await sql("SELECT COUNT(*)::int AS n FROM sessions"))[0].n).toBe(0);
  });

  it("la reimpostazione sostituisce i codici di emergenza e i nuovi sono monouso", async () => {
    const c = makeClient(base);
    const setup = await c.setup(VECCHIA);
    const vecchi = setup.body.codici as string[];

    const esito = await reimpostaPassword(databaseUrl(), NUOVA);
    expect(esito.codiciEmergenza).toHaveLength(8);
    for (const nuovo of esito.codiciEmergenza) {
      expect(nuovo.startsWith("em-")).toBe(true);
      expect(vecchi).not.toContain(nuovo);
    }

    // I codici vecchi non valgono più; uno nuovo entra, ma una volta sola.
    expect((await makeClient(base).request("/api/login", { password: vecchi[0] })).status).toBe(400);
    expect(
      (await makeClient(base).request("/api/login", { password: esito.codiciEmergenza[0] })).status,
    ).toBe(200);
    expect(
      (await makeClient(base).request("/api/login", { password: esito.codiciEmergenza[0] })).status,
    ).toBe(400);
  });

  it("azzera i tentativi falliti", async () => {
    await protetto();

    const sbagliata = makeClient(base);
    for (let i = 0; i < 10; i++) {
      const r = await sbagliata.request("/api/login", { password: "password-sbagliata" });
      expect(r.status).toBe(400);
    }
    expect((await sql("SELECT COUNT(*)::int AS n FROM login_attempts"))[0].n).toBe(1);

    await reimpostaPassword(databaseUrl(), NUOVA);

    expect((await sql("SELECT COUNT(*)::int AS n FROM login_attempts"))[0].n).toBe(0);
    const dopo = await makeClient(base).request("/api/login", { password: NUOVA });
    expect(dopo.status).toBe(200);
  });

  it("lo stato dice password, sessioni e blocchi senza modificare niente", async () => {
    const c = makeClient(base);
    await c.setup(VECCHIA);
    expect((await makeClient(base).request("/api/login", { password: VECCHIA })).status).toBe(200);

    // Un IP oltre la soglia, con due minuti di finestra residua.
    await sql(
      "INSERT INTO login_attempts (ip, count, reset) VALUES ('10.0.0.9', 12, $1)",
      [Date.now() / 1000 + 120],
    );

    const prima = await sql(
      "SELECT (SELECT COUNT(*) FROM sessions)::int AS sessioni, (SELECT value FROM settings WHERE key = 'password') AS password",
    );
    const stato = await statoAccesso(databaseUrl());
    const dopo = await sql(
      "SELECT (SELECT COUNT(*) FROM sessions)::int AS sessioni, (SELECT value FROM settings WHERE key = 'password') AS password",
    );

    expect(stato.passwordPresente).toBe(true);
    expect(stato.codiciDisponibili).toBe(8);
    // L'ultimo accesso riuscito arriva dallo stesso IP che il login conta.
    expect(stato.ultimoAccesso?.ip).toBe("127.0.0.1");
    expect(stato.ultimoAccesso?.via).toBe("password");
    expect(stato.sessioniAttive).toBe(2);
    expect(stato.bloccati).toHaveLength(1);
    expect(stato.bloccati[0].ip).toBe("10.0.0.9");
    expect(stato.bloccati[0].tentativi).toBe(12);
    expect(stato.bloccati[0].secondiResidui).toBeGreaterThan(100);
    expect(stato.bloccati[0].secondiResidui).toBeLessThanOrEqual(120);

    // Sola lettura: sessioni e hash della password sono identici.
    expect(dopo).toEqual(prima);
  });

  it("un X-Forwarded-For forgiato non sposta il conteggio né la diagnosi", async () => {
    await protetto();
    // Dieci errori con un «IP» diverso nell'header: se la chiave venisse
    // dall'header sarebbero dieci bucket distinti e il blocco non scatterebbe
    // mai. Deve contare l'indirizzo della connessione, uno solo.
    for (let i = 0; i < 10; i++) {
      const r = await makeClient(base).request(
        "/api/login",
        { password: "password-sbagliata" },
        { public: true, headers: { "X-Forwarded-For": `203.0.113.${i + 1}` } },
      );
      expect(r.status).toBe(400);
    }

    const righe = await sql("SELECT ip, count FROM login_attempts");
    expect(righe).toHaveLength(1);
    expect(righe[0].ip).toBe("127.0.0.1");
    expect(righe[0].count).toBe(10);

    // La diagnosi riporta lo stesso IP che il login ha contato.
    const stato = await statoAccesso(databaseUrl());
    expect(stato.bloccati).toHaveLength(1);
    expect(stato.bloccati[0].ip).toBe(righe[0].ip);
    expect(stato.bloccati[0].tentativi).toBe(10);
  });

  it("lo stato di un workspace mai configurato non inventa nulla", async () => {
    expect(await statoAccesso(databaseUrl())).toEqual({
      passwordPresente: false,
      codiciDisponibili: 0,
      sessioniAttive: 0,
      bloccati: [],
      ultimoAccesso: null,
    });
  });

  it("un blocco scaduto non risulta tra gli IP fermati", async () => {
    await protetto();
    await sql("INSERT INTO login_attempts (ip, count, reset) VALUES ('10.0.0.9', 12, $1)", [
      Date.now() / 1000 - 60,
    ]);
    expect((await statoAccesso(databaseUrl())).bloccati).toHaveLength(0);
  });

  it("su un workspace senza password la crea", async () => {
    const esito = await reimpostaPassword(databaseUrl(), NUOVA);
    expect(esito.workspaceProtetto).toBe(false);

    expect((await makeClient(base).request("/api/login", { password: NUOVA })).status).toBe(200);
  });
});
