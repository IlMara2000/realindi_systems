// Engine di sincronizzazione calendario (spec 2026-11-03).
// - pull-on-open + outbound immediato, nessun webhook;
// - finestra -1 mese / +4 mesi con filtri sui tipi personali Google;
// - merge last-write-wins su updatedAt (scelta documentata nel design doc);
// - CalDAV: discovery per-account (host partizione mai hardcoded), PUT con
//   If-Match sempre quotato; Google: syncToken con ripartenza su 410 GONE.
import { randomBytes } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { prisma } from "./db.js";
import { openSecret, sealSecret } from "./crypto.js";
import { Invalid } from "./util.js";
import { AppleHttpError, appleSyncMessage, integrationStatus } from "./integrations.js";
import { utcStamp } from "./notes.js";

// ------------------------------------------------------------------ pura

const EXCLUDED_EVENT_TYPES = new Set(["fromGmail", "birthday", "outOfOffice", "workingLocation"]);

export function isImportable(remote: { eventType?: string }): boolean {
  return !remote.eventType || !EXCLUDED_EVENT_TYPES.has(remote.eventType);
}

export function windowRange(now = new Date()): { from: string; to: string } {
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return {
    from: fmt(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, now.getUTCDate()))),
    to: fmt(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 4, now.getUTCDate()))),
  };
}

export interface LocalLike {
  updated_at: number | bigint;
  dirty: boolean;
}

export function mergeRemote(
  local: LocalLike | null,
  remote: { updated_at: number },
): "create" | "update" | "skip" | "skip_local_wins" {
  if (!local) return "create";
  if (local.dirty) return "skip_local_wins";
  return remote.updated_at > Number(local.updated_at) ? "update" : "skip";
}

export type ConflictPolicy = "latest_wins" | "local_wins" | "remote_wins" | "manual";

/**
 * Sotto questa distanza l'ordine di scrittura è rumore di clock, non una scelta:
 * due modifiche a meno di un minuto l'una dall'altra non hanno un "più recente"
 * affidabile, quindi la decisione passa a una persona.
 */
export const CONFLICT_THRESHOLD_MS = 60_000;

export function decideConflict(
  local: { updated_at: number | bigint },
  remote: { updated_at: number },
  policy: ConflictPolicy,
): "local_wins" | "remote_wins" | "manual" {
  if (policy === "local_wins") return "local_wins";
  if (policy === "remote_wins") return "remote_wins";
  if (policy === "manual") return "manual";
  const delta = Number(remote.updated_at) - Number(local.updated_at);
  if (Math.abs(delta) <= CONFLICT_THRESHOLD_MS) return "manual";
  return delta > 0 ? "remote_wins" : "local_wins";
}

const CONFLICT_POLICIES = new Set<ConflictPolicy>([
  "latest_wins",
  "local_wins",
  "remote_wins",
  "manual",
]);

/** Politica effettiva: la impostazione `conflict_policy`, altrimenti latest_wins. */
export async function conflictPolicy(): Promise<ConflictPolicy> {
  const row = await prisma().setting.findUnique({ where: { key: "conflict_policy" } });
  const value = (row?.value ?? "").trim() as ConflictPolicy;
  return CONFLICT_POLICIES.has(value) ? value : "latest_wins";
}

export interface RemoteEvent {
  external_id: string;
  title: string;
  start: string;
  end: string;
  all_day: boolean;
  description: string | null;
  location: string | null;
  updated_at: number;
  etag: string | null;
  cancelled: boolean;
  eventType?: string;
  /** Calendario di provenienza: fa parte dell'identità su Google. */
  calendar_id?: string;
  /** iCalUID: lo stesso evento invitato vive in più calendari con id diversi. */
  ical_uid?: string;
}

export interface SyncResult {
  imported: number;
  updated: number;
  removed: number;
  pending: number;
  conflicts: number;
  errors: Array<{ source: string; message: string }>;
}

function sanitize(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/https?:\/\/\S+/g, "[url]").slice(0, 200);
}
export { sanitize };

/** Una voce per provider: il primo errore racconta il disservizio. */
function addError(errors: Array<{ source: string; message: string }>, source: string, err: unknown): void {
  if (errors.some((e) => e.source === source)) return;
  errors.push({ source, message: source === "icloud" ? appleSyncMessage(err) : sanitize(err) });
}

function stripEtag(etag: string | null | undefined): string | null {
  if (!etag) return null;
  return etag.startsWith('"') ? etag.slice(1, -1) : etag;
}

function quotedEtag(etag: string | null): string | undefined {
  if (!etag) return undefined;
  return etag.startsWith('"') ? etag : `"${etag}"`;
}

class Conflict412 extends Error {
  constructor() {
    super("etag superato");
  }
}

// ------------------------------------------------------------- credenziali

export async function googleTokens(): Promise<{ access_token: string }> {
  const p = prisma();
  const row = await p.setting.findUnique({ where: { key: "int_google" } });
  if (!row) throw new Error("Google non collegato.");
  let parsed: { access_token?: string; refresh_token?: string; expires_at?: number };
  try {
    parsed = JSON.parse(openSecret(row.value));
  } catch {
    throw new Error("Google: credenziali illeggibili, ricollega l'account.");
  }
  if (Date.now() < Number(parsed.expires_at ?? 0) - 60_000 && parsed.access_token) {
    return { access_token: parsed.access_token };
  }
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret || !parsed.refresh_token) {
    throw new Error("Google: configurazione incompleta, ricollega l'account.");
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: parsed.refresh_token,
      grant_type: "refresh_token",
    }).toString(),
  });
  if (!res.ok) {
    await p.setting.upsert({
      where: { key: "int_google_status" },
      update: { value: "reauth_required" },
      create: { key: "int_google_status", value: "reauth_required" },
    });
    throw new Error("Google: sessione scaduta, riconnetti l'account.");
  }
  const data = (await res.json()) as Record<string, unknown>;
  const next = {
    access_token: String(data.access_token ?? ""),
    refresh_token: parsed.refresh_token,
    expires_at: Date.now() + Number(data.expires_in ?? 3600) * 1000,
  };
  const sealed = sealSecret(JSON.stringify(next));
  await p.setting.upsert({
    where: { key: "int_google" },
    update: { value: sealed },
    create: { key: "int_google", value: sealed },
  });
  return { access_token: next.access_token };
}

