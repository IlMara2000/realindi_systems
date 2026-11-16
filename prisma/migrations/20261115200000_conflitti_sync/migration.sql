-- Conflitti di sincronizzazione: quando locale e remoto sono cambiati entrambi
-- e l'ordine non è affidabile, si registrano le due versioni integrali e si
-- smette di ritentare, invece di sovrascrivere in silenzio.

CREATE TABLE "sync_conflicts" (
    "id" SERIAL NOT NULL,
    "link_id" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "entity_kind" TEXT NOT NULL DEFAULT 'event',
    "entity_id" INTEGER NOT NULL,
    "local_json" TEXT NOT NULL,
    "remote_json" TEXT NOT NULL,
    "detected_at" TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS'),
    "resolution" TEXT NOT NULL DEFAULT 'pending',
    "resolved_at" TEXT,
    "resolved_by" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "sync_conflicts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "sync_conflicts_resolution_detected_at_idx" ON "sync_conflicts"("resolution", "detected_at");
CREATE INDEX "sync_conflicts_link_id_idx" ON "sync_conflicts"("link_id");
