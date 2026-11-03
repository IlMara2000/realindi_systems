// REALINDI SYSTEMS — sito pubblico: dati da /api/site (path prenotazione + bio).
// Degradazione graziosa: senza risposta la pagina resta navigabile e le CTA
// di prenotazione vengono nascoste, i link bio mostrano uno stato vuoto.
(async function () {
  let data = null;
  try {
    const res = await fetch("/api/site");
    if (res.ok) data = await res.json();
  } catch (e) {
    data = null;
  }

  // CTA "Prenota un incontro": serve lo slug reale, altrimenti sparisce.
  const bookingCtas = document.querySelectorAll("[data-booking]");
  bookingCtas.forEach((cta) => {
    if (data && data.booking_path) cta.setAttribute("href", data.booking_path);
    else cta.hidden = true;
  });

  const mount = document.getElementById("bio-links");
  if (!mount) return;

  const tagline = document.getElementById("bio-tagline");
  const bio = data && data.bio ? data.bio : null;
  if (tagline && bio && bio.tagline) tagline.textContent = bio.tagline;

  const links = (bio && Array.isArray(bio.links) ? bio.links : [])
    .filter((l) => l && l.visible !== false)
    .sort((a, b) => (a.order || 0) - (b.order || 0));

  if (links.length === 0) {
    const empty = document.createElement("p");
    empty.className = "bio-empty";
    empty.textContent = "Nessun link pubblicato per ora.";
    mount.appendChild(empty);
    return;
  }

  function makeLink(link) {
    const a = document.createElement("a");
    a.className = "bio-link";
    a.href = link.url;
    a.textContent = link.label;
    a.rel = "me noopener noreferrer";
    return a;
  }

  const main = links.filter((l) => l.section === "main");
  const secondary = links.filter((l) => l.section !== "main");

  main.forEach((link) => mount.appendChild(makeLink(link)));

  if (secondary.length > 0) {
    const row = document.createElement("div");
    row.className = "bio-row";
    secondary.forEach((link) => row.appendChild(makeLink(link)));
    mount.appendChild(row);
  }

  const copyBtn = document.getElementById("bio-copy");
  const feedback = document.getElementById("bio-feedback");
  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(window.location.href);
        if (feedback) feedback.textContent = "Link copiato.";
      } catch (e) {
        if (feedback) feedback.textContent = "Copia manuale: " + window.location.href;
      }
      window.setTimeout(() => {
        if (feedback) feedback.textContent = "";
      }, 2500);
    });
  }
})();
