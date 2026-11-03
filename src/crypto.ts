// Crittografia dei segreti integrativi (Google refresh token, password Apple)
// conservati nella tabella settings. AES-256-GCM, formato v1:<iv>:<tag>:<ct>.
// La chiave viene da INTEGRATIONS_KEY: senza chiave le integrazioni restano
// disattivate invece di fallire a metà operazione.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";

function key(): Buffer {
  const raw = process.env.INTEGRATIONS_KEY;
  if (!raw) {
    throw new Error("INTEGRATIONS_KEY mancante: le integrazioni restano disattivate.");
  }
  return createHash("sha256").update(raw).digest();
}

export function sealSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

export function openSecret(sealed: string): string {
  const k = key();
  const [version, ivB64, tagB64, ctB64] = sealed.split(":");
  if (version !== "v1" || !ivB64 || !tagB64 || !ctB64) {
    throw new Error("Formato segreto non valido.");
  }
  const decipher = createDecipheriv(ALGO, k, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
