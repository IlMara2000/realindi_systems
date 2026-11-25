// Sincronizzazione contatti: iCloud via CardDAV (vCard) e Google via People API.
// - iCloud non ha OAuth né push: discovery per-account, addressbook-query e
//   confronto per ETag; niente webhook, si aggiorna a ogni sync.
// - Google: people.connections.list con syncToken incrementale e 410 GONE che
//   fa ripartire dal pieno, come per il calendario.
// - Deduplica: prima l'identità remota (link), poi l'email, poi il telefono.
//   Il legame al cliente del CRM scatta solo su email o telefono identici.
import { XMLParser } from "fast-xml-parser";
import { prisma } from "./db.js";
import { utcStamp } from "./notes.js";
import { AppleHttpError, appleSyncMessage, integrationStatus } from "./integrations.js";
import { appleCreds, findKey, googleTokens, hrefIn, sanitize } from "./sync.js";
import { Invalid } from "./util.js";

const CONTACTS_ENTRY = "https://contacts.icloud.com/";
const PEOPLE_API = "https://people.googleapis.com/v1";

const xmlParser = new XMLParser({ removeNSPrefix: true, ignoreAttributes: true, parseTagValue: false });

interface AppleCreds {
  apple_id: string;
  app_password: string;
}

function basicAuth(creds: AppleCreds): string {
  return "Basic " + Buffer.from(`${creds.apple_id}:${creds.app_password}`).toString("base64");
}

// ------------------------------------------------------------------- modello

export interface RemoteContact {
  source: "icloud" | "google";
  addressbook: string;
  remote_id: string;
  uid: string;
  display_name: string;
  given_name: string;
  family_name: string;
  org: string;
  job_title: string;
  emails: string[];
  phones: string[];
  notes: string;
  etag: string | null;
  updated_at: number;
  deleted: boolean;
}

export interface ContactsSyncResult {
  imported: number;
  updated: number;
  removed: number;
  linked: number;
  merged: number;
  errors: Array<{ source: string; message: string }>;
}

interface Counters {
  imported: number;
  updated: number;
  removed: number;
  linked: number;
  merged: number;
}

function addError(errors: Array<{ source: string; message: string }>, source: string, err: unknown): void {
  if (errors.some((e) => e.source === source)) return;
  errors.push({ source, message: source === "icloud" ? appleSyncMessage(err) : sanitize(err) });
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** Solo cifre, senza prefisso internazionale: “+39 333 123 4567” → “3331234567”. */
/**
 * Email di un contatto lette dal database, normalizzate come alla scrittura.
 *
 * Il backfill (`npm run db:normalizza-email`) sistema le righe già salvate,
 * ma finché non gira — o se una riga arriva da un backup vecchio — il campo può
 * contenere «Mario@Example.com». Chi cerca e chi confronta deve leggere con la
 * stessa regola con cui si scrive: così `mario@example.com` trova il contatto
 * comunque sia stata salvata la maiuscola, e i doppioni si riconoscono sempre.
 * Un valore illeggibile non fa fallire la ricerca: vale come nessuna email.
 */
export function emailsDelContatto(valore: string): string[] {
  let grezzo: unknown;
  try {
    grezzo = JSON.parse(valore);
  } catch {
    return [];
  }
  if (!Array.isArray(grezzo)) return [];
  return [
    ...new Set(
      grezzo
        .filter((v): v is string => typeof v === "string")
        .map(normalizeEmail)
        .filter(Boolean),
    ),
  ];
}

export function normalizePhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length > 10 && digits.startsWith("39")) return digits.slice(2);
  return digits.length > 10 ? digits.slice(-10) : digits;
}

// ------------------------------------------------------------------ vCard

function unfold(raw: string): string[] {
  return raw.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
}

function unescapeText(value: string): string {
  return value.replace(/\\n/gi, "\n").replace(/\\([,;:\\])/g, "$1");
}

/**
 * Parser vCard volutamente minimale: prende solo i campi che il CRM mostra.
 * Le righe con più valori (EMAIL, TEL) si ripetono e vengono raccolte in lista.
 *
 * `updatedAt` è l'istante da attribuire alle schede. Il valore predefinito va
 * bene per una scheda sola; chi legge un'intera rubrica passa lo stesso istante
 * a tutte (vedi `pullIcloud`), perché la fusione dei doppioni confronta questi
 * istanti e due schede dello stesso import non devono risultare una più nuova
 * dell'altra solo perché il parser è stato chiamato un millisecondo dopo.
 */
