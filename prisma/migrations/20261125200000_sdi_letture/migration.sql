-- Ultima lettura delle ricevute SdI: una riga sola (id 1), riscritta a ogni
-- lettura. Il pannello Impostazioni → Invio allo SdI la mostra per far vedere
-- che il cron gira e quante notifiche ha applicato (o perché non ci è riuscito).
CREATE TABLE "sdi_sync" (
    "id" INTEGER NOT NULL,
    "last_at" TEXT NOT NULL,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "ignorate" INTEGER NOT NULL DEFAULT 0,
    "superate" INTEGER NOT NULL DEFAULT 0,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "error" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "sdi_sync_pkey" PRIMARY KEY ("id")
);
