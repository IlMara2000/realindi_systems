// Helper condivisi: decimali (come Python Decimal), validazione, tempo (Europe/Rome).
// Ogni funzione rispecchia 1:1 la controparte in app.py / fiscal.py.
import Decimal from "decimal.js";
import crypto from "node:crypto";

// Contesto Python Decimal di default: 28 cifre significative, arrotondamento HALF_UP.
Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });
export { Decimal };

export class Invalid extends Error {}

/** str(d.get(k, '')).strip() con obbligatorietà e lunghezza massima. */
export function required(d: Record<string, unknown>, k: string, maxLen = 300): string {
  const v = String(d[k] ?? "").trim();
  if (!v || v.length > maxLen) {
    throw new Invalid(`Il campo ${k} è obbligatorio (massimo ${maxLen} caratteri).`);
  }
  return v;
}

/** str(d.get(k, '')).strip() senza obbligatorietà, solo limite di lunghezza. */
export function optional(d: Record<string, unknown>, k: string, maxLen = 5000): string {
  const v = String(d[k] ?? "").trim();
  if (v.length > maxLen) {
    throw new Invalid(`Il campo ${k} è troppo lungo.`);
  }
  return v;
}

export function email(d: Record<string, unknown>): string {
  const v = required(d, "email", 254);
  // required ha già fatto trim(): ^...$ equivale a re.fullmatch in Python.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
    throw new Invalid("Indirizzo email non valido.");
  }
  return v;
}

/** Decimal(str(v)) limitato a [minimum, maximum]; altrimenti Invalid. */
export function number(v: unknown, minimum = 0, maximum = 1000000): Decimal {
  let n: Decimal;
  try {
    n = new Decimal(String(v));
  } catch {
    throw new Invalid("Valore numerico non valido.");
  }
  if (!n.isFinite() || n.lt(minimum) || n.gt(maximum)) {
    throw new Invalid("Valore numerico non valido.");
  }
  return n;
}

/** int((v * 100).quantize(1, ROUND_HALF_UP)) — centesimi interi. */
export function cents(v: Decimal): number {
  return v.mul(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
}

/** date.fromisoformat(str(v)).isoformat() */
export function checkDate(v: unknown): string {
  const s = String(v ?? "");
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s) ?? /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (!m) throw new Invalid("Data non valida.");
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    throw new Invalid("Data non valida.");
  }
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${y}-${p2(mo)}-${p2(d)}`;
}

/** datetime.fromisoformat con fuso orario obbligatorio (Z accettato). */
export function instant(v: unknown): Date {
  const s = String(v ?? "");
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    throw new Invalid("Data e ora devono includere il fuso orario.");
  }
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw new Invalid("Data e ora devono includere il fuso orario.");
  return new Date(ms);
}

const p2 = (n: number) => String(n).padStart(2, "0");

/** dt.astimezone(utc).isoformat(timespec='seconds') → 2026-11-03T08:00:00+00:00 */
export function iso(dt: Date): string {
  return (
    `${dt.getUTCFullYear()}-${p2(dt.getUTCMonth() + 1)}-${p2(dt.getUTCDate())}` +
    `T${p2(dt.getUTCHours())}:${p2(dt.getUTCMinutes())}:${p2(dt.getUTCSeconds())}+00:00`
  );
}

const ROME_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Rome",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

interface RomeParts {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

function romeParts(dt: Date): RomeParts {
  const out: Record<string, number> = {};
  for (const part of ROME_FMT.formatToParts(dt)) {
    if (part.type !== "literal") out[part.type] = Number(part.value);
  }
  return { y: out.year, m: out.month, d: out.day, h: out.hour, mi: out.minute, s: out.second };
}

/** Offset del fuso di un istante, in millisecondi (ora di Roma). */
function romeOffsetMs(dt: Date): number {
  const p = romeParts(dt);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  return asUtc - Math.floor(dt.getTime() / 1000) * 1000;
}

/** datetime(y, m, d, h, mi, tzinfo=ZoneInfo('Europe/Rome')) → istante UTC. */
export function zonedToUtc(y: number, m: number, d: number, h: number, mi: number): Date {
  const wall = Date.UTC(y, m - 1, d, h, mi);
  let guess = wall;
  for (let i = 0; i < 3; i++) {
    const offset = romeOffsetMs(new Date(guess));
    const next = wall - offset;
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess);
}

/** datetime.now(ZoneInfo('Europe/Rome')).date() come {y,m,d}. */
export function todayRome(now = new Date()): { y: number; m: number; d: number } {
  const p = romeParts(now);
  return { y: p.y, m: p.m, d: p.d };
}

/** strftime('%H:%M') sull'ora di Roma di un istante. */
export function labelRome(dt: Date): string {
  const p = romeParts(dt);
  return `${p2(p.h)}:${p2(p.mi)}`;
}

/** data ISO (YYYY-MM-DD) dell'ora di Roma di un istante. */
export function dateRome(dt: Date): string {
  const p = romeParts(dt);
  return `${p.y}-${p2(p.m)}-${p2(p.d)}`;
}

/** data ISO in UTC di un istante (per confronti data↔data). */
export function dateUtc(dt: Date): string {
  return `${dt.getUTCFullYear()}-${p2(dt.getUTCMonth() + 1)}-${p2(dt.getUTCDate())}`;
}

/** weekday(): lunedì=0 … domenica=6 (come Python date.weekday()). */
export function weekdayMonday0(y: number, m: number, d: number): number {
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

/** secrets.token_urlsafe(nbytes) — URL-safe base64 senza padding. */
export function tokenUrlSafe(nbytes: number): string {
  return crypto.randomBytes(nbytes).toString("base64url");
}

export function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function sha256Bytes(value: Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** pbkdf2_hmac('sha256', password, salt_hex, 300000).hex() — compatibile con gli hash esistenti. */
export function hashPassword(password: string, saltHex: string): string {
  return crypto
    .pbkdf2Sync(password, Buffer.from(saltHex, "hex"), 300000, 32, "sha256")
    .toString("hex");
}

/** secrets.token_hex(16) */
export function tokenHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString("hex");
}

/** Comparazione a tempo costante come hmac.compare_digest. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** json.dumps(..., ensure_ascii=False) per le parti di testo libero. */
export function jsonParse<T>(raw: string): T {
  return JSON.parse(raw) as T;
}
