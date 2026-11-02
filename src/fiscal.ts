// Porting di fiscal.py: fatture FPR12 con generazione XML e validazione XSD ufficiale.
// Errori di dominio → FiscalError (errori[]), mai Invalid: il flusso li traduce in valid:false.
import { readFileSync } from "node:fs";
import { XMLParser } from "fast-xml-parser";
import { validateXML } from "xmllint-wasm";
import { Decimal, checkDate, dateRome } from "./util.js";

export const NS = "http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2";
const XSD_URL = new URL("../schemas/fatturapa-1.2.3.xsd", import.meta.url);
const XMDSIG_URL = new URL("../schemas/xmldsig-core-schema.xsd", import.meta.url);

export class FiscalError extends Error {
  errors: string[];
  constructor(errors: string | string[]) {
    const list = typeof errors === "string" ? [errors] : errors;
    super(list.join(" "));
    this.name = "FiscalError";
    this.errors = list;
  }
}

export const PROFILE_DEFAULTS: Record<string, string> = {
  country: "", city: "", postcode: "", province: "", tax_regime: "", ateco: "",
  invoice_vat_rate: "", invoice_nature: "", invoice_reference: "", payment_method: "",
  vat_timing: "", stamp_mode: "", stamp_amount: "", cassa_mode: "", cassa_type: "",
  cassa_rate: "", cassa_base_percent: "100", cassa_withholding: "no",
  withholding_mode: "", withholding_type: "", withholding_rate: "",
  withholding_base_percent: "100", withholding_reason: "",
};

export const CLIENT_FIELDS = [
  "country", "city", "postcode", "province", "tax_country", "tax_code",
  "recipient_code", "pec", "buyer_type",
];

export const COUNTRIES = new Set(
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW".split(" "),
);

// ------------------------------------------------------------------ catalogo XSD

type XmlNode = Record<string, unknown>;

function arr(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

let catalogCache: Record<string, [string, string][]> | null = null;

function collectEnumerations(node: unknown, out: XmlNode[]) {
  if (Array.isArray(node)) {
    for (const n of node) collectEnumerations(n, out);
    return;
  }
  if (!node || typeof node !== "object") return;
  const o = node as XmlNode;
  for (const [k, v] of Object.entries(o)) {
    if (k === "enumeration") {
      for (const e of arr(v)) out.push(e as XmlNode);
    } else {
      collectEnumerations(v, out);
    }
  }
}

function collectEnumerationTypes(node: unknown, out: Map<string, XmlNode[]>) {
  if (Array.isArray(node)) {
    for (const n of node) collectEnumerationTypes(n, out);
    return;
  }
  if (!node || typeof node !== "object") return;
  const o = node as XmlNode;
  if (o["@_name"]) {
    // come //xs:simpleType[@name=…]//xs:enumeration: enumerazioni a qualunque profondità
    const enums: XmlNode[] = [];
    collectEnumerations(o, enums);
    if (enums.length) {
      const name = String(o["@_name"]);
      const list = out.get(name) ?? [];
      list.push(...enums);
      out.set(name, list);
    }
  }
  for (const v of Object.values(o)) collectEnumerationTypes(v, out);
}

function docTexts(node: unknown, out: string[]) {
  if (Array.isArray(node)) {
    for (const n of node) docTexts(n, out);
    return;
  }
  if (!node || typeof node !== "object") return;
  const o = node as XmlNode;
  for (const [k, v] of Object.entries(o)) {
    if (k === "documentation") {
      for (const t of arr(v)) {
        out.push(typeof t === "string" ? t : String((t as XmlNode)["#text"] ?? ""));
      }
    } else {
      docTexts(v, out);
    }
  }
}

function collapse(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(" ");
}

/** catalog() di fiscal.py: enumerazioni estratte dallo schema ufficiale. */
export function catalog(): Record<string, [string, string][]> {
  if (catalogCache) return catalogCache;
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    removeNSPrefix: true,
    parseTagValue: false,
    trimValues: true,
  });
  const doc = parser.parse(readFileSync(XSD_URL, "utf8"));
  const types = new Map<string, XmlNode[]>();
  collectEnumerationTypes(doc, types);
  const pick = (typename: string): [string, string][] => {
    const nodes = types.get(typename) ?? [];
    return nodes.map((e) => {
      const value = String(e["@_value"] ?? "");
      const texts: string[] = [];
      docTexts(e, texts);
      return [value, collapse(texts.join(" ")) || value] as [string, string];
    });
  };
  catalogCache = {
    regimes: pick("RegimeFiscaleType"),
    natures: pick("NaturaType"),
    payments: pick("ModalitaPagamentoType"),
    funds: pick("TipoCassaType"),
    withholdings: pick("TipoRitenutaType"),
    reasons: pick("CausalePagamentoType"),
  };
  return catalogCache;
}

