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
//   npm run password:reimposta                    (mostra il database, chiede conferma e la nuova password)
//   npm run password:reimposta -- --stato         (solo diagnosi, non scrive nulla)
//   npm run password:reimposta -- --sì            (salta la conferma, per gli script)
//   npm run password:reimposta -- --portachiavi   (salva password e codici nel Portachiavi di macOS:
//                                                  non compaiono né qui né nella cronologia)
//
// Con --portachiavi i codici finiscono nel Portachiavi su una riga sola,
// separati da «; »: `security` restituisce in esadecimale i valori con ritorni
// a capo, e un valore così non si legge né si verifica a occhio.
//
// Usa DATABASE_URL (la stessa connessione dell'applicazione), quindi agisce
// sull'istanza che si sta davvero usando: in locale o in produzione.
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { CODICI_EMERGENZA, LIMITE_TENTATIVI_LOGIN, hashCodice, hashPassword } from "../src/util.js";
import { ETICHETTE, classifica, descriviHost, rimedio } from "./diagnose-db.js";

const MIN_LUNGHEZZA = 12;

/** Voci del Portachiavi: nomi fissi, così si ritrovano sempre allo stesso posto. */
const SERVIZIO_PASSWORD = "REALINDI CRM - password";
const SERVIZIO_CODICI = "REALINDI CRM - codici di emergenza";

export interface EsitoReimpostazione {
  /** true se il workspace aveva già una password (sostituita), false se è stata creata. */
  workspaceProtetto: boolean;
  sessioniChiuse: number;
  /** Mostrati una volta sola: nel database ne restano solo gli hash, monouso. */
  codiciEmergenza: string[];
}

export interface IpBloccato {
  ip: string;
  tentativi: number;
  secondiResidui: number;
}

export interface StatoAccesso {
  passwordPresente: boolean;
  /** Quanti codici di emergenza restano (ognuno vale una volta sola). */
  codiciDisponibili: number;
  sessioniAttive: number;
  bloccati: IpBloccato[];
  /** Ultimo accesso riuscito registrato dall'app (null se lo storico è vuoto). */
  ultimoAccesso: { at: number; ip: string; via: string } | null;
}

