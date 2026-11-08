// Routing del sito: / -> sito pubblico, /app -> CRM, /bio -> link-in-bio,
// /book/<slug> -> SPA booking (app.html). Statici nuovi serviti.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startServer, type RunningServer } from "../scripts/dev-server.js";
// Side-effect: carica DATABASE_URL_TEST da .env come helpers.ts.
import "./helpers.js";
import { httpFetch, makeClient, resetDb, sql } from "./helpers.js";

let server: RunningServer;
let base: string;

beforeAll(async () => {
  server = await startServer(0);
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
});

async function get(path: string) {
  const res = await httpFetch(base + path);
  const text = await res.text();
  return { status: res.status, text, type: res.headers.get("content-type") ?? "" };
}

async function getBytes(path: string) {
  const res = await httpFetch(base + path);
  const buf = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, buf, type: res.headers.get("content-type") ?? "" };
}

describe("routing sito", () => {
  it("/ serve il sito pubblico", async () => {
    const r = await get("/");
    expect(r.status).toBe(200);
    expect(r.type).toContain("text/html");
    expect(r.text).toContain('id="site-root"');
  });

  it("/app serve il CRM", async () => {
    const r = await get("/app");
    expect(r.status).toBe(200);
    expect(r.type).toContain("text/html");
    expect(r.text).toContain('id="root"');
  });

  it("/bio serve la pagina link-in-bio", async () => {
    const r = await get("/bio");
    expect(r.status).toBe(200);
    expect(r.type).toContain("text/html");
    expect(r.text).toContain('id="bio-root"');
  });

  it("/book/<slug> serve la SPA booking (CRM)", async () => {
    const r = await get("/book/prova");
    expect(r.status).toBe(200);
    expect(r.text).toContain('id="root"');
  });

  it("asset statici nuovi ed esistenti", async () => {
    const css = await get("/site.css");
    expect(css.status).toBe(200);
    expect(css.type).toContain("text/css");
    const js = await get("/site.js");
    expect(js.status).toBe(200);
    expect(js.type).toContain("text/javascript");
    const legacy = await get("/style.css");
    expect(legacy.status).toBe(200);
    const app = await get("/app.js");
    expect(app.status).toBe(200);
    const avvisi = await get("/limiti-assistente.js");
    expect(avvisi.status).toBe(200);
    expect(avvisi.type).toContain("text/javascript");
    expect(avvisi.text).toContain("mountLimitiAssistente");
  });

  it("la home ha le sezioni del sito freelance", async () => {
    const r = await get("/");
    expect(r.text).toContain("01 / SERVIZI");
    expect(r.text).toContain("Area riservata");
    expect(r.text).toContain("REALINDI SYSTEMS");
  });

  it("nessuna risorsa esterna caricata da script o fogli di stile (CSP)", async () => {
    const home = await get("/");
    expect(home.text).not.toMatch(/<(script|link)[^>]+(src|href)=["']https?:/);
    const bio = await get("/bio");
    expect(bio.text).not.toMatch(/<(script|link)[^>]+(src|href)=["']https?:/);
  });

  it("la pagina bio ha il mount dei link e carica site.js", async () => {
    const r = await get("/bio");
    expect(r.text).toContain('id="bio-links"');
    expect(r.text).toContain('<script src="/site.js"></script>');
  });

  it("site.css dichiara i colori del marchio e le ombre neumorphic", async () => {
    const css = await get("/site.css");
    expect(css.text).toContain("--brand: #141418");
    expect(css.text).toContain("--accent: #ff6a1a");
    expect(css.text).toContain("--tertiary: #55607a");
    expect(css.text).toContain("--raised:");
    expect(css.text).toContain("--inset:");
  });

  it("marchio e icone sono serviti e collegati in tutte le pagine", async () => {
    const logo = await getBytes("/assets/logo-realindi.png");
    expect(logo.status).toBe(200);
    expect(logo.type).toContain("image/png");
    // PNG vero, non un segnaposto: firma del formato.
    expect(Array.from(logo.buf.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);

    for (const path of ["/assets/favicon-32.png", "/assets/favicon-192.png", "/assets/app-touch.png"]) {
      const icon = await getBytes(path);
      expect(icon.status).toBe(200);
      expect(icon.type).toContain("image/png");
      expect(icon.buf.length).toBeGreaterThan(100);
    }

    for (const path of ["/", "/bio", "/app"]) {
      const page = await get(path);
      expect(page.text).toContain('href="/assets/favicon-32.png"');
      expect(page.text).toContain('href="/assets/favicon-192.png"');
      expect(page.text).toContain('href="/assets/app-touch.png"');
    }

    for (const path of ["/", "/bio"]) {
      const page = await get(path);
      expect(page.text).toContain('src="/assets/logo-realindi.png"');
    }
  });
});

// Impaginazione a schermo stretto. La suite non ha un browser, quindi non si
// misurano i pixel: si verificano le due condizioni che tengono il testo al
// sicuro dalla linguetta del menu. Erano proprio i margini asimmetrici e la
// linguetta larga o scivolosa a produrre sovrapposizioni in passato.

/** Corpo del blocco che si apre alla graffa `open`. */
function sliceBlock(css: string, open: number): { body: string; end: number } {
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return { body: css.slice(open + 1, i), end: i + 1 };
    }
  }
  throw new Error("site.css non bilanciato: manca una graffa di chiusura");
}

/** Corpi delle @media con max-width fino a `maxWidth` px. */
function mediaBodies(css: string, maxWidth: number): string[] {
  const bodies: string[] = [];
  const re = /@media[^{]*max-width:\s*(\d+)px[^{]*\{/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    const { body, end } = sliceBlock(css, m.index + m[0].length - 1);
    if (Number(m[1]) <= maxWidth) bodies.push(body);
    re.lastIndex = end;
  }
  return bodies;
}

/** Regole di primo livello di un corpo: selettore + dichiarazioni. */
function topLevelRules(body: string): { selector: string; decls: string }[] {
  const rules: { selector: string; decls: string }[] = [];
  let i = 0;
  for (;;) {
    const open = body.indexOf("{", i);
    if (open === -1) return rules;
    const { body: decls, end } = sliceBlock(body, open);
    rules.push({ selector: body.slice(i, open).trim(), decls });
    i = end;
  }
}

/** Dichiarazioni come mappa proprietà -> valore. */
function declarations(decls: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const part of decls.split(";")) {
    const colon = part.indexOf(":");
    if (colon === -1) continue;
    map[part.slice(0, colon).trim()] = part.slice(colon + 1).trim();
  }
  return map;
}

/** Applica le dichiarazioni a una mappa, espandendo la scorciatoia `padding`. */
function applyDeclarations(acc: Record<string, string>, decls: string): void {
  for (const [property, value] of Object.entries(declarations(decls))) {
    if (property !== "padding") {
      acc[property] = value;
      continue;
    }
    const [top, right = top, bottom = top, left = right] = value.split(/\s+/).filter(Boolean);
    Object.assign(acc, {
      "padding-top": top,
      "padding-right": right,
      "padding-bottom": bottom,
      "padding-left": left,
    });
  }
}

/** Valore effettivo di una proprietà: conta l'ultima regola, come la cascata. */
function effective(
  rules: { selector: string; decls: string }[],
  matches: (token: string) => boolean,
  property: string,
): string | undefined {
  let found: string | undefined;
  for (const { selector, decls } of rules) {
    if (!selector.split(",").some((token) => matches(token.trim()))) continue;
    const value = declarations(decls)[property];
    if (value !== undefined) found = value;
  }
  return found;
}

describe("impaginazione a schermo stretto", () => {
  it("su mobile le sezioni hanno margini simmetrici", async () => {
    const css = (await get("/site.css")).text;
    const rules = mediaBodies(css, 820).flatMap(topLevelRules);

    // Margini effettivi dei contenitori che arrivano al bordo dello schermo.
    const paddings = new Map<string, Record<string, string>>();
    for (const { selector, decls } of rules) {
      for (const token of selector.split(",").map((s) => s.trim())) {
        if (token !== ".section" && token !== ".footer") continue;
        const acc = paddings.get(token) ?? {};
        applyDeclarations(acc, decls);
        paddings.set(token, acc);
      }
    }

    // Si controllano solo i contenitori il cui margine orizzontale viene
    // davvero ridefinito qui sotto: un margine asimmetrico arriva sempre così.
    const padded = [...paddings].filter(
      ([, acc]) => acc["padding-left"] !== undefined || acc["padding-right"] !== undefined,
    );
    expect(padded.length, "mancano le regole mobile dei margini").toBeGreaterThan(0);
    for (const [selector, acc] of padded) {
      expect(
        acc["padding-right"],
        `${selector} sotto 820px deve avere lo stesso margine a sinistra e a destra`,
      ).toBe(acc["padding-left"]);
    }
  });

  it("la linguetta del menu resta stretta e non si sposta sotto il puntatore", async () => {
    const css = (await get("/site.css")).text;
    const rules = mediaBodies(css, 820).flatMap(topLevelRules);

    const width = effective(rules, (token) => token === ".drawer-tab", "width");
    expect(width, "la linguetta deve dichiarare una larghezza").toBeDefined();
    // Sopra i 24px la linguetta entra nella fascia del testo e lo copre.
    expect(Number.parseFloat(width as string)).toBeGreaterThan(0);
    expect(Number.parseFloat(width as string)).toBeLessThanOrEqual(24);

    // Uno spostamento in hover/focus la avvicinerebbe al testo.
    const isHover = (token: string) =>
      token === ".drawer-tab:hover" || token === ".drawer-tab:focus-visible";
    const transform = effective(rules, isHover, "transform");
    expect(transform, "manca la regola hover/focus della linguetta").toBeDefined();
    expect(transform, "al passaggio del puntatore la linguetta non deve spostarsi").toBe("none");
  });
});

describe("bottoni di modifica", () => {
  it("non compaiono nel markup servito senza sessione", async () => {
    for (const path of ["/", "/bio"]) {
      const r = await get(path);
      expect(r.status).toBe(200);
      expect(r.text).not.toContain("data-edit=");
      expect(r.text).not.toContain("edit-slot");
    }
  });

  it("li inserisce il server quando la sessione è aperta", async () => {
    await resetDb();
    const c = makeClient(base);
    await c.setup();

    const home = await c.request("/");
    const homeHtml = home.bytes.toString("utf8");
    expect(homeHtml).toContain('data-edit="hero"');
    expect(homeHtml).toContain('data-edit="services"');
    expect(homeHtml).toContain('data-edit="contacts"');
    expect(homeHtml).not.toContain("edit-slot");

    const bio = await c.request("/bio");
    const bioHtml = bio.bytes.toString("utf8");
    expect(bioHtml).toContain('data-edit="bio"');
  });

  it("una sessione scaduta non vede i bottoni", async () => {
    await resetDb();
    const c = makeClient(base);
    await c.setup();
    await c.request("/api/logout", {});
    const home = await c.request("/");
    expect(home.bytes.toString("utf8")).not.toContain("data-edit=");
  });
});

describe("GET /api/site", () => {
  it("è pubblico e senza contenuti salvati non inventa una configurazione", async () => {
    await resetDb();
    const res = await httpFetch(base + "/api/site");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.booking_path).toMatch(/^\/book\//);
    // null = mai salvato: la pagina mostra il proprio contenuto iniziale, il
    // server non tiene una copia di base da cui riemergere dopo una modifica.
    expect(body.bio).toBeNull();
    expect(body.content).toBeNull();
  });
});

describe("POST /api/site", () => {
  it("senza sessione non salva (convenzione POST: 400)", async () => {
    const res = await httpFetch(base + "/api/site", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bio: { tagline: "x", links: [] } }),
    });
    expect(res.status).toBe(400);
  });

  it("salva e restituisce i link bio validati", async () => {
    await resetDb();
    const c = makeClient(base);
    const setup = await c.setup();
    expect(setup.status).toBe(200);

    const valid = {
      bio: {
        tagline: "Sviluppo su misura",
        links: [
          { id: "l1", label: "Sito", url: "https://realindi-systems.vercel.app", section: "main", visible: true, order: 0 },
          { id: "l2", label: "Instagram", url: "https://instagram.com/realindi", section: "socials", visible: true, order: 0 },
        ],
      },
    };
    const saved = await c.request("/api/site", valid);
    expect(saved.status).toBe(200);

    const res = await httpFetch(base + "/api/site");
    const body = await res.json();
    expect(body.bio.tagline).toBe("Sviluppo su misura");
    expect(body.bio.links).toHaveLength(2);
    expect(body.bio.links[0].label).toBe("Sito");
    expect(body.bio.links[1].section).toBe("socials");
  });

  it("salva la vetrina completa e restituisce solo i dettagli inviati", async () => {
    await resetDb();
    const c = makeClient(base);
    await c.setup();

    const content = {
      brand: "Studio Rossi",
      ticker: "Automazioni ◆ Software ◆",
      hero: {
        label: "STUDIO ROSSI / SOFTWARE",
        title1: "SOFTWARE CHE",
        title2: "FA",
        emphasis: "LA DIFFERENZA.",
        lead: "Testo introduttivo nuovo.",
        cta_primary: "Parliamone",
        cta_secondary: "Guarda i lavori ↓",
      },
      services: {
        label: "01 / SERVIZI",
        title1: "COSA FACCIO",
        title2: "",
        items: [{ title: "Web app", body: "Applicazioni su misura." }],
      },
      about: {
        label: "02 / CHI SONO",
        title1: "IL METODO",
        title2: "",
        intro: "Una riga.",
        paragraphs: ["Primo paragrafo.", "Secondo paragrafo."],
        facts: ["Ascolto."],
      },
      works: {
        label: "03 / LAVORI",
        title1: "PROGETTI",
        title2: "",
        items: [{ kicker: "PROGETTO 01", title: "CRM", body: "Un gestionale." }],
      },
      contacts: {
        label: "04 / CONTATTI",
        title1: "SCRIVIMI",
        title2: "",
        paragraphs: ["Raccontami il progetto."],
        secondary: "I miei contatti →",
      },
      footer: "© 2026 Studio Rossi",
    };

    const saved = await c.request("/api/site", { content });
    expect(saved.status).toBe(200);
    expect(saved.body.content.brand).toBe("Studio Rossi");

    const res = await httpFetch(base + "/api/site");
    const body = await res.json();
    expect(body.content.brand).toBe("Studio Rossi");
    expect(body.content.services.items).toHaveLength(1);
    expect(body.content.about.paragraphs).toEqual(["Primo paragrafo.", "Secondo paragrafo."]);
  });

  it("un nuovo salvataggio cancella il precedente invece di integrarlo", async () => {
    await resetDb();
    const c = makeClient(base);
    await c.setup();

    const first = {
      brand: "Prima versione",
      ticker: "Ticker vecchio",
      hero: { label: "A", title1: "B", title2: "C", emphasis: "D", lead: "E", cta_primary: "F", cta_secondary: "G" },
      services: { label: "H", title1: "I", title2: "", items: [{ title: "Vecchio servizio", body: "Testo" }] },
      about: { label: "J", title1: "K", title2: "", intro: "L", paragraphs: ["Vecchio paragrafo"], facts: ["Vecchio punto"] },
      works: { label: "M", title1: "N", title2: "", items: [{ kicker: "O", title: "P", body: "Q" }] },
      contacts: { label: "R", title1: "S", title2: "", paragraphs: ["Vecchio contatto"], secondary: "T" },
      footer: "U",
    };
    expect((await c.request("/api/site", { content: first })).status).toBe(200);

    // Secondo salvataggio: cambia il marchio e svuota elenchi e ticker. Nulla di
    // quello che non viene inviato deve sopravvivere alla modifica.
    const next = {
      brand: "Solo questo",
      ticker: "",
      hero: { label: "", title1: "", title2: "", emphasis: "", lead: "", cta_primary: "", cta_secondary: "" },
      services: { label: "", title1: "", title2: "", items: [] },
      about: { label: "", title1: "", title2: "", intro: "", paragraphs: [], facts: [] },
      works: { label: "", title1: "", title2: "", items: [] },
      contacts: { label: "", title1: "", title2: "", paragraphs: [], secondary: "" },
      footer: "",
    };
    expect((await c.request("/api/site", { content: next })).status).toBe(200);

    const body = await (await httpFetch(base + "/api/site")).json();
    expect(body.content.brand).toBe("Solo questo");
    expect(body.content.ticker).toBe("");
    expect(body.content.services.items).toEqual([]);
    expect(body.content.about.paragraphs).toEqual([]);
    expect(body.content.footer).toBe("");

    const rows = await sql("SELECT COUNT(*)::int AS n FROM settings WHERE key = 'site_content'");
    expect(rows[0].n).toBe(1);
  });

  it("senza sessione non salva la vetrina", async () => {
    const res = await httpFetch(base + "/api/site", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: { brand: "Anonimo" } }),
    });
    expect(res.status).toBe(400);
  });

  it("rifiuta una vetrina con campi del tipo sbagliato", async () => {
    await resetDb();
    const c = makeClient(base);
    await c.setup();
    const bad = await c.request("/api/site", {
      content: {
        brand: 42,
        ticker: "x",
        hero: {},
        services: { items: [] },
        about: {},
        works: { items: [] },
        contacts: {},
        footer: "",
      },
    });
    expect(bad.status).toBe(400);
  });

  it("rifiuta URL non http(s) e sezioni sconosciute", async () => {
    await resetDb();
    const c = makeClient(base);
    await c.setup();

    const xss = await c.request("/api/site", {
      bio: { tagline: "x", links: [{ id: "l1", label: "cattivo", url: "javascript:alert(1)", section: "main", visible: true, order: 0 }] },
    });
    expect(xss.status).toBe(400);

    const badSection = await c.request("/api/site", {
      bio: { tagline: "x", links: [{ id: "l1", label: "ok", url: "https://example.com", section: "altro", visible: true, order: 0 }] },
    });
    expect(badSection.status).toBe(400);
  });
});
