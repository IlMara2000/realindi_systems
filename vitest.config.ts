import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // I test condividono il database: eseguire i file in serie.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
