// Diagnostica delle connessioni al database: prova DATABASE_URL e DIRECT_URL
// con una `SELECT 1` e dice quale dei tre guasti tipici ha davanti — account
// Prisma al limite del piano, credenziali rifiutate, rete che non arriva —
// senza mai stampare la password né la stringa di connessione: si vedono solo
// nome della variabile, host, latenza e messaggio ripulito.
//
// Sola lettura: nessuna scrittura, nessun database creato o eliminato.
//
// Uscita: 0 tutte le prove riuscite, 1 almeno una prova fallita (compreso il
// blocco del piano), 2 nessuna delle due variabili impostata.
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { Client } from "pg";

const TIMEOUT_MS = 10_000;

/** Le due variabili provate, nell'ordine in cui compaiono nell'output. */
const VARIABILI = ["DATABASE_URL", "DIRECT_URL"] as const;
type NomeVariabile = (typeof VARIABILI)[number];

export type Esito = "ok" | "piano" | "credenziali" | "rete" | "altro";

export interface Prova {
  variabile: NomeVariabile;
  /** `host:porta/database`, senza credenziali; null se il valore non è una URL. */
  host: string | null;
  esito: Esito;
  latenza_ms: number;
  /** Messaggio ripulito da password e stringa di connessione. */
  messaggio: string;
  /** Codice dell'errore (es. 28P01, ENOTFOUND), quando c'è. */
  codice: string | null;
}

/** Codici di rete: la connessione non è mai arrivata al server. */
const CODICI_RETE = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

/** Codici di autenticazione rifiutata dal server. */
const CODICI_CREDENZIALI = new Set(["28P01", "28000", "3D000"]);

/**
 * Toglie dal testo la stringa di connessione e la password: un messaggio
 * d'errore di `pg` può ripeterle. Il resto del messaggio resta leggibile —
 * serve a capire il guasto, e il nome utente fra questo: `password
 * authentication failed for user "…"` dice quale credenziale ha fallito, e non
 * è un segreto. Non viene mascherato.
 */
export function redigi(testo: string, connectionString = ""): string {
  let out = testo;
  if (connectionString) {
    out = out.split(connectionString).join("[stringa di connessione omessa]");
    try {
      const password = decodeURIComponent(new URL(connectionString).password);
      if (password.length >= 3) out = out.split(password).join("[password omessa]");
    } catch {
      // Valore che non è una URL: non c'è nulla da ricavare, la maschera
      // generica qui sotto copre comunque le stringhe di connessione.
    }
  }
  return out
    .replace(/\bpostgres(?:ql)?:\/\/\S+/gi, "[stringa di connessione omessa]")
    .replace(/\s*\n\s*/g, " ")
    .trim();
}

/**
 * Classifica l'errore in uno dei casi che si distinguono per rimedio: il piano
 * Prisma si risolve nell'account, le credenziali nel file .env, la rete con la
 * connessione. Il riconoscimento usa il testo grezzo (che può contenere
 * credenziali) ma restituisce solo quello ripulito.
 */
export function classifica(
  errore: unknown,
  connectionString = "",
): { esito: Esito; codice: string | null; messaggio: string } {
  const codiceGrezzo = (errore as { code?: unknown } | null)?.code;
  const codice = typeof codiceGrezzo === "string" ? codiceGrezzo : null;
  const grezzo = errore instanceof Error ? errore.message : String(errore);
  const messaggio = redigi(grezzo, connectionString) || "errore senza messaggio";
  const testo = `${codice ?? ""} ${grezzo}`.toLowerCase();

  // La restrizione dell'account arriva prima dell'autenticazione: il server
  // risponde, rifiuta il database e rimanda al supporto Prisma.
  if (/planlimitreached|plan limit|restrictions?: plan/i.test(testo)) {
    return { esito: "piano", codice, messaggio };
  }
  if (
    (codice && CODICI_CREDENZIALI.has(codice)) ||
    /password authentication failed|authentication failed|role .* does not exist|no pg_hba\.conf entry|invalid password/i.test(
      testo,
    )
  ) {
    return { esito: "credenziali", codice, messaggio };
  }
  if (
    (codice && CODICI_RETE.has(codice)) ||
    /getaddrinfo|econnrefused|enotfound|etimedout|econnreset|timeout expired|connection timeout|socket hang up|connection terminated|server closed the connection|network is unreachable/i.test(
      testo,
    )
  ) {
    return { esito: "rete", codice, messaggio };
  }
  return { esito: "altro", codice, messaggio };
}

/**
 * `host:porta/database` ricavati dalla URL, senza utente né password. Restituisce
 * null quando il valore non è una URL PostgreSQL (per esempio il segnaposto che
 * Vercel lascia al posto dei Secret).
 */
