// Pulizia dei database di test rimasti appesi.
//
// Il setup dei test non crea più database: usa sempre quello di
// DATABASE_URL_TEST e ne svuota le tabelle. I `realindi_test_run_<ts>_<nonce>`
// rimasti sono quelli delle run interrotte di prima (Ctrl+C, worker ucciso,
// connessione caduta): occupano spazio nell'account Prisma e, se molti,
// contribuiscono al limite del piano che ha bloccato il database. Questo
// comando li elenca e — solo dopo conferma — li elimina.
//
//   npm run db:pulisci-test              (elenca i residui e chiede conferma)
//   npm run db:pulisci-test -- --tutti   (include anche quelli creati nell'ultima ora)
//   npm run db:pulisci-test -- --sì      (salta la conferma, per gli script)
//
// Usa DATABASE_URL_TEST: i database delle run nascono accanto a quello, quindi
// è la connessione giusta per vederli. Il database indicato dall'URL non viene
// mai toccato: si eliminano solo nomi che iniziano con `realindi_test_run_`.
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { testUrlFromEnv } from "../tests/test-db.js";

const PREFIX = "realindi_test_run_";

/**
 * Un database creato da meno di un'ora può appartenere a una run ancora in
 * corso (una run dura minuti): lo si elenca ma, salvo `--tutti`, non si tocca.
 * È la stessa soglia con cui `tests/global-setup.ts` considera appeso un
 * database trovato all'avvio.
 */
const RECENTE_MS = 60 * 60 * 1000;

/** Nome ammesso: prefisso delle run e solo caratteri generati dal setup. */
const NOME_VALIDO = new RegExp(`^${PREFIX}[a-z0-9]+_[a-f0-9]+$`);

export interface DatabaseTest {
  nome: string;
  /** Età ricavata dal timestamp base36 nel nome; null se il nome non lo contiene. */
  etaMs: number | null;
  /** true se una run potrebbe ancora usarlo. */
  recente: boolean;
}

/** Host e nome del database, senza credenziali: serve a dire dove si agisce. */
function istanza(connectionString: string): string {
  const parsed = new URL(connectionString);
  return `${parsed.host}${parsed.pathname}`;
}

/** Età leggibile: «12 minuti», «3 ore», «2 giorni». */
function eta(ms: number): string {
  const minuti = Math.round(ms / 60000);
  if (minuti < 1) return "meno di un minuto";
  if (minuti < 60) return `${minuti} minut${minuti === 1 ? "o" : "i"}`;
  const ore = Math.round(minuti / 60);
  if (ore < 48) return `${ore} or${ore === 1 ? "a" : "e"}`;
  return `${Math.round(ore / 24)} giorni`;
}

