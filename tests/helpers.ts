// Utilità condivise dalla suite: DB di test isolato, client HTTP con cookie,
// fixture riprese da tests/test_crm.py e helper XML/backup.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client as PgClient } from "pg";
import JSZip from "jszip";
import { DatabaseSync } from "node:sqlite";
import { XMLParser } from "fast-xml-parser";

// Puntare al database di test PRIMA di ogni uso di src/db.ts.
const envText = readFileSync(resolve(process.cwd(), ".env"), "utf8");
const testUrl = envText
  .split("\n")
  .find((line) => line.startsWith("DATABASE_URL_TEST="))
  ?.slice("DATABASE_URL_TEST=".length)
  .trim();
if (!testUrl) throw new Error("DATABASE_URL_TEST mancante in .env");
process.env.DATABASE_URL = testUrl;

export interface TestResponse {
  status: number;
  body: any;
  bytes: Buffer;
}

export interface TestClient {
  request(
    path: string,
    data?: unknown,
    opts?: { public?: boolean; headers?: Record<string, string> },
  ): Promise<TestResponse>;
  state(): Promise<any>;
  setup(password?: string): Promise<TestResponse>;
}

export async function resetDb(): Promise<void> {
  const pg = new PgClient({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  try {
    await pg.query(
      "TRUNCATE TABLE settings, sessions, clients, projects, quotes, invoices, documents, appointments, blocks, login_attempts, notes, calendar_events, event_links, sync_state, channels, conversations, messages, knowledge_docs RESTART IDENTITY CASCADE",
    );
  } finally {
    await pg.end();
  }
}

export function makeClient(base: string): TestClient {
  const cookies = new Map<string, string>();
  async function request(
    path: string,
    data?: unknown,
    opts: { public?: boolean; headers?: Record<string, string> } = {},
  ): Promise<TestResponse> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (data !== undefined) headers["Content-Type"] = "application/json";
    if (!opts.public && cookies.size > 0) {
      headers["Cookie"] = [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    }
    const res = await fetch(base + path, {
      method: data !== undefined ? "POST" : "GET",
      headers,
      body: data !== undefined ? JSON.stringify(data) : undefined,
    });
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const pair = line.split(";")[0];
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === "" || /max-age=0/i.test(line)) cookies.delete(name);
      else cookies.set(name, value);
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json")
      ? JSON.parse(bytes.toString("utf8"))
      : bytes;
    return { status: res.status, body, bytes };
  }
  return {
    request,
    async state() {
      const r = await request("/api/state");
      if (r.status !== 200) {
        throw new Error(`state ${r.status}: ${JSON.stringify(r.body)}`);
      }
      return r.body;
    },
    async setup(password = "Test-password-123!") {
      return request("/api/setup", { password });
    },
  };
}

/** Fixture di test_crm.project(): cliente + progetto. */
export async function createProject(c: TestClient): Promise<[number, number]> {
  const client = await c.request("/api/clients", {
    name: "Ada",
    email: "ada@example.test",
    company: "Studio Ada",
    address: "Via Test 1",
    vat_number: "IT123",
  });
  if (client.status !== 200) {
    throw new Error(`clients ${client.status}: ${JSON.stringify(client.body)}`);
  }
  const project = await c.request("/api/projects", {
    client_id: client.body.id,
    title: "Portale clienti",
  });
  if (project.status !== 200) {
    throw new Error(`projects ${project.status}: ${JSON.stringify(project.body)}`);
  }
  return [client.body.id, project.body.id];
}

/** Fixture di test_crm.configure_fiscal(). */
export async function configureFiscal(
  c: TestClient,
  cid: number,
  regime = "RF01",
): Promise<void> {
  const settings = await c.request("/api/settings", {
    business_name: "Studio test",
    address: "Via Test 1",
    city: "Roma",
    postcode: "00100",
    province: "RM",
    country: "IT",
    vat_number: "01234567897",
    tax_regime: regime,
    invoice_vat_rate: regime === "RF01" ? "22" : "0",
    invoice_nature: regime === "RF01" ? "" : "N2.2",
    invoice_reference:
      regime === "RF01"
        ? ""
        : "Operazione senza applicazione IVA - regime forfettario",
    payment_method: "MP01",
    vat_timing: "I",
    stamp_mode: "no",
    cassa_mode: "no",
    withholding_mode: "no",
  });
  if (settings.status !== 200) {
    throw new Error(`settings ${settings.status}: ${JSON.stringify(settings.body)}`);
  }
  const state = await c.state();
  const old = state.clients.find((x: any) => x.id === cid);
  const updated = await c.request("/api/clients", {
    ...old,
    country: "IT",
    city: "Roma",
    postcode: "00100",
    province: "RM",
    vat_number: "12345678903",
    tax_country: "IT",
    buyer_type: "business",
    recipient_code: "0000000",
  });
  if (updated.status !== 200) {
    throw new Error(`client update ${updated.status}: ${JSON.stringify(updated.body)}`);
  }
}

/** Fixture di test_crm.finalize_invoice(): fiscal-check + finalize. */
export async function finalizeInvoice(
  c: TestClient,
  id: number,
  overrides: Record<string, unknown> = {},
): Promise<{ cfg: any; checked: any; result: any }> {
  const context = await c.request(`/api/invoices/${id}/fiscal`);
  if (context.status !== 200) {
    throw new Error(`fiscal context ${context.status}: ${JSON.stringify(context.body)}`);
  }
  const cfg = { ...context.body.config, ...overrides };
  const checked = await c.request("/api/invoices/fiscal-check", { id, config: cfg });
  if (checked.status !== 200) {
    throw new Error(`fiscal-check ${checked.status}: ${JSON.stringify(checked.body)}`);
  }
  if (!checked.body.valid) {
    throw new Error(`fiscal-check invalido: ${JSON.stringify(checked.body)}`);
  }
  const result = await c.request("/api/invoices/finalize", {
    id,
    config: cfg,
    confirmed: true,
    review_hash: checked.body.review_hash,
  });
  if (result.status !== 200) {
    throw new Error(`finalize ${result.status}: ${JSON.stringify(result.body)}`);
  }
  return { cfg, checked: checked.body, result: result.body };
}

/** Equivalente di ET.fromstring(xml).findtext('.//Tag') (XPath primo discendente). */
const parser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
});

