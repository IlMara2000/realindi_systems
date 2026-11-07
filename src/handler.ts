// Handler HTTP centrale: porting fedele di app.py (GET/POST, errori, header).
// Framework-agnostic: riceve un HandlerRequest e restituisce HandlerResponse,
// così lo stesso codice gira nel server di sviluppo e nelle funzioni Vercel.
import { readFileSync } from "node:fs";
import { CATALOG } from "./estimator.js";
import * as fiscal from "./fiscal.js";
import { buildBackup, BackupTooLarge } from "./backup.js";
import { available, createAppointment } from "./booking.js";
import {
  CLEAR_COOKIE,
  DEFAULTS,
  auth,
  destroySession,
  ensureDefaults,
  hasPassword,
  parseCookie,
  prisma,
  settings,
  setupPassword,
  verifyLogin,
} from "./db.js";
import {
  Invalid,
  required as requiredField,
  optional as optionalField,
  email as emailField,
  number as numberValue,
  checkDate as checkDateField,
  dateRome,
  dateUtc,
  instant as instantField,
  iso,
  sha256Bytes,
  sha256Hex,
  timingSafeEqualStr,
  tokenHex,
  todayRome,
} from "./util.js";
import { calculate, estimate } from "./estimator.js";
import {
  listNotes,
  validateNoteFields,
  ensureReferencesExist,
  intId,
  utcStamp,
} from "./notes.js";
import { listEvents, validateEventFields, parseRange } from "./events.js";
import {
  integrationStatus,
  googleConnectUrl,
  googleCallback,
  saveApple,
  removeApple,
} from "./integrations.js";
import { runSync } from "./sync.js";
import { emitReceipt, listReceipts, validateReceiptFields } from "./receipts.js";
import { sendMail, validateOutgoing, readInbox } from "./email.js";
import {
  PROVIDERS,
  channelCredentials,
  listChannels,
  normalizePhone,
  parseInstagramWebhook,
  parseWhatsAppWebhook,
  saveChannel,
  sendChannelMessage,
  verifyChannel,
  verifyMetaSignature,
  verifyTwilioSignature,
} from "./channels.js";
import {
  assistantSettings,
  generateReply,
  knowledgeSummary,
  saveAssistantKey,
  trainFromSite,
} from "./assistant.js";
import {
  conversationThread,
  ingestInbound,
  listConversations,
  sendManualReply,
  setConversationState,
} from "./messaging.js";

export interface HandlerRequest {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string | undefined>;
  body: Buffer;
  ip: string;
}

export interface HandlerResponse {
  status: number;
  headers: [string, string][];
  body: Buffer;
}

const CSP =
  "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

const SECURITY_HEADERS: [string, string][] = [
  ["Cache-Control", "no-store"],
  ["X-Content-Type-Options", "nosniff"],
  ["Referrer-Policy", "no-referrer"],
  ["Content-Security-Policy", CSP],
];

function send(
  value: unknown,
  status = 200,
  contentType = "application/json; charset=utf-8",
  extra: [string, string][] = [],
): HandlerResponse {
  const body =
    typeof contentType === "string" && contentType.startsWith("application/json")
      ? Buffer.from(JSON.stringify(value), "utf8")
      : (value as Buffer);
  return { status, headers: [...SECURITY_HEADERS, ["Content-Type", contentType], ...extra], body };
}

function sendError(status: number, message: string): HandlerResponse {
  return send({ error: message }, status);
}

const MIME: Record<string, string> = {
  "index.html": "text/html; charset=utf-8",
  "app.html": "text/html; charset=utf-8",
  "bio.html": "text/html; charset=utf-8",
  "app.js": "text/javascript; charset=utf-8",
  "estimate.js": "text/javascript; charset=utf-8",
  "fiscal.js": "text/javascript; charset=utf-8",
  "site.js": "text/javascript; charset=utf-8",
  "style.css": "text/css; charset=utf-8",
  "site.css": "text/css; charset=utf-8",
  "assets/logo-realindi.png": "image/png",
  "assets/favicon-32.png": "image/png",
  "assets/favicon-192.png": "image/png",
  "assets/app-touch.png": "image/png",
};

const STATIC_FILES = new Set([
  "/app.js",
  "/estimate.js",
  "/fiscal.js",
  "/site.js",
  "/style.css",
  "/site.css",
  "/assets/logo-realindi.png",
  "/assets/favicon-32.png",
  "/assets/favicon-192.png",
  "/assets/app-touch.png",
]);

const EDIT_SLOT_RE = /<!--\s*edit-slot:([a-z-]+)\s*-->/g;

/**
 * Vetrina e link-in-bio sono pagine pubbliche che diventano editor per il
 * titolare. I bottoni di modifica non esistono nel markup servito a chi non ha
 * la sessione: vengono iniettati qui, lato server, al posto dei segnaposto.
 * Nasconderli con il CSS non basta, e l'endpoint di salvataggio ricontrolla
 * comunque la sessione.
 *
 * I due file stanno in `public/pages/` e non nella radice di `public/`: su
 * Vercel i file statici hanno la precedenza sui rewrite, quindi con
 * `public/index.html` al suo posto il rewrite di `/` veniva ignorato e questa
 * funzione non veniva mai eseguita in produzione. Per lo stesso motivo le
 * pagine che non dipendono dalla sessione (`app.html`, `ricevute.html`)
 * restano servite staticamente da `serveStatic`.
 */
function serveEditablePage(file: string, authenticated: boolean): HandlerResponse {
  let html: string;
  try {
    html = readFileSync(new URL(`../public/pages/${file}`, import.meta.url), "utf8");
  } catch {
    return sendError(404, "Pagina non trovata.");
  }
  html = html.replace(EDIT_SLOT_RE, (_match, slot: string) =>
    authenticated
      ? `<button type="button" class="site-edit" data-edit="${slot}">Modifica</button>`
      : "",
  );
  return send(Buffer.from(html, "utf8"), 200, MIME[file]);
}

/**
 * La vetrina resta un sito pubblico: se il database non risponde la pagina
 * viene servita senza bottoni, non con un errore. L'autorizzazione vera sta
 * comunque sull'endpoint di salvataggio.
 */
async function editorSession(token: string | null): Promise<boolean> {
  if (!token) return false;
  try {
    return await auth(token);
  } catch {
    return false;
  }
}

function serveStatic(path: string): HandlerResponse | null {
  let file: string | null = null;
  if (path === "/app" || path.startsWith("/book/")) file = "app.html";
  else if (STATIC_FILES.has(path)) file = path.slice(1);
  if (!file) return null;
  try {
    const data = readFileSync(new URL(`../public/${file}`, import.meta.url));
    return send(data, 200, MIME[file]);
  } catch {
    return null;
  }
}

function parseQuery(raw: string): URLSearchParams {
  return new URLSearchParams(raw);
}

// ---------------------------------------------------------------------- bio
// Origine della richiesta (dietro il proxy di Vercel) per i redirect OAuth.
function originOf(req: HandlerRequest): string {
  const proto = (req.headers["x-forwarded-proto"] ?? "https").split(",")[0].trim();
  const host = req.headers["host"] ?? "localhost";
  return `${proto}://${host}`;
}

// Origine vista dal browser: in locale il proxy non manda x-forwarded-proto e
// senza questo l'addestramento leggerebbe https://127.0.0.1 (TLS assente).
function requestOrigin(req: HandlerRequest): string {
  const origin = req.headers.origin;
  if (origin) {
    try {
      const url = new URL(origin);
      if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
    } catch {
      // header non valido: si usa l'origine dedotta dall'host
    }
  }
  return originOf(req);
}

