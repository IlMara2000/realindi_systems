// Backup: i contatti devono viaggiare nell'archivio e tornare su con il
// ripristino legacy (`python3 manage.py restore`), che è il percorso vero usato
// per ricostruire un'istanza. La prova passa dal comando Python, non solo dal
// dump: è quello che non deve rompersi.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../scripts/dev-server.js";
import { extractBackup, makeClient, resetDb, sql, type TestClient } from "./helpers.js";

let server: RunningServer;
let base: string;

beforeAll(async () => {
  server = await startServer(0);
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
});

beforeEach(async () => {
  await resetDb();
});

async function fresh(): Promise<TestClient> {
  const c = makeClient(base);
  const r = await c.setup();
  if (r.status !== 200) throw new Error(`setup ${r.status}`);
  return c;
}

describe("backup con i contatti", () => {
  it("esporta la rubrica e il ripristino legacy la ricostruisce", async () => {
    const c = await fresh();
    const cliente = await c.request("/api/clients", {
      name: "Ada Rossi",
      email: "ada@example.test",
      company: "Studio Rossi",
    });
    expect(cliente.status).toBe(200);
    const cid = cliente.body.id;

    // Una scheda viva legata al cliente e una cancellata dalla sincronizzazione:
    // l'archivio è una copia fedele, quindi ci vanno entrambe. L'email resta
    // com'è nel database: il backup non è il posto dove normalizzarla.
    await sql(
      "INSERT INTO contacts (client_id, display_name, given_name, family_name, org, job_title, emails, phones, notes, updated_at, deleted_at) " +
        "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
      [
        cid,
        "Mario Rossi",
        "Mario",
        "Rossi",
        "Studio Rossi",
        "Titolare",
        '["Mario@Example.com"]',
        '["+39 333 123 4567"]',
        "Nota privata",
        1_764_000_000_000,
        null,
      ],
    );
    await sql(
      "INSERT INTO contacts (display_name, emails, phones, updated_at, deleted_at) VALUES ($1, $2, $3, $4, $5)",
      ["Vecchio Contatto", "[]", "[]", 1_764_000_000_001, "2026-11-01 10:00:00"],
    );

    const backup = await c.request("/api/backup");
    expect(backup.status).toBe(200);
    const { sql: dump } = await extractBackup(backup.bytes);
    expect(dump).toContain("CREATE TABLE IF NOT EXISTS contacts(");
    expect(dump).toContain("INSERT INTO contacts(");

    const dir = mkdtempSync(join(tmpdir(), "realindi-backup-contatti-"));
    try {
      const archive = join(dir, "archivio.zip");
      writeFileSync(archive, backup.bytes);
      const destinazione = join(dir, "ripristino");

      // Il ripristino legacy: se il dump gli va bene, non solleva.
      const esito = execFileSync(
        "python3",
        ["manage.py", "restore", archive, "--destination", destinazione],
        { encoding: "utf8" },
      );
      expect(esito).toContain("Backup ripristinato");

      const db = new DatabaseSync(join(destinazione, "crm.sqlite3"));
      try {
        const contatti = db
          .prepare("SELECT display_name, client_id, emails, phones, updated_at, deleted_at FROM contacts ORDER BY id")
          .all() as any[];
        expect(contatti).toHaveLength(2);
        expect(contatti[0].display_name).toBe("Mario Rossi");
        expect(contatti[0].client_id).toBe(cid);
        expect(JSON.parse(contatti[0].emails)).toEqual(["Mario@Example.com"]);
        expect(JSON.parse(contatti[0].phones)).toEqual(["+39 333 123 4567"]);
        expect(Number(contatti[0].updated_at)).toBe(1_764_000_000_000);
        expect(contatti[1].deleted_at).toBe("2026-11-01 10:00:00");

        // Le tabelle di prima restano ripristinate e le credenziali restano fuori.
        expect((db.prepare("SELECT COUNT(*) AS n FROM clients").get() as any).n).toBe(1);
        expect(db.prepare("SELECT value FROM settings WHERE key='password'").get()).toBeUndefined();
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("esporta note, ricevute, calendario, link brevi/QR e conversazioni", async () => {
    const c = await fresh();
    const cliente = await c.request("/api/clients", { name: "Studio Verdi", email: "verdi@example.test" });
    expect(cliente.status).toBe(200);
    const cid = cliente.body.id;
    const logo = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const allegato = Buffer.from("foto-riservata\u0000\u00ff", "latin1");

    await sql("INSERT INTO notes (title, body, pinned, client_id) VALUES ($1, $2, $3, $4)", [
      "Rinnovo",
      "Chiamare lunedì",
      true,
      cid,
    ]);
    await sql(
      "INSERT INTO receipts (year, number, issued_on, payer, amount_cents, amount_words, reason, cancelled_at, cancel_reason) " +
        "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [2026, 7, "2026-11-20", "Mario Rossi", 50_000, "cinquecento euro", "Acconto sito", "2026-11-21 09:00:00", "Errore importo"],
    );
    await sql(
      'INSERT INTO calendar_events (title, start, "end", all_day, description, location, updated_at, dirty, deleted_at) ' +
        "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      ["Riunione", "2026-11-26T10:00:00Z", "2026-11-26T11:00:00Z", false, "Portale", "Roma", 1_764_000_000_000, true, null],
    );
    await sql(
      "INSERT INTO event_links (event_id, source, calendar_id, external_id, etag, dirty, deleted_at) " +
        "VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [1, "google", "primary", "evt-1", '"etag-1"', false, null],
    );
    await sql(
      "INSERT INTO short_links (slug, target, label, clicks, unique_visits, active) VALUES ($1, $2, $3, $4, $5, $6)",
      ["preventivo", "https://realindi.example/preventivo", "Preventivo", 12, 9, true],
    );
    await sql("INSERT INTO link_visits (link_id, fingerprint, at) VALUES ($1, $2, $3)", [1, "fp-abc", 1_764_000_000_000]);
    await sql(
      "INSERT INTO qr_codes (title, payload, foreground, background, ecc, link_id, logo_mime, logo) " +
        "VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      ["QR biglietto", "https://realindi.example/preventivo", "#111111", "#ffffff", "H", 1, "image/png", logo],
    );
    await sql(
      "INSERT INTO channels (provider, label, external_id, detail, status, last_error, auto_reply, credentials) " +
        "VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      ["whatsapp", "WhatsApp studio", "1234567890", "+39 070 000000", "connected", "", true, "enc:segreto-cifrato"],
    );
    await sql(
      "INSERT INTO conversations (channel_id, contact, contact_name, status, unread, auto_reply, last_message_at) " +
        "VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [1, "+393331234567", "Mario Rossi", "open", 2, true, "2026-11-24 18:00:00"],
    );
    await sql(
      "INSERT INTO messages (conversation_id, direction, author, body, external_id, status, error, media_type, media_storage_name, media_url) " +
        "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
      [1, "in", "cliente", "Ecco la foto", "wamid.1", "read", "", "image/jpeg", "att-1", ""],
    );
    await sql(
      "INSERT INTO message_attachments (message_id, conversation_id, filename, mime_type, size, sha256, storage_name, content) " +
        "VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [1, 1, "foto.jpg", "image/jpeg", allegato.length, "a".repeat(64), "att-1", allegato],
    );

    const backup = await c.request("/api/backup");
    expect(backup.status).toBe(200);
    const { sql: dump } = await extractBackup(backup.bytes);
    // Le credenziali cifrate dei canali non escono: senza INTEGRATIONS_KEY
    // sarebbero solo blob inutili, e comunque sono segreti.
    expect(dump).not.toContain("enc:segreto-cifrato");

    const dir = mkdtempSync(join(tmpdir(), "realindi-backup-tabelle-"));
    try {
      const archive = join(dir, "archivio.zip");
      writeFileSync(archive, backup.bytes);
      const destinazione = join(dir, "ripristino");
      const esito = execFileSync(
        "python3",
        ["manage.py", "restore", archive, "--destination", destinazione],
        { encoding: "utf8" },
      );
      expect(esito).toContain("Backup ripristinato");

      const db = new DatabaseSync(join(destinazione, "crm.sqlite3"));
      try {
        const nota = db.prepare("SELECT title, body, pinned, client_id FROM notes").get() as any;
        expect(nota).toMatchObject({ title: "Rinnovo", body: "Chiamare lunedì", pinned: 1, client_id: cid });

        const ricevuta = db.prepare("SELECT year, number, payer, amount_cents, cancelled_at FROM receipts").get() as any;
        expect(ricevuta).toMatchObject({ year: 2026, number: 7, payer: "Mario Rossi", amount_cents: 50_000 });
        expect(ricevuta.cancelled_at).toBe("2026-11-21 09:00:00");

        const evento = db.prepare("SELECT title, all_day, updated_at, dirty, description FROM calendar_events").get() as any;
        expect(evento.title).toBe("Riunione");
        expect(evento.all_day).toBe(0);
        expect(Number(evento.updated_at)).toBe(1_764_000_000_000);
        expect(evento.dirty).toBe(1);
        expect((db.prepare("SELECT source, external_id, etag FROM event_links").get() as any)).toMatchObject({
          source: "google",
          external_id: "evt-1",
          etag: '"etag-1"',
        });

        expect(db.prepare("SELECT slug, clicks, unique_visits, active FROM short_links").get() as any).toMatchObject({
          slug: "preventivo",
          clicks: 12,
          unique_visits: 9,
          active: 1,
        });
        expect(db.prepare("SELECT fingerprint FROM link_visits").get() as any).toMatchObject({ fingerprint: "fp-abc" });

        const qr = db.prepare("SELECT title, link_id, logo_mime, logo FROM qr_codes").get() as any;
        expect(qr.title).toBe("QR biglietto");
        expect(qr.link_id).toBe(1);
        expect(qr.logo_mime).toBe("image/png");
        expect(Buffer.from(qr.logo).toString("hex")).toBe(logo.toString("hex"));

        const canale = db.prepare("SELECT provider, external_id, auto_reply, credentials FROM channels").get() as any;
        expect(canale).toMatchObject({ provider: "whatsapp", external_id: "1234567890", auto_reply: 1 });
        expect(canale.credentials).toBe("");

        expect(db.prepare("SELECT contact, unread FROM conversations").get() as any).toMatchObject({
          contact: "+393331234567",
          unread: 2,
        });
        expect(db.prepare("SELECT body, external_id, status FROM messages").get() as any).toMatchObject({
          body: "Ecco la foto",
          external_id: "wamid.1",
          status: "read",
        });

        const file = db.prepare("SELECT filename, mime_type, size, content FROM message_attachments").get() as any;
        expect(file.filename).toBe("foto.jpg");
        expect(file.size).toBe(allegato.length);
        expect(Buffer.from(file.content).toString("hex")).toBe(allegato.toString("hex"));
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