export function choices(key: string): Set<string> {
  return new Set(catalog()[key].map(([v]) => v));
}

// ------------------------------------------------------------------ numeri e pulizia

function dec(value: unknown, label: string, low = 0, high = 100): Decimal {
  let v: Decimal;
  try {
    v = new Decimal(String(value));
  } catch {
    throw new FiscalError(`${label}: valore obbligatorio tra ${low} e ${high}, con massimo due decimali.`);
  }
  if (!v.isFinite() || v.lt(low) || v.gt(high) || v.decimalPlaces() > 2) {
    throw new FiscalError(`${label}: valore obbligatorio tra ${low} e ${high}, con massimo due decimali.`);
  }
  return v;
}

function rounded(v: Decimal): number {
  return v.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
}

export function amount(cents: number): string {
  return new Decimal(cents).div(100).toFixed(2);
}

function clean(d: Record<string, unknown>, key: string): string {
  return String(d[key] ?? "").trim();
}

/** Controllo formale della partita IVA italiana (11 cifre). */
export function vatOk(value: string): boolean {
  if (!/^\d{11}$/.test(value)) return false;
  const digits = value.split("").map(Number);
  const even = digits.slice(0, 10).filter((_, i) => i % 2 === 0).reduce((a, b) => a + b, 0);
  const odd = digits.slice(0, 10).filter((_, i) => i % 2 === 1).reduce((a, x) => a + (x < 5 ? 2 * x : 2 * x - 9), 0);
  const total = even + odd;
  return (10 - (total % 10)) % 10 === digits[10] && value !== "00000000000";
}

// ------------------------------------------------------------------ errori di profilo

