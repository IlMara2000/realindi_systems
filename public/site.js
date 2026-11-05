// REALINDI SYSTEMS — menu laterale mobile (hamburger in testata + linguetta
// sul bordo destro). Il pannello esiste solo sotto gli 820px: da lì in su il
// click non lo aprirebbe, quindi lo stato viene azzerato al cambio di misura.
(function initMobileMenu() {
  const drawer = document.getElementById("site-menu");
  if (!drawer) return;

  const openers = Array.from(document.querySelectorAll(".nav-toggle, .drawer-tab"));
  const closers = Array.from(document.querySelectorAll(".drawer-close, .drawer-scrim"));
  const firstLink = drawer.querySelector(".drawer-nav a");
  let lastFocus = null;

  function isOpen() {
    return drawer.classList.contains("is-open");
  }

  function setOpen(open) {
    drawer.classList.toggle("is-open", open);
    document.body.classList.toggle("drawer-open", open);
    openers.forEach((el) => el.setAttribute("aria-expanded", open ? "true" : "false"));
    if (open) {
      lastFocus = document.activeElement;
      if (firstLink) firstLink.focus({ preventScroll: true });
    } else if (lastFocus && typeof lastFocus.focus === "function") {
      lastFocus.focus({ preventScroll: true });
    }
  }

  openers.forEach((el) => el.addEventListener("click", () => setOpen(!isOpen())));
  closers.forEach((el) => el.addEventListener("click", () => setOpen(false)));
  drawer.querySelectorAll("a").forEach((a) =>
    a.addEventListener("click", () => setOpen(false))
  );

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen()) setOpen(false);
  });

  const desktop = window.matchMedia("(min-width: 821px)");
  desktop.addEventListener("change", (e) => {
    if (e.matches && isOpen()) setOpen(false);
  });
})();

