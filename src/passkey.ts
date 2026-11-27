// Passkey (WebAuthn): accesso con Face ID, impronta o PIN del dispositivo.
// Il segreto resta sul dispositivo; qui c'è solo la chiave pubblica con cui si
// verifica la firma. La password e i codici di emergenza restano la via di
// riserva: una passkey persa non deve chiudere il titolare fuori dal workspace.
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { prisma } from "./db.js";
import { Invalid, tokenUrlSafe } from "./util.js";

/** Sfida valida per cinque minuti: il tempo di un Face ID, non di un attacco. */
const DURATA_SFIDA_SECONDI = 300;

/** Oltre questo numero la lista diventa un elenco di dispositivi dimenticati. */
export const MAX_PASSKEY = 10;

const NOME_RP = "REALINDI Workspace";

/**
 * La passkey è legata al dominio su cui viene creata: se cambia, va registrata
 * di nuovo. L'indirizzo arriva da APP_ORIGIN, non dall'header Host, che chi
 * chiama può scrivere. Senza variabile: il dominio di produzione su Vercel e
 * localhost in sviluppo (WebAuthn richiede HTTPS o localhost).
 */
export function origine(): { origin: string; rpID: string } {
  const configurato = (process.env.APP_ORIGIN ?? "").trim();
  const raw =
    configurato ||
    (process.env.VERCEL === "1" ? "https://realindi.vercel.app" : "http://localhost:8080");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("APP_ORIGIN non è un indirizzo valido.");
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("APP_ORIGIN deve essere un indirizzo HTTPS.");
  }
  return { origin: url.origin, rpID: url.hostname };
}

function transporti(valore: string | null): string[] | undefined {
  return valore ? valore.split(",").filter(Boolean) : undefined;
}

/**
 * Salva la sfida e scarta quelle scadute e quella precedente dello stesso IP:
 * un utente che riprova non lascia righe dietro di sé.
 */
async function salvaSfida(kind: string, ip: string, challenge: string): Promise<string> {
  const p = prisma();
  const now = Date.now() / 1000;
  const id = tokenUrlSafe(16);
  await p.passkeyChallenge.deleteMany({
    where: { OR: [{ expires: { lt: now } }, { ip }] },
  });
  await p.passkeyChallenge.create({
    data: { id, challenge, kind, ip, expires: now + DURATA_SFIDA_SECONDI },
  });
  return id;
}

/**
 * Consuma la sfida: la riga sparisce prima della verifica, quindi la stessa
 * risposta non può essere riprodotta due volte. Un id inventato, scaduto o di
 * un altro tipo non passa.
 */
async function consumaSfida(id: string, kind: string): Promise<string> {
  const p = prisma();
  const now = Date.now() / 1000;
  const riga = await p.passkeyChallenge.findUnique({ where: { id } });
  if (!riga || riga.kind !== kind || riga.expires <= now) {
    throw new Invalid("Richiesta scaduta: riprova.");
  }
  const rimosse = await p.passkeyChallenge.deleteMany({ where: { id } });
  if (rimosse.count !== 1) throw new Invalid("Richiesta scaduta: riprova.");
  return riga.challenge;
}

/** Passkey registrate, senza chiave pubblica né contatori. */
export interface PasskeyPubblica {
  id: string;
  label: string;
  created_at: number;
  last_used: number;
}

export async function elencoPasskey(): Promise<PasskeyPubblica[]> {
  // La tabella nasce con la migrazione: finché non è applicata l'elenco resta
  // vuoto invece di far fallire /api/state, che carica tutto il workspace.
  const righe = await prisma()
    .passkey.findMany({ orderBy: { created_at: "asc" } })
    .catch(() => []);
  return righe.map((riga) => ({
    id: riga.id,
    label: riga.label,
    created_at: Number(riga.created_at),
    last_used: Number(riga.last_used),
  }));
}

export async function passkeyDisponibili(): Promise<boolean> {
  // Stessa ragione: /api/session deve rispondere anche prima della migrazione,
  // altrimenti la pagina di accesso smetterebbe di caricarsi.
  const quante = await prisma().passkey.count().catch(() => 0);
  return quante > 0;
}

