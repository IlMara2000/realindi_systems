// Sincronizzazione contatti: parser vCard, normalizzazione, CardDAV iCloud,
// People API Google, deduplica e legame al cliente del CRM.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { startServer, type RunningServer } from "../scripts/dev-server.js";
import { sql, makeClient, resetDb, type TestClient } from "./helpers.js";
import { normalizePhone, parseVcards } from "../src/contacts.js";

const KEY = "chiave-di-test-non-produzione";

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

// --------------------------------------------------------------- documenti DAV

const PRINCIPAL_DOC =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/123/principal/</d:href>' +
  "<d:propstat><d:prop><d:current-user-principal><d:href>/123/principal/</d:href>" +
  "</d:current-user-principal></d:prop></d:propstat></d:response></d:multistatus>";

const HOME_DOC =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">' +
  "<d:response><d:href>/123/principal/</d:href><d:propstat><d:prop>" +
  "<card:addressbook-home-set><d:href>/123/card/</d:href></card:addressbook-home-set>" +
  "</d:prop></d:propstat></d:response></d:multistatus>";

const LIST_DOC =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">' +
  "<d:response><d:href>/123/card/Default/</d:href><d:propstat><d:prop>" +
  "<d:resourcetype><d:collection/><card:addressbook/></d:resourcetype>" +
  "<d:displayname>Contatti</d:displayname><d:getctag>ctag-1</d:getctag>" +
  "</d:prop></d:propstat></d:response></d:multistatus>";

function vcard(fields: Record<string, string | string[]>): string {
  const lines = ["BEGIN:VCARD", "VERSION:3.0"];
  for (const [key, value] of Object.entries(fields)) {
    for (const v of Array.isArray(value) ? value : [value]) lines.push(`${key}:${v}`);
  }
  lines.push("END:VCARD");
  return lines.join("\r\n");
}

function reportDoc(cards: Array<{ href: string; etag: string; body: string }>): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">' +
    cards
      .map(
        (c) =>
          `<d:response><d:href>${c.href}</d:href><d:propstat><d:prop>` +
          `<d:getetag>"${c.etag}"</d:getetag>` +
          `<card:address-data>${c.body.replace(/&/g, "&amp;")}</card:address-data>` +
          "</d:prop></d:propstat></d:response>",
      )
      .join("") +
    "</d:multistatus>"
  );
}

describe("parser e normalizzazione", () => {
  it("legge i campi utili di una vCard, con email e telefoni multipli", () => {
    const [card] = parseVcards(
      vcard({
        UID: "uid-1",
        FN: "Mario Rossi",
        N: "Rossi;Mario;;;",
        EMAIL: ["mario@example.com", "m.rossi@studio.it"],
        TEL: "+39 333 123 4567",
        ORG: "Studio Rossi;Consulenza",
        TITLE: "Consulente",
      }),
      "https://p1-contacts.icloud.com/1/card/uno.vcf",
    );
    expect(card.display_name).toBe("Mario Rossi");
    expect(card.given_name).toBe("Mario");
    expect(card.family_name).toBe("Rossi");
    expect(card.org).toBe("Studio Rossi");
    expect(card.job_title).toBe("Consulente");
    expect(card.emails).toEqual(["mario@example.com", "m.rossi@studio.it"]);
    expect(card.phones).toEqual(["+39 333 123 4567"]);
    expect(card.uid).toBe("uid-1");
  });

  it("normalizza il telefono togliendo prefisso e spazi", () => {
    expect(normalizePhone("+39 333 123 4567")).toBe("3331234567");
    expect(normalizePhone("333.123.4567")).toBe("3331234567");
    expect(normalizePhone("")).toBe("");
  });
});

