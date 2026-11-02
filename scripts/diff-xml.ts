// Confronta byte a byte l'XML generato dal port TS con quello di riferimento Python.
import { readFileSync, writeFileSync } from "node:fs";
import * as fiscal from "../src/fiscal.js";
import { PROFILE_DEFAULTS } from "../src/fiscal.js";

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

// Stesso report del riferimento Python (i calcoli sono già verificati dallo smoke).
const taxes = [{ vat_rate: "22.00", nature: "", reference: "" }];
const groups = [{ vat_rate: "22.00", nature: "", reference: "", base: 100000, vat: 22000 }];
const r: any = {
  taxes, groups, contribution: 0, withholding: 0, stamp: 0,
  subtotal: 100000, vat: 22000, total: 122000, split_vat: 0, payable: 122000,
};
const xml = fiscal.buildXml(s, c, items, cfg, r, "2026/00001", fiscal.fileProgressive(1));
writeFileSync("/tmp/mine.xml", xml);
const ref = readFileSync("/tmp/ref-invoice.xml", "utf8");
console.log("mine:", xml.length, "ref:", ref.length, "identical:", xml === ref);
if (xml !== ref) {
  const a = xml.split("\n");
  const b = ref.split("\n");
  let shown = 0;
  for (let i = 0; i < Math.max(a.length, b.length) && shown < 8; i++) {
    if (a[i] !== b[i]) {
      console.log(`line ${i + 1}:`);
      console.log(`  mine: ${JSON.stringify(a[i])}`);
      console.log(`  ref : ${JSON.stringify(b[i])}`);
      shown++;
    }
  }
}