/** Data e ora leggibili (Europe/Rome). */
function quando(ms: number): string {
  return new Date(ms).toLocaleString("it-IT", {
    timeZone: "Europe/Rome",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function conClient<T>(connectionString: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Elenco in sola lettura dei database di test presenti sul server, dal più
 * vecchio al più recente. Non elimina niente.
 */
export async function elencoDatabaseTest(connectionString: string): Promise<DatabaseTest[]> {
  const nomi = await conClient(connectionString, async (c) => {
    const result = await c.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datname LIKE $1 ORDER BY datname",
      [`${PREFIX}%`],
    );
    return result.rows.map((row) => row.datname);
  });

  const adesso = Date.now();
  return nomi
    .map((nome) => {
      const stamp = Number.parseInt(nome.slice(PREFIX.length).split("_")[0], 36);
      const etaMs = Number.isFinite(stamp) ? adesso - stamp : null;
      return { nome, etaMs, recente: etaMs !== null && etaMs < RECENTE_MS };
    })
    .sort((a, b) => (b.etaMs ?? 0) - (a.etaMs ?? 0));
}

/**
 * Elimina un singolo database di test. Rifiuta i nomi che non siano delle run:
 * una variabile sbagliata non deve poter cancellare il database del gestionale.
 */
export async function eliminaDatabaseTest(connectionString: string, nome: string): Promise<void> {
  if (!NOME_VALIDO.test(nome)) {
    throw new Error(`Nome rifiutato: «${nome}» non è un database di test.`);
  }
  const identificatore = `"${nome.replace(/"/g, '""')}"`;

  // WITH (FORCE) chiude le connessioni rimaste appese; il pool gestito può
  // impiegare un istante a rilasciarle, quindi si riprova un paio di volte
  // invece di lasciare il database appeso come prima.
  let ultimo: unknown = null;
  for (let tentativo = 0; tentativo < 5; tentativo++) {
    try {
      await conClient(connectionString, (c) =>
        c.query(`DROP DATABASE IF EXISTS ${identificatore} WITH (FORCE)`).then(() => undefined),
      );
      return;
    } catch (error) {
      ultimo = error;
      await new Promise((done) => setTimeout(done, 300));
    }
  }
  throw ultimo;
}

/** Domanda sì/no sul terminale (visibile: non è un segreto). */
function conferma(domanda: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(domanda, (risposta) => {
      rl.close();
      resolve(/^(s|si|sì|y|yes)$/i.test(risposta.trim()));
    });
  });
}

function messaggioDatabase(err: unknown): string {
  const msg = (err as Error)?.message ?? String(err);
  // Restrizione dell'account Prisma: nessun comando può passare finché non è
  // rimossa dal supporto. Il messaggio deve dire questo, non «connessione persa».
  if (/planLimitReached/i.test(msg)) {
    return (
      "L'account Prisma rifiuta la connessione con la restrizione «planLimitReached».\n" +
      "Non dipende dal comando: serve che il supporto Prisma sblocchi l'account.\n" +
      "Appena è sbloccato, rilancia lo stesso comando: eliminerà i database residui."
    );
  }
  const code = (err as { code?: string })?.code;
  if (code === "28P01" || code === "28000") {
    return "Il database ha rifiutato le credenziali: controlla DATABASE_URL_TEST nel file .env.";
  }
  if (code === "ENOTFOUND" || code === "ECONNREFUSED" || code === "ETIMEDOUT") {
    return "Database non raggiungibile: controlla la connessione e DATABASE_URL_TEST.";
  }
  return msg;
}

async function main(): Promise<void> {
  const connectionString = testUrlFromEnv();
  console.log(`Server dei test: ${istanza(connectionString)}`);

  const elenco = await elencoDatabaseTest(connectionString);
  if (!elenco.length) {
    console.log("Nessun database di test residuo.");
    return;
  }

  const tutti = process.argv.includes("--tutti");
  const residui = elenco.filter((db) => tutti || !db.recente);
  const inCorso = elenco.filter((db) => !tutti && db.recente);

  const riga = (db: DatabaseTest): string => {
    const quando_ = db.etaMs === null ? "data sconosciuta" : `${quando(Date.now() - db.etaMs)} (${eta(db.etaMs)} fa)`;
    return `  ${db.nome} — ${quando_}`;
  };

  if (residui.length) {
    console.log(`Database di test residui (${residui.length}):`);
    for (const db of residui) console.log(riga(db));
  } else {
    console.log("Nessun database di test residuo da eliminare.");
  }

  if (inCorso.length) {
    console.log(
      `\nCreati da meno di un'ora, forse una run in corso — non li tocco (${inCorso.length}):`,
    );
    for (const db of inCorso) console.log(riga(db));
    console.log("Per includerli: npm run db:pulisci-test -- --tutti");
  }

  if (!residui.length) return;

  // Conferma esplicita: l'eliminazione non si annulla. `--sì` serve agli
  // script; senza terminale non si presume mai un «sì».
  const salta = process.argv.includes("--sì") || process.argv.includes("--si");
  if (!salta) {
    if (!process.stdin.isTTY) {
      throw new Error(
        "Serve un terminale interattivo per confermare l'eliminazione.\n" +
          "In automazione aggiungi --sì dopo --: npm run db:pulisci-test -- --sì",
      );
    }
    const certo = await conferma(`Eliminare ${residui.length} database? [s/n] `);
    if (!certo) {
      console.log("Nessuna modifica fatta.");
      return;
    }
  }

  let eliminati = 0;
  const falliti: string[] = [];
  for (const db of residui) {
    try {
      await eliminaDatabaseTest(connectionString, db.nome);
      eliminati++;
      console.log(`Eliminato: ${db.nome}`);
    } catch (error) {
      falliti.push(db.nome);
      console.error(`Non eliminato: ${db.nome} — ${messaggioDatabase(error)}`);
    }
  }

  console.log(`\nEliminati ${eliminati} database di test su ${residui.length}.`);
  if (falliti.length) {
    console.error(`Restano ${falliti.length} database: rilancia il comando per riprovare.`);
    process.exitCode = 1;
    return;
  }
  console.log("Nessun database di test residuo.");
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(`Pulizia non riuscita: ${messaggioDatabase(err)}`);
    process.exitCode = 1;
  });
}
