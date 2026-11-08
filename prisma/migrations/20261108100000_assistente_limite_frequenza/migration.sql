-- Tabella dei tentativi dell'assistente: i conteggi del limite di frequenza
-- vivono qui e non in memoria, così valgono per tutte le istanze.
--
-- Scritta a mano: `prisma migrate diff` aggiunge dodici ALTER COLUMN SET
-- DEFAULT su tabelle esistenti solo perché Postgres riscrive quei default con
-- un cast ::text. Sono differenze testuali, non strutturali (vedi
-- scripts/check-migrations.ts), e non vanno in una migrazione.

-- CreateTable
CREATE TABLE "assistant_hits" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "at" BIGINT NOT NULL,

    CONSTRAINT "assistant_hits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assistant_hits_key_at_idx" ON "assistant_hits"("key", "at");

-- CreateIndex
CREATE INDEX "assistant_hits_at_idx" ON "assistant_hits"("at");
