// Sezione Note: validazione e CRUD su notes (spec 2026-11-03).
import { prisma } from "./db.js";
import { Invalid } from "./util.js";

export interface NoteFields {
  title: string;
  body: string;
  pinned: boolean;
  client_id: number | null;
  project_id: number | null;
}

/** Timestamp UTC nello stesso formato di created_at (SQLite compatibile). */
export function utcStamp(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

function intOrNull(v: unknown, label: string): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
    throw new Invalid(`Riferimento al ${label} non valido.`);
  }
  return v;
}

export function intId(v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
    throw new Invalid("Identificativo non valido.");
  }
  return v;
}

export function validateNoteFields(d: Record<string, unknown>): NoteFields {
  const title = typeof d.title === "string" ? d.title.trim() : "";
  if (!title || title.length > 200) {
    throw new Invalid("Titolo della nota non valido (1-200 caratteri).");
  }
  const body = typeof d.body === "string" ? d.body : "";
  if (body.length > 20000) {
    throw new Invalid("Testo della nota troppo lungo (max 20000 caratteri).");
  }
  return {
    title,
    body,
    pinned: d.pinned === true,
    client_id: intOrNull(d.client_id, "cliente"),
    project_id: intOrNull(d.project_id, "progetto"),
  };
}

/** I riferimenti a cliente/progetto, se presenti, devono esistere. */
export async function ensureReferencesExist(fields: NoteFields): Promise<void> {
  const p = prisma();
  if (fields.client_id !== null) {
    const n = await p.client.count({ where: { id: fields.client_id } });
    if (n === 0) throw new Invalid("Cliente non trovato.");
  }
  if (fields.project_id !== null) {
    const n = await p.project.count({ where: { id: fields.project_id } });
    if (n === 0) throw new Invalid("Progetto non trovato.");
  }
}

export async function listNotes(): Promise<
  Array<{
    id: number;
    title: string;
    body: string;
    pinned: boolean;
    client_id: number | null;
    project_id: number | null;
    created_at: string;
    updated_at: string;
  }>
> {
  return prisma().note.findMany({ orderBy: [{ pinned: "desc" }, { updated_at: "desc" }] });
}
