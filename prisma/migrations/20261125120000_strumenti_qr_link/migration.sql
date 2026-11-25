-- Strumenti: link brevi con conteggio dei clic e QR personalizzati.
CREATE TABLE "short_links" (
    "id" SERIAL NOT NULL,
    "slug" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS'),

    CONSTRAINT "short_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "short_links_slug_key" ON "short_links"("slug");
CREATE INDEX "short_links_created_at_idx" ON "short_links"("created_at");

CREATE TABLE "qr_codes" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "foreground" TEXT NOT NULL DEFAULT '#111111',
    "background" TEXT NOT NULL DEFAULT '#ffffff',
    "ecc" TEXT NOT NULL DEFAULT 'H',
    "logo_mime" TEXT,
    "logo" BYTEA,
    "created_at" TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS'),

    CONSTRAINT "qr_codes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "qr_codes_created_at_idx" ON "qr_codes"("created_at");
