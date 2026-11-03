// Routing del sito: / -> sito pubblico, /app -> CRM, /bio -> link-in-bio,
// /book/<slug> -> SPA booking (app.html). Statici nuovi serviti.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startServer, type RunningServer } from "../scripts/dev-server.js";
// Side-effect: carica DATABASE_URL_TEST da .env come helpers.ts.
import "./helpers.js";

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
});
