// Crittografia segreti, modelli Prisma e integrazioni Google/Apple.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { startServer, type RunningServer } from "../scripts/dev-server.js";
import { sql, makeClient, resetDb, type TestClient } from "./helpers.js";

// La verifica Apple fa login IMAP reale: va mockkato a livello di modulo.
const imap = vi.hoisted(() => ({ shouldFail: false, connects: 0 }));
vi.mock("imapflow", () => ({
  ImapFlow: class {
    async connect() {
      imap.connects += 1;
      if (imap.shouldFail) throw new Error("Invalid login credentials");
    }
    async logout() {}
  },
}));

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
  imap.shouldFail = false;
  imap.connects = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function fresh(): Promise<TestClient> {
  const c = makeClient(base);
  const r = await c.setup();
  if (r.status !== 200) throw new Error(`setup ${r.status}`);
  return c;
}

/** Intercetta SOLO lo scambio token Google; tutto il resto usa la rete reale. */
function stubGoogleTokenExchange(handler: () => Response): void {
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://oauth2.googleapis.com/token")) return handler();
    return real(input, init);
  });
}

const GOOGLE_ENV = {
  GOOGLE_CLIENT_ID: "client-id-di-test",
  GOOGLE_CLIENT_SECRET: "client-secret-di-test",
  INTEGRATIONS_KEY: "chiave-di-test-non-produzione",
};

describe("sealSecret/openSecret", () => {
  it("roundtrip: il testo decifra uguale all'originale e il formato è v1", async () => {
    vi.stubEnv("INTEGRATIONS_KEY", "chiave-di-test-non-produzione");
    const { sealSecret, openSecret } = await import("../src/crypto.js");
    const sealed = sealSecret("refresh-token-segreto-123");
    expect(sealed.startsWith("v1:")).toBe(true);
    expect(sealed).not.toContain("refresh-token-segreto-123");
    expect(openSecret(sealed)).toBe("refresh-token-segreto-123");
  });

  it("ciphertext manomesso: openSecret lancia", async () => {
    vi.stubEnv("INTEGRATIONS_KEY", "chiave-di-test-non-produzione");
    const { sealSecret, openSecret } = await import("../src/crypto.js");
    const sealed = sealSecret("valore-originale");
    const parts = sealed.split(":");
    const tampered = parts.slice(0, 3).join(":") + ":" + Buffer.from("altro-contenuto-ciffrato").toString("base64");
    expect(() => openSecret(tampered)).toThrow();
  });

  it("INTEGRATIONS_KEY assente: sealSecret e openSecret lanciano", async () => {
    vi.stubEnv("INTEGRATIONS_KEY", "");
    const { sealSecret, openSecret } = await import("../src/crypto.js");
    expect(() => sealSecret("x")).toThrow(/INTEGRATIONS_KEY/);
    expect(() => openSecret("v1:YQ==:YQ==:YQ==")).toThrow(/INTEGRATIONS_KEY/);
  });
});

describe("modelli Prisma", () => {
  it("le tabelle nuove esistono nel database di test", async () => {
    for (const table of ["notes", "calendar_events", "event_links", "sync_state"]) {
      const rows = await sql(`SELECT COUNT(*) AS n FROM ${table}`);
      expect(rows[0].n).toBeDefined();
    }
  });
});

