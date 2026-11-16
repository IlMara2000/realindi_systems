// Database di test unico per tutte le esecuzioni della suite.
//
// Prima ogni `vitest run` creava un database `realindi_test_run_*`, ci
// applicava le migrazioni e lo eliminava alla fine. L'isolamento era massimo,
// ma una run interrotta (Ctrl+C, worker ucciso, connessione caduta) lasciava il
// database sul server: l'account Prisma ha un tetto al numero di database e,
// accumulati, ha finito per rifiutare ogni connessione con `planLimitReached`.
//
// Ora la suite usa sempre il database indicato da DATABASE_URL_TEST: qui si
// applicano le migrazioni e si svuotano le tabelle, quindi una run non eredita
// niente da quella precedente. Nessun database viene creato o eliminato, e il
// loro numero non cresce più.
//
// L'isolamento fra i test non cambia: tests/helpers.ts chiama `resetDb()` in
// ogni `beforeEach`, che svuota le stesse tabelle (stesso codice, in
// tests/test-db.ts). L'unica cosa che questo schema non copre sono due run
// contemporanee sullo stesso database, che si troncherebbero le tabelle a
// vicenda: vanno eseguite una alla volta.
import { execFileSync } from "node:child_process";
import { svuotaTabelle, testUrlFromEnv } from "./test-db.js";

/**
 * Applica le migrazioni di prisma/migrations al database di test: sono le
 * stesse che girano in produzione (`npm run db:migrate`), quindi una migrazione
 * rotta fa fallire i test invece di scoprirsi al deploy. È idempotente: su un
 * database già aggiornato non fa nulla, e copre anche le run precedenti a un
 * cambio di schema.
 */
function applyMigrations(url: string): void {
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    // prisma7.config.ts preferisce DIRECT_URL. Senza questo override le
    // migrazioni finirebbero sull'endpoint diretto (quello di .env) invece che
    // sul database di test, che resterebbe vuoto.
    env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
  });
}

export async function setup(): Promise<() => Promise<void>> {
  const url = testUrlFromEnv();
  applyMigrations(url);
  // Ciò che ha lasciato una run interrotta non deve influire su questa.
  await svuotaTabelle(url);

  // tests/helpers.ts usa questo URL: nessun test tocca realindi_test per
  // sbaglio, nemmeno se DATABASE_URL nel file .env punta altrove.
  process.env.DATABASE_URL_TEST_RUN = url;

  // Niente da smontare: il database resta, è lo stesso per ogni run.
  return async () => {};
}
