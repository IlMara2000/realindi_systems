// Passaggio una tantum: normalizza le email dei contatti già nel database.
//
// Da quando l'import normalizza alla scrittura (minuscole, senza spazi attorno,
// senza doppioni), i contatti arrivati prima conservano «Mario@Example.com»: la
// ricerca per email e il confronto dei doppioni non li riconoscono. Questo
// script riscrive solo il campo `emails` delle righe che ne hanno bisogno, con
// la stessa regola dell'import (`normalizeEmail` di src/contacts.ts), e dice
// quante righe ha toccato.
//
//   npm run db:normalizza-email            (mostra cosa cambierebbe, non scrive)
//   npm run db:normalizza-email -- --applica   (scrive e poi rilegge per verificare)
//
// Usa DATABASE_URL, la stessa connessione dell'applicazione. È idempotente: una
// seconda esecuzione non trova più nulla da correggere. Le righe il cui campo
// non è un elenco JSON di stringhe non vengono toccate: sono un dato da
// guardare a mano, non da sovrascrivere.
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { emailsDaValore, normalizeEmail } from "../src/contacts.js";
import { ETICHETTE, classifica, descriviHost, rimedio } from "./diagnose-db.js";

export interface RigaDaCorreggere {
  id: number;
  prima: string[];
  dopo: string[];
  /** Quanti indirizzi cambiano davvero (maiuscole, spazi o doppioni tolti). */
  indirizzi: number;
}

export interface EsitoNormalizzazione {
  righeEsaminate: number;
  righeDaCorreggere: RigaDaCorreggere[];
  /** Id delle righe con un campo `emails` che non è un elenco di stringhe. */
  illeggibili: number[];
  /** Righe scritte davvero (0 in sola lettura). */
  righeScritte: number;
  /** Dopo la scrittura: righe che avevano ancora bisogno di normalizzazione. */
  residue: number;
}

/**
 * Email normalizzate e senza doppioni, nell'ordine in cui compaiono. Il campo
 * si legge una volta sola: il parse serve a scartare i valori illeggibili, poi
 * la regola condivisa con la lettura (`emailsDaValore` di src/contacts.ts)
 * lavora sul valore già letto. Restituisce null quando il valore non è un
 * elenco JSON di stringhe: meglio lasciare la riga com'è che sostituire un dato
 * incompreso con un elenco vuoto.
 */
export function emailsNormalizzate(valore: string): string[] | null {
  let grezzo: unknown;
  try {
    grezzo = JSON.parse(valore);
  } catch {
    return null;
  }
  if (!Array.isArray(grezzo) || !grezzo.every((v) => typeof v === "string")) return null;
  return emailsDaValore(grezzo);
}

/**
 * Quanti valori cambiano davvero: maiuscole, spazi attorno o doppioni tolti.
 * Un indirizzo già minuscolo e ripetuto conta una volta sola come cambiato.
 */
function indirizziCambiati(prima: string[]): number {
  const visti = new Set<string>();
  let cambiati = 0;
  for (const valore of prima) {
    const normalizzato = normalizeEmail(valore);
    if (!normalizzato || valore !== normalizzato || visti.has(normalizzato)) cambiati++;
    visti.add(normalizzato);
  }
  return cambiati;
}

/**
 * Legge tutti i contatti, calcola le email normalizzate e — solo con
 * `applica` — riscrive le righe che cambiano. Ogni UPDATE è condizionato al
 * valore appena letto: se nel frattempo la sincronizzazione ha toccato la riga,
 * la scrittura non la sovrascrive e la riga resta da rivedere.
 */
