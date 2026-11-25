-- Invio delle fatture allo SdI tramite PEC: stato, data e ultimo esito.
-- not_sent | sent | delivered | rejected | failed | accepted | refused

ALTER TABLE "invoices" ADD COLUMN "sdi_state" TEXT NOT NULL DEFAULT 'not_sent';
ALTER TABLE "invoices" ADD COLUMN "sdi_sent_at" TEXT;
ALTER TABLE "invoices" ADD COLUMN "sdi_updated_at" TEXT;
ALTER TABLE "invoices" ADD COLUMN "sdi_message" TEXT NOT NULL DEFAULT '';