export function profileErrors(s: Record<string, unknown>, c: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const pairs = [
    ["Azienda", s, "business_name"],
    ["Cliente", c, "name"],
  ] as const;
  for (const [prefix, d, namekey] of pairs) {
    const fields = [
      [namekey, "denominazione", 80],
      ["address", "indirizzo", 60],
      ["city", "comune", 60],
      ["postcode", "CAP", 5],
      ["country", "nazione", 2],
    ] as const;
    for (const [k, label, limit] of fields) {
      const v = clean(d as Record<string, unknown>, k);
      if (!v || v.length > limit) {
        errors.push(`${prefix}: ${label} obbligatorio, massimo ${limit} caratteri.`);
      }
    }
    const country = clean(d as Record<string, unknown>, "country").toUpperCase();
    if (!COUNTRIES.has(country)) {
      errors.push(`${prefix}: scegli una nazione ISO valida.`);
    }
    if (!/^\d{5}$/.test(clean(d as Record<string, unknown>, "postcode"))) {
      errors.push(`${prefix}: CAP di 5 cifre richiesto dal tracciato; per indirizzi esteri usa 00000.`);
    }
    if (country === "IT" && !/^[A-Z]{2}$/.test(clean(d as Record<string, unknown>, "province").toUpperCase())) {
      errors.push(`${prefix}: provincia italiana obbligatoria (2 lettere).`);
    }
    const cf = clean(d as Record<string, unknown>, "tax_code").toUpperCase();
    if (cf && !/^(?:[A-Z0-9]{16}|\d{11})$/.test(cf)) {
      errors.push(`${prefix}: codice fiscale non valido nel formato.`);
    }
  }
  if (clean(s, "country").toUpperCase() !== "IT") {
    errors.push("Il generatore FatturaPA attuale richiede un emittente stabilito in Italia. Le altre giurisdizioni richiedono un connettore dedicato.");
  }
  if (!vatOk(clean(s, "vat_number"))) {
    errors.push("Azienda: partita IVA italiana di 11 cifre con controllo formale valido obbligatoria, senza prefisso IT.");
  }
  if (!choices("regimes").has(clean(s, "tax_regime"))) {
    errors.push("Azienda: seleziona esplicitamente il regime fiscale nelle impostazioni.");
  }
  const kind = clean(c, "buyer_type");
  if (!["business", "private"].includes(kind)) {
    errors.push("Cliente: scegli impresa/professionista o privato. Il flusso PA non è ancora disponibile.");
  }
  const country = clean(c, "country").toUpperCase();
  const vatCountry = clean(c, "tax_country").toUpperCase();
  const vat = clean(c, "vat_number");
  if (kind === "business" && (!vat || !COUNTRIES.has(vatCountry))) {
    errors.push("Cliente impresa: identificativo IVA e paese fiscale obbligatori.");
  }
  if (vat && vatCountry === "IT" && !vatOk(vat)) {
    errors.push("Cliente: partita IVA italiana non valida nel controllo formale.");
  }
  if (country !== "IT" && (!vat || !COUNTRIES.has(vatCountry))) {
    errors.push("Cliente estero: identificativo fiscale estero e paese fiscale obbligatori.");
  }
  if (kind === "private" && country === "IT" && !clean(c, "tax_code")) {
    errors.push("Cliente privato italiano: codice fiscale obbligatorio.");
  }
  const code = clean(c, "recipient_code").toUpperCase();
  if (country === "IT" && kind === "business" && !/^[A-Z0-9]{7}$/.test(code)) {
    errors.push("Cliente: codice destinatario di 7 caratteri obbligatorio; indica 0000000 se non disponibile.");
  }
  if (country === "IT" && code === "XXXXXXX") {
    errors.push("Il codice XXXXXXX è riservato ai destinatari esteri.");
  }
  if (clean(c, "pec") && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean(c, "pec"))) {
    errors.push("Cliente: indirizzo PEC non valido.");
  }
  if (clean(s, "iban")) {
    const iban = clean(s, "iban").replace(/ /g, "").toUpperCase();
    if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban)) {
      errors.push("Azienda: IBAN non valido.");
    } else {
      const rearranged = iban.slice(4) + iban.slice(0, 4);
      let n = "";
      for (const ch of rearranged) {
        n += /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
      }
      if (Number(BigInt(n) % 97n) !== 1) {
        errors.push("Azienda: checksum IBAN non valido.");
      }
    }
  }
  return errors;
}

// ------------------------------------------------------------------ configurazione

export function defaults(
  s: Record<string, unknown>,
  items: unknown[],
  dueDate: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const k of Object.keys(PROFILE_DEFAULTS)) {
    if (k.startsWith("cassa_") || k.startsWith("withholding_") || k.startsWith("stamp_")) {
      result[k] = s[k] ?? "";
    }
  }
  result.document_date = dateRome(new Date());
  result.due_date = dueDate;
  result.payment_method = s.payment_method ?? "";
  result.vat_timing = s.vat_timing ?? "";
  result.taxes = items.map(() => ({
    vat_rate: s.invoice_vat_rate ?? "",
    nature: s.invoice_nature ?? "",
    reference: s.invoice_reference ?? "",
  }));
  result.cassa_vat_rate = s.invoice_vat_rate ?? "";
  result.cassa_nature = s.invoice_nature ?? "";
  result.cassa_reference = s.invoice_reference ?? "";
  return result;
}

function taxLine(t: unknown, label: string, regime: string): Record<string, string> {
  if (typeof t !== "object" || t === null || Array.isArray(t)) {
    throw new FiscalError(`${label}: trattamento IVA mancante.`);
  }
  const tax = t as Record<string, unknown>;
  const rate = dec(tax.vat_rate ?? "", `${label} IVA`);
  const nature = clean(tax, "nature");
  const reference = clean(tax, "reference");
  const natures = choices("natures");
  if (rate.isZero() && (!natures.has(nature) || ["N2", "N3", "N6"].includes(nature) || !reference)) {
    throw new FiscalError(`${label}: IVA zero richiede natura dettagliata e riferimento normativo.`);
  }
  if (rate.gt(0) && nature) {
    throw new FiscalError(`${label}: rimuovi la natura per le operazioni con IVA.`);
  }
  if ((regime === "RF19" || regime === "RF02") && rate.gt(0)) {
    throw new FiscalError(`${label}: il regime selezionato non è compatibile con IVA esposta.`);
  }
  if (reference.length > 100) {
    throw new FiscalError(`${label}: riferimento normativo massimo 100 caratteri.`);
  }
  return { vat_rate: rate.toFixed(2), nature, reference };
}

