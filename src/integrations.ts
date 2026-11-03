// Integrazioni Google (OAuth Calendar) e Apple (IMAP + SMTP): stato,
// collegamento e verifica delle credenziali. I segreti restano cifrati con
// INTEGRATIONS_KEY (v1:<iv>:<tag>:<ct>) nella tabella settings.
import { randomBytes } from "node:crypto";
import { ImapFlow } from "imapflow";
import { prisma } from "./db.js";
import { sealSecret } from "./crypto.js";
import { Invalid } from "./util.js";

const GOOGLE_SCOPES = "https://www.googleapis.com/auth/calendar.events openid email";
const STATE_TTL_MS = 10 * 60_000;

export interface IntegrationStatus {
  key_configured: boolean;
  google: { connected: boolean; needs_reauth: boolean };
  apple: { connected: boolean };
  sender: string;
}

export async function integrationStatus(): Promise<IntegrationStatus> {
  const p = prisma();
  const keyConfigured = !!process.env.INTEGRATIONS_KEY;
  const [googleState, appleRow, senderRow] = await Promise.all([
    p.setting.findUnique({ where: { key: "int_google_status" } }),
    p.setting.findUnique({ where: { key: "int_apple" } }),
    p.setting.findUnique({ where: { key: "email_sender" } }),
  ]);
  return {
    key_configured: keyConfigured,
    google: {
      connected: keyConfigured && googleState?.value === "connected",
      needs_reauth: googleState?.value === "reauth_required",
    },
    apple: { connected: keyConfigured && !!appleRow },
    sender: senderRow?.value ?? "",
  };
}

function requireGoogleEnv(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret || !process.env.INTEGRATIONS_KEY) {
    throw new Invalid("Configurazione Google mancante: imposta GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET e INTEGRATIONS_KEY.");
  }
  return { clientId, clientSecret };
}

/** URL di consenso Google; il nonce (10 min) viene consumato dal callback. */
export async function googleConnectUrl(origin: string): Promise<string> {
  const { clientId } = requireGoogleEnv();
  const nonce = randomBytes(24).toString("base64url");
  const p = prisma();
  const value = `${nonce}:${Date.now() + STATE_TTL_MS}`;
  await p.setting.upsert({
    where: { key: "int_google_state" },
    update: { value },
    create: { key: "int_google_state", value },
  });
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${origin}/api/integrations/google/callback`,
    response_type: "code",
    scope: GOOGLE_SCOPES,
    access_type: "offline",
    prompt: "consent",
    state: nonce,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/**
 * Scambio del codice: true se salvato, false se lo state non è valido.
 * Lancia Invalid (400) se lo scambio fallisce — nessun record parziale.
 */
export async function googleCallback(query: URLSearchParams, origin: string): Promise<boolean> {
  const p = prisma();
  const state = query.get("state") ?? "";
  const code = query.get("code") ?? "";
  const stateRow = await p.setting.findUnique({ where: { key: "int_google_state" } });
  const [nonce, expiry] = (stateRow?.value ?? "").split(":");
  if (!nonce || !code || state !== nonce || Date.now() > Number(expiry)) return false;

  const { clientId, clientSecret } = requireGoogleEnv();
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: `${origin}/api/integrations/google/callback`,
    }).toString(),
  });
  if (!res.ok) throw new Invalid("Scambio del codice Google non riuscito: riprova a collegare l'account.");
  const tokens = (await res.json()) as Record<string, unknown>;

  // Il refresh_token a volte non viene risposto: si conserva quello già salvato.
  let refresh = typeof tokens.refresh_token === "string" ? tokens.refresh_token : "";
  if (!refresh) {
    const old = await p.setting.findUnique({ where: { key: "int_google" } });
    if (old) {
      try {
        const { openSecret } = await import("./crypto.js");
        const parsed = JSON.parse(openSecret(old.value));
        refresh = typeof parsed.refresh_token === "string" ? parsed.refresh_token : "";
      } catch {
        refresh = "";
      }
    }
  }
  if (!refresh) {
    throw new Invalid("Google non ha rilasciato l'aggiornamento del token: ricollega l'account.");
  }

  const payload = JSON.stringify({
    access_token: typeof tokens.access_token === "string" ? tokens.access_token : "",
    refresh_token: refresh,
    expires_at: Date.now() + Number(tokens.expires_in ?? 3600) * 1000,
  });
  const sealed = sealSecret(payload);
  await p.setting.upsert({
    where: { key: "int_google" },
    update: { value: sealed },
    create: { key: "int_google", value: sealed },
  });
  await p.setting.upsert({
    where: { key: "int_google_status" },
    update: { value: "connected" },
    create: { key: "int_google_status", value: "connected" },
  });
  await p.setting.delete({ where: { key: "int_google_state" } }).catch(() => undefined);
  return true;
}

/** Verifica le credenziali Apple con un login IMAP reale (timeout corto). */
export async function verifyApple(appleId: string, appPassword: string): Promise<void> {
  const client = new ImapFlow({
    host: "imap.mail.me.com",
    port: 993,
    secure: true,
    auth: { user: appleId, pass: appPassword },
    logger: false,
    socketTimeout: 10_000,
    greetingTimeout: 10_000,
    connectionTimeout: 10_000,
  });
  try {
    await client.connect();
  } finally {
    try {
      await client.logout();
    } catch {
      /* la disconnessione ignorata */
    }
  }
}

export async function saveApple(
  appleId: string,
  appPassword: string,
  senderEmail: string,
): Promise<void> {
  if (!process.env.INTEGRATIONS_KEY) {
    throw new Invalid("Configurazione mancante: imposta INTEGRATIONS_KEY.");
  }
  await verifyApple(appleId, appPassword);
  const p = prisma();
  const sealed = sealSecret(JSON.stringify({ apple_id: appleId, app_password: appPassword }));
  await p.setting.upsert({
    where: { key: "int_apple" },
    update: { value: sealed },
    create: { key: "int_apple", value: sealed },
  });
  await p.setting.upsert({
    where: { key: "int_apple_status" },
    update: { value: "connected" },
    create: { key: "int_apple_status", value: "connected" },
  });
  await p.setting.upsert({
    where: { key: "email_sender" },
    update: { value: senderEmail },
    create: { key: "email_sender", value: senderEmail },
  });
}

export async function removeApple(): Promise<void> {
  const p = prisma();
  await p.setting.deleteMany({ where: { key: { in: ["int_apple", "int_apple_status"] } } });
}