export function parseVcards(vcf: string, href: string, updatedAt = Date.now()): RemoteContact[] {
  const out: RemoteContact[] = [];
  let card: Record<string, string> | null = null;
  const list = (current: Record<string, string>, key: string): string[] => {
    const raw = current[key];
    if (!raw) return [];
    return raw
      .split("\u0000")
      .map((v) => unescapeText(v).trim())
      .filter(Boolean);
  };

  for (const line of unfold(vcf)) {
    const upper = line.toUpperCase();
    if (upper.startsWith("BEGIN:VCARD")) {
      card = {};
      continue;
    }
    if (upper.startsWith("END:VCARD")) {
      if (card) {
        const uid = (card.UID ?? "").trim();
        const n = unescapeText(card.N ?? "").split(";");
        out.push({
          source: "icloud",
          addressbook: "",
          remote_id: href,
          uid: uid || href,
          display_name: unescapeText(card.FN ?? "").trim() || [n[1], n[0]].filter(Boolean).join(" "),
          given_name: (n[1] ?? "").trim(),
          family_name: (n[0] ?? "").trim(),
          org: unescapeText((card.ORG ?? "").split(";")[0] ?? "").trim(),
          job_title: unescapeText(card.TITLE ?? "").trim(),
          emails: list(card, "EMAIL"),
          phones: list(card, "TEL"),
          notes: unescapeText(card.NOTE ?? "").trim(),
          etag: null,
          updated_at: updatedAt,
          deleted: false,
        });
      }
      card = null;
      continue;
    }
    if (!card) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const name = line.slice(0, idx).split(";")[0].toUpperCase();
    const value = line.slice(idx + 1);
    if (name === "EMAIL" || name === "TEL") {
      card[name] = card[name] ? `${card[name]}\u0000${value}` : value;
    } else {
      card[name] = value;
    }
  }
  return out;
}

// ------------------------------------------------------------------ CardDAV

async function davPropfind(
  url: string,
  creds: AppleCreds,
  depth: string,
  body: string,
): Promise<Response> {
  return fetch(url, {
    method: "PROPFIND",
    headers: {
      Authorization: basicAuth(creds),
      "Content-Type": "application/xml; charset=utf-8",
      Depth: depth,
    },
    body,
  });
}

interface Addressbook {
  href: string;
  name: string;
  ctag: string | null;
}

const CARD_PRINCIPAL =
  '<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>';
const CARD_HOME =
  '<d:propfind xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:prop><card:addressbook-home-set/></d:prop></d:propfind>';
const CARD_LIST =
  '<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:displayname/><d:getctag/></d:prop></d:propfind>';
const CARD_QUERY =
  '<card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">' +
  "<d:prop><d:getetag/><card:address-data/></d:prop>" +
  "</card:addressbook-query>";

/** entry → principal → addressbook-home-set → elenco rubriche. */
export async function carddavAddressbooks(creds: AppleCreds): Promise<Addressbook[]> {
  const first = await davPropfind(CONTACTS_ENTRY, creds, "0", CARD_PRINCIPAL);
  let origin = new URL(CONTACTS_ENTRY).origin;
  if (first.status >= 300 && first.status < 400) {
    const location = first.headers.get("location");
    if (!location) throw new Error("iCloud: redirect privo di destinazione.");
    origin = new URL(location, CONTACTS_ENTRY).origin;
  } else if (first.status !== 207 && !first.ok) {
    throw new AppleHttpError(first.status, "l'interrogazione iniziale");
  }

  const principalRes = await davPropfind(`${origin}/`, creds, "0", CARD_PRINCIPAL);
  if (principalRes.status !== 207) {
    throw new AppleHttpError(principalRes.status, "la ricerca del principal");
  }
  const principalHref = hrefIn(findKey(xmlParser.parse(await principalRes.text()), "current-user-principal"));
  if (!principalHref) throw new Error("iCloud: principal non trovato nella risposta.");

  const homeRes = await davPropfind(
    new URL(principalHref, `${origin}/`).toString(),
    creds,
    "0",
    CARD_HOME,
  );
  if (homeRes.status !== 207) {
    throw new AppleHttpError(homeRes.status, "la ricerca delle rubriche");
  }
  const homeHref = hrefIn(findKey(xmlParser.parse(await homeRes.text()), "addressbook-home-set"));
  if (!homeHref) throw new Error("iCloud: rubriche non trovate nella risposta.");

  const listUrl = new URL(homeHref, `${origin}/`).toString();
  const listRes = await davPropfind(listUrl, creds, "1", CARD_LIST);
  if (listRes.status !== 207) {
    throw new AppleHttpError(listRes.status, "l'elenco delle rubriche");
  }
  const doc = xmlParser.parse(await listRes.text());
  let responses = findKey(doc, "response");
  if (responses && !Array.isArray(responses)) responses = [responses];

  const out: Addressbook[] = [];
  for (const resp of (responses as unknown[]) ?? []) {
    const href = hrefIn(resp);
    if (!href) continue;
    const resourceType = findKey(resp, "resourcetype");
    if (!resourceType || typeof resourceType !== "object" || !("addressbook" in resourceType)) continue;
    const name = findKey(resp, "displayname");
    const ctag = findKey(resp, "getctag");
    out.push({
      href: new URL(href, `${origin}/`).toString(),
      name: typeof name === "string" ? name : "",
      ctag: typeof ctag === "string" ? ctag : null,
    });
  }
  return out;
}