// ------------------------------------------------------------------ albero XML

class XNode {
  name: string;
  attrs: [string, string][] = [];
  text?: string;
  children: XNode[] = [];
  constructor(name: string, value?: unknown) {
    this.name = name;
    if (value !== undefined && value !== null) this.text = String(value);
  }
  child(name: string, value?: unknown): XNode {
    const e = new XNode(name, value);
    this.children.push(e);
    return e;
  }
}

function escapeText(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(v: string): string {
  return escapeText(v).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** Serializzazione in stile lxml pretty_print: indentazione 2 spazi, apici singoli. */
function serialize(root: XNode): string {
  const lines: string[] = ["<?xml version='1.0' encoding='utf-8'?>"];
  const walk = (node: XNode, depth: number, isRoot: boolean) => {
    const pad = "  ".repeat(depth);
    const prefix = isRoot ? "p:" : "";
    const attrs = node.attrs.map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join("");
    const open = `${pad}<${prefix}${node.name}${attrs}`;
    if (node.text === undefined && node.children.length === 0) {
      lines.push(`${open}/>`);
      return;
    }
    if (node.text !== undefined && node.children.length === 0) {
      lines.push(`${open}>${escapeText(node.text)}</${prefix}${node.name}>`);
      return;
    }
    lines.push(`${open}>`);
    for (const child of node.children) walk(child, depth + 1, false);
    lines.push(`${pad}</${prefix}${node.name}>`);
  };
  walk(root, 0, true);
  return lines.join("\n") + "\n";
}

function taxId(parent: XNode, country: string, value: string) {
  const e = parent.child("IdFiscaleIVA");
  e.child("IdPaese", country);
  e.child("IdCodice", value);
}

function address(parent: XNode, d: Record<string, unknown>) {
  const e = parent.child("Sede");
  e.child("Indirizzo", clean(d, "address"));
  e.child("CAP", clean(d, "postcode"));
  e.child("Comune", clean(d, "city"));
  if (clean(d, "province") && clean(d, "country").toUpperCase() === "IT") {
    e.child("Provincia", clean(d, "province").toUpperCase());
  }
  e.child("Nazione", clean(d, "country").toUpperCase());
}

export function fileProgressive(identifier: number): string {
  if (!(identifier > 0) || !(identifier < 36 ** 5)) {
    throw new FiscalError("Spazio dei progressivi file esaurito: configura una nuova serie di trasmissione.");
  }
  const digits = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let value = "";
  let n = identifier;
  while (n > 0) {
    const remainder = n % 36;
    value = digits[remainder] + value;
    n = Math.floor(n / 36);
  }
  return value.padStart(5, "0");
}

export function buildXml(
  s: Record<string, unknown>,
  c: Record<string, unknown>,
  items: Record<string, any>[],
  conf: Record<string, unknown>,
  r: Record<string, any>,
  number: string,
  progressive: string,
): string {
  const root = new XNode("FatturaElettronica");
  root.attrs.push(["xmlns:p", NS], ["versione", "FPR12"]);

  const header = root.child("FatturaElettronicaHeader");
  const trans = header.child("DatiTrasmissione");
  const sender = trans.child("IdTrasmittente");
  sender.child("IdPaese", "IT");
  sender.child("IdCodice", s.vat_number);
  trans.child("ProgressivoInvio", progressive);
  trans.child("FormatoTrasmissione", "FPR12");
  const code =
    clean(c, "country").toUpperCase() !== "IT"
      ? "XXXXXXX"
      : clean(c, "buyer_type") === "private"
        ? "0000000"
        : clean(c, "recipient_code").toUpperCase();
  trans.child("CodiceDestinatario", code);
  if (code === "0000000" && clean(c, "pec")) trans.child("PECDestinatario", c.pec);

  const seller = header.child("CedentePrestatore");
  const sellerAn = seller.child("DatiAnagrafici");
  taxId(sellerAn, "IT", String(s.vat_number));
  if (clean(s, "tax_code")) sellerAn.child("CodiceFiscale", clean(s, "tax_code").toUpperCase());
  sellerAn.child("Anagrafica").child("Denominazione", s.business_name);
  sellerAn.child("RegimeFiscale", s.tax_regime);
  address(seller, s);

  const buyer = header.child("CessionarioCommittente");
  const buyerAn = buyer.child("DatiAnagrafici");
  if (clean(c, "vat_number")) taxId(buyerAn, clean(c, "tax_country").toUpperCase(), clean(c, "vat_number"));
  if (clean(c, "tax_code")) buyerAn.child("CodiceFiscale", clean(c, "tax_code").toUpperCase());
  buyerAn.child("Anagrafica").child("Denominazione", c.company || c.name);
  address(buyer, c);

  const body = root.child("FatturaElettronicaBody");
  const general = body.child("DatiGenerali").child("DatiGeneraliDocumento");
  general.child("TipoDocumento", "TD01");
  general.child("Divisa", "EUR");
  general.child("Data", conf.document_date);
  general.child("Numero", number);
  if (r.withholding) {
    const w = general.child("DatiRitenuta");
    w.child("TipoRitenuta", conf.withholding_type);
    w.child("ImportoRitenuta", amount(r.withholding));
    w.child("AliquotaRitenuta", new Decimal(String(conf.withholding_rate)).toFixed(2));
    w.child("CausalePagamento", conf.withholding_reason);
  }
  if (r.stamp) {
    const stamp = general.child("DatiBollo");
    stamp.child("BolloVirtuale", "SI");
    stamp.child("ImportoBollo", amount(r.stamp));
  }
  if (r.contribution) {
    const fund = general.child("DatiCassaPrevidenziale");
    const t = r.contribution_tax;
    fund.child("TipoCassa", conf.cassa_type);
    fund.child("AlCassa", new Decimal(String(conf.cassa_rate)).toFixed(2));
    fund.child("ImportoContributoCassa", amount(r.contribution));
    fund.child("ImponibileCassa", amount(r.contribution_base));
    fund.child("AliquotaIVA", t.vat_rate);
    if (conf.cassa_withholding === "yes") fund.child("Ritenuta", "SI");
    if (t.nature) fund.child("Natura", t.nature);
  }
  general.child("ImportoTotaleDocumento", amount(r.total));

  const goods = body.child("DatiBeniServizi");
  items.forEach((item, i) => {
    const t = r.taxes[i];
    const line = goods.child("DettaglioLinee");
    // Il prezzo include già ore, complessità e extra: una prestazione concordata.
    line.child("NumeroLinea", i + 1);
    line.child("Descrizione", item.description);
    line.child("Quantita", "1.00");
    line.child("PrezzoUnitario", amount(item.amount));
    line.child("PrezzoTotale", amount(item.amount));
    line.child("AliquotaIVA", t.vat_rate);
    if (r.withholding) line.child("Ritenuta", "SI");
    if (t.nature) line.child("Natura", t.nature);
  });
  for (const g of r.groups) {
    const summary = goods.child("DatiRiepilogo");
    summary.child("AliquotaIVA", g.vat_rate);
    if (g.nature) summary.child("Natura", g.nature);
    summary.child("ImponibileImporto", amount(g.base));
    summary.child("Imposta", amount(g.vat));
    if (new Decimal(g.vat_rate).gt(0)) summary.child("EsigibilitaIVA", conf.vat_timing);
    if (g.reference) summary.child("RiferimentoNormativo", g.reference);
  }

  const pay = body.child("DatiPagamento");
  pay.child("CondizioniPagamento", "TP02");
  const detail = pay.child("DettaglioPagamento");
  detail.child("ModalitaPagamento", conf.payment_method);
  detail.child("DataScadenzaPagamento", conf.due_date);
  detail.child("ImportoPagamento", amount(r.payable));
  if (clean(s, "iban")) detail.child("IBAN", clean(s, "iban").replace(/ /g, "").toUpperCase());

  return serialize(root);
}

let xsdText: string | null = null;
let xmldsigText: string | null = null;
let schemaPromise: Promise<void> | null = null;

function loadSchemas(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      xsdText = readFileSync(XSD_URL, "utf8");
      xmldsigText = readFileSync(XMDSIG_URL, "utf8");
    })();
  }
  return schemaPromise;
}

