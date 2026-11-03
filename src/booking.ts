// Disponibilità della pagina di prenotazione: porting di available() da app.py.
// Confronti tra stringhe ISO identici al formato Python (+00:00, senza millisecondi).
import { prisma, settings } from "./db.js";
import {
  Invalid,
  checkDate,
  dateRome,
  email,
  instant,
  iso,
  labelRome,
  optional,
  required,
  tokenUrlSafe,
  todayRome,
  weekdayMonday0,
  zonedToUtc,
} from "./util.js";

export interface Slot {
  start: string;
  end: string;
  label: string;
}

interface Busy {
  start: string;
  end: string;
}

/** Client Prisma o transazione corrente: le query sono identiche. */
type Db = ReturnType<typeof prisma>;

function horizonIso(s: Record<string, any>, now: Date): string {
  const today = todayRome(now);
  const horizon = new Date(Date.UTC(today.y, today.m - 1, today.d + Number(s.booking_horizon)));
  return dateRome(horizon);
}

/** available() di app.py: slot del giorno nel fuso Europe/Rome. */
export async function available(day: string, db?: Db): Promise<Slot[]> {
  const conn = db ?? prisma();
  const s = await settings();
  const dayText = checkDate(day);
  const [y, m, d] = dayText.split("-").map(Number);
  const now = new Date();
  if (
    !s.booking_enabled ||
    !s.booking_days.includes(weekdayMonday0(y, m, d)) ||
    dayText > horizonIso(s, now)
  ) {
    return [];
  }
  const [confirmed, blocks] = await Promise.all([
    conn.appointment.findMany({ where: { status: "confirmed" }, select: { start: true, end: true } }),
    conn.block.findMany({ select: { start: true, end: true } }),
  ]);
  const busy: Busy[] = [...confirmed, ...blocks];

  const addMs = Number(s.booking_duration) * 60 * 1000;
  let cursor = zonedToUtc(y, m, d, Number(s.booking_start), 0);
  const limit = zonedToUtc(y, m, d, Number(s.booking_end), 0);
  const noticeCutoff = now.getTime() + Number(s.booking_notice) * 3600 * 1000;
  const slots: Slot[] = [];
  while (cursor.getTime() + addMs <= limit.getTime()) {
    const end = new Date(cursor.getTime() + addMs);
    const a = iso(cursor);
    const b = iso(end);
    if (
      cursor.getTime() >= noticeCutoff &&
      !busy.some((r) => a < r.end && b > r.start)
    ) {
      slots.push({ start: a, end: b, label: labelRome(cursor) });
    }
    cursor = end;
  }
  return slots;
}

/**
 * Conferma una prenotazione. L'advisory lock serializza le richieste
 * concorrenti sullo stesso slot (equivalente di BEGIN IMMEDIATE).
 */
export async function createAppointment(
  slug: string,
  data: Record<string, unknown>,
): Promise<{ start: string; end: string; cancel_token: string }> {
  const s = await settings();
  if (slug !== s.booking_slug) throw new Invalid("Pagina non trovata.");
  const start = instant(required(data, "start"));
  const day = dateRome(start);
  const token = tokenUrlSafe(32);
  const p = prisma();
  return p.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('crm_booking'))`;
    const slots = await available(day, tx as Db);
    const found = slots.find((slot) => slot.start === iso(start));
    if (!found) {
      throw new Invalid("Questo orario non è più disponibile. Scegline un altro.");
    }
    const created = await tx.appointment.create({
      data: {
        name: required(data, "name"),
        email: email(data),
        notes: optional(data, "notes"),
        start: found.start,
        end: found.end,
        cancel_token: token,
      },
    });
    // Proiezione nel calendario: l'appuntamento prenotato diventa evento
    // locale (da spingere ai provider collegati alla prima sincronizzazione).
    await tx.calendarEvent.create({
      data: {
        title: `Appuntamento: ${created.name}`,
        start: created.start,
        end: created.end,
        appointment_id: created.id,
        updated_at: BigInt(Date.now()),
        dirty: true,
      },
    });
    return { start: found.start, end: found.end, cancel_token: token };
  });
}
