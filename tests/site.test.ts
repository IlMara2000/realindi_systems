// Routing del sito: / -> sito pubblico, /app -> CRM, /bio -> link-in-bio,
// /book/<slug> -> SPA booking (app.html). Statici nuovi serviti.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startServer, type RunningServer } from "../scripts/dev-server.js";
// Side-effect: carica DATABASE_URL_TEST da .env come helpers.ts.
import "./helpers.js";
import { makeClient, resetDb } from "./helpers.js";

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
  const res = await fetch(base + path);
  const text = await res.text();
  return { status: res.status, text, type: res.headers.get("content-type") ?? "" };
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
    const logo = await get("/assets/brand-mark.svg");
    expect(logo.status).toBe(200);
    expect(logo.type).toContain("image/svg+xml");
    // Il marchio è la R con il parallelogramma arancione, non un segnaposto.
    expect(logo.text).toContain("#141418");
    expect(logo.text).toContain("#ff6a1a");

    const icon = await get("/assets/app-icon.svg");
    expect(icon.status).toBe(200);
    expect(icon.type).toContain("image/svg+xml");

    const touch = await get("/assets/app-touch.png");
    expect(touch.status).toBe(200);
    expect(touch.type).toContain("image/png");

    for (const path of ["/", "/bio", "/app"]) {
      const page = await get(path);
      expect(page.text).toContain('href="/assets/app-icon.svg"');
      expect(page.text).toContain('href="/assets/app-touch.png"');
    }

    for (const path of ["/", "/bio"]) {
      const page = await get(path);
      expect(page.text).toContain('src="/assets/brand-mark.svg"');
    }
  });
});

describe("GET /api/site", () => {
  it("è pubblico, riporta il path di prenotazione e la bio vuota", async () => {
    await resetDb();
    const res = await fetch(base + "/api/site");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.booking_path).toMatch(/^\/book\//);
    expect(body.bio.links).toEqual([]);
    expect(typeof body.bio.tagline).toBe("string");
  });
});

describe("POST /api/site", () => {
  it("senza sessione non salva (convenzione POST: 400)", async () => {
    const res = await fetch(base + "/api/site", {
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

    const res = await fetch(base + "/api/site");
    const body = await res.json();
    expect(body.bio.tagline).toBe("Sviluppo su misura");
    expect(body.bio.links).toHaveLength(2);
    expect(body.bio.links[0].label).toBe("Sito");
    expect(body.bio.links[1].section).toBe("socials");
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
