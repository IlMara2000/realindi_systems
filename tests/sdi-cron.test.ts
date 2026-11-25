// @vitest-environment happy-dom
// Avviso in Impostazioni → Invio allo SdI quando l'ultima lettura è vecchia.
import { beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(async () => {
  document.body.innerHTML = "<div id=\"root\"></div>";
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } })),
  );
  // @ts-ignore: public/app.js non ha dichiarazioni TypeScript, importa solo per side-effect
  await import("../public/app.js");
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
});

describe("SdI: avviso cron fermo", () => {
  it("mostra l'avviso se l'ultima lettura è più vecchia di 90 minuti", () => {
    const fn = (window as unknown as { sdiLastLettura: (l: unknown) => string }).sdiLastLettura;
    const vecchia = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const html = fn({ at: vecchia, ok: true, updated: 0, ignorate: 0, superate: 0, error: "" });
    expect(html).toContain("Il cron non sta girando");
    expect(html).toContain("90 minuti");
  });

  it("non mostra l'avviso se l'ultima lettura è recente", () => {
    const fn = (window as unknown as { sdiLastLettura: (l: unknown) => string }).sdiLastLettura;
    const recente = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const html = fn({ at: recente, ok: true, updated: 1, ignorate: 0, superate: 0, error: "" });
    expect(html).not.toContain("Il cron non sta girando");
    expect(html).toContain("Ultima lettura delle ricevute");
  });

  it("non mostra l'avviso se non c'è mai stata una lettura", () => {
    const fn = (window as unknown as { sdiLastLettura: (l: unknown) => string }).sdiLastLettura;
    const html = fn(null);
    expect(html).not.toContain("Il cron non sta girando");
    expect(html).toContain("Nessuna lettura delle ricevute");
  });
});