describe("POST /api/sync/contacts", () => {
  it("senza sessione → 400, senza account collegati → 400", async () => {
    const c = await fresh();
    const anon = makeClient(base);
    expect((await anon.request("/api/sync/contacts", {}, { public: true })).status).toBe(400);

    const none = await c.request("/api/sync/contacts", {});
    expect(none.status).toBe(400);
    expect(String(none.body.error)).toContain("Nessun account collegato");
  });

  it("iCloud: importa da CardDAV, fonde i doppioni per email e collega il cliente", async () => {
    const c = await fresh();
    await seedApple();
    await sql(
      "INSERT INTO clients(name, email, company, phone, vat_number, address, notes) VALUES ('Mario Rossi','mario@example.com','Studio Rossi','','','','')",
    );

    const cards = reportDoc([
      {
        href: "/123/card/Default/uno.vcf",
        etag: "e1",
        body: vcard({
          UID: "uid-mario",
          FN: "Mario Rossi",
          N: "Rossi;Mario;;;",
          EMAIL: "mario@example.com",
          TEL: "+39 333 123 4567",
          ORG: "Studio Rossi",
          TITLE: "Consulente",
        }),
      },
      {
        href: "/123/card/Default/due.vcf",
        etag: "e2",
        body: vcard({
          UID: "uid-mario-cellulare",
          FN: "Mario Rossi",
          EMAIL: "Mario@Example.com",
          TEL: "3331234567",
        }),
      },
    ]);

    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init: any = {}) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = String(init.method ?? "GET").toUpperCase();
      const body = typeof init.body === "string" ? init.body : "";
      // Solo i provider sono finti: il server di test parla con rete vera.
      if (!url.includes("icloud.com")) return real(input, init);

      const xml = (s: string) =>
        new Response(s, { status: 207, headers: { "content-type": "application/xml" } });
      if (method === "PROPFIND") {
        if (body.includes("addressbook-home-set")) return xml(HOME_DOC);
        if (body.includes("getctag")) return xml(LIST_DOC);
        return xml(PRINCIPAL_DOC);
      }
      if (method === "REPORT") return xml(cards);
      throw new Error(`richiesta inattesa: ${method} ${url}`);
    });

    const r = await c.request("/api/sync/contacts", {});
    expect(r.status).toBe(200);
    expect(r.body.errors).toEqual([]);
    expect(r.body.imported).toBe(1);
    expect(r.body.merged).toBe(1);
    expect(r.body.linked).toBe(1);

    const contatti = await sql("SELECT display_name, emails, phones, client_id FROM contacts");
    expect(contatti).toHaveLength(1);
    expect(contatti[0].display_name).toBe("Mario Rossi");
    expect(contatti[0].client_id).not.toBeNull();
    expect(JSON.parse(contatti[0].emails)).toContain("mario@example.com");

    const legami = await sql("SELECT source, remote_id FROM contact_links ORDER BY remote_id");
    expect(legami).toEqual([
      { source: "icloud", remote_id: "https://contacts.icloud.com/123/card/Default/due.vcf" },
      { source: "icloud", remote_id: "https://contacts.icloud.com/123/card/Default/uno.vcf" },
    ]);

    const stato = await sql("SELECT provider, ctag FROM sync_addressbooks");
    expect(stato).toEqual([{ provider: "icloud", ctag: "ctag-1" }]);

    // Secondo giro identico: nessun contatto in più.
    const r2 = await c.request("/api/sync/contacts", {});
    expect(r2.body.errors).toEqual([]);
    expect(r2.body.imported).toBe(0);
    expect(await sql("SELECT id FROM contacts")).toHaveLength(1);
  });

  it("iCloud che rifiuta le credenziali in sync spiega la revoca", async () => {
    const c = await fresh();
    await seedApple();

    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init: any = {}) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.includes("icloud.com")) return real(input, init);
      return new Response("denied", { status: 401 });
    });

    const r = await c.request("/api/sync/contacts", {});
    expect(r.status).toBe(200);
    expect(r.body.errors).toHaveLength(1);
    expect(r.body.errors[0].source).toBe("icloud");
    expect(r.body.errors[0].message).toContain("rifiutato le credenziali salvate");
    expect(r.body.errors[0].message).toContain("revocata o scaduta");
    expect(r.body.errors[0].message).toContain("l'interrogazione iniziale");
    expect(JSON.stringify(r.body)).not.toContain("abcd-efgh-ijkl");
  });

  it("iCloud irraggiungibile in sync riporta il guasto di rete, non le credenziali", async () => {
    const c = await fresh();
    await seedApple();

    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init: any = {}) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.includes("icloud.com")) return real(input, init);
      throw Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("getaddrinfo ENOTFOUND contacts.icloud.com"), {
          code: "ENOTFOUND",
        }),
      });
    });

    const r = await c.request("/api/sync/contacts", {});
    expect(r.body.errors[0].message).toContain("non si risolve");
    expect(r.body.errors[0].message).not.toContain("credenziali");
  });

  it("Google: importa da People API, aggiorna in incrementale ed elimina i cancellati", async () => {
    const c = await fresh();
    await seedGoogle();

    const anna = (extra: Record<string, unknown> = {}) => ({
      resourceName: "people/c1",
      etag: '"e-anna"',
      names: [{ displayName: "Anna Bianchi", givenName: "Anna", familyName: "Bianchi" }],
      emailAddresses: [{ value: "anna@example.com" }],
      metadata: { sources: [{ updateTime: "2026-11-01T10:00:00Z" }] },
      ...extra,
    });
    const bruno = {
      resourceName: "people/c2",
      names: [{ displayName: "Bruno Verdi" }],
      emailAddresses: [{ value: "bruno@example.com" }],
      metadata: { sources: [{ updateTime: "2026-11-01T10:00:00Z" }] },
    };

    let giro = 0;
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init: any = {}) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.includes("people.googleapis.com")) return real(input, init);
      const token = new URL(url).searchParams.get("syncToken");
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      giro += 1;
      if (!token) {
        return json({ connections: [anna(), bruno], nextSyncToken: "ptok-1" });
      }
      return json({
        connections: [
          anna({
            phoneNumbers: [{ value: "+39 333 999 8877" }],
            metadata: { sources: [{ updateTime: "2026-11-10T10:00:00Z" }] },
          }),
          { ...bruno, metadata: { deleted: true, sources: [{ updateTime: "2026-11-10T10:00:00Z" }] } },
        ],
        nextSyncToken: "ptok-2",
      });
    });

    const primo = await c.request("/api/sync/contacts", {});
    expect(primo.status).toBe(200);
    expect(primo.body.errors).toEqual([]);
    expect(primo.body.imported).toBe(2);

    const stato1 = await sql("SELECT sync_token FROM sync_addressbooks WHERE provider = 'google'");
    expect(stato1[0].sync_token).toBe("ptok-1");

    const secondo = await c.request("/api/sync/contacts", {});
    expect(secondo.status).toBe(200);
    expect(secondo.body.errors).toEqual([]);
    expect(secondo.body.imported).toBe(0);
    expect(secondo.body.updated).toBe(1);
    expect(secondo.body.removed).toBe(1);
    expect(giro).toBe(2);

    // Anna aggiornata con il telefono, Bruno tombstonato e senza legame.
    const annaRiga = await sql("SELECT phones FROM contacts WHERE display_name = 'Anna Bianchi'");
    expect(JSON.parse(annaRiga[0].phones)).toEqual(["+39 333 999 8877"]);
    const brunoRiga = await sql("SELECT deleted_at FROM contacts WHERE display_name = 'Bruno Verdi'");
    expect(brunoRiga[0].deleted_at).toBeTruthy();
    expect(await sql("SELECT source FROM contact_links")).toEqual([{ source: "google" }]);

    const stato2 = await sql("SELECT sync_token FROM sync_addressbooks WHERE provider = 'google'");
    expect(stato2[0].sync_token).toBe("ptok-2");
  });
});
