"use strict";

/* Ricevute di cassa: numerazione progressiva per anno, importo in lettere e
   registro su Postgres. Il numero lo assegna il server (unico per anno, mai il
   browser): la pagina legge e scrive /api/ricevute con la sessione del CRM. */

(function () {
  const EMITTENTE_KEY = "realindi.ricevute.emittente";

  const UNITA = [
    "zero", "uno", "due", "tre", "quattro", "cinque", "sei", "sette", "otto", "nove",
    "dieci", "undici", "dodici", "tredici", "quattordici", "quindici", "sedici",
    "diciassette", "diciotto", "diciannove",
  ];
  const DECINE = ["", "", "venti", "trenta", "quaranta", "cinquanta", "sessanta", "settanta", "ottanta", "novanta"];

  function sotto100(n) {
    if (n < 20) return UNITA[n];
    const decina = DECINE[Math.floor(n / 10)];
    const unita = n % 10;
    if (unita === 0) return decina;
    // ventuno, ventotto: la vocale finale della decina cade
    if (unita === 1 || unita === 8) return decina.slice(0, -1) + UNITA[unita];
    return decina + UNITA[unita];
  }

  function sotto1000(n) {
    const centinaia = Math.floor(n / 100);
    const resto = n % 100;
    if (centinaia === 0) return sotto100(resto);
    let testo = centinaia === 1 ? "cento" : sotto100(centinaia) + "cento";
    if (resto === 0) return testo;
    const coda = sotto100(resto);
    // centotto, centottanta: cento perde la "o" davanti a "o"
    if (coda.charAt(0) === "o") testo = testo.slice(0, -1);
    return testo + coda;
  }

  function inLettere(n) {
    let valore = Math.floor(n);
    if (valore === 0) return "zero";
    let testo = "";

    const milioni = Math.floor(valore / 1000000);
    if (milioni > 0) {
      testo += (milioni === 1 ? "un milione" : inLettere(milioni) + " milioni") + " ";
      valore %= 1000000;
    }

    const migliaia = Math.floor(valore / 1000);
    if (migliaia > 0) {
      // mille e le migliaia si scrivono unite: milleduecentotrentaquattro
      testo += migliaia === 1 ? "mille" : sotto1000(migliaia) + "mila";
      valore %= 1000;
    }

    if (valore > 0) testo += sotto1000(valore);
    return testo.trim();
  }

  function importoInLettere(valore) {
    const interi = Math.floor(valore);
    const centesimi = Math.round((valore - interi) * 100);
    const base = "euro " + inLettere(interi);
    return centesimi > 0 ? base + " e " + inLettere(centesimi) + " centesimi" : base + "/00";
  }

  const euro = new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" });
  const dataIT = new Intl.DateTimeFormat("it-IT", { day: "2-digit", month: "2-digit", year: "numeric" });

  function esc(valore) {
    return String(valore == null ? "" : valore)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /* ---------- registro sul server ---------- */

  let archivio = { anni: {}, items: [] };
  let emittente = "";
  let occupato = false;

  try {
    emittente = window.localStorage.getItem(EMITTENTE_KEY) || "";
  } catch (errore) {
    emittente = "";
  }

  function ricordaEmittente(valore) {
    try {
      window.localStorage.setItem(EMITTENTE_KEY, valore);
    } catch (errore) {
      /* solo un promemoria: se il browser lo blocca si continua senza */
    }
  }

  async function chiamata(metodo, corpo) {
    const risposta = await fetch("/api/ricevute", {
      method: metodo,
      credentials: "same-origin",
      headers: corpo ? { "Content-Type": "application/json" } : undefined,
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    if (risposta.status === 401) {
      const problema = new Error("Sessione scaduta.");
      problema.sessione = true;
      throw problema;
    }
    const dati = await risposta.json().catch(function () {
      return {};
    });
    if (!risposta.ok) throw new Error(dati.error || "Operazione non riuscita.");
    return dati;
  }

  function daServer(riga) {
    return {
      id: riga.id,
      numero: "R-" + riga.year + "-" + String(riga.number).padStart(4, "0"),
      data: riga.issued_on,
      luogo: riga.place,
      versante: riga.payer,
      cf: riga.tax_code,
      importo: Number(riga.amount_cents) / 100,
      lettere: riga.amount_words,
      emittente: riga.issuer,
      causale: riga.reason,
    };
  }

  function mostraAvviso(testo) {
    avviso.textContent = testo || "";
    avviso.hidden = !testo;
  }

  async function caricaRegistro() {
    try {
      const dati = await chiamata("GET");
      archivio = {
        anni: dati.counters && typeof dati.counters === "object" ? dati.counters : {},
        items: Array.isArray(dati.receipts) ? dati.receipts.map(daServer) : [],
      };
      mostraAvviso("");
      disegnaRegistro();
      aggiornaProssimo();
    } catch (problema) {
      if (problema.sessione) {
        mostraAvviso("Accedi al gestionale per emettere e consultare le ricevute.");
        errore("Serve la sessione del gestionale: accedi e ricarica la pagina.");
      } else {
        mostraAvviso("Registro non raggiungibile: " + problema.message);
      }
    }
  }

  /* ---------- elementi ---------- */

  const form = document.getElementById("rc-form");
  const campoData = document.getElementById("rc-data");
  const campoLuogo = document.getElementById("rc-luogo");
  const campoVersante = document.getElementById("rc-versante");
  const campoCf = document.getElementById("rc-cf");
  const campoImporto = document.getElementById("rc-importo");
  const campoEmittente = document.getElementById("rc-emittente");
  const campoCausale = document.getElementById("rc-causale");
  const errorBox = document.getElementById("rc-error");
  const nextBox = document.getElementById("rc-next");
  const sheet = document.getElementById("rc-sheet");
  const registro = document.getElementById("rc-reg");
  const vuotoBox = document.getElementById("rc-empty");
  const avviso = document.getElementById("rc-notice");

  function oggi() {
    const adesso = new Date();
    const mese = String(adesso.getMonth() + 1).padStart(2, "0");
    const giorno = String(adesso.getDate()).padStart(2, "0");
    return adesso.getFullYear() + "-" + mese + "-" + giorno;
  }

  function annoDi(data) {
    const anno = Number(String(data).slice(0, 4));
    return Number.isFinite(anno) && anno > 1900 ? anno : new Date().getFullYear();
  }

  function numeroProssimo(anno) {
    const gia = Number(archivio.anni[anno] || 0);
    return "R-" + anno + "-" + String(gia + 1).padStart(4, "0");
  }

  function aggiornaProssimo() {
    nextBox.textContent = "Prossimo numero: " + numeroProssimo(annoDi(campoData.value));
  }

  function leggiForm() {
    return {
      numero: null,
      data: campoData.value,
      luogo: campoLuogo.value.trim(),
      versante: campoVersante.value.trim(),
      cf: campoCf.value.trim(),
      importo: Number(campoImporto.value || 0),
      emittente: campoEmittente.value.trim(),
      causale: campoCausale.value.trim(),
    };
  }

  function disegnaFoglio(ricevuta) {
    const importo = Number(ricevuta.importo || 0);
    const data = ricevuta.data ? dataIT.format(new Date(ricevuta.data + "T00:00:00")) : "";
    const numero = ricevuta.numero || "da assegnare";
    const riga = (valore) => (valore ? esc(valore) : "&nbsp;");

    sheet.innerHTML =
      '<div class="rc-sheet-head">' +
      '<div class="rc-sheet-title">Ricevuta di cassa</div>' +
      '<div class="rc-sheet-id">' + esc(numero) + "<small>" + esc(data) + "</small></div>" +
      "</div>" +
      '<div class="rc-meta">' +
      "<span>Luogo: <strong>" + (ricevuta.luogo ? esc(ricevuta.luogo) : "—") + "</strong></span>" +
      '<span>Modalità: <span class="rc-modo">Contanti</span></span>' +
      "</div>" +
      '<div class="rc-fieldline"><div class="k">Ricevuto da</div><div class="v">' +
      riga(ricevuta.versante) +
      "</div></div>" +
      '<div class="rc-fieldline"><div class="k">Codice fiscale / P. IVA</div><div class="v">' +
      riga(ricevuta.cf) +
      "</div></div>" +
      '<div class="rc-amount">' +
      '<span class="rc-cifre">' + euro.format(importo) + "</span>" +
      '<span class="rc-lettere">(' + (importo > 0 ? esc(ricevuta.lettere || importoInLettere(importo)) : "importo in lettere") + ")</span>" +
      "</div>" +
      '<div class="rc-fieldline"><div class="k">Causale</div><div class="v">' +
      riga(ricevuta.causale) +
      "</div></div>" +
      '<div class="rc-fieldline"><div class="k">A mezzo</div><div class="v">' +
      "Contanti, della cui ricezione si rilascia la presente quietanza.</div></div>" +
      '<div class="rc-signs">' +
      "<div>Firma del versante</div>" +
      "<div>Firma per ricevuta" + (ricevuta.emittente ? "<br>" + esc(ricevuta.emittente) : "") + "</div>" +
      "</div>" +
      '<div class="rc-foot">Quietanza di cassa — documento non fiscale</div>';
  }

  function disegnaRegistro() {
    registro.innerHTML = "";
    const ricevute = archivio.items.slice();
    vuotoBox.hidden = ricevute.length > 0;

    ricevute.forEach(function (ricevuta) {
      const riga = document.createElement("tr");

      const numero = document.createElement("td");
      numero.textContent = ricevuta.numero;

      const data = document.createElement("td");
      data.textContent = ricevuta.data ? dataIT.format(new Date(ricevuta.data + "T00:00:00")) : "";

      const versante = document.createElement("td");
      versante.textContent = ricevuta.versante || "—";

      const importo = document.createElement("td");
      importo.className = "r";
      importo.textContent = euro.format(Number(ricevuta.importo || 0));

      const azione = document.createElement("td");
      azione.className = "r";
      const bottone = document.createElement("button");
      bottone.type = "button";
      bottone.className = "rc-btn";
      bottone.textContent = "Stampa";
      bottone.addEventListener("click", function () {
        disegnaFoglio(ricevuta);
        window.print();
      });
      azione.appendChild(bottone);

      riga.appendChild(numero);
      riga.appendChild(data);
      riga.appendChild(versante);
      riga.appendChild(importo);
      riga.appendChild(azione);
      registro.appendChild(riga);
    });
  }

  function errore(messaggio) {
    errorBox.textContent = messaggio || "";
  }

  /* ---------- azioni ---------- */

  form.addEventListener("submit", async function (evento) {
    evento.preventDefault();
    errore("");
    if (occupato) return;

    const dati = leggiForm();

    if (!dati.data) return errore("Indica la data della ricevuta.");
    if (!dati.versante) return errore("Indica chi ha versato il contante.");
    if (!(dati.importo > 0)) return errore("L'importo deve essere maggiore di zero.");
    if (!dati.causale) return errore("Indica la causale della ricevuta.");

    occupato = true;
    const bottone = form.querySelector('button[type="submit"]');
    bottone.disabled = true;
    bottone.textContent = "Emissione…";

    try {
      const risposta = await chiamata("POST", {
        date: dati.data,
        place: dati.luogo,
        payer: dati.versante,
        tax_code: dati.cf,
        amount_cents: Math.round(dati.importo * 100),
        reason: dati.causale,
        issuer: dati.emittente,
      });
      const ricevuta = daServer(risposta.receipt);
      ricordaEmittente(dati.emittente);
      disegnaFoglio(ricevuta);
      // Il registro lo detta il server: ricarico invece di indovinare l'ordine
      // (una ricevuta retrodatata va al suo posto, non in cima).
      await caricaRegistro();

      campoVersante.value = "";
      campoCf.value = "";
      campoImporto.value = "";
      campoCausale.value = "";
      campoVersante.focus();

      window.print();
    } catch (problema) {
      if (problema.sessione) {
        mostraAvviso("Accedi al gestionale per emettere le ricevute.");
        errore("Sessione scaduta: accedi al gestionale e ricarica la pagina.");
      } else {
        errore(problema.message || "Non è stato possibile emettere la ricevuta.");
      }
    } finally {
      occupato = false;
      bottone.disabled = false;
      bottone.textContent = "Emetti e stampa";
    }
  });

  document.getElementById("rc-preview").addEventListener("click", function () {
    disegnaFoglio(leggiForm());
    aggiornaProssimo();
  });

  campoData.addEventListener("change", aggiornaProssimo);

  /* ---------- avvio ---------- */

  campoData.value = oggi();
  campoEmittente.value = emittente;
  aggiornaProssimo();
  disegnaFoglio(leggiForm());
  disegnaRegistro();
  caricaRegistro();
})();
