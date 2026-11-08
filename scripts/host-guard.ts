// Guardia sugli host usati dagli script che creano e distruggono database.
//
// Su un Postgres locale creare e cancellare database è gratis e innocuo; su
// un'istanza gestita è un'operazione invasiva, che non deve partire per sbaglio
// da un `.env` puntato al cloud. La decisione è una funzione pura, così è
// verificabile senza database: lo script si limita a tradurre l'esito in uscita.

const HOST_LOCALI = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

export function hostDi(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Deliberatamente senza la URL: contiene la password.
    throw new Error("La stringa di connessione non è una URL valida.");
  }
  // `new URL("postgres:segreta")` non lancia: la legge come schema più
  // percorso, e hostname resta vuoto. Senza questo controllo la guardia
  // deciderebbe su un host inesistente.
  if (parsed.hostname === "") {
    throw new Error("La stringa di connessione non è una URL valida: manca l'host.");
  }
  return parsed.hostname;
}

export type EsitoGuardia =
  | { consentito: true; avviso?: string }
  | { consentito: false; hostname: string; messaggio: string };

export function verificaHost(
  url: string | undefined,
  opzioni: { consenso: boolean; ruolo: string },
): EsitoGuardia {
  if (!url) return { consentito: true }; // l'assenza della variabile è gestita dal chiamante

  const hostname = hostDi(url);
  if (HOST_LOCALI.has(hostname)) return { consentito: true };

  if (opzioni.consenso) {
    return {
      consentito: true,
      avviso: `Host remoto consentito per ${opzioni.ruolo}: ${hostname}`,
    };
  }

  return {
    consentito: false,
    hostname,
    messaggio: [
      "Il controllo delle migrazioni crea e distrugge database temporanei,",
      `e ${opzioni.ruolo} punta a un host remoto (${hostname}).`,
      "",
      "Su un'istanza gestita è un comportamento invasivo: la verifica va eseguita",
      "su un Postgres locale, con lo stesso motore della CI.",
      "",
      "Per procedere comunque:  npm run db:check -- --consenti-remoto",
    ].join("\n"),
  };
}
