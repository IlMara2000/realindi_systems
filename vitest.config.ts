import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Ogni esecuzione gira su un database Postgres dedicato, creato qui.
    globalSetup: ["./tests/global-setup.ts"],
    // I test condividono il database: eseguire i file in serie.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
