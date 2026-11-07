// Canali di messaggistica: WhatsApp Business (Cloud API), Instagram DM e SMS
// (Twilio). Le credenziali sono cifrate nella colonna `credentials` con la
// stessa chiave delle altre integrazioni (INTEGRATIONS_KEY) e non vengono mai
// restituite al browser. Qui vivono anche verifica, invio e parsing dei webhook.
import { createHmac } from "node:crypto";
import { prisma } from "./db.js";
import { openSecret, sealSecret } from "./crypto.js";
import { Invalid, timingSafeEqualStr, tokenHex } from "./util.js";
import { utcStamp } from "./notes.js";

export type Provider = "whatsapp" | "instagram" | "sms";

export interface ProviderInfo {
  id: Provider;
  name: string;
  webhook: string;
  description: string;
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: "whatsapp",
    name: "WhatsApp Business",
    webhook: "/api/webhooks/whatsapp",
    description: "Meta Cloud API · numero di telefono dell'attività",
  },
  {
    id: "instagram",
    name: "Instagram",
    webhook: "/api/webhooks/instagram",
    description: "Messaggi diretti di un account professionale",
  },
  {
    id: "sms",
    name: "SMS",
    webhook: "/api/webhooks/sms",
    description: "Twilio · numero mittente E.164",
  },
];

export function providerInfo(id: string): ProviderInfo | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/** Riga del canale come arriva da Prisma (credenziali ancora cifrate). */
export interface ChannelRecord {
  id: number;
  provider: string;
  label: string;
  external_id: string;
  detail: string;
  status: string;
  last_error: string;
  auto_reply: boolean;
  credentials: string;
  created_at: string;
  updated_at: string;
}

interface Credentials {
  access_token?: string;
  phone_number_id?: string;
  waba_id?: string;
  ig_user_id?: string;
  app_secret?: string;
  verify_token?: string;
  account_sid?: string;
  auth_token?: string;
  from?: string;
}

/** Canale nella forma esposta al browser: nessun token, nessun segreto. */
export interface PublicChannel {
  id: number;
  provider: string;
  provider_name: string;
  label: string;
  external_id: string;
  detail: string;
  status: string;
  last_error: string;
  auto_reply: boolean;
  verify_token: string;
  has_app_secret: boolean;
  created_at: string;
  updated_at: string;
  webhook: string;
}

const GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? "v23.0";
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

function str(value: unknown, max = 500): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Telefono in forma compatta: cifre, con il + iniziale se presente. */
export function normalizePhone(value: string): string {
  const raw = value.replace(/[^\d+]/g, "");
  if (!raw) return "";
  const hasPlus = raw.startsWith("+");
  const digits = raw.replace(/\D/g, "");
  return (hasPlus ? "+" : "") + digits;
}

