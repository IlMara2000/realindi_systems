// Diagnostica della Developer API dell'assistente: invia un messaggio minimo
// all'endpoint e riporta provider, modello, latenza ed eventuale errore.
//
// La chiave arriva dal database (cifrata con INTEGRATIONS_KEY) oppure da
// AI_API_KEY/OPENAI_API_KEY, con le stesse precedenze dell'assistente, e non
// viene mai stampata: si riportano solo provenienza e lunghezza. Anche il testo
// restituito dal provider passa da `redact`, perché un messaggio d'errore può
// ripetere la chiave.
//
// Uscita: 0 risposta ricevuta, 1 provider in errore o irraggiungibile,
// 2 configurazione assente (chiave o modulo).
import "dotenv/config";
import { pathToFileURL } from "node:url";

const TIMEOUT_MS = 20_000;
const DEFAULT_MESSAGE = "Ciao, che servizi offrite?";

export interface ProbeConfig {
  base_url: string;
  model: string;
  key: string;
  message: string;
  timeout_ms?: number;
}

export interface ProbeResult {
  ok: boolean;
  status: number;
  latency_ms: number;
  model: string;
  reply: string | null;
  error: string | null;
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
}

/** Sostituisce ogni occorrenza del segreto: vale anche per i testi del provider. */
export function redact(text: string, secret: string): string {
  if (!secret) return text;
  return text.split(secret).join("[chiave omessa]");
}