/** Query SQL grezza sul database di test (fixture che in Python usavano app.db()). */
export async function sql(query: string, params: unknown[] = []): Promise<any[]> {
  const pg = new PgClient({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  try {
    const result = await pg.query(query, params);
    return result.rows;
  } finally {
    await pg.end();
  }
}

/**
 * Equivalente di findtext('.//A/B/C'): il primo tag si cerca a qualunque
 * profondità, i successivi sono figli diretti.
 */
export function findPath(xml: Buffer | string, path: string[]): string | undefined {
  const root = parser.parse(xml.toString("utf8"));
  const findFirst = (node: any): any => {
    if (node === null || typeof node !== "object") return undefined;
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = findFirst(item);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    if (path[0] in node) return node[path[0]];
    for (const value of Object.values(node)) {
      const found = findFirst(value);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  let current = findFirst(root);
  for (let i = 1; i < path.length; i++) {
    if (current === null || typeof current !== "object") return undefined;
    if (Array.isArray(current)) current = current[0];
    current = current?.[path[i]];
  }
  if (typeof current === "string") return current;
  if (typeof current === "number") return String(current);
  if (current && typeof current === "object" && "#text" in current) {
    return String(current["#text"]);
  }
  return undefined;
}

export function findText(xml: Buffer | string, tag: string): string | undefined {
  const walk = (node: unknown): string | undefined => {
    if (node === null || typeof node !== "object") return undefined;
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = walk(item);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === tag) {
        if (typeof value === "string") return value;
        if (typeof value === "number") return String(value);
        if (value && typeof value === "object" && "#text" in (value as any)) {
          return String((value as any)["#text"]);
        }
      }
      const found = walk(value);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return walk(parser.parse(xml.toString("utf8")));
}

export async function extractBackup(
  archive: Buffer,
): Promise<{ sql: string; files: Record<string, Buffer> }> {
  const zip = await JSZip.loadAsync(archive);
  const files: Record<string, Buffer> = {};
  let sql = "";
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const data = Buffer.from(await entry.async("uint8array"));
    files[name] = data;
    if (name === "database.sql") sql = data.toString("utf8");
  }
  return { sql, files };
}

/** Esegue un dump SQLite (dialetto manage.restore) e lascia il DB aperto. */
export function loadSqliteDump(sql: string): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(sql);
  return db;
}

/** Data di domani a Roma (come datetime.now(app.TZ) + 1 giorno). */
export function tomorrowRome(): string {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Validità preventivo a 30 giorni (come date.today() + 30). */
export function in30Days(): string {
  const d = new Date(Date.now() + 30 * 86400_000);
  return d.toISOString().slice(0, 10);
}
