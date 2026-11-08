-- Annullamento logico delle ricevute: la riga resta, il numero resta occupato.
-- Scritta a mano per non trascinare gli ALTER COLUMN SET DEFAULT che
-- `prisma migrate diff` aggiunge solo per la normalizzazione dei default.

-- AlterTable
ALTER TABLE "receipts" ADD COLUMN "cancelled_at" TEXT,
ADD COLUMN "cancel_reason" TEXT;
