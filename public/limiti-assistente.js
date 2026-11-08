// Avviso dei contatti che hanno esaurito le risposte automatiche.
//
// I nomi arrivano dai canali (Meta, Twilio) e non sono fidati: si scrivono solo
// con textContent, mai con innerHTML. Il conto alla rovescia è locale, così il
// pannello non interroga il server ogni secondo.
(function () {
  "use strict";

  const POLL_MS = 30_000;
  let corrente = null;

  function durata(secondi) {
    if (secondi <= 1) return "pochi secondi";
    const minuti = Math.floor(secondi / 60);
    const resto = secondi % 60;
    if (minuti === 0) return `${resto} secondi`;
    const coda = resto > 0 ? ` e ${resto} secondi` : "";
    return `circa ${minuti} ${minuti === 1 ? "minuto" : "minuti"}${coda}`;
  }

  function disegna(el, limits) {
    el.replaceChildren();
    el.hidden = limits.length === 0;
    if (!limits.length) return;

    const titolo = document.createElement("strong");
    titolo.textContent =
      limits.length === 1
        ? "Un contatto ha esaurito le risposte automatiche"
        : `${limits.length} contatti hanno esaurito le risposte automatiche`;
    el.appendChild(titolo);

    const lista = document.createElement("ul");
    for (const item of limits) {
      const li = document.createElement("li");
      const chi = item.contact || "contatto senza nome";
      li.textContent = `${chi} · ${item.channel} — riprova tra ${durata(item.retry_after_seconds)}`;
      lista.appendChild(li);
    }
    el.appendChild(lista);

    const nota = document.createElement("small");
    nota.textContent = "Le risposte riprendono da sole quando il tempo scade.";
    el.appendChild(nota);
  }

  window.mountLimitiAssistente = function (el) {
    // La vista viene ridisegnata a ogni cambio pagina: senza questa guardia si
    // accumulerebbero timer che scrivono in nodi staccati dal documento.
    if (corrente && corrente.el === el) return corrente.handle;
    if (corrente) corrente.stop();

    let limits = [];
    let vivo = true;

    async function aggiorna() {
      try {
        const res = await fetch("/api/assistant/limits", {
          headers: { Accept: "application/json" },
        });
        if (!res.ok || !vivo) return;
        const data = await res.json();
        if (!vivo) return;
        limits = Array.isArray(data.limits) ? data.limits : [];
        disegna(el, limits);
      } catch {
        /* rete assente: si riprova al prossimo giro */
      }
    }

    const tick = setInterval(() => {
      if (!limits.length) return;
      limits = limits
        .map((l) => ({ ...l, retry_after_seconds: l.retry_after_seconds - 1 }))
        .filter((l) => l.retry_after_seconds > 0);
      disegna(el, limits);
    }, 1000);

    const poll = setInterval(aggiorna, POLL_MS);
    aggiorna();

    const handle = {
      refresh: aggiorna,
      stop: () => {
        vivo = false;
        clearInterval(tick);
        clearInterval(poll);
      },
    };
    corrente = { el, handle, stop: handle.stop };
    return handle;
  };
})();
