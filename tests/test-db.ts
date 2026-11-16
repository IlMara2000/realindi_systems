// Database unico della suite: connessione e svuotamento delle tabelle.
//
// Sta qui, e non in tests/global-setup.ts, perché serve in due momenti: al via
// della run (global setup) e prima di ogni singolo test (`resetDb` in
// tests/helpers.ts). Tenere un solo elenco di tabelle evita che una tabella
// aggiunta allo schema resti piena fra un test e l'altro senza che nessuno se
// ne accorga.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";

/**
 * DATABASE_URL_TEST dall'ambiente o, se lì non c'è, dal file .env: è il
 * database su cui gira tutta la suite, sempre lo stesso fra una run e l'altra.
 */
export function testUrlFromEnv(): string {
  const fromProcess = process.env.DATABASE_URL_TEST?.trim();
  if (fromProcess) return fromProcess;

  let text: string;
  try {
    text = readFileSync(resolve(process.cwd(), ".env"), "utf8");
  } catch {
    // In CI non esiste un file .env: la variabile deve arrivare dall'ambiente.
    throw new Error("DATABASE_URL_TEST mancante: non è nell'ambiente e non c'è un file .env");
  }
  const line = text.split("\n").find((l) => l.startsWith("DATABASE_URL_TEST="));
  const url = line?.slice("DATABASE_URL_TEST=".length).trim();
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
        AND tablename NOT LIKE '\\_prisma%'
      ORDER BY tablename`,
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
    if (!tabelle.length) return;
    await client.query(`TRUNCATE TABLE ${tabelle.map(virgolette).join(", ")} RESTART IDENTITY CASCADE`);
  } finally {
    await client.end();
  }
}
