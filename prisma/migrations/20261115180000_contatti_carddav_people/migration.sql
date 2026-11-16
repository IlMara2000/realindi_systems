-- Contatti: rubrica locale, identità remote e stato per rubrica.
-- `contacts` è la persona (una sola anche se arriva da iCloud e da Google),
-- `contact_links` tiene l'identità su ciascun provider e `sync_addressbooks`
-- lo stato di sincronizzazione (ctag CardDAV, syncToken People API).

CREATE TABLE "contacts" (
    "id" SERIAL NOT NULL,
    "client_id" INTEGER,
    "display_name" TEXT NOT NULL DEFAULT '',
    "given_name" TEXT NOT NULL DEFAULT '',
    "family_name" TEXT NOT NULL DEFAULT '',
    "org" TEXT NOT NULL DEFAULT '',
    "job_title" TEXT NOT NULL DEFAULT '',
    "emails" TEXT NOT NULL DEFAULT '[]',
    "phones" TEXT NOT NULL DEFAULT '[]',
    "notes" TEXT NOT NULL DEFAULT '',
    "updated_at" BIGINT NOT NULL,
    "deleted_at" TEXT,
    "created_at" TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS'),
    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "contacts_deleted_at_idx" ON "contacts"("deleted_at");
CREATE INDEX "contacts_display_name_idx" ON "contacts"("display_name");
CREATE INDEX "contacts_client_id_idx" ON "contacts"("client_id");

CREATE TABLE "contact_links" (
    "id" SERIAL NOT NULL,
    "contact_id" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "addressbook" TEXT NOT NULL DEFAULT '',
    "remote_id" TEXT NOT NULL,
    "etag" TEXT,
    "deleted_at" TEXT,
    CONSTRAINT "contact_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "contact_links_source_remote_id_key" ON "contact_links"("source", "remote_id");
CREATE INDEX "contact_links_contact_id_idx" ON "contact_links"("contact_id");

CREATE TABLE "sync_addressbooks" (
    "provider" TEXT NOT NULL,
    "addressbook" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "ctag" TEXT,
    "sync_token" TEXT,
    "last_sync_at" TEXT,
    CONSTRAINT "sync_addressbooks_pkey" PRIMARY KEY ("provider", "addressbook")
);