// Contenuti del sito pubblico: la vetrina (`site_content`) e il link-in-bio
// (`site_bio`). Il server non custodisce una configurazione di base: finché il
// titolare non salva, la pagina mostra il contenuto scritto nell'HTML; dal primo
// salvataggio il record precedente viene sostituito per intero, così niente
// della base sopravvive e nessun campo può riemergere da un valore predefinito.

const BIO_SECTIONS = new Set(["main", "socials", "contacts"]);

interface BioLink {
  id: string;
  label: string;
  url: string;
  section: string;
  visible: boolean;
  order: number;
}

interface Bio {
  tagline: string;
  links: BioLink[];
}

interface SiteService {
  title: string;
  body: string;
}

interface SiteWork {
  kicker: string;
  title: string;
  body: string;
}

/** Tutti i dettagli modificabili della vetrina, in un unico record. */
interface SiteContent {
  brand: string;
  ticker: string;
  hero: {
    label: string;
    title1: string;
    title2: string;
    emphasis: string;
    lead: string;
    cta_primary: string;
    cta_secondary: string;
  };
  services: { label: string; title1: string; title2: string; items: SiteService[] };
  about: {
    label: string;
    title1: string;
    title2: string;
    intro: string;
    paragraphs: string[];
    facts: string[];
  };
  works: { label: string; title1: string; title2: string; items: SiteWork[] };
  contacts: { label: string; title1: string; title2: string; paragraphs: string[]; secondary: string };
  footer: string;
}

/** Lettura grezza: null significa «mai salvato» (resta la pagina iniziale). */
async function storedSetting(key: string): Promise<unknown | null> {
  const row = await prisma().setting.findUnique({ where: { key } });
  if (!row) return null;
  try {
    return JSON.parse(row.value) as unknown;
  } catch {
    return null;
  }
}

async function getBio(): Promise<Bio | null> {
  const parsed = await storedSetting("site_bio");
  if (!parsed || typeof parsed !== "object") return null;
  const raw = parsed as Record<string, unknown>;
  return {
    tagline: typeof raw.tagline === "string" ? raw.tagline : "",
    links: Array.isArray(raw.links) ? (raw.links as BioLink[]) : [],
  };
}

async function getSiteContent(): Promise<SiteContent | null> {
  const parsed = await storedSetting("site_content");
  if (!parsed || typeof parsed !== "object") return null;
  try {
    return validateSiteContent(parsed);
  } catch {
    return null;
  }
}

/**
 * Sostituzione integrale di un record del sito: la riga precedente viene
 * eliminata, non aggiornata. Un salvataggio non è mai un merge con la
 * configurazione che c'era prima.
 */
async function replaceSetting(key: string, value: unknown): Promise<void> {
  const p = prisma();
  const data = JSON.stringify(value);
  await p.setting.deleteMany({ where: { key } });
  await p.setting.create({ data: { key, value: data } });
}

function siteText(value: unknown, max: number, label: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new Invalid(`Valore non valido per ${label}.`);
  const v = value.replace(/\r\n/g, "\n").trim();
  if (v.length > max) throw new Invalid(`${label}: massimo ${max} caratteri.`);
  return v;
}

function siteTextList(value: unknown, max: number, maxItems: number, label: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Invalid(`${label}: elenco non valido.`);
  if (value.length > maxItems) throw new Invalid(`${label}: massimo ${maxItems} voci.`);
  return value.map((item, i) => siteText(item, max, `${label} ${i + 1}`));
}

function siteObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Invalid(`${label}: dati non validi.`);
  }
  return value as Record<string, unknown>;
}

function validateSiteContent(raw: unknown): SiteContent {
  const root = siteObject(raw, "Contenuto del sito");
  const hero = siteObject(root.hero, "Testata");
  const services = siteObject(root.services, "Servizi");
  const about = siteObject(root.about, "Chi sono");
  const works = siteObject(root.works, "Lavori");
  const contacts = siteObject(root.contacts, "Contatti");

  const serviceItems = siteObjectList(services.items, 8, "Servizi");
  const workItems = siteObjectList(works.items, 8, "Lavori");

  return {
    brand: siteText(root.brand, 60, "Nome del marchio"),
    ticker: siteText(root.ticker, 240, "Testo scorrevole"),
    hero: {
      label: siteText(hero.label, 120, "Etichetta della testata"),
      title1: siteText(hero.title1, 160, "Titolo, prima riga"),
      title2: siteText(hero.title2, 160, "Titolo, seconda riga"),
      emphasis: siteText(hero.emphasis, 160, "Titolo, parte evidenziata"),
      lead: siteText(hero.lead, 1200, "Testo introduttivo"),
      cta_primary: siteText(hero.cta_primary, 60, "Bottone principale"),
      cta_secondary: siteText(hero.cta_secondary, 60, "Bottone secondario"),
    },
    services: {
      label: siteText(services.label, 120, "Etichetta dei servizi"),
      title1: siteText(services.title1, 160, "Titolo dei servizi, prima riga"),
      title2: siteText(services.title2, 160, "Titolo dei servizi, seconda riga"),
      items: serviceItems.map((item, i) => ({
        title: siteText(item.title, 80, `Servizio ${i + 1}, titolo`),
        body: siteText(item.body, 600, `Servizio ${i + 1}, descrizione`),
      })),
    },
    about: {
      label: siteText(about.label, 120, "Etichetta di chi sono"),
      title1: siteText(about.title1, 160, "Titolo di chi sono, prima riga"),
      title2: siteText(about.title2, 160, "Titolo di chi sono, seconda riga"),
      intro: siteText(about.intro, 600, "Presentazione breve"),
      paragraphs: siteTextList(about.paragraphs, 900, 8, "Paragrafo"),
      facts: siteTextList(about.facts, 200, 8, "Punto del metodo"),
    },
    works: {
      label: siteText(works.label, 120, "Etichetta dei lavori"),
      title1: siteText(works.title1, 160, "Titolo dei lavori, prima riga"),
      title2: siteText(works.title2, 160, "Titolo dei lavori, seconda riga"),
      items: workItems.map((item, i) => ({
        kicker: siteText(item.kicker, 60, `Lavoro ${i + 1}, etichetta`),
        title: siteText(item.title, 100, `Lavoro ${i + 1}, titolo`),
        body: siteText(item.body, 600, `Lavoro ${i + 1}, descrizione`),
      })),
    },
    contacts: {
      label: siteText(contacts.label, 120, "Etichetta dei contatti"),
      title1: siteText(contacts.title1, 160, "Titolo dei contatti, prima riga"),
      title2: siteText(contacts.title2, 160, "Titolo dei contatti, seconda riga"),
      paragraphs: siteTextList(contacts.paragraphs, 900, 8, "Paragrafo dei contatti"),
      secondary: siteText(contacts.secondary, 60, "Bottone secondario dei contatti"),
    },
    footer: siteText(root.footer, 240, "Nota a piè di pagina"),
  };
}

function siteObjectList(value: unknown, maxItems: number, label: string): Record<string, unknown>[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Invalid(`${label}: elenco non valido.`);
  if (value.length > maxItems) throw new Invalid(`${label}: massimo ${maxItems} voci.`);
  return value.map((item) => siteObject(item, `${label}: voce`));
}

