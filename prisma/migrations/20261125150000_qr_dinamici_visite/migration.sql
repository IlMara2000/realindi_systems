-- QR dinamici collegati a un link breve e visite uniche per giorno.

ALTER TABLE "short_links" ADD COLUMN "unique_visits" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "qr_codes" ADD COLUMN "link_id" INTEGER;

CREATE INDEX "qr_codes_link_id_idx" ON "qr_codes"("link_id");

ALTER TABLE "qr_codes" ADD CONSTRAINT "qr_codes_link_id_fkey"
    FOREIGN KEY ("link_id") REFERENCES "short_links"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Una riga per visita nuova: l'impronta contiene già il giorno, quindi la
-- stessa persona che torna domani viene contata di nuovo, ma i refresh di oggi
-- no. I record vengono eliminati dopo 35 giorni.
CREATE TABLE "link_visits" (
    "id" SERIAL NOT NULL,
    "link_id" INTEGER NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "at" BIGINT NOT NULL,

    CONSTRAINT "link_visits_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "link_visits_link_id_fingerprint_key" ON "link_visits"("link_id", "fingerprint");
CREATE INDEX "link_visits_link_id_at_idx" ON "link_visits"("link_id", "at");

ALTER TABLE "link_visits" ADD CONSTRAINT "link_visits_link_id_fkey"
    FOREIGN KEY ("link_id") REFERENCES "short_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;
