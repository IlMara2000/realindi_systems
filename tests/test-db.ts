// Database unico della suite: connessione e svuotamento delle tabelle.
//
// Sta qui, e non in tests/global-setup.ts, perché serve in due momenti: al via
// della run (global setup) e prima di ogni singolo test (`resetDb` in
// tests/helpers.ts). Tenere un solo elenco di tabelle evita che una tabella
// aggiunta allo schema resti piena fra un test e l'altro senza che nessuno se
// ne accorga.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseDotenv } from "dotenv";
import { Client } from "pg";

/**
 * DATABASE_URL_TEST dall'ambiente o, se lì non c'è, dal file .env: è il
 * database su cui gira tutta la suite, sempre lo stesso fra una run e l'altra.
 */
export function testUrlFromEnv(): string {
  const fromProcess = process.env.DATABASE_URL_TEST?.trim();
  if (fromProcess) return fromProcess;

  // In CI non esiste un file .env: la variabile deve arrivare dall'ambiente.
  let text: string;
  try {
    text = readFileSync(resolve(process.cwd(), ".env"), "utf8");
  } catch {
    throw new Error("DATABASE_URL_TEST mancante: non è nell'ambiente e non c'è un file .env");
  }
  const parsed = parseDotenv(text);
  const url = parsed.DATABASE_URL_TEST?.trim();
  if (!url) throw new Error("DATABASE_URL_TEST mancante in .env");
  return url;
}

/** Identificatore SQL fra virgolette doppie. */
function virgolette(nome: string): string {
  return `"${nome.replace(/"/g, '""')}"`;
}

/**
 * Nomi delle tabelle applicative: tutto ciò che le migrazioni hanno creato,
 * tranne lo storico delle migrazioni stesse (cancellarlo farebbe credere a
 * Prisma che lo schema è vuoto e la run successiva riapplicherebbe le
 * migrazioni da capo).
 */
async function tabelleApplicative(client: Client): Promise<string[]> {
  const result = await client.query<{ tablename: string }>(
    `SELECT tablename
       FROM pg_tables
      WHERE schemaname = current_schema()
        AND tablename NOT LIKE '\\_prisma%'`,
  );
  return result.rows.map((row) => row.tablename);
}

/**
 * Svuota tutte le tabelle e riavvia le sequenze. RESTART IDENTITY riporta gli
 * id a 1 come in un database appena creato — i test contano sugli id bassi — e
 * CASCADE copre le foreign key fra tabelle svuotate insieme.
 *
 * Fa parte dell'isolamento: all'avvio della run cancella ciò che ha lasciato
 * una run interrotta, e in ogni `beforeEach` azzera il test precedente.
 */
export async function svuotaTabelle(connectionString: string): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const tabelle = await tabelleApplicative(client);
    if (!tabelle.length) {
      throw new Error(
        "Il database di test non ha tabelle applicative: le migrazioni non sono state applicate oppure DATABASE_URL_TEST punta al database sbagliato.",
      );
    }
    await client.query(`TRUNCATE TABLE ${tabelle.map(virgolette).join(", ")} RESTART IDENTITY CASCADE`);
  } finally {
    await client.end();
  }
}

// --- Database delle vecchie run (`realindi_test_run_*`) ---------------------
//
// Le versioni precedenti della suite creavano un database per ogni esecuzione.
// Oggi non se ne crea più nessuno, ma quelli rimasti occupano un posto nel tetto
// dell'account Prisma: accumulati sono ciò che ha portato al blocco
// `planLimitReached`, quindi vanno eliminati e non solo ignorati. Le regole
// stanno qui perché servono in tre punti: all'avvio della run, alla sua fine e
// a `npm run db:pulisci-test`.

/** Prefisso dei database creati dalle run. */
export const PREFISSO_DB_TEST = "realindi_test_run_";

/**
 * Oltre un'ora un `realindi_test_run_*` non può appartenere a una run ancora in
 * corso (una run dura minuti): è un residuo da eliminare. Sotto la soglia
 * potrebbe essere di un'altra run, e non si tocca.
 */
export const ORFANO_MS = 60 * 60 * 1000;