function validateBio(raw: unknown): Bio {
  if (!raw || typeof raw !== "object") throw new Invalid("Dati della bio non validi.");
  const input = raw as Record<string, unknown>;
  const tagline = typeof input.tagline === "string" ? input.tagline : "";
  if (tagline.length > 300) throw new Invalid("Tagline troppo lunga (max 300 caratteri).");
  if (!Array.isArray(input.links) || input.links.length > 30) {
    throw new Invalid("Elenco link non valido (max 30 voci).");
  }
  const links: BioLink[] = input.links.map((item, i) => {
    if (!item || typeof item !== "object") throw new Invalid("Link non valido.");
    const l = item as Record<string, unknown>;
    const label = typeof l.label === "string" ? l.label.trim() : "";
    const url = typeof l.url === "string" ? l.url.trim() : "";
    const section = typeof l.section === "string" ? l.section : "";
    if (!label || label.length > 80) throw new Invalid("Etichetta del link non valida (1-80 caratteri).");
    if (url.length > 500 || !/^https?:\/\//.test(url)) {
      throw new Invalid("URL del link non valido: deve iniziare con http:// o https://.");
    }
    if (!BIO_SECTIONS.has(section)) throw new Invalid("Sezione del link non valida.");
    const id = typeof l.id === "string" && l.id.length > 0 && l.id.length <= 64 ? l.id : `link-${i + 1}`;
    const order = Number.isInteger(l.order) ? (l.order as number) : i;
    const visible = typeof l.visible === "boolean" ? l.visible : true;
    return { id, label, url, section, visible, order };
  });
  return { tagline, links };
}

// ---------------------------------------------------------------------- GET

