// Calendario/Planner: query unite (eventi locali/sincronizzati, appuntamenti
// della prenotazione, blocchi) e validazione degli eventi.
import { prisma } from "./db.js";
import { Invalid } from "./util.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Rome",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Data (Europe/Rome) di un istante ISO, oppure la data grezza se non è un istante. */
export function romeDay(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso.slice(0, 10);
  return dayFmt.format(new Date(t));
}

export function parseRange(query: URLSearchParams): { from?: string; to?: string } {
  const from = query.get("from") ?? undefined;
  const to = query.get("to") ?? undefined;
  if (from && !DATE_RE.test(from)) throw new Invalid("Intervallo non valido: from deve essere AAAA-MM-GG.");
  if (to && !DATE_RE.test(to)) throw new Invalid("Intervallo non valido: to deve essere AAAA-MM-GG.");
  return { from, to };
}

export interface EventFields {
  title: string;
  start: string;
  end: string;
  all_day: boolean;
  description: string | null;
  location: string | null;
}

export function validateEventFields(d: Record<string, unknown>): EventFields {
  const title = typeof d.title === "string" ? d.title.trim() : "";
  if (!title || title.length > 200) {
    throw new Invalid("Titolo dell'evento non valido (1-200 caratteri).");
  }
  const start = typeof d.start === "string" ? d.start : "";
  const end = typeof d.end === "string" ? d.end : "";
  const startAt = Date.parse(start);
  const endAt = Date.parse(end);
  if (Number.isNaN(startAt) || Number.isNaN(endAt)) {
    throw new Invalid("Date non valide: usa il formato ISO 8601.");
  }
  if (endAt < startAt) throw new Invalid("La fine non può precedere l'inizio.");
  const description = textOrNull(d.description, 5000, "Descrizione");
  const location = textOrNull(d.location, 300, "Luogo");
  return { title, start, end, all_day: d.all_day === true, description, location };
}

function textOrNull(v: unknown, max: number, label: string): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string" || v.length > max) {
    throw new Invalid(`${label} non valida (max ${max} caratteri).`);
  }
  return v;
}

function inRange(iso: string, from?: string, to?: string): boolean {
  const day = romeDay(iso);
  return (!from || day >= from) && (!to || day <= to);
}

/** Elenco unificato e ordinato per inizio. */
export async function listEvents(from?: string, to?: string): Promise<Array<Record<string, unknown>>> {
  const p = prisma();
  const [events, appointments, blocks] = await Promise.all([
    p.calendarEvent.findMany({ where: { deleted_at: null } }),
    p.appointment.findMany(),
    p.block.findMany(),
  ]);

  const unified: Array<Record<string, unknown>> = [];

  for (const e of events) {
    if (!inRange(e.start, from, to)) continue;
    unified.push({
      kind: "event",
      id: e.id,
      title: e.title,
      start: e.start,
      end: e.end,
      all_day: e.all_day,
      description: e.description,
      location: e.location,
      appointment_id: e.appointment_id,
      updated_at: String(e.updated_at),
      dirty: e.dirty,
    });
  }

  for (const a of appointments) {
    if (!inRange(a.start, from, to)) continue;
    unified.push({
      kind: "appointment",
      id: a.id,
      name: a.name,
      email: a.email,
      notes: a.notes,
      start: a.start,
      end: a.end,
      status: a.status,
    });
  }

  for (const b of blocks) {
    if (!inRange(b.start, from, to)) continue;
    unified.push({ kind: "block", id: b.id, start: b.start, end: b.end, reason: b.reason });
  }

  unified.sort((x, y) => {
    const a = String(x.start);
    const b = String(y.start);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return unified;
}
