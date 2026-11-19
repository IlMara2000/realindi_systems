-- Esiti di trasmissione al Sistema di Interscambio: canale usato, data di invio,
-- identificativo SdI e registro delle notifiche importate (RC, NS, MC, AT, DT).
ALTER TABLE "invoices" ADD COLUMN "sdi_status" TEXT NOT NULL DEFAULT 'none';
ALTER TABLE "invoices" ADD COLUMN "sdi_channel" TEXT;
ALTER TABLE "invoices" ADD COLUMN "sdi_sent_at" TEXT;
ALTER TABLE "invoices" ADD COLUMN "sdi_id" TEXT;
ALTER TABLE "invoices" ADD COLUMN "sdi_log" TEXT NOT NULL DEFAULT '[]';
