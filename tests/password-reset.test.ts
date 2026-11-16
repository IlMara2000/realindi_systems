// Reimpostazione della password del workspace: l'hash scritto da
// scripts/reimposta-password.ts deve essere accettato dal login vero, le
// sessioni aperte devono chiudersi e i tentativi falliti non devono più
// bloccare l'accesso.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startServer, type RunningServer } from "../scripts/dev-server.js";
import { reimpostaPassword } from "../scripts/reimposta-password.js";
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

  it("azzera il blocco dei tentativi falliti", async () => {
    await protetto();

    // Dieci errori: da qui l'IP resta fermo anche con la password giusta.
    const sbagliata = makeClient(base);
    for (let i = 0; i < 10; i++) {
      const r = await sbagliata.request("/api/login", { password: "password-sbagliata" });
      expect(r.status).toBe(400);
    }
    const bloccato = await makeClient(base).request("/api/login", { password: VECCHIA });
    expect(bloccato.status).toBe(400);
    expect(String(bloccato.body.error)).toContain("Troppi tentativi");
    expect((await sql("SELECT COUNT(*)::int AS n FROM login_attempts"))[0].n).toBe(1);

    await reimpostaPassword(databaseUrl(), NUOVA);

    expect((await sql("SELECT COUNT(*)::int AS n FROM login_attempts"))[0].n).toBe(0);
    const dopo = await makeClient(base).request("/api/login", { password: NUOVA });
    expect(dopo.status).toBe(200);
  });

  it("su un workspace senza password la crea", async () => {
    const esito = await reimpostaPassword(databaseUrl(), NUOVA);
    expect(esito.workspaceProtetto).toBe(false);

    expect((await makeClient(base).request("/api/login", { password: NUOVA })).status).toBe(200);
  });
});