interface AppleCreds {
  apple_id: string;
  app_password: string;
}

export async function appleCreds(): Promise<AppleCreds> {
  const row = await prisma().setting.findUnique({ where: { key: "int_apple" } });
  if (!row) throw new Error("Apple non collegato.");
  try {
    return JSON.parse(openSecret(row.value)) as AppleCreds;
  } catch {
    throw new Error("Apple: credenziali illeggibili, ricollega l'account.");
  }
}

function basicAuth(creds: AppleCreds): string {
  return "Basic " + Buffer.from(`${creds.apple_id}:${creds.app_password}`).toString("base64");
}

// ----------------------------------------------------------------- Google

const GOOGLE_API = "https://www.googleapis.com/calendar/v3";

const eventsPath = (calendarId: string): string =>
  `${GOOGLE_API}/calendars/${encodeURIComponent(calendarId)}/events`;

export interface GoogleCalendar {
  id: string;
  name: string;
  access_role: string;
  primary: boolean;
}

/**
 * Calendari dell'account: si sincronizzano tutti quelli non cancellati, non solo
 * `primary`. `primary` è messo per primo perché è la destinazione preferita
 * quando un evento nato nel CRM va creato su Google.
 */
export async function googleCalendars(accessToken: string): Promise<GoogleCalendar[]> {
  const res = await fetch(`${GOOGLE_API}/users/me/calendarList?maxResults=250&showDeleted=false`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Google Calendar (elenco calendari) ha risposto ${res.status}.`);
  const data = (await res.json()) as Record<string, any>;
  const out: GoogleCalendar[] = [];
  for (const item of Array.isArray(data.items) ? data.items : []) {
    const id = String(item.id ?? "");
    if (!id || item.deleted) continue;
    out.push({
      id,
      name: String(item.summary ?? id),
      access_role: String(item.accessRole ?? "reader"),
      primary: item.primary === true,
    });
  }
  return out.sort((a, b) => Number(b.primary) - Number(a.primary));
}

/** Calendario su cui creare gli eventi nati localmente: il primo scrivibile. */
async function googleWriteCalendar(): Promise<string> {
  const rows = await prisma().syncCalendar.findMany({ where: { provider: "google" } });
  const writable = rows.filter((r) => r.access_role === "owner" || r.access_role === "writer");
  const target =
    writable.find((r) => r.primary) ??
    writable.find((r) => r.calendar_id === "primary") ??
    writable[0];
  return target?.calendar_id ?? "primary";
}

function mapGoogleItem(item: Record<string, any>, calendarId: string): RemoteEvent {
  const allDay = !!item.start?.date;
  const start = String(item.start?.dateTime ?? item.start?.date ?? "");
  const end = String(item.end?.dateTime ?? item.end?.date ?? start);
  const updated = Date.parse(String(item.updated ?? ""));
  return {
    external_id: String(item.id ?? ""),
    title: String(item.summary ?? "(senza titolo)"),
    start,
    end,
    all_day: allDay,
    description: item.description ? String(item.description) : null,
    location: item.location ? String(item.location) : null,
    updated_at: Number.isNaN(updated) ? Date.now() : updated,
    etag: stripEtag(item.etag ?? null),
    cancelled: item.status === "cancelled",
    eventType: item.eventType ? String(item.eventType) : undefined,
    calendar_id: calendarId,
    ical_uid: item.iCalUID ? String(item.iCalUID) : undefined,
  };
}

export async function googleList(
  accessToken: string,
  calendarId: string,
  syncToken: string | null,
  win: { from: string; to: string },
): Promise<{ events: RemoteEvent[]; nextSyncToken: string | null }> {
  let token = syncToken;
  let pageToken: string | undefined;
  const events: RemoteEvent[] = [];
  for (;;) {
    const q = new URLSearchParams({ singleEvents: "true", showDeleted: "true", maxResults: "250" });
    if (token) q.set("syncToken", token);
    else {
      q.set("timeMin", `${win.from}T00:00:00Z`);
      q.set("timeMax", `${win.to}T23:59:59Z`);
    }
    if (pageToken) q.set("pageToken", pageToken);
    const res = await fetch(`${eventsPath(calendarId)}?${q.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 410 && token) {
      token = null;
      pageToken = undefined;
      continue;
    }
    if (!res.ok) throw new Error(`Google Calendar ha risposto ${res.status}.`);
    const data = (await res.json()) as Record<string, any>;
    for (const item of Array.isArray(data.items) ? data.items : []) {
      const mapped = mapGoogleItem(item, calendarId);
      if (mapped.external_id) events.push(mapped);
    }
    pageToken = data.nextPageToken;
    if (!pageToken) return { events, nextSyncToken: data.nextSyncToken ?? token };
  }
}

function googlePayload(ev: {
  title: string;
  start: string;
  end: string;
  all_day: boolean;
  description: string | null;
  location: string | null;
}): Record<string, unknown> {
  return {
    summary: ev.title,
    description: ev.description ?? undefined,
    location: ev.location ?? undefined,
    start: ev.all_day ? { date: ev.start.slice(0, 10) } : { dateTime: ev.start },
    end: ev.all_day ? { date: ev.end.slice(0, 10) } : { dateTime: ev.end },
  };
}

async function googleInsert(
  accessToken: string,
  calendarId: string,
  ev: Parameters<typeof googlePayload>[0],
): Promise<{ external_id: string; etag: string | null; calendar_id: string }> {
  const res = await fetch(eventsPath(calendarId), {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(googlePayload(ev)),
  });
  if (!res.ok) throw new Error(`Creazione su Google fallita (${res.status}).`);
  const data = (await res.json()) as Record<string, any>;
  return {
    external_id: String(data.id ?? ""),
    etag: stripEtag(data.etag ?? null),
    calendar_id: calendarId,
  };
}

async function googleUpdate(
  accessToken: string,
  calendarId: string,
  externalId: string,
  ev: Parameters<typeof googlePayload>[0],
  etag: string | null,
): Promise<string | null> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
  const quoted = quotedEtag(etag);
  if (quoted) headers["If-Match"] = quoted;
  const res = await fetch(`${eventsPath(calendarId)}/${encodeURIComponent(externalId)}`, {
    method: "PUT",
    headers,
    body: JSON.stringify(googlePayload(ev)),
  });
  if (res.status === 412) throw new Conflict412();
  if (!res.ok) throw new Error(`Aggiornamento su Google fallito (${res.status}).`);
  const data = (await res.json().catch(() => ({}))) as Record<string, any>;
  return stripEtag(data.etag ?? null);
}

