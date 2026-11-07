// Engine di sync calendario: logica pura (LWW, finestra, filtri) e
// orchestrazione outbound/inbound con provider mockati via fetch.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { startServer, type RunningServer } from "../scripts/dev-server.js";
import { sql, makeClient, resetDb, type TestClient } from "./helpers.js";
import { mergeRemote, isImportable, windowRange } from "../src/sync.js";

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

async function seedApple(): Promise<void> {
  vi.stubEnv("INTEGRATIONS_KEY", KEY);
  const sealed = await seal({ apple_id: "dany@icloud.com", app_password: "abcd-efgh-ijkl" });
  await sql("INSERT INTO settings(key, value) VALUES ($1, $2)", ["int_apple", sealed]);
  await sql("INSERT INTO settings(key, value) VALUES ('int_apple_status', 'connected')");
  await sql("INSERT INTO settings(key, value) VALUES ('email_sender', 'dany@icloud.com')");
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/** Intercetta solo Google/Apple; tutto il resto usa la rete reale. */
function spyProviders(router: (call: Call) => Response | Promise<Response>): Call[] {
  const real = globalThis.fetch;
  const log: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init: any = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const call: Call = {
      url,
      method: String(init.method ?? "GET").toUpperCase(),
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === "string" ? init.body : "",
    };
    log.push(call);
    if (url.includes("googleapis.com") || url.includes("icloud.com")) return router(call);
    return real(input, init);
  });
  return log;
}

