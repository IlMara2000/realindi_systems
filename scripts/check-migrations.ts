// Verifica che le migrazioni versionate descrivano ancora prisma/schema.prisma.
//
// Il controllo non confronta il testo dei due schemi: Postgres normalizza i
// default (aggiunge i cast ::text), quindi `prisma migrate diff` segnala
// differenze che non esistono. Si confronta invece la struttura che i due
// percorsi producono davvero: due database temporanei, uno costruito
// applicando prisma/migrations e uno con il DDL ricavato dallo schema attuale,
// confrontati su tabelle, colonne, tipi, nullabilità e indici.
//
// Se una modifica a schema.prisma non è accompagnata da una migrazione, il
// database "dalle migrazioni" non ha la nuova colonna o tabella e il confronto
// lo dice, con il nome della colonna.
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { Client } from "pg";
import { verificaHost } from "./host-guard.js";

const mother = process.env.DATABASE_URL_TEST?.trim() ?? process.env.DATABASE_URL?.trim();
if (!mother) throw new Error("Serve DATABASE_URL_TEST (con permesso di creare database).");

// Questo script crea e distrugge database: su un'istanza gestita è invasivo,
// quindi parte solo con un consenso esplicito sulla riga di comando.
const esitoHost = verificaHost(mother, {
  consenso: process.argv.includes("--consenti-remoto"),
  ruolo: "DATABASE_URL_TEST",
});
if (!esitoHost.consentito) {
  console.error(esitoHost.messaggio);
  process.exit(1);
}
if (esitoHost.avviso) console.warn(esitoHost.avviso);

// Un database appena creato non è raggiungibile attraverso il pooler: la
// mappatura non esiste ancora, e la connessione risponde «Failed to connect to
// upstream database». Se DIRECT_URL è impostata, ogni connessione di questo
// controllo passa dall'endpoint diretto: stesse credenziali, stesso server,
// cambia solo l'host.
const base = process.env.DIRECT_URL?.trim() || mother;

function urlFor(name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

async function withClient<T>(url: string, fn: (client: Client) => Promise<T>): Promise<T> {
  // Limiti espliciti: un pooler che non risponde non deve appendere la CI.
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 15_000, statement_timeout: 60_000 });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function createDatabase(name: string): Promise<string> {
  await withClient(base, (client) => client.query(`CREATE DATABASE "${name}"`).then(() => undefined));
  return urlFor(name);
}

async function dropDatabase(name: string): Promise<void> {
  await withClient(base, (client) =>
    client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).then(() => undefined),
  ).catch((error) => {
    console.error(`Database temporaneo ${name} non eliminato: ${(error as Error)?.message}`);
  });
}

/** Applica le migrazioni al database appena creato. */
function applyMigrations(url: string): void {
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    // prisma7.config.ts preferisce DIRECT_URL: va allineata all'URL del
    // database temporaneo. Senza, il deploy del controllo finirebbe sul
    // database indicato nel .env — cioè la produzione.
    env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
    timeout: 120_000,
  });
}

/** Applica il DDL che lo schema attuale produrrebbe, senza migrazioni. */
async function applySchema(url: string): Promise<void> {
  const ddl = execFileSync(
    "npx",
    ["prisma", "migrate", "diff", "--from-empty", "--to-schema", "prisma/schema.prisma", "--script"],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], timeout: 120_000 },
  );
  await withClient(url, (client) => client.query(ddl).then(() => undefined));
}

interface Shape {
  tables: Set<string>;
  columns: Set<string>;
  indexes: Set<string>;
}

async function shape(url: string): Promise<Shape> {
  return withClient(url, async (client) => {
    const columnRows = await client.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
      character_maximum_length: number | null;
      numeric_precision: number | null;
      numeric_scale: number | null;
    }>(
      `SELECT table_name, column_name, data_type, is_nullable, character_maximum_length, numeric_precision, numeric_scale
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name <> '_prisma_migrations'
        ORDER BY table_name, column_name`,
    );
    const indexRows = await client.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
        ORDER BY indexname`,
    );

    const tables = new Set(columnRows.rows.map((row) => row.table_name));
    const columns = new Set(
      columnRows.rows.map((row) => {
        const size =
          row.character_maximum_length !== null
            ? `(${row.character_maximum_length})`
            : row.numeric_scale !== null
              ? `(${row.numeric_precision},${row.numeric_scale})`
              : "";
        return `${row.table_name}.${row.column_name} ${row.data_type}${size} ${row.is_nullable === "YES" ? "null" : "not null"}`;
      }),
    );
    // indexdef contiene già tabella, colonne e unicità: confrontato così com'è
    // segnala anche un indice o un vincolo dimenticato nella migrazione.
    const indexes = new Set(indexRows.rows.map((row) => row.indexdef));
    return { tables, columns, indexes };
  });
}

function difference(expected: Set<string>, actual: Set<string>): string[] {
  return [...expected].filter((entry) => !actual.has(entry));
}

function report(label: string, missing: string[], extra: string[]): boolean {
  if (missing.length === 0 && extra.length === 0) return false;
  console.error(`\n${label}`);
  for (const entry of missing) console.error(`  manca nella migrazione: ${entry}`);
  for (const entry of extra) console.error(`  c'è solo nella migrazione: ${entry}`);
  return true;
}

const stamp = Date.now().toString(36) + randomBytes(2).toString("hex");
const fromMigrations = `realindi_check_mig_${stamp}`;
const fromSchema = `realindi_check_sch_${stamp}`;

let failed = false;
try {
  const migrationsUrl = await createDatabase(fromMigrations);
  applyMigrations(migrationsUrl);
  const schemaUrl = await createDatabase(fromSchema);
  await applySchema(schemaUrl);

  const actual = await shape(migrationsUrl);
  const expected = await shape(schemaUrl);

  failed =
    report(
      "Tabelle diverse: lo schema ha tabelle che le migrazioni non creano (o il contrario).",
      difference(expected.tables, actual.tables),
      difference(actual.tables, expected.tables),
    ) ||
    // I nomi delle colonne sono già dentro le stringhe: qui si isolano i
    // campi mancanti senza ripetere due volte la stessa colonna per ogni
    // attributo cambiato.
    report(
      "Colonne diverse: manca una migrazione per una modifica a schema.prisma.",
      difference(expected.columns, actual.columns),
      difference(actual.columns, expected.columns),
    ) ||
    report(
      "Indici o vincoli diversi.",
      difference(expected.indexes, actual.indexes),
      difference(actual.indexes, expected.indexes),
    );

  if (failed) {
    console.error(
      "\nCrea la migrazione con `npx prisma migrate dev --name <nome>`, rileggi il file SQL e committalo.\n",
    );
  } else {
    console.log("Migrazioni allineate allo schema.");
  }
} finally {
  await dropDatabase(fromMigrations);
  await dropDatabase(fromSchema);
}

process.exit(failed ? 1 : 0);