async function handleGet(req: HandlerRequest): Promise<HandlerResponse> {
  const p = prisma();
  const path = req.path;
  const token = parseCookie(req.headers.cookie, "crm_session");

  if (path === "/") return serveEditablePage("index.html", await editorSession(token));
  if (path === "/bio") return serveEditablePage("bio.html", await editorSession(token));

  const staticResponse = serveStatic(path);
  if (staticResponse) return staticResponse;

  if (path === "/api/session") {
    return send({ setup: !(await hasPassword()), authenticated: await auth(parseCookie(req.headers.cookie, "crm_session")) });
  }

  if (path === "/api/webhooks/whatsapp") return metaVerification(req, "whatsapp");
  if (path === "/api/webhooks/instagram") return metaVerification(req, "instagram");

  if (path.startsWith("/api/booking/")) {
    const slug = path.split("/").pop()!;
    const s = await settings();
    if (slug !== s.booking_slug) return sendError(404, "Pagina non trovata.");
    const info: Record<string, unknown> = {
      business_name: s.business_name,
      booking_title: s.booking_title,
      booking_description: s.booking_description,
      booking_duration: s.booking_duration,
      booking_enabled: s.booking_enabled,
      booking_horizon: s.booking_horizon,
      timezone: "Europe/Rome",
    };
    const day = parseQuery(req.query).get("day");
    if (day) info.slots = await available(day);
    return send(info);
  }

  if (path === "/api/site") {
    const s = await settings();
    return send({
      booking_path: `/book/${s.booking_slug}`,
      bio: await getBio(),
      content: await getSiteContent(),
    });
  }

  if (!(await auth(token))) return sendError(401, "Accedi per continuare.");

  if (path === "/api/channels") {
    const [channels, assistant, knowledge] = await Promise.all([
      listChannels(),
      assistantSettings(),
      knowledgeSummary(),
    ]);
    return send({
      channels,
      assistant,
      knowledge,
      webhooks: Object.fromEntries(PROVIDERS.map((p) => [p.id, originOf(req) + p.webhook])),
    });
  }

  const conversationMatch = /^\/api\/conversations\/(\d+)$/.exec(path);
  if (conversationMatch) return send(await conversationThread(Number(conversationMatch[1])));

  if (path === "/api/ricevute") return send(await listReceipts());

  if (path === "/api/estimates/catalog") return send(CATALOG);

  if (path === "/api/notes") return send({ notes: await listNotes() });

  if (path === "/api/events") {
    const { from, to } = parseRange(parseQuery(req.query));
    return send({ events: await listEvents(from, to) });
  }

  if (path === "/api/integrations/status") return send(await integrationStatus());

  if (path === "/api/email/inbox") return send(await readInbox());

  if (path === "/api/integrations/google/connect") {
    return send({ url: await googleConnectUrl(originOf(req)) });
  }

  if (path === "/api/integrations/google/callback") {
    const q = parseQuery(req.query);
    if (q.get("error")) return sendError(403, "Autorizzazione Google annullata.");
    const saved = await googleCallback(q, originOf(req));
    if (!saved) return sendError(403, "Stato OAuth non valido.");
    return send("", 302, "text/plain; charset=utf-8", [["Location", "/app?view=settings&linked=google"]]);
  }

  if (path === "/api/state") {
    const [clients, projects, quotes, invoices, documents, appointments, blocks] = await Promise.all([
      p.client.findMany({ orderBy: { id: "desc" } }),
      p.project.findMany({ orderBy: { id: "desc" } }),
      p.quote.findMany({ orderBy: { id: "desc" } }),
      p.invoice.findMany({ orderBy: { id: "desc" } }),
      p.document.findMany({ orderBy: { id: "desc" } }),
      p.appointment.findMany({ orderBy: { id: "desc" } }),
      p.block.findMany({ orderBy: { id: "desc" } }),
    ]);
    for (const q of quotes) {
      q.items = JSON.parse(q.items as string) as any;
      q.estimate = q.estimate ? (JSON.parse(q.estimate) as any) : null;
    }
    const invoiceRows = invoices.map((inv) => {
      const row: Record<string, unknown> = { ...inv };
      row.snapshot = JSON.parse(inv.snapshot as string);
      row.xml_generated = inv.xml !== null;
      delete row.xml;
      return row;
    });
    const [channels, conversations, assistant, knowledge] = await Promise.all([
      listChannels(),
      listConversations(),
      assistantSettings(),
      knowledgeSummary(),
    ]);
    return send({
      clients,
      projects,
      quotes,
      invoices: invoiceRows,
      documents,
      appointments,
      blocks,
      notes: await p.note.findMany({ orderBy: [{ pinned: "desc" }, { updated_at: "desc" }] }),
      integrations: await integrationStatus(),
      settings: await settings(),
      fiscal_catalog: fiscal.catalog(),
      channels,
      conversations,
      assistant,
      knowledge,
    });
  }

  const invoiceFiscal = /^\/api\/invoices\/(\d+)\/fiscal$/.exec(path);
  if (invoiceFiscal) {
    const inv = await p.invoice.findUnique({ where: { id: Number(invoiceFiscal[1]) } });
    if (!inv) throw new Invalid("Elemento non trovato.");
    const snapshot = JSON.parse(inv.snapshot) as any;
    const project = await p.project.findUnique({ where: { id: inv.project_id } });
    if (!project) throw new Invalid("Elemento non trovato.");
    const client = await p.client.findUnique({ where: { id: project.client_id } });
    if (!client) throw new Invalid("Elemento non trovato.");
    const s = await settings();
    return send({
      business: s,
      client,
      items: snapshot.items,
      config: fiscal.defaults(s, snapshot.items, inv.due_date),
      profile_errors: fiscal.profileErrors(s, client),
    });
  }

  const invoiceXml = /^\/api\/invoices\/(\d+)\/xml$/.exec(path);
  if (invoiceXml) {
    const inv = await p.invoice.findUnique({ where: { id: Number(invoiceXml[1]) } });
    if (!inv) throw new Invalid("Elemento non trovato.");
    if (!inv.xml) throw new Invalid("Questa fattura non ha ancora un XML validato.");
    return send(Buffer.from(inv.xml), 200, "application/xml; charset=utf-8", [
      ["Content-Disposition", `attachment; filename="${inv.xml_filename}"`],
    ]);
  }

  if (path.startsWith("/api/documents/")) {
    const id = Number(path.split("/").pop());
    const doc = await p.document.findUnique({ where: { id } });
    if (!doc) throw new Invalid("Elemento non trovato.");
    const encoded = encodeURIComponent(doc.name).replace(
      /['()*]/g,
      (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase(),
    );
    return send(Buffer.from(doc.content), 200, "application/octet-stream", [
      ["Content-Disposition", `attachment; filename*=UTF-8''${encoded}`],
    ]);
  }

  if (path === "/api/backup") {
    const zip = await buildBackup();
    return send(zip, 200, "application/zip", [
      ["Content-Disposition", 'attachment; filename="realindi-backup.zip"'],
    ]);
  }

  return sendError(404, "Risorsa non trovata.");
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";
}

function jsonBody(req: HandlerRequest): Record<string, unknown> {
  const ct = (req.headers["content-type"] ?? "").split(";")[0];
  if (ct !== "application/json") throw new Invalid("Inviare dati JSON.");
  const headerLength = req.headers["content-length"];
  const length = headerLength !== undefined ? Number(headerLength) : req.body.length;
  if (!(length >= 1) || length > 15 * 1024 * 1024) {
    throw new Invalid("Richiesta troppo grande o vuota (documenti massimo 10 MB).");
  }
  const parsed: unknown = JSON.parse(req.body.toString("utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Invalid("Richiesta non valida.");
  }
  return parsed as Record<string, unknown>;
}

/** public_url() di app.py: solo origini https (o localhost in http), senza percorso. */
function publicUrl(value: unknown): string {
  let v = String(value ?? "").trim().replace(/\/+$/, "");
  if (!v) return "";
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new Invalid("Indirizzo pubblico non valido: usa il formato https://prenotazioni.esempio.it, senza percorso.");
  }
  const pathEmpty = u.pathname === "" || u.pathname === "/";
  if (
    (u.protocol !== "https:" && u.protocol !== "http:") ||
    !u.hostname ||
    !pathEmpty ||
    u.search ||
    u.hash ||
    u.username ||
    u.password
  ) {
    throw new Invalid("Indirizzo pubblico non valido: usa il formato https://prenotazioni.esempio.it, senza percorso.");
  }
  if (u.protocol === "http:" && u.hostname !== "127.0.0.1" && u.hostname !== "localhost") {
    throw new Invalid("Usa un indirizzo HTTPS: i clienti inseriscono dati personali.");
  }
  return v;
}

const ASSISTANT_SETTINGS_KEYS = [
  "assistant_enabled",
  "assistant_name",
  "assistant_tone",
  "assistant_language",
  "assistant_signature",
  "assistant_notes",
  "assistant_site_url",
  "assistant_model",
  "assistant_base_url",
  "assistant_max_chars",
  "assistant_handoff_email",
] as const;

const INTEGER_SETTINGS: Record<string, [number, number]> = {
  booking_duration: [15, 180],
  booking_start: [0, 23],
  booking_end: [1, 23],
  booking_notice: [0, 720],
  booking_horizon: [1, 180],
};

// ------------------------------------------------------------ webhook canali

function twimlResponse(): HandlerResponse {
  return send(
    Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', "utf8"),
    200,
    "text/xml; charset=utf-8",
  );
}

/** Handshake di Meta: confronta hub.verify_token con quello dei canali salvati. */
async function metaVerification(
  req: HandlerRequest,
  provider: "whatsapp" | "instagram",
): Promise<HandlerResponse> {
  const q = parseQuery(req.query);
  if (q.get("hub.mode") !== "subscribe") {
    return sendError(400, "Verifica webhook non valida.");
  }
  const token = q.get("hub.verify_token") ?? "";
  const channels = await prisma().channel.findMany({ where: { provider } });
  const match = channels.some((channel) => {
    const expected = channelCredentials(channel).verify_token ?? "";
    return expected.length > 0 && timingSafeEqualStr(expected, token);
  });
  if (!match) return sendError(403, "Token di verifica non valido.");
  return send(q.get("hub.challenge") ?? "", 200, "text/plain; charset=utf-8");
}

async function receiveMetaWebhook(
  req: HandlerRequest,
  provider: "whatsapp" | "instagram",
): Promise<HandlerResponse> {
  if (req.body.length > 1_000_000) return sendError(413, "Payload troppo grande.");
  let payload: unknown;
  try {
    payload = JSON.parse(req.body.toString("utf8"));
  } catch {
    return sendError(400, "Payload non valido.");
  }

  const p = prisma();
  const channels = await p.channel.findMany({ where: { provider } });
  if (!channels.length) return send({ ok: true });

  const appSecret = channels
    .map((channel) => channelCredentials(channel).app_secret ?? "")
    .find((secret) => secret.length > 0) ?? "";
  if (appSecret && !verifyMetaSignature(req.body, req.headers["x-hub-signature-256"], appSecret)) {
    return sendError(403, "Firma del webhook non valida.");
  }

  const events = provider === "whatsapp" ? parseWhatsAppWebhook(payload) : parseInstagramWebhook(payload);
  for (const event of events.slice(0, 10)) {
    const channel = channels.find((row) => row.external_id === event.externalChannelId);
    if (!channel) continue;
    try {
      await ingestInbound({
        channel,
        contact: event.contact,
        contactName: event.contactName,
        text: event.text,
        externalId: event.externalId,
        kind: event.kind,
      });
    } catch (err) {
      console.error(`Webhook ${provider}:`, err);
    }
  }
  return send({ ok: true });
}

async function receiveTwilioWebhook(req: HandlerRequest): Promise<HandlerResponse> {
  const params: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(req.body.toString("utf8"))) {
    params[key] = value;
  }
  const channels = await prisma().channel.findMany({ where: { provider: "sms" } });
  if (!channels.length) return twimlResponse();

  const to = normalizePhone(params.To ?? "");
  const channel = channels.find((row) => row.external_id === to) ?? channels[0];
  const authToken = channelCredentials(channel).auth_token ?? "";
  if (authToken) {
    const url = originOf(req) + req.path + (req.query ? `?${req.query}` : "");
    if (!verifyTwilioSignature(url, params, req.headers["x-twilio-signature"], authToken)) {
      return sendError(403, "Firma del webhook non valida.");
    }
  }

  const from = normalizePhone(params.From ?? "");
  const body = params.Body ?? "";
  if (from && body.trim()) {
    try {
      await ingestInbound({
        channel,
        contact: from,
        text: body,
        externalId: params.MessageSid,
        kind: "text",
      });
    } catch (err) {
      console.error("Webhook sms:", err);
    }
  }
  return twimlResponse();
}

async function handleWebhookPost(req: HandlerRequest): Promise<HandlerResponse | null> {
  if (req.path === "/api/webhooks/whatsapp") return receiveMetaWebhook(req, "whatsapp");
  if (req.path === "/api/webhooks/instagram") return receiveMetaWebhook(req, "instagram");
  if (req.path === "/api/webhooks/sms") return receiveTwilioWebhook(req);
  return null;
}

const CLIENT_LIST_FIELDS = ["company", "phone", "vat_number", "address", "notes"];
const PROJECT_STATUSES = ["discovery", "active", "paused", "completed"];

async function handlePost(req: HandlerRequest): Promise<HandlerResponse> {
  // Controlli di origine (stessi di do_POST).
  const origin = req.headers.origin;
  if (origin) {
    let originHost = "";
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = "";
    }
    if (originHost !== (req.headers.host ?? "")) {
      return sendError(403, "Origine non consentita.");
    }
  }
  if (req.headers["sec-fetch-site"] === "cross-site") {
    return sendError(403, "Origine non consentita.");
  }
  const webhook = await handleWebhookPost(req);
  if (webhook) return webhook;
  const d = jsonBody(req);
  const path = req.path;
  const p = prisma();

  // ------------------------------------------------------------ pubblici
  if (path === "/api/setup" || path === "/api/login") {
    const password = requiredField(d, "password", 256);
    if (path === "/api/setup") {
      if (await hasPassword()) throw new Invalid("Configurazione già completata.");
      if (password.length < 12) throw new Invalid("Usa una password di almeno 12 caratteri.");
      try {
        const res = await setupPassword(password);
        return send({ ok: true }, 200, "application/json; charset=utf-8", [["Set-Cookie", res.cookie]]);
      } catch (err) {
        // Setup arrivato mentre un altro stava già configurando l'account.
        if ((err as Error).message === "ALREADY_SET") throw new Invalid("Configurazione già completata.");
        throw err;
      }
    }
    try {
      const res = await verifyLogin(req.ip, password);
      return send({ ok: true }, 200, "application/json; charset=utf-8", [["Set-Cookie", res.cookie]]);
    } catch (err) {
      const code = (err as Error).message;
      if (code === "NO_PASSWORD") throw new Invalid("Configura prima il tuo account.");
      if (code === "RATE_LIMITED") throw new Invalid("Troppi tentativi. Riprova tra 15 minuti.");
      if (code === "BAD_PASSWORD") throw new Invalid("Password non corretta.");
      throw err;
    }
  }

  if (path.startsWith("/api/booking/")) {
    const slug = path.split("/").pop()!;
    const result = await createAppointment(slug, d);
    return send({ ok: true, ...result });
  }

  if (path === "/api/cancel-booking") {
    const token = requiredField(d, "token");
    const found = await p.appointment.findUnique({ where: { cancel_token: token } });
    if (!found) throw new Invalid("Prenotazione non trovata.");
    await p.appointment.update({ where: { id: found.id }, data: { status: "cancelled" } });
    const linked = await p.calendarEvent.findFirst({
      where: { appointment_id: found.id, deleted_at: null },
    });
    if (linked) {
      const stamp = utcStamp();
      await p.calendarEvent.update({
        where: { id: linked.id },
        data: { deleted_at: stamp, updated_at: BigInt(Date.now()), dirty: true },
      });
      await p.eventLink.updateMany({
        where: { event_id: linked.id },
        data: { dirty: true, deleted_at: stamp },
      });
    }
    return send({ ok: true });
  }

  // ------------------------------------------------------------ autenticati
  const sessionToken = parseCookie(req.headers.cookie, "crm_session");
  if (!(await auth(sessionToken))) throw new Invalid("Sessione scaduta. Accedi di nuovo.");

  // --------------------------------------------------------- canali e assistente
  if (path === "/api/channels") {
    return send({ ok: true, ...(await saveChannel(d)) });
  }

  if (path === "/api/channels/delete") {
    const id = intId(d.id);
    const found = await p.channel.findUnique({ where: { id } });
    if (!found) throw new Invalid("Canale non trovato.");
    const conversations = await p.conversation.findMany({ where: { channel_id: id }, select: { id: true } });
    const ids = conversations.map((c) => c.id);
    if (ids.length) await p.message.deleteMany({ where: { conversation_id: { in: ids } } });
    await p.conversation.deleteMany({ where: { channel_id: id } });
    await p.channel.delete({ where: { id } });
    return send({ ok: true });
  }

  if (path === "/api/channels/verify") {
    const id = intId(d.id);
    const channel = await p.channel.findUnique({ where: { id } });
    if (!channel) throw new Invalid("Canale non trovato.");
    const verification = await verifyChannel(channel);
    return send({ ok: verification.ok, verification });
  }

  if (path === "/api/channels/test") {
    const id = intId(d.id);
    const channel = await p.channel.findUnique({ where: { id } });
    if (!channel) throw new Invalid("Canale non trovato.");
    const to = typeof d.to === "string" ? d.to.trim() : "";
    if (!to) throw new Invalid("Indica il destinatario del messaggio di prova.");
    const message =
      typeof d.text === "string" && d.text.trim()
        ? d.text.trim().slice(0, 1000)
        : "Messaggio di prova dal CRM REALINDI. Se lo ricevi, il canale è collegato correttamente.";
    try {
      const sent = await sendChannelMessage(channel, to, message);
      return send({ ok: true, ...sent });
    } catch (err) {
      throw new Invalid(err instanceof Error ? err.message : "Invio di prova non riuscito.");
    }
  }

  if (path === "/api/assistant") {
    const s = await settings();
    if ("assistant_enabled" in d) {
      if (typeof d.assistant_enabled !== "boolean") throw new Invalid("Attivazione assistente non valida.");
      s.assistant_enabled = d.assistant_enabled;
    }
    const textKeys: [string, number][] = [
      ["assistant_name", 80],
      ["assistant_tone", 40],
      ["assistant_language", 20],
      ["assistant_signature", 200],
      ["assistant_notes", 8000],
      ["assistant_model", 100],
      ["assistant_handoff_email", 200],
    ];
    for (const [key, max] of textKeys) {
      if (!(key in d)) continue;
      if (typeof d[key] !== "string") throw new Invalid("Valore non valido.");
      s[key] = (d[key] as string).trim().slice(0, max);
    }
    if ("assistant_max_chars" in d) {
      const n = numberValue(d.assistant_max_chars, 200, 2000);
      if (!n.isInteger()) throw new Invalid("La lunghezza massima deve essere un numero intero.");
      s.assistant_max_chars = n.toNumber();
    }
    for (const key of ["assistant_base_url", "assistant_site_url"] as const) {
      if (!(key in d)) continue;
      const raw = typeof d[key] === "string" ? (d[key] as string).trim() : "";
      if (!raw) {
        s[key] = "";
        continue;
      }
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        throw new Invalid("Indirizzo non valido: usa un URL completo (https://…).");
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Invalid("L'indirizzo deve usare http o https.");
      }
      s[key] = url.toString().replace(/\/+$/, "");
    }
    if (
      typeof s.assistant_handoff_email === "string" &&
      s.assistant_handoff_email &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.assistant_handoff_email)
    ) {
      throw new Invalid("Email di recapito non valida.");
    }
    for (const key of ASSISTANT_SETTINGS_KEYS) {
      await p.setting.upsert({
        where: { key },
        update: { value: JSON.stringify(s[key]) },
        create: { key, value: JSON.stringify(s[key]) },
      });
    }
    if (d.remove_key === true) await saveAssistantKey("");
    if (typeof d.api_key === "string" && d.api_key.trim()) await saveAssistantKey(d.api_key);
    return send({ ok: true, assistant: await assistantSettings() });
  }

  if (path === "/api/assistant/train") {
    let explicit = "";
    if (typeof d.site_url === "string" && d.site_url.trim()) {
      let url: URL;
      try {
        url = new URL(d.site_url.trim());
      } catch {
        throw new Invalid("Indirizzo del sito non valido.");
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Invalid("Il sito deve usare http o https.");
      }
      explicit = url.toString().replace(/\/+$/, "");
      await p.setting.upsert({
        where: { key: "assistant_site_url" },
        update: { value: JSON.stringify(explicit) },
        create: { key: "assistant_site_url", value: JSON.stringify(explicit) },
      });
    }
    const result = await trainFromSite(requestOrigin(req), explicit || undefined);
    return send({ ok: true, ...result, assistant: await assistantSettings() });
  }

  if (path === "/api/assistant/preview") {
    const text = typeof d.text === "string" ? d.text.trim() : "";
    if (!text) throw new Invalid("Scrivi un messaggio: l'assistente risponderà come farebbe con un cliente.");
    const result = await generateReply({ channel: "chat di prova", text, contactName: "Cliente di prova" });
    return send({ ok: true, ...result });
  }

  if (path === "/api/conversations/reply") {
    const message = await sendManualReply(intId(d.id), typeof d.body === "string" ? d.body : "");
    return send({ ok: true, message });
  }

  if (path === "/api/conversations/state") {
    const patch: { auto_reply?: boolean; status?: string; read?: boolean } = {};
    if (typeof d.auto_reply === "boolean") patch.auto_reply = d.auto_reply;
    if (typeof d.status === "string") patch.status = d.status;
    if (d.read === true) patch.read = true;
    return send({ ok: true, conversation: await setConversationState(intId(d.id), patch) });
  }

  if (path === "/api/site") {
    const saved: { bio?: Bio; content?: SiteContent } = {};
    // Ogni parte si salva per intero: il record precedente viene eliminato prima
    // di scrivere il nuovo, quindi un campo omesso non recupera il vecchio valore.
    if ("content" in d) {
      const content = validateSiteContent(d.content);
      await replaceSetting("site_content", content);
      saved.content = content;
    }
    if ("bio" in d) {
      const bio = validateBio(d.bio);
      await replaceSetting("site_bio", bio);
      saved.bio = bio;
    }
    if (!saved.content && !saved.bio) throw new Invalid("Nessun contenuto da salvare.");
    return send({ ok: true, ...saved });
  }

  if (path === "/api/ricevute") {
    const emitted = await emitReceipt(validateReceiptFields(d));
    return send({ receipt: emitted });
  }

  if (path === "/api/notes") {
    const fields = validateNoteFields(d);
    await ensureReferencesExist(fields);
    if (d.id === undefined) {
      const created = await p.note.create({ data: fields });
      return send({ id: created.id });
    }
    const id = intId(d.id);
    const existing = await p.note.findUnique({ where: { id } });
    if (!existing) return sendError(404, "Nota non trovata.");
    await p.note.update({ where: { id }, data: { ...fields, updated_at: utcStamp() } });
    return send({ ok: true });
  }

  if (path === "/api/notes/delete") {
    const id = intId(d.id);
    const existing = await p.note.findUnique({ where: { id } });
    if (!existing) return sendError(404, "Nota non trovata.");
    await p.note.delete({ where: { id } });
    return send({ ok: true });
  }

  if (path === "/api/events") {
    const fields = validateEventFields(d);
    if (d.id === undefined) {
      const created = await p.calendarEvent.create({
        data: { ...fields, updated_at: BigInt(Date.now()), dirty: true },
      });
      return send({ id: created.id });
    }
    const id = intId(d.id);
    const existing = await p.calendarEvent.findUnique({ where: { id } });
    if (!existing || existing.deleted_at) return sendError(404, "Evento non trovato.");
    await p.calendarEvent.update({
      where: { id },
      data: { ...fields, updated_at: BigInt(Date.now()), dirty: true },
    });
    return send({ ok: true });
  }

  if (path === "/api/events/delete") {
    const id = intId(d.id);
    const existing = await p.calendarEvent.findUnique({ where: { id } });
    if (!existing || existing.deleted_at) return sendError(404, "Evento non trovato.");
    const stamp = utcStamp();
    await p.calendarEvent.update({
      where: { id },
      data: { deleted_at: stamp, updated_at: BigInt(Date.now()), dirty: true },
    });
    await p.eventLink.updateMany({
      where: { event_id: id },
      data: { dirty: true, deleted_at: stamp },
    });
    return send({ ok: true });
  }

  if (path === "/api/integrations/apple") {
    const appleId = String(d.apple_id ?? "").trim();
    const appPassword = typeof d.app_password === "string" ? d.app_password : "";
    const sender = String(d.sender_email ?? "").trim();
    if (!appleId || !appPassword) throw new Invalid("Inserisci Apple ID e password specifica.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender)) throw new Invalid("Indirizzo mittente non valido.");
    try {
      await saveApple(appleId, appPassword, sender);
    } catch (err) {
      if (err instanceof Invalid) throw err;
      throw new Invalid("Credenziali Apple non valide.");
    }
    return send({ ok: true });
  }

  if (path === "/api/integrations/apple/delete") {
    await removeApple();
    return send({ ok: true });
  }

  if (path === "/api/sync/calendar") {
    return send(await runSync());
  }

  if (path === "/api/email/send") {
    const mail = validateOutgoing(d);
    try {
      await sendMail(mail);
    } catch (err) {
      if (err instanceof Invalid) throw err;
      return sendError(502, "Invio email fallito: riprova più tardi.");
    }
    return send({ ok: true });
  }

  if (path === "/api/logout") {
    await destroySession(sessionToken);
    return send({ ok: true }, 200, "application/json; charset=utf-8", [["Set-Cookie", CLEAR_COOKIE]]);
  }

  if (path === "/api/settings") {
    const s = await settings();
    for (const k of Object.keys(DEFAULTS)) {
      if (!(k in d)) continue;
      if (k in INTEGER_SETTINGS) {
        const [min, max] = INTEGER_SETTINGS[k];
        const n = numberValue(d[k], min, max);
        if (!n.isInteger()) throw new Invalid("Inserisci un numero intero.");
        s[k] = n.toNumber();
      } else if (k === "booking_days") {
        const days = d[k];
        if (
          !Array.isArray(days) ||
          !days.every((x) => typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= 6)
        ) {
          throw new Invalid("Giorni non validi.");
        }
        s[k] = [...new Set(days as number[])].sort((a, b) => a - b);
      } else if (k === "booking_enabled") {
        if (typeof d[k] !== "boolean") throw new Invalid("Disponibilità non valida.");
        s[k] = d[k];
      } else if (k === "vat_rate" || k === "hourly_rate") {
        s[k] = numberValue(d[k], 0, k === "vat_rate" ? 100 : 100000).toString();
      } else if (k === "public_url") {
        s[k] = publicUrl(d[k]);
      } else {
        s[k] = optionalField(d, k);
      }
    }
    if (
      Number(s.booking_start) >= Number(s.booking_end) ||
      ("business_name" in d && !s.business_name)
    ) {
      throw new Invalid("Controlla nome attività e orari di disponibilità.");
    }
    for (const k of Object.keys(DEFAULTS)) {
      await p.setting.upsert({
        where: { key: k },
        create: { key: k, value: JSON.stringify(s[k]) },
        update: { value: JSON.stringify(s[k]) },
      });
    }
    return send({ ok: true });
  }

  if (path === "/api/clients") {
    const name = requiredField(d, "name");
    const mail = emailField(d);
    const values = {
      name,
      email: mail,
      company: optionalField(d, "company"),
      phone: optionalField(d, "phone"),
      vat_number: optionalField(d, "vat_number"),
      address: optionalField(d, "address"),
      notes: optionalField(d, "notes"),
    };
    const fiscalExtra: Record<string, string> = {};
    for (const key of fiscal.CLIENT_FIELDS) {
      if (key in d) fiscalExtra[key] = optionalField(d, key, 200);
    }
    if (d.id) {
      const id = Number(d.id);
      const existing = Number.isInteger(id)
        ? await p.client.findUnique({ where: { id } })
        : null;
      if (!existing) throw new Invalid("Elemento non trovato.");
      await p.client.update({ where: { id }, data: { ...values, ...fiscalExtra } });
      return send({ id });
    }
    const created = await p.client.create({ data: { ...values, ...fiscalExtra } });
    return send({ id: created.id });
  }

  if (path === "/api/projects") {
    const clientId = Number(d.client_id);
    const client = Number.isInteger(clientId)
      ? await p.client.findUnique({ where: { id: clientId } })
      : null;
    if (!client) throw new Invalid("Elemento non trovato.");
    const status = String(d.status ?? "discovery");
    if (!PROJECT_STATUSES.includes(status)) throw new Invalid("Stato progetto non valido.");
    const deadline = d.deadline ? checkDateField(d.deadline) : "";
    const values = {
      client_id: clientId,
      title: requiredField(d, "title"),
      description: optionalField(d, "description"),
      status,
      deadline,
    };
    if (d.id) {
      const id = Number(d.id);
      const old = Number.isInteger(id) ? await p.project.findUnique({ where: { id } }) : null;
      if (!old) throw new Invalid("Elemento non trovato.");
      if (String(old.client_id) !== String(d.client_id)) {
        throw new Invalid("Il cliente del progetto non può essere cambiato.");
      }
      await p.project.update({ where: { id }, data: values });
      return send({ id });
    }
    const created = await p.project.create({ data: values });
    return send({ id: created.id });
  }

  return await handlePostRest(req, d, path, sessionToken);
}

