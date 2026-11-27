-- Passkey (WebAuthn): la credenziale privata resta sul dispositivo, qui c'è la
-- chiave pubblica con cui il server verifica la firma a ogni accesso.
CREATE TABLE "passkeys" (
    "id" TEXT NOT NULL,
    "public_key" BYTEA NOT NULL,
    "counter" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT NOT NULL DEFAULT '',
    "label" TEXT NOT NULL DEFAULT '',
    "created_at" BIGINT NOT NULL DEFAULT 0,
    "last_used" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "passkeys_pkey" PRIMARY KEY ("id")
);

-- Sfida WebAuthn in sospeso: monouso, legata al tipo (accesso o registrazione)
-- e con scadenza breve. Non può stare in memoria: su Vercel ogni richiesta può
-- essere servita da un'istanza diversa.
CREATE TABLE "passkey_challenges" (
    "id" TEXT NOT NULL,
    "challenge" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ip" TEXT NOT NULL DEFAULT '',
    "expires" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "passkey_challenges_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "passkey_challenges_expires_idx" ON "passkey_challenges"("expires");
