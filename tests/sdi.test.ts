// Invio allo SdI via PEC: interpretazione delle notifiche, stato sulla fattura,
// ritentabilità dopo un errore. Il trasporto è iniettato: nessun invio reale.
process.env.INTEGRATIONS_KEY ??= "test-integrations-key-per-lo-sdi-0123456789";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import {
  SDI_PEC,
  aggiornaEsiti,
  inviaFattura,
  invioAutomatico,
  leggiNotifica,
  salvaConfig,
  stato,
  type SdiTransport,
} from "../src/sdi.js";
import { resetDb, sql } from "./helpers.js";

const FILE = "IT01234567890_00001.xml";

function trasportoFinto(notifiche: { filename: string; xml: string }[] = [], errore?: string) {
  const inviate: any[] = [];
  const transport: SdiTransport = {
    async send(mail) {
      if (errore) throw new Error(errore);
      inviate.push(mail);
    },
    async notifications() {
      return notifiche;
    },
  };
  return { transport, inviate };
}

async function configuraPec(): Promise<void> {
  await salvaConfig({
    host: "smtps.pec.example.test",
    port: 465,
    secure: true,
    imap_host: "imaps.pec.example.test",
    imap_port: 993,
    user: "studio@pec.example.test",
    from: "studio@pec.example.test",
    password: "password-della-pec-non-deve-uscire",
  });
}

async function fatturaConXml(): Promise<number> {
  const [cliente] = await sql(
    "INSERT INTO clients (name, email, company, phone, vat_number, address, notes) VALUES ('Ada', 'ada@example.test', 'Studio', '', '', '', '') RETURNING id",
  );
  const [progetto] = await sql(
    "INSERT INTO projects (client_id, title, description, status, deadline) VALUES ($1, 'Sito', '', 'open', '2026-12-31') RETURNING id",
    [cliente.id],
  );
  const [fattura] = await sql(
    "INSERT INTO invoices (project_id, snapshot, subtotal, vat, total, status, due_date, number, xml, xml_filename) " +
      "VALUES ($1, '{}', 1000, 220, 1220, 'issued', '2026-12-31', '2026/00001', $2, $3) RETURNING id",
    [progetto.id, Buffer.from("<FatturaElettronica/>"), FILE],
  );
  return fattura.id as number;
}

async function statoFattura(id: number): Promise<any> {
  const [row] = await sql("SELECT sdi_state, sdi_sent_at, sdi_message FROM invoices WHERE id = $1", [id]);
  return row;
}

describe("notifiche SdI", () => {
  it("riconosce consegna, scarto, mancata consegna ed esito", () => {
    expect(leggiNotifica(`<RicevutaConsegna><NomeFile>${FILE}</NomeFile><DataOraConsegna>2026-11-25 10:00:00</DataOraConsegna></RicevutaConsegna>`)).toMatchObject({
      file: FILE,
      state: "delivered",
    });
    const scarto = leggiNotifica(
      `<NotificaScarto><NomeFile>${FILE}</NomeFile><ListaErrori><Errore><Descrizione>Codice destinatario inesistente</Descrizione></Errore></ListaErrori></NotificaScarto>`,
    );
    expect(scarto?.state).toBe("rejected");
    expect(scarto?.message).toContain("Codice destinatario inesistente");
    expect(leggiNotifica(`<NotificaMancataConsegna><NomeFile>${FILE}</NomeFile></NotificaMancataConsegna>`)?.state).toBe("failed");
    expect(leggiNotifica(`<NotificaEsito><NomeFile>${FILE}</NomeFile><Esito>EC01</Esito></NotificaEsito>`)?.state).toBe("accepted");
    expect(leggiNotifica(`<NotificaEsito><NomeFile>${FILE}</NomeFile><Esito>EC02</Esito></NotificaEsito>`)?.state).toBe("refused");
    expect(leggiNotifica(`<NotificaDecorrenzaTermini><NomeFile>${FILE}</NomeFile></NotificaDecorrenzaTermini>`)?.state).toBe("accepted");
  });

  it("usa il nome del file quando la notifica non lo ripete, e ignora il resto", () => {
    expect(leggiNotifica("<RicevutaConsegna/>", FILE)?.file).toBe(FILE);
    expect(leggiNotifica("<Altro><NomeFile>x.xml</NomeFile></Altro>")).toBeNull();
    // Senza NomeFile vale il nome dell'allegato: se non corrisponde a nessuna
    // fattura la notifica viene solo ignorata, senza effetti.
    expect(leggiNotifica("<RicevutaConsegna/>", "notifica.xml")?.file).toBe("notifica.xml");
  });
});