function openCreds(channel: ChannelRecord): Credentials {
  try {
    const parsed = JSON.parse(openSecret(channel.credentials)) as Credentials;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function publicChannel(channel: ChannelRecord): PublicChannel {
  const creds = openCreds(channel);
  const info = providerInfo(channel.provider);
  return {
    id: channel.id,
    provider: channel.provider,
    provider_name: info?.name ?? channel.provider,
    label: channel.label,
    external_id: channel.external_id,
    detail: channel.detail,
    status: channel.status,
    last_error: channel.last_error,
    auto_reply: channel.auto_reply,
    verify_token: creds.verify_token ?? "",
    has_app_secret: Boolean(creds.app_secret),
    created_at: channel.created_at,
    updated_at: channel.updated_at,
    webhook: info?.webhook ?? "",
  };
}

export async function listChannels(): Promise<PublicChannel[]> {
  const rows = await prisma().channel.findMany({ orderBy: { id: "asc" } });
  return rows.map(publicChannel);
}

async function fetchWithTimeout(url: string, init: RequestInit, ms = 8000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function providerMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const err = (body as { error?: unknown }).error;
    if (typeof err === "string") return err;
    if (err && typeof err === "object") {
      const message = (err as { message?: unknown }).message;
      const code = (err as { code?: unknown }).code;
      if (typeof message === "string" && message) {
        return code !== undefined ? `${message} (codice ${String(code)})` : message;
      }
    }
    const message = (body as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return fallback;
}

/**
 * Crea o aggiorna un canale. I campi segreti lasciati vuoti su un canale già
 * esistente mantengono il valore salvato, così si può cambiare l'etichetta o
 * l'auto-risposta senza reinserire i token.
 */
export async function saveChannel(d: Record<string, unknown>): Promise<{
  channel: PublicChannel;
  verification: { ok: boolean; detail: string; error: string } | null;
}> {
  const provider = str(d.provider, 20) as Provider;
  const info = providerInfo(provider);
  if (!info) throw new Invalid("Canale non riconosciuto.");

  const idRaw = d.id;
  const id = typeof idRaw === "number" && Number.isInteger(idRaw) && idRaw > 0 ? idRaw : null;
  const p = prisma();
  const existing = id ? await p.channel.findUnique({ where: { id } }) : null;
  if (id && !existing) throw new Invalid("Canale non trovato.");
  if (existing && existing.provider !== provider) {
    throw new Invalid("Il canale non può cambiare provider: scollegalo e creane uno nuovo.");
  }

  const old: Credentials = existing ? openCreds(existing) : {};
  const keep = (value: string, previous: string | undefined): string => value || previous || "";

  const label = str(d.label, 80) || existing?.label || info.name;
  const verifyTokenInput = str(d.verify_token, 120);
  let verifyToken = keep(verifyTokenInput, old.verify_token) || tokenHex(24);
  if (verifyToken.length < 8) throw new Invalid("Il token di verifica webhook deve avere almeno 8 caratteri.");

  let externalId = "";
  let detail = str(d.detail, 120) || existing?.detail || "";
  let creds: Credentials = {};

  if (provider === "whatsapp") {
    const phoneNumberId = keep(str(d.phone_number_id, 40), old.phone_number_id);
    if (!/^\d{5,30}$/.test(phoneNumberId)) {
      throw new Invalid("Phone number ID WhatsApp non valido: sono solo cifre (da Meta → WhatsApp → Impostazioni API).");
    }
    const accessToken = keep(str(d.access_token, 2000), old.access_token);
    if (accessToken.length < 20) throw new Invalid("Access token WhatsApp mancante o troppo corto.");
    const appSecret = keep(str(d.app_secret, 200), old.app_secret);
    const wabaId = keep(str(d.waba_id, 40), old.waba_id);
    externalId = phoneNumberId;
    creds = { access_token: accessToken, phone_number_id: phoneNumberId, app_secret: appSecret, verify_token: verifyToken, waba_id: wabaId };
    if (!detail) detail = label;
  } else if (provider === "instagram") {
    const igUserId = keep(str(d.ig_user_id, 40), old.ig_user_id);
    if (!/^\d{5,30}$/.test(igUserId)) {
      throw new Invalid("ID account Instagram non valido: è l'ID numerico dell'account professionale.");
    }
    const accessToken = keep(str(d.access_token, 2000), old.access_token);
    if (accessToken.length < 20) throw new Invalid("Access token Instagram mancante o troppo corto.");
    const appSecret = keep(str(d.app_secret, 200), old.app_secret);
    externalId = igUserId;
    creds = { access_token: accessToken, ig_user_id: igUserId, app_secret: appSecret, verify_token: verifyToken };
    if (!detail) detail = label;
  } else {
    const accountSid = keep(str(d.account_sid, 60), old.account_sid);
    if (!/^AC[0-9a-fA-F]{32}$/.test(accountSid)) {
      throw new Invalid("Account SID Twilio non valido: inizia con AC seguito da 32 caratteri.");
    }
    const authToken = keep(str(d.auth_token, 200), old.auth_token);
    if (authToken.length < 10) throw new Invalid("Auth token Twilio mancante o troppo corto.");
    const from = normalizePhone(keep(str(d.from, 30), old.from));
    if (from.replace(/\D/g, "").length < 6) {
      throw new Invalid("Numero mittente SMS non valido: usa il formato internazionale, es. +393331234567.");
    }
    externalId = from;
    creds = { account_sid: accountSid, auth_token: authToken, from, verify_token: verifyToken };
    if (!detail) detail = from;
  }

  const duplicate = await p.channel.findFirst({
    where: { provider, external_id: externalId, ...(existing ? { NOT: { id: existing.id } } : {}) },
  });
  if (duplicate) throw new Invalid("Questo canale è già collegato.");

  let sealed: string;
  try {
    sealed = sealSecret(JSON.stringify(creds));
  } catch {
    throw new Invalid(
      "Manca INTEGRATIONS_KEY: aggiungi una chiave lunga e casuale al file .env (es. openssl rand -hex 32) per cifrare le credenziali dei canali.",
    );
  }

  const row = existing
    ? await p.channel.update({
        where: { id: existing.id },
        data: {
          label,
          external_id: externalId,
          detail,
          credentials: sealed,
          auto_reply: bool(d.auto_reply, existing.auto_reply),
          status: "connected",
          last_error: "",
          updated_at: utcStamp(),
        },
      })
    : await p.channel.create({
        data: {
          provider,
          label,
          external_id: externalId,
          detail,
          credentials: sealed,
          auto_reply: bool(d.auto_reply, true),
          status: "connected",
          created_at: utcStamp(),
          updated_at: utcStamp(),
        },
      });

  const verification = d.verify === false ? null : await verifyChannel(row);
  const fresh = await p.channel.findUnique({ where: { id: row.id } });
  return { channel: publicChannel(fresh ?? row), verification };
}

export async function verifyChannel(channel: ChannelRecord): Promise<{ ok: boolean; detail: string; error: string }> {
  const creds = openCreds(channel);
  let ok = false;
  let detail = "";
  let error = "";
  try {
    if (channel.provider === "whatsapp") {
      const res = await fetchWithTimeout(
        `${GRAPH}/${creds.phone_number_id}?fields=display_phone_number,verified_name`,
        { headers: { Authorization: `Bearer ${creds.access_token ?? ""}` } },
      );
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.ok) {
        ok = true;
        detail = [body.verified_name, body.display_phone_number].filter((x) => typeof x === "string" && x).join(" · ");
      } else {
        error = providerMessage(body, `WhatsApp ha risposto ${res.status}.`);
      }
    } else if (channel.provider === "instagram") {
      const res = await fetchWithTimeout(
        `${GRAPH}/${creds.ig_user_id}?fields=username,name`,
        { headers: { Authorization: `Bearer ${creds.access_token ?? ""}` } },
      );
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.ok) {
        ok = true;
        detail = [body.name, body.username && `@${String(body.username)}`].filter((x) => typeof x === "string" && x).join(" · ");
      } else {
        error = providerMessage(body, `Instagram ha risposto ${res.status}.`);
      }
    } else {
      const auth = Buffer.from(`${creds.account_sid}:${creds.auth_token}`).toString("base64");
      const res = await fetchWithTimeout(
        `https://api.twilio.com/2010-04-01/Accounts/${creds.account_sid}.json`,
        { headers: { Authorization: `Basic ${auth}` } },
      );
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.ok) {
        ok = true;
        detail = [body.friendly_name, body.status].filter((x) => typeof x === "string" && x).join(" · ");
      } else {
        error = providerMessage(body, `Twilio ha risposto ${res.status}.`);
      }
    }
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    error = aborted ? "Il provider non ha risposto in tempo." : "Connessione al provider non riuscita.";
  }

  await prisma()
    .channel.update({
      where: { id: channel.id },
      data: {
        status: ok ? "connected" : "error",
        last_error: ok ? "" : error.slice(0, 300),
        ...(ok && detail ? { detail: detail.slice(0, 120) } : {}),
        updated_at: utcStamp(),
      },
    })
    .catch(() => undefined);

  return { ok, detail, error };
}

