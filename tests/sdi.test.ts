import { describe, expect, it } from "vitest";
import { nextStatus, parseNotification, SdiParseError } from "../src/sdi.js";

const ns = 'xmlns:types="http://www.fatturapa.gov.it/sdi/messaggi/v1.0"';

describe("notifiche SdI", () => {
  it("legge una ricevuta di consegna", () => {
    const n = parseNotification(`<?xml version="1.0"?><types:RicevutaConsegna ${ns} versione="1.0">
      <IdentificativoSdI>123456</IdentificativoSdI><NomeFile>IT01234567890_00001.xml</NomeFile>
      <DataOraRicezione>2026-11-19T10:00:00.000+01:00</DataOraRicezione>
      <DataOraConsegna>2026-11-19T10:00:05.000+01:00</DataOraConsegna></types:RicevutaConsegna>`);
    expect(n.type).toBe("RC");
    expect(n.sdi_id).toBe("123456");
    expect(n.invoice_filename).toBe("IT01234567890_00001.xml");
    expect(n.errors).toEqual([]);
  });

  it("legge uno scarto con gli errori", () => {
    const n = parseNotification(`<types:NotificaScarto ${ns}><IdentificativoSdI>9</IdentificativoSdI>
      <NomeFile>IT01234567890_00002.xml</NomeFile><ListaErrori>
      <Errore><Codice>00300</Codice><Descrizione>IdFiscaleIVA non valido</Descrizione></Errore>
      <Errore><Codice>00311</Codice><Descrizione>Codice destinatario non valido</Descrizione></Errore>
      </ListaErrori></types:NotificaScarto>`);
    expect(n.type).toBe("NS");
    expect(n.errors.map((e) => e.code)).toEqual(["00300", "00311"]);
  });

  it("rifiuta file che non sono notifiche", () => {
    expect(() => parseNotification("<FatturaElettronica/>")).toThrow(SdiParseError);
    expect(() => parseNotification("non xml")).toThrow(SdiParseError);
    expect(() => parseNotification('<!DOCTYPE x [<!ENTITY a "b">]><NotificaScarto/>')).toThrow(SdiParseError);
  });

  it("non scavalca una consegna o uno scarto con un messaggio diverso", () => {
    expect(nextStatus("sent", "RC")).toBe("delivered");
    expect(nextStatus("delivered", "MC")).toBe("delivered");
    expect(nextStatus("rejected", "RC")).toBe("rejected");
    expect(nextStatus("not_delivered", "RC")).toBe("delivered");
  });
});
