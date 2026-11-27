// Accesso dati: client Prisma (Postgres) + impostazioni predefinite + sessioni.
// Porting di init()/settings()/auth() di app.py.
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import * as fiscal from "./fiscal.js";
import {
  CODICI_EMERGENZA,
  LIMITE_TENTATIVI_LOGIN,
  hashCodice,
  hashPassword,
  sha256Hex,
  timingSafeEqualStr,
  tokenHex,
  tokenUrlSafe,
} from "./util.js";

let client: PrismaClient | null = null;

/** Client singleton per istanza (le funzioni Vercel riusano l'istanza a freddo). */
export function prisma(): PrismaClient {
  if (!client) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL non configurato.");
    client = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  }
  return client;
}

export const DEFAULTS: Record<string, unknown> = {
  business_name: "", owner_name: "", email: "", address: "",
  vat_number: "", tax_code: "", iban: "", tax_label: "",
  vat_rate: "0", hourly_rate: "60",
  booking_title: "Prenota una chiacchierata",
  booking_description: "Un primo incontro per capire obiettivi, tempi e possibilità.",
  booking_duration: 30, booking_start: 9, booking_end: 18,
  booking_days: [0, 1, 2, 3, 4], booking_enabled: true,
  booking_notice: 24, booking_horizon: 30, public_url: "",
  assistant_enabled: false, assistant_name: "", assistant_tone: "professionale",
  assistant_language: "auto", assistant_signature: "", assistant_notes: "",
  assistant_site_url: "", assistant_model: "deepseek-v4.1-flash",
  assistant_base_url: "https://freebuff.com/api/v1/paid", assistant_max_chars: 700,
  assistant_handoff_email: "",
  ...fiscal.PROFILE_DEFAULTS,
};

let defaultsInFlight: Promise<void> | null = null;

/**
 * init() di app.py: inserisce le impostazioni mancanti e crea lo slug della
 * prenotazione. Auto-guaritrice: verifica a ogni chiamata (un database ripristinato
 * o svuotato rientra in sync), con dedup delle chiamate concorrenti.
 */
export function ensureDefaults(): Promise<void> {
  if (defaultsInFlight) return defaultsInFlight;
  defaultsInFlight = (async () => {
    const p = prisma();
    const existing = new Set((await p.setting.findMany({ select: { key: true } })).map((r) => r.key));
    const missing: { key: string; value: string }[] = [];
    for (const [key, value] of Object.entries(DEFAULTS)) {
      if (!existing.has(key)) missing.push({ key, value: JSON.stringify(value) });
    }
    if (!existing.has("booking_slug")) {
      missing.push({ key: "booking_slug", value: JSON.stringify(tokenUrlSafe(16)) });
    }
    if (missing.length) {
      await p.setting.createMany({ data: missing, skipDuplicates: true });
    }
  })();
  const done = defaultsInFlight.catch(() => {
    // un errore di rete non blocca le chiamate successive
  });
  defaultsInFlight.then(
    () => { defaultsInFlight = null; },
    () => { defaultsInFlight = null; },
  );
  return done;
}

/**
 * settings() di app.py: tutte le impostazioni tranne la password (DEFAULTS come rete).
 * Esclude anche le chiavi di integrazione (int_*, email_sender): valori cifrati (v1:…)
 * o grezzi che settings() non deve interpretare e che non devono mai raggiungere il client.
 */
/** Righe che contengono credenziali: mai verso il client, mai nel backup. */
export const CHIAVI_CREDENZIALI = new Set(["password", "password_emergenza"]);

/**
 * Codici di emergenza monouso: credenziali alternative alla password,
 * generate e mostrate una volta sola. Il prefisso serve solo a riconoscerle
 * nel gestore password — l'entropia sta nei byte casuali.
 */
function generaCodiciEmergenza(): string[] {
  return Array.from({ length: CODICI_EMERGENZA }, () => `em-${tokenUrlSafe(24)}`);
}

