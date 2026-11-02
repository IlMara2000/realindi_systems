// Smoke test: catalogo, prepare() e XML confrontati col riferimento Python.
import { readFileSync } from "node:fs";
import * as fiscal from "../src/fiscal.js";
import { PROFILE_DEFAULTS } from "../src/fiscal.js";

const sizes = Object.fromEntries(Object.entries(fiscal.catalog()).map(([k, v]) => [k, v.length]));
console.log("catalog:", JSON.stringify(sizes));

const s: any = {
  ...PROFILE_DEFAULTS,
  business_name: "Studio test", address: "Via Test 1", city: "Roma", postcode: "00100",
  province: "RM", country: "IT", vat_number: "01234567897", tax_regime: "RF01", tax_code: "",
  iban: "", email: "studio@example.test", invoice_vat_rate: "22", invoice_nature: "",
  invoice_reference: "", payment_method: "MP01", vat_timing: "I",
};
const c: any = {
  name: "Ada", email: "ada@example.test", company: "Studio Ada", address: "Via Test 1",
  phone: "", vat_number: "12345678903", notes: "", country: "IT", city: "Roma", postcode: "00100",
  province: "RM", tax_country: "IT", tax_code: "", recipient_code: "0000000", pec: "", buyer_type: "business",
};
const items = [{ description: "Analisi & sviluppo", amount: 100000 }];
const cfg: any = fiscal.defaults(s, items, "2026-12-02");
cfg.stamp_mode = "no";
cfg.cassa_mode = "no";
cfg.withholding_mode = "no";
const { result, xml } = await fiscal.prepare(s, c, items, cfg, "2026/00001", fiscal.fileProgressive(1));
const { contribution, withholding, stamp, subtotal, vat, total, split_vat, payable } = result;
console.log("report:", JSON.stringify({ contribution, withholding, stamp, subtotal, vat, total, split_vat, payable }));
console.log("xml bytes:", xml.length, "| progressive:", fiscal.fileProgressive(1), fiscal.fileProgressive(100000));
const ref = readFileSync("/tmp/ref-invoice.xml");
console.log("ref bytes:", ref.length, "| identical:", Buffer.compare(xml, ref) === 0);