async function makeEvent(c: TestClient, title: string, start: string, end: string): Promise<number> {
  const r = await c.request("/api/events", { title, start, end });
  if (r.status !== 200) throw new Error(`events ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body.id;
}

describe("logica pura di sync", () => {
  it("mergeRemote: create, vince il locale sporco, update e skip", () => {
    expect(mergeRemote(null, { updated_at: 1000 })).toBe("create");
    expect(mergeRemote({ updated_at: 500, dirty: true }, { updated_at: 1000 })).toBe("skip_local_wins");
    expect(mergeRemote({ updated_at: 500, dirty: false }, { updated_at: 1000 })).toBe("update");
    expect(mergeRemote({ updated_at: 1500, dirty: false }, { updated_at: 1000 })).toBe("skip");
    expect(mergeRemote({ updated_at: 500n, dirty: false }, { updated_at: 1000 })).toBe("update");
  });

  it("isImportable esclude i tipi personali di Google", () => {
    for (const t of ["fromGmail", "birthday", "outOfOffice", "workingLocation"]) {
      expect(isImportable({ eventType: t })).toBe(false);
    }
    expect(isImportable({ eventType: "default" })).toBe(true);
    expect(isImportable({})).toBe(true);
  });

  it("windowRange copre -1 mese / +4 mesi", () => {
    const { from, to } = windowRange(new Date("2026-11-03T12:00:00Z"));
    expect(from).toBe("2026-10-03");
    expect(to).toBe("2027-03-03");
  });
});

describe("POST /api/sync/calendar", () => {
  it("nessun calendario collegato → 400", async () => {
    const c = await fresh();
    const r = await c.request("/api/sync/calendar", {});
    expect(r.status).toBe(400);
  });

  it("outbound: spinge l'evento dirty su Google e pulisce i legami", async () => {
    const c = await fresh();
    await seedGoogle();
    await makeEvent(c, "Call cliente", "2026-11-10T10:00:00.000Z", "2026-11-10T11:00:00.000Z");

    const log = spyProviders((call) => {
      if (call.method === "POST" && call.url.includes("/calendars/primary/events")) {
        return new Response(
          JSON.stringify({ id: "g-evt-1", etag: "\"etag-1\"", updated: "2026-11-03T10:00:00Z" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ items: [], nextSyncToken: "tok-0" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const r = await c.request("/api/sync/calendar", {});
    expect(r.status).toBe(200);
    expect(r.body.errors).toEqual([]);

    const create = log.find((x) => x.method === "POST" && x.url.includes("/calendars/primary/events"));
    expect(create).toBeDefined();
    expect(create!.body).toContain("Call cliente");

    const links = await sql("SELECT * FROM event_links");
    expect(links).toHaveLength(1);
    expect(links[0].source).toBe("google");
    expect(links[0].external_id).toBe("g-evt-1");
    expect(links[0].dirty).toBe(false);

    const events = await sql("SELECT dirty FROM calendar_events");
    expect(events).toHaveLength(1);
    expect(events[0].dirty).toBe(false);
    expect(r.body.pending).toBe(0);
  });

  it("outbound: con Google e iCloud insieme l'evento arriva a tutti e due", async () => {
    const c = await fresh();
    await seedGoogle();
    await seedApple();
    const calendar = "https://p21-caldav.icloud.com/1234567890/calendars/Home/";
    await sql("INSERT INTO sync_state(provider, calendar_path) VALUES ('icloud', $1)", [calendar]);
    await makeEvent(c, "Sopralluogo", "2026-11-13T10:00:00.000Z", "2026-11-13T11:00:00.000Z");

    const log = spyProviders((call) => {
      if (call.url.includes("googleapis.com")) {
        if (call.method === "POST") {
          return new Response(
            JSON.stringify({ id: "g-evt-1", etag: "\"etag-g\"", updated: "2026-11-07T09:00:00Z" }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ items: [], nextSyncToken: "tok-0" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (call.method === "PUT") {
        return new Response(null, { status: 201, headers: { ETag: "\"etag-i\"" } });
      }
      return new Response(
        '<?xml version="1.0" encoding="UTF-8"?><d:multistatus xmlns:d="DAV:"></d:multistatus>',
        { status: 207, headers: { "content-type": "application/xml" } },
      );
    });

    const r = await c.request("/api/sync/calendar", {});
    expect(r.status).toBe(200);
    expect(r.body.errors).toEqual([]);
    expect(r.body.imported).toBe(0);
    expect(r.body.pending).toBe(0);

    // Un solo invio per provider: Google POST, iCloud PUT.
    const posts = log.filter((x) => x.method === "POST" && x.url.includes("googleapis.com"));
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toContain("Sopralluogo");

    const puts = log.filter((x) => x.method === "PUT" && x.url.includes("icloud.com"));
    expect(puts).toHaveLength(1);
    expect(puts[0].url.startsWith(calendar)).toBe(true);
    expect(puts[0].url.endsWith(".ics")).toBe(true);
    expect(puts[0].body).toContain("SUMMARY:Sopralluogo");

    // Un evento, due legami puliti.
    const links = await sql("SELECT source, external_id, dirty FROM event_links ORDER BY source");
    expect(links.map((l) => l.source)).toEqual(["google", "icloud"]);
    expect(links[0].external_id).toBe("g-evt-1");
    expect(links[1].external_id).toBe(puts[0].url);
    expect(links.every((l) => l.dirty === false)).toBe(true);

    const events = await sql("SELECT dirty FROM calendar_events");
    expect(events).toHaveLength(1);
    expect(events[0].dirty).toBe(false);

    // Seconda sincronizzazione: il flag è davvero spento, niente da rispingere.
    const r2 = await c.request("/api/sync/calendar", {});
    expect(r2.body.errors).toEqual([]);
    expect(r2.body.pending).toBe(0);
    expect(log.filter((x) => x.method === "POST" && x.url.includes("googleapis.com"))).toHaveLength(1);
    expect(log.filter((x) => x.method === "PUT" && x.url.includes("icloud.com"))).toHaveLength(1);
    expect(await sql("SELECT id FROM calendar_events")).toHaveLength(1);
    expect(await sql("SELECT id FROM event_links")).toHaveLength(2);
  });

  it("eliminato in locale: sparisce da Google e iCloud in una sola sincronizzazione", async () => {
    const c = await fresh();
    await seedGoogle();
    await seedApple();
    const calendar = "https://p21-caldav.icloud.com/1234567890/calendars/Home/";
    await sql("INSERT INTO sync_state(provider, calendar_path) VALUES ('icloud', $1)", [calendar]);
    const id = await makeEvent(
      c,
      "Riunione annullata",
      "2026-11-14T09:00:00.000Z",
      "2026-11-14T10:00:00.000Z",
    );

    // L'evento è già stato pubblicato su entrambi i calendari.
    await sql(
      "INSERT INTO event_links(event_id, source, external_id, etag, dirty) VALUES ($1, 'google', 'g-evt-1', 'etag-g', false)",
      [id],
    );
    await sql(
      "INSERT INTO event_links(event_id, source, external_id, etag, dirty) VALUES ($1, 'icloud', $2, 'abc', false)",
      [id, calendar + "vecchio.ics"],
    );

    const del = await c.request("/api/events/delete", { id });
    expect(del.status).toBe(200);

    const log = spyProviders((call) => {
      if (call.url.includes("googleapis.com")) {
        return new Response(JSON.stringify({ items: [], nextSyncToken: "tok-0" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        '<?xml version="1.0" encoding="UTF-8"?><d:multistatus xmlns:d="DAV:"></d:multistatus>',
        { status: 207, headers: { "content-type": "application/xml" } },
      );
    });

    const r = await c.request("/api/sync/calendar", {});
    expect(r.status).toBe(200);
    expect(r.body.errors).toEqual([]);
    expect(r.body.pending).toBe(0);

    // Un DELETE per provider, nella stessa sincronizzazione.
    const deletes = log.filter((x) => x.method === "DELETE");
    expect(deletes).toHaveLength(2);
    const googleDel = deletes.find((x) => x.url.includes("googleapis.com"));
    const icloudDel = deletes.find((x) => x.url.includes("icloud.com"));
    expect(googleDel!.url).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events/g-evt-1",
    );
    expect(icloudDel!.url).toBe(calendar + "vecchio.ics");
    expect(icloudDel!.headers["If-Match"]).toBe('"abc"');

    // Nessuna traccia locale: prima i legami, poi la riga dell'evento.
    expect(await sql("SELECT id FROM event_links")).toHaveLength(0);
    expect(await sql("SELECT id FROM calendar_events")).toHaveLength(0);
  });

  it("annullato su iCloud: rimosso in locale e il legame Google resta", async () => {
    const c = await fresh();
    await seedGoogle();
    await seedApple();
    const calendar = "https://p21-caldav.icloud.com/1234567890/calendars/Home/";
    await sql("INSERT INTO sync_state(provider, calendar_path) VALUES ('icloud', $1)", [calendar]);
    await makeEvent(c, "Sopralluogo", "2026-11-15T10:00:00.000Z", "2026-11-15T11:00:00.000Z");

    // Stato del finto server: la risorsa scritta via PUT e se è stata annullata.
    let icsInviato: { url: string; body: string } | null = null;
    let annullato = false;

    const log = spyProviders((call) => {
      if (call.url.includes("googleapis.com")) {
        if (call.method === "POST") {
          return new Response(
            JSON.stringify({ id: "g-evt-1", etag: "\"etag-g\"", updated: "2026-11-07T09:00:00Z" }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ items: [], nextSyncToken: "tok-0" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (call.method === "PUT") {
        icsInviato = { url: call.url, body: call.body };
        return new Response(null, { status: 201, headers: { ETag: "\"etag-i\"" } });
      }
      if (call.method === "DELETE") return new Response(null, { status: 204 });

      const inviato = icsInviato;
      if (!annullato || !inviato) {
        return new Response(
          '<?xml version="1.0" encoding="UTF-8"?><d:multistatus xmlns:d="DAV:"></d:multistatus>',
          { status: 207, headers: { "content-type": "application/xml" } },
        );
      }
      // iCloud restituisce la stessa risorsa con STATUS:CANCELLED.
      const ics = inviato.body.replace("STATUS:CONFIRMED", "STATUS:CANCELLED");
      return new Response(
        '<?xml version="1.0" encoding="UTF-8"?>' +
          '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">' +
          "<d:response><d:href>" +
          new URL(inviato.url).pathname +
          "</d:href>" +
          '<d:propstat><d:prop><d:getetag>"etag-i"</d:getetag>' +
          "<c:calendar-data>" +
          ics +
          "</c:calendar-data>" +
          "</d:prop></d:propstat></d:response>" +
          "</d:multistatus>",
        { status: 207, headers: { "content-type": "application/xml" } },
      );
    });

    // 1. Prima sincronizzazione: l'evento viene pubblicato su entrambi i provider.
    const primo = await c.request("/api/sync/calendar", {});
    expect(primo.body.errors).toEqual([]);
    expect((await sql("SELECT source FROM event_links ORDER BY source")).map((l) => l.source)).toEqual([
      "google",
      "icloud",
    ]);
    expect(icsInviato).not.toBeNull();

    // 2. L'evento viene annullato su iCloud.
    annullato = true;
    const secondo = await c.request("/api/sync/calendar", {});
    expect(secondo.status).toBe(200);
    expect(secondo.body.errors).toEqual([]);
    expect(secondo.body.removed).toBe(1);
    expect(secondo.body.pending).toBe(1);

    const evento = await sql("SELECT deleted_at FROM calendar_events");
    expect(evento).toHaveLength(1);
    expect(evento[0].deleted_at).toBeTruthy();

    // Il legame iCloud si consuma, quello Google resta intatto.
    expect(await sql("SELECT source, external_id FROM event_links")).toEqual([
      { source: "google", external_id: "g-evt-1" },
    ]);
    expect(log.filter((x) => x.method === "DELETE")).toHaveLength(0);

    // 3. Alla sincronizzazione successiva il tombstone si propaga a Google.
    const terzo = await c.request("/api/sync/calendar", {});
    expect(terzo.body.errors).toEqual([]);
    expect(terzo.body.pending).toBe(0);
    const deletes = log.filter((x) => x.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0].url).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events/g-evt-1",
    );
    expect(await sql("SELECT id FROM calendar_events")).toHaveLength(0);
    expect(await sql("SELECT id FROM event_links")).toHaveLength(0);
  });

  it("inbound: importa dalla finestra ed esclude i tipi personali", async () => {
    const c = await fresh();
    await seedGoogle();

    const log = spyProviders(() =>
      new Response(
        JSON.stringify({
          items: [
            {
              id: "g1",
              summary: "Kickoff progetto",
              start: { dateTime: "2026-11-05T10:00:00Z" },
              end: { dateTime: "2026-11-05T11:00:00Z" },
              updated: "2026-11-01T08:00:00Z",
              etag: "\"x1\"",
              eventType: "default",
            },
            {
              id: "g2",
              summary: "Compleanni",
              start: { date: "2026-11-06" },
              end: { date: "2026-11-07" },
              updated: "2026-11-01T08:00:00Z",
              etag: "\"x2\"",
              eventType: "birthday",
            },
          ],
          nextSyncToken: "tok-1",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const r = await c.request("/api/sync/calendar", {});
    expect(r.status).toBe(200);
    expect(r.body.imported).toBe(1);
    expect(r.body.errors).toEqual([]);

    const list = log.find((x) => x.url.includes("/calendars/primary/events"));
    expect(list).toBeDefined();
    expect(list!.url).toContain("timeMin=");
    expect(list!.url).toContain("timeMax=");

    const titles = (await sql("SELECT title FROM calendar_events")).map((x) => x.title);
    expect(titles).toEqual(["Kickoff progetto"]);

    const links = await sql("SELECT source, external_id FROM event_links");
    expect(links).toEqual([{ source: "google", external_id: "g1" }]);

    const state = await sql("SELECT token FROM sync_state WHERE provider = 'google'");
    expect(state[0].token).toBe("tok-1");
  });

  it("410 GONE: riparte dal full sync senza syncToken", async () => {
    const c = await fresh();
    await seedGoogle();
    await sql("INSERT INTO sync_state(provider, token) VALUES ('google', 'vecchio-token')");

    const log = spyProviders((call) => {
      if (call.url.includes("syncToken=vecchio-token")) {
        return new Response("Gone", { status: 410 });
      }
      return new Response(JSON.stringify({ items: [], nextSyncToken: "tok-2" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const r = await c.request("/api/sync/calendar", {});
    expect(r.status).toBe(200);

    const listCalls = log.filter((x) => x.url.includes("/calendars/primary/events"));
    expect(listCalls).toHaveLength(2);
    expect(listCalls[0].url).toContain("syncToken=vecchio-token");
    expect(listCalls[1].url).not.toContain("syncToken=");
    expect(listCalls[1].url).toContain("timeMin=");

    const state = await sql("SELECT token FROM sync_state WHERE provider = 'google'");
    expect(state[0].token).toBe("tok-2");
  });

  it("provider in errore: errors[], nessun segreto in risposta, dati locali intatti", async () => {
    const c = await fresh();
    await seedApple();
    await sql(
      "INSERT INTO sync_state(provider, calendar_path) VALUES ('icloud', 'https://p21-caldav.icloud.com/1234567890/calendars/Home/')",
    );
    await makeEvent(c, "Da spingere", "2026-11-11T09:00:00.000Z", "2026-11-11T10:00:00.000Z");

    spyProviders(() => {
      throw new Error("connessione rifiutata");
    });

    const r = await c.request("/api/sync/calendar", {});
    expect(r.status).toBe(200);
    expect(r.body.errors).toHaveLength(1);
    expect(r.body.errors[0].source).toBe("icloud");
    expect(r.body.pending).toBeGreaterThan(0);

    const raw = JSON.stringify(r.body);
    expect(raw).not.toContain("abcd-efgh-ijkl");
    expect(raw).not.toContain("dany@icloud.com");

    const events = await sql("SELECT dirty FROM calendar_events");
    expect(events[0].dirty).toBe(true);
  });

  it("caldav: PUT con If-Match quotato quando il legame ha l'etag", async () => {
    const c = await fresh();
    await seedApple();
    await sql(
      "INSERT INTO sync_state(provider, calendar_path) VALUES ('icloud', 'https://p21-caldav.icloud.com/1234567890/calendars/Home/')",
    );
    const id = await makeEvent(c, "Aggiorna su iCloud", "2026-11-12T09:00:00.000Z", "2026-11-12T10:00:00.000Z");
    await sql(
      "INSERT INTO event_links(event_id, source, external_id, etag, dirty) VALUES ($1, 'icloud', $2, $3, true)",
      [id, "https://p21-caldav.icloud.com/1234567890/calendars/Home/vecchio.ics", "abc"],
    );

    const log = spyProviders((call) => {
      if (call.method === "PUT") {
        return new Response(null, { status: 204, headers: { ETag: "\"nuova-etag\"" } });
      }
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?><d:multistatus xmlns:d="DAV:"></d:multistatus>`,
        { status: 207, headers: { "content-type": "application/xml" } },
      );
    });

    const r = await c.request("/api/sync/calendar", {});
    expect(r.status).toBe(200);
    expect(r.body.errors).toEqual([]);

    const put = log.find((x) => x.method === "PUT" && x.url.includes("vecchio.ics"));
    expect(put).toBeDefined();
    expect(put!.headers["If-Match"]).toBe("\"abc\"");
    expect(put!.body).toContain("Aggiorna su iCloud");

    const links = await sql("SELECT etag, dirty FROM event_links");
    expect(links).toHaveLength(1);
    expect(links[0].dirty).toBe(false);
    expect(links[0].etag).toBe("nuova-etag");
  });
});