/** Valore da salvare per la password: sale nuovo + hash, come il login. */
function credenzialeHash(segreto: string): string {
  const salt = tokenHex(16);
  return JSON.stringify([salt, hashPassword(segreto, salt)]);
}

/** Valore da salvare per i codici: un [sale, hash] per ciascuno, nessuno in chiaro. */
function codiciHash(codici: string[]): string {
  return JSON.stringify(
    codici.map((codice) => {
      const salt = tokenHex(16);
      return [salt, hashCodice(codice, salt)];
    }),
  );
}

/** Confronto a tempo costante fra un segreto in chiaro e la riga salvata. */
function corrisponde(segreto: string, riga: { value: string } | null): boolean {
  if (!riga) return false;
  const [salt, saved] = JSON.parse(riga.value) as [string, string];
  return timingSafeEqualStr(hashPassword(segreto, salt), saved);
}

/**
 * Consuma un codice di emergenza: se combacia viene tolto dalla lista, quindi
 * quel codice non vale più. L'aggiornamento è condizionato al valore appena
 * letto, così due login simultanei con lo stesso codice non riescono entrambi.
 */
async function consumaCodiceEmergenza(codice: string): Promise<boolean> {
  const p = prisma();
  const riga = await p.setting.findUnique({ where: { key: "password_emergenza" } });
  if (!riga) return false;
  const salvati = JSON.parse(riga.value) as [string, string][];
  const indice = salvati.findIndex(([salt, hash]) =>
    timingSafeEqualStr(hashCodice(codice, salt), hash),
  );
  if (indice === -1) return false;
  const rimosso = await p.setting.updateMany({
    where: { key: "password_emergenza", value: riga.value },
    data: { value: JSON.stringify(salvati.filter((_, i) => i !== indice)) },
  });
  return rimosso.count === 1;
}

/** Un accesso riuscito, come lo mostra il pannello Sicurezza. */
export interface Accesso {
  /** Millisecondi UTC: il client lo formatta direttamente. */
  at: number;
  ip: string;
  via: "password" | "codice" | "passkey";
  /** Primo accesso in assoluto da questo IP (il primo di tutti non conta). */
  nuovo: boolean;
}

/** Quanti accessi mostra il pannello. */
const ACCESSI_MOSTRATI = 8;

/** Quanti accessi si conservano: è uno storico, non un archivio. */
const ACCESSI_CONSERVATI = 100;

/**
 * Registra un accesso riuscito e tiene la tabella corta: oltre le ultime cento
 * righe si cancellano le più vecchie, altrimenti crescerebbe a ogni login.
 */
async function registraAccesso(ip: string, via: Accesso["via"]): Promise<void> {
  try {
    const p = prisma();
    await p.loginEvent.create({ data: { at: Date.now(), ip, via } });
    const vecchi = await p.loginEvent.findMany({
      orderBy: { id: "desc" },
      skip: ACCESSI_CONSERVATI,
      select: { id: true },
    });
    if (vecchi.length) {
      await p.loginEvent.deleteMany({ where: { id: { in: vecchi.map((row) => row.id) } } });
    }
  } catch (err) {
    // Lo storico non deve mai impedire di entrare: una migrazione non ancora
    // applicata o un errore di scrittura si legge nei log, non blocca il login.
    console.error("Accesso non registrato:", (err as Error)?.message);
  }
}

/**
 * Accessi riusciti recenti, dal più nuovo. `nuovo` marca chi arriva da un IP
 * mai comparso prima: è il segnale da guardare. Il primo accesso in assoluto
 * non è «nuovo» — non esiste un prima con cui confrontarlo, e segnalarlo
 * dipingerebbe come sospetto il setup appena fatto.
 */
export async function accessiRecenti(): Promise<Accesso[]> {
  const p = prisma();
  const [righe, prime] = await Promise.all([
    p.loginEvent.findMany({ orderBy: { id: "desc" }, take: ACCESSI_MOSTRATI }),
    p.loginEvent.groupBy({ by: ["ip"], _min: { id: true } }),
  ]);
  const primoDa = new Map(prime.map((row) => [row.ip, row._min.id]));
  const primoInAssoluto = Math.min(...prime.map((row) => row._min.id ?? Infinity));
  return righe.map((row) => ({
    at: row.at,
    ip: row.ip,
    via: row.via as Accesso["via"],
    nuovo: primoDa.get(row.ip) === row.id && row.id !== primoInAssoluto,
  }));
}

