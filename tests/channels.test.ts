// Canali di messaggistica, webhook firmati, inbox e auto-apprendimento.
import { createHmac } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startServer, type RunningServer } from "../scripts/dev-server.js";
import { makeClient, resetDb, type TestClient } from "./helpers.js";

// Le credenziali dei canali sono cifrate: la suite usa una chiave dedicata.
process.env.INTEGRATIONS_KEY ??= "test-integrations-key-per-i-canali-0123456789";

let server: RunningServer;
let base: string;

beforeAll(async () => {
  server = await startServer(0);
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
});

beforeEach(async () => {
  await resetDb();
});

async function fresh(): Promise<TestClient> {
  const c = makeClient(base);
  const r = await c.setup();
  if (r.status !== 200) throw new Error(`setup ${r.status}: ${JSON.stringify(r.body)}`);
  return c;
}

async function addSmsChannel(c: TestClient, verifyToken = "verify-token-123") {
  const res = await c.request("/api/channels", {
    provider: "sms",
    label: "SMS attività",
    account_sid: "AC" + "a".repeat(32),
    auth_token: "token-twilio-di-prova",
    from: "+393331112222",
    verify_token: verifyToken,
    verify: false,
  });
  expect(res.status).toBe(200);
  return res.body.channel;
}

async function addWhatsAppChannel(c: TestClient, appSecret = "segreto-app-meta") {
  const res = await c.request("/api/channels", {
    provider: "whatsapp",
    label: "WhatsApp attività",
    phone_number_id: "123456789",
    access_token: "EAAG" + "x".repeat(40),
    app_secret: appSecret,
    verify_token: "verify-wa-123",
    verify: false,
  });
  expect(res.status).toBe(200);
  return res.body.channel;
}

describe("canali", () => {
  it("richiede la sessione e non restituisce i segreti", async () => {
    const anon = await fetch(`${base}/api/channels`);
    expect(anon.status).toBe(401);

    const c = await fresh();
    const channel = await addSmsChannel(c);
    expect(channel.provider).toBe("sms");
    expect(channel.verify_token).toBe("verify-token-123");
    expect(channel.status).toBe("connected");

    const listed = await c.request("/api/channels");
    expect(listed.status).toBe(200);
    const text = JSON.stringify(listed.body);
    expect(text).not.toContain("token-twilio-di-prova");
    expect(text).not.toContain("auth_token");

    const duplicate = await c.request("/api/channels", {
      provider: "sms",
      account_sid: "AC" + "a".repeat(32),
      auth_token: "token-twilio-di-prova",
      from: "+393331112222",
      verify: false,
    });
    expect(duplicate.status).toBe(400);
    expect(duplicate.body.error).toMatch(/già collegato/i);
  });

  it("valida i campi obbligatori del provider", async () => {
    const c = await fresh();
    const res = await c.request("/api/channels", {
      provider: "whatsapp",
      phone_number_id: "non-un-numero",
      access_token: "corto",
      verify: false,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Phone number ID/i);
  });

  it("disconnette il canale con le sue conversazioni", async () => {
    const c = await fresh();
    const channel = await addSmsChannel(c);
    const params: Record<string, string> = {
      From: "+393331110000",
      To: "+393331112222",
      Body: "Ciao",
      MessageSid: "SM-DELETE-1",
    };
    const url = `${base}/api/webhooks/sms`;
    const data = Object.keys(params)
      .sort()
      .reduce((acc, key) => acc + key + params[key], url);
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-forwarded-proto": "http",
        "X-Twilio-Signature": createHmac("sha1", "token-twilio-di-prova").update(data, "utf8").digest("base64"),
      },
      body: new URLSearchParams(params).toString(),
    });
    expect((await c.state()).conversations).toHaveLength(1);

    const removed = await c.request("/api/channels/delete", { id: channel.id });
    expect(removed.status).toBe(200);
    expect((await c.state()).channels).toHaveLength(0);
    expect((await c.state()).conversations).toHaveLength(0);
  });
});

describe("webhook WhatsApp", () => {
  const payload = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA-1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "393331112222", phone_number_id: "123456789" },
              contacts: [{ profile: { name: "Mario Rossi" }, wa_id: "393330001111" }],
              messages: [
                {
                  from: "393330001111",
                  id: "wamid.TEST-1",
                  timestamp: "1",
                  type: "text",
                  text: { body: "Ciao, quanto costa un gestionale?" },
                },
              ],
            },
          },
        ],
      },
    ],
  };

  function signed(body: string): string {
    return "sha256=" + createHmac("sha256", "segreto-app-meta").update(body).digest("hex");
  }

  it("verifica l'handshake di Meta con il token del canale", async () => {
    const c = await fresh();
    await addWhatsAppChannel(c);
    const ok = await fetch(
      `${base}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-wa-123&hub.challenge=12345`,
    );
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("12345");

    const bad = await fetch(
      `${base}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=sbagliato&hub.challenge=1`,
    );
    expect(bad.status).toBe(403);
  });

  it("rifiuta payload senza firma valida", async () => {
    const c = await fresh();
    await addWhatsAppChannel(c);
    const raw = JSON.stringify(payload);
    const res = await fetch(`${base}/api/webhooks/whatsapp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw,
    });
    expect(res.status).toBe(403);
    expect((await c.state()).conversations).toHaveLength(0);
  });

  it("salva il messaggio una sola volta anche se Meta lo ripete", async () => {
    const c = await fresh();
    await addWhatsAppChannel(c);
    const raw = JSON.stringify(payload);
    for (let i = 0; i < 2; i += 1) {
      const res = await fetch(`${base}/api/webhooks/whatsapp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signed(raw) },
        body: raw,
      });
      expect(res.status).toBe(200);
    }
    const state = await c.state();
    expect(state.conversations).toHaveLength(1);
    expect(state.conversations[0].contact_name).toBe("Mario Rossi");
    expect(state.conversations[0].unread).toBe(1);

    const thread = await c.request(`/api/conversations/${state.conversations[0].id}`);
    expect(thread.status).toBe(200);
    expect(thread.body.messages).toHaveLength(1);
    expect(thread.body.messages[0].body).toContain("gestionale");
    expect(thread.body.channel.provider).toBe("whatsapp");
  });
});

