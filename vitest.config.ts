import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Un solo database di test (DATABASE_URL_TEST), migrato e svuotato qui:
    // nessun database nuovo per run, così l'account Prisma non li accumula.
    globalSetup: ["./tests/global-setup.ts"],
    // I test condividono il database: eseguire i file in serie, e una run alla
    // volta — due run sullo stesso database si troncherebbero le tabelle.
    fileParallelism: false,
    // Sopra HTTP_TIMEOUT_MS (30s in tests/helpers.ts): una richiesta bloccata
    // viene abortita e il test riporta l'errore vero; il runner non deve
    // troncare il test lasciando la richiesta ancora in volo sul server.
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