export async function settings(): Promise<Record<string, any>> {
  const rows = await prisma().setting.findMany();
  const out: Record<string, any> = { ...DEFAULTS };
  for (const row of rows) {
    if (CHIAVI_CREDENZIALI.has(row.key) || row.key === "email_sender" || row.key.startsWith("int_")) continue;
    out[row.key] = JSON.parse(row.value);
  }
  return out;
}

export async function hasPassword(): Promise<boolean> {
  return (await prisma().setting.findUnique({ where: { key: "password" } })) !== null;
}

/** Durata di una sessione: dodici ore dall'apertura. */
const DURATA_SESSIONE = 43200;

/**
 * Auth: il cookie crm_session viene conservato come sha256, scadenza in epoch
 * secondi. Aggiorna anche l'ultimo utilizzo, ma non a ogni richiesta: basta il
 * minuto, altrimenti si scriverebbe sul database per ogni vista.
 */
export async function auth(token: string | null): Promise<boolean> {
  if (!token) return false;
  const hash = sha256Hex(token);
  const row = await prisma().session.findUnique({ where: { token: hash } });
  const now = Date.now() / 1000;
  if (!row || row.expires <= now) return false;
  if (now - row.last_seen > 60) {
    await prisma()
      .session.update({ where: { token: hash }, data: { last_seen: now } })
      .catch(() => undefined);
  }
  return true;
}

/**
 * Apre una sessione con il contesto da cui è nata (IP, browser) e restituisce
 * il cookie da mandare al client. Il token in chiaro esiste solo qui.
 */
async function creaSessione(ip: string, userAgent: string): Promise<string> {
  const token = tokenUrlSafe(32);
  const now = Date.now() / 1000;
  await prisma().session.create({
    data: {
      token: sha256Hex(token),
      expires: now + DURATA_SESSIONE,
      ip,
      user_agent: userAgent.slice(0, 300),
      created_at: now,
      last_seen: now,
    },
  });
  return sessionCookie(token, DURATA_SESSIONE);
}

export function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

export interface LoginResult {
  ok: true;
  cookie: string;
}

/** Finestra dei tentativi falliti: la soglia è in src/util.ts, condivisa con lo script di stato. */
const FINESTRA_LOGIN_SECONDI = 900;

/**
 * Blocco dei tentativi con l'attesa residua, così il messaggio può dire quanti
 * minuti mancano davvero invece di ripetere sempre «15 minuti».
 */
export class RateLimited extends Error {
  constructor(readonly attesaSecondi: number) {
    super("RATE_LIMITED");
  }
}

/**
 * Login con conteggio dei tentativi falliti per IP (login_attempts) e hash
 * pbkdf2 compatibile con quelli esistenti.
 *
 * La password si verifica *prima* del blocco: chi la conosce entra sempre e il
 * contatore si azzera. Rifiutare anche la password giusta lasciava fuori il
 * titolare per un errore di battitura o per una vecchia voce compilata dal
 * gestore password — cioè proprio quando serve rientrare.
 *
 * Il conteggio resta sui soli errori: chi sbaglia la password per l'ennesima
 * volta riceve l'attesa residua, e ogni tentativo costa comunque un pbkdf2
 * completo, quindi il conteggio non diventa un modo per indovinare più in fretta.
 */
