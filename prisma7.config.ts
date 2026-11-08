// Prisma ORM 7 configuration (discovered by Prisma 7.10+ CLI).
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // DIRECT_URL, quando c'è, punta all'endpoint diretto: il pooler non
    // conserva lo stato di sessione che i comandi Migrate richiedono. Il
    // runtime dell'applicazione resta su DATABASE_URL, che è quella pooled.
    url: process.env["DIRECT_URL"]?.trim() || process.env["DATABASE_URL"],
  },
});
