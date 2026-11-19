// Pulizia dei database di test rimasti appesi.
//
// Il setup dei test non crea più database: usa sempre quello di
// DATABASE_URL_TEST e ne svuota le tabelle. I `realindi_test_run_<ts>_<nonce>`
// rimasti sono quelli delle run interrotte di prima (Ctrl+C, worker ucciso,
// connessione caduta): occupano spazio nell'account Prisma e, se molti,
// contribuiscono al limite del piano che ha bloccato il database.
//
// La suite li elimina già da sola all'avvio (quelli più vecchi di un'ora) e
// alla fine della run (quelli nati durante la run, vedi tests/global-setup.ts).
// Questo comando serve per i casi che restano: una run interrotta da pochi
// minuti, o un residuo che l'ultima pulizia non è riuscita a eliminare.
//
//   npm run db:pulisci-test              (elenca i residui e chiede conferma)
//   npm run db:pulisci-test -- --tutti   (include anche quelli creati nell'ultima ora)
//   npm run db:pulisci-test -- --sì      (salta la conferma, per gli script)
//
// Usa DATABASE_URL_TEST: i database delle run nascono accanto a quello, quindi
// è la connessione giusta per vederli. Il database indicato dall'URL non viene
// mai toccato: si eliminano solo nomi che iniziano con `realindi_test_run_`.
// Elenco, soglia e nomi ammessi stanno in tests/test-db.ts, gli stessi che usa
// la suite: una regola sola, nessuna copia che può divergere.
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { ORFANO_MS, type DatabaseTest, eliminaDatabaseTest, elencoDatabaseTest, orfani, testUrlFromEnv } from "../tests/test-db.js";
import { ETICHETTE, classifica, descriviHost, rimedio } from "./diagnose-db.js";

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

/**
 * Errore in una riga, con la stessa classificazione e lo stesso vocabolario di
 * `npm run diagnose:db`: piano Prisma, credenziali o rete, non tre elenchi di
 * codici da tenere allineati a mano in due file. La stringa di connessione, se
 * passata, serve alla redazione del messaggio (mai stampata).
 */
function messaggioDatabase(err: unknown, connectionString = ""): string {
  const { esito, codice, messaggio } = classifica(err, connectionString);
  const intestazione = `${ETICHETTE[esito]}${codice ? ` [${codice}]` : ""}: ${messaggio}`;
  const consiglio = rimedio(esito, "DATABASE_URL_TEST");
  return consiglio ? `${intestazione}\n${consiglio}` : intestazione;
}

async function main(): Promise<void> {
  const connectionString = testUrlFromEnv();
  console.log(`Server dei test: ${descriviHost(connectionString) ?? "host non riconosciuto"}`);

  const elenco = await elencoDatabaseTest(connectionString);
  if (!elenco.length) {
    console.log("Nessun database di test residuo.");
    return;
  }

  const tutti = process.argv.includes("--tutti");
  const residui = tutti ? elenco : orfani(elenco);
  const inCorso = tutti ? [] : elenco.filter((db) => db.recente);

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
      `\nCreati da meno di ${Math.round(ORFANO_MS / 60000)} minuti, forse una run in corso — non li tocco (${inCorso.length}):`,
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
      console.error(`Non eliminato: ${db.nome} — ${messaggioDatabase(error, connectionString)}`);
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