describe("invio allo SdI", () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await prisma().$disconnect();
  });

  it("collega la PEC, non restituisce la password e sa cosa manca", async () => {
    await configuraPec();
    const primo = await stato();
    expect(primo.configured).toBe(true);
    expect(JSON.stringify(primo)).not.toContain("password-della-pec-non-deve-uscire");
    expect(primo.missing.join(" ")).toContain("Partita IVA");

    await sql(
      "INSERT INTO settings (key, value) VALUES ('vat_number', '01234567890'), ('tax_regime', 'RF01')",
    );
    const completo = await stato();
    expect(completo.missing).toEqual([]);
  });

  it("spedisce l'XML immutabile alla PEC dello SdI e registra l'invio", async () => {
    await configuraPec();
    const id = await fatturaConXml();
    const { transport, inviate } = trasportoFinto();

    await inviaFattura(id, transport);

    expect(inviate).toHaveLength(1);
    expect(inviate[0].to).toBe(SDI_PEC);
    expect(inviate[0].from).toBe("studio@pec.example.test");
    expect(inviate[0].filename).toBe(FILE);
    expect(inviate[0].xml.toString("utf8")).toContain("FatturaElettronica");
    const dopo = await statoFattura(id);
    expect(dopo.sdi_state).toBe("sent");
    expect(dopo.sdi_sent_at).toBeTruthy();
    expect(dopo.sdi_message).toContain(SDI_PEC);
  });

  it("un errore di invio resta scritto sulla fattura e si può ritentare", async () => {
    await configuraPec();
    const id = await fatturaConXml();
    const { transport } = trasportoFinto([], "535 autenticazione rifiutata");

    await expect(inviaFattura(id, transport)).rejects.toThrow(/Invio allo SdI non riuscito/);
    const fallito = await statoFattura(id);
    expect(fallito.sdi_state).toBe("failed");
    expect(fallito.sdi_message).toContain("autenticazione rifiutata");
    expect(fallito.sdi_sent_at).toBeNull();

    const { transport: buono } = trasportoFinto();
    await inviaFattura(id, buono);
    expect((await statoFattura(id)).sdi_state).toBe("sent");
  });

  it("rifiuta l'invio senza XML e senza PEC", async () => {
    await configuraPec();
    const [cliente] = await sql(
      "INSERT INTO clients (name, email, company, phone, vat_number, address, notes) VALUES ('Ada', 'ada@example.test', 'Studio', '', '', '', '') RETURNING id",
    );
    const [progetto] = await sql(
      "INSERT INTO projects (client_id, title, description, status, deadline) VALUES ($1, 'Sito', '', 'open', '2026-12-31') RETURNING id",
      [cliente.id],
    );
    const [bozza] = await sql(
      "INSERT INTO invoices (project_id, snapshot, subtotal, vat, total, status, due_date) VALUES ($1, '{}', 1000, 220, 1220, 'draft', '2026-12-31') RETURNING id",
      [progetto.id],
    );
    const { transport } = trasportoFinto();
    await expect(inviaFattura(bozza.id, transport)).rejects.toThrow(/Genera prima l'XML/);

    await resetDb();
    const id = await fatturaConXml();
    await expect(inviaFattura(id, transport)).rejects.toThrow(/Configura la PEC/);
  });

  it("non invia da solo finché la PEC non è collegata", async () => {
    const id = await fatturaConXml();
    expect(await invioAutomatico(id)).toBe("not_configured");
    expect((await statoFattura(id)).sdi_state).toBe("not_sent");
  });

  it("aggiorna lo stato dalle ricevute e ignora le notifiche di altre fatture", async () => {
    await configuraPec();
    const id = await fatturaConXml();
    const { transport } = trasportoFinto([
      { filename: "RC_00001.xml", xml: `<RicevutaConsegna><NomeFile>${FILE}</NomeFile></RicevutaConsegna>` },
      { filename: "NS_99999.xml", xml: "<NotificaScarto><NomeFile>IT00000000000_99999.xml</NomeFile></NotificaScarto>" },
    ]);

    const esito = await aggiornaEsiti(transport);

    expect(esito).toEqual({ updated: 1, ignorate: 1, superate: 0 });
    const dopo = await statoFattura(id);
    expect(dopo.sdi_state).toBe("delivered");
    expect(dopo.sdi_message).toBe("Consegnata");
  });

  it("una notifica più vecchia non sovrascrive uno stato più recente", async () => {
    await configuraPec();
    const id = await fatturaConXml();
    const consegna = {
      filename: "RC_00001.xml",
      xml: `<RicevutaConsegna><NomeFile>${FILE}</NomeFile><DataOraConsegna>2026-11-25 10:00:00</DataOraConsegna></RicevutaConsegna>`,
    };
    const esitoCliente = {
      filename: "NE_00001.xml",
      xml: `<NotificaEsito><NomeFile>${FILE}</NomeFile><Esito>EC01</Esito><DataOra>2026-11-25 12:00:00</DataOra></NotificaEsito>`,
    };

    // La casella viene riletta intera: la vecchia ricevuta torna a ogni lettura
    // e arriva dopo l'esito del cliente.
    const prima = await aggiornaEsiti(trasportoFinto([esitoCliente, consegna]).transport);
    expect(prima).toEqual({ updated: 1, ignorate: 0, superate: 1 });
    expect((await statoFattura(id)).sdi_state).toBe("accepted");

    // Rileggere le stesse notifiche non cambia più nulla.
    const ripetuta = await aggiornaEsiti(trasportoFinto([consegna, esitoCliente]).transport);
    expect(ripetuta).toEqual({ updated: 0, ignorate: 0, superate: 2 });
    expect((await statoFattura(id)).sdi_state).toBe("accepted");

    // Una notifica davvero successiva passa.
    const rifiuto = {
      filename: "NE_00002.xml",
      xml: `<NotificaEsito><NomeFile>${FILE}</NomeFile><Esito>EC02</Esito><DataOra>2026-11-25 13:00:00</DataOra></NotificaEsito>`,
    };
    expect(await aggiornaEsiti(trasportoFinto([rifiuto]).transport)).toEqual({
      updated: 1,
      ignorate: 0,
      superate: 0,
    });
    expect((await statoFattura(id)).sdi_state).toBe("refused");
  });

  it("senza data nelle notifiche vale l'ordine degli stati", async () => {
    await configuraPec();
    const id = await fatturaConXml();

    await aggiornaEsiti(
      trasportoFinto([{ filename: "NE.xml", xml: `<NotificaEsito><NomeFile>${FILE}</NomeFile><Esito>EC01</Esito></NotificaEsito>` }])
        .transport,
    );
    expect((await statoFattura(id)).sdi_state).toBe("accepted");

    // Una ricevuta di consegna senza data non riporta indietro la fattura.
    const tardiva = await aggiornaEsiti(
      trasportoFinto([{ filename: "RC.xml", xml: `<RicevutaConsegna><NomeFile>${FILE}</NomeFile></RicevutaConsegna>` }])
        .transport,
    );
    expect(tardiva).toEqual({ updated: 0, ignorate: 0, superate: 1 });
    expect((await statoFattura(id)).sdi_state).toBe("accepted");
  });

  it("dopo un reinvio la vecchia notifica di scarto non riporta indietro la fattura", async () => {
    await configuraPec();
    const id = await fatturaConXml();
    const scarto = {
      filename: "NS_00001.xml",
      xml: `<NotificaScarto><NomeFile>${FILE}</NomeFile><DataOra>2026-11-20 09:00:00</DataOra></NotificaScarto>`,
    };
    await aggiornaEsiti(trasportoFinto([scarto]).transport);
    expect((await statoFattura(id)).sdi_state).toBe("rejected");

    // Corretta la fattura, si reinvia: parte da un istante più recente.
    await inviaFattura(id, trasportoFinto().transport);
    expect((await statoFattura(id)).sdi_state).toBe("sent");

    // Lo scarto resta in casella e viene riletto, ma è più vecchio del reinvio.
    const dopo = await aggiornaEsiti(trasportoFinto([scarto]).transport);
    expect(dopo).toEqual({ updated: 0, ignorate: 0, superate: 1 });
    expect((await statoFattura(id)).sdi_state).toBe("sent");
  });
});
