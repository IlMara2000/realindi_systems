// Strumenti: link brevi pubblici con conteggio dei clic e QR personalizzati.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startServer, type RunningServer } from "../scripts/dev-server.js";
import { httpFetch, makeClient, resetDb, type TestClient } from "./helpers.js";

let server: RunningServer;
let base: string;

// 1×1 PNG trasparente: basta a verificare che la foto venga accettata,
// conservata e servita con il tipo giusto.
const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

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

describe("accessi agli strumenti", () => {
  it("l'elenco richiede la sessione, il link breve no", async () => {
    const guest = makeClient(base);
    expect((await guest.request("/api/tools", undefined, { public: true })).status).toBe(401);
    expect((await guest.request("/api/tools/links", { target: "https://x.test" }, { public: true })).status).toBe(400);
    expect((await guest.request("/api/tools/qr/1/logo")).status).toBe(401);
    const miss = await httpFetch(base + "/l/inesistente", { redirect: "manual" });
    expect(miss.status).toBe(404);
  });
});

describe("link brevi", () => {
  it("conta clic grezzi e visite uniche, ignorando prefetch e browser diversi", async () => {
    const c = await fresh();
    const created = await c.request("/api/tools/links", {
      label: "Listino",
      target: "https://example.test/listino",
      slug: "listino",
    });
    expect(created.status).toBe(200);
    expect(created.body.slug).toBe("listino");

    const saved = (await c.state()).tools.links.find((l: any) => l.slug === "listino");
    expect(saved).toMatchObject({
      label: "Listino",
      target: "https://example.test/listino",
      clicks: 0,
      unique_visits: 0,
      active: true,
    });

    for (let i = 0; i < 2; i++) {
      const hop = await httpFetch(base + "/l/listino", { redirect: "manual" });
      expect(hop.status).toBe(302);
      expect(hop.headers.get("location")).toBe("https://example.test/listino");
    }
    let row = (await c.state()).tools.links.find((l: any) => l.slug === "listino");
    // Due clic grezzi ma una sola visita: stesso IP e stesso browser.
    expect(row.clicks).toBe(2);
    expect(row.unique_visits).toBe(1);

    // Un altro browser è una visita nuova.
    await httpFetch(base + "/l/listino", {
      redirect: "manual",
      headers: { "user-agent": "AltroBrowser/1.0" },
    });
    row = (await c.state()).tools.links.find((l: any) => l.slug === "listino");
    expect(row.clicks).toBe(3);
    expect(row.unique_visits).toBe(2);

    // Il prefetch non conta: né clic né visita.
    await httpFetch(base + "/l/listino", {
      redirect: "manual",
      headers: { "user-agent": "TerzoBrowser/1.0", "sec-purpose": "prefetch;prerender" },
    });
    row = (await c.state()).tools.links.find((l: any) => l.slug === "listino");
    expect(row.clicks).toBe(3);
    expect(row.unique_visits).toBe(2);
  });

  it("un link disattivato o eliminato non reindirizza più", async () => {
    const c = await fresh();
    await c.request("/api/tools/links", {
      label: "Listino",
      target: "https://example.test/listino",
      slug: "listino",
    });
    const saved = (await c.state()).tools.links.find((l: any) => l.slug === "listino");

    const off = await c.request("/api/tools/links", {
      id: saved.id,
      label: "Listino",
      target: "https://example.test/listino",
      slug: "listino",
      active: false,
    });
    expect(off.status).toBe(200);
    expect((await httpFetch(base + "/l/listino", { redirect: "manual" })).status).toBe(404);

    expect((await c.request("/api/tools/links/delete", { id: saved.id })).status).toBe(200);
    expect((await c.state()).tools.links).toEqual([]);
    expect((await httpFetch(base + "/l/listino", { redirect: "manual" })).status).toBe(404);
  });

  it("reindirizza anche verso un percorso interno", async () => {
    const c = await fresh();
    expect((await c.request("/api/tools/links", { target: "/book/prova", slug: "interno" })).status).toBe(200);
    const hop = await httpFetch(base + "/l/interno", { redirect: "manual" });
    expect(hop.status).toBe(302);
    expect(hop.headers.get("location")).toBe("/book/prova");
  });

  it("genera lo slug quando non è indicato e rifiuta i duplicati", async () => {
    const c = await fresh();
    const auto = await c.request("/api/tools/links", { target: "https://example.test/a", label: "Pagina servizi" });
    expect(auto.status).toBe(200);
    expect(auto.body.slug).toMatch(/^pagina-servizi-[a-z0-9]{5}$/);

    expect((await c.request("/api/tools/links", { target: "https://example.test/b", slug: "auto" })).status).toBe(200);
    expect((await c.request("/api/tools/links", { target: "https://example.test/c", slug: "auto" })).status).toBe(400);
  });

  it("accetta un percorso interno ma non schemi eseguibili", async () => {
    const c = await fresh();
    expect((await c.request("/api/tools/links", { target: "/book/prova" })).status).toBe(200);
    expect((await c.request("/api/tools/links", { target: "javascript:alert(1)" })).status).toBe(400);
    expect((await c.request("/api/tools/links", { target: "" })).status).toBe(400);
    // Lo slug viene normalizzato in minuscolo, non rifiutato.
    const upper = await c.request("/api/tools/links", { target: "https://ok.test", slug: "Maiuscolo" });
    expect(upper.status).toBe(200);
    expect(upper.body.slug).toBe("maiuscolo");
    expect((await c.request("/api/tools/links", { target: "https://ok.test", slug: "con spazio" })).status).toBe(400);
  });
});

