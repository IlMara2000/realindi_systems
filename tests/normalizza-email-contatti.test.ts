// Passaggio una tantum sulle email già salvate: la regola di normalizzazione e
// la scrittura sul database, con il conteggio delle righe toccate.
import { describe, it, expect, beforeEach } from "vitest";
import {
  emailsNormalizzate,
  normalizzaEmailContatti,
} from "../scripts/normalizza-email-contatti.js";
import { emailsDaValore, emailsDelContatto } from "../src/contacts.js";
import { resetDb, sql } from "./helpers.js";

beforeEach(async () => {
  await resetDb();
});

async function contatto(emails: string, updated_at = 1): Promise<number> {
  const rows = await sql(
    "INSERT INTO contacts (display_name, emails, updated_at) VALUES ('Prova', $1, $2) RETURNING id",
    [emails, updated_at],
  );
  return rows[0].id;
}

async function emailsSalvate(id: number): Promise<string> {
  const rows = await sql("SELECT emails FROM contacts WHERE id = $1", [id]);
  return rows[0].emails;
}

describe("emailsNormalizzate", () => {
  it("mette in minuscolo, toglie gli spazi ai lati e i doppioni", () => {
    expect(emailsNormalizzate('["Mario@Example.com"," mario@example.com ","M.ROSSI@Studio.IT"]')).toEqual([
      "mario@example.com",
      "m.rossi@studio.it",
    ]);
  });

  it("non tocca un elenco già a posto", () => {
    expect(emailsNormalizzate('["mario@example.com"]')).toEqual(["mario@example.com"]);
  });

  it("usa la stessa regola della lettura dei contatti", () => {
    // Una regola sola: lo script non tiene una seconda copia di normalizeEmail.
    const salvato = '["Mario@Example.com"," mario@example.com ","M.ROSSI@Studio.IT"]';
    expect(emailsNormalizzate(salvato)).toEqual(emailsDelContatto(salvato));
    expect(emailsNormalizzate(salvato)).toEqual(emailsDaValore(JSON.parse(salvato)));
  });

  it("rifiuta un valore che non è un elenco di stringhe", () => {
    expect(emailsNormalizzate("non-json")).toBeNull();
    expect(emailsNormalizzate('{"a":1}')).toBeNull();
    expect(emailsNormalizzate('["ok@example.com",42]')).toBeNull();
  });
});

describe("normalizzaEmailContatti", () => {
  it("in sola lettura conta le righe da correggere senza scrivere", async () => {
    const id = await contatto('["Mario@Example.com"]');

    const esito = await normalizzaEmailContatti(process.env.DATABASE_URL!, { applica: false });

    expect(esito.righeEsaminate).toBe(1);
    expect(esito.righeDaCorreggere).toEqual([
      { id, prima: ["Mario@Example.com"], dopo: ["mario@example.com"], indirizzi: 1 },
    ]);
    expect(esito.righeScritte).toBe(0);
    expect(await emailsSalvate(id)).toBe('["Mario@Example.com"]');
  });

  it("scrive le email normalizzate, conta le righe toccate e verifica il risultato", async () => {
    const daCorreggere = await contatto('["Mario@Example.com"," mario@example.com "]');
    const giaAPosto = await contatto('["anna@example.com"]');
    const illeggibile = await contatto("non-json");

    const esito = await normalizzaEmailContatti(process.env.DATABASE_URL!, { applica: true });

    expect(esito.righeScritte).toBe(1);
    expect(esito.residue).toBe(0);
    expect(esito.illeggibili).toEqual([illeggibile]);
    expect(await emailsSalvate(daCorreggere)).toBe('["mario@example.com"]');
    expect(await emailsSalvate(giaAPosto)).toBe('["anna@example.com"]');
    expect(await emailsSalvate(illeggibile)).toBe("non-json");
  });

  it("è idempotente: la seconda esecuzione non trova nulla", async () => {
    await contatto('["Mario@Example.com"]');
    await normalizzaEmailContatti(process.env.DATABASE_URL!, { applica: true });

    const seconda = await normalizzaEmailContatti(process.env.DATABASE_URL!, { applica: true });

    expect(seconda.righeDaCorreggere).toEqual([]);
    expect(seconda.righeScritte).toBe(0);
    expect(seconda.residue).toBe(0);
  });
});
