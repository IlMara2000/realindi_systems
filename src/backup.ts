// Esportazione archivio: porting di /api/backup da app.py.
// Il dump resta in dialetto SQLite con lo stesso DDL: manage.restore del vecchio
// CRM lo riesegue intatto (le righe di sessioni/login/password non esportate).
import JSZip from "jszip";
import { prisma } from "./db.js";

// Limite di risposta di Vercel: 4.5 MB. Restiamo sotto con un margine sicuro.
const MAX_ZIP_BYTES = 4.4 * 1024 * 1024;

const DDL = `CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, expires REAL NOT NULL);
CREATE TABLE IF NOT EXISTS clients(id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL,
  company TEXT NOT NULL, phone TEXT NOT NULL, vat_number TEXT NOT NULL, address TEXT NOT NULL,
  notes TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, country TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '', postcode TEXT NOT NULL DEFAULT '', province TEXT NOT NULL DEFAULT '',
  tax_country TEXT NOT NULL DEFAULT '', tax_code TEXT NOT NULL DEFAULT '',
  recipient_code TEXT NOT NULL DEFAULT '', pec TEXT NOT NULL DEFAULT '', buyer_type TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS projects(id INTEGER PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES clients(id),
  title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL, deadline TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS quotes(id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL, items TEXT NOT NULL, subtotal INTEGER NOT NULL, vat INTEGER NOT NULL,
  total INTEGER NOT NULL, vat_rate TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
  valid_until TEXT NOT NULL, notes TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  estimate TEXT, generation_key TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS quote_generation_key ON quotes(generation_key);
CREATE TABLE IF NOT EXISTS invoices(id INTEGER PRIMARY KEY, quote_id INTEGER UNIQUE REFERENCES quotes(id),
  project_id INTEGER NOT NULL REFERENCES projects(id), number TEXT UNIQUE, snapshot TEXT NOT NULL,
  subtotal INTEGER NOT NULL, vat INTEGER NOT NULL, total INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
  due_date TEXT NOT NULL, issued_at TEXT, paid_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  xml BLOB, xml_filename TEXT);
CREATE TABLE IF NOT EXISTS documents(id INTEGER PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES clients(id),
  project_id INTEGER REFERENCES projects(id), name TEXT NOT NULL, storage_name TEXT NOT NULL UNIQUE,
  size INTEGER NOT NULL, sha256 TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS appointments(id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL,
  notes TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'confirmed',
  cancel_token TEXT NOT NULL UNIQUE, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS blocks(id INTEGER PRIMARY KEY, start TEXT NOT NULL, end TEXT NOT NULL, reason TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS login_attempts(ip TEXT PRIMARY KEY, count INTEGER NOT NULL, reset REAL NOT NULL);`;

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return `X'${Buffer.from(value).toString("hex")}'`;
  }
  return sqlString(String(value));
}

function insert(table: string, columns: string[], row: Record<string, unknown>): string {
  const values = columns.map((c) => sqlValue(row[c])).join(",");
  return `INSERT INTO ${table}(${columns.join(",")}) VALUES(${values});`;
}

const CLIENT_COLUMNS = [
  "id", "name", "email", "company", "phone", "vat_number", "address", "notes", "created_at",
  "country", "city", "postcode", "province", "tax_country", "tax_code", "recipient_code", "pec", "buyer_type",
];
const PROJECT_COLUMNS = ["id", "client_id", "title", "description", "status", "deadline", "created_at"];
const QUOTE_COLUMNS = [
  "id", "project_id", "title", "items", "subtotal", "vat", "total", "vat_rate", "status",
  "valid_until", "notes", "created_at", "estimate", "generation_key",
];
const INVOICE_COLUMNS = [
  "id", "quote_id", "project_id", "number", "snapshot", "subtotal", "vat", "total", "status",
  "due_date", "issued_at", "paid_at", "created_at", "xml", "xml_filename",
];
const DOCUMENT_COLUMNS = ["id", "client_id", "project_id", "name", "storage_name", "size", "sha256", "created_at"];
const APPOINTMENT_COLUMNS = ["id", "name", "email", "notes", "start", "end", "status", "cancel_token", "created_at"];
const BLOCK_COLUMNS = ["id", "start", "end", "reason"];

export class BackupTooLarge extends Error {
  constructor() {
    super("Archivio troppo grande per un solo download: scarica i documenti singolarmente dall'elenco.");
    this.name = "BackupTooLarge";
  }
}

export async function buildBackup(): Promise<Buffer> {
  const p = prisma();
  const [settingsRows, clients, projects, quotes, invoices, documents, appointments, blocks] =
    await Promise.all([
      p.setting.findMany(),
      p.client.findMany({ orderBy: { id: "asc" } }),
      p.project.findMany({ orderBy: { id: "asc" } }),
      p.quote.findMany({ orderBy: { id: "asc" } }),
      p.invoice.findMany({ orderBy: { id: "asc" } }),
      p.document.findMany({ orderBy: { id: "asc" } }),
      p.appointment.findMany({ orderBy: { id: "asc" } }),
      p.block.findMany({ orderBy: { id: "asc" } }),
    ]);

  const lines: string[] = [DDL];
  for (const row of settingsRows) {
    if (row.key === "password") continue; // le credenziali non viaggiano nel backup
    lines.push(insert("settings", ["key", "value"], row));
  }
  for (const row of clients) lines.push(insert("clients", CLIENT_COLUMNS, row));
  for (const row of projects) lines.push(insert("projects", PROJECT_COLUMNS, row));
  for (const row of quotes) lines.push(insert("quotes", QUOTE_COLUMNS, row));
  for (const row of invoices) lines.push(insert("invoices", INVOICE_COLUMNS, row));
  for (const row of documents) lines.push(insert("documents", DOCUMENT_COLUMNS, row)); // senza content
  for (const row of appointments) lines.push(insert("appointments", APPOINTMENT_COLUMNS, row));
  for (const row of blocks) lines.push(insert("blocks", BLOCK_COLUMNS, row));

  const zip = new JSZip();
  zip.file("database.sql", lines.join("\n") + "\n");
  for (const doc of documents) {
    zip.file(`documents/${doc.storage_name}`, Buffer.from(doc.content));
  }
  zip.file(
    "LEGGIMI.txt",
    "Esportazione CRM. Ripristino: python3 manage.py restore archivio.zip --destination cartella-vuota\n" +
      "Al primo avvio scegli una nuova password.\n",
  );
  const out = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  if (out.length > MAX_ZIP_BYTES) throw new BackupTooLarge();
  return out;
}
