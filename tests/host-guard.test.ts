// Guardia sugli host degli script che creano database: la decisione è pura,
// quindi si verifica senza database.
import { describe, expect, it } from "vitest";
import { hostDi, verificaHost } from "../scripts/host-guard.js";

const RUOLO = "DATABASE_URL_TEST";
const NEGATO = { consenso: false, ruolo: RUOLO };

const LOCALI = [
  "postgresql://postgres:postgres@localhost:5432/postgres",
  "postgresql://postgres:postgres@127.0.0.1:5432/postgres",
  "postgresql://postgres:postgres@[::1]:5432/postgres",
  "postgresql://postgres:postgres@0.0.0.0:5432/postgres",
];

// I primi tre somigliano a host locali ma non lo sono: è il caso che una
// guardia scritta con startsWith("localhost") lascerebbe passare.
const REMOTI = [
  "postgresql://utente:segreta@db.prisma.io:5432/postgres",
  "postgresql://utente:segreta@localhost.evil.example:5432/postgres",
  "postgresql://utente:segreta@127.0.0.1.example.com:5432/postgres",
  "postgresql://utente:segreta@host.docker.internal:5432/postgres",
];

describe.each(LOCALI)("host locale %s", (url) => {
  it("è consentito senza consenso esplicito, senza avvisi", () => {
    expect(verificaHost(url, NEGATO)).toEqual({ consentito: true });
  });
});

describe.each(REMOTI)("host remoto %s", (url) => {
  it("è rifiutato senza consenso esplicito", () => {
    expect(verificaHost(url, NEGATO).consentito).toBe(false);
  });

  it("nomina l'host ma mai la password", () => {
    const esito = verificaHost(url, NEGATO);
    if (esito.consentito) throw new Error("host remoto non rifiutato");
    expect(esito.messaggio).toContain(hostDi(url));
    expect(esito.messaggio).not.toContain("segreta");
  });

  it("indica come procedere comunque", () => {
    const esito = verificaHost(url, NEGATO);
    if (esito.consentito) throw new Error("host remoto non rifiutato");
    expect(esito.messaggio).toContain("--consenti-remoto");
  });

  it("è consentito, con avviso, quando c'è il consenso", () => {
    const esito = verificaHost(url, { consenso: true, ruolo: RUOLO });
    expect(esito.consentito).toBe(true);
    if (!esito.consentito) return;
    expect(esito.avviso).toContain(hostDi(url));
  });
});

describe("casi limite", () => {
  it("una URL assente non fa fallire la guardia", () => {
    expect(verificaHost(undefined, NEGATO)).toEqual({ consentito: true });
  });

  it("una URL non valida lancia un errore che non la riporta", () => {
    expect(() => hostDi("postgres:segreta")).toThrow(/URL valida/);
    try {
      hostDi("postgres:segreta");
    } catch (errore) {
      expect(String(errore)).not.toContain("segreta");
    }
  });
});