async function googleGet(
  accessToken: string,
  calendarId: string,
  externalId: string,
): Promise<RemoteEvent | null> {
  const res = await fetch(`${eventsPath(calendarId)}/${encodeURIComponent(externalId)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 404 || res.status === 410) return null;
  if (!res.ok) throw new Error(`Lettura da Google fallita (${res.status}).`);
  return mapGoogleItem((await res.json()) as Record<string, any>, calendarId);
}

async function googleDelete(
  accessToken: string,
  calendarId: string,
  externalId: string,
  etag: string | null,
): Promise<void> {
  const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
  const quoted = quotedEtag(etag);
  if (quoted) headers["If-Match"] = quoted;
  const res = await fetch(`${eventsPath(calendarId)}/${encodeURIComponent(externalId)}`, {
    method: "DELETE",
    headers,
  });
  if (res.ok || res.status === 404 || res.status === 410) return;
  throw new Error(`Cancellazione su Google fallita (${res.status}).`);
}

// ------------------------------------------------------------------ CalDAV

const CALDAV_ENTRY = "https://caldav.icloud.com/";
const xmlParser = new XMLParser({ removeNSPrefix: true, ignoreAttributes: true, parseTagValue: false });

function findKey(node: unknown, key: string): unknown {
  if (!node || typeof node !== "object") return undefined;
  if (Array.isArray(node)) {
    for (const item of node) {
      const r = findKey(item, key);
      if (r !== undefined) return r;
    }
    return undefined;
  }
  const obj = node as Record<string, unknown>;
  if (key in obj) return obj[key];
  for (const v of Object.values(obj)) {
    const r = findKey(v, key);
    if (r !== undefined) return r;
  }
  return undefined;
}

function hrefIn(node: unknown): string | undefined {
  const href = findKey(node, "href");
  return typeof href === "string" ? href : undefined;
}

// Riusati dal client CardDAV dei contatti: stessa forma di risposta DAV.
export { findKey, hrefIn };

const PRINCIPAL_XML =
  '<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>';
const HOME_XML =
  '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>';
const LIST_XML =
  '<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:displayname/></d:prop></d:propfind>';

async function propfind(url: string, creds: AppleCreds, depth: string, body: string): Promise<Response> {
  return fetch(url, {
    method: "PROPFIND",
    headers: {
      Authorization: basicAuth(creds),
      "Content-Type": "application/xml; charset=utf-8",
      Depth: depth,
    },
    body,
  });
}

/** Discovery per-account: entry → principal → home-set → calendario predefinito. */
export async function caldavDiscover(creds: AppleCreds): Promise<string> {
  const first = await fetch(CALDAV_ENTRY, {
    method: "PROPFIND",
    headers: {
      Authorization: basicAuth(creds),
      "Content-Type": "application/xml; charset=utf-8",
      Depth: "0",
    },
    body: PRINCIPAL_XML,
    redirect: "manual",
  });

  let origin = new URL(CALDAV_ENTRY).origin;
  if (first.status >= 300 && first.status < 400) {
    const location = first.headers.get("location");
    if (!location) throw new Error("iCloud: redirect privo di destinazione.");
    origin = new URL(location, CALDAV_ENTRY).origin;
  } else if (first.status !== 207 && !first.ok) {
    throw new AppleHttpError(first.status, "l'interrogazione iniziale");
  }

  const principalRes = await propfind(`${origin}/`, creds, "0", PRINCIPAL_XML);
  if (principalRes.status !== 207) {
    throw new AppleHttpError(principalRes.status, "la ricerca del principal");
  }
  const principalDoc = xmlParser.parse(await principalRes.text());
  const principalHref = hrefIn(findKey(principalDoc, "current-user-principal"));
  if (!principalHref) throw new Error("iCloud: principal non trovato nella risposta.");
  const principalUrl = new URL(principalHref, `${origin}/`).toString();

  const homeRes = await propfind(principalUrl, creds, "0", HOME_XML);
  if (homeRes.status !== 207) {
    throw new AppleHttpError(homeRes.status, "la ricerca dei calendari");
  }
  const homeDoc = xmlParser.parse(await homeRes.text());
  const homeHref = hrefIn(findKey(homeDoc, "calendar-home-set"));
  if (!homeHref) throw new Error("iCloud: calendari non trovati nella risposta.");
  const homeUrl = new URL(homeHref, `${origin}/`).toString();

  const listRes = await propfind(homeUrl, creds, "1", LIST_XML);
  if (listRes.status !== 207) {
    throw new AppleHttpError(listRes.status, "l'elenco dei calendari");
  }
  const listDoc = xmlParser.parse(await listRes.text());
  let responses = findKey(listDoc, "response");
  if (responses && !Array.isArray(responses)) responses = [responses];
  for (const resp of (responses as unknown[]) ?? []) {
    const href = hrefIn(resp);
    if (!href || /(inbox|outbox|notification)/i.test(href)) continue;
    const resourceType = findKey(resp, "resourcetype");
    if (resourceType && typeof resourceType === "object" && "calendar" in (resourceType as object)) {
      return new URL(href, `${origin}/`).toString();
    }
  }
  throw new Error("iCloud: nessun calendario scrivibile trovato nell'account.");
}

async function getCalendarPath(creds: AppleCreds): Promise<string> {
  const p = prisma();
  const row = await p.syncState.findUnique({ where: { provider: "icloud" } });
  if (row?.calendar_path) return row.calendar_path;
  const path = await caldavDiscover(creds);
  await p.syncState.upsert({
    where: { provider: "icloud" },
    update: { calendar_path: path },
    create: { provider: "icloud", calendar_path: path },
  });
  return path;
}

function icsUnescape(value: string): string {
  return value.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
}

export function parseIcsEvents(ics: string, href: string): RemoteEvent[] {
  const lines = ics.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  const out: RemoteEvent[] = [];
  let cur: Record<string, string> | null = null;
  let curKey: Record<string, string> = {};
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      cur = {};
      curKey = {};
      continue;
    }
    if (line === "END:VEVENT" && cur) {
      const uid = cur.UID ?? "";
      const dtStart = cur.DTSTART ?? "";
      const dtEnd = cur.DTEND ?? dtStart;
      const allDay = /VALUE=DATE/i.test(curKey.DTSTART ?? "") || /^\d{8}$/.test(dtStart);
      const stamp = Date.parse(cur.LAST_MODIFIED ?? cur.DTSTAMP ?? "");
      out.push({
        external_id: `${href}#${uid || randomBytes(6).toString("hex")}`,
        title: icsUnescape(cur.SUMMARY ?? "(senza titolo)"),
        start: allDay
          ? `${dtStart.slice(0, 4)}-${dtStart.slice(4, 6)}-${dtStart.slice(6, 8)}`
          : dtStart,
        end: allDay
          ? dtEnd.length >= 8
            ? `${dtEnd.slice(0, 4)}-${dtEnd.slice(4, 6)}-${dtEnd.slice(6, 8)}`
            : dtEnd
          : dtEnd,
        all_day: allDay,
        description: cur.DESCRIPTION ? icsUnescape(cur.DESCRIPTION) : null,
        location: cur.LOCATION ? icsUnescape(cur.LOCATION) : null,
        updated_at: Number.isNaN(stamp) ? Date.now() : stamp,
        etag: null,
        cancelled: (cur.STATUS ?? "").toUpperCase() === "CANCELLED",
      });
      cur = null;
      continue;
    }
    if (cur) {
      const idx = line.indexOf(":");
      if (idx > 0) {
        const keyPart = line.slice(0, idx);
        const name = keyPart.split(";")[0];
        cur[name] = line.slice(idx + 1);
        curKey[name] = keyPart;
      }
    }
  }
  return out;
}

