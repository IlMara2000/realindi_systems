// Strumenti interni: link brevi funzionanti e QR personalizzati.
//
// Il QR non si salva come immagine: nel database restano contenuto, colori,
// livello di correzione e l'eventuale foto del centro. La matrice si genera qui
// (libreria `qrcode`, nessun servizio esterno) e il browser la disegna sul
// canvas, così il codice è nitido a qualsiasi dimensione e resta modificabile.
import QRCode from "qrcode";
import { prisma } from "./db.js";
import { Invalid, sha256Hex, tokenHex } from "./util.js";

export const ECC_LEVELS = ["L", "M", "Q", "H"] as const;
export type EccLevel = (typeof ECC_LEVELS)[number];

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const HEX_RE = /^#[0-9a-f]{6}$/i;
/** Stesso limite del client: oltre, il QR perde leggibilità con la foto. */
const MAX_LOGO_BYTES = 300 * 1024;
/** Sotto la capacità massima di un QR in byte mode a correzione alta (1273). */
const MAX_PAYLOAD = 1200;

function positiveId(raw: unknown, message = "Identificativo non valido."): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new Invalid(message);
  return id;
}

/** Id facoltativo: vuoto vale null, altrimenti deve essere un intero positivo. */
function optionalId(raw: unknown, message: string): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  return positiveId(raw, message);
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";
}

// ------------------------------------------------------------------- link
export interface LinkFields {
  slug: string;
  target: string;
  label: string;
  active: boolean;
}

function targetValue(raw: unknown): string {
  const v = String(raw ?? "").trim();
  if (!v || v.length > 2000) throw new Invalid("Indirizzo di destinazione non valido.");
  // Percorso interno: utile per portare a una pagina del gestionale o del sito.
  if (/^\/(?!\/)\S*$/.test(v)) return v;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw new Invalid("L'indirizzo deve iniziare con http://, https:// oppure essere un percorso interno (/…).");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Invalid("L'indirizzo deve usare http o https.");
  }
  return url.toString();
}

/** Slug richiesto dall'utente: minuscolo, senza spazi. Vuoto = lo genera il server. */
function slugValue(raw: unknown): string {
  const v = String(raw ?? "").trim().toLowerCase();
  if (!v) return "";
  if (!SLUG_RE.test(v)) {
    throw new Invalid("Slug non valido: da 2 a 40 caratteri, lettere minuscole, numeri e trattini.");
  }
  return v;
}

/** Slug leggibile ricavato dall'etichetta, con un suffisso casuale: unico. */
function randomSlug(label: string): string {
  const base =
    label
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "link";
  return `${base}-${tokenHex(3).slice(0, 5)}`;
}

async function uniqueSlug(label: string): Promise<string> {
  const p = prisma();
  for (let attempt = 0; attempt < 6; attempt++) {
    const slug = randomSlug(label);
    const taken = await p.shortLink.findUnique({ where: { slug } });
    if (!taken) return slug;
  }
  throw new Invalid("Non è stato possibile generare uno slug libero: riprova.");
}

/** Unico punto in cui un slug "già in uso" diventa un errore leggibile. */
function slugInUse(): Invalid {
  return new Invalid("Questo slug è già in uso.");
}

export async function saveLink(d: Record<string, unknown>): Promise<{ id: number; slug: string }> {
  const target = targetValue(d.target);
  const label = String(d.label ?? "").trim().slice(0, 120);
  const active = typeof d.active === "boolean" ? d.active : true;
  const wanted = slugValue(d.slug);
  const p = prisma();

  try {
    if (d.id !== undefined) {
      const id = positiveId(d.id, "Link non trovato.");
      const existing = await p.shortLink.findUnique({ where: { id } });
      if (!existing) throw new Invalid("Link non trovato.");
      let slug = existing.slug;
      if (wanted && wanted !== existing.slug) {
        if (await p.shortLink.findUnique({ where: { slug: wanted } })) throw slugInUse();
        slug = wanted;
      }
      await p.shortLink.update({ where: { id }, data: { slug, target, label, active } });
      return { id, slug };
    }

    if (wanted && (await p.shortLink.findUnique({ where: { slug: wanted } }))) throw slugInUse();
    const created = await p.shortLink.create({
      data: { slug: wanted || (await uniqueSlug(label)), target, label, active },
    });
    return { id: created.id, slug: created.slug };
  } catch (err) {
    // Due richieste contemporanee sullo stesso slug: vince il vincolo unico.
    if (isUniqueViolation(err)) throw slugInUse();
    throw err;
  }
}

export async function deleteLink(rawId: unknown): Promise<void> {
  const { count } = await prisma().shortLink.deleteMany({ where: { id: positiveId(rawId) } });
  if (!count) throw new Invalid("Link non trovato.");
}

