// Ricevute di cassa: importo in lettere, numerazione progressiva per anno e
// registro su Postgres.
//
// Il numero è deciso dal server dentro una transazione protetta da un lock
// consultivo per anno: due incassi simultanei dello stesso anno si mettono in
// fila e prendono numeri diversi. Il vincolo univoco (year, number) resta come
// rete di sicurezza se qualcosa scavalca la transazione.
import { prisma } from "./db.js";
import { Invalid, checkDate } from "./util.js";

const UNITA = [
  "zero",
  "uno",
  "due",
  "tre",
  "quattro",
  "cinque",
  "sei",
  "sette",
  "otto",
  "nove",
  "dieci",
  "undici",
  "dodici",
  "tredici",
  "quattordici",
  "quindici",
  "sedici",
  "diciassette",
  "diciotto",
  "diciannove",
];

const DECINE = ["", "", "venti", "trenta", "quaranta", "cinquanta", "sessanta", "settanta", "ottanta", "novanta"];

function sotto100(n: number): string {
  if (n < 20) return UNITA[n];
  const decina = DECINE[Math.floor(n / 10)];
  const unita = n % 10;
  if (unita === 0) return decina;
  // ventuno, ventotto: la vocale finale della decina cade
  if (unita === 1 || unita === 8) return decina.slice(0, -1) + UNITA[unita];
  return decina + UNITA[unita];
}

function sotto1000(n: number): string {
  const centinaia = Math.floor(n / 100);
  const resto = n % 100;
  if (centinaia === 0) return sotto100(resto);
  let testo = centinaia === 1 ? "cento" : sotto100(centinaia) + "cento";
  if (resto === 0) return testo;
  const coda = sotto100(resto);
  // centotto, centottanta: cento perde la "o" davanti a "o"
  if (coda.charAt(0) === "o") testo = testo.slice(0, -1);
  return testo + coda;
}

/** Intero in lettere: mille e le migliaia si scrivono unite (millenovecento). */
export function inLettere(n: number): string {
  let valore = Math.floor(n);
  if (valore === 0) return "zero";
  let testo = "";

  const milioni = Math.floor(valore / 1000000);
  if (milioni > 0) {
    testo += (milioni === 1 ? "un milione" : inLettere(milioni) + " milioni") + " ";
    valore %= 1000000;
  }

  const migliaia = Math.floor(valore / 1000);
  if (migliaia > 0) {
    testo += migliaia === 1 ? "mille" : sotto1000(migliaia) + "mila";
    valore %= 1000;
  }

  if (valore > 0) testo += sotto1000(valore);
  return testo.trim();
}

/** Importo in centesimi come si scrive su una quietanza: "euro …,NN centesimi". */
export function importoInLettere(centesimi: number): string {
  const interi = Math.floor(centesimi / 100);
  const resto = centesimi % 100;
  const base = "euro " + inLettere(interi);
  return resto > 0 ? `${base} e ${inLettere(resto)} centesimi` : `${base}/00`;
}

export interface ReceiptFields {
  issued_on: string;
  place: string;
  payer: string;
  tax_code: string;
  amount_cents: number;
  reason: string;
  issuer: string;
}

function testo(value: unknown, max: number): string {
  const s = String(value ?? "").trim();
  if (s.length > max) throw new Invalid(`Testo troppo lungo (massimo ${max} caratteri).`);
  return s;
}

export function validateReceiptFields(d: Record<string, unknown>): ReceiptFields {
  const issued_on = checkDate(d.date);
  const payer = testo(d.payer, 160);
  if (!payer) throw new Invalid("Indica chi ha versato il contante.");
  const reason = testo(d.reason, 400);
  if (!reason) throw new Invalid("Indica la causale della ricevuta.");
  const amount_cents = Number(d.amount_cents);
  if (!Number.isInteger(amount_cents) || amount_cents <= 0) {
    throw new Invalid("L'importo deve essere maggiore di zero.");
  }
  if (amount_cents > 100_000_000) throw new Invalid("Importo troppo elevato (massimo 1.000.000 €).");
  return {
    issued_on,
    place: testo(d.place, 120),
    payer,
    tax_code: testo(d.tax_code, 32),
    amount_cents,
    reason,
    issuer: testo(d.issuer, 160),
  };
}

/** Emette la ricevuta: anno della data, numero successivo, importo in lettere. */
export async function emitReceipt(fields: ReceiptFields) {
  const p = prisma();
  const year = Number(fields.issued_on.slice(0, 4));
  const amount_words = importoInLettere(fields.amount_cents);
  const chiave = `ricevute:${year}`;
  return p.$transaction(
    async (tx) => {
      // Il cast a testo serve a Prisma: pg_advisory_xact_lock restituisce void.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${chiave})::bigint)::text`;
      const ultima = await tx.receipt.findFirst({
        where: { year },
        orderBy: { number: "desc" },
        select: { number: true },
      });
      return tx.receipt.create({
        data: { ...fields, year, number: (ultima?.number ?? 0) + 1, amount_words },
      });
    },
    { timeout: 15000 },
  );
}

/** Registro completo (dal più recente) e ultimo numero usato per ogni anno. */
export async function listReceipts() {
  const p = prisma();
  const [receipts, counters] = await Promise.all([
    p.receipt.findMany({ orderBy: [{ year: "desc" }, { number: "desc" }] }),
    p.receipt.groupBy({ by: ["year"], _max: { number: true } }),
  ]);
  const anni: Record<string, number> = {};
  for (const c of counters) anni[String(c.year)] = c._max.number ?? 0;
  return { receipts, counters: anni };
}
