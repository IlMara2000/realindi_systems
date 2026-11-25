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
});
