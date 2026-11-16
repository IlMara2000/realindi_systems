-- Canali di notifica Google Calendar (events.watch).
-- Ogni calendario ha il suo canale: Google chiama l'URL con un POST vuoto e gli
-- header X-Goog-* identificano canale e risorsa. I canali scadono e vengono
-- rinnovati prima della scadenza, quindi l'expiration è indicizzata.

CREATE TABLE "sync_channels" (
    "channel_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "calendar_id" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL DEFAULT '',
    "address" TEXT NOT NULL,
    "token" TEXT NOT NULL DEFAULT '',
    "expiration" BIGINT NOT NULL,
    "created_at" TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS'),
    CONSTRAINT "sync_channels_pkey" PRIMARY KEY ("channel_id")
);

CREATE INDEX "sync_channels_provider_calendar_id_idx" ON "sync_channels"("provider", "calendar_id");
CREATE INDEX "sync_channels_expiration_idx" ON "sync_channels"("expiration");
