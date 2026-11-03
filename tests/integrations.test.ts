// Crittografia segreti (AES-256-GCM) e modelli Prisma nuovi.
// Prisma: tabelle note, calendar_events, event_links, sync_state.
import { describe, it, expect, afterEach, vi } from "vitest";
import { sql } from "./helpers.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("sealSecret/openSecret", () => {
  it("roundtrip: il testo decifra uguale all'originale e il formato è v1", async () => {
    vi.stubEnv("INTEGRATIONS_KEY", "chiave-di-test-non-produzione");
    const { sealSecret, openSecret } = await import("../src/crypto.js");
    const sealed = sealSecret("refresh-token-segreto-123");
    expect(sealed.startsWith("v1:")).toBe(true);
    expect(sealed).not.toContain("refresh-token-segreto-123");
    expect(openSecret(sealed)).toBe("refresh-token-segreto-123");
  });

  it("ciphertext manomesso: openSecret lancia", async () => {
    vi.stubEnv("INTEGRATIONS_KEY", "chiave-di-test-non-produzione");
    const { sealSecret, openSecret } = await import("../src/crypto.js");
    const sealed = sealSecret("valore-originale");
    const parts = sealed.split(":");
    const tampered = parts.slice(0, 3).join(":") + ":" + Buffer.from("altro-contenuto-ciffrato").toString("base64");
    expect(() => openSecret(tampered)).toThrow();
  });

  it("INTEGRATIONS_KEY assente: sealSecret e openSecret lanciano", async () => {
    vi.stubEnv("INTEGRATIONS_KEY", "");
    const { sealSecret, openSecret } = await import("../src/crypto.js");
    expect(() => sealSecret("x")).toThrow(/INTEGRATIONS_KEY/);
    expect(() => openSecret("v1:YQ==:YQ==:YQ==")).toThrow(/INTEGRATIONS_KEY/);
  });
});

describe("modelli Prisma", () => {
  it("le tabelle nuove esistono nel database di test", async () => {
    for (const table of ["notes", "calendar_events", "event_links", "sync_state"]) {
      const rows = await sql(`SELECT COUNT(*) AS n FROM ${table}`);
      expect(rows[0].n).toBeDefined();
    }
  });
});
