// End-to-end di Buffy: server HTTP reale (scripts/dev-server.ts), database
// Postgres isolato creato da tests/global-setup.ts e provider AI locale
// OpenAI-compatibile.
//
// La chiave AI è configurata in AGENT_API_KEY come una chiave qualsiasi: il
// provider di prova la riceve come Bearer e la verifica. Nessuna rete, nessun
// costo, esito deterministico anche in CI. Con AGENT_E2E_LIVE=1 e una chiave
// reale nell'ambiente gira in più un controllo in sola lettura sul provider
// effettivamente configurato.
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../scripts/dev-server.js";
import {
  configureFiscal,
  createProject,
  finalizeInvoice,
  makeClient,
  resetDb,
  sql,
  type TestClient,
} from "./helpers.js";

const TEST_KEY = "sk-buffy-e2e-test-0123456789abcdef";
const TEST_MODEL = "buffy-e2e";
const TEST_INTEGRATIONS_KEY = randomBytes(32).toString("hex");

interface ProviderRequest {
  authorization: string;
  model: string;
  messages: { role: string; content: string }[];
}

interface ProviderAnswer {
  reply: string;
  actions: unknown[];
}

interface OutboundRequest {
  url: string;
  body: string;
}

let server: RunningServer;
let base: string;
let provider: Server | null = null;
let providerBase = "";
const providerRequests: ProviderRequest[] = [];
const answers: ProviderAnswer[] = [];
const outbound: OutboundRequest[] = [];
const realFetch = globalThis.fetch;

// Configurazione reale presente prima del test: il provider di prova la
// sostituisce solo per la durata della suite e la ripristina alla fine.
const savedEnv = {
  AGENT_API_KEY: process.env.AGENT_API_KEY,
  AGENT_BASE_URL: process.env.AGENT_BASE_URL,
  AGENT_MODEL: process.env.AGENT_MODEL,
  INTEGRATIONS_KEY: process.env.INTEGRATIONS_KEY,
};

function queueAnswer(reply: string, actions: unknown[] = []): void {
  answers.push({ reply, actions });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Provider OpenAI-compatibile: risponde con la coda preparata dal test. */
function startProvider(): Promise<void> {
  const stub = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      if (req.method !== "POST" || !(req.url ?? "").startsWith("/chat/completions")) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "rotta sconosciuta" } }));
        return;
      }
      let body: { model?: string; messages?: ProviderRequest["messages"] } = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof body;
      } catch {
        // corpo illeggibile: il test fallisce sull'assenza di risposta
      }
      providerRequests.push({
        authorization: req.headers.authorization ?? "",
        model: typeof body.model === "string" ? body.model : "",
        messages: Array.isArray(body.messages) ? body.messages : [],
      });
      const answer = answers.shift();
      if (!answer) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "nessuna risposta preparata dal test" } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          model: TEST_MODEL,
          choices: [
            {
              message: {
                content: JSON.stringify({ reply: answer.reply, actions: answer.actions }),
              },
            },
          ],
          usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
        }),
      );
    });
  });
  return new Promise<void>((done) => {
    stub.listen(0, "127.0.0.1", () => {
      provider = stub;
      const address = stub.address();
      if (!address || typeof address === "string") throw new Error("porta del provider non assegnata");
      providerBase = `http://127.0.0.1:${address.port}`;
      done();
    });
  });
}

beforeAll(async () => {
  await startProvider();
  process.env.AGENT_API_KEY = TEST_KEY;
  process.env.AGENT_BASE_URL = `${providerBase}/`;
  process.env.AGENT_MODEL = TEST_MODEL;
  process.env.INTEGRATIONS_KEY = TEST_INTEGRATIONS_KEY;

  // Solo l'invio sui canali esce verso Internet: qui viene intercettato, mentre
  // le chiamate al provider di prova passano sul fetch vero.
  globalThis.fetch = (async (input: any, init?: any) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : String(input?.url ?? "");
    if (url.startsWith("https://graph.facebook.com/")) {
      outbound.push({ url, body: init?.body ? String(init.body) : "" });
      return jsonResponse({ messages: [{ id: "wamid.E2E" }] });
    }
    return realFetch(input, init);
  }) as typeof fetch;

  server = await startServer(0);
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await server?.close();
  const stub = provider;
  provider = null;
  if (stub) await new Promise<void>((done) => stub.close(() => done()));
});

beforeEach(async () => {
  await resetDb();
  providerRequests.length = 0;
  answers.length = 0;
  outbound.length = 0;
});

async function fresh(): Promise<TestClient> {
  const c = makeClient(base);
  const res = await c.setup();
  if (res.status !== 200) throw new Error(`setup ${res.status}: ${JSON.stringify(res.body)}`);
  return c;
}

