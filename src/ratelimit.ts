// Limite di frequenza dell'assistente. Lo stato vive su Postgres, così vale per
// tutte le istanze: su Vercel ogni processo ha memoria propria e un contatore in
// memoria lascerebbe passare N volte il limite con N istanze.
//
// Il numero di tentativi ammessi è per contatto e canale nella finestra mobile.
// Una richiesta respinta non viene registrata: altrimenti chi insiste
// allungherebbe da solo il proprio blocco.
import { prisma } from "./db.js";

export const REPLY_WINDOW_MS = 10 * 60_000;
export const MAX_REPLIES = 20;

export interface LimitOutcome {
  allowed: boolean;
  retryAfterMs: number;
}

export interface BlockedKey {
  key: string;
  retryAfterMs: number;
}

export interface LimitStore {
  record(key: string, at: number): Promise<LimitOutcome>;
  blocked(at: number): Promise<BlockedKey[]>;
}

export function createLimiter({
  store,
  now = Date.now,
}: {
  store: LimitStore;
  now?: () => number;
}) {
  return {
    check: (key: string): Promise<LimitOutcome> => store.record(key, now()),
    blocked: (): Promise<BlockedKey[]> => store.blocked(now()),
  };
}

/**
 * Conteggi su Postgres. Il lock consultivo sulla chiave serializza le istanze:
 * due richieste simultanee non possono occupare lo stesso ultimo posto.
 */
export function postgresStore(windowMs: number, max: number): LimitStore {
  let calls = 0;

  async function guard<T>(work: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await work();
    } catch (err) {
      // Il limite è una protezione, non una barriera: se la tabella non
      // risponde, meglio rispondere al cliente che rifiutare tutto.
      console.error("limite assistente non disponibile:", err);
      return fallback;
    }
  }

  return {
    record(key, at) {
      const cutoff = BigInt(at - windowMs);
      return guard(async () => {
        return prisma().$transaction(
          async (tx) => {
            // Stesso schema di receipts.ts: il cast a testo serve a Prisma, che
            // non sa leggere il void restituito da pg_advisory_xact_lock.
            await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`assistente:${key}`})::bigint)::text`;
            const recent = await tx.assistantHit.findMany({
              where: { key, at: { gt: cutoff } },
              orderBy: { at: "asc" },
              select: { at: true },
            });
            if (recent.length >= max) {
              const oldest = Number(recent[0]?.at ?? BigInt(at));
              return { allowed: false, retryAfterMs: Math.max(0, windowMs - (at - oldest)) };
            }
            await tx.assistantHit.create({ data: { key, at: BigInt(at) } });
            // Pulizia opportunistica: senza, la tabella cresce a ogni risposta.
            if (++calls % 50 === 0) {
              await tx.assistantHit.deleteMany({ where: { at: { lt: cutoff } } });
            }
            return { allowed: true, retryAfterMs: 0 };
          },
          { timeout: 15000 },
        );
      }, { allowed: true, retryAfterMs: 0 });
    },

    blocked(at) {
      const cutoff = BigInt(at - windowMs);
      return guard(async () => {
        // COUNT e MIN tornano come stringhe da node-postgres: si convertono qui.
        const rows = await prisma().$queryRaw<Array<{ key: string; first: string }>>`
          SELECT key, MIN(at) AS first
          FROM assistant_hits
          WHERE at > ${cutoff}
          GROUP BY key
          HAVING COUNT(*) >= ${max}
          ORDER BY MIN(at) ASC`;
        return rows.map((row) => ({
          key: row.key,
          retryAfterMs: Math.max(0, windowMs - (at - Number(row.first))),
        }));
      }, []);
    },
  };
}

/** Unico punto di accesso in produzione. */
export const replyLimit = createLimiter({
  store: postgresStore(REPLY_WINDOW_MS, MAX_REPLIES),
});