/** validate_xml() di fiscal.py: controllo contro lo schema FatturaPA ufficiale. */
export async function validateXml(xml: Buffer | string): Promise<void> {
  await loadSchemas();
  const body = typeof xml === "string" ? xml : xml.toString("utf8");
  // L'import punta a un URL remoto: xmllint-wasm non fa rete, lo rindirizziamo
  // al file locale (stesso contenuto, stesso significato) caricato in preload.
  const localXsd = xsdText!.replace(
    "http://www.w3.org/TR/2002/REC-xmldsig-core-20020212/xmldsig-core-schema.xsd",
    "xmldsig-core-schema.xsd",
  );
  let result: { valid: boolean; errors: readonly { message: string }[] };
  try {
    result = await validateXML({
      xml: [{ fileName: "fattura.xml", contents: body }],
      schema: [{ fileName: "fatturapa-1.2.3.xsd", contents: localXsd }],
      preload: [{ fileName: "xmldsig-core-schema.xsd", contents: xmldsigText! }],
    });
  } catch (err) {
    throw new FiscalError([`XML non conforme allo schema: ${(err as Error).message}`]);
  }
  if (!result.valid) {
    throw new FiscalError(
      result.errors.slice(0, 8).map((e) => `XML non conforme allo schema: ${e.message}`),
    );
  }
}

