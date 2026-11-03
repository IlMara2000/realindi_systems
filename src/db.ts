// Accesso dati: client Prisma (Postgres) + impostazioni predefinite + sessioni.
// Porting di init()/settings()/auth() di app.py.
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import * as fiscal from "./fiscal.js";
import { hashPassword, sha256Hex, timingSafeEqualStr, tokenHex, tokenUrlSafe } from "./util.js";

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
export async function settings(): Promise<Record<string, any>> {
  const rows = await prisma().setting.findMany();
  const out: Record<string, any> = { ...DEFAULTS };
  for (const row of rows) {
    if (row.key === "password" || row.key === "email_sender" || row.key.startsWith("int_")) continue;
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

/** Login/setup con rate-limit per IP (login_attempts) e pbkdf2 compatibile. */
export async function verifyLogin(ip: string, password: string): Promise<LoginResult> {
  const p = prisma();
  const stored = await p.setting.findUnique({ where: { key: "password" } });
  if (!stored) throw new Error("NO_PASSWORD");
  const attempt = await p.loginAttempt.findUnique({ where: { ip } });
  const now = Date.now() / 1000;
  if (attempt && attempt.reset > now && attempt.count >= 10) {
    throw new Error("RATE_LIMITED");
  }
  const [salt, saved] = JSON.parse(stored.value) as [string, string];
  const given = hashPassword(password, salt);
  if (!timingSafeEqualStr(given, saved)) {
    const count = attempt && attempt.reset > now ? attempt.count + 1 : 1;
    const reset = attempt && attempt.reset > now ? attempt.reset : now + 900;
    await p.loginAttempt.upsert({
      where: { ip },
      create: { ip, count, reset },
      update: { count, reset },
    });
    throw new Error("BAD_PASSWORD");
  }
  await p.loginAttempt.delete({ where: { ip } }).catch(() => undefined);
  const token = tokenUrlSafe(32);
  await p.session.deleteMany({ where: { expires: { lt: now } } });
  await p.session.create({ data: { token: sha256Hex(token), expires: now + 43200 } });
  return { ok: true, cookie: sessionCookie(token, 43200) };
}

/** Primo avvio: imposta la password (almeno 12 caratteri) e crea la sessione. */
export async function setupPassword(password: string): Promise<LoginResult> {
  const p = prisma();
  if (await hasPassword()) throw new Error("ALREADY_SET");
  if (password.length < 12) throw new Error("TOO_SHORT");
  const salt = tokenHex(16);
  await p.setting.create({
    data: { key: "password", value: JSON.stringify([salt, hashPassword(password, salt)]) },
  });
  const token = tokenUrlSafe(32);
  await p.session.create({ data: { token: sha256Hex(token), expires: Date.now() / 1000 + 43200 } });
  return { ok: true, cookie: sessionCookie(token, 43200) };
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