/** Data e ora leggibili di un istante in millisecondi (Europe/Rome). */
function quando(ms: number): string {
  return new Date(ms).toLocaleString("it-IT", {
    timeZone: "Europe/Rome",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
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
    const emergenza = await client.query<{ value: string }>(
      "SELECT value FROM settings WHERE key = 'password_emergenza'",
    );
    const codiciDisponibili = emergenza.rows[0]
      ? (JSON.parse(emergenza.rows[0].value) as unknown[]).length
      : 0;
    const sessioni = await client.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM sessions WHERE expires > $1",
      [now],
    );
    // La tabella degli accessi arriva con una migrazione: su un database più
    // vecchio la diagnosi prosegue senza, invece di fermarsi.
    let ultimoAccesso: StatoAccesso["ultimoAccesso"] = null;
    try {
      const ultimo = await client.query<{ at: number; ip: string; via: string }>(
        "SELECT at, ip, via FROM login_events ORDER BY id DESC LIMIT 1",
      );
      ultimoAccesso = ultimo.rows[0] ?? null;
    } catch {
      // tabella assente
    }
    const bloccati = await client.query<{ ip: string; count: number; reset: number }>(
      "SELECT ip, count, reset FROM login_attempts WHERE count >= $1 AND reset > $2 ORDER BY reset ASC",
      [LIMITE_TENTATIVI_LOGIN, now],
    );
    return {
      passwordPresente: (password.rowCount ?? 0) > 0,
      codiciDisponibili,
      sessioniAttive: sessioni.rows[0].n,
      bloccati: bloccati.rows.map((row) => ({
        ip: row.ip,
        tentativi: row.count,
        secondiResidui: Math.ceil(row.reset - now),
      })),
      ultimoAccesso,
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
    // Codici nuovi a ogni reimpostazione: quelli vecchi smettono di valere, così
    // un codice copiato in una nota condivisa non resta una porta aperta.
    const codici = Array.from(
      { length: CODICI_EMERGENZA },
      () => `em-${randomBytes(24).toString("base64url")}`,
    );
    const codiciValue = JSON.stringify(
      codici.map((codice) => {
        const salt = randomBytes(16).toString("hex");
        return [salt, hashCodice(codice, salt)];
      }),
    );
    const sessioni = await client.query("DELETE FROM sessions");

    await client.query("BEGIN");
    const aggiornate = await client.query("UPDATE settings SET value = $1 WHERE key = 'password'", [value]);
    if (aggiornate.rowCount === 0) {
      await client.query("INSERT INTO settings (key, value) VALUES ('password', $1)", [value]);
    }
    await client.query(
      "INSERT INTO settings (key, value) VALUES ('password_emergenza', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [codiciValue],
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
    const salvatiCodici = await client.query<{ value: string }>(
      "SELECT value FROM settings WHERE key = 'password_emergenza'",
    );
    const righe = JSON.parse(salvatiCodici.rows[0].value) as [string, string][];
    if (
      righe.length !== codici.length ||
      !codici.every((codice, i) => hashCodice(codice, righe[i][0]) === righe[i][1])
    ) {
      throw new Error("Verifica fallita: i codici di emergenza salvati non corrispondono.");
    }

    return {
      workspaceProtetto: (esistente.rowCount ?? 0) > 0,
      sessioniChiuse: sessioni.rowCount ?? 0,
      codiciEmergenza: codici,
    };
  } finally {
    await client.end();
  }
}

/**
 * I codici su una riga sola, separati da «; ». Oltre a essere leggibili nel
 * Portachiavi, restano confrontabili: un valore con ritorni a capo viene
 * restituito da `security` in esadecimale e non si può verificare a occhio.
 */
export function codiciSuUnaRiga(codici: string[]): string {
  return codici.join("; ");
}

/**
 * Scrive password e codici nel Portachiavi di macOS e rilegge ogni voce per
 * confermare che sia finito il valore giusto. I segreti passano come argomenti
 * a `security` (senza shell, quindi senza interpolazione) e non vengono mai
 * stampati.
 */
export function salvaNelPortachiavi(
  password: string,
  codici: string[],
): { password: string; codici: string } {
  if (process.platform !== "darwin") {
    throw new Error("Il Portachiavi è disponibile solo su macOS: qui usa senza --portachiavi.");
  }
  const voci = [
    { servizio: SERVIZIO_PASSWORD, etichetta: SERVIZIO_PASSWORD, valore: password },
    {
      servizio: SERVIZIO_CODICI,
      etichetta: `${SERVIZIO_CODICI} (monouso, separati da punto e virgola)`,
      valore: codiciSuUnaRiga(codici),
    },
  ];
  for (const voce of voci) {
    try {
      execFileSync(
        "security",
        [
          "add-generic-password",
          "-a",
          "realindi",
          "-s",
          voce.servizio,
          "-l",
          voce.etichetta,
          "-w",
          voce.valore,
          "-U",
        ],
        { stdio: "pipe" },
      );
      const letto = execFileSync(
        "security",
        ["find-generic-password", "-a", "realindi", "-s", voce.servizio, "-w"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ).replace(/\r?\n$/, "");
      if (letto !== voce.valore) {
        throw new Error(`la voce «${voce.servizio}» non corrisponde a quanto salvato`);
      }
    } catch (err) {
      const dettaglio = (err as { stderr?: Buffer | string })?.stderr?.toString().trim();
      throw new Error(
        `Portachiavi non aggiornato (${voce.servizio}): ${dettaglio || (err as Error).message}. ` +
          "Se macOS ha chiesto il permesso, ripeti consentendo l'accesso.",
      );
    }
  }
  return { password: SERVIZIO_PASSWORD, codici: SERVIZIO_CODICI };
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

/**
 * Errore in una riga, con la stessa classificazione e lo stesso vocabolario di
 * `npm run diagnose:db` e `npm run db:pulisci-test`: piano Prisma, credenziali
 * o rete, non tre elenchi di codici da tenere allineati in tre file.
 */
function messaggioDatabase(err: unknown, connectionString = ""): string {
  // Caso di questo comando, non un guasto di connessione: le migrazioni non
  // sono mai state applicate, quindi la tabella da leggere non esiste.
  if ((err as { code?: string })?.code === "42P01") {
    return "Il database non ha la tabella settings: esegui prima `npm run db:migrate`.";
  }
  const { esito, codice, messaggio } = classifica(err, connectionString);
  const intestazione = `${ETICHETTE[esito]}${codice ? ` [${codice}]` : ""}: ${messaggio}`;
  const consiglio = rimedio(esito, "DATABASE_URL");
  return consiglio ? `${intestazione}\n${consiglio}` : intestazione;
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error("DATABASE_URL non configurato: compila il file .env.");
  }
  // Dove si scrive: un .env che punta alla produzione credendo di essere in
  // locale non deve poter reimpostare il workspace vero senza accorgersene.
  console.log(`Database: ${descriviHost(connectionString) ?? "host non riconosciuto"}`);

  if (process.argv.includes("--stato")) {
    const stato = await statoAccesso(connectionString);
    console.log(
      stato.passwordPresente
        ? "Password del workspace: impostata."
        : "Password del workspace: assente (il gestionale chiede di crearne una al primo accesso).",
    );
    console.log(
      stato.codiciDisponibili
        ? `Codici di emergenza: ${stato.codiciDisponibili} disponibili (ognuno vale una volta sola).`
        : "Codici di emergenza: nessuno (una reimpostazione ne genera 8 nuovi).",
    );
    console.log(`Sessioni attive: ${stato.sessioniAttive}.`);
    console.log(
      stato.ultimoAccesso
        ? `Ultimo accesso: ${quando(stato.ultimoAccesso.at)} da ${stato.ultimoAccesso.ip} (${
            stato.ultimoAccesso.via === "codice" ? "codice di emergenza" : "password"
          }).`
        : "Ultimo accesso: nessuno registrato.",
    );
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

  // Conferma esplicita prima di scrivere; in automazione (niente terminale) la
  // conferma è implicita, e --sì la salta anche da terminale.
  const confermato =
    process.argv.includes("--sì") || !process.stdin.isTTY
      ? true
      : await conferma("Sostituire la password su questo database? [s/n] ");
  if (!confermato) {
    console.log("Nessuna modifica fatta.");
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

  if (process.argv.includes("--portachiavi")) {
    const voci = salvaNelPortachiavi(nuova, esito.codiciEmergenza);
    console.log(`Nel Portachiavi di macOS, sotto «${voci.password}» e «${voci.codici}»:`);
    console.log(`  password e ${esito.codiciEmergenza.length} codici di emergenza, riletti e verificati.`);
    console.log("Non compaiono qui: apri Accesso Portachiavi, cerca «REALINDI CRM» e mostra la voce.");
    console.log(
      "Ognuno vale una volta sola e il primo uso lo consuma: entra da /app senza terminale. I codici precedenti non valgono più.",
    );
    return;
  }

  console.log("La password non viene mostrata: salvala ora nel gestore password.");
  console.log("");
  console.log(`Codici di emergenza (${esito.codiciEmergenza.length} nuovi, mostrati solo ora):`);
  for (const codice of esito.codiciEmergenza) console.log(`  ${codice}`);
  console.log(
    "Ognuno vale una volta sola e il primo uso lo consuma: entra da /app senza terminale. I codici precedenti non valgono più.",
  );
  console.log("Con --portachiavi li salvo nel Portachiavi di macOS senza stamparli.");
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(`Reimpostazione non riuscita: ${messaggioDatabase(err)}`);
    process.exitCode = 1;
  });
}