describe("webhook SMS (Twilio)", () => {
  function twilioSignature(url: string, params: Record<string, string>, token: string): string {
    const data = Object.keys(params)
      .sort()
      .reduce((acc, key) => acc + key + params[key], url);
    return createHmac("sha1", token).update(data, "utf8").digest("base64");
  }

  it("accetta solo la firma Twilio corretta e crea la conversazione", async () => {
    const c = await fresh();
    const channel = await addSmsChannel(c);
    const params: Record<string, string> = {
      From: "+393330002222",
      To: "+393331112222",
      Body: "Buongiorno, avete tempo per un sito?",
      MessageSid: "SM1234567890",
    };
    const url = `${base}/api/webhooks/sms`;

    const forged = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-forwarded-proto": "http",
        "X-Twilio-Signature": "firma-sbagliata",
      },
      body: new URLSearchParams(params).toString(),
    });
    expect(forged.status).toBe(403);

    const signed = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-forwarded-proto": "http",
        "X-Twilio-Signature": twilioSignature(url, params, "token-twilio-di-prova"),
      },
      body: new URLSearchParams(params).toString(),
    });
    expect(signed.status).toBe(200);
    expect(await signed.text()).toContain("<Response");

    const state = await c.state();
    expect(state.conversations).toHaveLength(1);
    expect(state.conversations[0].channel.id).toBe(channel.id);
    expect(state.conversations[0].preview).toContain("sito");
  });
});

describe("assistente", () => {
  it("salva la configurazione e cifra la chiave AI", async () => {
    const c = await fresh();
    const res = await c.request("/api/assistant", {
      assistant_enabled: true,
      assistant_name: "Sofia",
      assistant_tone: "professionale",
      assistant_language: "it",
      assistant_signature: "Sofia · REALINDI",
      assistant_notes: "Lavoriamo su appuntamento.",
      assistant_model: "gpt-4o-mini",
      assistant_base_url: "https://api.openai.com/v1",
      assistant_max_chars: 600,
      assistant_handoff_email: "ciao@example.test",
      api_key: "sk-test-chiave-1234567890",
    });
    expect(res.status).toBe(200);
    expect(res.body.assistant.key_configured).toBe(true);
    expect(res.body.assistant.name).toBe("Sofia");

    const state = await c.state();
    expect(state.assistant.enabled).toBe(true);
    expect(JSON.stringify(state)).not.toContain("sk-test-chiave-1234567890");
  });

  it("auto-apprende dal sito e ricostruisce la scheda attività", async () => {
    const c = await fresh();
    await c.request("/api/assistant", {
      assistant_enabled: true,
      assistant_name: "Sofia",
      assistant_notes: "Preferisco essere contattato via email.",
    });
    const res = await c.request("/api/assistant/train", { site_url: base });
    expect(res.status).toBe(200);
    expect(res.body.pages).toBeGreaterThanOrEqual(1);
    expect(res.body.changed).toBeGreaterThanOrEqual(1);
    expect(res.body.at).toMatch(/^\d{4}-\d{2}-\d{2}/);

    const state = await c.state();
    expect(state.assistant.trained_at).toBeTruthy();
    const urls = state.knowledge.docs.map((d: { url: string }) => d.url);
    expect(urls).toContain("manual:attivita");
    expect(urls.some((u: string) => u.startsWith(base))).toBe(true);
    expect(state.knowledge.chars).toBeGreaterThan(100);
  });

  it("spiega che manca la chiave AI prima di provare una risposta", async () => {
    const c = await fresh();
    const res = await c.request("/api/assistant/preview", { text: "Quanto costa un sito?" });
    expect(res.status).toBe(400);
    expect(res.body.error.toLowerCase()).toContain("chiave ai");
  });

  it("permette di mettere in pausa l'auto-risposta di una conversazione", async () => {
    const c = await fresh();
    const channel = await addSmsChannel(c);
    const raw = new URLSearchParams({
      From: "+393330003333",
      To: "+393331112222",
      Body: "Test",
      MessageSid: "SM-2",
    });
    const url = `${base}/api/webhooks/sms`;
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-forwarded-proto": "http",
        "X-Twilio-Signature": twilioSignature(url, Object.fromEntries(raw), "token-twilio-di-prova"),
      },
      body: raw.toString(),
    });
    const conversation = (await c.state()).conversations[0];
    expect(conversation.channel.id).toBe(channel.id);

    const paused = await c.request("/api/conversations/state", {
      id: conversation.id,
      auto_reply: false,
      status: "human",
    });
    expect(paused.status).toBe(200);
    expect(paused.body.conversation.auto_reply).toBe(false);
    expect(paused.body.conversation.status).toBe("human");

    function twilioSignature(urlValue: string, params: Record<string, string>, token: string): string {
      const data = Object.keys(params)
        .sort()
        .reduce((acc, key) => acc + key + params[key], urlValue);
      return createHmac("sha1", token).update(data, "utf8").digest("base64");
    }
  });
});
