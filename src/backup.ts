// Esportazione archivio: porting di /api/backup da app.py.
// Il dump resta in dialetto SQLite con lo stesso DDL: manage.restore del vecchio
// CRM lo riesegue intatto (le righe di sessioni/login/password non esportate).
import JSZip from "jszip";
import { CHIAVI_CREDENZIALI, prisma } from "./db.js";

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
CREATE TABLE IF NOT EXISTS login_attempts(ip TEXT PRIMARY KEY, count INTEGER NOT NULL, reset REAL NOT NULL);
CREATE TABLE IF NOT EXISTS contacts(id INTEGER PRIMARY KEY, client_id INTEGER,
  display_name TEXT NOT NULL DEFAULT '', given_name TEXT NOT NULL DEFAULT '',
  family_name TEXT NOT NULL DEFAULT '', org TEXT NOT NULL DEFAULT '',
  job_title TEXT NOT NULL DEFAULT '', emails TEXT NOT NULL DEFAULT '[]',
  phones TEXT NOT NULL DEFAULT '[]', notes TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL, deleted_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS notes(id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0, client_id INTEGER, project_id INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS receipts(id INTEGER PRIMARY KEY, year INTEGER NOT NULL, number INTEGER NOT NULL,
  issued_on TEXT NOT NULL, place TEXT NOT NULL DEFAULT '', payer TEXT NOT NULL, tax_code TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL, amount_words TEXT NOT NULL, reason TEXT NOT NULL,
  issuer TEXT NOT NULL DEFAULT '', cancelled_at TEXT, cancel_reason TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(year, number));
CREATE TABLE IF NOT EXISTS calendar_events(id INTEGER PRIMARY KEY, title TEXT NOT NULL, start TEXT NOT NULL,
  end TEXT NOT NULL, all_day INTEGER NOT NULL DEFAULT 0, description TEXT, location TEXT,
  updated_at INTEGER NOT NULL, dirty INTEGER NOT NULL DEFAULT 1, deleted_at TEXT, appointment_id INTEGER);
CREATE TABLE IF NOT EXISTS event_links(id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL, source TEXT NOT NULL,
  calendar_id TEXT NOT NULL DEFAULT 'primary', external_id TEXT NOT NULL, etag TEXT,
  dirty INTEGER NOT NULL DEFAULT 1, deleted_at TEXT, UNIQUE(source, calendar_id, external_id));
CREATE TABLE IF NOT EXISTS short_links(id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, target TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '', clicks INTEGER NOT NULL DEFAULT 0, unique_visits INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS link_visits(id INTEGER PRIMARY KEY, link_id INTEGER NOT NULL REFERENCES short_links(id),
  fingerprint TEXT NOT NULL, at INTEGER NOT NULL, UNIQUE(link_id, fingerprint));
CREATE TABLE IF NOT EXISTS qr_codes(id INTEGER PRIMARY KEY, title TEXT NOT NULL, payload TEXT NOT NULL,
  foreground TEXT NOT NULL DEFAULT '#111111', background TEXT NOT NULL DEFAULT '#ffffff', ecc TEXT NOT NULL DEFAULT 'H',
  link_id INTEGER REFERENCES short_links(id), logo_mime TEXT, logo BLOB, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS channels(id INTEGER PRIMARY KEY, provider TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
  external_id TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'connected',
  last_error TEXT NOT NULL DEFAULT '', auto_reply INTEGER NOT NULL DEFAULT 1, credentials TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS conversations(id INTEGER PRIMARY KEY, channel_id INTEGER NOT NULL REFERENCES channels(id),
  contact TEXT NOT NULL, contact_name TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open',
  unread INTEGER NOT NULL DEFAULT 0, auto_reply INTEGER NOT NULL DEFAULT 1, last_message_at TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(channel_id, contact));
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  direction TEXT NOT NULL, author TEXT NOT NULL, body TEXT NOT NULL, external_id TEXT, status TEXT NOT NULL DEFAULT 'sent',
  error TEXT NOT NULL DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP, media_type TEXT,
  media_storage_name TEXT, media_url TEXT, UNIQUE(conversation_id, external_id));
CREATE TABLE IF NOT EXISTS message_attachments(id INTEGER PRIMARY KEY, message_id INTEGER NOT NULL REFERENCES messages(id),
  conversation_id INTEGER NOT NULL REFERENCES conversations(id), filename TEXT NOT NULL, mime_type TEXT NOT NULL,
  size INTEGER NOT NULL, sha256 TEXT NOT NULL, storage_name TEXT NOT NULL UNIQUE, content BLOB NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);`;

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  // updated_at dei contatti è un BIGINT: va scritto come numero, non fra apici.
  if (typeof value === "bigint") return value.toString();
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
const CONTACT_COLUMNS = [
  "id", "client_id", "display_name", "given_name", "family_name", "org", "job_title",
  "emails", "phones", "notes", "updated_at", "deleted_at", "created_at",
];
const NOTE_COLUMNS = ["id", "title", "body", "pinned", "client_id", "project_id", "created_at", "updated_at"];
const RECEIPT_COLUMNS = [
  "id", "year", "number", "issued_on", "place", "payer", "tax_code", "amount_cents", "amount_words",
  "reason", "issuer", "cancelled_at", "cancel_reason", "created_at",
];
const CALENDAR_EVENT_COLUMNS = [
  "id", "title", "start", "end", "all_day", "description", "location", "updated_at", "dirty",
  "deleted_at", "appointment_id",
];
const EVENT_LINK_COLUMNS = ["id", "event_id", "source", "calendar_id", "external_id", "etag", "dirty", "deleted_at"];
const SHORT_LINK_COLUMNS = ["id", "slug", "target", "label", "clicks", "unique_visits", "active", "created_at"];
const LINK_VISIT_COLUMNS = ["id", "link_id", "fingerprint", "at"];
const QR_CODE_COLUMNS = [
  "id", "title", "payload", "foreground", "background", "ecc", "link_id", "logo_mime", "logo", "created_at",
];
const CHANNEL_COLUMNS = [
  "id", "provider", "label", "external_id", "detail", "status", "last_error", "auto_reply", "credentials",
  "created_at", "updated_at",
];
const CONVERSATION_COLUMNS = [
  "id", "channel_id", "contact", "contact_name", "status", "unread", "auto_reply", "last_message_at", "created_at",
];
const MESSAGE_COLUMNS = [
  "id", "conversation_id", "direction", "author", "body", "external_id", "status", "error", "created_at",
  "media_type", "media_storage_name", "media_url",
];
const MESSAGE_ATTACHMENT_COLUMNS = [
  "id", "message_id", "conversation_id", "filename", "mime_type", "size", "sha256", "storage_name", "content",
  "created_at",
];

export class BackupTooLarge extends Error {
  constructor() {
    super("Archivio troppo grande per un solo download: scarica i documenti singolarmente dall'elenco.");
    this.name = "BackupTooLarge";
  }
}

export async function buildBackup(): Promise<Buffer> {
  const p = prisma();
  const [
    settingsRows, clients, projects, quotes, invoices, documents, appointments, blocks, contacts,
    notes, receipts, calendarEvents, eventLinks, shortLinks, linkVisits, qrCodes,
    channels, conversations, messages, messageAttachments,
  ] =
    await Promise.all([
      p.setting.findMany(),
      p.client.findMany({ orderBy: { id: "asc" } }),
      p.project.findMany({ orderBy: { id: "asc" } }),
      p.quote.findMany({ orderBy: { id: "asc" } }),
      p.invoice.findMany({ orderBy: { id: "asc" } }),
      p.document.findMany({ orderBy: { id: "asc" } }),
      p.appointment.findMany({ orderBy: { id: "asc" } }),
      p.block.findMany({ orderBy: { id: "asc" } }),
      // Tutta la rubrica, comprese le schede cancellate dalla sincronizzazione:
      // l'archivio è una copia fedele, non la vista dell'app.
      p.contact.findMany({ orderBy: { id: "asc" } }),
      p.note.findMany({ orderBy: { id: "asc" } }),
      p.receipt.findMany({ orderBy: { id: "asc" } }),
      // Il calendario locale viaggia intero: anche gli eventi cancellati, perché
      // la cancellazione è un fatto da riportare al provider dopo il ripristino.
      p.calendarEvent.findMany({ orderBy: { id: "asc" } }),
      p.eventLink.findMany({ orderBy: { id: "asc" } }),
      p.shortLink.findMany({ orderBy: { id: "asc" } }),
      p.linkVisit.findMany({ orderBy: { id: "asc" } }),
      p.qrCode.findMany({ orderBy: { id: "asc" } }),
      p.channel.findMany({ orderBy: { id: "asc" } }),
      p.conversation.findMany({ orderBy: { id: "asc" } }),
      p.message.findMany({ orderBy: { id: "asc" } }),
      p.messageAttachment.findMany({ orderBy: { id: "asc" } }),
    ]);

  const lines: string[] = [DDL];
  for (const row of settingsRows) {
    if (CHIAVI_CREDENZIALI.has(row.key)) continue; // le credenziali non viaggiano nel backup
    lines.push(insert("settings", ["key", "value"], row));
  }
  for (const row of clients) lines.push(insert("clients", CLIENT_COLUMNS, row));
  for (const row of projects) lines.push(insert("projects", PROJECT_COLUMNS, row));
  for (const row of quotes) lines.push(insert("quotes", QUOTE_COLUMNS, row));
  for (const row of invoices) lines.push(insert("invoices", INVOICE_COLUMNS, row));
  for (const row of documents) lines.push(insert("documents", DOCUMENT_COLUMNS, row)); // senza content
  for (const row of appointments) lines.push(insert("appointments", APPOINTMENT_COLUMNS, row));
  for (const row of blocks) lines.push(insert("blocks", BLOCK_COLUMNS, row));
  for (const row of contacts) lines.push(insert("contacts", CONTACT_COLUMNS, row));
  for (const row of notes) lines.push(insert("notes", NOTE_COLUMNS, row));
  for (const row of receipts) lines.push(insert("receipts", RECEIPT_COLUMNS, row));
  for (const row of calendarEvents) lines.push(insert("calendar_events", CALENDAR_EVENT_COLUMNS, row));
  for (const row of eventLinks) lines.push(insert("event_links", EVENT_LINK_COLUMNS, row));
  for (const row of shortLinks) lines.push(insert("short_links", SHORT_LINK_COLUMNS, row));
  for (const row of linkVisits) lines.push(insert("link_visits", LINK_VISIT_COLUMNS, row));
  for (const row of qrCodes) lines.push(insert("qr_codes", QR_CODE_COLUMNS, row));
  // Le credenziali dei canali sono cifrate con INTEGRATIONS_KEY, che non
  // viaggia nel backup: esportarle darebbe solo blob illeggibili in giro.
  for (const row of channels) lines.push(insert("channels", CHANNEL_COLUMNS, { ...row, credentials: "" }));
  for (const row of conversations) lines.push(insert("conversations", CONVERSATION_COLUMNS, row));
  for (const row of messages) lines.push(insert("messages", MESSAGE_COLUMNS, row));
  // I media delle conversazioni stanno nel dump come i XML delle fatture:
  // così il ripristino legacy non deve sapere nulla di cartelle nuove.
  for (const row of messageAttachments) lines.push(insert("message_attachments", MESSAGE_ATTACHMENT_COLUMNS, row));

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
