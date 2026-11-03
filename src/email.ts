// Sezione email: invio via SMTP Apple (nodemailer) e lettura inbox via
// IMAP Apple (imapflow) o Gmail API. Nessuna credenziale in chiaro né in
// risposta: i messaggi contengono solo mittente/oggetto/data/snippet.
import { ImapFlow } from "imapflow";
import { createTransport } from "nodemailer";
import { prisma } from "./db.js";
import { Invalid } from "./util.js";
import { appleCreds, googleTokens, buildIcs, sanitize } from "./sync.js";
import { integrationStatus } from "./integrations.js";

const SMTP_HOST = "smtp.mail.me.com";
const IMAP_HOST = "imap.mail.me.com";

export interface OutgoingMail {
  to: string;
  subject: string;
  body: string;
  ics?: { title: string; start: string; end: string };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateOutgoing(d: Record<string, unknown>): OutgoingMail {
  const to = typeof d.to === "string" ? d.to.trim() : "";
  const subject = typeof d.subject === "string" ? d.subject.trim() : "";
  const body = typeof d.body === "string" ? d.body : "";
  if (!EMAIL_RE.test(to)) throw new Invalid("Indirizzo del destinatario non valido.");
  if (!subject || subject.length > 200) throw new Invalid("Oggetto non valido (1-200 caratteri).");
  if (body.length > 10000) throw new Invalid("Testo troppo lungo (max 10000 caratteri).");
  let ics: OutgoingMail["ics"];
  if (d.ics !== undefined && d.ics !== null) {
    if (!d.ics || typeof d.ics !== "object") throw new Invalid("Allegato calendario non valido.");
    const raw = d.ics as Record<string, unknown>;
    const title = typeof raw.title === "string" ? raw.title.trim() : "";
    const start = typeof raw.start === "string" ? raw.start : "";
    const end = typeof raw.end === "string" ? raw.end : "";
    if (!title || title.length > 200 || Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end))) {
      throw new Invalid("Allegato calendario non valido.");
    }
    ics = { title, start, end };
  }
  return { to, subject, body, ics };
}

async function senderAddress(): Promise<string> {
  const row = await prisma().setting.findUnique({ where: { key: "email_sender" } });
  if (!row?.value) throw new Invalid("Configura prima il mittente in Impostazioni → Mittente email.");
  return row.value;
}

export async function sendMail(mail: OutgoingMail): Promise<void> {
  const sender = await senderAddress();
  const status = await integrationStatus();
  if (!status.apple.connected) throw new Invalid("Collega prima l'account Apple (Impostazioni → Integrazioni).");
  const creds = await appleCreds();

  const transporter = createTransport({
    host: SMTP_HOST,
    port: 587,
    secure: false,
    auth: { user: creds.apple_id, pass: creds.app_password },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });

  const attachments = mail.ics
    ? [
        {
          filename: "invito.ics",
          content: buildIcs(
            { title: mail.ics.title, start: mail.ics.start, end: mail.ics.end, all_day: false, description: null, location: null },
            `invito-${Date.now()}@realindi`,
          ),
          contentType: "text/calendar; charset=utf-8",
        },
      ]
    : [];

  await transporter.sendMail({
    from: `"REALINDI SYSTEMS" <${sender}>`,
    to: mail.to,
    subject: mail.subject,
    text: mail.body,
    attachments,
  });
}

export interface InboxMessage {
  id: string | number;
  from: string;
  subject: string;
  date: string;
  snippet: string;
}

async function appleInbox(): Promise<InboxMessage[]> {
  const creds = await appleCreds();
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: 993,
    secure: true,
    auth: { user: creds.apple_id, pass: creds.app_password },
    logger: false,
    socketTimeout: 15_000,
    greetingTimeout: 15_000,
    connectionTimeout: 15_000,
  });
  await client.connect();
  try {
    const mailbox = await client.mailboxOpen("INBOX");
    const total = Number(mailbox?.exists ?? 0);
    const first = Math.max(1, total - 19);
    const out: InboxMessage[] = [];
    for await (const msg of client.fetch(
      `${first}:*`,
      {
        uid: true,
        envelope: true,
        internalDate: true,
        bodyParts: [{ key: "TEXT", start: 0, maxLength: 200 }],
      },
      { uid: false },
    )) {
      const env = msg.envelope ?? {};
      const raw = msg.bodyParts?.get("TEXT");
      const snippet = raw
        ? raw.toString("utf8").replace(/\s+/g, " ").trim().slice(0, 200)
        : "";
      const date = env.date ? new Date(env.date).toISOString() : "";
      out.push({
        id: msg.uid ?? msg.seq ?? 0,
        from: env.from?.[0]?.address ?? "",
        subject: (env.subject ?? "").slice(0, 200),
        date,
        snippet,
      });
    }
    return out
      .filter((m) => m.subject !== "" || m.snippet !== "")
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
      .slice(0, 20);
  } finally {
    try {
      await client.logout();
    } catch {
      /* disconnessione ignorata */
    }
  }
}

async function gmailInbox(): Promise<InboxMessage[]> {
  const { access_token } = await googleTokens();
  const headers = { Authorization: `Bearer ${access_token}` };
  const listRes = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=20&q=" +
      encodeURIComponent("in:inbox"),
    { headers },
  );
  if (!listRes.ok) throw new Error(`Gmail ha risposto ${listRes.status}.`);
  const list = (await listRes.json()) as { messages?: Array<{ id: string }> };
  const ids = (list.messages ?? []).map((m) => m.id).slice(0, 20);

  const details = await Promise.all(
    ids.map(async (id): Promise<InboxMessage | null> => {
      const res = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}` +
          "?format=metadata&metadataHeaders=From&metadataHeaders=Subject",
        { headers },
      );
      if (!res.ok) return null;
      const data = (await res.json()) as Record<string, any>;
      const hdrs: Array<{ name?: string; value?: string }> = data.payload?.headers ?? [];
      const pick = (name: string) =>
        hdrs.find((h) => (h.name ?? "").toLowerCase() === name.toLowerCase())?.value ?? "";
      const ts = Number(data.internalDate ?? 0);
      return {
        id,
        from: pick("From").slice(0, 200),
        subject: pick("Subject").slice(0, 200),
        date: ts ? new Date(ts).toISOString() : "",
        snippet: String(data.snippet ?? "").slice(0, 200),
      };
    }),
  );
  return details.filter((m): m is InboxMessage => m !== null);
}

export async function readInbox(): Promise<{ provider: "apple" | "gmail"; messages: InboxMessage[] }> {
  const status = await integrationStatus();
  try {
    if (status.apple.connected) return { provider: "apple", messages: await appleInbox() };
    if (status.google.connected) return { provider: "gmail", messages: await gmailInbox() };
  } catch (err) {
    throw new Invalid(sanitize(err));
  }
  throw new Invalid("Collega un account email (Impostazioni → Integrazioni).");
}