export function descriviHost(connectionString: string): string | null {
  if (!/^postgres(ql)?:\/\//i.test(connectionString.trim())) return null;
  try {
    const url = new URL(connectionString.trim());
    const database = url.pathname.replace(/^\//, "") || "(predefinito)";
    return `${url.hostname}:${url.port || "5432"}/${database}`;
  } catch {
    return null;
  }
}

/** Una connessione di sola lettura, con il tempo misurato attorno alla query. */
export async function provaConnessione(
  variabile: NomeVariabile,
  connectionString: string,
  timeoutMs = TIMEOUT_MS,
): Promise<Prova> {
  const host = descriviHost(connectionString);
  if (!host) {
    return {
      variabile,
      host: null,
      esito: "altro",
      latenza_ms: 0,
      messaggio:
        "il valore non è una URL PostgreSQL (nessun dettaglio: può essere un segnaposto o una variabile troncata)",
      codice: null,
    };
  }

  const inizio = performance.now();
  // `pg` stampa su stderr un avviso sui futuri sslmode: è informativo e non
  // tocca l'esito, quindi resta dov'è. Sostituire `process.emitWarning` per
  // zittirlo cambierebbe il comportamento di tutto il processo, anche per chi
  // importa questo modulo.
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
  });
  try {
    await client.connect();
    await client.query("SELECT 1");
    return {
      variabile,
      host,
      esito: "ok",
      latenza_ms: Math.round(performance.now() - inizio),
      messaggio: "connessione riuscita, SELECT 1 eseguita",
      codice: null,
    };
  } catch (errore) {
    const { esito, codice, messaggio } = classifica(errore, connectionString);
    return { variabile, host, esito, latenza_ms: Math.round(performance.now() - inizio), messaggio, codice };
  } finally {
    // Il client può essere già chiuso o mai connesso: la chiusura non deve
    // diventare l'errore che si vede.
    await client.end().catch(() => undefined);
  }
}

/**
 * Nome breve dell'esito: è il vocabolario condiviso con gli altri comandi
 * (vedi scripts/pulisci-db-test.ts), così lo stesso guasto si chiama allo
 * stesso modo ovunque compaia.
 */
export const ETICHETTE: Record<Esito, string> = {
  ok: "OK",
  piano: "BLOCCATO DAL PIANO PRISMA",
  credenziali: "CREDENZIALI RIFIUTATE",
  rete: "RETE NON RAGGIUNGIBILE",
  altro: "ERRORE NON CLASSIFICATO",
};

/**
 * Rimedio per esito, con la variabile da controllare. Vive qui accanto alla
 * classificazione: se un caso cambia, cambia una volta sola per tutti i comandi
 * che la usano.
 */
export function rimedio(esito: Esito, variabile: string): string | null {
  switch (esito) {
    case "ok":
      return null;
    case "piano":
      return (
        "non dipende dalla configurazione: l'account Prisma ha raggiunto un limite del piano, " +
        "quindi rifiuta ogni database. Elimina i database inutilizzati dalla console Prisma " +
        "(i realindi_test_run_* delle vecchie run di test) o chiedi lo sblocco al supporto; " +
        "poi rilancia questo comando."
      );
    case "credenziali":
      return (
        `utente o password rifiutati: controlla ${variabile} nel file .env o nella ` +
        "variabile d'ambiente. Il nome del database deve esistere sul server."
      );
    case "rete":
      return (
        "il server non risponde: controlla la connessione, il DNS e che l'host sia " +
        "raggiungibile da questa macchina (Vercel non c'entra: qui si prova da locale)."
      );
    default:
      // Nessun rimedio noto: il messaggio è già stampato, e inventare un
      // consiglio generico sarebbe rumore.
      return null;
  }
}

export async function main(): Promise<number> {
  console.log("Diagnostica database — sola lettura, senza password né stringa di connessione nell'output.");
  console.log("");

  const prove: Prova[] = [];
  const assenti: string[] = [];

  for (const nome of VARIABILI) {
    const grezzo = (process.env[nome] ?? "").trim();
    if (!grezzo) {
      assenti.push(nome);
      continue;
    }
    const prova = await provaConnessione(nome, grezzo);
    prove.push(prova);

    const codice = prova.codice ? ` · codice ${prova.codice}` : "";
    console.log(`${nome} · ${prova.host ?? "valore non è una URL"}`);
    console.log(`  esito: ${ETICHETTE[prova.esito]} (${prova.latenza_ms} ms)${codice}`);
    console.log(`  messaggio: ${prova.messaggio}`);
    const consiglio = rimedio(prova.esito, prova.variabile);
    if (consiglio) console.log(`  suggerimento: ${consiglio}`);
    console.log("");
  }

  for (const nome of assenti) {
    if (nome === "DIRECT_URL") {
      console.log("DIRECT_URL · non impostata: i comandi Prisma usano DATABASE_URL.");
    } else {
      console.log(`${nome} · non impostata`);
    }
  }
  if (assenti.length) console.log("");

  if (!prove.length) {
    console.error(
      "Nessuna delle variabili provate è impostata: imposta DATABASE_URL nel file .env o nell'ambiente.",
    );
    return 2;
  }

  const fallite = prove.filter((prova) => prova.esito !== "ok");
  const riuscite = prove.length - fallite.length;
  console.log(
    fallite.length
      ? `Riepilogo: ${riuscite} riuscite, ${fallite.length} fallite (${fallite.map((p) => `${p.variabile}: ${ETICHETTE[p.esito].toLowerCase()}`).join(", ")}).`
      : `Riepilogo: ${riuscite} prove riuscite.`,
  );

  // Un blocco del piano è un guasto quanto un errore di rete: entrambi
  // impediscono al gestionale di funzionare, e lo script non deve fingere che
  // sia andata bene.
  return fallite.length ? 1 : 0;
}

// Eseguito come comando, non quando il modulo viene importato.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
