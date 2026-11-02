// Porting di tests/test_fiscal.py: stessi casi, stessi asserzioni, stessi messaggi.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { startServer, type RunningServer } from "../scripts/dev-server.js";
import { validateXml, fileProgressive, FiscalError } from "../src/fiscal.js";
import {
  makeClient,
  resetDb,
  createProject,
  configureFiscal,
  finalizeInvoice,
  extractBackup,
  loadSqliteDump,
  findText,
  findPath,
  sql,
  in30Days,
  type TestClient,
} from "./helpers.js";

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
  if (r.status !== 200) throw new Error(`setup ${r.status}: ${JSON.stringify(r.body)}`);
  return c;
}

/** Fixture di FiscalFlowTest.draft(): preventivo accettato → fattura in bozza. */
async function draft(c: TestClient): Promise<[number, number]> {
  const [cid, pid] = await createProject(c);
  const quote = await c.request("/api/quotes", {
    project_id: pid, title: "Consulenza", valid_until: in30Days(),
    vat_rate: "22",
    items: [{ description: "Analisi & sviluppo", hours: "10", rate: "100" }],
  });
  if (quote.status !== 200) throw new Error(`quote ${quote.status}: ${JSON.stringify(quote.body)}`);
  const accepted = await c.request("/api/quotes/status", { id: quote.body.id, status: "accepted" });
  if (accepted.status !== 200) throw new Error(`accept ${accepted.status}`);
  const invoice = (await c.state()).invoices[0];
  return [cid, invoice.id];
}