describe("integrazioni", () => {
  it("status richiede la sessione (GET → 401)", async () => {
    const c = makeClient(base);
    const r = await c.request("/api/integrations/status", undefined, { public: true });
    expect(r.status).toBe(401);
  });

  it("status senza configurazione: tutto scollegato, nessun segreto nel payload", async () => {
    const c = await fresh();
    const r = await c.request("/api/integrations/status");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      key_configured: false,
      google: { connected: false, needs_reauth: false },
      apple: { connected: false },
      sender: "",
    });
    const raw = JSON.stringify(r.body);
    expect(raw).not.toContain("refresh");
    expect(raw).not.toContain("token");
    expect(raw).not.toContain("password");
  });

  it("google/connect: 400 senza env, URL OAuth valido con env", async () => {
    const c = await fresh();
    const missing = await c.request("/api/integrations/google/connect");
    expect(missing.status).toBe(400);

    vi.stubEnv("GOOGLE_CLIENT_ID", GOOGLE_ENV.GOOGLE_CLIENT_ID);
    vi.stubEnv("GOOGLE_CLIENT_SECRET", GOOGLE_ENV.GOOGLE_CLIENT_SECRET);
    vi.stubEnv("INTEGRATIONS_KEY", GOOGLE_ENV.INTEGRATIONS_KEY);

    const ok = await c.request("/api/integrations/google/connect");
    expect(ok.status).toBe(200);
    expect(ok.body.url).toContain("accounts.google.com");
    const decoded = decodeURIComponent(ok.body.url);
    expect(decoded).toContain(GOOGLE_ENV.GOOGLE_CLIENT_ID);
    expect(decoded).toContain("https://www.googleapis.com/auth/calendar.events");
    expect(decoded).toContain("/api/integrations/google/callback");
    expect(decoded).toContain("state=");
  });

  it("callback con state errato → 403, nessun salvataggio", async () => {
    const c = await fresh();
    vi.stubEnv("GOOGLE_CLIENT_ID", GOOGLE_ENV.GOOGLE_CLIENT_ID);
    vi.stubEnv("GOOGLE_CLIENT_SECRET", GOOGLE_ENV.GOOGLE_CLIENT_SECRET);
    vi.stubEnv("INTEGRATIONS_KEY", GOOGLE_ENV.INTEGRATIONS_KEY);
    stubGoogleTokenExchange(() =>
      new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const bad = await c.request("/api/integrations/google/callback?state=sbagliato&code=abc");
    expect(bad.status).toBe(403);
    expect((await c.request("/api/integrations/status")).body.google.connected).toBe(false);
    const rows = await sql("SELECT value FROM settings WHERE key = 'int_google'");
    expect(rows).toHaveLength(0);
  });

  it("callback valido: token cifrati in settings e status collegato", async () => {
    const c = await fresh();
    vi.stubEnv("GOOGLE_CLIENT_ID", GOOGLE_ENV.GOOGLE_CLIENT_ID);
    vi.stubEnv("GOOGLE_CLIENT_SECRET", GOOGLE_ENV.GOOGLE_CLIENT_SECRET);
    vi.stubEnv("INTEGRATIONS_KEY", GOOGLE_ENV.INTEGRATIONS_KEY);
    stubGoogleTokenExchange(() =>
      new Response(
        JSON.stringify({ access_token: "at-di-prova", refresh_token: "rt-segreto-456", expires_in: 3600 }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const connect = await c.request("/api/integrations/google/connect");
    const state = new URL(connect.body.url).searchParams.get("state");
    expect(state).toBeTruthy();

    const cb = await c.request(`/api/integrations/google/callback?state=${state}&code=code-di-prova`);
    expect(cb.status).toBe(200);

    const status = await c.request("/api/integrations/status");
    expect(status.body.google.connected).toBe(true);
    expect(status.body.key_configured).toBe(true);
    expect(JSON.stringify(status.body)).not.toContain("rt-segreto-456");
    expect(JSON.stringify(status.body)).not.toContain("at-di-prova");

    const rows = await sql("SELECT value FROM settings WHERE key = 'int_google'");
    expect(rows).toHaveLength(1);
    expect(rows[0].value.startsWith("v1:")).toBe(true);
    expect(rows[0].value).not.toContain("rt-segreto-456");
    expect(rows[0].value).not.toContain("at-di-prova");
  });

  it("scambio token fallito → 400 e nessun record parziale", async () => {
    const c = await fresh();
    vi.stubEnv("GOOGLE_CLIENT_ID", GOOGLE_ENV.GOOGLE_CLIENT_ID);
    vi.stubEnv("GOOGLE_CLIENT_SECRET", GOOGLE_ENV.GOOGLE_CLIENT_SECRET);
    vi.stubEnv("INTEGRATIONS_KEY", GOOGLE_ENV.INTEGRATIONS_KEY);
    stubGoogleTokenExchange(() => new Response("bad request", { status: 400 }));

    const connect = await c.request("/api/integrations/google/connect");
    const state = new URL(connect.body.url).searchParams.get("state");
    const cb = await c.request(`/api/integrations/google/callback?state=${state}&code=code-di-prova`);
    expect(cb.status).toBe(400);

    const status = await c.request("/api/integrations/status");
    expect(status.body.google.connected).toBe(false);
    const rows = await sql("SELECT value FROM settings WHERE key = 'int_google'");
    expect(rows).toHaveLength(0);
  });

  it("apple: login fallito → 400, login riuscito → collegato con mittente", async () => {
    const c = await fresh();
    vi.stubEnv("INTEGRATIONS_KEY", GOOGLE_ENV.INTEGRATIONS_KEY);

    imap.shouldFail = true;
    const ko = await c.request("/api/integrations/apple", {
      apple_id: "dany@icloud.com",
      app_password: "abcd-efgh-ijkl",
      sender_email: "dany@icloud.com",
    });
    expect(ko.status).toBe(400);
    expect((await c.request("/api/integrations/status")).body.apple.connected).toBe(false);

    imap.shouldFail = false;
    const ok = await c.request("/api/integrations/apple", {
      apple_id: "dany@icloud.com",
      app_password: "abcd-efgh-ijkl",
      sender_email: "dany@icloud.com",
    });
    expect(ok.status).toBe(200);
    expect(imap.connects).toBeGreaterThan(1);

    const status = await c.request("/api/integrations/status");
    expect(status.body.apple.connected).toBe(true);
    expect(status.body.sender).toBe("dany@icloud.com");
    expect(JSON.stringify(status.body)).not.toContain("abcd-efgh-ijkl");

    const rows = await sql("SELECT value FROM settings WHERE key = 'int_apple'");
    expect(rows[0].value.startsWith("v1:")).toBe(true);
    expect(rows[0].value).not.toContain("abcd-efgh-ijkl");

    const badSender = await c.request("/api/integrations/apple", {
      apple_id: "dany@icloud.com",
      app_password: "abcd-efgh-ijkl",
      sender_email: "non-email",
    });
    expect(badSender.status).toBe(400);
  });

  it("apple/delete disconnette l'account", async () => {
    const c = await fresh();
    vi.stubEnv("INTEGRATIONS_KEY", GOOGLE_ENV.INTEGRATIONS_KEY);
    const saved = await c.request("/api/integrations/apple", {
      apple_id: "dany@icloud.com",
      app_password: "abcd-efgh-ijkl",
      sender_email: "dany@icloud.com",
    });
    expect(saved.status).toBe(200);

    const del = await c.request("/api/integrations/apple/delete", {});
    expect(del.status).toBe(200);
    expect((await c.request("/api/integrations/status")).body.apple.connected).toBe(false);
    const rows = await sql("SELECT value FROM settings WHERE key = 'int_apple'");
    expect(rows).toHaveLength(0);
  });
});
