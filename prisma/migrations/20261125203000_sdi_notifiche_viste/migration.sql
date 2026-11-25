-- Impronta delle notifiche SdI già viste: la casella viene riletta intera a
-- ogni lettura, quindi i conteggi «senza fattura» e «più vecchie di quelle
-- registrate» vanno limitati alle notifiche nuove di quel giro. Le righe più
-- vecchie della finestra di lettura si eliminano da sole (`vista_il`).
CREATE TABLE "sdi_notifiche" (
    "chiave" TEXT NOT NULL,
    "vista_il" TEXT NOT NULL,
    CONSTRAINT "sdi_notifiche_pkey" PRIMARY KEY ("chiave")
);

CREATE INDEX "sdi_notifiche_vista_il_idx" ON "sdi_notifiche"("vista_il");