// Dati da /api/site (path prenotazione + bio).
// Degradazione graziosa: senza risposta la pagina resta navigabile e le CTA
// di prenotazione vengono nascoste, i link bio mostrano uno stato vuoto.
// Se la sessione del gestionale è aperta la pagina diventa anche l'editor:
// si modifica qui e si salva su POST /api/site, senza passare dalle impostazioni.
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
  const copyBtn = document.getElementById("bio-copy");
  const feedback = document.getElementById("bio-feedback");
  const editBtn = document.getElementById("bio-edit");
  const editor = document.getElementById("bio-editor");
  const tagInput = document.getElementById("bio-tagline-input");
  const editorLinks = document.getElementById("bio-editor-links");
  const errorEl = document.getElementById("bio-editor-error");
  const addBtn = document.getElementById("bio-add");
  const cancelBtn = document.getElementById("bio-cancel");
  const SECTIONS = [
    ["main", "Principale"],
    ["socials", "Social"],
    ["contacts", "Contatti"],
  ];

  let current = normalize(data && data.bio);
  let canEdit = false;

  function normalize(bio) {
    const raw = bio && Array.isArray(bio.links) ? bio.links : [];
    const links = raw
      .map((l, i) => ({
        label: typeof l.label === "string" ? l.label : "",
        url: typeof l.url === "string" ? l.url : "",
        section: SECTIONS.some(([value]) => value === l.section) ? l.section : "main",
        visible: l.visible !== false,
        order: Number.isInteger(l.order) ? l.order : i,
      }))
      .sort((a, b) => a.order - b.order)
      .map((l, i) => ({ ...l, order: i }));
    return {
      tagline: bio && typeof bio.tagline === "string" ? bio.tagline : "",
      links,
    };
  }

  function makeLink(link) {
    const a = document.createElement("a");
    a.className = "bio-link";
    a.href = link.url;
    a.textContent = link.label;
    a.rel = "me noopener noreferrer";
    return a;
  }

  function renderBio() {
    mount.textContent = "";
    if (tagline) {
      tagline.textContent = current.tagline;
      tagline.hidden = false;
    }

    const visible = current.links
      .filter((l) => l && l.visible !== false)
      .sort((a, b) => a.order - b.order);

    if (visible.length === 0) {
      const empty = document.createElement("p");
      empty.className = "bio-empty";
      empty.textContent = "Nessun link pubblicato per ora.";
      mount.appendChild(empty);
      return;
    }

    const main = visible.filter((l) => l.section === "main");
    const secondary = visible.filter((l) => l.section !== "main");

    main.forEach((link) => mount.appendChild(makeLink(link)));

    if (secondary.length > 0) {
      const row = document.createElement("div");
      row.className = "bio-row";
      secondary.forEach((link) => row.appendChild(makeLink(link)));
      mount.appendChild(row);
    }
  }

  // ---------------------------------------------------------------- editor
  function editorRow(link) {
    const row = document.createElement("div");
    row.className = "bio-edit-row";

    const label = document.createElement("input");
    label.type = "text";
    label.value = link.label;
    label.maxLength = 80;
    label.placeholder = "Titolo";
    label.setAttribute("aria-label", "Titolo del link");
    label.className = "bio-edit-label";

    const url = document.createElement("input");
    url.type = "url";
    url.value = link.url;
    url.maxLength = 500;
    url.placeholder = "https://…";
    url.setAttribute("aria-label", "Indirizzo del link");
    url.className = "bio-edit-url";

    const section = document.createElement("select");
    section.setAttribute("aria-label", "Sezione del link");
    section.className = "bio-edit-section";
    SECTIONS.forEach(([value, text]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      if (link.section === value) option.selected = true;
      section.appendChild(option);
    });

    const visibility = document.createElement("label");
    visibility.className = "bio-edit-vis";
    const visible = document.createElement("input");
    visible.type = "checkbox";
    visible.checked = link.visible !== false;
    visibility.appendChild(visible);
    visibility.appendChild(document.createTextNode("visibile"));

    const tools = document.createElement("div");
    tools.className = "bio-edit-tools";
    const tool = (text, labelText, onClick) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "bio-tool";
      button.textContent = text;
      button.setAttribute("aria-label", labelText);
      button.addEventListener("click", onClick);
      tools.appendChild(button);
    };
    tool("↑", "Sposta in alto", () => {
      const previous = row.previousElementSibling;
      if (previous) row.parentNode.insertBefore(row, previous);
    });
    tool("↓", "Sposta in basso", () => {
      const next = row.nextElementSibling;
      if (next) row.parentNode.insertBefore(next, row);
    });
    tool("×", "Rimuovi link", () => row.remove());

    row.append(label, url, section, visibility, tools);
    row.fields = { label, url, section, visible };
    return row;
  }

  function collect() {
    const links = Array.from(editorLinks.querySelectorAll(".bio-edit-row")).map((row, i) => ({
      label: row.fields.label.value.trim(),
      url: row.fields.url.value.trim(),
      section: row.fields.section.value,
      visible: row.fields.visible.checked,
      order: i,
    }));
    return { tagline: tagInput.value.trim(), links };
  }

  function setEditing(on) {
    if (!canEdit || !editor) return;
    editor.hidden = !on;
    mount.hidden = on;
    if (tagline) tagline.hidden = on;
    if (errorEl) errorEl.textContent = "";
    if (editBtn) editBtn.textContent = on ? "Chiudi" : "Modifica";
    if (!on) return;
    tagInput.value = current.tagline;
    editorLinks.textContent = "";
    current.links.forEach((link) => editorLinks.appendChild(editorRow(link)));
    tagInput.focus({ preventScroll: true });
  }

  renderBio();

  if (editor && editBtn) {
    editBtn.addEventListener("click", () => setEditing(editor.hidden));

    if (addBtn)
      addBtn.addEventListener("click", () => {
        editorLinks.appendChild(
          editorRow({ label: "", url: "", section: "main", visible: true })
        );
        const rows = editorLinks.querySelectorAll(".bio-edit-row");
        const last = rows[rows.length - 1];
        if (last) last.querySelector("input").focus();
      });

    if (cancelBtn) cancelBtn.addEventListener("click", () => setEditing(false));

    editor.addEventListener("keydown", (event) => {
      if (event.key === "Escape") setEditing(false);
    });

    editor.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (errorEl) errorEl.textContent = "";

      const payload = collect();
      const invalid = payload.links.find(
        (l) => !l.label || !/^https?:\/\//i.test(l.url)
      );
      if (invalid) {
        if (errorEl)
          errorEl.textContent =
            "Ogni link vuole un titolo e un indirizzo che inizi con http:// o https://. Le righe vuote si possono togliere con ×.";
        return;
      }

      const submit = editor.querySelector('[type="submit"]');
      if (submit) submit.disabled = true;
      try {
        const res = await fetch("/api/site", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bio: payload }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(
            (body && (body.error || body.message)) || "Salvataggio non riuscito."
          );
        }
        current = normalize(payload);
        renderBio();
        setEditing(false);
        if (feedback) {
          feedback.textContent = "Link salvati.";
          window.setTimeout(() => {
            if (feedback) feedback.textContent = "";
          }, 2500);
        }
      } catch (err) {
        if (errorEl) errorEl.textContent = err.message;
      } finally {
        if (submit) submit.disabled = false;
      }
    });

    try {
      const res = await fetch("/api/session");
      if (res.ok) {
        const session = await res.json();
        canEdit = Boolean(session && session.authenticated);
      }
    } catch (e) {
      canEdit = false;
    }
    editBtn.hidden = !canEdit;
  }

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
