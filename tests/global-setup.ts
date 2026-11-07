// Isolamento del database fra esecuzioni della suite.
//
// Ogni `vitest run` crea un database Postgres dedicato (prefisso
// realindi_test_run_), ci applica il DDL dello schema Prisma e lo elimina alla
// fine. Due run contemporanee — o un worker rimasto vivo da una run interrotta
// — scrivono quindi su database diversi e non possono più troncare le tabelle
// l'una dell'altra: era questa la causa dei fallimenti intermittenti (setup
// "già completato", sessioni sparite, foreign key violate a metà test).
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";

const PREFIX = "realindi_test_run_";

/** Database lasciati da run interrotte: si eliminano dopo un'ora (una run dura minuti). */
const STALE_MS = 60 * 60 * 1000;

let created: string | null = null;

/** DATABASE_URL_TEST dal file .env: da lì si ricava il database madre. */
function testUrlFromEnv(): string {
  const text = readFileSync(resolve(process.cwd(), ".env"), "utf8");
  const line = text.split("\n").find((l) => l.startsWith("DATABASE_URL_TEST="));
  const url = line?.slice("DATABASE_URL_TEST=".length).trim();
  if (!url) throw new Error("DATABASE_URL_TEST mancante in .env");
  return url;
}

/** Stessa connessione (host, credenziali, sslmode) su un altro database. */
function databaseUrlFor(base: string, name: string): string {
  const parsed = new URL(base);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

async function withClient<T>(url: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * DDL completo dello schema Prisma, lo stesso che `prisma db push` applica al
 * database di sviluppo. Calcolarlo qui evita di far girare db push contro
 * l'host pooled, dove l'applicazione a metà si interrompe.
 */
function schemaDdl(): string {
  return execFileSync(
    "npx",
    ["prisma", "migrate", "diff", "--from-empty", "--to-schema", "prisma/schema.prisma", "--script"],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
  );
}

/**
 * WITH (FORCE) chiude le connessioni rimaste appese (worker vitest orfani). Il
 * pool gestito può impiegare un istante a rilasciarle: il primo tentativo può
 * fallire, quindi si riprova invece di lasciare il database appeso.
 */
async function dropDatabase(base: string, name: string): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await withClient(base, (c) => c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).then(() => undefined));
      return;
    } catch (error) {
      lastError = error;
      await new Promise((done) => setTimeout(done, 300));
    }
  }
  throw lastError;
}

/** I nome delle run contengono il timestamp in base36: si scartano i vecchi. */
async function dropStale(base: string): Promise<void> {
  const names = await withClient(base, async (c) => {
    const result = await c.query<{ datname: string }>("SELECT datname FROM pg_database WHERE datname LIKE $1", [
      `${PREFIX}%`,
    ]);
    return result.rows.map((row) => row.datname);
  });
  const cutoff = Date.now() - STALE_MS;
  for (const name of names) {
    const stamp = Number.parseInt(name.slice(PREFIX.length).split("_")[0], 36);
    if (Number.isFinite(stamp) && stamp < cutoff) await dropDatabase(base, name).catch(() => undefined);
  }
}

export async function setup(): Promise<() => Promise<void>> {
  const base = testUrlFromEnv();
  await dropStale(base);

  const name = `${PREFIX}${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
  const url = databaseUrlFor(base, name);
  await withClient(base, (c) => c.query(`CREATE DATABASE "${name}"`).then(() => undefined));
  created = name;
  await withClient(url, (c) => c.query(schemaDdl()).then(() => undefined));

  // tests/helpers.ts usa questo URL: nessun test tocca più realindi_test.
  process.env.DATABASE_URL_TEST_RUN = url;

  return async () => {
    // Se non si riesce a eliminarlo si avvisa: il database viene comunque
    // raccolto dal prossimo avvio, ma restare in silenzio lo renderebbe invisibile.
    if (created) {
      await dropDatabase(base, created).catch((error) => {
        console.error(`Database di test ${created} non eliminato: ${(error as Error)?.message}`);
      });
    }
    created = null;
  };
}