describe("Fisco", () => {
  it("profilo vuoto e revisione obbligatoria", async () => {
    const c = await fresh();
    const [cid, iid] = await draft(c);

    let context = (await c.request(`/api/invoices/${iid}/fiscal`)).body;
    expect(context.business.tax_regime).toBe("");
    expect(context.business.vat_number).toBe("");
    expect(context.business.ateco).toBe("");
    expect(context.profile_errors.length).toBeGreaterThan(0);
    let check = (await c.request("/api/invoices/fiscal-check", { id: iid, config: context.config })).body;
    expect(check.valid).toBe(false);
    expect((await c.state()).invoices[0].number).toBeNull();

    await configureFiscal(c, cid);
    context = (await c.request(`/api/invoices/${iid}/fiscal`)).body;
    check = (await c.request("/api/invoices/fiscal-check", { id: iid, config: context.config })).body;
    expect(check.valid, JSON.stringify(check)).toBe(true);
    const payload = { id: iid, config: context.config, review_hash: check.review_hash };
    expect((await c.request("/api/invoices/finalize", payload)).status).toBe(400);

    // Un'altra tabella cambia la ditta emittente dopo la revisione.
    await c.request("/api/settings", { business_name: "Studio cambiato" });
    expect((await c.request("/api/invoices/finalize", { ...payload, confirmed: true })).status).toBe(400);
    expect((await c.state()).invoices[0].number).toBeNull();

    const { result } = await finalizeInvoice(c, iid);
    const xmlResponse = await c.request(`/api/invoices/${iid}/xml`);
    expect(xmlResponse.status).toBe(200);
    await expect(validateXml(xmlResponse.bytes)).resolves.toBeUndefined();
    expect(xmlResponse.bytes.includes(Buffer.from("Studio cambiato"))).toBe(true);
    expect(xmlResponse.bytes.includes(Buffer.from("Studio test"))).toBe(false);
    expect((await c.request(`/api/invoices/${iid}/xml`, undefined, { public: true })).status).toBe(401);

    const replay = await c.request("/api/invoices/finalize", { ...payload, confirmed: true });
    expect(replay.body).toEqual(result);

    const original = createHash("sha256").update(xmlResponse.bytes).digest("hex");
    await c.request("/api/settings", {
      business_name: "Nuovo nome", vat_number: "12345678903", tax_regime: "RF19",
    });
    const again = await c.request(`/api/invoices/${iid}/xml`);
    expect(createHash("sha256").update(again.bytes).digest("hex")).toBe(original);
  });

  it("cassa, ritenuta e pagamento", async () => {
    const c = await fresh();
    const [cid, iid] = await draft(c);
    await configureFiscal(c, cid);
    const { checked } = await finalizeInvoice(c, iid, {
      cassa_mode: "yes", cassa_type: "TC22", cassa_rate: "4",
      cassa_base_percent: "100", cassa_vat_rate: "22", cassa_nature: "",
      cassa_reference: "", cassa_withholding: "yes",
      withholding_mode: "yes", withholding_type: "RT01",
      withholding_rate: "20", withholding_base_percent: "100", withholding_reason: "A",
    });
    const r = checked.report;
    expect([r.subtotal, r.contribution, r.vat, r.withholding, r.total, r.payable])
      .toEqual([100000, 4000, 22880, 20800, 126880, 106080]);

    const xml = (await c.request(`/api/invoices/${iid}/xml`)).bytes;
    await validateXml(xml);
    expect(findText(xml, "ImportoPagamento")).toBe("1060.80");
    expect(findText(xml, "RegimeFiscale")).toBe("RF01");
    expect(findText(xml, "ImportoContributoCassa")).toBe("40.00");
    expect(findText(xml, "Descrizione")).toBe("Analisi & sviluppo");

    expect((await c.request("/api/invoices/status", { id: iid, status: "paid" })).status).toBe(200);
    expect((await c.state()).invoices[0].snapshot.fiscal.report.payable).toBe(106080);
  });

  it("forfettario, bollo e IVA non valida", async () => {
    const c = await fresh();
    const [cid, iid] = await draft(c);
    await configureFiscal(c, cid, "RF19");
    const ctx = (await c.request(`/api/invoices/${iid}/fiscal`)).body;
    const bad = { ...ctx.config, taxes: [{ vat_rate: "22", nature: "", reference: "" }] };
    const badCheck = (await c.request("/api/invoices/fiscal-check", { id: iid, config: bad })).body;
    expect(badCheck.valid).toBe(false);

    const { checked } = await finalizeInvoice(c, iid, { stamp_mode: "yes", stamp_amount: "2" });
    expect(checked.report.stamp).toBe(200);
    expect(checked.report.payable).toBe(100000); // bollo a carico dell'emittente

    const xml = (await c.request(`/api/invoices/${iid}/xml`)).bytes;
    await validateXml(xml);
    expect(findText(xml, "RegimeFiscale")).toBe("RF19");
    expect(findText(xml, "BolloVirtuale")).toBe("SI");
    expect(findText(xml, "Natura")).toBe("N2.2");
    expect(findText(xml, "Imposta")).toBe("0.00");
  });

  it("destinatario estero e XML nel backup", async () => {
    const c = await fresh();
    const [cid, iid] = await draft(c);
    await configureFiscal(c, cid);
    const old = (await c.state()).clients.find((x: any) => x.id === cid);
    const updated = await c.request("/api/clients", {
      ...old, country: "FR", tax_country: "FR", vat_number: "FR12345678901",
      postcode: "00000", province: "", city: "Paris", recipient_code: "",
    });
    expect(updated.status).toBe(200);
    await finalizeInvoice(c, iid, {
      taxes: [{ vat_rate: "0", nature: "N2.1", reference: "Art. 7-ter DPR 633/1972" }],
    });
    const xml = (await c.request(`/api/invoices/${iid}/xml`)).bytes;
    await validateXml(xml);
    expect(findText(xml, "CodiceDestinatario")).toBe("XXXXXXX");

    const backup = await c.request("/api/backup");
    expect(backup.status).toBe(200);
    const { sql: dump } = await extractBackup(backup.bytes);
    const db = loadSqliteDump(dump);
    const restored = db.prepare("SELECT xml FROM invoices WHERE id = ?").get(iid) as any;
    db.close();
    expect(Buffer.compare(Buffer.from(restored.xml), xml)).toBe(0);
  });

  it("numerazione file e cliente privato", async () => {
    expect(fileProgressive(1)).toBe("00001");
    expect(fileProgressive(100000)).toHaveLength(5);
    expect(fileProgressive(100000)).not.toBe(fileProgressive(100001));
    expect(() => fileProgressive(36 ** 5)).toThrow(FiscalError);

    const c = await fresh();
    const [cid, iid] = await draft(c);
    await configureFiscal(c, cid);
    const old = (await c.state()).clients.find((x: any) => x.id === cid);
    expect((await c.request("/api/clients", {
      ...old, buyer_type: "private", vat_number: "", tax_country: "", tax_code: "",
    })).status).toBe(200);

    const ctx = (await c.request(`/api/invoices/${iid}/fiscal`)).body;
    expect(ctx.profile_errors.some((e: string) => e.includes("codice fiscale obbligatorio"))).toBe(true);

    expect((await c.request("/api/clients", {
      ...old, buyer_type: "private", vat_number: "", tax_country: "", tax_code: "RSSMRA80A01H501U",
    })).status).toBe(200);
    await finalizeInvoice(c, iid);
    const xml = (await c.request(`/api/invoices/${iid}/xml`)).bytes;
    await validateXml(xml);
    expect(findText(xml, "CodiceDestinatario")).toBe("0000000");
    expect(findPath(xml, ["CessionarioCommittente", "DatiAnagrafici", "CodiceFiscale"]))
      .toBe("RSSMRA80A01H501U");
  });

  it("IVA mista e split payment", async () => {
    const c = await fresh();
    const [cid, iid] = await draft(c);
    await configureFiscal(c, cid);
    // Invariante: i valori della fattura da preventivo accettato sono immutabili.
    // Come in Python (app.db) si riscrive direttamente lo snapshot del bozzetto.
    const [row] = await sql("SELECT snapshot FROM invoices WHERE id = $1", [iid]);
    const snapshot = JSON.parse(row.snapshot);
    snapshot.items = [
      { description: "Servizio A", amount: 10000 },
      { description: "Servizio B", amount: 5000 },
    ];
    await sql("UPDATE invoices SET snapshot = $1, subtotal = $2 WHERE id = $3", [
      JSON.stringify(snapshot), 15000, iid,
    ]);

    const { checked } = await finalizeInvoice(c, iid, {
      taxes: [
        { vat_rate: "22", nature: "", reference: "" },
        { vat_rate: "0", nature: "N4", reference: "Operazione esente" },
      ],
      vat_timing: "S",
    });
    expect(checked.report.vat).toBe(2200);
    expect(checked.report.total).toBe(17200);
    expect(checked.report.payable).toBe(15000);
  });
});