function quoteAction(projectId: number): Record<string, unknown> {
  return {
    type: "create_quote",
    label: "Nuovo preventivo",
    data: {
      project_id: projectId,
      title: "Restyling del portale",
      vat_rate: "22",
      notes: "50% alla conferma, 50% alla consegna.",
      items: [
        { description: "Design e prototipo", hours: 10, rate: 60, factor: 1 },
        { description: "Sviluppo frontend", hours: 20, rate: 60, factor: 1.2 },
      ],
    },
  };
}

describe("Buffy end-to-end", () => {
  it("propone le azioni senza eseguirle prima della conferma", async () => {
    const c = await fresh();
    const [, pid] = await createProject(c);
    queueAnswer("Ho preparato il preventivo: vuoi che lo salvi?", [quoteAction(pid)]);

    const res = await c.request("/api/agent", {
      messages: [{ role: "user", content: "Preparami un preventivo per il portale" }],
    });

    expect(res.status).toBe(200);
    expect(res.body.actions).toHaveLength(1);
    expect(res.body.actions[0].type).toBe("create_quote");
    expect(res.body.actions[0].summary).toContain("Restyling del portale");
    expect(res.body.actions[0].data.project_id).toBe(pid);

    // Il provider ha ricevuto la chiave configurata, il modello e il contesto.
    expect(providerRequests).toHaveLength(1);
    expect(providerRequests[0].authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(providerRequests[0].model).toBe(TEST_MODEL);
    const system = providerRequests[0].messages[0];
    expect(system.role).toBe("system");
    expect(system.content).toContain("CONTESTO WORKSPACE");
    expect(system.content).toContain("Portale clienti");
    expect(system.content).not.toContain(TEST_KEY);

    // Niente è stato scritto: le azioni esistono solo nella risposta.
    const state = await c.state();
    expect(state.quotes).toHaveLength(0);
    expect((await c.request("/api/ricevute")).body.receipts).toHaveLength(0);
  });

  it("applica preventivo, accettazione, fattura e pagamento", async () => {
    const c = await fresh();
    const [cid, pid] = await createProject(c);

    const created = await c.request("/api/agent/actions", { actions: [quoteAction(pid)] });
    expect(created.status).toBe(200);
    expect(created.body.results[0].ok).toBe(true);

    let state = await c.state();
    const quote = state.quotes[0];
    expect(quote.title).toBe("Restyling del portale");
    // 10h × 60 € + 20h × 60 € × 1,2 = 2040 € + IVA 22%.
    expect([quote.subtotal, quote.vat, quote.total]).toEqual([204000, 44880, 248880]);
    expect(quote.vat_rate).toBe("22");
    expect(quote.valid_until).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(quote.valid_until > new Date().toISOString().slice(0, 10)).toBe(true);

    const accepted = await c.request("/api/agent/actions", {
      actions: [{ type: "update_quote_status", data: { id: quote.id, status: "accepted" } }],
    });
    expect(accepted.body.results[0].ok).toBe(true);
    expect(accepted.body.results[0].message).toContain("fattura in bozza");

    state = await c.state();
    expect(state.quotes[0].status).toBe("accepted");
    expect(state.projects[0].status).toBe("active");
    expect(state.invoices).toHaveLength(1);
    const invoice = state.invoices[0];
    expect(invoice.quote_id).toBe(quote.id);
    expect(invoice.status).toBe("draft");
    expect(invoice.total).toBe(248880);

    // Un preventivo accettato non si accetta due volte, e una bozza non è pagata.
    const again = await c.request("/api/agent/actions", {
      actions: [{ type: "update_quote_status", data: { id: quote.id, status: "accepted" } }],
    });
    expect(again.body.results[0].ok).toBe(false);

    const draftPaid = await c.request("/api/agent/actions", {
      actions: [{ type: "mark_invoice_paid", data: { id: invoice.id } }],
    });
    expect(draftPaid.body.results[0].ok).toBe(false);
    expect(draftPaid.body.results[0].message).toContain("emessa");

    // La fattura viene numerata dal flusso fiscale esistente, poi Buffy la incassa.
    await configureFiscal(c, cid);
    const finalized = await finalizeInvoice(c, invoice.id);
    expect(finalized.result.id).toBe(invoice.id);

    const paid = await c.request("/api/agent/actions", {
      actions: [{ type: "mark_invoice_paid", data: { id: invoice.id } }],
    });
    expect(paid.body.results[0].ok).toBe(true);
    state = await c.state();
    expect(state.invoices[0].status).toBe("paid");
    expect(state.invoices[0].paid_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("emette e annulla una ricevuta di cassa", async () => {
    const c = await fresh();

    const created = await c.request("/api/agent/actions", {
      actions: [
        {
          type: "create_receipt",
          data: {
            date: "2026-03-04",
            payer: "Mario Rossi",
            amount_eur: 1450.5,
            reason: "Saldo lavori",
            place: "Milano",
            issuer: "REALINDI Systems",
          },
        },
      ],
    });
    expect(created.body.results[0].ok).toBe(true);

    const register = await c.request("/api/ricevute");
    const receipt = register.body.receipts[0];
    expect(receipt.number).toBe(1);
    expect(receipt.year).toBe(2026);
    expect(receipt.amount_cents).toBe(145050);
    expect(receipt.amount_words).toBe(
      "euro millequattrocentocinquanta e cinquanta centesimi",
    );

    const cancelled = await c.request("/api/agent/actions", {
      actions: [{ type: "cancel_receipt", data: { id: receipt.id, reason: "Importo errato" } }],
    });
    expect(cancelled.body.results[0].ok).toBe(true);
    expect((await c.request("/api/ricevute")).body.receipts[0].cancelled_at).toBeTruthy();

    const missing = await c.request("/api/agent/actions", {
      actions: [{ type: "create_receipt", data: { payer: "Anna Bianchi", reason: "Acconto" } }],
    });
    expect(missing.body.results[0].ok).toBe(false);
    expect(missing.body.results[0].message).toContain("importo");
  });

  it("invia un messaggio al cliente solo alla conferma", async () => {
    const c = await fresh();
    const channel = await c.request("/api/channels", {
      provider: "whatsapp",
      label: "WhatsApp test",
      phone_number_id: "1234567890",
      access_token: "EAAG-buffy-e2e-token-0123456789",
      verify: false,
    });
    expect(channel.status).toBe(200);

    const rows = await sql(
      "INSERT INTO conversations (channel_id, contact, contact_name, status, unread, auto_reply, last_message_at) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
      [channel.body.channel.id, "393331234567", "Mario Rossi", "open", 1, true, "2026-11-08 09:00:00"],
    );
    const conversationId = Number(rows[0].id);
    const body = "Ciao Mario,\nconfermo la call per lunedì alle 10. A presto.";

    queueAnswer("Ho preparato il messaggio: controllo io l'invio?", [
      { type: "send_client_message", label: "Messaggio a Mario", data: { conversation_id: conversationId, body } },
    ]);

    const proposed = await c.request("/api/agent", {
      messages: [{ role: "user", content: "Scrivi a Mario che confermo la call di lunedì alle 10" }],
    });
    expect(proposed.status).toBe(200);
    expect(proposed.body.actions[0].type).toBe("send_client_message");
    expect(proposed.body.actions[0].data.body).toBe(body);
    // Prima della conferma non parte nulla verso il canale.
    expect(outbound).toHaveLength(0);
    expect(await sql("SELECT id FROM messages WHERE conversation_id = $1", [conversationId])).toHaveLength(0);

    const applied = await c.request("/api/agent/actions", {
      actions: [{ type: "send_client_message", data: { conversation_id: conversationId, body } }],
    });
    expect(applied.body.results[0].ok).toBe(true);
    expect(applied.body.results[0].message).toContain("Mario Rossi");

    expect(outbound).toHaveLength(1);
    expect(outbound[0].url).toContain("/1234567890/messages");
    const sent = JSON.parse(outbound[0].body) as { to: string; text: { body: string } };
    expect(sent.to).toBe("393331234567");
    expect(sent.text.body).toBe(body);

    const stored = await sql(
      "SELECT direction, author, body, status, external_id FROM messages WHERE conversation_id = $1",
      [conversationId],
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      direction: "out",
      author: "human",
      status: "sent",
      external_id: "wamid.E2E",
    });
    expect(stored[0].body).toBe(body);
    const conversation = await sql("SELECT status FROM conversations WHERE id = $1", [conversationId]);
    expect(conversation[0].status).toBe("human");
  });

  it("rifiuta richieste senza azioni o con tipi sconosciuti", async () => {
    const c = await fresh();

    const empty = await c.request("/api/agent/actions", { actions: [] });
    expect(empty.status).toBe(400);

    const unknown = await c.request("/api/agent/actions", {
      actions: [{ type: "delete_everything", data: {} }],
    });
    expect(unknown.status).toBe(200);
    expect(unknown.body.results[0]).toMatchObject({ ok: false, message: "Azione non supportata." });
  });
});

const liveKey =
  process.env.AGENT_API_KEY || process.env.AI_API_KEY || process.env.OPENAI_API_KEY || "";
const live = process.env.AGENT_E2E_LIVE === "1" && Boolean(liveKey.trim());

describe.skipIf(!live)("Buffy con il provider reale (AGENT_E2E_LIVE=1)", () => {
  it("risponde in sola lettura", async () => {
    // Ripristina la configurazione reale: il provider di prova resta spento.
    for (const key of ["AGENT_API_KEY", "AGENT_BASE_URL", "AGENT_MODEL"] as const) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }

    const c = await fresh();
    const res = await c.request("/api/agent", {
      messages: [{ role: "user", content: "Rispondi in una sola frase: quante fatture ho?" }],
    });

    expect(res.status).toBe(200);
    expect(typeof res.body.reply).toBe("string");
    expect(res.body.reply.trim().length).toBeGreaterThan(0);
    expect(typeof res.body.model).toBe("string");
    // Controllo in sola lettura: le eventuali azioni proposte non vengono applicate.
    expect((await c.state()).quotes).toHaveLength(0);
  });
});
