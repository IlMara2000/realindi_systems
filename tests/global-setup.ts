// Database di test unico per tutte le esecuzioni della suite, più pulizia dei
// database che le vecchie run lasciavano dietro.
//
// Prima ogni `vitest run` creava un database `realindi_test_run_*`, ci
// applicava le migrazioni e lo eliminava alla fine. L'isolamento era massimo,
// ma una run interrotta (Ctrl+C, worker ucciso, connessione caduta) lasciava il
// database sul server: l'account Prisma ha un tetto al numero di database e,
// accumulati, ha finito per rifiutare ogni connessione con `planLimitReached`.
//
// Ora la suite usa sempre il database indicato da DATABASE_URL_TEST: qui si
// applicano le migrazioni e si svuotano le tabelle, quindi una run non eredita
// niente da quella precedente. Nessun database viene creato, e il loro numero
// non cresce più. I residui delle vecchie run, però, restano finché qualcuno
// non li elimina: per questo la run li cancella da sola in due momenti.
//
//   - all'avvio, quelli più vecchi di un'ora (nessuna run può più usarli);
//   - alla fine, quelli nati durante questa esecuzione: oggi non ce ne sono,
//     ma se una modifica futura reintroducesse un database per run il teardown
//     lo elimina anche quando i test falliscono.
//
// Resta scoperto solo il Ctrl+C durante la run: vitest non chiama il teardown,
// ma è esattamente il caso che la pulizia all'avvio successivo copre.
//
// L'isolamento fra i test non cambia: tests/helpers.ts chiama `resetDb()` in
// ogni `beforeEach`, che svuota le stesse tabelle (stesso codice, in
// tests/test-db.ts). L'unica cosa che questo schema non copre sono due run
// contemporanee sullo stesso database, che si troncherebbero le tabelle a
// vicenda: vanno eseguite una alla volta.
import { execFileSync } from "node:child_process";
import {
  type DatabaseTest,
  creatiDurante,
  eliminaDatabaseTest,
  elencoDatabaseTest,
  orfani,
  svuotaTabelle,
  testUrlFromEnv,
} from "./test-db.js";

/** Momento in cui è partita questa run: separa i residui dai database della run. */
let inizioRunMs = Date.now();

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

/**
 * Elenco dei database di test. Se il server non risponde avvisa e restituisce
 * null: la pulizia è un servizio accessorio e non deve fermare la suite.
 */
async function elencoConAvviso(url: string, contesto: string): Promise<DatabaseTest[] | null> {
  try {
    return await elencoDatabaseTest(url);
  } catch (error) {
    console.warn(`${contesto}: ${(error as Error).message}`);
    return null;
  }
}

/**
 * Elimina i database indicati, uno per uno: un singolo errore non deve
 * impedire la pulizia degli altri. Restituisce quanti ne sono spariti davvero.
 */
async function eliminaTutti(url: string, elenco: DatabaseTest[]): Promise<number> {
  let eliminati = 0;
  for (const db of elenco) {
    try {
      await eliminaDatabaseTest(url, db.nome);
      eliminati++;
      console.log(`  eliminato ${db.nome}`);
    } catch (error) {
      console.warn(`  non eliminato ${db.nome}: ${(error as Error).message}`);
    }
  }
  return eliminati;
}

/**
 * All'avvio elimina i `realindi_test_run_*` rimasti da run interrotte: ognuno
 * occupa un posto nel tetto dell'account Prisma, ed è così che il limite è
 * stato raggiunto la prima volta. Meglio liberarli prima che i test lavorino.
 *
 * Un errore qui non ferma la suite: se il server rifiuta (account bloccato,
 * credenziali sbagliate) il problema vero lo dirà la migrazione subito dopo,
 * con un messaggio più preciso.
 */
async function pulisciOrfani(url: string): Promise<void> {
  const elenco = await elencoConAvviso(url, "Pulizia dei database di test rimandata");
  if (!elenco?.length) return;

  for (const candidato of elenco.filter((db) => db.recente)) {
    console.warn(
      `Database di test creato da meno di un'ora, forse una run in corso: ${candidato.nome} (non lo tocco)`,
    );
  }
  const vecchi = orfani(elenco);
  if (!vecchi.length) return;

  console.log(`Database di test rimasti da run precedenti (${vecchi.length}): li elimino.`);
  const eliminati = await eliminaTutti(url, vecchi);
  if (eliminati < vecchi.length) {
    console.warn(
      `Restano ${vecchi.length - eliminati} database di test: ` +
        "rilancia `npm run db:pulisci-test` quando il database risponde.",
    );
  }
}

export async function setup(): Promise<void> {
  inizioRunMs = Date.now();
  const url = testUrlFromEnv();
  // Prima la pulizia, poi le migrazioni: se il server è al limite del piano,
  // liberare i residui è l'unica cosa che può ancora riuscire.
  await pulisciOrfani(url);
  applyMigrations(url);
  // Ciò che ha lasciato una run interrotta non deve influire su questa.
  await svuotaTabelle(url);

  // Il database usato dai test resta: è lo stesso per ogni run. L'URL non
  // viene propagato da qui: tests/helpers.ts lo ricava da testUrlFromEnv(),
  // così il worker non dipende dallo stato di questo processo.
}

/**
 * Fine della run: elimina i database nati durante questa esecuzione. Oggi non
 * ce ne sono, quindi di norma qui non succede nulla; se qualcuno reintroducesse
 * un database per run, questo passaggio lo rimuove anche a test falliti.
 */
export async function teardown(): Promise<void> {
  const url = testUrlFromEnv();
  const elenco = await elencoConAvviso(url, "Pulizia di fine run rimandata");
  if (!elenco?.length) return;

  const miei = creatiDurante(elenco, inizioRunMs);
  if (!miei.length) return;

  console.log(`Database di test creati da questa run (${miei.length}): li elimino.`);
  const eliminati = await eliminaTutti(url, miei);
  if (eliminati < miei.length) {
    console.warn(
      `Restano ${miei.length - eliminati} database di questa run: ` +
        "verranno eliminati al prossimo avvio dopo un'ora (`npm run db:pulisci-test` per farlo subito).",
    );
  }
}
