// @vitest-environment happy-dom
// Riepilogo in Impostazioni → Invio allo SdI delle fatture inviate da giorni
// e ancora senza ricevuta.
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

type Render = (s: unknown) => string;

describe("SdI: fatture inviate senza ricevuta", () => {
  it("elenca numero e data delle trasmissioni rimaste appese", () => {
    const fn = (window as unknown as { sdiSenzaRicevuta: Render }).sdiSenzaRicevuta;
    const html = fn({
      giorni: 3,
      fatture: [
        { id: 7, number: "2026/00007", at: "2026-11-18T09:30:00.000Z" },
        { id: 8, number: "2026/00008", at: "2026-11-20T15:00:00.000Z" },
      ],
    });
    expect(html).toContain("Trasmissioni senza ricevuta");
    expect(html).toContain("2 fatture sono inviate");
    expect(html).toContain("più di 3 giorni");
    expect(html).toContain("2026/00007");
    expect(html).toContain("2026/00008");
    expect(html).toContain("18 nov");
  });

  it("usa il singolare quando la fattura appesa è una sola", () => {
    const fn = (window as unknown as { sdiSenzaRicevuta: Render }).sdiSenzaRicevuta;
    const html = fn({ giorni: 3, fatture: [{ id: 7, number: "2026/00007", at: "2026-11-18T09:30:00.000Z" }] });
    expect(html).toContain("Una fattura è inviata");
    expect(html).toContain("non ha ancora nessuna ricevuta");
  });

  it("non mostra nulla quando non ci sono trasmissioni appese", () => {
    const fn = (window as unknown as { sdiSenzaRicevuta: Render }).sdiSenzaRicevuta;
    expect(fn({ giorni: 3, fatture: [] })).toBe("");
    expect(fn(null)).toBe("");
  });
});