/**
 * Tutte le vCard di una rubrica, con ETag. `lettoIl` è l'istante dell'import
 * (uno solo per tutta la sincronizzazione, vedi `pullIcloud`): tutte le schede
 * lette insieme lo condividono, così la fusione dei doppioni non dipende da
 * quanti millisecondi passa fra una scheda e l'altra.
 */
export async function carddavQuery(
  addressbook: string,
  creds: AppleCreds,
  lettoIl = Date.now(),
): Promise<RemoteContact[]> {
  const res = await fetch(addressbook, {
    method: "REPORT",
    headers: {
      Authorization: basicAuth(creds),
      "Content-Type": "application/xml; charset=utf-8",
      Depth: "1",
    },
    body: CARD_QUERY,
  });
  if (res.status !== 207 && !res.ok) {
    throw new AppleHttpError(res.status, "la lettura della rubrica");
  }
  const doc = xmlParser.parse(await res.text());
  let responses = findKey(doc, "response");
  if (responses && !Array.isArray(responses)) responses = [responses];

  const out: RemoteContact[] = [];
  for (const resp of (responses as unknown[]) ?? []) {
    const href = hrefIn(resp);
    if (!href) continue;
    const absolute = new URL(href, addressbook).toString();
    const etag = findKey(resp, "getetag");
    const data = findKey(resp, "address-data");
    if (typeof data !== "string" || !data.includes("BEGIN:VCARD")) continue;
    for (const card of parseVcards(data, absolute, lettoIl)) {
      out.push({
        ...card,
        addressbook,
        etag: typeof etag === "string" ? etag.replace(/^"|"$/g, "") : null,
      });
    }
  }
  return out;
}

// ------------------------------------------------------------------- Google

interface PeoplePage {
  contacts: RemoteContact[];
  nextSyncToken: string | null;
}

