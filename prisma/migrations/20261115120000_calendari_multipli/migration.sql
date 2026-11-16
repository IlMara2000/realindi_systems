-- Calendari multipli.
-- Google emette un syncToken per calendario, non per account: lo stato passa da
-- sync_state.token (uno per provider) a sync_calendars (uno per calendario).
-- Gli id evento di Google sono univoci solo dentro un calendario, quindi
-- calendar_id entra nell'identità del legame remoto.

CREATE TABLE "sync_calendars" (
    "provider" TEXT NOT NULL,
    "calendar_id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "access_role" TEXT NOT NULL DEFAULT '',
    "primary" BOOLEAN NOT NULL DEFAULT false,
    "token" TEXT,
    "last_sync_at" TEXT,
    CONSTRAINT "sync_calendars_pkey" PRIMARY KEY ("provider","calendar_id")
);

-- Ripresa senza perdere l'avanzamento: il token già salvato era di "primary",
-- il solo calendario sincronizzato fino a questa migrazione.
INSERT INTO "sync_calendars" ("provider", "calendar_id", "name", "access_role", "primary", "token", "last_sync_at")
SELECT 'google', 'primary', 'Calendario principale', 'owner', true, "token", "last_sync_at"
FROM "sync_state"
WHERE "provider" = 'google'
ON CONFLICT ("provider", "calendar_id") DO NOTHING;

ALTER TABLE "event_links" ADD COLUMN "calendar_id" TEXT NOT NULL DEFAULT 'primary';

DROP INDEX IF EXISTS "event_links_source_external_id_key";
CREATE UNIQUE INDEX "event_links_source_calendar_id_external_id_key" ON "event_links"("source", "calendar_id", "external_id");
