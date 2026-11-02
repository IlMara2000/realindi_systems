// Porting di estimator.py: stima deterministica scope→ore, con Decimal come in Python.
import { Decimal, Invalid, cents, number, required } from "./util.js";

export interface CatalogModule {
  key: string;
  name: string;
  unit: string;
  hours: string;
  quantity: number;
}

export interface Catalog {
  name: string;
  modules: CatalogModule[];
}

export const CATALOG: Record<string, Catalog> = {
  website: {
    name: "Sito web",
    modules: [
      { key: "discovery", name: "Analisi e struttura del sito", unit: "progetto", hours: "4", quantity: 1 },
      { key: "pages", name: "Design e sviluppo pagine", unit: "pagina distinta", hours: "4", quantity: 5 },
      { key: "cms", name: "Gestione contenuti CMS", unit: "tipologia di contenuto", hours: "6", quantity: 0 },
      { key: "forms", name: "Form e acquisizione contatti", unit: "form", hours: "3", quantity: 1 },
      { key: "languages", name: "Configurazione lingua aggiuntiva", unit: "lingua", hours: "4", quantity: 0 },
      { key: "release", name: "Pubblicazione e passaggio di consegne", unit: "rilascio", hours: "4", quantity: 1 },
    ],
  },
  application: {
    name: "Applicazione web",
    modules: [
      { key: "discovery", name: "Analisi e architettura", unit: "progetto", hours: "8", quantity: 1 },
      { key: "screens", name: "Schermate e flussi applicativi", unit: "schermata", hours: "6", quantity: 5 },
      { key: "entities", name: "Gestione dati e API", unit: "entità", hours: "6", quantity: 3 },
      { key: "auth", name: "Accesso e gestione ruoli", unit: "sistema di accesso", hours: "12", quantity: 1 },
      { key: "integrations", name: "Integrazioni con servizi esterni", unit: "integrazione", hours: "8", quantity: 0 },
      { key: "migration", name: "Importazione dati esistenti", unit: "sorgente dati", hours: "8", quantity: 0 },
      { key: "release", name: "Rilascio e documentazione", unit: "rilascio", hours: "6", quantity: 1 },
    ],
  },
  consulting: {
    name: "Consulenza / assistenza",
    modules: [
      { key: "audit", name: "Analisi tecnica iniziale", unit: "sistema", hours: "4", quantity: 1 },
      { key: "sessions", name: "Sessioni di consulenza", unit: "sessione", hours: "2", quantity: 2 },
      { key: "interventions", name: "Interventi tecnici concordati", unit: "intervento", hours: "4", quantity: 0 },
      { key: "report", name: "Report e raccomandazioni", unit: "report", hours: "3", quantity: 1 },
      { key: "training", name: "Formazione e affiancamento", unit: "sessione", hours: "2", quantity: 0 },
    ],
  },
};

/** Decimal con vincoli di intervallo e massimo due decimali (come estimator.decimal). */
function bounded(value: unknown, low: number, high: number, label: string): Decimal {
  let result: Decimal;
  try {
    result = new Decimal(String(value));
  } catch {
    throw new Error(`${label}: inserisci un valore tra ${low} e ${high}, con massimo due decimali.`);
  }
  if (!result.isFinite() || result.lt(low) || result.gt(high)) {
    throw new Error(`${label}: inserisci un valore tra ${low} e ${high}, con massimo due decimali.`);
  }
  if (result.decimalPlaces() > 2) {
    throw new Error(`${label}: inserisci un valore tra ${low} e ${high}, con massimo due decimali.`);
  }
  return result;
}