export async function verifyLogin(ip: string, password: string, userAgent = ""): Promise<LoginResult> {
  const p = prisma();
  const stored = await p.setting.findUnique({ where: { key: "password" } });
  if (!stored) throw new Error("NO_PASSWORD");
  const now = Date.now() / 1000;

  // La password si verifica per prima, con un solo pbkdf2. Solo se non combacia
  // si prova uno dei codici monouso: l'hash è veloce e, se vale, si consuma.
  // `daPassword` resta com'era prima dei due test, così lo storico può dire
  // con quale credenziale si è entrati.
  const daPassword = corrisponde(password, stored);
  const valida = daPassword || (await consumaCodiceEmergenza(password));

  if (valida) {
    await p.loginAttempt.delete({ where: { ip } }).catch(() => undefined);
    await registraAccesso(ip, daPassword ? "password" : "codice");
    await p.session.deleteMany({ where: { expires: { lt: now } } });
    return { ok: true, cookie: await creaSessione(ip, userAgent) };
  }

  const attempt = await p.loginAttempt.findUnique({ where: { ip } });
  const inFinestra = attempt !== null && attempt.reset > now;
  const count = inFinestra ? attempt!.count + 1 : 1;
  // La finestra non si allunga a ogni errore: chi ha sbagliato dieci volte
  // aspetta il tempo che resta, non altri quindici minuti da capo.
  const reset = inFinestra ? attempt!.reset : now + FINESTRA_LOGIN_SECONDI;
  await p.loginAttempt.upsert({
    where: { ip },
    create: { ip, count, reset },
    update: { count, reset },
  });
  if (count >= LIMITE_TENTATIVI_LOGIN) throw new RateLimited(Math.ceil(reset - now));
  throw new Error("BAD_PASSWORD");
}

/**
 * Accesso riuscito con una passkey: stessa sessione e stesso storico della
 * password, e i tentativi falliti dell'IP si azzerano come dopo un login
 * normale — chi dimostra di avere il dispositivo non deve restare bloccato.
 */
export async function loginConPasskey(ip: string, userAgent = ""): Promise<LoginResult> {
  const p = prisma();
  await p.loginAttempt.delete({ where: { ip } }).catch(() => undefined);
  await registraAccesso(ip, "passkey");
  await p.session.deleteMany({ where: { expires: { lt: Date.now() / 1000 } } });
  return { ok: true, cookie: await creaSessione(ip, userAgent) };
}

export interface SetupResult extends LoginResult {
  /** Da mostrare una volta sola: nel database ne restano solo gli hash. */
  codici: string[];
}

/**
 * Primo avvio: imposta la password (almeno 12 caratteri), genera i codici di
 * emergenza monouso e crea la sessione. È a sua volta un accesso, quindi entra
 * nello storico come gli altri.
 */
export async function setupPassword(password: string, ip: string, userAgent = ""): Promise<SetupResult> {
  const p = prisma();
  if (password.length < 12) throw new Error("TOO_SHORT");
  const codici = generaCodiciEmergenza();
  // Un solo INSERT con la password e i codici: fra il controllo "esiste già?"
  // e la scrittura non c'è più finestra, quindi due setup simultanei non si
  // scontrano sulla chiave e chi arriva secondo riceve ALREADY_SET.
  const created = await p.setting.createMany({
    data: [
      { key: "password", value: credenzialeHash(password) },
      { key: "password_emergenza", value: codiciHash(codici) },
    ],
    skipDuplicates: true,
  });
  if (created.count === 0) throw new Error("ALREADY_SET");
  await registraAccesso(ip, "password");
  return { ok: true, cookie: await creaSessione(ip, userAgent), codici };
}

/**
 * Cambio password dall'app: richiede la credenziale attuale, chiude *tutte* le
 * sessioni (compresa quella che sta chiedendo il cambio) e ne emette una nuova
 * per il browser chiamante. Così gli altri dispositivi restano fuori.
 */
export interface ChangeResult extends LoginResult {
  /** Nuovi codici monouso: i precedenti non valgono più, si mostrano una volta. */
  codici: string[];
}