/** people.connections.list, incrementale quando c'è un syncToken. */
export async function peopleConnections(
  accessToken: string,
  syncToken: string | null,
): Promise<PeoplePage> {
  let token = syncToken;
  let pageToken: string | undefined;
  const contacts: RemoteContact[] = [];

  for (;;) {
    const q = new URLSearchParams({
      personFields:
        "names,emailAddresses,phoneNumbers,organizations,biographies,metadata",
      pageSize: "1000",
      requestSyncToken: "true",
    });
    if (token) q.set("syncToken", token);
    if (pageToken) q.set("pageToken", pageToken);

    const res = await fetch(`${PEOPLE_API}/people/me/connections?${q.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 410 && token) {
      token = null;
      pageToken = undefined;
      continue;
    }
    if (!res.ok) throw new Error(`Google People ha risposto ${res.status}.`);
    const data = (await res.json()) as Record<string, any>;

    for (const person of Array.isArray(data.connections) ? data.connections : []) {
      const name = Array.isArray(person.names) ? person.names[0] ?? {} : {};
      const org = Array.isArray(person.organizations) ? person.organizations[0] ?? {} : {};
      const bio = Array.isArray(person.biographies) ? person.biographies[0] ?? {} : {};
      const updated = Date.parse(String(person.metadata?.sources?.[0]?.updateTime ?? ""));
      contacts.push({
        source: "google",
        addressbook: "connections",
        remote_id: String(person.resourceName ?? ""),
        uid: String(person.resourceName ?? ""),
        display_name: String(name.displayName ?? name.unstructuredName ?? ""),
        given_name: String(name.givenName ?? ""),
        family_name: String(name.familyName ?? ""),
        org: String(org.name ?? ""),
        job_title: String(org.title ?? ""),
        emails: (Array.isArray(person.emailAddresses) ? person.emailAddresses : [])
          .map((e: any) => String(e?.value ?? ""))
          .filter(Boolean),
        phones: (Array.isArray(person.phoneNumbers) ? person.phoneNumbers : [])
          .map((p: any) => String(p?.value ?? ""))
          .filter(Boolean),
        notes: String(bio.value ?? ""),
        etag: person.etag ? String(person.etag).replace(/^"|"$/g, "") : null,
        updated_at: Number.isNaN(updated) ? Date.now() : updated,
        deleted: person?.metadata?.deleted === true,
      });
    }

    pageToken = data.nextPageToken;
    if (!pageToken) return { contacts, nextSyncToken: data.nextSyncToken ?? token };
  }
}

// ------------------------------------------------------------ applicazione

/** Contatto locale con la stessa email (o lo stesso telefono), se esiste. */
async function matchExisting(remote: RemoteContact): Promise<{ id: number } | null> {
  const p = prisma();
  const emails = remote.emails.map(normalizeEmail).filter(Boolean);
  const phones = remote.phones.map(normalizePhone).filter(Boolean);
  if (!emails.length && !phones.length) return null;

  const rows = await p.contact.findMany({ where: { deleted_at: null } });
  for (const row of rows) {
    const localEmails = emailsDelContatto(row.emails);
    if (emails.some((e) => localEmails.includes(e))) return { id: row.id };
  }
  for (const row of rows) {
    const localPhones = (JSON.parse(row.phones) as string[]).map(normalizePhone);
    if (phones.some((n) => n && localPhones.includes(n))) return { id: row.id };
  }
  return null;
}

/** Legame al cliente del CRM: solo email o telefono identici, mai il nome. */
async function linkClient(contactId: number, remote: RemoteContact, counts: Counters): Promise<void> {
  const p = prisma();
  const contact = await p.contact.findUnique({ where: { id: contactId } });
  if (!contact || contact.client_id) return;

  const emails = remote.emails.map(normalizeEmail).filter(Boolean);
  let client = emails.length
    ? await p.client.findFirst({ where: { email: { in: emails, mode: "insensitive" } } })
    : null;

  if (!client) {
    const phones = remote.phones.map(normalizePhone).filter(Boolean);
    if (phones.length) {
      const candidates = await p.client.findMany();
      client = candidates.find((c) => phones.includes(normalizePhone(c.phone))) ?? null;
    }
  }
  if (!client) return;

  await p.contact.update({ where: { id: contactId }, data: { client_id: client.id } });
  counts.linked += 1;
}

async function applyRemote(remotes: RemoteContact[], counts: Counters): Promise<void> {
  const p = prisma();

  for (const remote of remotes) {
    if (!remote.remote_id) continue;
    const link = await p.contactLink.findUnique({
      where: { source_remote_id: { source: remote.source, remote_id: remote.remote_id } },
    });

    if (remote.deleted) {
      if (link) {
        const others = await p.contactLink.count({
          where: { contact_id: link.contact_id, id: { not: link.id } },
        });
        if (others === 0) {
          await p.contact
            .update({ where: { id: link.contact_id }, data: { deleted_at: utcStamp() } })
            .catch(() => undefined);
        }
        await p.contactLink.delete({ where: { id: link.id } }).catch(() => undefined);
        counts.removed += 1;
      }
      continue;
    }

    let contactId = link?.contact_id ?? null;
    if (!contactId) {
      const existing = await matchExisting(remote);
      if (existing) {
        contactId = existing.id;
        counts.merged += 1;
      }
    }

    // Le email si salvano già normalizzate, come si confrontano: altrimenti
    // «Mario@Example.com» resta maiuscola nel contatto e la stessa persona
    // scritta in due modi compare due volte nella ricerca per email.
    const emails = JSON.stringify([...new Set(remote.emails.map(normalizeEmail).filter(Boolean))]);
    const phones = JSON.stringify(remote.phones);

    if (!contactId) {
      const created = await p.contact.create({
        data: {
          display_name: remote.display_name,
          given_name: remote.given_name,
          family_name: remote.family_name,
          org: remote.org,
          job_title: remote.job_title,
          emails,
          phones,
          notes: remote.notes,
          updated_at: BigInt(remote.updated_at),
        },
      });
      contactId = created.id;
      counts.imported += 1;
    } else {
      const local = await p.contact.findUnique({ where: { id: contactId } });
      if (local && !local.deleted_at && remote.updated_at > Number(local.updated_at)) {
        await p.contact.update({
          where: { id: contactId },
          data: {
            display_name: remote.display_name || local.display_name,
            given_name: remote.given_name || local.given_name,
            family_name: remote.family_name || local.family_name,
            org: remote.org || local.org,
            job_title: remote.job_title || local.job_title,
            emails: remote.emails.length ? emails : local.emails,
            phones: remote.phones.length ? phones : local.phones,
            notes: remote.notes || local.notes,
            updated_at: BigInt(remote.updated_at),
          },
        });
        counts.updated += 1;
      }
    }

    if (link) {
      await p.contactLink.update({
        where: { id: link.id },
        data: { etag: remote.etag, addressbook: remote.addressbook },
      });
    } else {
      await p.contactLink.create({
        data: {
          contact_id: contactId,
          source: remote.source,
          addressbook: remote.addressbook,
          remote_id: remote.remote_id,
          etag: remote.etag,
        },
      });
    }

    await linkClient(contactId, remote, counts);
  }
}

// ------------------------------------------------------------ orchestrazione

async function pullIcloud(
  counts: Counters,
  errors: Array<{ source: string; message: string }>,
): Promise<void> {
  const p = prisma();
  const creds = await appleCreds();
  const addressbooks = await carddavAddressbooks(creds);
  // Un istante per tutto l'import: due schede della stessa lettura non sono
  // una più recente dell'altra, e la fusione dei doppioni deve decidere allo
  // stesso modo a ogni esecuzione invece di dipendere dall'orologio.
  const lettoIl = Date.now();
  for (const book of addressbooks) {
    try {
      const cards = await carddavQuery(book.href, creds, lettoIl);
      await applyRemote(cards, counts);
      await p.syncAddressbook.upsert({
        where: { provider_addressbook: { provider: "icloud", addressbook: book.href } },
        update: { name: book.name, ctag: book.ctag, last_sync_at: utcStamp() },
        create: {
          provider: "icloud",
          addressbook: book.href,
          name: book.name,
          ctag: book.ctag,
          last_sync_at: utcStamp(),
        },
      });
    } catch (err) {
      addError(errors, "icloud", err);
    }
  }
}

async function pullGoogle(
  counts: Counters,
  errors: Array<{ source: string; message: string }>,
): Promise<void> {
  const p = prisma();
  const { access_token } = await googleTokens();
  const state = await p.syncAddressbook.findUnique({
    where: { provider_addressbook: { provider: "google", addressbook: "connections" } },
  });
  const { contacts, nextSyncToken } = await peopleConnections(
    access_token,
    state?.sync_token ?? null,
  );
  await applyRemote(contacts, counts);
  await p.syncAddressbook.upsert({
    where: { provider_addressbook: { provider: "google", addressbook: "connections" } },
    update: { name: "Contatti Google", sync_token: nextSyncToken, last_sync_at: utcStamp() },
    create: {
      provider: "google",
      addressbook: "connections",
      name: "Contatti Google",
      sync_token: nextSyncToken,
      last_sync_at: utcStamp(),
    },
  });
}

export async function syncContacts(): Promise<ContactsSyncResult> {
  const status = await integrationStatus();
  if (!status.google.connected && !status.apple.connected) {
    throw new Invalid("Nessun account collegato per i contatti.");
  }

  const errors: Array<{ source: string; message: string }> = [];
  const counts: Counters = { imported: 0, updated: 0, removed: 0, linked: 0, merged: 0 };

  if (status.apple.connected) {
    try {
      await pullIcloud(counts, errors);
    } catch (err) {
      addError(errors, "icloud", err);
    }
  }
  if (status.google.connected) {
    try {
      await pullGoogle(counts, errors);
    } catch (err) {
      addError(errors, "google", err);
    }
  }

  return { ...counts, errors };
}