/** Destinazione del redirect pubblico. Un link disattivato non esiste più. */
export async function activeLink(slug: string): Promise<{ id: number; target: string } | null> {
  if (!SLUG_RE.test(slug)) return null;
  const row = await prisma().shortLink.findUnique({ where: { slug } });
  if (!row || !row.active) return null;
  return { id: row.id, target: row.target };
}

/** Dopo quanti giorni le righe di visita vengono eliminate. */
const VISIT_RETENTION_DAYS = 35;

/**
 * Registra una visita: il clic grezzo sale sempre, la visita unica solo la prima
 * volta che la stessa impronta vede quel link nella giornata. L'impronta è un
 * hash salato di giorno, link, IP e browser — non conserva l'indirizzo in
 * chiaro — e cambia ogni giorno, quindi chi torna domani conta di nuovo.
 *
 * L'inserimento usa `skipDuplicates` sul vincolo unico (link, impronta): due
 * richieste contemporanee non possono contare due visite.
 */
export async function registerVisit(
  linkId: number,
  visitor: { ip: string; userAgent: string },
): Promise<void> {
  const p = prisma();
  const day = new Date().toISOString().slice(0, 10);
  const fingerprint = sha256Hex(
    `${process.env.INTEGRATIONS_KEY ?? "realindi"}|${day}|${linkId}|${visitor.ip}|${visitor.userAgent}`,
  );
  const now = Date.now();
  const inserted = await p.linkVisit.createMany({
    data: [{ link_id: linkId, fingerprint, at: BigInt(now) }],
    skipDuplicates: true,
  });
  await p.shortLink.update({
    where: { id: linkId },
    data: {
      clicks: { increment: 1 },
      ...(inserted.count ? { unique_visits: { increment: 1 } } : {}),
    },
  });
  if (inserted.count) {
    await p.linkVisit.deleteMany({
      where: { link_id: linkId, at: { lt: BigInt(now - VISIT_RETENTION_DAYS * 86_400_000) } },
    });
  }
}

// --------------------------------------------------------------------- qr
export interface QrFields {
  title: string;
  payload: string;
  foreground: string;
  background: string;
  ecc: EccLevel;
}

export interface QrMatrix {
  size: number;
  /** Una riga per riga: "1" modulo scuro, "0" chiaro. */
  rows: string[];
}

function hexValue(raw: unknown, fallback: string, label: string): string {
  const v = String(raw ?? "").trim();
  if (!v) return fallback;
  if (!HEX_RE.test(v)) throw new Invalid(`${label}: usa un colore esadecimale come #111111.`);
  return v.toLowerCase();
}

/**
 * Campi del QR. Il contenuto è obbligatorio solo senza link breve: un QR
 * dinamico prende l'indirizzo dal link, quindi `payload` può restare vuoto.
 */
export function validateQrFields(d: Record<string, unknown>, payloadRequired = true): QrFields {
  const title = String(d.title ?? "").trim();
  if (!title || title.length > 120) throw new Invalid("Nome del QR non valido (1-120 caratteri).");
  const payload = String(d.payload ?? "").trim();
  if (payloadRequired && !payload) throw new Invalid("Scrivi il contenuto da mettere nel QR.");
  if (payload.length > MAX_PAYLOAD || Buffer.byteLength(payload, "utf8") > MAX_PAYLOAD) {
    throw new Invalid(`Contenuto troppo lungo: massimo ${MAX_PAYLOAD} caratteri.`);
  }
  const ecc = String(d.ecc ?? "H").toUpperCase() as EccLevel;
  if (!ECC_LEVELS.includes(ecc)) throw new Invalid("Livello di correzione non valido.");
  return {
    title,
    payload,
    foreground: hexValue(d.foreground, "#111111", "Colore del codice"),
    background: hexValue(d.background, "#ffffff", "Sfondo"),
    ecc,
  };
}

/**
 * Matrice del QR. Unico punto in cui il contenuto viene effettivamente
 * codificato: il controllo di lunghezza qui evita di far lavorare la libreria
 * su un payload enorme arrivato da una richiesta costruita a mano.
 */
export function qrMatrix(payload: string, ecc: EccLevel): QrMatrix {
  const text = payload.trim();
  if (!text) throw new Invalid("Scrivi il contenuto da mettere nel QR.");
  if (text.length > MAX_PAYLOAD || Buffer.byteLength(text, "utf8") > MAX_PAYLOAD) {
    throw new Invalid(`Contenuto troppo lungo: massimo ${MAX_PAYLOAD} caratteri.`);
  }
  let qr: ReturnType<typeof QRCode.create>;
  try {
    qr = QRCode.create(text, { errorCorrectionLevel: ecc });
  } catch {
    throw new Invalid("Contenuto troppo lungo per un QR leggibile: accorcialo.");
  }
  const rows: string[] = [];
  for (let y = 0; y < qr.modules.size; y++) {
    let row = "";
    for (let x = 0; x < qr.modules.size; x++) row += qr.modules.get(y, x) ? "1" : "0";
    rows.push(row);
  }
  return { size: qr.modules.size, rows };
}

