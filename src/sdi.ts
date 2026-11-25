// Invio delle fatture allo SdI con il canale PEC.
//
// Lo SdI non ha un'API a cui un gestionale si "collega" da solo: si trasmette
// il file XML alla casella PEC sdi01@pec.fatturapa.it dalla PEC dell'azienda e
// le notifiche (consegna, scarto, mancata consegna, esito committente) tornano
// sulla stessa casella. Il codice destinatario è del destinatario, non
// dell'emittente: non viene generato qui. L'XML resta immutabile, cambia solo
// lo stato della fattura.
import { createHash } from "node:crypto";
import { ImapFlow } from "imapflow";
import { createTransport } from "nodemailer";
import { openSecret, sealSecret } from "./crypto.js";
import { prisma } from "./db.js";
import { Invalid } from "./util.js";

export const SDI_PEC = "sdi01@pec.fatturapa.it";
const CHIAVE_CONFIG = "sdi_pec";
const CHIAVE_PASSWORD = "sdi_pec_password";

// Quanti giorni di posta si rileggono a ogni controllo. La casella si riempie
// di anni di notifiche e la lettura gira dentro una funzione con un tempo
// limite: oltre questa finestra il messaggio resta in casella, semplicemente
// non viene letto. Le notifiche SdI arrivano entro pochi giorni dall'invio.
export const GIORNI_RICEVUTE = 30;

// Giorni dopo i quali una fattura ancora in stato «sent» viene considerata
// appesa: la ricevuta di consegna arriva di norma entro poche ore, quindi
// qualche giorno di silenzio vuol dire che c'è qualcosa da guardare.
export const GIORNI_SENZA_RICEVUTA = 3;

export const SDI_STATI: Record<string, string> = {
  not_sent: "Non inviata",
  sent: "Inviata · in attesa di ricevuta",
  delivered: "Consegnata",
  rejected: "Scartata dallo SdI",
  failed: "Mancata consegna",
  accepted: "Accettata dal cliente",
  refused: "Rifiutata dal cliente",
};

