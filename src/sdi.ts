// Invio delle fatture allo SdI con il canale PEC.
//
// Lo SdI non ha un'API a cui un gestionale si "collega" da solo: si trasmette
// il file XML alla casella PEC sdi01@pec.fatturapa.it dalla PEC dell'azienda e
// le notifiche (consegna, scarto, mancata consegna, esito committente) tornano
// sulla stessa casella. Il codice destinatario è del destinatario, non
// dell'emittente: non viene generato qui. L'XML resta immutabile, cambia solo
// lo stato della fattura.
import { ImapFlow } from "imapflow";
import { createTransport } from "nodemailer";
import { openSecret, sealSecret } from "./crypto.js";
import { prisma } from "./db.js";
import { Invalid } from "./util.js";

export const SDI_PEC = "sdi01@pec.fatturapa.it";
const CHIAVE_CONFIG = "sdi_pec";
const CHIAVE_PASSWORD = "sdi_pec_password";

export const SDI_STATI: Record<string, string> = {
  not_sent: "Non inviata",
  sent: "Inviata · in attesa di ricevuta",
  delivered: "Consegnata",
  rejected: "Scartata dallo SdI",
  failed: "Mancata consegna",
  accepted: "Accettata dal cliente",
  refused: "Rifiutata dal cliente",
};

export interface SdiConfig {
  host: string;
  port: number;
  secure: boolean;
  imap_host: string;
  imap_port: number;
  user: string;
  from: string;
}

export interface SdiStatus {
  configured: boolean;
  key_configured: boolean;
  config: Omit<SdiConfig, never> | null;
  counts: Record<string, number>;
  missing: string[];
}