describe("QR personalizzati", () => {
  it("salva con la foto al centro e la serve con il tipo corretto", async () => {
    const c = await fresh();
    const created = await c.request("/api/tools/qr", {
      title: "Scheda studio",
      payload: "https://example.test/studio",
      foreground: "#112233",
      background: "#ffffff",
      ecc: "H",
      logo_data: `data:image/png;base64,${PNG_1PX}`,
    });
    expect(created.status).toBe(200);

    const item = (await c.state()).tools.qr.find((q: any) => q.id === created.body.id);
    expect(item).toMatchObject({
      title: "Scheda studio",
      payload: "https://example.test/studio",
      foreground: "#112233",
      ecc: "H",
      has_logo: true,
    });

    const logo = await c.request(`/api/tools/qr/${created.body.id}/logo`);
    expect(logo.status).toBe(200);
    expect(logo.bytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    // La matrice si rigenera dal contenuto: dimensioni coerenti con le righe.
    const matrix = await c.request("/api/tools/qr/render", { payload: item.payload, ecc: "H" });
    expect(matrix.status).toBe(200);
    expect(matrix.body.size).toBeGreaterThan(20);
    expect(matrix.body.rows).toHaveLength(matrix.body.size);
    expect(matrix.body.rows[0]).toHaveLength(matrix.body.size);

    // Rimozione della foto e aggiornamento dei colori.
    const updated = await c.request("/api/tools/qr", {
      id: item.id,
      title: "Scheda studio",
      payload: item.payload,
      foreground: "#000000",
      background: "#ffeeaa",
      ecc: "Q",
      remove_logo: true,
    });
    expect(updated.status).toBe(200);
    const after = (await c.state()).tools.qr.find((q: any) => q.id === item.id);
    expect(after.has_logo).toBe(false);
    expect(after.ecc).toBe("Q");
    expect((await c.request(`/api/tools/qr/${item.id}/logo`)).status).toBe(400);

    expect((await c.request("/api/tools/qr/delete", { id: item.id })).status).toBe(200);
    expect((await c.state()).tools.qr).toEqual([]);
  });

  it("QR dinamico: contiene il link breve e segue la sua destinazione", async () => {
    const c = await fresh();
    const link = await c.request("/api/tools/links", { label: "Menu", target: "https://example.test/menu", slug: "menu" });
    expect(link.status).toBe(200);

    const dynamic = await c.request("/api/tools/qr", {
      title: "Menu al tavolo",
      link_id: link.body.id,
      payload: "",
    });
    expect(dynamic.status).toBe(200);
    const item = (await c.state()).tools.qr.find((q: any) => q.id === dynamic.body.id);
    expect(item).toMatchObject({ link_id: link.body.id, link_slug: "menu", payload: "" });

    // L'indirizzo definitivo si compone nel browser; il render usa quello.
    const rendered = await c.request("/api/tools/qr/render", {
      payload: `${base}/l/${item.link_slug}`,
      ecc: item.ecc,
    });
    expect(rendered.status).toBe(200);

    // Se il link sparisce il QR resta, senza riferimento: non si rompe nulla.
    expect((await c.request("/api/tools/links/delete", { id: link.body.id })).status).toBe(200);
    const orphan = (await c.state()).tools.qr.find((q: any) => q.id === dynamic.body.id);
    expect(orphan.link_id).toBeNull();
    expect((await c.request("/api/tools/qr/delete", { id: dynamic.body.id })).status).toBe(200);
  });

  it("rifiuta un QR dinamico che punta a un link inesistente", async () => {
    const c = await fresh();
    expect((await c.request("/api/tools/qr", { title: "Fantasma", link_id: 999, payload: "" })).status).toBe(400);
  });

  it("tiene la foto fuori dall'elenco e limita il contenuto del render", async () => {
    const c = await fresh();
    const created = await c.request("/api/tools/qr", {
      title: "Con foto",
      payload: "https://example.test",
      logo_data: `data:image/png;base64,${PNG_1PX}`,
    });
    expect(created.status).toBe(200);
    const item = (await c.state()).tools.qr.find((q: any) => q.id === created.body.id);
    expect("logo" in item).toBe(false);

    expect((await c.request("/api/tools/qr/render", { payload: "x".repeat(1201) })).status).toBe(400);
    const fallback = await c.request("/api/tools/qr/render", { payload: "ciao", ecc: "X" });
    expect(fallback.status).toBe(200);
    expect(fallback.body.ecc).toBe("H");
  });

  it("rifiuta colori, livelli e immagini non validi", async () => {
    const c = await fresh();
    const base = { title: "Prova", payload: "ciao" };
    expect((await c.request("/api/tools/qr", { ...base, foreground: "rosso" })).status).toBe(400);
    expect((await c.request("/api/tools/qr", { ...base, ecc: "X" })).status).toBe(400);
    expect((await c.request("/api/tools/qr", { ...base, title: "" })).status).toBe(400);
    expect((await c.request("/api/tools/qr", { ...base, payload: "" })).status).toBe(400);
    expect(
      (
        await c.request("/api/tools/qr", {
          ...base,
          logo_data: "data:image/png;base64,bm9uIHVuYSBpbW1hZ2luZQ==",
        })
      ).status,
    ).toBe(400);
    expect((await c.request("/api/tools/qr", { ...base, logo_data: "data:image/svg+xml;base64,PHN2Zz4=" })).status).toBe(400);
    expect(
      (await c.request("/api/tools/qr", { ...base, payload: "x".repeat(1201) })).status,
    ).toBe(400);
  });
});