// Avanzamento degli stati: si usa solo quando una notifica arriva senza data e
// i tempi non possono decidere. Non si torna mai indietro.
const RANGO: Record<string, number> = {
  not_sent: 0,
  sent: 1,
  delivered: 2,
  failed: 2,
  rejected: 3,
  accepted: 4,
  refused: 4,
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

/** Esito dell'ultima lettura delle ricevute, come lo mostra il pannello. */
export interface SdiLettura {
  at: string;
  updated: number;
  ignorate: number;
  superate: number;
  ok: boolean;
  error: string;
}

export interface SdiSospesa {
  id: number;
  number: string;
  /** Istante dell'invio: `sdi_event_at`, oppure `sdi_sent_at` per le fatture più vecchie. */
  at: string;
}

export interface SdiSenzaRicevuta {
  /** Soglia usata per selezionare le fatture, così il pannello la mostra senza ripeterla. */
  giorni: number;
  fatture: SdiSospesa[];
}

export interface SdiStatus {
  configured: boolean;
  key_configured: boolean;
  config: Omit<SdiConfig, never> | null;
  counts: Record<string, number>;
  missing: string[];
  /** Null finché nessuna lettura è stata fatta (né dal cron né dal pulsante). */
  last_lettura: SdiLettura | null;
  /** Fatture inviate da giorni e ancora senza alcuna ricevuta. */
  senza_ricevuta: SdiSenzaRicevuta;
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

/** Scostamento di Roma da UTC nell'istante indicato, in millisecondi. */
function scostamentoRoma(ms: number): number {
  const locale = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(ms));
  const letto = Date.parse(locale.replace(", ", "T") + "Z");
  return Number.isFinite(letto) ? letto - ms : 0;
}

/**
 * Istante (ms) di una data, o null se non è una data. Le notifiche SdI
 * scrivono l'ora italiana senza fuso orario; quelli che scriviamo noi (invio)
 * sono ISO con la Z e vengono letti così come sono.
 */
export function istanteNotifica(valore: string | null | undefined): number | null {
  const s = (valore ?? "").trim().replace(" ", "T");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return null;
  const letto = Date.parse(s);
  if (!Number.isFinite(letto)) return null;
  return /(?:Z|[+-]\d{2}:?\d{2})$/.test(s) ? letto : letto - scostamentoRoma(letto);
}

/**
 * Una notifica si applica solo se è più recente dello stato già registrato:
 * la casella viene riletta intera a ogni lettura, quindi la vecchia ricevuta di
 * consegna torna sempre e non deve riportare indietro una fattura già accettata.
 * Senza date decide l'ordine degli stati.
 */
export function piuRecente(
  attuale: { state: string; at: string | null },
  nuova: { state: string; at: string | null },
): boolean {
  const a = istanteNotifica(attuale.at);
  const n = istanteNotifica(nuova.at);
  if (a !== null && n !== null && a !== n) return n > a;
  return (RANGO[nuova.state] ?? 0) > (RANGO[attuale.state] ?? 0);
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

async function trasmissioniSenzaRicevuta(): Promise<SdiSenzaRicevuta> {
  const p = prisma();
  // Solo le «sent»: appena arriva una ricevuta lo stato cambia e la fattura
  // esce dall'elenco da sola.
  const righe = await p.invoice.findMany({
    where: { sdi_state: "sent" },
    select: { id: true, number: true, sdi_event_at: true, sdi_sent_at: true },
  });
  const limite = Date.now() - GIORNI_SENZA_RICEVUTA * 24 * 60 * 60 * 1000;
  const fatture = righe
    .map((r) => {
      // sdi_event_at è ISO; sdi_sent_at è UTC senza suffisso e resta l'unico
      // riferimento per le fatture inviate prima che esistesse sdi_event_at.
      const at = r.sdi_event_at ?? (r.sdi_sent_at ? `${r.sdi_sent_at.replace(" ", "T")}Z` : "");
      return { id: r.id, number: r.number || `#${r.id}`, at, ms: at ? Date.parse(at) : NaN };
    })
    .filter((r) => Number.isFinite(r.ms) && r.ms < limite)
    .sort((a, b) => a.ms - b.ms)
    .map(({ id, number, at }) => ({ id, number, at }));
  return { giorni: GIORNI_SENZA_RICEVUTA, fatture };
}

export async function stato(): Promise<SdiStatus> {
  const p = prisma();
  const [cfg, password, impostazioni, lettura, senzaRicevuta] = await Promise.all([
    configPec(),
    passwordPec(),
    p.setting.findMany({ where: { key: { in: ["vat_number", "tax_regime", "address", "postcode", "city"] } } }),
    p.sdiSync.findUnique({ where: { id: 1 } }),
    trasmissioniSenzaRicevuta(),
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
    last_lettura: lettura
      ? {
          at: lettura.last_at,
          updated: lettura.updated,
          ignorate: lettura.ignorate,
          superate: lettura.superate,
          ok: lettura.ok,
          error: lettura.error,
        }
      : null,
    senza_ricevuta: senzaRicevuta,
  };
}

/** PEC collegata e utilizzabile: configurazione salvata e password leggibile. */
export async function configurata(): Promise<boolean> {
  return !!(await configPec()) && !!(await passwordPec());
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
          const criteri: Record<string, unknown> = {
            from: SDI_PEC,
            since: new Date(Date.now() - GIORNI_RICEVUTE * 24 * 60 * 60 * 1000),
          };
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
      data: {
        sdi_state: "failed",
        sdi_updated_at: adesso(),
        sdi_event_at: new Date().toISOString(),
        sdi_message: `Invio non riuscito: ${motivo}`,
      },
    });
    throw new Invalid(`Invio allo SdI non riuscito: ${motivo}`);
  }
  await p.invoice.update({
    where: { id },
    data: {
      sdi_state: "sent",
      sdi_sent_at: adesso(),
      sdi_updated_at: adesso(),
      // Ancora temporale del reinvio: le notifiche della trasmissione
      // precedente restano in casella ma sono più vecchie di questo istante.
      sdi_event_at: new Date().toISOString(),
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
export function leggiNotifica(
  xml: string,
  filename = "",
): { file: string; state: string; message: string; at: string | null } | null {
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
  // Data dell'evento secondo lo SdI: vale per ordinare le notifiche fra loro.
  const at = /<DataOraConsegna>([^<]+)<\/DataOraConsegna>/.exec(xml)?.[1]?.trim()
    ?? /<DataOra>([^<]+)<\/DataOra>/.exec(xml)?.[1]?.trim()
    ?? null;
  return { file, state, message: descrizioni || SDI_STATI[state] || state, at };
}

/**
 * Rilegge le notifiche dalla PEC e aggiorna lo stato delle fatture. L'esito
 * della lettura viene sempre registrato, riuscita o no: senza, dal pannello
 * non si distingue "il cron non gira" da "gira e non trova nulla".
 *
 * I contatori riguardano solo le notifiche nuove di questo giro: la casella
 * viene riletta intera, e senza memoria i messaggi già visti gonfierebbero
 * «senza fattura» e «più vecchie» a ogni lettura. La memoria è `sdi_notifiche`
 * (impronta del file); le righe escono quando il messaggio esce dalla finestra
 * di lettura, quindi al massimo per `GIORNI_RICEVUTE` restano in tabella.
 */
export async function aggiornaEsiti(
  transport?: SdiTransport,
): Promise<{ updated: number; ignorate: number; superate: number }> {
  let esiti: { updated: number; ignorate: number; superate: number };
  try {
    esiti = await elaboraEsiti(transport);
  } catch (err) {
    // Se il guasto è il database, anche la registrazione fallisce: non c'è
    // niente da salvare, e l'errore vero da mostrare è quello originale.
    await registraLettura({ updated: 0, ignorate: 0, superate: 0, ok: false, error: erroreBreve(err) })
      .catch(() => {});
    throw err;
  }
  await registraLettura({ ...esiti, ok: true, error: "" });
  return esiti;
}

/** L'esito della lettura nella riga unica `sdi_sync` (id 1). */
async function registraLettura(d: {
  updated: number;
  ignorate: number;
  superate: number;
  ok: boolean;
  error: string;
}): Promise<void> {
  const riga = { last_at: new Date().toISOString(), ...d };
  await prisma().sdiSync.upsert({
    where: { id: 1 },
    create: { id: 1, ...riga },
    update: riga,
  });
}

/** Impronta del file di notifica: identifica il messaggio fra una lettura e l'altra. */
function improntaNotifica(xml: string): string {
  return createHash("sha256").update(xml).digest("hex");
}

async function elaboraEsiti(
  transport?: SdiTransport,
): Promise<{ updated: number; ignorate: number; superate: number }> {
  const t = transport ?? (await trasportoDaConfig());
  const notifiche = await t.notifications();
  const p = prisma();
  const viste = new Set(
    (await p.sdiNotifica.findMany({ select: { chiave: true } })).map((r) => r.chiave),
  );
  const nuove: string[] = [];
  let updated = 0;
  let ignorate = 0;
  let superate = 0;
  for (const notifica of notifiche) {
    const esito = leggiNotifica(notifica.xml, notifica.filename);
    if (!esito) continue;
    // Una notifica già letta viene comunque applicata (l'ordine delle date
    // decide), ma non si conta di nuovo: i numeri del pannello sono le novità
    // di questa lettura.
    const chiave = improntaNotifica(notifica.xml);
    const nuova = !viste.has(chiave);
    if (nuova) {
      viste.add(chiave);
      nuove.push(chiave);
    }
    const inv = await p.invoice.findFirst({ where: { xml_filename: esito.file } });
    if (!inv) {
      if (nuova) ignorate++;
      continue;
    }
    if (!piuRecente({ state: inv.sdi_state, at: inv.sdi_event_at }, { state: esito.state, at: esito.at })) {
      if (nuova) superate++;
      continue;
    }
    await p.invoice.update({
      where: { id: inv.id },
      data: {
        sdi_state: esito.state,
        sdi_updated_at: adesso(),
        sdi_event_at: esito.at ?? inv.sdi_event_at,
        sdi_message: esito.message,
      },
    });
    updated++;
  }
  const ora = new Date().toISOString();
  if (nuove.length) {
    await p.sdiNotifica.createMany({
      data: nuove.map((chiave) => ({ chiave, vista_il: ora })),
      skipDuplicates: true,
    });
  }
  // Le righe più vecchie della finestra di lettura non servono più: quei
  // messaggi non vengono nemmeno scaricati dalla casella.
  const limite = new Date(Date.now() - GIORNI_RICEVUTE * 24 * 60 * 60 * 1000).toISOString();
  await p.sdiNotifica.deleteMany({ where: { vista_il: { lt: limite } } });
  return { updated, ignorate, superate };
}
