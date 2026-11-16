// Reimposta la password del workspace quando quella salvata non è più quella
// che si ricorda. Il CRM non ha un recupero via email (un solo titolare,
// nessun servizio di posta garantito), quindi l'unico modo è scrivere un nuovo
// hash nel database con lo stesso formato usato dal login:
// `settings.password = [salt_hex, pbkdf2_hmac('sha256', password, salt, 300000)]`.
//
// La vecchia password non viene letta — non è possibile, è un hash — e i dati
// del CRM non vengono toccati. Oltre alla password:
//   - chiude tutte le sessioni aperte (i cookie già emessi smettono di valere);
//   - azzera `login_attempts`, altrimenti dopo dieci errori l'IP resta bloccato
//     per quindici minuti anche con la password nuova.
//
//   npm run password:reimposta
//
// Usa DATABASE_URL (la stessa connessione dell'applicazione), quindi agisce
// sull'istanza che si sta davvero usando: in locale o in produzione.
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { hashPassword } from "../src/util.js";

const MIN_LUNGHEZZA = 12;

export interface EsitoReimpostazione {
  /** true se il workspace aveva già una password (sostituita), false se è stata creata. */
  workspaceProtetto: boolean;
  sessioniChiuse: number;
}

/**
 * Scrive `nuovaPassword` nel workspace e riporta il database in uno stato in
 * cui il login funziona subito: sessioni chiuse, blocco dei tentativi azzerato.
 * L'hash viene riletto e ricontrollato prima di dichiarare il successo.
 */
export async function reimpostaPassword(
  connectionString: string,
  nuovaPassword: string,
): Promise<EsitoReimpostazione> {
  if (nuovaPassword.length < MIN_LUNGHEZZA) {
    throw new Error(`Password troppo corta: servono almeno ${MIN_LUNGHEZZA} caratteri.`);
  }

  const client = new Client({ connectionString });
  await client.connect();
  try {
    const esistente = await client.query<{ value: string }>(
      "SELECT value FROM settings WHERE key = 'password'",
    );

    const salt = randomBytes(16).toString("hex");
    const value = JSON.stringify([salt, hashPassword(nuovaPassword, salt)]);
    const sessioni = await client.query("DELETE FROM sessions");

    await client.query("BEGIN");
    const aggiornate = await client.query("UPDATE settings SET value = $1 WHERE key = 'password'", [value]);
    if (aggiornate.rowCount === 0) {
      await client.query("INSERT INTO settings (key, value) VALUES ('password', $1)", [value]);
    }
    // Sblocca l'IP: i tentativi falliti non devono impedire l'accesso con la
    // password appena impostata.
    await client.query("DELETE FROM login_attempts");
    await client.query("COMMIT");

    // Rilettura: conferma che nel database è finito l'hash della password
    // digitata, non solo che l'UPDATE è andato a buon fine.
    const salvata = await client.query<{ value: string }>(
      "SELECT value FROM settings WHERE key = 'password'",
    );
    const [lettoSalt, lettoHash] = JSON.parse(salvata.rows[0].value) as [string, string];
    if (hashPassword(nuovaPassword, lettoSalt) !== lettoHash) {
      throw new Error("Verifica fallita: la password salvata non corrisponde a quella digitata.");
    }

    return { workspaceProtetto: (esistente.rowCount ?? 0) > 0, sessioniChiuse: sessioni.rowCount ?? 0 };
  } finally {
    await client.end();
  }
}

/** Legge una riga dal terminale senza mostrarla (né sulla riga, né nella history). */
function leggiNascosta(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    let valore = "";
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(valore);
          return;
        }
        if (ch === "\u0003") {
          // Ctrl+C: esce senza scrivere nulla.
          process.stdin.setRawMode(false);
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") {
          valore = valore.slice(0, -1);
          continue;
        }
        valore += ch;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function chiediNuovaPassword(): Promise<string> {
  // Via ambiente (utile in automazione): evita di dover digitare.
  const daAmbiente = process.env.NUOVA_PASSWORD;
  if (daAmbiente !== undefined) return daAmbiente;

  if (!process.stdin.isTTY) {
    throw new Error(
      "Serve un terminale interattivo per digitare la password senza mostrarla.\n" +
        "In automazione imposta NUOVA_PASSWORD.",
    );
  }
  const prima = await leggiNascosta(`Nuova password (almeno ${MIN_LUNGHEZZA} caratteri): `);
  if (prima.length < MIN_LUNGHEZZA) {
    throw new Error(`Password troppo corta: servono almeno ${MIN_LUNGHEZZA} caratteri.`);
  }
  const seconda = await leggiNascosta("Ripetila per conferma: ");
  if (prima !== seconda) throw new Error("Le due password non coincidono. Nessuna modifica fatta.");
  return prima;
}

function messaggioDatabase(err: unknown): string {
  const code = (err as { code?: string })?.code;
  if (code === "42P01") {
    return "Il database non ha la tabella settings: esegui prima `npm run db:migrate`.";
  }
  if (code === "28P01" || code === "28000") {
    return "Il database ha rifiutato le credenziali: controlla DATABASE_URL nel file .env.";
  }
  if (code === "ENOTFOUND" || code === "ECONNREFUSED" || code === "ETIMEDOUT") {
    return "Database non raggiungibile: controlla la connessione e DATABASE_URL.";
  }
  return (err as Error)?.message ?? String(err);
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error("DATABASE_URL non configurato: compila il file .env.");
  }

  const nuova = await chiediNuovaPassword();
  const esito = await reimpostaPassword(connectionString, nuova);

  console.log(
    esito.workspaceProtetto
      ? "Workspace già protetto da password: l'ho sostituita."
      : "Workspace senza password: l'ho impostata.",
  );
  console.log(`Password del workspace aggiornata. Sessioni aperte chiuse: ${esito.sessioniChiuse}.`);
  console.log("Blocco dei tentativi azzerato. Accedi da /app con la nuova password.");
  console.log("Non viene mostrata: salvala ora nel gestore password.");
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(`Reimpostazione non riuscita: ${messaggioDatabase(err)}`);
    process.exitCode = 1;
  });
}