function icsEscape(value: string): string {
  return value
    .replace(/\r?\n/g, "\\n")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

function foldIcs(line: string): string {
  if (line.length <= 74) return line;
  const parts: string[] = [line.slice(0, 74)];
  let rest = line.slice(74);
  while (rest.length > 73) {
    parts.push(" " + rest.slice(0, 73));
    rest = rest.slice(73);
  }
  if (rest) parts.push(" " + rest);
  return parts.join("\r\n");
}

function toIcsInstant(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso.replace(/[-:]/g, "").slice(0, 15) + "Z";
  return new Date(t).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export function buildIcs(ev: {
  title: string;
  start: string;
  end: string;
  all_day: boolean;
  description: string | null;
  location: string | null;
}, uid: string): string {
  const dtstamp = toIcsInstant(new Date().toISOString());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//REALINDI SYSTEMS//CRM//IT",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${dtstamp}`,
    ev.all_day
      ? `DTSTART;VALUE=DATE:${ev.start.slice(0, 10).replace(/-/g, "")}`
      : `DTSTART:${toIcsInstant(ev.start)}`,
    ev.all_day
      ? `DTEND;VALUE=DATE:${ev.end.slice(0, 10).replace(/-/g, "")}`
      : `DTEND:${toIcsInstant(ev.end)}`,
    `SUMMARY:${icsEscape(ev.title)}`,
    ev.location ? `LOCATION:${icsEscape(ev.location)}` : null,
    ev.description ? `DESCRIPTION:${icsEscape(ev.description)}` : null,
    "STATUS:CONFIRMED",
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter((x): x is string => x !== null);
  return lines.map(foldIcs).join("\r\n") + "\r\n";
}

export async function caldavReport(
  calendarPath: string,
  creds: AppleCreds,
  win: { from: string; to: string },
): Promise<RemoteEvent[]> {
  const start = win.from.replace(/-/g, "") + "T000000Z";
  const end = win.to.replace(/-/g, "") + "T235959Z";
  const body =
    '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">' +
    "<d:prop><d:getetag/><c:calendar-data/></d:prop>" +
    '<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">' +
    `<c:time-range start="${start}" end="${end}"/>` +
    "</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>";
  const res = await fetch(calendarPath, {
    method: "REPORT",
    headers: {
      Authorization: basicAuth(creds),
      "Content-Type": "application/xml; charset=utf-8",
      Depth: "1",
    },
    body,
  });
  if (!res.ok && res.status !== 207) {
    throw new AppleHttpError(res.status, "la lettura del calendario");
  }
  const doc = xmlParser.parse(await res.text());
  let responses = findKey(doc, "response");
  if (responses && !Array.isArray(responses)) responses = [responses];
  const out: RemoteEvent[] = [];
  for (const resp of (responses as unknown[]) ?? []) {
    const href = hrefIn(resp);
    if (!href) continue;
    const absolute = new URL(href, calendarPath).toString();
    const etag = stripEtag(
      typeof findKey(resp, "getetag") === "string" ? (findKey(resp, "getetag") as string) : null,
    );
    const ics = findKey(resp, "calendar-data");
    if (typeof ics !== "string" || !ics.includes("BEGIN:VEVENT")) continue;
    for (const ev of parseIcsEvents(ics, absolute)) {
      out.push({ ...ev, etag });
    }
  }
  return out;
}

async function caldavInsert(
  calendarPath: string,
  creds: AppleCreds,
  ev: { title: string; start: string; end: string; all_day: boolean; description: string | null; location: string | null },
): Promise<{ external_id: string; etag: string | null }> {
  const uid = `${randomBytes(12).toString("hex")}@realindi`;
  const url = calendarPath + uid.replace("@", "-") + ".ics";
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: basicAuth(creds),
      "Content-Type": "text/calendar; charset=utf-8",
      "If-None-Match": "*",
    },
    body: buildIcs(ev, uid),
  });
  if (res.status === 412) throw new Conflict412();
  if (!res.ok) throw new AppleHttpError(res.status, "la creazione dell'evento");
  return { external_id: url, etag: stripEtag(res.headers.get("etag")) };
}

async function caldavUpdate(
  creds: AppleCreds,
  externalId: string,
  ev: { title: string; start: string; end: string; all_day: boolean; description: string | null; location: string | null },
  etag: string | null,
): Promise<string | null> {
  const headers: Record<string, string> = {
    Authorization: basicAuth(creds),
    "Content-Type": "text/calendar; charset=utf-8",
  };
  const quoted = quotedEtag(etag);
  if (quoted) headers["If-Match"] = quoted;
  const res = await fetch(externalId, {
    method: "PUT",
    headers,
    body: buildIcs(ev, externalId.split("/").pop() ?? "evento"),
  });
  if (res.status === 412) throw new Conflict412();
  if (!res.ok) throw new AppleHttpError(res.status, "la modifica dell'evento");
  return stripEtag(res.headers.get("etag")) ?? etag;
}