export async function normalizzaEmailContatti(
  connectionString: string,
  { applica }: { applica: boolean },
): Promise<EsitoNormalizzazione> {
  const client = new Client({ connectionString, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    const { rows } = await client.query<{ id: number; emails: string }>(
      "SELECT id, emails FROM contacts ORDER BY id",
    );

    const esito: EsitoNormalizzazione = {
      righeEsaminate: rows.length,
      righeDaCorreggere: [],
      illeggibili: [],
      righeScritte: 0,
      residue: 0,
    };

    for (const row of rows) {
      const dopo = emailsNormalizzate(row.emails);
      if (dopo === null) {
        esito.illeggibili.push(row.id);
        continue;
      }
      const serializzato = JSON.stringify(dopo);
      if (serializzato === row.emails) continue;

      let prima: string[] = [];
      try {
        prima = JSON.parse(row.emails) as string[];
      } catch {
        // già escluso da emailsNormalizzate
      }
      esito.righeDaCorreggere.push({
        id: row.id,
        prima,
        dopo,
        indirizzi: indirizziCambiati(prima),
      });

      if (!applica) continue;
      const update = await client.query(
        "UPDATE contacts SET emails = $1 WHERE id = $2 AND emails = $3",
        [serializzato, row.id, row.emails],
      );
      esito.righeScritte += update.rowCount ?? 0;
    }

    // Verifica: la stessa regola riletta dal database. Non ci si fida del
    // conteggio delle UPDATE, perché è il contenuto che deve essere a posto.
    if (applica) {
      const { rows: dopoScrittura } = await client.query<{ id: number; emails: string }>(
        "SELECT id, emails FROM contacts ORDER BY id",
      );
      for (const row of dopoScrittura) {
        const dopo = emailsNormalizzate(row.emails);
        if (dopo !== null && JSON.stringify(dopo) !== row.emails) esito.residue += 1;
      }
    }

    return esito;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Messaggio in una riga, con la classificazione condivisa dagli altri comandi. */
function messaggioDatabase(err: unknown, connectionString = ""): string {
  const { esito, codice, messaggio } = classifica(err, connectionString);
  const intestazione = `${ETICHETTE[esito]}${codice ? ` [${codice}]` : ""}: ${messaggio}`;
  const consiglio = rimedio(esito, "DATABASE_URL");
  return consiglio ? `${intestazione}\n${consiglio}` : intestazione;
}

async function main(): Promise<number> {
  const connectionString = (process.env.DATABASE_URL ?? "").trim();
  if (!connectionString) {
    console.error("DATABASE_URL non impostato.");
    return 2;
  }
  const applica = process.argv.includes("--applica");
  console.log(`Database: ${descriviHost(connectionString) ?? "host non riconosciuto"}`);
  console.log(applica ? "Modalità: scrittura" : "Modalità: sola lettura (aggiungi -- --applica per scrivere)");

  const esito = await normalizzaEmailContatti(connectionString, { applica });

  console.log(`Contatti esaminati: ${esito.righeEsaminate}`);
  if (esito.righeDaCorreggere.length) {
    console.log(`Righe da correggere: ${esito.righeDaCorreggere.length}`);
    const esempi = esito.righeDaCorreggere.slice(0, 5);
    for (const riga of esempi) {
      console.log(`  #${riga.id}: ${riga.prima.join(", ")} → ${riga.dopo.join(", ")}`);
    }
    if (esito.righeDaCorreggere.length > esempi.length) {
      console.log(`  … e altre ${esito.righeDaCorreggere.length - esempi.length}`);
    }
    const indirizzi = esito.righeDaCorreggere.reduce((n, riga) => n + riga.indirizzi, 0);
    console.log(`Valori corretti (maiuscole, spazi o doppioni): ${indirizzi}`);
  } else {
    console.log("Nessuna email da normalizzare.");
  }

  if (esito.illeggibili.length) {
    console.warn(
      `Righe non toccate, campo emails illeggibile (${esito.illeggibili.length}): ` +
        esito.illeggibili.join(", "),
    );
  }

  if (applica) {
    console.log(`Righe scritte: ${esito.righeScritte}`);
    if (esito.residue) {
      console.error(`Verifica fallita: ${esito.residue} righe hanno ancora email da normalizzare.`);
      return 1;
    }
    console.log("Verifica riuscita: nessuna email resta da normalizzare.");
  }

  return esito.illeggibili.length ? 1 : 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(`Normalizzazione non riuscita: ${messaggioDatabase(err, (process.env.DATABASE_URL ?? "").trim())}`);
    process.exitCode = 1;
  });
}
