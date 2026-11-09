// REALINDI SYSTEMS — Theme toggle (dark/light mode)
(function initThemeToggle() {
  const toggle = document.getElementById("theme-toggle");
  if (!toggle) return;

  function getStoredTheme() {
    return localStorage.getItem("theme");
  }

  function setStoredTheme(theme) {
    localStorage.setItem("theme", theme);
  }

  function getPreferredTheme() {
    const stored = getStoredTheme();
    if (stored) return stored;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function applyTheme(theme) {
    document.documentElement.classList.toggle("dark-mode", theme === "dark");
    toggle.setAttribute("aria-pressed", theme === "dark");
    setStoredTheme(theme);
  }

  // Initialize
  applyTheme(getPreferredTheme());

  // Toggle on click
  toggle.addEventListener("click", () => {
    const isDark = document.documentElement.classList.contains("dark-mode");
    applyTheme(isDark ? "light" : "dark");
  });

  // Listen for system preference changes
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
    if (!getStoredTheme()) {
      applyTheme(e.matches ? "dark" : "light");
    }
  });
})();

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

// ---------------------------------------------------------------------------
// Contenuti pubblicati e modifica diretta.
//
// I bottoni «Modifica» non sono nel markup servito a chi non ha la sessione: li
// inserisce il server (handleGet) al posto dei segnaposto <!-- edit-slot:… -->.
// Qui si collegano solo i bottoni realmente presenti e si salva su /api/site,
// che ricontrolla la sessione e sostituisce il contenuto invece di integrarlo:
// quello che non viene inviato non resta appeso alla configurazione precedente.
// Degradazione graziosa: senza /api/site la pagina resta navigabile, le CTA di
// prenotazione si nascondono e i link della bio mostrano lo stato vuoto.
(async function initSiteContent() {
  const SECTIONS = [
    ["main", "Principale"],
    ["socials", "Social"],
    ["contacts", "Contatti"],
  ];

  const EDITORS = {
    hero: {
      title: "Testata",
      fields: [
        ["brand", "Nome del marchio"],
        ["ticker", "Testo scorrevole"],
        ["hero.label", "Etichetta"],
        ["hero.title1", "Titolo — prima riga"],
        ["hero.title2", "Titolo — seconda riga"],
        ["hero.emphasis", "Titolo — parte evidenziata"],
        ["hero.lead", "Testo introduttivo", "textarea"],
        ["hero.cta_primary", "Bottone principale"],
        ["hero.cta_secondary", "Bottone secondario"],
      ],
    },
    services: {
      title: "Servizi",
      fields: [
        ["services.label", "Etichetta"],
        ["services.title1", "Titolo — prima riga"],
        ["services.title2", "Titolo — seconda riga"],
      ],
      lists: [
        {
          path: "services.items",
          label: "Servizio",
          add: "+ Aggiungi servizio",
          fields: [
            ["title", "Titolo"],
            ["body", "Descrizione", "textarea"],
          ],
        },
      ],
    },
    about: {
      title: "Chi sono",
      fields: [
        ["about.label", "Etichetta"],
        ["about.title1", "Titolo — prima riga"],
        ["about.title2", "Titolo — seconda riga"],
        ["about.intro", "Presentazione breve", "textarea"],
      ],
      lists: [
        { path: "about.paragraphs", label: "Paragrafo", add: "+ Aggiungi paragrafo", kind: "text" },
        { path: "about.facts", label: "Punto del metodo", add: "+ Aggiungi punto", kind: "text" },
      ],
    },
    works: {
      title: "Lavori",
      fields: [
        ["works.label", "Etichetta"],
        ["works.title1", "Titolo — prima riga"],
        ["works.title2", "Titolo — seconda riga"],
      ],
      lists: [
        {
          path: "works.items",
          label: "Lavoro",
          add: "+ Aggiungi lavoro",
          fields: [
            ["kicker", "Etichetta piccola"],
            ["title", "Titolo"],
            ["body", "Descrizione", "textarea"],
          ],
        },
      ],
    },
    contacts: {
      title: "Contatti",
      fields: [
        ["contacts.label", "Etichetta"],
        ["contacts.title1", "Titolo — prima riga"],
        ["contacts.title2", "Titolo — seconda riga"],
        ["contacts.secondary", "Bottone secondario"],
      ],
      lists: [
        { path: "contacts.paragraphs", label: "Paragrafo", add: "+ Aggiungi paragrafo", kind: "text" },
      ],
    },
    footer: {
      title: "Piè di pagina",
      fields: [["footer", "Nota a piè di pagina"]],
    },
  };

  const state = { content: null, bio: null, draft: null, section: null };

  let data = null;
  try {
    const res = await fetch("/api/site");
    if (res.ok) data = await res.json();
  } catch (e) {
    data = null;
  }

  // CTA "Prenota un incontro": serve lo slug reale, altrimenti sparisce.
  document.querySelectorAll("[data-booking]").forEach((cta) => {
    if (data && data.booking_path) cta.setAttribute("href", data.booking_path);
    else cta.hidden = true;
  });

  if (data) {
    state.content = data.content || null;
    state.bio = data.bio || null;
  }

  // --------------------------------------------------------------- utilità
  function valueAt(source, path) {
    return path
      .split(".")
      .reduce((acc, key) => (acc && typeof acc === "object" ? acc[key] : undefined), source);
  }

  function setPath(target, path, value) {
    const keys = path.split(".");
    let node = target;
    for (let i = 0; i < keys.length - 1; i += 1) {
      if (!node[keys[i]] || typeof node[keys[i]] !== "object") node[keys[i]] = {};
      node = node[keys[i]];
    }
    node[keys[keys.length - 1]] = value;
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function plainText(el) {
    return el ? el.textContent.replace(/\s+/g, " ").trim() : "";
  }

  function blockOfTitle(path) {
    return path && path.endsWith(".title") ? path.slice(0, path.indexOf(".")) : null;
  }

  // ---------------------------------------------------------------- rendering
  function buildTitle(el, block) {
    const title1 = typeof block.title1 === "string" ? block.title1 : "";
    const title2 = typeof block.title2 === "string" ? block.title2 : "";
    const emphasis = typeof block.emphasis === "string" ? block.emphasis : "";
    el.textContent = "";
    el.appendChild(document.createTextNode(title1));
    if (!title2 && !emphasis) return;
    el.appendChild(document.createElement("br"));
    el.appendChild(document.createTextNode(title2));
    if (emphasis) {
      if (title2) el.appendChild(document.createTextNode(" "));
      const em = document.createElement("em");
      em.textContent = emphasis;
      el.appendChild(em);
    }
  }

  function serviceRow(item, i) {
    const li = document.createElement("li");
    li.className = "row";
    const num = document.createElement("span");
    num.className = "row-num";
    num.textContent = String(i + 1).padStart(2, "0");
    const body = document.createElement("div");
    body.className = "row-body";
    const h3 = document.createElement("h3");
    h3.textContent = typeof item.title === "string" ? item.title : "";
    const p = document.createElement("p");
    p.textContent = typeof item.body === "string" ? item.body : "";
    body.append(h3, p);
    const arrow = document.createElement("span");
    arrow.className = "row-arrow";
    arrow.setAttribute("aria-hidden", "true");
    arrow.textContent = "→";
    li.append(num, body, arrow);
    return li;
  }

  function workCard(item) {
    const li = document.createElement("li");
    li.className = "card";
    const kicker = document.createElement("p");
    kicker.className = "card-kicker";
    kicker.textContent = typeof item.kicker === "string" ? item.kicker : "";
    const h3 = document.createElement("h3");
    h3.textContent = typeof item.title === "string" ? item.title : "";
    const p = document.createElement("p");
    p.textContent = typeof item.body === "string" ? item.body : "";
    li.append(kicker, h3, p);
    return li;
  }

  function renderItems(name, items, build) {
    const mount = document.querySelector(`[data-list="${name}"]`);
    if (!mount) return;
    mount.textContent = "";
    (Array.isArray(items) ? items : []).forEach((item, i) => {
      mount.appendChild(build(item, i));
    });
  }

  function renderLines(name, lines, tag) {
    const mount = document.querySelector(`[data-list="${name}"]`);
    if (!mount) return;
    mount.textContent = "";
    (Array.isArray(lines) ? lines : []).forEach((line) => {
      const el = document.createElement(tag);
      el.textContent = typeof line === "string" ? line : "";
      mount.appendChild(el);
    });
  }

  function applyContent(content) {
    if (!content) return;
    document.querySelectorAll("[data-slot]").forEach((el) => {
      const path = el.getAttribute("data-slot");
      if (!path || path === "bio.tagline" || path === "hero.emphasis") return;
      if (blockOfTitle(path)) return;
      const value = valueAt(content, path);
      if (typeof value === "string") el.textContent = value;
    });
    document.querySelectorAll("[data-slot]").forEach((el) => {
      const path = el.getAttribute("data-slot");
      const block = blockOfTitle(path);
      if (!block) return;
      const section = valueAt(content, block);
      if (section && typeof section === "object") buildTitle(el, section);
    });
    renderItems("services.items", valueAt(content, "services.items"), serviceRow);
    renderItems("works.items", valueAt(content, "works.items"), workCard);
    renderLines("about.paragraphs", valueAt(content, "about.paragraphs"), "p");
    renderLines("about.facts", valueAt(content, "about.facts"), "li");
    renderLines("contacts.paragraphs", valueAt(content, "contacts.paragraphs"), "p");
  }

  // La prima volta la base è ciò che la pagina mostra: si legge dal DOM e da
  // quel momento è contenuto salvato, non più configurazione iniziale.
  function readTitle(path) {
    const el = document.querySelector(`[data-slot="${path}"]`);
    if (!el) return { title1: "", title2: "", emphasis: "" };
    const em = el.querySelector("em");
    let line = 1;
    let title1 = "";
    let title2 = "";
    el.childNodes.forEach((node) => {
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.tagName === "BR") {
          line = 2;
          return;
        }
        if (node.tagName === "EM") return;
      }
      if (line === 1) title1 += node.textContent || "";
      else title2 += node.textContent || "";
    });
    return {
      title1: title1.replace(/\s+/g, " ").trim(),
      title2: title2.replace(/\s+/g, " ").trim(),
      emphasis: plainText(em),
    };
  }

  function readList(selector, build) {
    return Array.from(document.querySelectorAll(selector)).map(build);
  }

  function readFromDom() {
    const at = (path) => plainText(document.querySelector(`[data-slot="${path}"]`));
    const hero = readTitle("hero.title");
    const services = readTitle("services.title");
    const about = readTitle("about.title");
    const works = readTitle("works.title");
    const contacts = readTitle("contacts.title");
    return {
      brand: at("brand"),
      ticker: at("ticker"),
      footer: at("footer"),
      hero: {
        label: at("hero.label"),
        title1: hero.title1,
        title2: hero.title2,
        emphasis: hero.emphasis,
        lead: at("hero.lead"),
        cta_primary: at("hero.cta_primary"),
        cta_secondary: at("hero.cta_secondary"),
      },
      services: {
        label: at("services.label"),
        title1: services.title1,
        title2: services.title2,
        items: readList('[data-list="services.items"] .row', (row) => ({
          title: plainText(row.querySelector("h3")),
          body: plainText(row.querySelector(".row-body p")),
        })),
      },
      about: {
        label: at("about.label"),
        title1: about.title1,
        title2: about.title2,
        intro: at("about.intro"),
        paragraphs: readList('[data-list="about.paragraphs"] p', (p) => plainText(p)),
        facts: readList('[data-list="about.facts"] li', (li) => plainText(li)),
      },
      works: {
        label: at("works.label"),
        title1: works.title1,
        title2: works.title2,
        items: readList('[data-list="works.items"] .card', (card) => ({
          kicker: plainText(card.querySelector(".card-kicker")),
          title: plainText(card.querySelector("h3")),
          body: plainText(card.querySelector("p:not(.card-kicker)")),
        })),
      },
      contacts: {
        label: at("contacts.label"),
        title1: contacts.title1,
        title2: contacts.title2,
        paragraphs: readList('[data-list="contacts.paragraphs"] p', (p) => plainText(p)),
        secondary: at("contacts.secondary"),
      },
    };
  }

  function currentContent() {
    if (!state.content) state.content = readFromDom();
    return state.content;
  }

  // ------------------------------------------------------------- editor sito
  let panel = null;

  function buildButton(text, label, onClick, className) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className || "bio-tool";
    button.textContent = text;
    if (label) button.setAttribute("aria-label", label);
    button.addEventListener("click", onClick);
    return button;
  }

  function fieldBlock(attr, key, label, type, value) {
    const wrap = document.createElement("div");
    wrap.className = "bio-field";
    const caption = document.createElement("span");
    caption.textContent = label;
    const input = type === "textarea" ? document.createElement("textarea") : document.createElement("input");
    if (type === "textarea") input.rows = 4;
    else input.type = "text";
    input.value = typeof value === "string" ? value : "";
    input.setAttribute(attr, key);
    wrap.append(caption, input);
    return wrap;
  }

  function listRow(list, item) {
    const row = document.createElement("div");
    row.className = "site-list-row";
    if (list.kind === "text") {
      const input = document.createElement("textarea");
      input.rows = 3;
      input.value = typeof item === "string" ? item : "";
      input.setAttribute("data-key", "text");
      row.appendChild(input);
    } else {
      (list.fields || []).forEach(([key, label, type]) => {
        row.appendChild(fieldBlock("data-key", key, label, type, item && item[key]));
      });
    }
    const tools = document.createElement("div");
    tools.className = "bio-edit-tools";
    tools.appendChild(
      buildButton("×", "Rimuovi " + list.label.toLowerCase(), () => row.remove())
    );
    row.appendChild(tools);
    return row;
  }

  function listBlock(list, items) {
    const wrap = document.createElement("div");
    wrap.className = "site-list";
    const caption = document.createElement("p");
    caption.className = "site-list-label";
    caption.textContent = list.label;
    const rows = document.createElement("div");
    rows.className = "site-list-rows";
    rows.setAttribute("data-list-path", list.path);
    (Array.isArray(items) ? items : []).forEach((item) => rows.appendChild(listRow(list, item)));
    const add = document.createElement("button");
    add.type = "button";
    add.className = "btn btn-dark btn-sm";
    add.textContent = list.add;
    add.addEventListener("click", () => {
      const empty =
        list.kind === "text"
          ? ""
          : Object.fromEntries((list.fields || []).map(([key]) => [key, ""]));
      const row = listRow(list, empty);
      rows.appendChild(row);
      const input = row.querySelector("input, textarea");
      if (input) input.focus();
    });
    wrap.append(caption, rows, add);
    return wrap;
  }

  function ensurePanel() {
    if (panel) return panel;
    panel = document.createElement("div");
    panel.className = "site-editor";
    panel.hidden = true;

    const card = document.createElement("div");
    card.className = "site-editor-card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-labelledby", "site-editor-title");

    const head = document.createElement("div");
    head.className = "site-editor-head";
    const title = document.createElement("h2");
    title.id = "site-editor-title";
    head.append(title, buildButton("×", "Chiudi", () => closeEditor()));

    const form = document.createElement("form");
    const fields = document.createElement("div");
    fields.className = "site-editor-fields";
    const actions = document.createElement("div");
    actions.className = "bio-editor-actions";
    const save = document.createElement("button");
    save.type = "submit";
    save.className = "btn btn-primary";
    save.textContent = "Salva";
    actions.append(save, buildButton("Annulla", null, () => closeEditor(), "btn btn-ghost"));
    const error = document.createElement("p");
    error.className = "bio-editor-error";
    error.setAttribute("role", "alert");
    const hint = document.createElement("p");
    hint.className = "bio-editor-hint";
    hint.textContent =
      "Salvando, questo contenuto sostituisce per intero quello precedente: i campi lasciati vuoti restano vuoti sul sito.";
    form.append(fields, actions, error, hint);

    card.append(head, form);
    panel.appendChild(card);
    panel.addEventListener("click", (event) => {
      if (event.target === panel) closeEditor();
    });

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      saveContent(save, fields, error);
    });

    panel._title = title;
    panel._fields = fields;
    panel._error = error;
    document.body.appendChild(panel);
    return panel;
  }

  function openEditor(section) {
    const def = EDITORS[section];
    if (!def) return;
    const el = ensurePanel();
    state.section = section;
    state.draft = clone(currentContent());
    el._title.textContent = "Modifica · " + def.title;
    el._fields.textContent = "";
    def.fields.forEach(([path, label, type]) => {
      el._fields.appendChild(fieldBlock("data-path", path, label, type, valueAt(state.draft, path)));
    });
    (def.lists || []).forEach((list) => {
      el._fields.appendChild(listBlock(list, valueAt(state.draft, list.path)));
    });
    el._error.textContent = "";
    el.hidden = false;
    const first = el._fields.querySelector("input, textarea");
    if (first) first.focus({ preventScroll: true });
  }

  function closeEditor() {
    if (panel) panel.hidden = true;
    state.section = null;
    state.draft = null;
  }

  function collectEditor(def) {
    const draft = state.draft;
    const fields = panel._fields;
    fields.querySelectorAll("[data-path]").forEach((input) => {
      setPath(draft, input.getAttribute("data-path"), input.value.trim());
    });
    (def.lists || []).forEach((list) => {
      const rows = Array.from(
        fields.querySelectorAll(`[data-list-path="${list.path}"] .site-list-row`)
      );
      const values = rows.map((row) => {
        if (list.kind === "text") {
          const input = row.querySelector("textarea");
          return input ? input.value.trim() : "";
        }
        const item = {};
        (list.fields || []).forEach(([key]) => {
          const input = row.querySelector(`[data-key="${key}"]`);
          item[key] = input ? input.value.trim() : "";
        });
        return item;
      });
      setPath(draft, list.path, values);
    });
    return draft;
  }

  function flash(message) {
    const note = document.createElement("p");
    note.className = "site-flash";
    note.setAttribute("role", "status");
    note.textContent = message;
    document.body.appendChild(note);
    window.setTimeout(() => note.remove(), 2500);
  }

  async function saveContent(save, fields, error) {
    const def = EDITORS[state.section];
    if (!def) return;
    error.textContent = "";
    save.disabled = true;
    try {
      const content = collectEditor(def);
      const res = await fetch("/api/site", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error((body && (body.error || body.message)) || "Salvataggio non riuscito.");
      }
      const saved = await res.json();
      state.content = saved.content || content;
      applyContent(state.content);
      closeEditor();
      flash("Contenuto aggiornato.");
    } catch (err) {
      error.textContent = err.message;
    } finally {
      save.disabled = false;
    }
  }

  applyContent(state.content);

  document.querySelectorAll("[data-edit]").forEach((button) => {
    const section = button.getAttribute("data-edit");
    if (section === "bio") return;
    button.addEventListener("click", () => openEditor(section));
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && panel && !panel.hidden) closeEditor();
  });

  // ------------------------------------------------------------ link in bio
  const mount = document.getElementById("bio-links");
  if (mount) {
    const tagline = document.getElementById("bio-tagline");
    const copyBtn = document.getElementById("bio-copy");
    const feedback = document.getElementById("bio-feedback");
    const editBtn = document.querySelector('[data-edit="bio"]');
    const editor = document.getElementById("bio-editor");
    const tagInput = document.getElementById("bio-tagline-input");
    const editorLinks = document.getElementById("bio-editor-links");
    const errorEl = document.getElementById("bio-editor-error");
    const addBtn = document.getElementById("bio-add");
    const cancelBtn = document.getElementById("bio-cancel");

    let current = state.bio ? normalize(state.bio) : null;

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
      if (!current) return;
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
      if (!editor) return;
      if (on && !current) {
        current = { tagline: plainText(tagline), links: [] };
      }
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
        const invalid = payload.links.find((l) => !l.label || !/^https?:\/\//i.test(l.url));
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
          const saved = await res.json();
          current = normalize(saved.bio || payload);
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
  }
})();