async function caldavDelete(creds: AppleCreds, externalId: string, etag: string | null): Promise<void> {
  const headers: Record<string, string> = { Authorization: basicAuth(creds) };
  const quoted = quotedEtag(etag);
  if (quoted) headers["If-Match"] = quoted;
  const res = await fetch(externalId, { method: "DELETE", headers });
  if (res.ok || res.status === 404 || res.status === 410) return;
  throw new AppleHttpError(res.status, "la cancellazione dell'evento");
}

// ------------------------------------------------------------ orchestrazione

type Source = "google" | "icloud";

interface EventRow {
  id: number;
  title: string;
  start: string;
  end: string;
  all_day: boolean;
  description: string | null;
  location: string | null;
  updated_at: bigint;
  dirty: boolean;
  deleted_at: string | null;
}

async function insertRemote(
  source: Source,
  ev: EventRow,
): Promise<{ external_id: string; etag: string | null; calendar_id: string }> {
  if (source === "google") {
    const { access_token } = await googleTokens();
    return googleInsert(access_token, await googleWriteCalendar(), ev);
  }
  const creds = await appleCreds();
  const path = await getCalendarPath(creds);
  return { ...(await caldavInsert(path, creds, ev)), calendar_id: "primary" };
}

async function updateRemote(
  source: Source,
  link: { external_id: string; etag: string | null; calendar_id: string },
  ev: EventRow,
): Promise<string | null> {
  if (source === "google") {
    const { access_token } = await googleTokens();
    return googleUpdate(access_token, link.calendar_id, link.external_id, ev, link.etag);
  }
  const creds = await appleCreds();
  return caldavUpdate(creds, link.external_id, ev, link.etag);
}

async function deleteRemote(
  source: Source,
  link: { external_id: string; etag: string | null; calendar_id: string },
): Promise<void> {
  if (source === "google") {
    const { access_token } = await googleTokens();
    return googleDelete(access_token, link.calendar_id, link.external_id, link.etag);
  }
  const creds = await appleCreds();
  return caldavDelete(creds, link.external_id, link.etag);
}

async function getRemote(
  source: Source,
  link: { external_id: string; calendar_id: string },
): Promise<RemoteEvent | null> {
  if (source === "google") {
    const { access_token } = await googleTokens();
    return googleGet(access_token, link.calendar_id, link.external_id);
  }
  const creds = await appleCreds();
  const path = await getCalendarPath(creds);
  const origin = new URL(path).origin;
  const events = await caldavReport(path, creds, windowRange());
  return (
    events.find((e) => e.external_id === link.external_id || new URL(e.external_id).origin === origin) ??
    null
  );
}

function eventSnapshot(ev: {
  title: string;
  start: string;
  end: string;
  all_day: boolean;
  description: string | null;
  location: string | null;
  updated_at: number | bigint;
}): Record<string, unknown> {
  return {
    title: ev.title,
    start: ev.start,
    end: ev.end,
    all_day: ev.all_day,
    description: ev.description,
    location: ev.location,
    updated_at: Number(ev.updated_at),
  };
}

/** Registra il conflitto con entrambe le versioni; se ne esiste gi\u00e0 uno aperto, lo aggiorna. */
async function recordConflict(
  link: { id: number; event_id: number; source: string },
  ev: EventRow,
  remote: RemoteEvent,
): Promise<void> {
  const p = prisma();
  const local_json = JSON.stringify(eventSnapshot(ev));
  const remote_json = JSON.stringify({ ...eventSnapshot(remote), etag: remote.etag });
  const pending = await p.syncConflict.findFirst({
    where: { link_id: link.id, resolution: "pending" },
  });
  if (pending) {
    await p.syncConflict.update({ where: { id: pending.id }, data: { local_json, remote_json } });
    return;
  }
  await p.syncConflict.create({
    data: {
      link_id: link.id,
      source: link.source,
      entity_kind: "event",
      entity_id: ev.id,
      local_json,
      remote_json,
    },
  });
}

export interface ConflictView {
  id: number;
  source: string;
  event_id: number;
  detected_at: string;
  local: Record<string, unknown>;
  remote: Record<string, unknown>;
}

/** Conflitti ancora aperti, dal più vecchio. */
export async function listConflicts(): Promise<ConflictView[]> {
  const rows = await prisma().syncConflict.findMany({
    where: { resolution: "pending" },
    orderBy: { detected_at: "asc" },
  });
  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    event_id: r.entity_id,
    detected_at: r.detected_at,
    local: JSON.parse(r.local_json) as Record<string, unknown>,
    remote: JSON.parse(r.remote_json) as Record<string, unknown>,
  }));
}

/** Chiude un conflitto applicando la versione scelta. */
export async function resolveConflictById(
  id: number,
  choice: "local" | "remote",
  by: string,
): Promise<void> {
  const p = prisma();
  const conflict = await p.syncConflict.findUnique({ where: { id } });
  if (!conflict || conflict.resolution !== "pending") {
    throw new Invalid("Conflitto non trovato o già risolto.");
  }
  const event = await p.calendarEvent.findUnique({ where: { id: conflict.entity_id } });
  if (!event) throw new Invalid("Evento del conflitto non trovato.");
  const link = await p.eventLink.findUnique({ where: { id: conflict.link_id } });

  if (choice === "remote") {
    const remote = JSON.parse(conflict.remote_json) as Record<string, any>;
    await p.calendarEvent.update({
      where: { id: event.id },
      data: {
        title: String(remote.title ?? event.title),
        start: String(remote.start ?? event.start),
        end: String(remote.end ?? event.end),
        all_day: remote.all_day === true,
        description: remote.description == null ? null : String(remote.description),
        location: remote.location == null ? null : String(remote.location),
        updated_at: BigInt(Number(remote.updated_at ?? Date.now())),
        dirty: false,
      },
    });
    if (link) {
      const etag = typeof remote.etag === "string" ? remote.etag.replace(/^"|"$/g, "") : link.etag;
      await p.eventLink.update({ where: { id: link.id }, data: { etag, dirty: false } });
    }
  } else {
    // Vince il locale: si riparte dal push al prossimo sync.
    await p.calendarEvent.update({
      where: { id: event.id },
      data: { updated_at: BigInt(Date.now()), dirty: true },
    });
    if (link) await p.eventLink.update({ where: { id: link.id }, data: { dirty: true } });
  }

  await p.syncConflict.update({
    where: { id },
    data: {
      resolution: choice === "remote" ? "remote_wins" : "local_wins",
      resolved_at: utcStamp(),
      resolved_by: by.slice(0, 120),
    },
  });
}

