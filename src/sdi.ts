// Esiti del Sistema di Interscambio (SdI) dell'Agenzia delle Entrate.
//
// Il gestionale non si collega al SdI con un canale proprio: SdICoop/SdIFtp
// richiedono accreditamento e un accordo di servizio con l'Agenzia. La fattura
// viene trasmessa dal titolare con un canale ufficiale (portale «Fatture e
// Corrispettivi», PEC a sdi01@pec.fatturapa.it, o un intermediario) e qui si
// registra l'invio e si importano le notifiche XML che il SdI restituisce,
// così lo stato della fattura riflette l'esito reale.
import { XMLParser } from "fast-xml-parser";

export const SDI_PEC = "sdi01@pec.fatturapa.it";
export const SDI_PORTAL = "https://ivaservizi.agenziaentrate.gov.it/portale/";

export const SDI_CHANNELS = ["portale", "pec", "intermediario"] as const;
export type SdiChannel = (typeof SDI_CHANNELS)[number];

/** Stati di trasmissione. `none` = non ancora inviata al SdI. */
export type SdiStatus =
  | "none"
  | "sent"
  | "delivered"
  | "not_delivered"
  | "rejected"
  | "attested"
  | "expired";

export type SdiNotificationType = "RC" | "NS" | "MC" | "AT" | "DT";

export interface SdiError {
  code: string;
  description: string;
}

export interface SdiNotification {
  type: SdiNotificationType;
  sdi_id: string;
  invoice_filename: string;
  received_at: string;
  delivered_at: string;
  errors: SdiError[];
}

export class SdiParseError extends Error {}

const ROOTS: Record<string, SdiNotificationType> = {
  RicevutaConsegna: "RC",
  NotificaScarto: "NS",
  NotificaMancataConsegna: "MC",
  AttestazioneTrasmissioneFattura: "AT",
  NotificaDecorrenzaTermini: "DT",
};

export const STATUS_BY_TYPE: Record<SdiNotificationType, SdiStatus> = {
  RC: "delivered",
  NS: "rejected",
  MC: "not_delivered",
  AT: "attested",
  DT: "expired",
};

export const STATUS_LABELS: Record<SdiStatus, string> = {
  none: "Da inviare al SdI",
  sent: "Inviata al SdI, in attesa di esito",
  delivered: "Consegnata al destinatario",
  not_delivered: "Mancata consegna (fattura valida, copia nell'area riservata del cliente)",
  rejected: "Scartata dal SdI: fattura considerata non emessa",
  attested: "Trasmessa, destinatario non raggiungibile",
  expired: "Decorrenza termini",
};

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false,
  processEntities: false,
});

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

/** Legge una notifica SdI (RC, NS, MC, AT, DT) e ne estrae i campi utili. */
export function parseNotification(xml: Buffer | string): SdiNotification {
  const source = Buffer.isBuffer(xml) ? xml.toString("utf8") : xml;
  if (source.length > 1_000_000) throw new SdiParseError("File troppo grande per essere una notifica SdI.");
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new SdiParseError("Il file contiene dichiarazioni non ammesse.");
  let doc: Record<string, any>;
  try {
    doc = parser.parse(source) as Record<string, any>;
  } catch {
    throw new SdiParseError("Il file non è un XML valido.");
  }
  const rootName = Object.keys(doc).find((k) => k in ROOTS);
  if (!rootName) throw new SdiParseError("Non è una notifica del Sistema di Interscambio.");
  const root = (doc[rootName] ?? {}) as Record<string, any>;
  const invoice_filename = text(root.NomeFile);
  if (!invoice_filename) throw new SdiParseError("La notifica non indica il file fattura.");
  const rawErrors = root.ListaErrori?.Errore;
  const list = Array.isArray(rawErrors) ? rawErrors : rawErrors ? [rawErrors] : [];
  const errors: SdiError[] = list.map((e: any) => ({
    code: text(e?.Codice),
    description: text(e?.Descrizione),
  }));
  const mc = text(root.Descrizione);
  if (ROOTS[rootName] === "MC" && mc) errors.push({ code: "", description: mc });
  return {
    type: ROOTS[rootName],
    sdi_id: text(root.IdentificativoSdI),
    invoice_filename,
    received_at: text(root.DataOraRicezione),
    delivered_at: text(root.DataOraConsegna),
    errors,
  };
}

/**
 * Ordine di precedenza: una consegna o uno scarto non vengono sovrascritti da
 * un messaggio arrivato in ritardo o importato due volte.
 */
export function nextStatus(current: SdiStatus, incoming: SdiNotificationType): SdiStatus {
  const target = STATUS_BY_TYPE[incoming];
  const final: SdiStatus[] = ["delivered", "rejected"];
  if (final.includes(current) && current !== target) return current;
  return target;
}
