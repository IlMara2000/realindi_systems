// Routing di produzione: su Vercel solo `api/index.ts` esegue il server, quindi
// le due pagine che cambiano HTML in base alla sessione (vetrina e link-in-bio)
// devono arrivare alla funzione. I file statici hanno la precedenza sui
// rewrite: se `public/index.html` tornasse al suo posto, il rewrite di `/`
// verrebbe ignorato e il pulsante «Modifica» non comparirebbe più online.
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import apiHandler from "../api/index.js";
// Side-effect: carica DATABASE_URL_TEST da .env come helpers.ts.
import "./helpers.js";

interface FakeResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  setHeader(name: string, value: string): void;
  end(body?: Buffer | string): void;
}

async function callApi(url: string): Promise<FakeResponse> {
  const res: FakeResponse = {
    statusCode: 0,
    headers: {},
    body: "",
    setHeader(name: string, value: string) {
      res.headers[name.toLowerCase()] = value;
    },
    end(body?: Buffer | string) {
      res.body = body === undefined ? "" : body.toString();
    },
  };
  const req = {
    url,
    method: "GET",
    // Il corpo vuoto evita che api/index.ts provi a leggere lo stream.
    body: "",
    headers: { host: "127.0.0.1:3000", "x-forwarded-proto": "https" },
    socket: {},
  };
  await apiHandler(req as never, res as never);
  return res;
}

describe("entry point Vercel", () => {
  it("le pagine con sessione non stanno nella radice statica", () => {
    expect(existsSync(new URL("../public/index.html", import.meta.url))).toBe(false);
    expect(existsSync(new URL("../public/bio.html", import.meta.url))).toBe(false);
    expect(existsSync(new URL("../public/pages/index.html", import.meta.url))).toBe(true);
    expect(existsSync(new URL("../public/pages/bio.html", import.meta.url))).toBe(true);
  });

  it("?page=home serve la vetrina, non cacheabile", async () => {
    const r = await callApi("/api?page=home");
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("text/html");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.body).toContain('id="site-root"');
    // Anonimo: nessun bottone di modifica nel markup.
    expect(r.body).not.toContain("site-edit");
  });

  it("?page=bio serve il link-in-bio, non cacheabile", async () => {
    const r = await callApi("/api?page=bio");
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("text/html");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.body).toContain('id="bio-root"');
    expect(r.body).not.toContain("site-edit");
  });

  it("rifiuta le pagine non in elenco", async () => {
    // Inclusi i nomi ereditati da Object.prototype: la mappa non li espone.
    for (const name of ["index", "../../etc/passwd", "%2Fapp", "toString", "constructor"]) {
      const r = await callApi(`/api?page=${name}`);
      expect(r.statusCode).toBe(404);
      expect(r.body).not.toContain("site-root");
    }
  });

  it("le API restano raggiungibili dallo stesso entry point", async () => {
    const r = await callApi("/api?path=session");
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("application/json");
    const data = JSON.parse(r.body);
    expect(typeof data.setup).toBe("boolean");
    expect(data.authenticated).toBe(false);
  });
});