function hoursRound(value: Decimal): Decimal {
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

const str = (d: Decimal) => d.toString();

export function estimate(scope: unknown, rate: unknown): Record<string, unknown> {
  if (typeof scope !== "object" || scope === null || Array.isArray(scope)) {
    throw new Invalid("Seleziona una tipologia di lavoro valida.");
  }
  const sc = scope as Record<string, unknown>;
  const kind = sc.kind;
  if (typeof kind !== "string" || !(kind in CATALOG)) {
    throw new Invalid("Seleziona una tipologia di lavoro valida.");
  }
  const catalog = CATALOG[kind];
  const inputs = sc.modules;
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > catalog.modules.length) {
    throw new Invalid("Indica le funzionalità concordate con il cliente.");
  }
  let tariff: Decimal;
  let factor: Decimal;
  let testing: Decimal;
  let coordination: Decimal;
  let contingency: Decimal;
  let weekly: Decimal;
  let expenses: Decimal;
  try {
    tariff = bounded(rate, 0, 100000, "Tariffa oraria");
    factor = bounded(sc.complexity ?? "1", 0.5, 3, "Complessità");
    testing = bounded(sc.testing ?? "0", 0, 100, "Test e verifiche (%)");
    coordination = bounded(sc.coordination ?? "0", 0, 100, "Coordinamento (%)");
    contingency = bounded(sc.contingency ?? "0", 0, 100, "Imprevisti (%)");
    weekly = bounded(sc.weekly_hours ?? "20", 1, 80, "Ore disponibili alla settimana");
    expenses = bounded(sc.expenses ?? "0", 0, 1000000, "Costi extra");
  } catch (err) {
    throw new Invalid((err as Error).message);
  }

  const definitions = new Map(catalog.modules.map((m) => [m.key, m]));
  const seen = new Set<string>();
  const normalized: Record<string, unknown>[] = [];
  const lines: Record<string, unknown>[] = [];
  let baseHours = new Decimal(0);

  for (const raw of inputs) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Invalid("Funzionalità sconosciuta o ripetuta.");
    }
    const entry = raw as Record<string, unknown>;
    const key = entry.key;
    if (typeof key !== "string" || !definitions.has(key) || seen.has(key)) {
      throw new Invalid("Funzionalità sconosciuta o ripetuta.");
    }
    seen.add(key);
    const module = definitions.get(key)!;
    let qty: Decimal;
    let unitHours: Decimal;
    try {
      qty = bounded(entry.quantity, 0, 1000, "Quantità");
      unitHours = bounded(entry.hours, 0.01, 1000, "Ore per unità");
    } catch (err) {
      throw new Invalid((err as Error).message);
    }
    if (!qty.isInteger()) {
      throw new Invalid("La quantità deve essere un numero intero.");
    }
    normalized.push({
      key,
      name: module.name,
      unit: module.unit,
      quantity: qty.toNumber(),
      hours: str(unitHours),
    });
    if (qty.isZero()) continue;
    const effort = hoursRound(qty.mul(unitHours).mul(factor));
    baseHours = baseHours.add(effort);
    lines.push({
      description: `${module.name} (${qty.toNumber()} × ${unitHours} h × ${factor})`,
      hours: str(effort),
      rate: str(tariff),
      factor: "1",
      extra: "0",
    });
  }
  if (lines.length === 0) {
    throw new Invalid("Seleziona almeno una funzionalità con quantità maggiore di zero.");
  }

  const testHours = hoursRound(baseHours.mul(testing).div(100));
  const coordinationHours = hoursRound(baseHours.mul(coordination).div(100));
  const contingencyHours = hoursRound(
    baseHours.add(testHours).add(coordinationHours).mul(contingency).div(100),
  );
  for (const [label, effort] of [
    ["Test e verifiche", testHours],
    ["Coordinamento e revisioni", coordinationHours],
    ["Riserva per imprevisti", contingencyHours],
  ] as const) {
    if (!effort.isZero()) {
      lines.push({ description: label, hours: str(effort), rate: str(tariff), factor: "1", extra: "0" });
    }
  }
  if (!expenses.isZero()) {
    lines.push({
      description: "Costi extra concordati",
      hours: "0",
      rate: "0",
      factor: "1",
      extra: str(expenses),
    });
  }

  const totalHours = baseHours.add(testHours).add(coordinationHours).add(contingencyHours);
  const normalizedScope = {
    kind,
    modules: normalized,
    complexity: str(factor),
    testing: str(testing),
    coordination: str(coordination),
    contingency: str(contingency),
    weekly_hours: str(weekly),
    expenses: str(expenses),
  };
  return {
    version: 1,
    scope: normalizedScope,
    rate: str(tariff),
    items: lines,
    base_hours: str(baseHours),
    test_hours: str(testHours),
    coordination_hours: str(coordinationHours),
    contingency_hours: str(contingencyHours),
    total_hours: str(totalHours),
    workload_weeks: str(hoursRound(totalHours.div(weekly))),
    assumptions: [
      "Ore per unità e quantità sono ipotesi modificabili, non misure di lavoro già svolto.",
      `Complessità × ${factor} applicata alle attività selezionate.`,
      `Test ${testing}% e coordinamento ${coordination}% calcolati sulle attività; imprevisti ${contingency}% sul lavoro comprensivo di test e coordinamento.`,
      "Il carico in settimane dipende dalle ore disponibili; non costituisce una data di consegna.",
      "Sono esclusi servizi ricorrenti, licenze e attività non selezionate, salvo i costi extra indicati.",
    ],
  };
}

/** calculate() di app.py: righe di preventivo con arrotondamento ai centesimi. */
export function calculate(
  items: unknown,
  rate: unknown,
): { items: Record<string, unknown>[]; subtotal: number; vat: number; total: number; vat_rate: string } {
  if (!Array.isArray(items) || items.length < 1 || items.length > 100) {
    throw new Invalid("Inserisci da 1 a 100 voci nel preventivo.");
  }
  const lines: Record<string, unknown>[] = [];
  let subtotal = 0;
  for (const raw of items) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Invalid("Dati non validi.");
    }
    const item = raw as Record<string, unknown>;
    const desc = required(item, "description", 500);
    const hoursV = number(item.hours, 0, 100000);
    const price = number(item.rate, 0, 100000);
    const factor = number(item.factor ?? 1, 0.1, 10);
    const extra = number(item.extra ?? 0, 0, 1000000);
    const amount = cents(hoursV.mul(price).mul(factor).add(extra));
    subtotal += amount;
    lines.push({
      description: desc,
      hours: hoursV.toString(),
      rate: price.toString(),
      factor: factor.toString(),
      extra: extra.toString(),
      amount,
    });
  }
  const taxRate = number(rate, 0, 100);
  const vat = new Decimal(subtotal)
    .mul(taxRate)
    .div(100)
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
    .toNumber();
  return {
    items: lines,
    subtotal,
    vat,
    total: subtotal + vat,
    vat_rate: taxRate.toString(),
  };
}