// ------------------------------------------------------------------ prepare

function isoDay(value: unknown): number {
  const text = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error("bad date");
  const [y, m, d] = text.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new Error("bad date");
  }
  return dt.getTime();
}

export async function prepare(
  s: Record<string, any>,
  c: Record<string, any>,
  items: Record<string, any>[],
  config: Record<string, any> | null,
  number: string,
  progressive: string,
): Promise<{ result: Record<string, any>; xml: Buffer }> {
  const errors = profileErrors(s, c);
  if (errors.length) throw new FiscalError(errors);
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new FiscalError("Compila la verifica fiscale per questa fattura.");
  }
  for (const [key, label] of [
    ["stamp_mode", "Bollo"],
    ["cassa_mode", "Contributo previdenziale"],
    ["withholding_mode", "Ritenuta"],
  ] as const) {
    if (config[key] !== "yes" && config[key] !== "no") {
      throw new FiscalError(`${label}: scegli esplicitamente se si applica a questa fattura.`);
    }
  }
  try {
    const documentDate = isoDay(config.document_date);
    const due = isoDay(config.due_date);
    const today = isoDay(dateRome(new Date()));
    if (documentDate > today || due < documentDate) throw new Error("range");
  } catch {
    throw new FiscalError("Date non valide: emissione non futura e scadenza non precedente alla data documento.");
  }
  if (!choices("payments").has(config.payment_method)) {
    throw new FiscalError("Seleziona la modalità di pagamento.");
  }
  if (!["I", "D", "S"].includes(config.vat_timing)) {
    throw new FiscalError("Seleziona l’esigibilità IVA dell’operazione.");
  }
  if (config.payment_method === "MP05" && !clean(s, "iban")) {
    throw new FiscalError("Inserisci l’IBAN aziendale per il pagamento con bonifico.");
  }
  const taxes = config.taxes;
  if (!Array.isArray(taxes) || taxes.length !== items.length) {
    throw new FiscalError("Verifica il trattamento IVA di ogni voce della fattura.");
  }

  const result: Record<string, any> = {
    taxes: [], groups: [], contribution: 0, withholding: 0, stamp: 0,
  };
  const groups = new Map<string, { vat_rate: string; nature: string; reference: string; base: number }>();
  const subtotal = items.reduce((sum, i) => sum + Number(i.amount), 0);
  if (subtotal <= 0) throw new FiscalError("La fattura deve avere un imponibile positivo.");
  items.forEach((item, idx) => {
    const t = taxLine(taxes[idx], `Voce ${idx + 1}`, s.tax_regime);
    result.taxes.push(t);
    const key = `${t.vat_rate} ${t.nature} ${t.reference}`;
    const group = groups.get(key) ?? { vat_rate: t.vat_rate, nature: t.nature, reference: t.reference, base: 0 };
    group.base += Number(item.amount);
    groups.set(key, group);
  });
  if (config.stamp_mode === "yes") {
    result.stamp = rounded(dec(config.stamp_amount ?? "", "Importo bollo", 0.01, 100000).mul(100));
  }
  if (config.cassa_mode === "yes") {
    if (!choices("funds").has(config.cassa_type)) {
      throw new FiscalError("Seleziona la cassa previdenziale.");
    }
    const rate = dec(config.cassa_rate ?? "", "Aliquota cassa", 0.01, 100);
    const basePct = dec(config.cassa_base_percent ?? "", "Base cassa (%)", 0.01, 100);
    const base = rounded(new Decimal(subtotal).mul(basePct).div(100));
    result.contribution = rounded(new Decimal(base).mul(rate).div(100));
    result.contribution_base = base;
    const t = taxLine(
      { vat_rate: config.cassa_vat_rate ?? "", nature: config.cassa_nature ?? "", reference: config.cassa_reference ?? "" },
      "Contributo previdenziale",
      s.tax_regime,
    );
    result.contribution_tax = t;
    const key = `${t.vat_rate} ${t.nature} ${t.reference}`;
    const group = groups.get(key) ?? { vat_rate: t.vat_rate, nature: t.nature, reference: t.reference, base: 0 };
    group.base += result.contribution;
    groups.set(key, group);
    if (config.cassa_withholding !== "yes" && config.cassa_withholding !== "no") {
      throw new FiscalError("Indica se il contributo previdenziale è soggetto a ritenuta.");
    }
  }
  if (config.withholding_mode === "yes") {
    if (s.tax_regime === "RF19" || s.tax_regime === "RF02") {
      throw new FiscalError("Il regime selezionato non è compatibile con la ritenuta configurata.");
    }
    if (!choices("withholdings").has(config.withholding_type) || !choices("reasons").has(config.withholding_reason)) {
      throw new FiscalError("Seleziona tipo e causale della ritenuta.");
    }
    const rate = dec(config.withholding_rate ?? "", "Aliquota ritenuta", 0.01, 100);
    const basePct = dec(config.withholding_base_percent ?? "", "Base ritenuta (%)", 0.01, 100);
    const base = subtotal + (config.cassa_withholding === "yes" ? result.contribution : 0);
    result.withholding_base = rounded(new Decimal(base).mul(basePct).div(100));
    result.withholding = rounded(new Decimal(result.withholding_base).mul(rate).div(100));
  } else if (config.cassa_mode === "yes" && config.cassa_withholding === "yes") {
    throw new FiscalError("Il contributo è indicato soggetto a ritenuta ma la ritenuta non è attiva.");
  }
  for (const group of groups.values()) {
    result.groups.push({
      vat_rate: group.vat_rate,
      nature: group.nature,
      reference: group.reference,
      base: group.base,
      vat: rounded(new Decimal(group.base).mul(new Decimal(group.vat_rate)).div(100)),
    });
  }
  result.subtotal = subtotal;
  result.vat = result.groups.reduce((sum: number, g: any) => sum + g.vat, 0);
  // Il bollo è a carico dell'emittente; i rimborsi vanno come righe imponibili esplicite.
  result.total = subtotal + result.contribution + result.vat;
  result.split_vat = config.vat_timing === "S" ? result.vat : 0;
  result.payable = result.total - result.withholding - result.split_vat;
  if (result.payable < 0) throw new FiscalError("Il netto da pagare non può essere negativo.");
  const xml = buildXml(s, c, items, config, result, number, progressive);
  await validateXml(xml);
  return { result, xml: Buffer.from(xml, "utf8") };
}

/** Usato dai test: verifica che una data sia nel formato accettato. */
export function fiscalCheckDate(value: unknown): string {
  return checkDate(value);
}