/**
 * Intestazioni ammesse per la foto del centro. Solo formati raster, mai SVG:
 * il file deve corrispondere al tipo dichiarato nel data URL.
 */
const LOGO_SIGNATURES: Record<string, (b: Buffer) => boolean> = {
  "image/png": (b) => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/webp": (b) =>
    b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP",
};

function decodeLogo(raw: unknown): { mime: string; bytes: Uint8Array<ArrayBuffer> } {
  const value = typeof raw === "string" ? raw.trim() : "";
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(value);
  if (!match) throw new Invalid("La foto deve essere un'immagine PNG, JPG o WebP.");
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length) throw new Invalid("L'immagine è vuota.");
  if (bytes.length > MAX_LOGO_BYTES) throw new Invalid("Foto troppo grande: massimo 300 KB.");
  const mime = `image/${match[1]}`;
  if (!LOGO_SIGNATURES[mime](bytes)) {
    throw new Invalid("Il file non sembra un'immagine PNG, JPG o WebP valida.");
  }
  // Copia su un ArrayBuffer proprio: è il tipo che Prisma accetta per Bytes
  // (un Buffer può poggiare su memoria condivisa).
  const copy = new Uint8Array(new ArrayBuffer(bytes.length));
  copy.set(bytes);
  return { mime, bytes: copy };
}

export async function saveQr(d: Record<string, unknown>): Promise<{ id: number }> {
  const p = prisma();
  const linkId = optionalId(d.link_id, "Link breve non valido.");
  const fields = validateQrFields(d, linkId === null);
  if (linkId !== null) {
    const link = await p.shortLink.findUnique({ where: { id: linkId }, select: { id: true } });
    if (!link) throw new Invalid("Link breve non trovato.");
  }
  // Il contenuto statico si verifica subito; per un QR dinamico l'indirizzo
  // definitivo si conosce solo al disegno, quindi si controlla solo l'eventuale
  // testo di riserva.
  if (fields.payload) qrMatrix(fields.payload, fields.ecc);

  const logo = d.logo_data ? decodeLogo(d.logo_data) : null;
  const removeLogo = d.remove_logo === true;
  const logoPatch: { logo_mime?: string | null; logo?: Uint8Array<ArrayBuffer> | null } = removeLogo
    ? { logo_mime: null, logo: null }
    : logo
      ? { logo_mime: logo.mime, logo: logo.bytes }
      : {};
  const data = { ...fields, link_id: linkId, ...logoPatch };

  if (d.id !== undefined) {
    const id = positiveId(d.id, "QR non trovato.");
    const { count } = await p.qrCode.updateMany({ where: { id }, data });
    if (!count) throw new Invalid("QR non trovato.");
    return { id };
  }
  const created = await p.qrCode.create({ data });
  return { id: created.id };
}

export async function deleteQr(rawId: unknown): Promise<void> {
  const { count } = await prisma().qrCode.deleteMany({ where: { id: positiveId(rawId) } });
  if (!count) throw new Invalid("QR non trovato.");
}

export async function qrLogo(
  rawId: unknown,
): Promise<{ mime: string; bytes: Buffer } | null> {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = await prisma().qrCode.findUnique({
    where: { id },
    select: { logo: true, logo_mime: true },
  });
  if (!row?.logo || !row.logo_mime) return null;
  return { mime: row.logo_mime, bytes: Buffer.from(row.logo) };
}

// --------------------------------------------------------------- elenco
export async function listTools(): Promise<{
  links: Array<{
    id: number;
    slug: string;
    target: string;
    label: string;
    clicks: number;
    active: boolean;
    created_at: string;
  }>;
  qr: Array<{
    id: number;
    title: string;
    payload: string;
    foreground: string;
    background: string;
    ecc: string;
    has_logo: boolean;
    link_id: number | null;
    link_slug: string | null;
    created_at: string;
  }>;
}> {
  const p = prisma();
  // `omit` tiene fuori dal payload della pagina i BLOB delle foto: al browser
  // serve solo sapere se la foto c'è.
  const [links, qr] = await Promise.all([
    p.shortLink.findMany({ orderBy: { created_at: "desc" } }),
    p.qrCode.findMany({
      omit: { logo: true },
      include: { link: { select: { slug: true } } },
      orderBy: { created_at: "desc" },
    }),
  ]);
  return {
    links,
    qr: qr.map((row) => ({
      id: row.id,
      title: row.title,
      payload: row.payload,
      foreground: row.foreground,
      background: row.background,
      ecc: row.ecc,
      has_logo: Boolean(row.logo_mime),
      link_id: row.link_id,
      link_slug: row.link?.slug ?? null,
      created_at: row.created_at,
    })),
  };
}
