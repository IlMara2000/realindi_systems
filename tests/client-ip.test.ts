// IP usato come chiave del limite dei tentativi: deve venire da una fonte che
// il client non può scegliere, altrimenti basta cambiare header per non essere
// mai bloccati (e per riempire login_attempts di indirizzi inventati).
import { describe, it, expect } from "vitest";
import { clientIp } from "../src/util.js";

describe("IP del client", () => {
  it("senza proxy fidato gli header si ignorano: vale la connessione", () => {
    const ip = clientIp(
      { "x-forwarded-for": "203.0.113.1", "x-vercel-forwarded-for": "203.0.113.2", "x-real-ip": "203.0.113.3" },
      "198.51.100.7",
      { dietroProxy: false },
    );
    expect(ip).toBe("198.51.100.7");
  });

  it("un X-Forwarded-For forgiato non diventa la chiave", () => {
    // Il caso dell'attacco: una lista scritta dal client. Senza proxy fidato
    // non conta; con proxy fidato conta solo l'ultimo valore, quello aggiunto
    // dal proxy, e i valori inventati a sinistra restano fuori.
    expect(clientIp({ "x-forwarded-for": "192.0.2.50" }, "198.51.100.7", { dietroProxy: false })).toBe(
      "198.51.100.7",
    );
    expect(
      clientIp({ "x-forwarded-for": "192.0.2.50, 198.51.100.9" }, "10.0.0.1", { dietroProxy: true }),
    ).toBe("198.51.100.9");
  });

  it("preferisce x-vercel-forwarded-for, che un proxy davanti non sovrascrive", () => {
    const ip = clientIp(
      { "x-vercel-forwarded-for": "198.51.100.9", "x-forwarded-for": "203.0.113.4" },
      "10.0.0.1",
      { dietroProxy: true },
    );
    expect(ip).toBe("198.51.100.9");
  });

  it("scarta i valori che non sono IP e ricade sulla connessione", () => {
    expect(clientIp({ "x-forwarded-for": "non-un-ip" }, "198.51.100.7", { dietroProxy: true })).toBe(
      "198.51.100.7",
    );
    expect(clientIp({ "x-forwarded-for": "" }, "198.51.100.7", { dietroProxy: true })).toBe("198.51.100.7");
  });

  it("normalizza IPv4-mapped e IPv6, così lo stesso client resta una chiave sola", () => {
    expect(clientIp({ "x-forwarded-for": "::ffff:198.51.100.7" }, "::1", { dietroProxy: true })).toBe(
      "198.51.100.7",
    );
    expect(clientIp({ "x-forwarded-for": "2001:DB8::1" }, "::1", { dietroProxy: true })).toBe(
      "2001:db8::1",
    );
    expect(clientIp({}, "::ffff:127.0.0.1", { dietroProxy: false })).toBe("127.0.0.1");
  });

  it("senza alcun indirizzo usa un valore fisso, mai una stringa vuota", () => {
    expect(clientIp({}, undefined, { dietroProxy: false })).toBe("127.0.0.1");
  });
});