async function handlePostRest(
  req: HandlerRequest,
  d: Record<string, unknown>,
  path: string,
  sessionToken: string | null,
): Promise<HandlerResponse> {
  const p = prisma();

  if (path === "/api/estimates/preview" || path === "/api/estimates") {
    const projectId = Number(d.project_id);
    const project = Number.isInteger(projectId)
      ? await p.project.findUnique({ where: { id: projectId } })
      : null;
    if (!project) throw new Invalid("Elemento non trovato.");
    let key: string | null = null;
    if (path === "/api/estimates") {
      key = requiredField(d, "generation_key", 80);
      if (!/^[a-zA-Z0-9_-]{16,80}$/.test(key)) {
        throw new Invalid("Identificativo di generazione non valido.");
      }
      const previous = await p.quote.findUnique({ where: { generation_key: key } });
      if (previous) {
        if (previous.project_id !== project.id) {
          throw new Invalid("La richiesta appartiene a un altro progetto.");
        }
        return send({ id: previous.id });
      }
    }
    const s = await settings();
    const est = estimate(
      d.scope,
      "rate" in d ? d.rate : s.hourly_rate,
    );
    const result = calculate(est.items as Record<string, unknown>[],
      "vat_rate" in d ? d.vat_rate : s.vat_rate);
    Object.assign(est, result);
    est.project = {
      id: project.id,
      title: project.title,
      description: project.description,
      deadline: project.deadline,
    };
    est.created_at = isoNow();
    if (path === "/api/estimates/preview") return send(est);

    const validUntil = checkDateField(d.valid_until);
    if (validUntil < dateRome(new Date())) {
      throw new Invalid("La validità del nuovo preventivo non può essere nel passato.");
    }
    const title = requiredField(d, "title");
    let notes = optionalField(d, "notes");
    const brief = project.description;
    const context = brief ? `Perimetro concordato: ${brief}\n\n` : "";
    const assumptions = (est.assumptions as string[]).join("\n");
    notes = context + assumptions + (notes ? `\n\n${notes}` : "");
    const data = {
      project_id: project.id,
      title,
      items: JSON.stringify(result.items),
      subtotal: result.subtotal,
      vat: result.vat,
      total: result.total,
      vat_rate: result.vat_rate,
      valid_until: validUntil,
      notes,
      estimate: JSON.stringify(est),
      generation_key: key,
    };
    try {
      const created = await p.quote.create({ data });
      return send({ id: created.id });
    } catch (err) {
      // Corsa su generation_key identico: la seconda richiesta riceve lo stesso preventivo.
      if (isUniqueViolation(err) && key) {
        const previous = await p.quote.findUnique({ where: { generation_key: key } });
        if (previous) {
          if (previous.project_id !== project.id) {
            throw new Invalid("La richiesta appartiene a un altro progetto.");
          }
          return send({ id: previous.id });
        }
      }
      throw err;
    }
  }

  if (path === "/api/quotes/calculate") {
    const s = await settings();
    return send(
      calculate(d.items as Record<string, unknown>[], "vat_rate" in d ? d.vat_rate : s.vat_rate),
    );
  }

  if (path === "/api/quotes") {
    const projectId = Number(d.project_id);
    const project = Number.isInteger(projectId)
      ? await p.project.findUnique({ where: { id: projectId } })
      : null;
    if (!project) throw new Invalid("Elemento non trovato.");
    const s = await settings();
    const calc = calculate(
      d.items as Record<string, unknown>[],
      "vat_rate" in d ? d.vat_rate : s.vat_rate,
    );
    const values = {
      project_id: project.id,
      title: requiredField(d, "title"),
      items: JSON.stringify(calc.items),
      subtotal: calc.subtotal,
      vat: calc.vat,
      total: calc.total,
      vat_rate: calc.vat_rate,
      valid_until: checkDateField(d.valid_until),
      notes: optionalField(d, "notes", 15000),
    };
    if (d.id) {
      const id = Number(d.id);
      const q = Number.isInteger(id) ? await p.quote.findUnique({ where: { id } }) : null;
      if (!q) throw new Invalid("Elemento non trovato.");
      if (q.estimate && String(q.project_id) !== String(d.project_id)) {
        throw new Invalid("Il preventivo stimato deve restare associato al progetto di origine.");
      }
      if (q.status !== "draft") {
        throw new Invalid("Puoi modificare soltanto preventivi in bozza.");
      }
      await p.quote.update({ where: { id }, data: values });
      return send({ id });
    }
    const created = await p.quote.create({ data: values });
    return send({ id: created.id });
  }

  if (path === "/api/quotes/status") {
    const id = Number(d.id);
    const q = Number.isInteger(id) ? await p.quote.findUnique({ where: { id } }) : null;
    if (!q) throw new Invalid("Elemento non trovato.");
    const status = String(d.status ?? "");
    const allowed: Record<string, string[]> = {
      draft: ["sent", "accepted", "rejected"],
      sent: ["accepted", "rejected"],
      accepted: [],
      rejected: [],
    };
    if (!allowed[q.status] || !allowed[q.status].includes(status)) {
      throw new Invalid("Cambio di stato non consentito.");
    }
    const dueDate = plusDaysRome(30);
    await p.$transaction(async (tx) => {
      await tx.quote.update({ where: { id: q.id }, data: { status } });
      if (status === "accepted") {
        const project = await tx.project.findUnique({ where: { id: q.project_id } });
        if (!project) throw new Invalid("Elemento non trovato.");
        const client = await tx.client.findUnique({ where: { id: project.client_id } });
        if (!client) throw new Invalid("Elemento non trovato.");
        const snapshot = {
          client,
          business: await settings(),
          title: q.title,
          items: JSON.parse(q.items),
          vat_rate: q.vat_rate,
          notes: q.notes,
        };
        await tx.invoice.create({
          data: {
            quote_id: q.id,
            project_id: project.id,
            snapshot: JSON.stringify(snapshot),
            subtotal: q.subtotal,
            vat: q.vat,
            total: q.total,
            due_date: dueDate,
          },
        });
        await tx.project.updateMany({
          where: { id: project.id, status: "discovery" },
          data: { status: "active" },
        });
      }
    });
    return send({ ok: true });
  }

  return await handlePostFiscal(req, d, path);
}

