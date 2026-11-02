// Server di sviluppo locale: node:http → lo stesso handler delle funzioni Vercel.
// Esporta startServer() per la suite di test; se eseguito come script, ascolta.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { handle } from "../src/handler.js";

export interface RunningServer {
  server: Server;
  port: number;
  close(): Promise<void>;
}

export function startServer(
  port = 0,
  host = "127.0.0.1",
): Promise<RunningServer> {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer));
      const headers: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        headers[key] = Array.isArray(value) ? value.join(", ") : value;
      }
      const out = await handle({
        method: req.method ?? "GET",
        path: url.pathname,
        query: url.search.slice(1),
        headers,
        body: Buffer.concat(chunks),
        ip: req.socket.remoteAddress ?? "127.0.0.1",
      });
      res.statusCode = out.status;
      for (const [key, value] of out.headers) res.setHeader(key, value);
      res.setHeader("Content-Length", String(out.body.length));
      res.end(out.body);
    } catch (err) {
      console.error(err);
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "Errore interno. Controlla il server." }));
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const addr = server.address() as AddressInfo;
      resolve({
        server,
        port: addr.port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const wanted = Number(process.env.CRM_PORT ?? 8080);
  const host = process.env.CRM_HOST ?? "127.0.0.1";
  startServer(wanted, host).then(({ port }) => {
    console.log(`REALINDI CRM pronto: http://${host}:${port}`);
  });
}
