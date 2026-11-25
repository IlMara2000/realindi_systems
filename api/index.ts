// Funzione Vercel: endpoint unico per /api/*.
// Il rewrite di vercel.json porta /api/qualcosa → /api?path=qualcosa;
// il path originale viene ricostruito qui prima di passarlo al handler.
import { handle } from "../src/handler.js";
import { clientIp } from "../src/util.js";

interface VercelRequest {
  url?: string;
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  socket?: { remoteAddress?: string };
  [key: string]: unknown;
}

interface VercelResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: Buffer | string): void;
}

// Le pagine che il server deve generare per forza (vetrina e link-in-bio hanno
// un HTML diverso per chi ha la sessione) vivono fuori dalla radice statica e
// arrivano qui con ?page=. Solo questi nomi sono ammessi: la funzione non deve
// diventare un modo per raggiungere percorsi arbitrari.
const PAGE_ROUTES = new Map<string, string>([
  ["home", "/"],
  ["bio", "/bio"],
]);

function notFound(res: VercelResponse): void {
  res.statusCode = 404;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({ error: "Pagina non trovata." }));
}

async function readBody(req: VercelRequest): Promise<Buffer> {
  // Vercel pre-parsa i body JSON: lo riserializziamo (le chiavi restano in ordine).
  if (req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body)) return req.body;
    if (typeof req.body === "string") return Buffer.from(req.body, "utf8");
    return Buffer.from(JSON.stringify(req.body), "utf8");
  }
  const chunks: Buffer[] = [];
  const stream = req as unknown as AsyncIterable<Buffer>;
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value.join(", ");
  return value;
}

export default async function apiHandler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pageName = url.searchParams.get("page");
  url.searchParams.delete("page");
  const pagePath = pageName === null ? null : (PAGE_ROUTES.get(pageName) ?? null);
  if (pageName !== null && pagePath === null) {
    notFound(res);
    return;
  }

  // Link brevi: /l/<slug> è pubblico e arriva qui con ?link=<slug>. Lo slug è
  // ricontrollato: il rewrite non deve diventare un percorso arbitrario.
  const shortSlug = url.searchParams.get("link");
  if (shortSlug !== null && !/^[a-z0-9-]{2,40}$/.test(shortSlug)) {
    notFound(res);
    return;
  }

  const segments = url.searchParams.get("path");
  const apiPath =
    pagePath ?? (shortSlug !== null ? `/l/${shortSlug}` : segments ? `/api/${segments}` : "/api/");
  url.searchParams.delete("path");
  url.searchParams.delete("link");

  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    headers[key] = headerValue(value);
  }
  // L'IP lo imposta la piattaforma: gli header si leggono solo qui, non nel
  // server di sviluppo, dove sarebbero scrivibili da chi fa la richiesta.
  const ip = clientIp(headers, req.socket?.remoteAddress, {
    dietroProxy: process.env.VERCEL === "1",
  });
  const out = await handle({
    method: req.method ?? "GET",
    path: apiPath,
    query: url.searchParams.toString(),
    headers,
    body: await readBody(req),
    ip,
  });
  res.statusCode = out.status;
  for (const [key, value] of out.headers) res.setHeader(key, value);
  res.end(out.body);
}