/** Una richiesta reale, con la stessa forma usata da generateReply. */
export async function probeAiProvider(cfg: ProbeConfig): Promise<ProbeResult> {
  const started = performance.now();
  const elapsed = (): number => Math.round(performance.now() - started);
  const timeout = cfg.timeout_ms ?? TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(`${cfg.base_url.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${cfg.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: "system", content: "Rispondi in italiano con una sola frase breve." },
          { role: "user", content: cfg.message },
        ],
        temperature: 0,
        max_tokens: 80,
      }),
    });

    const body = (await res.json().catch(() => ({}))) as {
      model?: unknown;
      choices?: { message?: { content?: unknown } }[];
      error?: { message?: unknown };
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const latency_ms = elapsed();

    if (!res.ok) {
      const detail = typeof body.error?.message === "string" ? body.error.message : `errore ${res.status}`;
      return {
        ok: false,
        status: res.status,
        latency_ms,
        model: cfg.model,
        reply: null,
        error: redact(detail, cfg.key),
        usage: null,
      };
    }

    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      return {
        ok: false,
        status: res.status,
        latency_ms,
        model: cfg.model,
        reply: null,
        error: "risposta vuota dal provider",
        usage: null,
      };
    }

    return {
      ok: true,
      status: res.status,
      latency_ms,
      model: typeof body.model === "string" && body.model ? body.model : cfg.model,
      reply: redact(content.trim(), cfg.key),
      error: null,
      usage: body.usage ?? null,
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      status: 0,
      latency_ms: elapsed(),
      model: cfg.model,
      reply: null,
      error: aborted
        ? `nessuna risposta entro ${Math.round(timeout / 1000)} s`
        : "connessione al provider non riuscita",
      usage: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

interface Provider {
  base_url: string;
  model: string;
  key: string | null;
  key_source: string;
  notice: string;
}

/**
 * Configurazione effettiva: database (con le variabili d'ambiente già
 * prevalenti, come in assistantSettings), altrimenti solo ambiente e default.
 * Se il database non risponde il comando resta utile: è proprio uno dei casi
 * in cui serve capire se il problema è l'AI o la connessione al database.
 */
async function resolveProvider(): Promise<Provider> {
  const mod = await import("../src/assistant.js");
  let base_url = (process.env.AI_BASE_URL ?? "").trim();
  let model = (process.env.AI_MODEL ?? "").trim();
  let key: string | null = null;
  let key_source = "assente";
  let notice = "";

  try {
    const cfg = await mod.assistantSettings();
    base_url = base_url || cfg.base_url;
    model = model || cfg.model;
  } catch {
    // Il messaggio dell'errore può contenere la stringa di connessione: omesso.
    notice =
      "impostazioni dal database non leggibili: uso solo le variabili d'ambiente (dettaglio omesso perché può contenere la stringa di connessione).";
    base_url = base_url || mod.DEFAULT_BASE_URL;
    model = model || mod.DEFAULT_MODEL;
  }

  try {
    const stored = await mod.storedAiKey();
    if (stored) {
      key = stored;
      key_source = "database (cifrata con INTEGRATIONS_KEY)";
    }
  } catch {
    if (!notice) {
      notice = "chiave nel database non leggibile: provo le variabili d'ambiente.";
    }
  }

  if (!key) {
    const envKey = (process.env.AI_API_KEY || process.env.OPENAI_API_KEY || "").trim();
    if (envKey) {
      key = envKey;
      key_source = "variabile d'ambiente (AI_API_KEY/OPENAI_API_KEY)";
    }
  }

  return { base_url, model, key, key_source, notice };
}

function hintFor(result: ProbeResult): string {
  if (result.status === 401 || result.status === 403) {
    return "la chiave non è valida o è stata revocata: creane una da Account → Developer API (https://freebuff.com/account/api) e aggiornala nel CRM o in AI_API_KEY.";
  }
  if (result.status === 429) {
    return "limite di richieste o credito esaurito sul provider: riprova più tardi o controlla il piano su freebuff.com/account/api.";
  }
  if (result.status === 404) {
    return "endpoint non trovato: controlla AI_BASE_URL, deve essere la base senza /chat/completions.";
  }
  if (result.status === 0) {
    return "nessuna risposta di rete: controlla la connessione e che AI_BASE_URL sia raggiungibile da questa macchina.";
  }
  return "il provider ha rifiutato la richiesta: il dettaglio è nella risposta qui sopra.";
}

export async function main(argv: string[]): Promise<number> {
  const message = argv.filter((arg) => !arg.startsWith("--")).join(" ").trim() || DEFAULT_MESSAGE;

  let provider: Provider;
  try {
    provider = await resolveProvider();
  } catch (err) {
    console.error(`Diagnostica non disponibile: ${err instanceof Error ? err.message : "errore"}`);
    return 2;
  }

  if (provider.notice) console.error(`Nota: ${provider.notice}`);

  if (!provider.key) {
    console.error(
      [
        "Nessuna chiave AI configurata.",
        "Salvala in Canali & AI → Assistente, oppure imposta AI_API_KEY nel file .env",
        "(la chiave si crea da Account → Developer API: https://freebuff.com/account/api).",
      ].join("\n"),
    );
    return 2;
  }

  console.log("Diagnostica Developer API");
  console.log(`Provider: ${provider.base_url}`);
  console.log(`Modello: ${provider.model}`);
  console.log(`Chiave: ${provider.key_source} · ${provider.key.length} caratteri`);
  console.log(`Messaggio: "${message}"`);
  console.log("");

  const result = await probeAiProvider({
    base_url: provider.base_url,
    model: provider.model,
    key: provider.key,
    message,
  });

  if (!result.ok) {
    console.error(
      `Esito: ERRORE (${result.status === 0 ? "nessuna risposta" : `HTTP ${result.status}`}) in ${result.latency_ms} ms`,
    );
    console.error(`Dettaglio: ${result.error}`);
    console.error(`Suggerimento: ${hintFor(result)}`);
    return 1;
  }

  console.log(`Esito: OK (HTTP ${result.status}) in ${result.latency_ms} ms`);
  console.log(`Modello usato: ${result.model}`);
  console.log(`Risposta: ${result.reply}`);
  if (result.usage) {
    console.log(
      `Token: prompt ${result.usage.prompt_tokens ?? "?"} · risposta ${result.usage.completion_tokens ?? "?"}`,
    );
  }
  return 0;
}

// Eseguito come comando, non quando il modulo viene importato dai test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
