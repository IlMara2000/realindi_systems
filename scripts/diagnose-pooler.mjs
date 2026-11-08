#!/usr/bin/env node
// Confronta l'endpoint pooled (pooled.db.prisma.io) con quello diretto
// (db.prisma.io) usando la stessa credenziale. Sola lettura: esegue SELECT 1,
// non crea né elimina nulla. Le credenziali sono mascherate nell'output.
//
// Uso: node scripts/diagnose-pooler.mjs [tentativi-per-endpoint]   (default 5)
//
// Esce con 1 se un endpoint non ha accettato NESSUNA connessione: è il codice
// d'uscita usato dal workflow di sorveglianza.

import { existsSync, readFileSync } from "node:fs";
import dns from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";
import { Client } from "pg";

const ATTEMPTS = Number(process.argv[2] ?? 5);
const CONNECT_TIMEOUT_MS = 15_000;
const PAUSE_MS = 500;
const HOSTS = ["pooled.db.prisma.io", "db.prisma.io"];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readEnv() {
  if (!existsSync(".env")) return {};
  const out = {};
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    out[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
  return out;
}

const env = { ...readEnv(), ...process.env };

function withHost(rawUrl, hostname) {
  const url = new URL(rawUrl);
  url.hostname = hostname;
  return url;
}

function masked(url) {
  const copy = new URL(url.toString());
  if (copy.password) copy.password = "***";
  return copy.toString();
}

function compact(error) {
  const message = String(error?.message ?? error).split("\n")[0].trim();
  return error?.code ? `${message} [${error.code}]` : message;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
}

function bases() {
  const seen = new Set();
  const list = [];
  for (const key of ["DATABASE_URL", "DATABASE_URL_TEST"]) {
    const raw = env[key];
    if (!raw) continue;
    const database = new URL(raw).pathname.slice(1) || "postgres";
    if (seen.has(database)) continue;
    seen.add(database);
    list.push({ key, raw, database });
  }
  return list;
}

async function resolveHost(hostname) {
  const started = performance.now();
  try {
    const records = await dns.lookup(hostname, { all: true });
    return {
      hostname,
      ok: true,
      ms: Math.round(performance.now() - started),
      addresses: records.map((r) => r.address).sort(),
    };
  } catch (error) {
    return { hostname, ok: false, ms: Math.round(performance.now() - started), error: compact(error) };
  }
}

function tcpProbe(hostname, port) {
  return new Promise((resolve) => {
    const started = performance.now();
    const socket = net.connect({ host: hostname, port });
    const done = (payload) => {
      socket.destroy();
      resolve({ ...payload, ms: Math.round(performance.now() - started) });
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.once("connect", () => done({ ok: true }));
    socket.once("timeout", () => done({ ok: false, error: "timeout" }));
    socket.once("error", (error) => done({ ok: false, error: compact(error) }));
  });
}

function tlsProbe(hostname, port) {
  return new Promise((resolve) => {
    const started = performance.now();
    // rejectUnauthorized: false è voluto — misuriamo l'handshake, non la CA.
    const socket = tls.connect({ host: hostname, port, servername: hostname, rejectUnauthorized: false });
    const done = (payload) => {
      socket.destroy();
      resolve({ ...payload, ms: Math.round(performance.now() - started) });
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.once("secureConnect", () => done({ ok: true, protocol: socket.getProtocol() }));
    socket.once("timeout", () => done({ ok: false, error: "timeout" }));
    socket.once("error", (error) => done({ ok: false, error: compact(error) }));
  });
}

async function pgProbe(url) {
  const started = performance.now();
  const client = new Client({ connectionString: url.toString(), connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  try {
    await client.connect();
    const connectMs = Math.round(performance.now() - started);
    const queryStarted = performance.now();
    await client.query("SELECT 1");
    return { ok: true, connectMs, queryMs: Math.round(performance.now() - queryStarted) };
  } catch (error) {
    return { ok: false, connectMs: Math.round(performance.now() - started), error: compact(error) };
  } finally {
    await client.end().catch(() => {});
  }
}

async function main() {
  const targets = bases();
  if (targets.length === 0) {
    console.error("Nessuna DATABASE_URL o DATABASE_URL_TEST trovata (.env o ambiente).");
    process.exitCode = 1;
    return;
  }

  console.log(`# Diagnostica pooler Prisma - ${new Date().toISOString()}`);
  console.log(`# node ${process.version} - ${process.platform} ${process.arch}`);
  console.log(`# tentativi per endpoint: ${ATTEMPTS}\n`);

  console.log("## DNS");
  const dnsResults = [];
  for (const hostname of HOSTS) {
    const result = await resolveHost(hostname);
    dnsResults.push(result);
    console.log(
      result.ok
        ? `  ${hostname} -> ${result.addresses.join(", ")} (${result.ms} ms)`
        : `  ${hostname} -> errore: ${result.error} (${result.ms} ms)`,
    );
  }

  console.log("\n## TCP e TLS");
  for (const hostname of HOSTS) {
    const tcp = await tcpProbe(hostname, 5432);
    const secure = await tlsProbe(hostname, 5432);
    console.log(
      `  ${hostname}: tcp ${tcp.ok ? `ok ${tcp.ms} ms` : `ko (${tcp.error})`}, ` +
        `tls ${secure.ok ? `ok ${secure.protocol} ${secure.ms} ms` : `ko (${secure.error})`}`,
    );
  }

  console.log("\n## Connessioni");
  const runs = [];
  for (const target of targets) {
    for (const hostname of HOSTS) {
      const url = withHost(target.raw, hostname);
      const attempts = [];
      for (let i = 0; i < ATTEMPTS; i += 1) {
        const attempt = await pgProbe(url);
        attempts.push(attempt);
        const label = attempt.ok
          ? `connesso in ${attempt.connectMs} ms, SELECT 1 in ${attempt.queryMs} ms`
          : `errore dopo ${attempt.connectMs} ms: ${attempt.error}`;
        console.log(`  [${target.key}] ${hostname} / ${target.database} #${i + 1}: ${label}`);
        if (i < ATTEMPTS - 1) await sleep(PAUSE_MS);
      }

      const succeeded = attempts.filter((a) => a.ok);
      const failures = [...new Set(attempts.filter((a) => !a.ok).map((a) => a.error))];
      runs.push({
        env: target.key,
        database: target.database,
        hostname,
        url: masked(url),
        ok: succeeded.length,
        total: attempts.length,
        medianConnectMs: median(succeeded.map((a) => a.connectMs)),
        medianQueryMs: median(succeeded.map((a) => a.queryMs)),
        errors: failures,
      });
    }
  }

  console.log("\n## Riepilogo");
  for (const run of runs) {
    const timing = run.ok
      ? `ok ${run.ok}/${run.total}, connessione mediana ${run.medianConnectMs} ms, query mediana ${run.medianQueryMs} ms`
      : `falliti ${run.total - run.ok}/${run.total}`;
    console.log(`  ${run.env} / ${run.database} / ${run.hostname}: ${timing}`);
    for (const error of run.errors) console.log(`    errore: ${error}`);
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    attemptsPerEndpoint: ATTEMPTS,
    dns: dnsResults,
    runs,
  };
  console.log("\n<!-- incolla da qui nel ticket -->");
  console.log("```json");
  console.log(JSON.stringify(payload, null, 2));
  console.log("```");

  // Nessun tentativo riuscito su un endpoint = guasto, non rumore di rete.
  const morti = runs.filter((run) => run.ok === 0);
  for (const run of morti) {
    console.error(
      `::error::${run.hostname} non ha accettato nessuna connessione su ${run.database} ` +
        `(${run.errors.join("; ") || "errore sconosciuto"})`,
    );
  }
  if (morti.length > 0) process.exitCode = 1;
}

await main();
