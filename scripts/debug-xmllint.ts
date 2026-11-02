// Debug: valida l'XML generato e quello di riferimento Python con xmllint-wasm.
import { readFileSync } from "node:fs";
import { validateXML } from "xmllint-wasm";

const xsd = readFileSync(new URL("../schemas/fatturapa-1.2.3.xsd", import.meta.url), "utf8");
const xmldsig = readFileSync(new URL("../schemas/xmldsig-core-schema.xsd", import.meta.url), "utf8");
const localXsd = xsd.replace(
  "http://www.w3.org/TR/2002/REC-xmldsig-core-20020212/xmldsig-core-schema.xsd",
  "xmldsig-core-schema.xsd",
);

for (const [label, path] of [
  ["python-ref", "/tmp/ref-invoice.xml"],
] as const) {
  const xml = readFileSync(path, "utf8");
  console.log(`--- ${label}: first 60 chars: ${JSON.stringify(xml.slice(0, 60))}`);
  const res = await validateXML({
    xml: [{ fileName: "fattura.xml", contents: xml }],
    schema: [{ fileName: "fatturapa-1.2.3.xsd", contents: localXsd }],
    preload: [{ fileName: "xmldsig-core-schema.xsd", contents: xmldsig }],
  });
  console.log(`valid=${res.valid} errors=${res.errors.length}`);
  for (const e of res.errors.slice(0, 4)) console.log("  -", e.message.slice(0, 200));
  if (!res.valid) console.log("  raw:", res.rawOutput.slice(0, 400));
}
