// Sezione email: invio SMTP Apple con ICS e inbox via Apple/Google.
// Le asserzioni riprendono il Task 9 del piano approvato.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { startServer, type RunningServer } from "../scripts/dev-server.js";
import { sql, makeClient, resetDb, type TestClient } from "./helpers.js";

const KEY = "chiave-di-test-non-produzione";

const mocks = vi.hoisted(() => ({
  sendMail: vi.fn(async (_opts: any) => ({ messageId: "m1" })),
  imapMessages: [] as any[],
  imapConnects: 0,
  shouldFailConnect: false,
}));

vi.mock("nodemailer", () => ({
  createTransport: () => ({ sendMail: mocks.sendMail }),
}));

vi.mock("imapflow", () => ({
  ImapFlow: class {
    async connect() {
      mocks.imapConnects += 1;
      if (mocks.shouldFailConnect) throw new Error("Invalid login credentials");
    }
    async mailboxOpen() {
      return { exists: mocks.imapMessages.length };
    }
    async *fetch() {
      for (const m of mocks.imapMessages) yield m;
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
  mocks.sendMail.mockClear();
  mocks.imapMessages = [];
  mocks.imapConnects = 0;
  mocks.shouldFailConnect = false;
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

async function seal(value: unknown): Promise<string> {
  const { sealSecret } = await import("../src/crypto.js");
  return sealSecret(JSON.stringify(value));
}

async function seedApple(): Promise<void> {
  vi.stubEnv("INTEGRATIONS_KEY", KEY);
  const sealed = await seal({ apple_id: "dany@icloud.com", app_password: "abcd-efgh-ijkl" });
  await sql("INSERT INTO settings(key, value) VALUES ($1, $2)", ["int_apple", sealed]);
  await sql("INSERT INTO settings(key, value) VALUES ('int_apple_status', 'connected')");
  await sql("INSERT INTO settings(key, value) VALUES ('email_sender', 'dany@icloud.com')");
}

async function seedGoogle(): Promise<void> {
  vi.stubEnv("INTEGRATIONS_KEY", KEY);
  vi.stubEnv("GOOGLE_CLIENT_ID", "cid-di-test");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "csec-di-test");
  const sealed = await seal({
    access_token: "at-di-prova",
    refresh_token: "rt-di-prova",
    expires_at: Date.now() + 3600_000,
  });
  await sql("INSERT INTO settings(key, value) VALUES ($1, $2)", ["int_google", sealed]);
  await sql("INSERT INTO settings(key, value) VALUES ('int_google_status', 'connected')");
}

describe("accessi /api/email", () => {
  it("GET inbox senza sessione → 401, POST send senza sessione → 400", async () => {
    const c = makeClient(base);
    const inbox = await c.request("/api/email/inbox", undefined, { public: true });
    expect(inbox.status).toBe(401);
    const send = await c.request("/api/email/send", { to: "a@b.com", subject: "x", body: "" }, { public: true });
    expect(send.status).toBe(400);
  });
});

describe("POST /api/email/send", () => {
  it("senza Apple collegato → 400", async () => {
    const c = await fresh();
    const r = await c.request("/api/email/send", { to: "cliente@example.com", subject: "Oggetto", body: "Testo" });
    expect(r.status).toBe(400);
    expect(mocks.sendMail).not.toHaveBeenCalled();
  });

  it("invia dal mittente configurato e allega l'ICS quando richiesto", async () => {
    const c = await fresh();
    await seedApple();
    const r = await c.request("/api/email/send", {
      to: "cliente@example.com",
      subject: "Proposta",
      body: "In allegato l'invito.",
      ics: { title: "Call cliente", start: "2026-11-10T10:00:00.000Z", end: "2026-11-10T11:00:00.000Z" },
    });
    expect(r.status).toBe(200);
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
    const opts = mocks.sendMail.mock.calls[0][0];
    expect(opts.from).toContain("dany@icloud.com");
    expect(opts.to).toBe("cliente@example.com");
    expect(opts.subject).toBe("Proposta");
    expect(opts.attachments).toHaveLength(1);
    expect(opts.attachments[0].filename).toBe("invito.ics");
    expect(String(opts.attachments[0].content)).toContain("BEGIN:VCALENDAR");
    expect(String(opts.attachments[0].content)).toContain("Call cliente");
  });

  it("validazione: destinatario e oggetto", async () => {
    const c = await fresh();
    await seedApple();
    expect((await c.request("/api/email/send", { to: "non-email", subject: "x", body: "" })).status).toBe(400);
    expect((await c.request("/api/email/send", { to: "a@b.com", subject: "", body: "" })).status).toBe(400);
    expect(
      (await c.request("/api/email/send", { to: "a@b.com", subject: "x".repeat(201), body: "" })).status,
    ).toBe(400);
    expect(
      (await c.request("/api/email/send", { to: "a@b.com", subject: "ok", body: "", ics: { title: "t", start: "ieri", end: "poi" } }))
        .status,
    ).toBe(400);
  });
});

describe("GET /api/email/inbox", () => {
  it("nessun provider collegato → 400", async () => {
    const c = await fresh();
    const r = await c.request("/api/email/inbox");
    expect(r.status).toBe(400);
  });

  it("Apple: restituisce envelope e snippet senza esporre le credenziali", async () => {
    const c = await fresh();
    await seedApple();
    mocks.imapMessages = [
      {
        uid: 7,
        seq: 7,
        envelope: {
          from: [{ address: "cliente@example.com", name: "Cliente" }],
          subject: "Ricevuto",
          date: "2026-11-01T10:00:00.000Z",
        },
        bodyParts: new Map([["TEXT", Buffer.from("Anteprima del testo della mail.", "utf8")]]),
      },
    ];

    const r = await c.request("/api/email/inbox");
    expect(r.status).toBe(200);
    expect(r.body.provider).toBe("apple");
    expect(r.body.messages).toHaveLength(1);
    expect(r.body.messages[0]).toMatchObject({
      id: 7,
      from: "cliente@example.com",
      subject: "Ricevuto",
      snippet: "Anteprima del testo della mail.",
    });
    expect(r.body.messages[0].snippet.length).toBeLessThanOrEqual(200);
    const raw = JSON.stringify(r.body);
    expect(raw).not.toContain("abcd-efgh-ijkl");
    expect(raw).not.toContain("app_password");
  });

  it("solo Google collegato: inbox via Gmail API con provider gmail", async () => {
    const c = await fresh();
    await seedGoogle();

    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages?")) {
        return new Response(JSON.stringify({ messages: [{ id: "m1" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages/m1")) {
        return new Response(
          JSON.stringify({
            id: "m1",
            internalDate: "1793504000000",
            snippet: "Dalla casella Gmail.",
            payload: {
              headers: [
                { name: "From", value: "partner@example.com" },
                { name: "Subject", value: "Contratto" },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return real(input, init);
    });

    const r = await c.request("/api/email/inbox");
    expect(r.status).toBe(200);
    expect(r.body.provider).toBe("gmail");
    expect(r.body.messages).toHaveLength(1);
    expect(r.body.messages[0]).toMatchObject({
      id: "m1",
      from: "partner@example.com",
      subject: "Contratto",
      snippet: "Dalla casella Gmail.",
    });
    expect(JSON.stringify(r.body)).not.toContain("rt-di-prova");
    expect(JSON.stringify(r.body)).not.toContain("at-di-prova");
  });
});
