// Migrazione dati: data/crm.sqlite3 (in sola lettura, mai modificato) → Postgres.
// Uso: DATABASE_URL=... npx tsx scripts/migrate-sqlite.ts [--force]
// Se il database di destinazione contiene già entità, serve --force (sostituisce).
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdirSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "../src/db.js";
import * as fiscal from "../src/fiscal.js";

const DATA = process.env.CRM_DATA_DIR ?? "data";
const SOURCE = join(DATA, "crm.sqlite3");
const DOCS_DIR = join(DATA, "documents");
const FORCE = process.argv.includes("--force");

const ENTITY_TABLES = [
  "clients",
  "projects",
  "quotes",
  "invoices",
  "documents",
  "appointments",
  "blocks",
] as const;

type Row = Record<string, any>;

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

async function targetCounts(): Promise<Record<string, number>> {
  const p = prisma();
  return {
    clients: await p.client.count(),
    projects: await p.project.count(),
    quotes: await p.quote.count(),
    invoices: await p.invoice.count(),
    documents: await p.document.count(),
    appointments: await p.appointment.count(),
    blocks: await p.block.count(),
  };
}

async function resetSequences(): Promise<void> {
  const p = prisma();
  for (const table of ENTITY_TABLES) {
    await p.$executeRawUnsafe(
      `SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1), true)`,
    );
  }
}