/** Opzioni per registrare una nuova passkey da un dispositivo già autenticato. */
export async function opzioniRegistrazione(ip: string): Promise<Record<string, unknown>> {
  const p = prisma();
  const esistenti = await p.passkey.findMany({ select: { id: true, transports: true } });
  if (esistenti.length >= MAX_PASSKEY) {
    throw new Invalid(`Hai già ${MAX_PASSKEY} passkey: rimuovine una per aggiungerne un'altra.`);
  }
  const { rpID } = origine();
  const options = await generateRegistrationOptions({
    rpName: NOME_RP,
    rpID,
    // Un solo titolare: l'identificatore resta stabile nel tempo.
    userID: new TextEncoder().encode("realindi-owner"),
    userName: "realindi",
    userDisplayName: "REALINDI Workspace",
    attestationType: "none",
    excludeCredentials: esistenti.map((riga) => ({
      id: riga.id,
      transports: transporti(riga.transports),
    })),
    // Una passkey che non verifica l'utente (PIN o biometria) sarebbe solo una
    // chiave fisica: qui la verifica è obbligatoria.
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
  });
  const sfida = await salvaSfida("registrazione", ip, options.challenge);
  return { sfida, options };
}

/** Verifica l'attestazione e salva la chiave pubblica della nuova passkey. */
export async function registraPasskey(
  sfida: string,
  risposta: unknown,
  label: string,
): Promise<void> {
  const challenge = await consumaSfida(sfida, "registrazione");
  const { origin, rpID } = origine();
  let credenziale: { id: string; publicKey: Uint8Array<ArrayBuffer>; counter: number; transports?: string[] };
  try {
    const esito = await verifyRegistrationResponse({
      response: risposta as Parameters<typeof verifyRegistrationResponse>[0]["response"],
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
    if (!esito.verified) throw new Error("registrazione non verificata");
    credenziale = esito.registrationInfo.credential;
  } catch (err) {
    if (err instanceof Invalid) throw err;
    console.error("Passkey non registrata:", (err as Error)?.message);
    throw new Invalid("Passkey non verificata: riprova o usa la password.");
  }

  try {
    await prisma().passkey.create({
      data: {
        id: credenziale.id,
        public_key: Buffer.from(credenziale.publicKey),
        counter: BigInt(credenziale.counter ?? 0),
        transports: (credenziale.transports ?? []).join(","),
        label: label.slice(0, 80),
        created_at: BigInt(Date.now()),
        last_used: BigInt(0),
      },
    });
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") {
      throw new Invalid("Questa passkey è già registrata.");
    }
    throw err;
  }
}

/** Opzioni per entrare con una passkey già registrata. */
export async function opzioniAccesso(ip: string): Promise<Record<string, unknown>> {
  const esistenti = await prisma().passkey.findMany({ select: { id: true, transports: true } });
  if (!esistenti.length) throw new Invalid("Nessuna passkey registrata: entra con la password.");
  const { rpID } = origine();
  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials: esistenti.map((riga) => ({
      id: riga.id,
      transports: transporti(riga.transports),
    })),
    userVerification: "required",
  });
  const sfida = await salvaSfida("accesso", ip, options.challenge);
  return { sfida, options };
}

/**
 * Verifica la firma della passkey e aggiorna il contatore. Il confronto del
 * contatore è dentro la libreria: un autenticatore clonato che riporta un
 * valore vecchio viene rifiutato.
 */
export async function verificaAccesso(sfida: string, risposta: unknown): Promise<void> {
  const challenge = await consumaSfida(sfida, "accesso");
  const response = risposta as Parameters<typeof verifyAuthenticationResponse>[0]["response"];
  const id = String((response as { id?: unknown })?.id ?? "");
  if (!id) throw new Invalid("Passkey non riconosciuta.");
  const riga = await prisma().passkey.findUnique({ where: { id } });
  if (!riga) throw new Invalid("Passkey non riconosciuta.");

  const { origin, rpID } = origine();
  try {
    const esito = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: riga.id,
        publicKey: new Uint8Array(riga.public_key),
        counter: Number(riga.counter),
        transports: transporti(riga.transports),
      },
      requireUserVerification: true,
    });
    if (!esito.verified) throw new Error("firma non verificata");
    await prisma().passkey.update({
      where: { id: riga.id },
      data: {
        counter: BigInt(esito.authenticationInfo.newCounter),
        last_used: BigInt(Date.now()),
      },
    });
  } catch (err) {
    if (err instanceof Invalid) throw err;
    console.error("Passkey non verificata:", (err as Error)?.message);
    throw new Invalid("Passkey non verificata: riprova o entra con la password.");
  }
}

/** Rimuove una passkey: il dispositivo non entra più, gli altri restano validi. */
export async function rimuoviPasskey(id: string): Promise<boolean> {
  const rimosse = await prisma().passkey.deleteMany({ where: { id } });
  return rimosse.count === 1;
}
