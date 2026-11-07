import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Ogni esecuzione gira su un database Postgres dedicato, creato qui.
    globalSetup: ["./tests/global-setup.ts"],
    // I test condividono il database: eseguire i file in serie.
    fileParallelism: false,
    // Sopra HTTP_TIMEOUT_MS (30s in tests/helpers.ts): una richiesta bloccata
    // viene abortita e il test riporta l'errore vero; il runner non deve
    // troncare il test lasciando la richiesta ancora in volo sul server.
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
