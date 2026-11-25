-- Istante dell'evento che ha prodotto lo stato SdI della fattura: la data della
-- notifica oppure l'istante dell'invio. Una notifica più vecchia non deve
-- sovrascrivere uno stato più recente.
ALTER TABLE "invoices" ADD COLUMN "sdi_event_at" TEXT;