/** Invia un messaggio di testo e restituisce l'identificativo esterno. */
export async function sendChannelMessage(
  channel: ChannelRecord,
  to: string,
  text: string,
): Promise<{ externalId: string; status: string }> {
  const creds = openCreds(channel);
  const body = text.trim();
  if (!body) throw new Invalid("Messaggio vuoto.");

  if (channel.provider === "whatsapp") {
    const dest = normalizePhone(to).replace(/\D/g, "");
    if (!dest) throw new Invalid("Destinatario WhatsApp non valido.");
    const res = await fetchWithTimeout(`${GRAPH}/${creds.phone_number_id}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${creds.access_token ?? ""}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: dest,
        type: "text",
        text: { preview_url: false, body },
      }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      messages?: { id?: string }[];
      error?: { message?: string; code?: number };
    };
    if (!res.ok) {
      if (json.error?.code === 131047) {
        throw new Error("WhatsApp: la finestra di 24 ore è chiusa. Il cliente deve scrivere per primo per ricevere una risposta libera.");
      }
      throw new Error(
        `WhatsApp: ${json.error?.message ?? `invio non riuscito (${res.status})`}`,
      );
    }
    return { externalId: json.messages?.[0]?.id ?? "", status: "sent" };
  }

  if (channel.provider === "instagram") {
    const dest = to.trim();
    if (!dest) throw new Invalid("Destinatario Instagram non valido.");
    const res = await fetchWithTimeout(`${GRAPH}/${creds.ig_user_id}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${creds.access_token ?? ""}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ recipient: { id: dest }, message: { text: body } }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      message_id?: string;
      error?: { message?: string; code?: number };
    };
    if (!res.ok) {
      if (json.error?.code === 10 || json.error?.code === 200) {
        throw new Error("Instagram: finestra di risposta scaduta o permessi insufficienti sul messaggio.");
      }
      throw new Error(`Instagram: ${json.error?.message ?? `invio non riuscito (${res.status})`}`);
    }
    return { externalId: json.message_id ?? "", status: "sent" };
  }

  const dest = normalizePhone(to);
  if (dest.replace(/\D/g, "").length < 6) throw new Invalid("Destinatario SMS non valido.");
  const auth = Buffer.from(`${creds.account_sid}:${creds.auth_token}`).toString("base64");
  const form = new URLSearchParams({ From: creds.from ?? "", To: dest, Body: body });
  const res = await fetchWithTimeout(
    `https://api.twilio.com/2010-04-01/Accounts/${creds.account_sid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    },
  );
  const json = (await res.json().catch(() => ({}))) as {
    sid?: string;
    status?: string;
    message?: string;
  };
  if (!res.ok) throw new Error(`SMS: ${json.message ?? `invio non riuscito (${res.status})`}`);
  return { externalId: json.sid ?? "", status: json.status ?? "queued" };
}

// ------------------------------------------------------------------ webhook

export interface InboundEvent {
  externalChannelId: string;
  contact: string;
  contactName: string;
  text: string;
  externalId: string;
  kind: "text" | "media";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Eventi in ingresso da un payload WhatsApp Cloud API (object: whatsapp_business_account). */
export function parseWhatsAppWebhook(payload: unknown): InboundEvent[] {
  const out: InboundEvent[] = [];
  for (const entry of asArray(asRecord(payload).entry)) {
    for (const change of asArray(asRecord(entry).changes)) {
      const value = asRecord(asRecord(change).value);
      const phoneNumberId = asString(asRecord(value.metadata).phone_number_id);
      const contacts = asArray(value.contacts).map(asRecord);
      const messages = asArray(value.messages).map(asRecord);
      for (const message of messages) {
        if (!phoneNumberId) continue;
        const from = asString(message.from);
        if (!from) continue;
        const profile = asRecord(contacts[0]?.profile);
        const type = asString(message.type);
        const text =
          type === "text"
            ? asString(asRecord(message.text).body)
            : type === "button"
              ? asString(asRecord(message.button).text)
              : type === "interactive"
                ? asString(asRecord(asRecord(message.interactive).button_reply).title) ||
                  asString(asRecord(asRecord(message.interactive).list_reply).title)
                : "";
        out.push({
          externalChannelId: phoneNumberId,
          contact: from,
          contactName: asString(profile.name),
          text,
          externalId: asString(message.id),
          kind: text ? "text" : "media",
        });
      }
    }
  }
  return out;
}

/** Eventi in ingresso da Instagram Messaging (object: instagram). */
export function parseInstagramWebhook(payload: unknown): InboundEvent[] {
  const out: InboundEvent[] = [];
  for (const entry of asArray(asRecord(payload).entry)) {
    const igId = asString(asRecord(entry).id);
    for (const item of asArray(asRecord(entry).messaging)) {
      const messaging = asRecord(item);
      const message = asRecord(messaging.message);
      if (message.is_echo === true) continue;
      const sender = asString(asRecord(messaging.sender).id);
      const recipient = asString(asRecord(messaging.recipient).id);
      if (!igId || !sender || sender === igId) continue;
      if (recipient && recipient !== igId) continue;
      const text = asString(message.text);
      out.push({
        externalChannelId: igId,
        contact: sender,
        contactName: "",
        text,
        externalId: asString(message.mid),
        kind: text ? "text" : "media",
      });
    }
  }
  return out;
}

/** Firma X-Hub-Signature-256 di Meta sul corpo grezzo. */
export function verifyMetaSignature(
  raw: Buffer,
  header: string | undefined,
  appSecret: string,
): boolean {
  if (!appSecret) return true;
  if (!header || !header.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(raw).digest("hex");
  return timingSafeEqualStr(header.slice(7), expected);
}

/** Firma X-Twilio-Signature: HMAC-SHA1 su URL + parametri ordinati. */
export function computeTwilioSignature(
  url: string,
  params: Record<string, string>,
  authToken: string,
): string {
  const payload = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac("sha1", authToken).update(payload, "utf8").digest("base64");
}

export function verifyTwilioSignature(
  url: string,
  params: Record<string, string>,
  header: string | undefined,
  authToken: string,
): boolean {
  if (!authToken) return true;
  if (!header) return false;
  return timingSafeEqualStr(computeTwilioSignature(url, params, authToken), header);
}

/** Credenziali in sola lettura per i webhook (app secret, token Twilio). */
export function channelCredentials(channel: ChannelRecord): Credentials {
  return openCreds(channel);
}
