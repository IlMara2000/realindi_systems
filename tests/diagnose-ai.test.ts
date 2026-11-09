// Diagnostica Developer API: il probe si verifica con un server locale, senza
// rete né chiavi reali. Il punto delicato è che la chiave non compaia mai
// nell'esito, nemmeno quando il provider la ripete in un messaggio d'errore.
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { probeAiProvider, redact } from "../scripts/diagnose-ai.js";

const KEY = "sk-test-diagnostica-1234567890";

let server: Server | null = null;

async function withServer(
  answer: (body: { model?: string; messages?: unknown[] }) => { status: number; body: unknown },
  delay_ms = 0,
): Promise<string> {
  const s = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const parsed = raw ? (JSON.parse(raw) as { model?: string; messages?: unknown[] }) : {};
      const out = answer(parsed);
      // Un ritardo esplicito rende deterministico il caso del timeout: senza di
      // esso la risposta istantanea del server locale vince la gara con l'abort.
      setTimeout(() => {
        if (res.destroyed || res.writableEnded) return;
        res.writeHead(out.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(out.body));
      }, delay_ms);
    });
  });
  server = s;
  await new Promise<void>((done) => s.listen(0, "127.0.0.1", done));
  const address = s.address();
  if (!address || typeof address === "string") throw new Error("porta non assegnata");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  const s = server;
  server = null;
  if (s) await new Promise<void>((done) => s.close(() => done()));
});

describe("diagnostica AI", () => {
  it("riporta modello, latenza e risposta quando il provider risponde", async () => {
    const base = await withServer((body) => ({
      status: 200,
      body: {
        model: body.model,
        choices: [{ message: { content: "Facciamo siti e applicazioni su misura." } }],
        usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
      },
    }));

    const result = await probeAiProvider({
      base_url: base,
      model: "deepseek-v4.1-flash",
      key: KEY,
      message: "Che fate?",
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.model).toBe("deepseek-v4.1-flash");
    expect(result.reply).toContain("siti");
    expect(result.error).toBeNull();
    expect(result.usage?.total_tokens).toBe(19);
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("non espone la chiave nemmeno se il provider la ripete nell'errore", async () => {
    const base = await withServer(() => ({
      status: 401,
      body: { error: { message: `Invalid API key ${KEY}` } },
    }));

    const result = await probeAiProvider({
      base_url: base,
      model: "deepseek-v4.1-flash",
      key: KEY,
      message: "ciao",
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error).toContain("Invalid API key");
    expect(result.error).not.toContain(KEY);
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("tratta una risposta senza contenuto come errore", async () => {
    const base = await withServer(() => ({
      status: 200,
      body: { model: "deepseek-v4.1-flash", choices: [{ message: { content: "   " } }] },
    }));

    const result = await probeAiProvider({
      base_url: `${base}/`,
      model: "deepseek-v4.1-flash",
      key: KEY,
      message: "ciao",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("risposta vuota dal provider");
  });

  it("riporta un timeout senza inventare una risposta", async () => {
    const base = await withServer(() => ({ status: 200, body: {} }), 300);

    const result = await probeAiProvider({
      base_url: base,
      model: "deepseek-v4.1-flash",
      key: KEY,
      message: "ciao",
      timeout_ms: 50,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.error).toContain("entro");
  });

  it("redact sostituisce ogni occorrenza del segreto", () => {
    expect(redact(`a ${KEY} b ${KEY}`, KEY)).toBe("a [chiave omessa] b [chiave omessa]");
    expect(redact("niente da nascondere", "")).toBe("niente da nascondere");
  });
});