/** 412: rilegge il remoto e applica la politica dei conflitti. */
async function resolveConflict(
  source: Source,
  ev: EventRow,
  link: {
    id: number;
    event_id: number;
    source: string;
    external_id: string;
    etag: string | null;
    calendar_id: string;
  },
): Promise<void> {
  const p = prisma();
  const remote = await getRemote(source, link);
  if (!remote) {
    await p.eventLink.delete({ where: { id: link.id } }).catch(() => undefined);
    await p.calendarEvent.update({
      where: { id: ev.id },
      data: { deleted_at: utcStamp(), dirty: false, updated_at: BigInt(Date.now()) },
    });
    return;
  }
  if (remote.cancelled) {
    await p.eventLink.delete({ where: { id: link.id } }).catch(() => undefined);
    await p.calendarEvent.update({
      where: { id: ev.id },
      data: { deleted_at: utcStamp(), dirty: false, updated_at: BigInt(Date.now()) },
    });
    return;
  }
  const decision = decideConflict(ev, remote, await conflictPolicy());

  if (decision === "manual") {
    // Nessuna delle due versioni è più autorevole: si registrano entrambe e si
    // smette di ritentare, altrimenti ogni sync riprodurrebbe lo stesso 412.
    await recordConflict(link, ev, remote);
    await p.eventLink.update({
      where: { id: link.id },
      data: { etag: remote.etag, dirty: false },
    });
    await p.calendarEvent.update({ where: { id: ev.id }, data: { dirty: false } });
    return;
  }

  if (decision === "remote_wins") {
    await p.calendarEvent.update({
      where: { id: ev.id },
      data: {
        title: remote.title,
        start: remote.start,
        end: remote.end,
        all_day: remote.all_day,
        description: remote.description,
        location: remote.location,
        updated_at: BigInt(remote.updated_at),
        dirty: false,
      },
    });
    await p.eventLink.update({
      where: { id: link.id },
      data: { etag: remote.etag, dirty: false },
    });
    return;
  }

  // local_wins: si riprova con l'ETag appena letto, quindi il push va a segno.
  await p.eventLink.update({ where: { id: link.id }, data: { etag: remote.etag, dirty: true } });
}

async function pushOutbound(
  source: Source,
  sources: Source[],
  errors: Array<{ source: string; message: string }>,
): Promise<void> {
  const p = prisma();
  const events = await p.calendarEvent.findMany();
  const allLinks = await p.eventLink.findMany();
  const linkByEvent = new Map(allLinks.filter((l) => l.source === source).map((l) => [l.event_id, l]));

  // `dirty` è globale sull'evento: azzerarlo al primo push riuscito farebbe
  // saltare le altre sorgenti collegate, che non hanno ancora un legame (e
  // quindi nemmeno un `link.dirty`). Va spento solo quando sono tutte allineate.
  const clean = new Map<number, Set<string>>();
  for (const l of allLinks) {
    if (l.dirty) continue;
    const set = clean.get(l.event_id) ?? new Set<string>();
    set.add(l.source);
    clean.set(l.event_id, set);
  }
  const markClean = (eventId: number, s: Source): void => {
    const set = clean.get(eventId) ?? new Set<string>();
    set.add(s);
    clean.set(eventId, set);
  };
  const settled = (eventId: number): boolean => {
    const set = clean.get(eventId);
    return !!set && sources.every((s) => set.has(s));
  };

  for (const ev of events) {
    const link = linkByEvent.get(ev.id) ?? null;
    try {
      if (ev.deleted_at) {
        if (link) {
          await deleteRemote(source, link);
          await p.eventLink.delete({ where: { id: link.id } }).catch(() => undefined);
        }
        const remaining = await p.eventLink.count({ where: { event_id: ev.id } });
        if (remaining === 0) await p.calendarEvent.delete({ where: { id: ev.id } }).catch(() => undefined);
        continue;
      }
      if (!ev.dirty && !(link && link.dirty)) continue;

      if (!link) {
        const created = await insertRemote(source, ev);
        if (!created.external_id) throw new Error(`${source}: il provider non ha restituito un identificativo.`);
        await p.eventLink.create({
          data: {
            event_id: ev.id,
            source,
            calendar_id: created.calendar_id,
            external_id: created.external_id,
            etag: created.etag,
            dirty: false,
          },
        });
        markClean(ev.id, source);
      } else {
        try {
          const newEtag = await updateRemote(
            source,
            { external_id: link.external_id, etag: link.etag, calendar_id: link.calendar_id },
            ev,
          );
          await p.eventLink.update({
            where: { id: link.id },
            data: { etag: newEtag ?? link.etag, dirty: false },
          });
          markClean(ev.id, source);
        } catch (err) {
          if (err instanceof Conflict412) {
            // Il conflitto lascia il legame sporco: la sorgente non è allineata.
            clean.get(ev.id)?.delete(source);
            await resolveConflict(source, ev, link);
          } else throw err;
        }
      }

      if (ev.dirty && settled(ev.id)) {
        await p.calendarEvent.update({ where: { id: ev.id }, data: { dirty: false } });
      }
    } catch (err) {
      addError(errors, source, err);
    }
  }
}