/** Nome ammesso: prefisso delle run e solo caratteri generati dal setup. */
const NOME_DB_TEST = new RegExp(`^${PREFISSO_DB_TEST}[a-z0-9]+_[a-f0-9]+$`);

export interface DatabaseTest {
  nome: string;
  /** Momento di creazione ricavato dal nome (base36); null se illeggibile. */
  creatoMs: number | null;
  /** Età in millisecondi; null se la creazione non è ricavabile. */
  etaMs: number | null;
  /** true se è nato da meno di ORFANO_MS: forse una run in corso. */
  recente: boolean;
}

/** Timestamp base36 incorporato nel nome; null se il nome non lo contiene. */
function creatoDaNome(nome: string): number | null {
  const stamp = Number.parseInt(nome.slice(PREFISSO_DB_TEST.length).split("_")[0] ?? "", 36);
  return Number.isFinite(stamp) ? stamp : null;
}

async function conClient<T>(connectionString: string, fn: (client: Client) => Promise<T>): Promise<T> {
  // Limite esplicito: con un database irraggiungibile il pooler può lasciare la
  // connessione appesa a lungo, e la pulizia all'avvio non deve bloccare la
  // suite. Meglio un errore dopo dieci secondi che un `npm test` fermo.
  const client = new Client({ connectionString, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Database di test presenti sul server, dal più vecchio al più recente.
 * Sola lettura: non elimina niente.
 */
export async function elencoDatabaseTest(connectionString: string): Promise<DatabaseTest[]> {
  const nomi = await conClient(connectionString, async (client) => {
    const result = await client.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datname LIKE $1 ORDER BY datname",
      [`${PREFISSO_DB_TEST}%`],
    );
    return result.rows.map((row) => row.datname);
  });

  const adesso = Date.now();
  return nomi
    .map((nome) => {
      const creatoMs = creatoDaNome(nome);
      const etaMs = creatoMs === null ? null : adesso - creatoMs;
      return { nome, creatoMs, etaMs, recente: etaMs !== null && etaMs < ORFANO_MS };
    })
    .sort((a, b) => (a.creatoMs ?? 0) - (b.creatoMs ?? 0));
}

/** Residui di run precedenti: più vecchi della soglia, quindi eliminabili. */
export function orfani(elenco: DatabaseTest[]): DatabaseTest[] {
  // I nomi senza timestamp leggibile non entrano mai: non si sa quanto siano
  // vecchi, e la regola è eliminare solo ciò che si può datare.
  return elenco.filter((db) => db.creatoMs !== null && !db.recente);
}

/**
 * Nati durante la run iniziata a `inizioRunMs`: sono quelli che la run deve
 * eliminare alla fine. La tolleranza copre la differenza fra l'orologio del
 * processo e quello del server, che può arrotondare al secondo.
 */
export function creatiDurante(
  elenco: DatabaseTest[],
  inizioRunMs: number,
  tolleranzaMs = 5_000,
): DatabaseTest[] {
  return elenco.filter((db) => db.creatoMs !== null && db.creatoMs >= inizioRunMs - tolleranzaMs);
}

/**
 * Elimina un singolo database di test. Rifiuta i nomi che non siano delle run:
 * una variabile sbagliata non deve poter cancellare il database del gestionale.
 */
export async function eliminaDatabaseTest(connectionString: string, nome: string): Promise<void> {
  if (!NOME_DB_TEST.test(nome)) {
    throw new Error(`Nome rifiutato: «${nome}» non è un database di test.`);
  }
  const identificatore = `"${nome.replace(/"/g, '""')}"`;

  // WITH (FORCE) chiude le connessioni rimaste appese; il pool gestito può
  // impiegare un istante a rilasciarle, quindi si riprova un paio di volte
  // invece di lasciare il database appeso come prima.
  let ultimo: unknown = null;
  for (let tentativo = 0; tentativo < 5; tentativo++) {
    try {
      await conClient(connectionString, (client) =>
        client.query(`DROP DATABASE IF EXISTS ${identificatore} WITH (FORCE)`).then(() => undefined),
      );
      return;
    } catch (error) {
      ultimo = error;
      await new Promise((done) => setTimeout(done, 300));
    }
  }
  throw ultimo;
}