async function main(): Promise<void> {
  if (!existsSync(SOURCE)) fail(`Archivio non trovato: ${SOURCE}`);

  // 1. Copia su temp: l'originale resta intatto e non viene mai aperto in scrittura.
  const tmp = mkdtempSync(join(tmpdir(), "crm-migrate-"));
  const copy = join(tmp, "crm.sqlite3");
  copyFileSync(SOURCE, copy);

  const src = new DatabaseSync(copy, { readOnly: true });
  const read = (query: string): Row[] => src.prepare(query).all() as Row[];

  // 2. Guardia sul contenuto di destinazione.
  const counts = await targetCounts();
  const existing = Object.entries(counts).filter(([, n]) => n > 0);
  if (existing.length > 0 && !FORCE) {
    fail(
      `Il database di destinazione contiene già dati (${existing
        .map(([t, n]) => `${t}=${n}`)
        .join(", ")}). Usa --force per sostituirli.`,
    );
  }

  const p = prisma();
  if (FORCE) {
    await p.$transaction([
      p.document.deleteMany(),
      p.invoice.deleteMany(),
      p.quote.deleteMany(),
      p.project.deleteMany(),
      p.client.deleteMany(),
      p.appointment.deleteMany(),
      p.block.deleteMany(),
      p.session.deleteMany(),
      p.loginAttempt.deleteMany(),
      p.setting.deleteMany(),
    ]);
  }

  // 3. settings: sostituite integralmente (password e booking_slug = identità dell'istanza).
  const settings = read("SELECT key, value FROM settings");
  await p.setting.deleteMany({});
  if (settings.length) {
    await p.setting.createMany({
      data: settings.map((r) => ({ key: r.key, value: r.value })),
    });
  }

  // 4. clienti
  const clients = read("SELECT * FROM clients ORDER BY id");
  for (const r of clients) {
    await p.client.create({
      data: {
        id: r.id,
        name: r.name,
        email: r.email,
        company: r.company,
        phone: r.phone,
        vat_number: r.vat_number,
        address: r.address,
        notes: r.notes,
        created_at: r.created_at,
        ...fiscalClientFields(r),
      },
    });
  }

  // 5. progetti
  const projects = read("SELECT * FROM projects ORDER BY id");
  for (const r of projects) {
    await p.project.create({
      data: {
        id: r.id,
        client_id: r.client_id,
        title: r.title,
        description: r.description,
        status: r.status,
        deadline: r.deadline,
        created_at: r.created_at,
      },
    });
  }

  // 6. preventivi
  const quotes = read("SELECT * FROM quotes ORDER BY id");
  for (const r of quotes) {
    await p.quote.create({
      data: {
        id: r.id,
        project_id: r.project_id,
        title: r.title,
        items: r.items,
        subtotal: r.subtotal,
        vat: r.vat,
        total: r.total,
        vat_rate: r.vat_rate,
        status: r.status,
        valid_until: r.valid_until,
        notes: r.notes,
        created_at: r.created_at,
        estimate: r.estimate ?? null,
        generation_key: r.generation_key ?? null,
      },
    });
  }

  // 7. fatture (xml/xml_filename già emessi restano invariati)
  const invoices = read("SELECT * FROM invoices ORDER BY id");
  for (const r of invoices) {
    await p.invoice.create({
      data: {
        id: r.id,
        quote_id: r.quote_id ?? null,
        project_id: r.project_id,
        number: r.number ?? null,
        snapshot: r.snapshot,
        subtotal: r.subtotal,
        vat: r.vat,
        total: r.total,
        status: r.status,
        due_date: r.due_date,
        issued_at: r.issued_at ?? null,
        paid_at: r.paid_at ?? null,
        created_at: r.created_at,
        xml: r.xml ? Buffer.from(r.xml) : null,
        xml_filename: r.xml_filename ?? null,
      },
    });
  }

  // 8. documenti: contenuto da data/documents/<storage_name> → colonna bytes
  const documents = read("SELECT * FROM documents ORDER BY id");
  for (const r of documents) {
    const filePath = join(DOCS_DIR, r.storage_name);
    if (!existsSync(filePath)) {
      fail(`File documento mancante: ${filePath} (riferimento ${r.name})`);
    }
    const content = readFileSync(filePath);
    await p.document.create({
      data: {
        id: r.id,
        client_id: r.client_id,
        project_id: r.project_id ?? null,
        name: r.name,
        storage_name: r.storage_name,
        size: r.size,
        sha256: r.sha256,
        created_at: r.created_at,
        content: new Uint8Array(content),
      },
    });
  }

  // 9. appuntamenti e blocchi
  const appointments = read("SELECT * FROM appointments ORDER BY id");
  for (const r of appointments) {
    await p.appointment.create({
      data: {
        id: r.id,
        name: r.name,
        email: r.email,
        notes: r.notes,
        start: r.start,
        end: r.end,
        status: r.status,
        cancel_token: r.cancel_token,
        created_at: r.created_at,
      },
    });
  }
  const blocks = read("SELECT * FROM blocks ORDER BY id");
  for (const r of blocks) {
    await p.block.create({
      data: { id: r.id, start: r.start, end: r.end, reason: r.reason },
    });
  }

  src.close();

  // 10. sequence allineate + verifica dei conteggi
  await resetSequences();
  const after = await targetCounts();
  const sourceCounts: Record<string, number> = {};
  for (const table of ENTITY_TABLES) {
    sourceCounts[table] = (read2(copy, table) as number) ?? 0;
  }
  console.log("Tabella        SQLite  Postgres");
  let ok = true;
  for (const table of ENTITY_TABLES) {
    const a = sourceCounts[table];
    const b = after[table];
    const mark = a === b ? "✓" : "✗";
    if (a !== b) ok = false;
    console.log(`${mark} ${table.padEnd(14)} ${String(a).padStart(4)}  ${String(b).padStart(7)}`);
  }
  if (!ok) fail("Conteggi non coincidenti: verificare prima di procedere.");
  console.log(`✓ Migrazione completata (${settings.length} impostazioni incluse).`);
  rmSync(tmp, { recursive: true, force: true });
  if (!ok) process.exit(1);
}

/** Colonne additive dei clienti: solo fiscal.CLIENT_FIELDS (sono quelle dello schema). */
function fiscalClientFields(row: Row): Record<string, string> {
  const extra: Record<string, string> = {};
  for (const key of fiscal.CLIENT_FIELDS) {
    if (key in row) extra[key] = String(row[key] ?? "");
  }
  return extra;
}

function read2(copy: string, table: string): number {
  const db = new DatabaseSync(copy, { readOnly: true });
  try {
    const r = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as any;
    return Number(r.n);
  } finally {
    db.close();
  }
}

mkdirSync(DATA, { recursive: true });
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
