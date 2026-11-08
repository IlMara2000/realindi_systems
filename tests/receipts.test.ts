// Ricevute di cassa: numerazione progressiva per anno sul database, registro e
// importo in lettere. La numerazione la decide il server, non il browser.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startServer, type RunningServer } from "../scripts/dev-server.js";
import { makeClient, resetDb, type TestClient } from "./helpers.js";
import { importoInLettere, inLettere } from "../src/receipts.js";

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

async function fresh(): Promise<TestClient> {
  const c = makeClient(base);
  const r = await c.setup();
  if (r.status !== 200) throw new Error(`setup ${r.status}`);
  return c;
}

function ricevuta(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    date: "2026-03-04",
    place: "Milano",
    payer: "Mario Rossi",
    tax_code: "RSSMRA80A01F205X",
    amount_cents: 145000,
    reason: "Saldo lavori",
    issuer: "REALINDI Systems",
    ...extra,
  };
}

describe("importo in lettere", () => {
  it("scrive gli importi come su una quietanza", () => {
    expect(inLettere(21)).toBe("ventuno");
    expect(inLettere(108)).toBe("centotto");
    expect(inLettere(2000)).toBe("duemila");
    expect(inLettere(1000000)).toBe("un milione");
    expect(inLettere(1234)).toBe("milleduecentotrentaquattro");
    expect(importoInLettere(145000)).toBe("euro millequattrocentocinquanta/00");
    expect(importoInLettere(123456)).toBe("euro milleduecentotrentaquattro e cinquantasei centesimi");
  });
});

describe("ricevute di cassa", () => {
  it("numera in modo progressivo e salva l'importo in lettere", async () => {
    const c = await fresh();

    const prima = await c.request("/api/ricevute", ricevuta());
    expect(prima.status).toBe(200);
    expect(prima.body.receipt.year).toBe(2026);
    expect(prima.body.receipt.number).toBe(1);
    expect(prima.body.receipt.amount_cents).toBe(145000);
    expect(prima.body.receipt.amount_words).toBe("euro millequattrocentocinquanta/00");

    const seconda = await c.request("/api/ricevute", ricevuta({ payer: "Anna Bianchi" }));
    expect(seconda.body.receipt.number).toBe(2);
  });

  it("tiene una numerazione separata per ogni anno", async () => {
    const c = await fresh();

    await c.request("/api/ricevute", ricevuta());
    const vecchia = await c.request("/api/ricevute", ricevuta({ date: "2025-12-31" }));

    expect(vecchia.status).toBe(200);
    expect(vecchia.body.receipt.year).toBe(2025);
    expect(vecchia.body.receipt.number).toBe(1);

    const registro = await c.request("/api/ricevute");
    expect(registro.status).toBe(200);
    expect(registro.body.counters).toEqual({ "2026": 1, "2025": 1 });
    expect(registro.body.receipts).toHaveLength(2);
    // dal più recente: prima il 2026, poi il 2025
    expect(registro.body.receipts[0].year).toBe(2026);
    expect(registro.body.receipts[1].year).toBe(2025);
  });

  it("non assegna due volte lo stesso numero a emissioni simultanee", async () => {
    const c = await fresh();

    const esiti = await Promise.all(
      Array.from({ length: 8 }, (_, i) => c.request("/api/ricevute", ricevuta({ payer: `Versante ${i + 1}` }))),
    );

    expect(esiti.map((r) => r.status)).toEqual(Array(8).fill(200));
    const numeri = esiti.map((r) => r.body.receipt.number).sort((a, b) => a - b);
    expect(numeri).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    const registro = await c.request("/api/ricevute");
    expect(registro.body.receipts).toHaveLength(8);
    expect(registro.body.counters["2026"]).toBe(8);
  });

  it("annulla una ricevuta senza cancellarla", async () => {
    const c = await fresh();
    const emessa = await c.request("/api/ricevute", ricevuta());
    const id = emessa.body.receipt.id;

    const res = await c.request("/api/ricevute/annulla", { id, reason: "Importo errato" });
    expect(res.status).toBe(200);
    expect(res.body.receipt.cancel_reason).toBe("Importo errato");
    // Stesso formato di created_at: utcStamp(), senza la T.
    expect(res.body.receipt.cancelled_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    const registro = await c.request("/api/ricevute");
    expect(registro.body.receipts).toHaveLength(1);
    expect(registro.body.receipts[0].cancelled_at).toBeTruthy();
    // Il numero resta occupato: il contatore dell'anno non cala.
    expect(registro.body.counters["2026"]).toBe(1);
  });

  it("rifiuta il doppio annullamento e il motivo vuoto", async () => {
    const c = await fresh();
    const emessa = await c.request("/api/ricevute", ricevuta());
    const id = emessa.body.receipt.id;

    const vuoto = await c.request("/api/ricevute/annulla", { id, reason: "   " });
    expect(vuoto.status).toBe(400);
    expect(String(vuoto.body.error)).toContain("motivo");

    expect((await c.request("/api/ricevute/annulla", { id, reason: "Errore" })).status).toBe(200);
    const doppio = await c.request("/api/ricevute/annulla", { id, reason: "Errore" });
    expect(doppio.status).toBe(400);
    expect(String(doppio.body.error)).toContain("già annullata");
  });

  it("non riusa il numero di una ricevuta annullata", async () => {
    const c = await fresh();
    const prima = await c.request("/api/ricevute", ricevuta());
    await c.request("/api/ricevute/annulla", { id: prima.body.receipt.id, reason: "Errore" });

    const dopo = await c.request("/api/ricevute", ricevuta({ payer: "Anna Bianchi" }));
    expect(dopo.body.receipt.number).toBe(prima.body.receipt.number + 1);
  });

  it("risponde 404 su una ricevuta inesistente", async () => {
    const c = await fresh();
    const res = await c.request("/api/ricevute/annulla", { id: 9999, reason: "Errore" });
    expect(res.status).toBe(404);
    expect(String(res.body.error)).toContain("non trovata");
  });

  it("rifiuta le ricevute senza i dati essenziali", async () => {
    const c = await fresh();

    const senzaVersante = await c.request("/api/ricevute", ricevuta({ payer: "  " }));
    expect(senzaVersante.status).toBe(400);
    expect(String(senzaVersante.body.error)).toContain("versato");

    const senzaCausale = await c.request("/api/ricevute", ricevuta({ reason: "" }));
    expect(senzaCausale.status).toBe(400);

    const importoZero = await c.request("/api/ricevute", ricevuta({ amount_cents: 0 }));
    expect(importoZero.status).toBe(400);

    const dataRotta = await c.request("/api/ricevute", ricevuta({ date: "2026-02-31" }));
    expect(dataRotta.status).toBe(400);

    const registro = await c.request("/api/ricevute");
    expect(registro.body.receipts).toHaveLength(0);
  });

  it("chiede la sessione del gestionale", async () => {
    const anonimo = makeClient(base);

    const lettura = await anonimo.request("/api/ricevute");
    expect(lettura.status).toBe(401);

    const emissione = await anonimo.request("/api/ricevute", ricevuta());
    expect(emissione.status).toBeGreaterThanOrEqual(400);
    expect(emissione.status).toBeLessThan(500);
  });
});