async function applyRemote(
  source: Source,
  remotes: RemoteEvent[],
  counts: { imported: number; updated: number; removed: number },
): Promise<void> {
  const p = prisma();
  const links = await p.eventLink.findMany({ where: { source } });
  // La chiave include il calendario: su Google un id evento è univoco solo
  // dentro il suo calendario.
  const linkKey = (calendarId: string, externalId: string): string =>
    `${calendarId}\u0000${externalId}`;
  const linkByExt = new Map(links.map((l) => [linkKey(l.calendar_id, l.external_id), l]));
  // I legami creati da caldavInsert conservano l'URL della risorsa, mentre il
  // parser ICS produce `url#uid`: senza il confronto per risorsa l'evento appena
  // scritto verrebbe reimportato e un annullamento remoto resterebbe invisibile.
  const linkByResource = new Map(
    links.map((l) => [linkKey(l.calendar_id, l.external_id.split("#")[0]), l]),
  );
  const locals = await p.calendarEvent.findMany({ where: { id: { in: links.map((l) => l.event_id) } } });
  const localById = new Map(locals.map((e) => [e.id, e]));

  for (const remote of remotes) {
    if (!remote.external_id || !isImportable(remote)) continue;
    const remoteCalendar = remote.calendar_id ?? "primary";
    const link =
      linkByExt.get(linkKey(remoteCalendar, remote.external_id)) ??
      linkByResource.get(linkKey(remoteCalendar, remote.external_id.split("#")[0])) ??
      null;
    const local = link ? localById.get(link.event_id) ?? null : null;

    if (remote.cancelled) {
      if (local && !local.deleted_at) {
        await p.calendarEvent.update({
          where: { id: local.id },
          data: { deleted_at: utcStamp(), dirty: false, updated_at: BigInt(Date.now()) },
        });
        counts.removed += 1;
      }
      if (link) {
        await p.eventLink.delete({ where: { id: link.id } }).catch(() => undefined);
        linkByExt.delete(linkKey(remoteCalendar, remote.external_id));
      }
      continue;
    }

    if (!local) {
      const created = await p.calendarEvent.create({
        data: {
          title: remote.title,
          start: remote.start,
          end: remote.end,
          all_day: remote.all_day,
          description: remote.description,
          location: remote.location,
          updated_at: BigInt(remote.updated_at),
          dirty: false,
        },
      });
      if (link) {
        await p.eventLink.update({
          where: { id: link.id },
          data: { event_id: created.id, etag: remote.etag, dirty: false },
        });
      } else {
        await p.eventLink.create({
          data: {
            event_id: created.id,
            source,
            calendar_id: remoteCalendar,
            external_id: remote.external_id,
            etag: remote.etag,
            dirty: false,
          },
        });
      }
      counts.imported += 1;
      continue;
    }

    const decision = mergeRemote(local, remote);
    if (decision === "update") {
      await p.calendarEvent.update({
        where: { id: local.id },
        data: {
          title: remote.title,
          start: remote.start,
          end: remote.end,
          all_day: remote.all_day,
          description: remote.description,
          location: remote.location,
          updated_at: BigInt(remote.updated_at),
          dirty: false,
        },
      });
      if (link) {
        await p.eventLink.update({
          where: { id: link.id },
          data: { etag: remote.etag ?? link.etag, dirty: false },
        });
      }
      counts.updated += 1;
    } else if (link && remote.etag && remote.etag !== link.etag) {
      await p.eventLink.update({ where: { id: link.id }, data: { etag: remote.etag } });
    }
  }
}

/**
 * Sincronizza un singolo calendario Google. Usata dal ciclo completo e dal
 * webhook, che riceve notifica per un calendario solo.
 */
async function syncGoogleCalendar(
  accessToken: string,
  calendarId: string,
  meta: { name: string; access_role: string; primary: boolean } | null,
  counts: { imported: number; updated: number; removed: number },
  seen: Set<string>,
): Promise<void> {
  const p = prisma();
  const state = await p.syncCalendar.findUnique({
    where: { provider_calendar_id: { provider: "google", calendar_id: calendarId } },
  });
  const { events, nextSyncToken } = await googleList(
    accessToken,
    calendarId,
    state?.token ?? null,
    windowRange(),
  );
  const fresh = events.filter((e) => {
    if (e.cancelled) return true;
    const key = e.ical_uid ? `uid:${e.ical_uid}` : `id:${calendarId}:${e.external_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  await applyRemote("google", fresh, counts);
  const base = meta ?? {
    name: state?.name ?? "",
    access_role: state?.access_role ?? "",
    primary: state?.primary ?? false,
  };
  await p.syncCalendar.upsert({
    where: { provider_calendar_id: { provider: "google", calendar_id: calendarId } },
    update: {
      name: base.name,
      access_role: base.access_role,
      primary: base.primary,
      token: nextSyncToken,
      last_sync_at: utcStamp(),
    },
    create: {
      provider: "google",
      calendar_id: calendarId,
      name: base.name,
      access_role: base.access_role,
      primary: base.primary,
      token: nextSyncToken,
      last_sync_at: utcStamp(),
    },
  });
}

async function pullInbound(
  source: Source,
  counts: { imported: number; updated: number; removed: number },
  errors: Array<{ source: string; message: string }>,
): Promise<void> {
  const p = prisma();
  const win = windowRange();

  if (source === "google") {
    const { access_token } = await googleTokens();
    const calendars = await googleCalendars(access_token);
    // Lo stesso evento invitato vive in più calendari con id diversi ma con lo
    // stesso iCalUID: si importa una volta sola, la prima occorrenza trovata.
    const seen = new Set<string>();
    for (const cal of calendars) {
      try {
        await syncGoogleCalendar(access_token, cal.id, cal, counts, seen);
      } catch (err) {
        // Un calendario in errore non deve fermare gli altri.
        addError(errors, "google", err);
      }
    }
    await p.syncState.upsert({
      where: { provider: "google" },
      update: { last_sync_at: utcStamp() },
      create: { provider: "google", last_sync_at: utcStamp() },
    });
    return;
  }

  const creds = await appleCreds();
  const path = await getCalendarPath(creds);
  const events = await caldavReport(path, creds, win);
  await applyRemote("icloud", events, counts);
  await p.syncState.upsert({
    where: { provider: "icloud" },
    update: { calendar_path: path, last_sync_at: utcStamp() },
    create: { provider: "icloud", calendar_path: path, last_sync_at: utcStamp() },
  });
}

export async function runSync(options: { origin?: string } = {}): Promise<SyncResult> {
  const status = await integrationStatus();
  if (!status.google.connected && !status.apple.connected) {
    throw new Invalid("Nessun calendario collegato.");
  }
  const errors: Array<{ source: string; message: string }> = [];
  const counts = { imported: 0, updated: 0, removed: 0 };
  const sources: Source[] = [];
  if (status.google.connected) sources.push("google");
  if (status.apple.connected) sources.push("icloud");

  for (const source of sources) {
    try {
      await pushOutbound(source, sources, errors);
    } catch (err) {
      addError(errors, source, err);
    }
    try {
      await pullInbound(source, counts, errors);
    } catch (err) {
      addError(errors, source, err);
    }
  }

  // Rinnovo dei canali push: i canali Google scadono, e questo è l'unico punto
  // periodico disponibile senza un servizio di cron separato.
  if (sources.includes("google")) {
    const origin = (options.origin ?? process.env.APP_ORIGIN ?? "").trim();
    try {
      await ensureGoogleChannels(origin);
    } catch (err) {
      addError(errors, "google", err);
    }
  }

  const p = prisma();
  const dirtyLinks = await p.eventLink.count({ where: { dirty: true } });
  const dirtyEvents = await p.calendarEvent.count({ where: { dirty: true } });
  const openConflicts = await p.syncConflict.count({ where: { resolution: "pending" } });
  const pendingTombstones = await p.$queryRaw<
    Array<{ n: number }>
  >`SELECT COUNT(*)::int AS n FROM calendar_events c WHERE c.deleted_at IS NOT NULL AND EXISTS (SELECT 1 FROM event_links l WHERE l.event_id = c.id)`;

  return {
    imported: counts.imported,
    updated: counts.updated,
    removed: counts.removed,
    pending: dirtyLinks + dirtyEvents + Number(pendingTombstones[0]?.n ?? 0),
    conflicts: openConflicts,
    errors,
  };
}

// ------------------------------------------------- notifiche push (Google)

const CHANNEL_TTL_SECONDS = 6 * 24 * 60 * 60;
const CHANNEL_RENEW_BEFORE_MS = 24 * 60 * 60 * 1000;

/**
 * URL che Google può raggiungere. Richiede HTTPS senza percorso: in locale
 * (`http://127.0.0.1`) il push resta spento e si continua col pull.
 */
export function pushAddress(origin: string): string | null {
  const base = origin.trim().replace(/\/+$/, "");
  return /^https:\/\/[^/]+$/.test(base) ? `${base}/api/sync/google/push` : null;
}

async function stopChannel(
  accessToken: string,
  channelId: string,
  resourceId: string,
): Promise<void> {
  await fetch(`${GOOGLE_API}/channels/stop`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ id: channelId, resourceId }),
  }).catch(() => undefined);
}

