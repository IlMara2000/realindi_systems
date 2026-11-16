-- Accessi riusciti (pannello Sicurezza): chi è entrato, quando, da quale IP e
-- con quale credenziale. `at` è in millisecondi UTC, come assistant_hits.
CREATE TABLE "login_events" (
    "id" SERIAL NOT NULL,
    "at" DOUBLE PRECISION NOT NULL,
    "ip" TEXT NOT NULL,
    "via" TEXT NOT NULL,
    CONSTRAINT "login_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "login_events_at_idx" ON "login_events"("at");