/** json.dumps(..., sort_keys=True): canonico e determinante per il review_hash. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
}

async function handlePostFiscal(
  _req: HandlerRequest,
  d: Record<string, unknown>,
  path: string,
): Promise<HandlerResponse> {
  const p = prisma();

  if (path === "/api/invoices/fiscal-check" || path === "/api/invoices/finalize") {
    const isFinalize = path.endsWith("/finalize");
    const id = Number(d.id);
    const inv = Number.isInteger(id) ? await p.invoice.findUnique({ where: { id } }) : null;
    if (!inv) throw new Invalid("Elemento non trovato.");
    if (isFinalize && inv.xml) {
      return send({ id: inv.id, filename: inv.xml_filename });
    }
    if (inv.status !== "draft") {
      throw new Invalid("La fattura è già numerata. I documenti storici non vengono rigenerati.");
    }
    const config = d.config as Record<string, any> | undefined;
    const snapshot = JSON.parse(inv.snapshot) as Record<string, any>;
    const s = await settings();
    const project = await p.project.findUnique({ where: { id: inv.project_id } });
    if (!project) throw new Invalid("Elemento non trovato.");
    const client = await p.client.findUnique({ where: { id: project.client_id } });
    if (!client) throw new Invalid("Elemento non trovato.");
    const isDict = typeof config === "object" && config !== null && !Array.isArray(config);
    const year = isDict
      ? checkDateField(config!.document_date).slice(0, 4)
      : String(todayRome(new Date()).y);
    const issued = await p.invoice.findMany({
      where: { number: { startsWith: `${year}/` } },
      select: { number: true, issued_at: true },
    });
    let last = 0;
    for (const row of issued) {
      const suffix = (row.number ?? "").split("/")[1] ?? "";
      if (/^\d+$/.test(suffix)) last = Math.max(last, Number(suffix));
    }
    const nextNumber = `${year}/${String(last + 1).padStart(5, "0")}`;

    let report: Record<string, any>;
    let xml: Buffer;
    try {
      const progressive = fiscal.fileProgressive(inv.id);
      const prepared = await fiscal.prepare(
        s,
        client,
        snapshot.items,
        config ?? null,
        nextNumber,
        progressive,
      );
      report = prepared.result;
      xml = prepared.xml;
      if (issued.some((r) => r.issued_at && config && r.issued_at > config.document_date)) {
        throw new fiscal.FiscalError(
          "La data documento precede una fattura già numerata nella stessa annualità.",
        );
      }
    } catch (err) {
      if (err instanceof fiscal.FiscalError) {
        if (!isFinalize) return send({ valid: false, errors: err.errors });
        throw new Invalid(err.message);
      }
      throw err;
    }
    const reviewHash = sha256Hex(
      canonicalJson([s, client, snapshot.items, config, report]),
    );
    if (!isFinalize) {
      return send({
        valid: true,
        errors: [],
        report,
        review_hash: reviewHash,
        business: s,
        client,
      });
    }
    if (d.confirmed !== true || d.review_hash !== reviewHash) {
      throw new Invalid("Verifica nuovamente il riepilogo e conferma i dati fiscali aggiornati.");
    }
    snapshot.business = s;
    snapshot.client = client;
    snapshot.fiscal = {
      config,
      report,
      schema: "1.2.3",
      reviewed_at: isoNow(),
    };
    const filename = `IT${s.vat_number}_${fiscal.fileProgressive(inv.id)}.xml`;
    const finalConfig = config!;
    await p.$transaction(async (tx) => {
      // Numerazione serializzata: due finalizzazioni concorrenti non si sovrappongono.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('crm_invoice_number'))`;
      await tx.invoice.update({
        where: { id: inv.id },
        data: {
          status: "issued",
          number: nextNumber,
          issued_at: finalConfig.document_date,
          snapshot: JSON.stringify(snapshot),
          subtotal: report.subtotal,
          vat: report.vat,
          total: report.total,
          due_date: finalConfig.due_date,
          xml: new Uint8Array(xml),
          xml_filename: filename,
        },
      });
    });
    return send({ id: inv.id, filename });
  }

  if (path === "/api/invoices/status") {
    const id = Number(d.id);
    const inv = Number.isInteger(id) ? await p.invoice.findUnique({ where: { id } }) : null;
    if (!inv) throw new Invalid("Elemento non trovato.");
    const status = String(d.status ?? "");
    if (status === "issued") {
      throw new Invalid("Usa la verifica fiscale e la generazione XML per numerare questa fattura.");
    } else if (status === "paid" && inv.status === "issued") {
      await p.invoice.update({
        where: { id: inv.id },
        data: { status: "paid", paid_at: dateRome(new Date()) },
      });
    } else {
      throw new Invalid("Cambio di stato non consentito.");
    }
    return send({ ok: true });
  }

  return handlePostMisc(d, path);
}

/** base64 rigoroso (Node ignora i caratteri invalidi, Python validate=True no). */
function strictBase64(value: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) return null;
  const buf = Buffer.from(value, "base64");
  const roundtrip = buf.toString("base64").replace(/=+$/, "");
  if (roundtrip !== value.replace(/=+$/, "")) return null;
  return buf;
}