/**
 * Un canale per calendario, creato alla prima sincronizzazione e sostituito
 * quando manca meno di un giorno alla scadenza. Restituisce quanti ne ha creati.
 */
export async function ensureGoogleChannels(origin: string): Promise<number> {
  const address = pushAddress(origin);
  if (!address) return 0;
  const p = prisma();
  const calendars = await p.syncCalendar.findMany({ where: { provider: "google" } });
  if (!calendars.length) return 0;
  const { access_token } = await googleTokens();
  const now = Date.now();
  let creati = 0;

  for (const cal of calendars) {
    const existing = await p.syncChannel.findFirst({
      where: { provider: "google", calendar_id: cal.calendar_id },
    });
    const valido =
      !!existing &&
      existing.address === address &&
      Number(existing.expiration) - now > CHANNEL_RENEW_BEFORE_MS;
    if (valido) continue;

    if (existing) {
      await stopChannel(access_token, existing.channel_id, existing.resource_id);
      await p.syncChannel
        .delete({ where: { channel_id: existing.channel_id } })
        .catch(() => undefined);
    }

    const channelId = randomBytes(12).toString("hex");
    const token = randomBytes(18).toString("base64url");
    const res = await fetch(`${eventsPath(cal.calendar_id)}/watch`, {
      method: "POST",
      headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        id: channelId,
        type: "web",
        address,
        token,
        params: { ttl: String(CHANNEL_TTL_SECONDS) },
      }),
    });
    if (!res.ok) throw new Error(`Google (watch) ha risposto ${res.status}.`);
    const data = (await res.json().catch(() => ({}))) as Record<string, any>;
    const expiration = Date.parse(String(data.expiration ?? ""));
    await p.syncChannel.create({
      data: {
        channel_id: channelId,
        provider: "google",
        calendar_id: cal.calendar_id,
        resource_id: String(data.resourceId ?? ""),
        address,
        token,
        expiration: BigInt(
          Number.isNaN(expiration) ? now + CHANNEL_TTL_SECONDS * 1000 : expiration,
        ),
      },
    });
    creati += 1;
  }
  return creati;
}

export interface PushResult {
  status: number;
  synced: boolean;
}

/**
 * Notifica di Google: corpo vuoto, identità negli header X-Goog-*. Il canale
 * dice quale calendario è cambiato, quindi si risincronizza solo quello.
 */
export async function handleGooglePush(
  headers: Record<string, string | undefined>,
): Promise<PushResult> {
  const channelId = (headers["x-goog-channel-id"] ?? "").trim();
  const resourceId = (headers["x-goog-resource-id"] ?? "").trim();
  const state = (headers["x-goog-resource-state"] ?? "").trim();
  const token = (headers["x-goog-channel-token"] ?? "").trim();
  if (!channelId) return { status: 400, synced: false };

  const channel = await prisma().syncChannel.findUnique({ where: { channel_id: channelId } });
  if (!channel) return { status: 404, synced: false };
  if (channel.resource_id && resourceId && resourceId !== channel.resource_id) {
    return { status: 404, synced: false };
  }
  if (channel.token && token !== channel.token) return { status: 403, synced: false };
  // Prima notifica di ogni canale: serve solo a confermare che l'URL risponde.
  if (state === "sync") return { status: 200, synced: false };
  if (Number(channel.expiration) < Date.now()) return { status: 410, synced: false };

  const counts = { imported: 0, updated: 0, removed: 0 };
  const errors: Array<{ source: string; message: string }> = [];
  try {
    const { access_token } = await googleTokens();
    await syncGoogleCalendar(access_token, channel.calendar_id, null, counts, new Set<string>());
  } catch (err) {
    addError(errors, "google", err);
  }
  // Google ritenta su 5xx: un pull fallito non deve generare una tempesta di
  // retry, il sync successivo (manuale o all'apertura) recupera comunque.
  return { status: 200, synced: errors.length === 0 };
}
