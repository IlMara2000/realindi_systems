// Accesso dati: client Prisma (Postgres) + impostazioni predefinite + sessioni.
// Porting di init()/settings()/auth() di app.py.
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import * as fiscal from "./fiscal.js";
import {
  LIMITE_TENTATIVI_LOGIN,
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
 * Codice di emergenza: credenziale alternativa allo stesso livello della
 * password, generata e mostrata una volta sola. Il prefisso serve solo a
 * riconoscerla nel gestore password — l'entropia sta nei byte casuali.
 */
function generaCodiceEmergenza(): string {
  return `em-${tokenUrlSafe(24)}`;
}

/** Valore da salvare per una credenziale: sale nuovo + hash, come il login. */
function credenzialeHash(segreto: string): string {
  const salt = tokenHex(16);
  return JSON.stringify([salt, hashPassword(segreto, salt)]);
}

/** Confronto a tempo costante fra un segreto in chiaro e la riga salvata. */
function corrisponde(segreto: string, riga: { value: string } | null): boolean {
  if (!riga) return false;
  const [salt, saved] = JSON.parse(riga.value) as [string, string];
  return timingSafeEqualStr(hashPassword(segreto, salt), saved);
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

/** Auth: il cookie crm_session viene conservato come sha256, scadenza in epoch secondi. */
export async function auth(token: string | null): Promise<boolean> {
  if (!token) return false;
  const row = await prisma().session.findUnique({ where: { token: sha256Hex(token) } });
  return row !== null && row.expires > Date.now() / 1000;
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
export async function verifyLogin(ip: string, password: string): Promise<LoginResult> {
  const p = prisma();
  const stored = await p.setting.findUnique({ where: { key: "password" } });
  if (!stored) throw new Error("NO_PASSWORD");
  const now = Date.now() / 1000;

  // Due credenziali ammesse: la password e il codice di emergenza. Il codice si
  // prova solo se la password non combacia, così l'accesso normale costa un
  // solo pbkdf2; un errore costa comunque il doppio, mai zero.
  const valida =
    corrisponde(password, stored) ||
    corrisponde(password, await p.setting.findUnique({ where: { key: "password_emergenza" } }));

  if (valida) {
    await p.loginAttempt.delete({ where: { ip } }).catch(() => undefined);
    const token = tokenUrlSafe(32);
    await p.session.deleteMany({ where: { expires: { lt: now } } });
    await p.session.create({ data: { token: sha256Hex(token), expires: now + 43200 } });
    return { ok: true, cookie: sessionCookie(token, 43200) };
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

export interface SetupResult extends LoginResult {
  /** Da mostrare una volta sola: nel database ne resta solo l'hash. */
  emergenza: string;
}

/**
 * Primo avvio: imposta la password (almeno 12 caratteri), genera il codice di
 * emergenza e crea la sessione.
 */
export async function setupPassword(password: string): Promise<SetupResult> {
  const p = prisma();
  if (password.length < 12) throw new Error("TOO_SHORT");
  const emergenza = generaCodiceEmergenza();
  // Un solo INSERT con entrambe le credenziali: fra il controllo "esiste già?"
  // e la scrittura non c'è più finestra, quindi due setup simultanei non si
  // scontrano sulla chiave e chi arriva secondo riceve ALREADY_SET.
  const created = await p.setting.createMany({
    data: [
      { key: "password", value: credenzialeHash(password) },
      { key: "password_emergenza", value: credenzialeHash(emergenza) },
    ],
    skipDuplicates: true,
  });
  if (created.count === 0) throw new Error("ALREADY_SET");
  const token = tokenUrlSafe(32);
  await p.session.create({ data: { token: sha256Hex(token), expires: Date.now() / 1000 + 43200 } });
  return { ok: true, cookie: sessionCookie(token, 43200), emergenza };
}

/**
 * Cambio password dall'app: richiede quella attuale, chiude *tutte* le
 * sessioni (compresa quella che sta chiedendo il cambio) e ne emette una nuova
 * per il browser chiamante. Così gli altri dispositivi restano fuori.
 */
export async function changePassword(current: string, next: string): Promise<string> {
  const p = prisma();
  const stored = await p.setting.findUnique({ where: { key: "password" } });
  if (!stored) throw new Error("NO_PASSWORD");
  if (next.length < 12) throw new Error("TOO_SHORT");
  if (!corrisponde(current, stored)) throw new Error("BAD_PASSWORD");

  await p.setting.update({ where: { key: "password" }, data: { value: credenzialeHash(next) } });
  await p.session.deleteMany({});

  const token = tokenUrlSafe(32);
  await p.session.create({ data: { token: sha256Hex(token), expires: Date.now() / 1000 + 43200 } });
  return sessionCookie(token, 43200);
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