// Limite di upload: le funzioni Vercel accettano max 4.5 MB per richiesta
// (il vecchio limite di 10 MB non è più raggiungibile in serverless).
const MAX_DOCUMENT_BYTES = 3 * 1024 * 1024;

async function handlePostMisc(
  d: Record<string, unknown>,
  path: string,
): Promise<HandlerResponse> {
  const p = prisma();

  if (path === "/api/documents") {
    const clientId = Number(d.client_id);
    const client = Number.isInteger(clientId)
      ? await p.client.findUnique({ where: { id: clientId } })
      : null;
    if (!client) throw new Invalid("Elemento non trovato.");
    const rawProject = d.project_id ? Number(d.project_id) : null;
    let projectId: number | null = null;
    if (rawProject) {
      const project = Number.isInteger(rawProject)
        ? await p.project.findUnique({ where: { id: rawProject } })
        : null;
      if (!project) throw new Invalid("Elemento non trovato.");
      if (project.client_id !== client.id) {
        throw new Invalid("Il documento e il progetto devono appartenere allo stesso cliente.");
      }
      projectId = project.id;
    }
    const name = requiredField(d, "name", 200).replace(/\\/g, "/").split("/").pop() ?? "";
    if (!name || [...name].some((ch) => ch.charCodeAt(0) < 32)) {
      throw new Invalid("Nome file non valido.");
    }
    const content = strictBase64(String(d.content ?? ""));
    if (!content) throw new Invalid("File non valido.");
    if (content.length < 1 || content.length > MAX_DOCUMENT_BYTES) {
      throw new Invalid("Il file deve essere tra 1 byte e 3 MB (limite della piattaforma).");
    }
    const storage = tokenHex(24);
    const created = await p.document.create({
      data: {
        client_id: client.id,
        project_id: projectId,
        name,
        storage_name: storage,
        size: content.length,
        sha256: sha256Bytes(content),
        content: new Uint8Array(content),
      },
    });
    return send({ id: created.id });
  }

  if (path === "/api/appointments/cancel") {
    const id = Number(d.id);
    const found = Number.isInteger(id) ? await p.appointment.findUnique({ where: { id } }) : null;
    if (!found) throw new Invalid("Elemento non trovato.");
    await p.appointment.update({ where: { id: found.id }, data: { status: "cancelled" } });
    return send({ ok: true });
  }

  if (path === "/api/blocks") {
    const start = iso(instantField(d.start));
    const end = iso(instantField(d.end));
    if (start >= end) throw new Invalid("La fine deve essere successiva all’inizio.");
    const created = await p.block.create({
      data: { start, end, reason: optionalField(d, "reason") },
    });
    return send({ id: created.id });
  }

  if (path === "/api/blocks/delete") {
    const id = Number(d.id);
    if (Number.isInteger(id)) {
      await p.block.deleteMany({ where: { id } });
    }
    return send({ ok: true });
  }

  throw new Invalid("Operazione non disponibile.");
}

function isoNow(): string {
  return iso(new Date());
}

function plusDaysRome(days: number): string {
  const t = todayRome(new Date());
  return dateUtc(new Date(Date.UTC(t.y, t.m - 1, t.d + days)));
}


export async function handle(req: HandlerRequest): Promise<HandlerResponse> {
  await ensureDefaults();
  try {
    if (req.method === "GET") return await handleGet(req);
    if (req.method === "POST") return await handlePost(req);
    return sendError(404, "Risorsa non trovata.");
  } catch (err) {
    if (err instanceof Invalid) return sendError(400, err.message);
    if (err instanceof BackupTooLarge) return sendError(413, err.message);
    // come (ValueError, TypeError, KeyError) in do_POST
    if (err instanceof fiscal.FiscalError) return sendError(400, "Dati non validi.");
    if (err instanceof SyntaxError || err instanceof TypeError || err instanceof RangeError) {
      return sendError(400, "Dati non validi.");
    }
    // come sqlite3.IntegrityError in do_POST
    if (isUniqueViolation(err)) return sendError(409, "Operazione in conflitto con i dati esistenti.");
    console.error(err);
    return sendError(500, "Errore interno. Riprova.");
  }
}

