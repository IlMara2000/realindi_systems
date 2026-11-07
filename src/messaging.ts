// Inbox unificata: salvataggio dei messaggi in ingresso, risposta automatica
// dell'assistente (con freni anti-loop) e risposte manuali del titolare.
import { prisma } from "./db.js";
import { Invalid } from "./util.js";
import { utcStamp } from "./notes.js";
import { assistantSettings, generateReply } from "./assistant.js";
import {
  channelCredentials,
  publicChannel,
  sendChannelMessage,
  type ChannelRecord,
} from "./channels.js";

export interface IngestInput {
  channel: ChannelRecord;
  contact: string;
  contactName?: string;
  text: string;
  externalId?: string;
  kind?: "text" | "media";
}

export interface IngestResult {
  conversationId: number;
  replied: boolean;
  error?: string;
}

const AUTO_REPLY_WINDOW_MS = 10 * 60_000;
const AUTO_REPLY_MAX = 3;
const MAX_REPLY_HISTORY = 10;

function stampAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Registra un messaggio in ingresso e, se l'assistente è attivo, risponde.
 * Non lancia mai per errori del provider: il webhook deve poter rispondere 200
 * e il problema resta visibile nella conversazione.
 */
export async function ingestInbound(input: IngestInput): Promise<IngestResult> {
  const p = prisma();
  const now = utcStamp();
  const contact = input.contact.trim();
  if (!contact) throw new Invalid("Contatto mancante.");
  const body = (input.text ?? "").trim() || (input.kind === "media" ? "[Allegato ricevuto]" : "");

  const conversation = await p.conversation.upsert({
    where: { channel_id_contact: { channel_id: input.channel.id, contact } },
    update: {
      last_message_at: now,
      ...(input.contactName ? { contact_name: input.contactName.slice(0, 120) } : {}),
    },
    create: {
      channel_id: input.channel.id,
      contact,
      contact_name: (input.contactName ?? "").slice(0, 120),
      last_message_at: now,
      created_at: now,
    },
  });

  if (input.externalId) {
    const duplicate = await p.message.findUnique({
      where: { conversation_id_external_id: { conversation_id: conversation.id, external_id: input.externalId } },
    });
    if (duplicate) return { conversationId: conversation.id, replied: false };
  }

  const incoming = await p.message.create({
    data: {
      conversation_id: conversation.id,
      direction: "in",
      author: "contact",
      body: body.slice(0, 4000),
      external_id: input.externalId || null,
      status: "received",
      created_at: now,
    },
  });
  const fresh = await p.conversation.update({
    where: { id: conversation.id },
    data: { unread: { increment: 1 }, last_message_at: now },
  });

  if (input.kind === "media" || !input.text.trim()) {
    return { conversationId: fresh.id, replied: false };
  }

  const cfg = await assistantSettings();
  if (!cfg.enabled || !input.channel.auto_reply || !fresh.auto_reply || fresh.status !== "open") {
    return { conversationId: fresh.id, replied: false };
  }

  const recent = await p.message.count({
    where: {
      conversation_id: fresh.id,
      author: "assistant",
      created_at: { gte: stampAgo(AUTO_REPLY_WINDOW_MS) },
    },
  });
  if (recent >= AUTO_REPLY_MAX) {
    await p.conversation.update({ where: { id: fresh.id }, data: { status: "human" } });
    return { conversationId: fresh.id, replied: false, error: "Troppe risposte automatiche ravvicinate: conversazione passata al titolare." };
  }

  // Il messaggio appena salvato viene passato come testo corrente: escluderlo
  // dalla cronologia evita di inviarlo due volte al modello.
  const historyRows = await p.message.findMany({
    where: { conversation_id: fresh.id, author: { not: "system" }, id: { not: incoming.id } },
    orderBy: { id: "desc" },
    take: MAX_REPLY_HISTORY,
  });
  const history = historyRows
    .reverse()
    .map((m) => ({ direction: m.direction, body: m.body }));

  let reply: string;
  try {
    const generated = await generateReply({
      channel: channelLabel(input.channel),
      text: input.text,
      contactName: fresh.contact_name,
      history,
    });
    reply = generated.reply;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Assistente non disponibile.";
    await p.message.create({
      data: {
        conversation_id: fresh.id,
        direction: "out",
        author: "system",
        body: `Risposta automatica non inviata: ${message}`,
        status: "failed",
        created_at: utcStamp(),
      },
    });
    await p.conversation.update({ where: { id: fresh.id }, data: { status: "human" } });
    return { conversationId: fresh.id, replied: false, error: message };
  }

  try {
    const sent = await sendChannelMessage(input.channel, contact, reply);
    await p.message.create({
      data: {
        conversation_id: fresh.id,
        direction: "out",
        author: "assistant",
        body: reply,
        external_id: sent.externalId || null,
        status: sent.status,
        created_at: utcStamp(),
      },
    });
    await p.conversation.update({ where: { id: fresh.id }, data: { last_message_at: utcStamp() } });
    return { conversationId: fresh.id, replied: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invio non riuscito.";
    await p.message.create({
      data: {
        conversation_id: fresh.id,
        direction: "out",
        author: "system",
        body: `Risposta automatica non inviata: ${message}`,
        status: "failed",
        created_at: utcStamp(),
      },
    });
    await p.conversation.update({ where: { id: fresh.id }, data: { status: "human" } });
    return { conversationId: fresh.id, replied: false, error: message };
  }
}

function channelLabel(channel: ChannelRecord): string {
  return channel.provider === "whatsapp" ? "WhatsApp" : channel.provider === "instagram" ? "Instagram" : "SMS";
}

export async function listConversations(): Promise<Record<string, unknown>[]> {
  const rows = await prisma().conversation.findMany({
    orderBy: { last_message_at: "desc" },
    take: 100,
    include: {
      channel: true,
      messages: { orderBy: { id: "desc" }, take: 1 },
    },
  });
  return rows.map((row) => {
    const last = row.messages[0];
    return {
      id: row.id,
      channel_id: row.channel_id,
      contact: row.contact,
      contact_name: row.contact_name,
      status: row.status,
      unread: row.unread,
      auto_reply: row.auto_reply,
      last_message_at: row.last_message_at,
      preview: last ? last.body.slice(0, 140) : "",
      preview_direction: last?.direction ?? "",
      channel: publicChannel(row.channel),
    };
  });
}

export async function conversationThread(id: number): Promise<Record<string, unknown>> {
  const p = prisma();
  const conversation = await p.conversation.findUnique({
    where: { id },
    include: { channel: true },
  });
  if (!conversation) throw new Invalid("Conversazione non trovata.");
  const messages = await p.message.findMany({
    where: { conversation_id: id },
    orderBy: { id: "asc" },
    take: 300,
  });
  if (conversation.unread > 0) {
    await p.conversation.update({ where: { id }, data: { unread: 0 } });
  }
  return {
    conversation: {
      id: conversation.id,
      contact: conversation.contact,
      contact_name: conversation.contact_name,
      status: conversation.status,
      auto_reply: conversation.auto_reply,
      last_message_at: conversation.last_message_at,
    },
    channel: publicChannel(conversation.channel),
    messages,
  };
}

export async function sendManualReply(id: number, body: string): Promise<Record<string, unknown>> {
  const text = (body ?? "").trim();
  if (!text) throw new Invalid("Scrivi un messaggio prima di inviarlo.");
  if (text.length > 4000) throw new Invalid("Messaggio troppo lungo (massimo 4000 caratteri).");

  const p = prisma();
  const conversation = await p.conversation.findUnique({
    where: { id },
    include: { channel: true },
  });
  if (!conversation) throw new Invalid("Conversazione non trovata.");

  const now = utcStamp();
  try {
    const sent = await sendChannelMessage(conversation.channel, conversation.contact, text);
    const message = await p.message.create({
      data: {
        conversation_id: id,
        direction: "out",
        author: "human",
        body: text,
        external_id: sent.externalId || null,
        status: sent.status,
        created_at: now,
      },
    });
    await p.conversation.update({
      where: { id },
      data: { status: "human", unread: 0, last_message_at: now },
    });
    return message;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invio non riuscito.";
    await p.message.create({
      data: {
        conversation_id: id,
        direction: "out",
        author: "system",
        body: `Messaggio non inviato: ${message}`,
        status: "failed",
        created_at: now,
      },
    });
    throw new Invalid(message);
  }
}

/** Cambia stato della conversazione: auto-risposta, presa in carico, archiviazione. */
export async function setConversationState(
  id: number,
  patch: { auto_reply?: boolean; status?: string; read?: boolean },
): Promise<Record<string, unknown>> {
  const data: Record<string, unknown> = {};
  if (typeof patch.auto_reply === "boolean") data.auto_reply = patch.auto_reply;
  if (patch.status !== undefined) {
    if (!["open", "human", "closed"].includes(patch.status)) throw new Invalid("Stato conversazione non valido.");
    data.status = patch.status;
  }
  if (patch.read === true) data.unread = 0;
  if (!Object.keys(data).length) throw new Invalid("Nessuna modifica richiesta.");
  const p = prisma();
  const found = await p.conversation.findUnique({ where: { id } });
  if (!found) throw new Invalid("Conversazione non trovata.");
  const updated = await p.conversation.update({ where: { id }, data });
  return {
    id: updated.id,
    status: updated.status,
    auto_reply: updated.auto_reply,
    unread: updated.unread,
  };
}

/** Credenziali del canale per i webhook (usate solo lato server). */
export function credentialsOf(channel: ChannelRecord): ReturnType<typeof channelCredentials> {
  return channelCredentials(channel);
}
