// Limite di frequenza dell'assistente: le asserzioni girano sul codice vero,
// dentro Postgres. L'orologio è iniettato, così la finestra mobile si prova
// senza aspettare dieci minuti.
import { beforeEach, describe, expect, it } from "vitest";
import { createLimiter, postgresStore } from "../src/ratelimit.js";
import { resetDb } from "./helpers.js";

function clock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

beforeEach(async () => {
  await resetDb();
});

describe("limite di frequenza", () => {
  it("consente fino al massimo e poi rifiuta", async () => {
    const c = clock();
    const lim = createLimiter({ store: postgresStore(1000, 3), now: c.now });
    expect((await lim.check("a")).allowed).toBe(true);
    expect((await lim.check("a")).allowed).toBe(true);
    expect((await lim.check("a")).allowed).toBe(true);
    expect((await lim.check("a")).allowed).toBe(false);
  });

  it("la finestra scorre e riapre il passaggio", async () => {
    const c = clock();
    const lim = createLimiter({ store: postgresStore(1000, 2), now: c.now });
    await lim.check("a");
    await lim.check("a");
    expect((await lim.check("a")).allowed).toBe(false);

    c.advance(999);
    expect((await lim.check("a")).allowed).toBe(false);

    c.advance(1);
    expect((await lim.check("a")).allowed).toBe(true);
    expect((await lim.check("a")).allowed).toBe(true);
    expect((await lim.check("a")).allowed).toBe(false);
  });

  it("i tentativi respinti non allungano il blocco", async () => {
    const c = clock();
    const lim = createLimiter({ store: postgresStore(1000, 2), now: c.now });
    await lim.check("a");
    await lim.check("a");

    c.advance(100);
    for (let i = 0; i < 5; i += 1) {
      expect((await lim.check("a")).allowed).toBe(false);
    }

    // Se i rifiuti fossero registrati, le righe a t=100 terrebbero il blocco
    // fino a 1100; qui invece i due tentativi veri scadono a 1000.
    c.advance(900);
    expect((await lim.check("a")).allowed).toBe(true);
  });

  it("dice quanto manca", async () => {
    const c = clock();
    const lim = createLimiter({ store: postgresStore(1000, 2), now: c.now });
    expect((await lim.check("sms:mario")).retryAfterMs).toBe(0);
    expect((await lim.check("sms:mario")).allowed).toBe(true);

    c.advance(400);
    const esito = await lim.check("sms:mario");
    expect(esito.allowed).toBe(false);
    expect(esito.retryAfterMs).toBe(600);
  });

  it("chiavi diverse non si influenzano", async () => {
    const c = clock();
    const lim = createLimiter({ store: postgresStore(1000, 1), now: c.now });
    expect((await lim.check("sms:mario")).allowed).toBe(true);
    expect((await lim.check("sms:mario")).allowed).toBe(false);
    expect((await lim.check("sms:anna")).allowed).toBe(true);
    expect((await lim.check("whatsapp:mario")).allowed).toBe(true);
  });

  it("elenca i bloccati con il tempo di attesa", async () => {
    const c = clock();
    const lim = createLimiter({ store: postgresStore(1000, 2), now: c.now });
    await lim.check("sms:mario");
    await lim.check("sms:mario");

    c.advance(400);
    await lim.check("sms:anna");
    await lim.check("sms:anna");

    expect(await lim.blocked()).toEqual([
      { key: "sms:mario", retryAfterMs: 600 },
      { key: "sms:anna", retryAfterMs: 1000 },
    ]);

    c.advance(600);
    expect(await lim.blocked()).toEqual([{ key: "sms:anna", retryAfterMs: 400 }]);
  });

  it("condivide i conteggi tra istanze diverse", async () => {
    const istanzaA = createLimiter({ store: postgresStore(60_000, 2) });
    const istanzaB = createLimiter({ store: postgresStore(60_000, 2) });

    expect((await istanzaA.check("sms:due-istanze")).allowed).toBe(true);
    expect((await istanzaA.check("sms:due-istanze")).allowed).toBe(true);

    const terza = await istanzaB.check("sms:due-istanze");
    expect(terza.allowed).toBe(false);
    expect(terza.retryAfterMs).toBeGreaterThan(0);
    expect(terza.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it("due richieste simultanee non occupano lo stesso posto", async () => {
    const lim = createLimiter({ store: postgresStore(60_000, 3) });
    const esiti = await Promise.all(
      Array.from({ length: 8 }, () => lim.check("sms:concorrenza")),
    );
    expect(esiti.filter((e) => e.allowed)).toHaveLength(3);
  });
});