export interface SdiTransport {
  send(mail: { from: string; to: string; subject: string; text: string; filename: string; xml: Buffer }): Promise<void>;
  notifications(): Promise<{ filename: string; xml: string }[]>;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_ERRORE = 300;

function testo(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function erroreBreve(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, MAX_ERRORE);
}

function adesso(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

export function validaConfig(d: Record<string, unknown>): SdiConfig {
  const host = testo(d.host);
  const imapHost = testo(d.imap_host) || host;
  const user = testo(d.user);
  const from = testo(d.from) || user;
  if (!host || !/^[a-z0-9.-]+$/i.test(host)) throw new Invalid("Host SMTP della PEC non valido.");
  if (!imapHost || !/^[a-z0-9.-]+$/i.test(imapHost)) throw new Invalid("Host IMAP della PEC non valido.");
  const port = Number(d.port ?? 465);
  const imapPort = Number(d.imap_port ?? 993);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Invalid("Porta SMTP non valida.");
  if (!Number.isInteger(imapPort) || imapPort < 1 || imapPort > 65535) throw new Invalid("Porta IMAP non valida.");
  if (!EMAIL.test(user)) throw new Invalid("Utente PEC non valido: serve l'indirizzo completo.");
  if (!EMAIL.test(from)) throw new Invalid("Indirizzo mittente PEC non valido.");
  return { host, port, secure: d.secure !== false, imap_host: imapHost, imap_port: imapPort, user, from };
}

export async function configPec(): Promise<SdiConfig | null> {
  const row = await prisma().setting.findUnique({ where: { key: CHIAVE_CONFIG } });
  if (!row?.value) return null;
  try {
    return JSON.parse(row.value) as SdiConfig;
  } catch {
    return null;
  }
}

async function passwordPec(): Promise<string | null> {
  const row = await prisma().setting.findUnique({ where: { key: CHIAVE_PASSWORD } });
  if (!row?.value) return null;
  try {
    return openSecret(row.value);
  } catch {
    return null;
  }
}

export async function salvaConfig(d: Record<string, unknown>): Promise<SdiStatus> {
  const cfg = validaConfig(d);
  const password = testo(d.password);
  if (!password && !(await passwordPec())) {
    throw new Invalid("Inserisci la password della casella PEC.");
  }
  if (password.length > 300) throw new Invalid("Password della PEC troppo lunga.");
  if (password && !process.env.INTEGRATIONS_KEY) {
    throw new Invalid("Manca INTEGRATIONS_KEY sul server: la password non può essere cifrata.");
  }
  const p = prisma();
  await p.setting.upsert({
    where: { key: CHIAVE_CONFIG },
    create: { key: CHIAVE_CONFIG, value: JSON.stringify(cfg) },
    update: { value: JSON.stringify(cfg) },
  });
  if (password) {
    const sealed = sealSecret(password);
    await p.setting.upsert({
      where: { key: CHIAVE_PASSWORD },
      create: { key: CHIAVE_PASSWORD, value: sealed },
      update: { value: sealed },
    });
  }
  return stato();
}

export async function stato(): Promise<SdiStatus> {
  const p = prisma();
  const [cfg, password, impostazioni] = await Promise.all([
    configPec(),
    passwordPec(),
    p.setting.findMany({ where: { key: { in: ["vat_number", "tax_regime", "address", "postcode", "city"] } } }),
  ]);
  const valori = new Map(impostazioni.map((r) => [r.key, r.value]));
  const keyConfigured = !!process.env.INTEGRATIONS_KEY;
  const missing: string[] = [];
  if (!keyConfigured) missing.push("INTEGRATIONS_KEY non impostata sul server: la password della PEC non può essere cifrata.");
  if (!cfg) missing.push("PEC non collegata: servono host SMTP/IMAP, indirizzo e password.");
  else if (!password) missing.push("Password della PEC mancante o illeggibile: reinseriscila.");
  if (!testo(valori.get("vat_number"))) missing.push("Partita IVA aziendale mancante nelle Impostazioni.");
  if (!testo(valori.get("tax_regime"))) missing.push("Regime fiscale aziendale mancante: serve per generare l'XML.");

  const righe = await p.invoice.groupBy({ by: ["sdi_state"], _count: { _all: true } });
  const counts: Record<string, number> = {};
  for (const r of righe) counts[r.sdi_state] = r._count._all;

  return {
    configured: !!(cfg && password && keyConfigured),
    key_configured: keyConfigured,
    config: cfg
      ? { host: cfg.host, port: cfg.port, secure: cfg.secure, imap_host: cfg.imap_host, imap_port: cfg.imap_port, user: cfg.user, from: cfg.from }
      : null,
    counts,
    missing,
  };
}

async function trasportoDaConfig(): Promise<SdiTransport> {
  const cfg = await configPec();
  const password = await passwordPec();
  if (!cfg || !password) {
    throw new Invalid("La PEC non è configurata: apri Impostazioni → Invio allo SdI.");
  }
  return {
    async send(mail) {
      const transporter = createTransport({
        host: cfg.host,
        port: cfg.port,
        secure: cfg.secure,
        auth: { user: cfg.user, pass: password },
      });
      try {
        await transporter.sendMail({
          from: mail.from,
          to: mail.to,
          subject: mail.subject,
          text: mail.text,
          attachments: [{ filename: mail.filename, content: mail.xml, contentType: "application/xml" }],
        });
      } finally {
        transporter.close();
      }
    },
    async notifications() {
      const client = new ImapFlow({
        host: cfg.imap_host,
        port: cfg.imap_port,
        secure: true,
        auth: { user: cfg.user, pass: password },
      });
      const out: { filename: string; xml: string }[] = [];
      await client.connect();
      try {
        const lock = await client.getMailboxLock("INBOX");
        try {
          const criteri: Record<string, unknown> = { from: SDI_PEC };
          for await (const msg of client.fetch(criteri as never, { uid: true, bodyStructure: true })) {
            const parti: any[] = [];
            const raccogli = (nodo: any) => {
              if (!nodo) return;
              if (Array.isArray(nodo.childNodes) && nodo.childNodes.length) {
                nodo.childNodes.forEach(raccogli);
                return;
              }
              const nome = nodo.dispositionParameters?.filename ?? nodo.parameters?.name ?? "";
              if (String(nodo.type ?? "").includes("xml") || /\.xml$/i.test(String(nome))) parti.push(nodo);
            };
            raccogli((msg as any).bodyStructure);
            for (const parte of parti) {
              const flusso: any = await (client as any).download(String((msg as any).uid), parte.part, { uid: true });
              const pezzi: Buffer[] = [];
              for await (const pezzo of flusso) pezzi.push(Buffer.from(pezzo));
              const xml = Buffer.concat(pezzi).toString("utf8");
              if (!xml.includes("<")) continue;
              const nome =
                parte.dispositionParameters?.filename ?? parte.parameters?.name ?? `notifica-${(msg as any).uid}.xml`;
              out.push({ filename: String(nome), xml });
            }
          }
        } finally {
          lock.release();
        }
      } finally {
        await client.logout();
      }
      return out;
    },
  };
}

/** Invia una fattura già numerata con XML. Registra sempre l'esito. */
export async function inviaFattura(id: number, transport?: SdiTransport): Promise<{ state: string }> {
  const p = prisma();
  const inv = await p.invoice.findUnique({ where: { id } });
  if (!inv) throw new Invalid("Fattura non trovata.");
  if (!inv.xml) throw new Invalid("Genera prima l'XML validato: allo SdI va solo il file definitivo.");
  const cfg = await configPec();
  if (!cfg) throw new Invalid("Configura la PEC in Impostazioni → Invio allo SdI.");
  const t = transport ?? (await trasportoDaConfig());
  try {
    await t.send({
      from: cfg.from,
      to: SDI_PEC,
      subject: `Fattura ${inv.number ?? inv.id}`,
      text: `Trasmissione della fattura ${inv.number ?? inv.id} (${inv.xml_filename ?? ""}) al Sistema di Interscambio.`,
      filename: inv.xml_filename ?? `fattura-${inv.id}.xml`,
      xml: Buffer.from(inv.xml),
    });
  } catch (err) {
    const motivo = erroreBreve(err);
    await p.invoice.update({
      where: { id },
      data: { sdi_state: "failed", sdi_updated_at: adesso(), sdi_message: `Invio non riuscito: ${motivo}` },
    });
    throw new Invalid(`Invio allo SdI non riuscito: ${motivo}`);
  }
  await p.invoice.update({
    where: { id },
    data: {
      sdi_state: "sent",
      sdi_sent_at: adesso(),
      sdi_updated_at: adesso(),
      sdi_message: `Trasmessa a ${SDI_PEC}`,
    },
  });
  return { state: "sent" };
}

/** Invia appena la fattura è numerata, senza far fallire l'emissione. */
export async function invioAutomatico(id: number): Promise<string> {
  const cfg = await configPec();
  const password = await passwordPec();
  if (!cfg || !password) return "not_configured";
  try {
    await inviaFattura(id);
    return "sent";
  } catch {
    return "failed"; // inviaFattura ha già scritto stato e motivo
  }
}

/** Interpreta una notifica SdI: dice a quale file si riferisce e che esito è. */
export function leggiNotifica(xml: string, filename = ""): { file: string; state: string; message: string } | null {
  const nome = /<NomeFile>([^<]+)<\/NomeFile>/.exec(xml)?.[1]?.trim();
  const file = nome || (/\.xml$/i.test(filename) ? filename : "");
  if (!file) return null;
  let state: string | null = null;
  if (xml.includes("<RicevutaConsegna")) state = "delivered";
  else if (xml.includes("<NotificaScarto")) state = "rejected";
  else if (xml.includes("<NotificaMancataConsegna")) state = "failed";
  else if (xml.includes("<NotificaEsito")) state = /<Esito>\s*EC02/.test(xml) ? "refused" : "accepted";
  else if (xml.includes("<NotificaDecorrenzaTermini")) state = "accepted";
  if (!state) return null;
  const descrizioni = [...xml.matchAll(/<Descrizione>([^<]+)<\/Descrizione>/g)]
    .map((m) => m[1].trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(" · ");
  return { file, state, message: descrizioni || SDI_STATI[state] || state };
}

/** Rilegge le notifiche dalla PEC e aggiorna lo stato delle fatture. */
export async function aggiornaEsiti(transport?: SdiTransport): Promise<{ updated: number; ignorate: number }> {
  const t = transport ?? (await trasportoDaConfig());
  const notifiche = await t.notifications();
  let updated = 0;
  let ignorate = 0;
  for (const notifica of notifiche) {
    const esito = leggiNotifica(notifica.xml, notifica.filename);
    if (!esito) continue;
    const inv = await prisma().invoice.findFirst({ where: { xml_filename: esito.file } });
    if (!inv) {
      ignorate++;
      continue;
    }
    await prisma().invoice.update({
      where: { id: inv.id },
      data: { sdi_state: esito.state, sdi_updated_at: adesso(), sdi_message: esito.message },
    });
    updated++;
  }
  return { updated, ignorate };
}