export async function changePassword(
  current: string,
  next: string,
  ip = "",
  userAgent = "",
): Promise<ChangeResult> {
  const p = prisma();
  const stored = await p.setting.findUnique({ where: { key: "password" } });
  if (!stored) throw new Error("NO_PASSWORD");
  if (next.length < 12) throw new Error("TOO_SHORT");
  // La credenziale attuale può essere la password o uno dei codici monouso:
  // chi è rientrato con un codice deve poter scegliere una password nuova
  // senza tornare al terminale. Il codice speso qui si consuma, come al login.
  if (!corrisponde(current, stored) && !(await consumaCodiceEmergenza(current))) {
    throw new Error("BAD_PASSWORD");
  }

  await p.setting.update({ where: { key: "password" }, data: { value: credenzialeHash(next) } });
  // Cambiare password azzera anche i codici superstiti: uno finito in una nota
  // condivisa non deve sopravvivere al cambio. I nuovi si mostrano una volta.
  const codici = generaCodiciEmergenza();
  await scriviCodici(codici);
  await p.session.deleteMany({});
  return { ok: true, cookie: await creaSessione(ip, userAgent), codici };
}

/** Sostituisce l'intera lista dei codici monouso nel database. */
async function scriviCodici(codici: string[]): Promise<void> {
  const value = codiciHash(codici);
  await prisma().setting.upsert({
    where: { key: "password_emergenza" },
    create: { key: "password_emergenza", value },
    update: { value },
  });
}

/** Rigenera i codici dal pannello Sicurezza e li restituisce una volta sola. */
export async function nuoviCodiciEmergenza(): Promise<string[]> {
  const codici = generaCodiciEmergenza();
  await scriviCodici(codici);
  return codici;
}

/** Quanti codici di emergenza restano. */
export async function codiciDisponibili(): Promise<number> {
  const riga = await prisma().setting.findUnique({ where: { key: "password_emergenza" } });
  return riga ? (JSON.parse(riga.value) as unknown[]).length : 0;
}

export interface Sessione {
  /** Testa dell'hash del token: identifica la sessione senza esporre il cookie. */
  id: string;
  ip: string;
  user_agent: string;
  created_at: number;
  last_seen: number;
  corrente: boolean;
}

/** Quante sessioni mostra il pannello. */
const SESSIONI_MOSTRATE = 10;

/** Sessioni ancora valide, dalla più usata di recente, con quella corrente marcata. */
export async function sessioniAttive(token: string | null): Promise<Sessione[]> {
  const corrente = token ? sha256Hex(token) : "";
  const righe = await prisma().session.findMany({
    where: { expires: { gt: Date.now() / 1000 } },
    orderBy: { last_seen: "desc" },
    take: SESSIONI_MOSTRATE,
  });
  return righe.map((riga) => ({
    id: riga.token.slice(0, 12),
    ip: riga.ip,
    user_agent: riga.user_agent,
    created_at: riga.created_at,
    last_seen: riga.last_seen,
    corrente: riga.token === corrente,
  }));
}

/** Chiude una sessione per id (testa dell'hash) e dice quante ne ha chiuse. */
export async function revocaSessione(id: string): Promise<number> {
  if (!/^[a-f0-9]{12}$/.test(id)) throw new Error("SESSIONE_NON_VALIDA");
  const chiuse = await prisma().session.deleteMany({ where: { token: { startsWith: id } } });
  return chiuse.count;
}

/** Chiude tutte le sessioni tranne quella che sta chiedendo. */
export async function revocaAltreSessioni(token: string | null): Promise<number> {
  if (!token) return 0;
  const chiuse = await prisma().session.deleteMany({ where: { token: { not: sha256Hex(token) } } });
  return chiuse.count;
}

export async function destroySession(token: string | null): Promise<void> {
  if (!token) return;
  await prisma().session.deleteMany({ where: { token: sha256Hex(token) } });
}

export function sessionCookie(token: string, maxAge: number): string {
  // Su HTTPS (Vercel) il cookie va marcato Secure, come con CRM_SECURE_COOKIE=1.
  const secure = process.env.CRM_SECURE_COOKIE === "1" || process.env.VERCEL === "1" ? "; Secure" : "";
  return `crm_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
}

export const CLEAR_COOKIE = "crm_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0";
