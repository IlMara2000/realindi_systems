-- Contesto delle sessioni: IP e browser di origine, creazione e ultimo uso.
-- I default vuoti coprono le sessioni già aperte al momento della migrazione.
ALTER TABLE "sessions" ADD COLUMN "ip" TEXT NOT NULL DEFAULT '';
ALTER TABLE "sessions" ADD COLUMN "user_agent" TEXT NOT NULL DEFAULT '';
ALTER TABLE "sessions" ADD COLUMN "created_at" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "sessions" ADD COLUMN "last_seen" DOUBLE PRECISION NOT NULL DEFAULT 0;
