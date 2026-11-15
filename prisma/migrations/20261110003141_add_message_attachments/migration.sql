-- AlterTable
ALTER TABLE "appointments" ALTER COLUMN "created_at" SET DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS');

-- AlterTable
ALTER TABLE "channels" ALTER COLUMN "created_at" SET DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS'),
ALTER COLUMN "updated_at" SET DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS');

-- AlterTable
ALTER TABLE "clients" ALTER COLUMN "created_at" SET DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS');

-- AlterTable
ALTER TABLE "conversations" ALTER COLUMN "created_at" SET DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS');

-- AlterTable
ALTER TABLE "documents" ALTER COLUMN "created_at" SET DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS');

-- AlterTable
ALTER TABLE "invoices" ALTER COLUMN "created_at" SET DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS');

-- AlterTable
ALTER TABLE "knowledge_docs" ALTER COLUMN "updated_at" SET DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS');

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "media_storage_name" TEXT,
ADD COLUMN     "media_type" TEXT,
ADD COLUMN     "media_url" TEXT,
ALTER COLUMN "created_at" SET DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS');

-- AlterTable
ALTER TABLE "notes" ALTER COLUMN "created_at" SET DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS'),
ALTER COLUMN "updated_at" SET DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS');

-- AlterTable
ALTER TABLE "projects" ALTER COLUMN "created_at" SET DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS');

-- AlterTable
ALTER TABLE "quotes" ALTER COLUMN "created_at" SET DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS');

-- AlterTable
ALTER TABLE "receipts" ALTER COLUMN "created_at" SET DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS');

-- CreateTable
CREATE TABLE "message_attachments" (
    "id" SERIAL NOT NULL,
    "message_id" INTEGER NOT NULL,
    "conversation_id" INTEGER NOT NULL,
    "filename" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storage_name" TEXT NOT NULL,
    "content" BYTEA NOT NULL,
    "created_at" TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS'),

    CONSTRAINT "message_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "message_attachments_storage_name_key" ON "message_attachments"("storage_name");

-- CreateIndex
CREATE INDEX "message_attachments_conversation_id_idx" ON "message_attachments"("conversation_id");

-- AddForeignKey
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
