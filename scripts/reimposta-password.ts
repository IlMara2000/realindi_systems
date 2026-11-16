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
//   npm run password:reimposta              (chiede la nuova password)
//   npm run password:reimposta -- --stato   (solo diagnosi, non scrive nulla)
//
// Usa DATABASE_URL (la stessa connessione dell'applicazione), quindi agisce
// sull'istanza che si sta davvero usando: in locale o in produzione.
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { LIMITE_TENTATIVI_LOGIN, hashPassword } from "../src/util.js";

const MIN_LUNGHEZZA = 12;

export interface EsitoReimpostazione {
  /** true se il workspace aveva già una password (sostituita), false se è stata creata. */
  workspaceProtetto: boolean;
  sessioniChiuse: number;
  /** Mostrato una volta sola: nel database ne resta solo l'hash. */
  codiceEmergenza: string;
}

export interface IpBloccato {
  ip: string;
  tentativi: number;
  secondiResidui: number;
}

export interface StatoAccesso {
  passwordPresente: boolean;
  /** Un codice di emergenza valido esiste: si può rientrare senza terminale. */
  emergenzaPresente: boolean;
  sessioniAttive: number;
  bloccati: IpBloccato[];
}

/**
 * Diagnosi in sola lettura: risponde a «la password è sbagliata o sono
 * bloccato?» senza scrivere niente. Un IP è bloccato quando ha raggiunto la
 * soglia di errori e la finestra non è ancora scaduta.
 */
export async function statoAccesso(connectionString: string): Promise<StatoAccesso> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const now = Date.now() / 1000;
    const password = await client.query("SELECT 1 FROM settings WHERE key = 'password'");
    const emergenza = await client.query("SELECT 1 FROM settings WHERE key = 'password_emergenza'");
    const sessioni = await client.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM sessions WHERE expires > $1",
      [now],
    );
    const bloccati = await client.query<{ ip: string; count: number; reset: number }>(
      "SELECT ip, count, reset FROM login_attempts WHERE count >= $1 AND reset > $2 ORDER BY reset ASC",
      [LIMITE_TENTATIVI_LOGIN, now],
    );
    return {
      passwordPresente: (password.rowCount ?? 0) > 0,
      emergenzaPresente: (emergenza.rowCount ?? 0) > 0,
      sessioniAttive: sessioni.rows[0].n,
      bloccati: bloccati.rows.map((row) => ({
        ip: row.ip,
        tentativi: row.count,
        secondiResidui: Math.ceil(row.reset - now),
      })),
    };
  } finally {
    await client.end();
  }
}

/** Attesa del blocco in minuti: la finestra dura 15, quindi le ore non arrivano. */
function attesaMinuti(secondi: number): string {
  const minuti = Math.ceil(secondi / 60);
  return minuti <= 1 ? "meno di un minuto" : `${minuti} minuti`;
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
    // Codice di emergenza nuovo a ogni reimpostazione: quello vecchio smette di
    // valere, così un codice dimenticato in giro non resta una porta aperta.
    const emergenza = `em-${randomBytes(24).toString("base64url")}`;
    const emergenzaSalt = randomBytes(16).toString("hex");
    const emergenzaValue = JSON.stringify([emergenzaSalt, hashPassword(emergenza, emergenzaSalt)]);
    const sessioni = await client.query("DELETE FROM sessions");

    await client.query("BEGIN");
    const aggiornate = await client.query("UPDATE settings SET value = $1 WHERE key = 'password'", [value]);
    if (aggiornate.rowCount === 0) {
      await client.query("INSERT INTO settings (key, value) VALUES ('password', $1)", [value]);
    }
    await client.query(
      "INSERT INTO settings (key, value) VALUES ('password_emergenza', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [emergenzaValue],
    );
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
    const salvataEmergenza = await client.query<{ value: string }>(
      "SELECT value FROM settings WHERE key = 'password_emergenza'",
    );
    const [lettoSaltEm, lettoHashEm] = JSON.parse(salvataEmergenza.rows[0].value) as [string, string];
    if (hashPassword(emergenza, lettoSaltEm) !== lettoHashEm) {
      throw new Error("Verifica fallita: il codice di emergenza salvato non corrisponde.");
    }

    return {
      workspaceProtetto: (esistente.rowCount ?? 0) > 0,
      sessioniChiuse: sessioni.rowCount ?? 0,
      codiceEmergenza: emergenza,
    };
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

  if (process.argv.includes("--stato")) {
    const stato = await statoAccesso(connectionString);
    console.log(
      stato.passwordPresente
        ? "Password del workspace: impostata."
        : "Password del workspace: assente (il gestionale chiede di crearne una al primo accesso).",
    );
    console.log(
      stato.emergenzaPresente
        ? "Codice di emergenza: impostato (permette di rientrare senza terminale)."
        : "Codice di emergenza: assente (una reimpostazione ne genera uno nuovo).",
    );
    console.log(`Sessioni attive: ${stato.sessioniAttive}.`);
    if (!stato.bloccati.length) {
      console.log("IP bloccati: nessuno.");
      if (stato.passwordPresente) {
        console.log("Quindi un accesso rifiutato è una password sbagliata, non un blocco.");
      }
    } else {
      console.log(`IP bloccati: ${stato.bloccati.length}.`);
      for (const b of stato.bloccati) {
        console.log(
          `  ${b.ip} — ${b.tentativi} errori, ancora ${attesaMinuti(b.secondiResidui)}.`,
        );
      }
    }
    console.log("Sola lettura: nessuna modifica al database.");
    return;
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
  console.log("La password non viene mostrata: salvala ora nel gestore password.");
  console.log("");
  console.log("Codice di emergenza (nuovo, mostrato solo ora):");
  console.log(`  ${esito.codiceEmergenza}`);
  console.log(
    "Salvalo insieme alla password: entra da /app senza terminale. Quello precedente non vale più.",
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(`Reimpostazione non riuscita: ${messaggioDatabase(err)}`);
    process.exitCode = 1;
  });
}
