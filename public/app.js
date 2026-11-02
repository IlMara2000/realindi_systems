"use strict";
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const money = (cents) =>
  new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" }).format(
    (cents || 0) / 100,
  );
const day = (v) =>
  v
    ? new Date(v.slice(0, 10) + "T12:00:00").toLocaleDateString("it-IT", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
    : "—";
const timeLabel = (v) =>
  new Date(v).toLocaleString("it-IT", {
    timeZone: "Europe/Rome",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
const today = () =>
  new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Rome" });
const futureDay = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString("en-CA", { timeZone: "Europe/Rome" });
};
const labels = {
  dashboard: "Panoramica",
  clients: "Clienti",
  projects: "Progetti",
  quotes: "Preventivi",
  invoices: "Fatture",
  documents: "Documenti",
  calendar: "Appuntamenti",
  settings: "Impostazioni",
  discovery: "In definizione",
  active: "In corso",
  paused: "In pausa",
  completed: "Completato",
  draft: "Bozza",
  sent: "Consegnato",
  accepted: "Accettato",
  rejected: "Rifiutato",
  issued: "Numerata",
  paid: "Pagata",
  confirmed: "Confermato",
  cancelled: "Annullato",
  overdue: "Scaduta",
};
const paths = {
  dashboard: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  clients:
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M16 3a4 4 0 0 1 0 8 M22 21v-2a4 4 0 0 0-3-3.87 M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  projects: "M3 7h6l2-3h9a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z",
  quotes: "M7 3h10l3 3v15H4V3z M8 9h8 M8 13h8 M8 17h5",
  invoices: "M6 3h12v18l-3-2-3 2-3-2-3 2z M9 8h6 M9 12h6",
  documents:
    "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6",
  calendar: "M4 5h16v16H4z M16 3v4 M8 3v4 M4 11h16 M8 15h2 M14 15h2",
  settings:
    "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2",
};
const icon = (k) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[k] || paths.documents}"/></svg>`;
const pill = (status) =>
  `<span class="pill ${esc(status)}">${esc(labels[status] || status)}</span>`;
let state,
  route = "dashboard",
  search = "",
  filter = "all";
async function api(url, data) {
  const res = await fetch(url, {
    credentials: "same-origin",
    ...(data !== undefined
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        }
      : {}),
  });
  const result = await res.json();
  if (!res.ok) throw new Error(result.error || "Operazione non riuscita.");
  return result;
}
function toast(s) {
  $("#toast").textContent = s;
  $("#toast").style.display = "block";
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => ($("#toast").style.display = "none"), 4500);
}
function report(e) {
  toast(e.message || String(e));
}
function client(id) {
  return state.clients.find((x) => x.id === Number(id)) || {};
}
function project(id) {
  return state.projects.find((x) => x.id === Number(id)) || {};
}
function projectClient(id) {
  return client(project(id).client_id);
}
function btn(text, action, id = "", cls = "secondary small") {
  return `<button type="button" class="${cls}" data-action="${action}" data-id="${esc(id)}">${text}</button>`;
}
function empty(kind, title, description, action) {
  return `<div class="empty">${icon(kind)}<strong>${title}</strong><p>${description}</p>${action || ""}</div>`;
}
function table(headers, rows) {
  return `<div class="table-wrap"><table><thead><tr>${headers.map((x) => `<th>${x}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}
function panel(title, body, link = "") {
  return `<section class="panel"><div class="panel-head"><h2>${title}</h2>${link}</div>${body}</section>`;
}
function field(label, name, type = "text", value = "", extra = "") {
  return `<div class="field"><label for="f-${name}">${label}</label><input id="f-${name}" name="${name}" type="${type}" value="${esc(value)}" ${extra}></div>`;
}
function area(label, name, value = "") {
  return `<div class="field full"><label for="f-${name}">${label}</label><textarea id="f-${name}" name="${name}">${esc(value)}</textarea></div>`;
}
function select(label, name, options, value = "", extra = "") {
  return `<div class="field"><label for="f-${name}">${label}</label><select id="f-${name}" name="${name}" ${extra}>${options.map(([v, t]) => `<option value="${esc(v)}" ${String(v) === String(value) ? "selected" : ""}>${esc(t)}</option>`).join("")}</select></div>`;
}
function title(name, sub, action = "") {
  return `<div class="page-title"><div><div class="eyebrow">Il tuo workspace</div><h1>${name}</h1><p class="subtitle">${sub}</p></div><div class="actions">${action}</div></div>`;
}
function formBottom(label = "Salva") {
  return `<div class="error" role="alert"></div><div class="form-actions"><button type="button" class="secondary" data-action="close">Annulla</button><button class="primary" type="submit">${label}</button></div>`;
}
function showModal(name, html, onSubmit) {
  const modal = $("#modal");
  modal.oninput = null;
  modal.innerHTML = `<div class="modal-header"><h2>${name}</h2><button class="modal-close" aria-label="Chiudi" data-action="close">×</button></div>${html}`;
  if (!modal.open) modal.showModal();
  const form = $("form", modal);
  if (form)
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const submit = $("[type=submit]", form);
      submit.disabled = true;
      $(".error", form).textContent = "";
      try {
        await onSubmit(Object.fromEntries(new FormData(form)), form);
      } catch (e) {
        $(".error", form).textContent = e.message;
      } finally {
        submit.disabled = false;
      }
    });
}
async function refresh() {
  state = await api("/api/state");
  render();
}
async function saved(message) {
  $("#modal").close();
  await refresh();
  toast(message);
}
function auth(setup) {
  $("#root").innerHTML =
    `<div class="auth-page"><section class="auth-story"><div class="brand"><span class="brand-mark">r</span> REALINDI</div><div><div class="eyebrow">Un solo posto. Tutto il tuo lavoro.</div><h1>Più spazio ai progetti.<br>Meno alla burocrazia.</h1><p>Clienti, proposte, documenti e appuntamenti. Il workspace pensato per il tuo lavoro indipendente.</p></div><small>REALINDI SYSTEMS · Freelancer workspace</small></section><section class="auth-form"><div class="brand"><span class="brand-mark">r</span> REALINDI</div><div class="eyebrow">Il tuo nuovo punto di partenza</div><h1>${setup ? "Crea il tuo workspace" : "Bentornato nel workspace"}</h1><p class="subtitle">${setup ? "Scegli la password per proteggere clienti e documenti." : "Accedi per riprendere da dove avevi lasciato."}</p><form id="auth-form">${field("Password", "password", "password", "", 'required minlength="12" maxlength="256" autocomplete="' + (setup ? "new-password" : "current-password") + '"')}${setup ? field("Ripeti password", "confirm", "password", "", 'required minlength="12" autocomplete="new-password"') : ""}<div class="error" role="alert"></div><button class="primary" type="submit">${setup ? "Crea workspace" : "Accedi al workspace"} →</button><p class="hint">${setup ? "Almeno 12 caratteri. I dati vengono conservati nella cartella locale del progetto." : "Sessione privata · accesso protetto"}</p></form></section></div>`;
  $("#auth-form").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target,
      d = Object.fromEntries(new FormData(f));
    $("button", f).disabled = true;
    try {
      if (setup && d.password !== d.confirm)
        throw new Error("Le password non coincidono.");
      await api(setup ? "/api/setup" : "/api/login", d);
      await refresh();
    } catch (e) {
      $(".error", f).textContent = e.message;
    } finally {
      if ($("button", f)) $("button", f).disabled = false;
    }
  };
}
function render() {
  route = location.hash.slice(1) || "dashboard";
  if (!labels[route]) route = "dashboard";
  $("#root").innerHTML =
    `<div class="shell"><aside class="sidebar"><a class="brand" href="#dashboard"><span class="brand-mark">r</span> REALINDI</a><div class="brand-sub">FREELANCER WORKSPACE</div><div class="nav-label">WORKSPACE</div><nav class="nav" aria-label="Menu principale">${["dashboard", "clients", "projects", "quotes", "invoices", "documents", "calendar", "settings"].map((k) => `<a href="#${k}" class="${route === k ? "active" : ""}" ${route === k ? 'aria-current="page"' : ""}>${icon(k)}${labels[k]}</a>`).join("")}</nav><div class="sidebar-bottom"><div class="nav-label">IL TUO BUSINESS, IN ORDINE.</div><div class="account"><span class="avatar">${esc((state.settings.owner_name || "RS").slice(0, 2).toUpperCase())}</span><div>${esc(state.settings.owner_name || "Il tuo workspace")}<small>Consulente indipendente</small></div></div></div></aside><main class="main"><header class="topbar"><div class="crumb">Workspace <span>/ &nbsp; ${labels[route]}</span></div><div class="top-right"><span class="local-status"><i class="status-dot"></i>Archivio locale</span>${btn("Esci", "logout", "", "secondary small")}</div></header><div class="content" id="content"></div></main></div>`;
  renderContent();
}
function renderContent() {
  const views = {
    dashboard,
    clients,
    projects,
    quotes,
    invoices,
    documents,
    calendar,
    settingsView,
  };
  $("#content").innerHTML = (
    route === "settings" ? settingsView : views[route]
  )();
  if (route === "dashboard" && (!state.settings.tax_regime || !state.settings.vat_number)) {
    $("#content").insertAdjacentHTML("afterbegin", '<div class="callout"><strong>Configura la tua azienda</strong><br>Inserisci dati fiscali e preferenze di fatturazione prima di generare il primo XML. <a href="#settings">Apri impostazioni →</a></div>');
  }
  bindView();
}
function dashboard() {
  const paid = state.invoices.filter((x) => x.status === "paid");
  const open = state.invoices.filter((x) => x.status === "issued");
  const accepted = state.quotes.filter((x) => x.status === "accepted");
  const upcoming = state.appointments
    .filter((x) => x.status === "confirmed" && new Date(x.start) > new Date())
    .sort((a, b) => a.start.localeCompare(b.start));
  const ongoing = state.projects.filter((x) => x.status === "active");
  const sum = (a) => a.reduce((s, x) => s + invoicePayable(x), 0);
  const metrics = [
    ["Incassato", money(sum(paid)), "Fatture segnate come pagate", "invoices"],
    [
      "Da incassare",
      money(sum(open)),
      `${open.length} fatture in attesa di pagamento`,
      "quotes",
    ],
    [
      "Progetti in corso",
      ongoing.length,
      `${state.projects.length} progetti nel workspace`,
      "projects",
    ],
    [
      "Clienti",
      state.clients.length,
      `${accepted.length} preventivi accettati`,
      "clients",
    ],
  ];
  const months = Array.from({ length: 6 }, (_, i) => {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - 5 + i);
    const key = d.toLocaleDateString("en-CA").slice(0, 7);
    return {
      label: d.toLocaleDateString("it-IT", { month: "short" }),
      sum: sum(paid.filter((x) => x.paid_at?.startsWith(key))),
    };
  });
  const max = Math.max(...months.map((x) => x.sum), 1);
  return (
    title(
      "Ogni progetto, sotto controllo.",
      "Una visione chiara del lavoro e delle prossime opportunità.",
      btn("Stima dal progetto", "estimate-project", "", "primary") +
        btn("+ Preventivo manuale", "new-quote"),
    ) +
    `<div class="metrics">${metrics.map((m, i) => `<section class="metric ${i === 0 ? "featured" : ""}"><div class="metric-label">${m[0]}${icon(m[3])}</div><div class="metric-value">${m[1]}</div><small>${m[2]}</small></section>`).join("")}</div><div class="grid-two">${panel("Andamento degli incassi", `<div class="chart">${months.map((m) => `<div class="chart-col"><span class="bar-value">${money(m.sum)}</span><div class="bar" data-height="${Math.max(3, (m.sum / max) * 130)}"></div><small>${m.label}</small></div>`).join("")}</div><div class="chart-footer">Ultimi 6 mesi · importi netti da pagare delle fatture saldate</div>`, '<a href="#invoices">Dettaglio fatture ↗</a>')}${panel(
      "Prossimi appuntamenti",
      upcoming.length
        ? upcoming
            .slice(0, 3)
            .map(
              (a) =>
                `<div class="list-row"><div class="date-tile"><b>${new Date(a.start).getDate()}</b><small>${new Date(a.start).toLocaleDateString("it-IT", { month: "short" })}</small></div><div class="list-info"><strong>${esc(a.name)}</strong><small>${timeLabel(a.start)} · ${esc(a.email)}</small></div></div>`,
            )
            .join("")
        : empty(
            "calendar",
            "L’agenda aspetta il prossimo progetto",
            "Condividi la pagina di prenotazione per ricevere appuntamenti.",
          ),
      '<a href="#calendar">Apri agenda ↗</a>',
    )}</div>${panel("Progetti in primo piano", ongoing.length ? projectTable(ongoing.slice(0, 5)) : empty("projects", "Qui iniziano le prossime idee", "Aggiungi un cliente e crea il suo primo progetto.", btn("+ Nuovo progetto", "new-project", "", "secondary")), '<a href="#projects">Tutti i progetti ↗</a>')}<div class="section-gap">${panel("Da tenere d’occhio", `<div class="list-row"><div class="list-info"><strong>${state.quotes.filter((x) => ["draft", "sent"].includes(x.status)).length} preventivi aperti</strong><small>Le opportunità da trasformare in nuovi progetti</small></div><a href="#quotes">Vai ai preventivi →</a></div><div class="list-row"><div class="list-info"><strong>${state.invoices.filter((x) => x.status === "draft").length} fatture in bozza</strong><small>Generate automaticamente dai preventivi accettati</small></div><a href="#invoices">Controlla le bozze →</a></div>`)}</div>`
  );
}
function searchbar(placeholder, statuses = []) {
  return `<div class="toolbar"><input class="search" type="search" id="search" aria-label="Cerca" placeholder="${placeholder}" value="${esc(search)}">${statuses.length ? `<select id="status-filter" aria-label="Filtra per stato" class="search"><option value="all">Tutti gli stati</option>${statuses.map((x) => `<option value="${x}" ${filter === x ? "selected" : ""}>${labels[x]}</option>`).join("")}</select>` : ""}</div>`;
}
function matches(text) {
  return String(text).toLowerCase().includes(search.toLowerCase());
}
function clients() {
  const rows = state.clients.filter((x) =>
    matches(x.name + " " + x.company + " " + x.email),
  );
  return (
    title(
      "Relazioni che fanno crescere il lavoro.",
      `${state.clients.length} clienti · tutte le informazioni, nello stesso posto.`,
      btn("+ Nuovo cliente", "new-client", "", "primary"),
    ) +
    searchbar("Cerca per nome, azienda o email…") +
    `<section class="panel">${
      rows.length
        ? table(
            ["Cliente", "Contatti", "Progetti", "Partita IVA", ""],
            rows.map(
              (c) =>
                `<tr><td><strong>${esc(c.name)}</strong><small>${esc(c.company || "Privato / professionista")}</small></td><td>${esc(c.email)}<small>${esc(c.phone)}</small></td><td>${state.projects.filter((p) => p.client_id === c.id).length}</td><td>${esc(c.vat_number || "—")}</td><td>${btn("Apri scheda", "edit-client", c.id)}</td></tr>`,
            ),
          )
        : empty(
            "clients",
            search ? "Nessun risultato" : "Il primo cliente, il primo passo",
            search
              ? "Prova a cambiare la ricerca."
              : "Salva contatti, dati fiscali e note utili per ogni relazione.",
            search
              ? ""
              : btn("+ Aggiungi cliente", "new-client", "", "primary"),
          )
    }</section>`
  );
}
function projectTable(rows) {
  return table(
    ["Progetto / cliente", "Stato", "Scadenza", ""],
    rows.map(
      (p) =>
        `<tr><td><strong>${esc(p.title)}</strong><small>${esc(client(p.client_id).name)}</small></td><td>${pill(p.status)}</td><td>${day(p.deadline)}</td><td>${btn("Apri", "edit-project", p.id)}</td></tr>`,
    ),
  );
}
function projects() {
  const rows = state.projects.filter(
    (p) =>
      matches(p.title + " " + client(p.client_id).name) &&
      (filter === "all" || p.status === filter),
  );
  return (
    title(
      "Dall’idea alla consegna.",
      "Organizza i lavori, segui le scadenze e mantieni il contesto.",
      btn("+ Nuovo progetto", "new-project", "", "primary"),
    ) +
    searchbar("Cerca progetto o cliente…", [
      "discovery",
      "active",
      "paused",
      "completed",
    ]) +
    (rows.length
      ? `<div class="project-grid">${rows.map((p) => `<article class="project"><div class="project-head">${pill(p.status)}${btn("Modifica", "edit-project", p.id)}</div><div class="eyebrow">${esc(client(p.client_id).name)}</div><h2>${esc(p.title)}</h2><p>${esc(p.description || "Aggiungi gli obiettivi e il perimetro di questo progetto.")}</p><footer><span>${p.deadline ? "Consegna " + day(p.deadline) : "Nessuna scadenza"}</span>${btn("Stima automatica →", "estimate-project", p.id)}</footer></article>`).join("")}</div>`
      : `<section class="panel">${empty("projects", "Nessun progetto da mostrare", "Crea un progetto e collega preventivi, fatture e documenti.", btn("+ Nuovo progetto", "new-project", "", "primary"))}</section>`)
  );
}
function quotes() {
  const rows = state.quotes.filter(
    (q) =>
      matches(q.title + " " + projectClient(q.project_id).name) &&
      (filter === "all" || filter === q.status),
  );
  return (
    title(
      "Il valore del tuo lavoro, nero su bianco.",
      "Stime trasparenti, calcoli automatici e fatture collegate.",
      btn("Stima dal progetto", "estimate-project", "", "primary") +
        btn("+ Preventivo manuale", "new-quote"),
    ) +
    searchbar("Cerca preventivo o cliente…", [
      "draft",
      "sent",
      "accepted",
      "rejected",
    ]) +
    `<section class="panel">${
      rows.length
        ? table(
            [
              "Preventivo",
              "Cliente / progetto",
              "Totale",
              "Validità",
              "Stato",
              "",
            ],
            rows.map(
              (q) =>
                `<tr><td><strong>PRE-${String(q.id).padStart(4, "0")}</strong><small>${esc(q.title)}</small></td><td>${esc(projectClient(q.project_id).name)}<small>${esc(project(q.project_id).title)}</small></td><td class="amount">${money(q.total)}</td><td>${day(q.valid_until)}</td><td>${pill(q.status)}</td><td><div class="actions">${btn("Apri", "view-quote", q.id)}${q.status === "draft" ? btn("Modifica", "edit-quote", q.id) : ""}</div></td></tr>`,
            ),
          )
        : empty(
            "quotes",
            "Il prossimo accordo parte da qui",
            "Scegli le attività: il preventivatore calcola ore, complessità, extra e IVA.",
            btn("+ Crea preventivo", "new-quote", "", "primary"),
          )
    }</section>`
  );
}
function invoices() {
  const rows = state.invoices.filter(
    (i) =>
      matches((i.number || "") + " " + i.snapshot.client.name) &&
      (filter === "all" || i.status === filter),
  );
  return (
    title(
      "Fatture pronte, meno lavoro ripetitivo.",
      "Ogni preventivo accettato genera automaticamente una bozza.",
    ) +
    `<div class="callout">Ogni fattura richiede la verifica dei dati aziendali e del trattamento fiscale. Il file XML generato viene validato; invio allo SdI e conservazione non sono ancora collegati.</div>` +
    searchbar("Cerca numero o cliente…", ["draft", "issued", "paid"]) +
    `<section class="panel">${
      rows.length
        ? table(
            ["Fattura", "Cliente", "Totale", "Scadenza", "Stato", ""],
            rows.map(
              (i) =>
                `<tr><td><strong>${esc(i.number || "Bozza #" + i.id)}</strong><small>${esc(i.snapshot.title)}</small></td><td>${esc(i.snapshot.client.name)}</td><td class="amount">${money(i.total)}</td><td>${day(i.due_date)}</td><td>${pill(i.status)} ${i.status === "issued" && i.due_date < today() ? pill("overdue") : ""}</td><td>${btn("Apri fattura", "view-invoice", i.id)}</td></tr>`,
            ),
          )
        : empty(
            "invoices",
            "Le fatture nascono dai tuoi accordi",
            "Apri un preventivo e registrane l’accettazione per generare la prima bozza.",
            '<a class="button" href="#quotes">Vai ai preventivi</a>',
          )
    }</section>`
  );
}
function documents() {
  const rows = state.documents.filter((d) =>
    matches(d.name + " " + client(d.client_id).name),
  );
  return (
    title(
      "Il tuo archivio, sempre in ordine.",
      "Contratti, brief e allegati organizzati per cliente e progetto.",
      btn("↑ Carica documento", "upload", "", "primary"),
    ) +
    searchbar("Cerca documento o cliente…") +
    `<section class="panel">${
      rows.length
        ? table(
            [
              "Documento",
              "Cliente / progetto",
              "Dimensione",
              "Caricato il",
              "",
            ],
            rows.map(
              (d) =>
                `<tr><td><strong>${esc(d.name)}</strong><small title="${esc(d.sha256)}">SHA-256 · ${esc(d.sha256.slice(0, 16))}…</small></td><td>${esc(client(d.client_id).name)}<small>${esc(project(d.project_id).title || "Archivio cliente")}</small></td><td>${(d.size / 1024).toLocaleString("it-IT", { maximumFractionDigits: 1 })} KB</td><td>${day(d.created_at)}</td><td><a class="secondary small" href="/api/documents/${d.id}">Scarica ↓</a></td></tr>`,
            ),
          )
        : empty(
            "documents",
            "Tutto il contesto, a portata di mano",
            "Carica file fino a 10 MB. L’archivio è incluso nell’esportazione di backup.",
            btn("Carica il primo documento", "upload", "", "primary"),
          )
    }</section>`
  );
}
function bookingUrl() {
  const base = (state.settings.public_url || location.origin).replace(/\/$/, "");
  return base + "/book/" + state.settings.booking_slug;
}
function calendar() {
  const online = Boolean(state.settings.public_url);
  const rows = state.appointments
    .filter((a) => filter === "all" || a.status === filter)
    .sort((a, b) => b.start.localeCompare(a.start));
  return (
    title(
      "Tempo al lavoro che conta.",
      "La tua pagina di prenotazione, con disponibilità personalizzate.",
      `<a class="button" href="${bookingUrl()}" target="_blank" rel="noopener">Apri pagina pubblica ↗</a>`,
    ) +
    `<div class="grid-two">${panel("Il tuo link di prenotazione", `<div class="panel-body"><p class="subtitle">${esc(state.settings.booking_title)} · ${state.settings.booking_duration} minuti</p><p class="link-box">${esc(bookingUrl())}</p><div class="actions">${btn("Copia link", "copy-booking")}<a href="#settings">Modifica disponibilità →</a></div><p class="hint">${online ? "Link pubblico attivo: puoi condividerlo con i clienti. Funziona finché server e tunnel restano attivi." : "Questo link funziona solo su questo computer. Apri «Pubblica prenotazioni.command» per un indirizzo HTTPS condivisibile, oppure inseriscilo in Impostazioni."}</p></div>`)}${panel("Periodi non disponibili", `<div class="panel-body">${state.blocks.length ? state.blocks.map((b) => `<div class="list-row"><div class="list-info"><strong>${esc(b.reason || "Non disponibile")}</strong><small>${timeLabel(b.start)} → ${timeLabel(b.end)}</small></div>${btn("Rimuovi", "delete-block", b.id)}</div>`).join("") : '<p class="subtitle">Nessuna assenza impostata.</p>'}<div class="section-gap">${btn("+ Blocca un periodo", "new-block")}</div></div>`)}</div>` +
    searchbar("Cerca appuntamento…", ["confirmed", "cancelled"]) +
    panel(
      "Appuntamenti",
      rows.filter((a) => matches(a.name + " " + a.email)).length
        ? table(
            ["Ospite", "Quando · Europe/Rome", "Note", "Stato", ""],
            rows
              .filter((a) => matches(a.name + " " + a.email))
              .map(
                (a) =>
                  `<tr><td><strong>${esc(a.name)}</strong><small>${esc(a.email)}</small></td><td>${timeLabel(a.start)}</td><td>${esc(a.notes || "—")}</td><td>${pill(a.status)}</td><td><div class="actions">${btn("Calendario .ics", "ics", a.id)}${a.status === "confirmed" ? btn("Annulla", "cancel-appointment", a.id) : ""}</div></td></tr>`,
              ),
          )
        : empty(
            "calendar",
            "La tua agenda è libera",
            "Le nuove prenotazioni compariranno qui automaticamente.",
          ),
    )
  );
}
function settingsView() {
  const s = state.settings;
  return (
    title(
      "Un workspace che ti somiglia.",
      "Dati attività, parametri economici e disponibilità.",
    ) +
    `<form id="settings-form"><div class="settings-grid">${panel("Attività e fatturazione", `<div class="panel-body form-grid">${field("Nome attività", "business_name", "text", s.business_name, "required")}${field("Il tuo nome", "owner_name", "text", s.owner_name)}${field("Email attività", "email", "email", s.email)}${field("Partita IVA", "vat_number", "text", s.vat_number)}${field("Codice fiscale", "tax_code", "text", s.tax_code)}${field("IBAN", "iban", "text", s.iban)}${area("Indirizzo completo", "address", s.address)}${field("Dicitura aggiuntiva", "tax_label", "text", s.tax_label)}${field("IVA indicativa preventivi (%)", "vat_rate", "number", s.vat_rate, 'min="0" max="100" step="0.01" required')}${field("Tariffa oraria (€)", "hourly_rate", "number", s.hourly_rate, 'min="0" step="0.01" required')}<p class="hint">Partita IVA senza prefisso paese. Completa il profilo fiscale aziendale qui sotto: ogni fattura richiederà una verifica dedicata.</p></div>`)}${panel("Pagina di prenotazione", `<div class="panel-body form-grid">${field("Titolo dell’incontro", "booking_title", "text", s.booking_title, "required")}${field("Durata (minuti)", "booking_duration", "number", s.booking_duration, 'min="15" max="180" required')}${area("Presentazione", "booking_description", s.booking_description)}${field("Disponibile dalle (ora)", "booking_start", "number", s.booking_start, 'min="0" max="23" required')}${field("Alle (ora)", "booking_end", "number", s.booking_end, 'min="1" max="23" required')}${field("Preavviso minimo (ore)", "booking_notice", "number", s.booking_notice, 'min="0" max="720" required')}${field("Prenotabile entro (giorni)", "booking_horizon", "number", s.booking_horizon, 'min="1" max="180" required')}${field("Indirizzo pubblico (HTTPS)", "public_url", "url", s.public_url, 'placeholder="https://prenotazioni.esempio.it"')}<p class="hint">Indirizzo su cui i clienti aprono le prenotazioni, solo dominio senza percorso. Vuoto: il link usa l'indirizzo da cui stai navigando. «Pubblica prenotazioni.command» lo imposta automaticamente quando avvia il tunnel.</p><div class="field full"><label>Giorni disponibili · Europe/Rome</label><div class="check-row">${["Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"].map((t, i) => `<label><input type="checkbox" name="day" value="${i}" ${s.booking_days.includes(i) ? "checked" : ""}>${t}</label>`).join("")}</div></div><div class="field full check-row"><label><input type="checkbox" name="booking_enabled" ${s.booking_enabled ? "checked" : ""}>Accetta nuove prenotazioni</label></div></div>`)}</div>${fiscalSettings(s)}<div class="error" role="alert"></div><div class="form-actions"><button class="primary" type="submit">Salva impostazioni</button></div></form><div class="section-gap">${panel("I tuoi dati restano tuoi", `<div class="panel-body"><p class="subtitle">Esporta database e documenti in un archivio ZIP. Il backup contiene dati personali: conservalo in un luogo protetto.</p><div class="section-gap"><a class="button" href="/api/backup">Scarica backup completo ↓</a></div><p class="hint">Il ripristino è disponibile con lo strumento manage.py incluso nel progetto.</p></div>`)}</div>`
  );
}
function bindView() {
  $$("[data-height]").forEach(
    (b) => (b.style.height = b.dataset.height + "px"),
  );
  if ($("#search"))
    $("#search").oninput = (e) => {
      const pos = e.target.selectionStart;
      search = e.target.value;
      renderContent();
      $("#search").focus();
      $("#search").setSelectionRange(pos, pos);
    };
  if ($("#status-filter"))
    $("#status-filter").onchange = (e) => {
      filter = e.target.value;
      renderContent();
    };
  if ($("#settings-form"))
    $("#settings-form").onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target,
        d = Object.fromEntries(new FormData(f));
      d.booking_days = $$("input[name=day]:checked", f).map((x) =>
        Number(x.value),
      );
      d.booking_enabled = f.booking_enabled.checked;
      const b = $("[type=submit]", f);
      b.disabled = true;
      try {
        await api("/api/settings", d);
        await refresh();
        toast("Impostazioni salvate.");
      } catch (e) {
        $(".error", f).textContent = e.message;
      } finally {
        b.disabled = false;
      }
    };
}
function clientModal(id) {
  const c = client(id);
  showModal(
    id ? "Scheda cliente" : "Nuovo cliente",
    `<form><div class="form-grid">${field("Nome e cognome / referente", "name", "text", c.name, 'required maxlength="300"')}${field("Azienda", "company", "text", c.company)}${field("Email", "email", "email", c.email, "required")}${field("Telefono", "phone", "tel", c.phone)}${field("Partita IVA (senza prefisso paese)", "vat_number", "text", c.vat_number)}${field("Indirizzo", "address", "text", c.address)}${area("Note e contesto", "notes", c.notes)}${fiscalClientFields(c)}</div>${formBottom()}</form>`,
    async (d) => {
      await api("/api/clients", { ...d, id: id || undefined });
      await saved("Cliente salvato.");
    },
  );
}
function projectModal(id) {
  if (!state.clients.length) {
    toast("Aggiungi prima il cliente del progetto.");
    return clientModal();
  }
  const p = project(id);
  showModal(
    id ? "Dettagli progetto" : "Nuovo progetto",
    `<form><div class="form-grid">${field("Nome progetto", "title", "text", p.title, "required")}${select(
      "Cliente",
      "client_id",
      state.clients.map((c) => [c.id, c.name]),
      p.client_id,
    )}${select(
      "Stato",
      "status",
      ["discovery", "active", "paused", "completed"].map((s) => [s, labels[s]]),
      p.status || "discovery",
    )}${field("Scadenza", "deadline", "date", p.deadline)}${area("Obiettivi, perimetro e accordi", "description", p.description)}</div>${formBottom()}</form>`,
    async (d) => {
      await api("/api/projects", { ...d, id: id || undefined });
      await saved("Progetto salvato.");
    },
  );
}
let lineId = 0,
  calcVersion = 0;
function quoteLine(item = {}) {
  const n = ++lineId;
  return `<div class="quote-line"><div class="line-description"><label for="desc-${n}">Attività / risultato</label><input id="desc-${n}" data-key="description" value="${esc(item.description || "")}" placeholder="Es. Sviluppo area clienti" required maxlength="500"></div>${[
    ["hours", "Ore", item.hours ?? 8],
    ["rate", "€/ora", item.rate ?? state.settings.hourly_rate],
    ["factor", "Complessità", item.factor ?? 1],
    ["extra", "Extra €", item.extra ?? 0],
  ]
    .map(
      ([k, l, v]) =>
        `<div><label for="${k}-${n}">${l}</label><input id="${k}-${n}" type="number" data-key="${k}" value="${esc(v)}" step="0.01" min="${k === "factor" ? "0.1" : "0"}" ${k === "factor" ? 'max="10"' : ""} required></div>`,
    )
    .join(
      "",
    )}<button type="button" class="remove-line" data-action="remove-line" aria-label="Rimuovi attività">×</button></div>`;
}
function quoteItems() {
  return $$(".quote-line", $("#modal")).map((l) =>
    Object.fromEntries(
      $$("[data-key]", l).map((x) => [x.dataset.key, x.value]),
    ),
  );
}
async function calculateQuote() {
  const v = ++calcVersion;
  try {
    const d = await api("/api/quotes/calculate", {
      items: quoteItems().map((x) => ({
        ...x,
        description: x.description || "Attività",
      })),
      vat_rate: $("#f-vat_rate", $("#modal")).value,
    });
    if (v === calcVersion && $("#quote-total"))
      $("#quote-total").innerHTML =
        `<div><span>Imponibile</span><b>${money(d.subtotal)}</b></div><div><span>IVA ${esc(d.vat_rate)}%</span><b>${money(d.vat)}</b></div><div class="grand"><span>Totale</span><span>${money(d.total)}</span></div>`;
  } catch (e) {
    if (v === calcVersion && $("#quote-total"))
      $("#quote-total").textContent = e.message;
  }
}
function quoteModal(id, projectId) {
  if (!state.projects.length) {
    toast("Crea prima un progetto per il preventivo.");
    return projectModal();
  }
  const q = state.quotes.find((x) => x.id === Number(id)) || {};
  showModal(
    id ? "Modifica preventivo" : "Costruisci il tuo preventivo",
    `<form><div class="form-grid">${field("Titolo proposta", "title", "text", q.title, "required")}${select(
      "Progetto",
      "project_id",
      state.projects.map((p) => [
        p.id,
        p.title + " · " + client(p.client_id).name,
      ]),
      q.project_id || projectId,
    )}${field("Valido fino al", "valid_until", "date", q.valid_until || futureDay(30), "required")}${field("IVA (%)", "vat_rate", "number", q.vat_rate ?? state.settings.vat_rate, 'min="0" max="100" step="0.01" required')}</div><div class="section-gap"><label>Parti da un modello di attività</label><div class="template-row">${btn("Sito web", "template", "web")}${btn("Applicazione web", "template", "app")}${btn("Consulenza", "template", "consulting")}</div><p class="hint">I modelli sono punti di partenza modificabili. Ogni voce = ore × tariffa × complessità + extra.</p><div id="quote-lines">${(q.items || [{}]).map(quoteLine).join("")}</div><button type="button" class="secondary small" data-action="add-line">+ Aggiungi attività</button></div><div id="quote-total" class="totals" aria-live="polite">Calcolo…</div><div class="section-gap">${area("Condizioni, consegne ed esclusioni", "notes", q.notes || "Pagamento a 30 giorni. Le attività extra saranno concordate separatamente.")}</div>${formBottom("Salva preventivo")}</form>`,
    async (d) => {
      await api("/api/quotes", {
        ...d,
        id: id || undefined,
        items: quoteItems(),
      });
      await saved("Preventivo salvato.");
    },
  );
  $("#modal").oninput = () => calculateQuote();
  calculateQuote();
}
function documentHtml(kind, record) {
  const isInvoice = kind === "invoice";
  const s = isInvoice ? record.snapshot.business : state.settings;
  const c = isInvoice
    ? record.snapshot.client
    : projectClient(record.project_id);
  const items = isInvoice ? record.snapshot.items : record.items;
  const name = isInvoice ? record.snapshot.title : record.title;
  const number = isInvoice
    ? record.number || "BOZZA #" + record.id
    : "PRE-" + String(record.id).padStart(4, "0");
  const notes = isInvoice ? record.snapshot.notes : record.notes;
  return `<article class="print-doc"><header><div><h2>${esc(s.business_name)}</h2><address>${esc(s.address)}<br>${esc([s.postcode, s.city, s.province, s.country].filter(Boolean).join(" "))}<br>${esc(s.email)}<br>P. IVA ${esc(s.vat_number || "—")}<br>C.F. ${esc(s.tax_code || "—")}</address></div><div><div class="eyebrow">${isInvoice ? (record.xml_generated ? "Fattura · copia di cortesia" : "Fattura gestionale") : "Preventivo"}</div><h1>${esc(number)}</h1><p>${isInvoice ? "Data: " + day(record.issued_at || record.created_at) : "Data: " + day(record.created_at)}<br>${isInvoice ? "Scadenza: " : "Valido fino al: "}${day(isInvoice ? record.due_date : record.valid_until)}</p>${pill(record.status)}</div></header><div class="client-detail"><div class="eyebrow">Destinatario</div><h3>${esc(c.company || c.name)}</h3><address>${esc(c.name)}<br>${esc(c.address)}<br>${esc([c.postcode, c.city, c.province, c.country].filter(Boolean).join(" "))}<br>${esc(c.email)}<br>P. IVA / C.F. ${esc(c.vat_number || "—")}</address></div><h3>${esc(name)}</h3>${table(
    ["Attività", "Ore", "Tariffa", "Fattore", "Extra", "Importo"],
    items.map(
      (i) =>
        `<tr><td>${esc(i.description)}</td><td>${esc(i.hours)}</td><td>${money(Number(i.rate) * 100)}</td><td>× ${esc(i.factor)}</td><td>${money(Number(i.extra) * 100)}</td><td>${money(i.amount)}</td></tr>`,
    ),
  )}${isInvoice && record.snapshot.fiscal ? fiscalPrint(record) : `<div class="totals"><div><span>Imponibile</span><b>${money(record.subtotal)}</b></div><div><span>IVA ${esc(isInvoice ? record.snapshot.vat_rate : record.vat_rate)}%</span><b>${money(record.vat)}</b></div><div class="grand"><span>Totale</span><b>${money(record.total)}</b></div></div>`}<div class="notes">${esc(notes)}</div><footer>${esc(isInvoice && record.snapshot.fiscal ? s.tax_regime : s.tax_label)}${s.iban ? "<br>IBAN: " + esc(s.iban) : ""}${isInvoice ? "<br>Non trasmessa al Sistema di Interscambio. Generazione XML e accettazione SdI sono stati distinti." : ""}</footer></article>`;
}
function viewQuote(id) {
  const q = state.quotes.find((x) => x.id === Number(id));
  showModal(
    "Preventivo PRE-" + String(id).padStart(4, "0"),
    `<div class="actions">${q.estimate ? btn("Ipotesi iniziali", "estimate-source", id) : ""}${btn("Stampa / Salva PDF", "print-quote", id)}${q.status === "draft" ? btn("Segna consegnato", "quote-sent", id) : ""}${["draft", "sent"].includes(q.status) ? btn("Registra accettazione", "quote-accepted", id, "primary small") + btn("Rifiutato", "quote-rejected", id) : ""}</div>${documentHtml("quote", q)}`,
  );
}
function viewInvoice(id) {
  const i = state.invoices.find((x) => x.id === Number(id));
  showModal(
    "Fattura " + (i.number || "in bozza"),
    `<div class="actions">${btn("Stampa / Salva PDF", "print-invoice", id)}${i.xml_generated ? `<a class="button small" href="/api/invoices/${i.id}/xml">Scarica XML</a>` : ""}${i.status === "draft" ? btn("Verifica fiscale e genera XML", "invoice-issued", id, "primary small") : ""}${i.status === "issued" ? btn("Segna come pagata", "invoice-paid", id, "primary small") : ""}</div>${documentHtml("invoice", i)}`,
  );
}
function confirmAction(title, text, action) {
  showModal(
    title,
    `<form><p>${text}</p>${formBottom("Conferma")}</form>`,
    async () => {
      await action();
    },
  );
}
function uploadModal() {
  if (!state.clients.length) {
    toast("Aggiungi prima un cliente.");
    return clientModal();
  }
  showModal(
    "Aggiungi un documento",
    `<form><div class="form-grid">${select(
      "Cliente",
      "client_id",
      state.clients.map((c) => [c.id, c.name]),
    )}${select("Progetto (facoltativo)", "project_id", [["", "Archivio cliente"]])}${field("Documento · massimo 10 MB", "file", "file", "", "required")}<p class="hint">Il file originale sarà salvato nell’archivio locale con impronta SHA-256.</p></div>${formBottom("Carica documento")}</form>`,
    async (d, f) => {
      const file = f.file.files[0];
      if (file.size > 10 * 1024 * 1024)
        throw new Error("Il file supera il limite di 10 MB.");
      const content = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result.split(",")[1]);
        r.onerror = () => reject(new Error("Impossibile leggere il file."));
        r.readAsDataURL(file);
      });
      await api("/api/documents", {
        client_id: d.client_id,
        project_id: d.project_id,
        name: file.name,
        content,
      });
      await saved("Documento archiviato.");
    },
  );
  const update = () => {
    $("#f-project_id").innerHTML =
      '<option value="">Archivio cliente</option>' +
      state.projects
        .filter((p) => p.client_id === Number($("#f-client_id").value))
        .map((p) => `<option value="${p.id}">${esc(p.title)}</option>`)
        .join("");
  };
  $("#f-client_id").onchange = update;
  update();
}
function blockModal() {
  showModal(
    "Blocca un periodo",
    `<form><p class="hint">Gli orari sono interpretati nel fuso del dispositivo: ${esc(Intl.DateTimeFormat().resolvedOptions().timeZone)}. Le prenotazioni già confermate restano valide.</p><div class="form-grid">${field("Dall’istante", "start", "datetime-local", "", "required")}${field("Fino all’istante", "end", "datetime-local", "", "required")}${field("Motivo", "reason")}</div>${formBottom("Blocca disponibilità")}</form>`,
    async (d) => {
      await api("/api/blocks", {
        ...d,
        start: new Date(d.start).toISOString(),
        end: new Date(d.end).toISOString(),
      });
      await saved("Disponibilità aggiornata.");
    },
  );
}
function downloadICS(a, title = "Consulenza") {
  const escapeICS = (s) =>
    String(s || "")
      .replace(/\\/g, "\\\\")
      .replace(/\n/g, "\\n")
      .replace(/,/g, "\\,")
      .replace(/;/g, "\\;")
      .replace(/\r/g, "");
  const stamp = (s) =>
    new Date(s)
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}Z/, "Z");
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//REALINDI//CRM//IT",
    "BEGIN:VEVENT",
    "UID:" + escapeICS(a.cancel_token || a.id) + "@realindi",
    "DTSTAMP:" + stamp(new Date()),
    "DTSTART:" + stamp(a.start),
    "DTEND:" + stamp(a.end),
    "SUMMARY:" + escapeICS(title),
    "DESCRIPTION:" + escapeICS(a.notes || "Appuntamento con " + a.name),
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const url = URL.createObjectURL(
    new Blob([ics], { type: "text/calendar;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "appuntamento.ics";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-action]");
  if (!b) return;
  const a = b.dataset.action,
    id = b.dataset.id;
  try {
    if (a === "close") {
      calcVersion++;
      $("#modal").oninput = null;
      return $("#modal").close();
    }
    if (a === "logout") {
      await api("/api/logout", {});
      state = null;
      return auth(false);
    }
    if (a === "new-client" || a === "edit-client") return clientModal(id);
    if (a === "new-project" || a === "edit-project") return projectModal(id);
    if (a === "new-quote" || a === "edit-quote" || a === "project-quote")
      return quoteModal(
        a === "edit-quote" ? id : undefined,
        a === "project-quote" ? id : undefined,
      );
    if (a === "estimate-project") return await estimateModal(id);
    if (a === "estimate-source") return estimateSource(id);
    if (a === "view-quote") return viewQuote(id);
    if (a === "view-invoice") return viewInvoice(id);
    if (a === "upload") return uploadModal();
    if (a === "new-block") return blockModal();
    if (a === "delete-block") {
      await api("/api/blocks/delete", { id });
      return refresh();
    }
    if (a === "copy-booking") {
      await navigator.clipboard.writeText(bookingUrl());
      return toast("Link copiato.");
    }
    if (a === "ics")
      return downloadICS(
        state.appointments.find((x) => x.id === Number(id)),
        state.settings.booking_title,
      );
    if (a === "cancel-appointment")
      return confirmAction(
        "Annullare l’appuntamento?",
        "L’orario tornerà disponibile. Nessuna email automatica verrà inviata all’ospite.",
        async () => {
          await api("/api/appointments/cancel", { id });
          await saved("Appuntamento annullato.");
        },
      );
    if (a === "add-line") {
      $("#quote-lines").insertAdjacentHTML("beforeend", quoteLine());
      return calculateQuote();
    }
    if (a === "remove-line") {
      if ($$(".quote-line").length === 1)
        return toast("Mantieni almeno una attività.");
      b.closest(".quote-line").remove();
      return calculateQuote();
    }
    if (a === "template") {
      const templates = {
        web: [
          ["Analisi e struttura", 4],
          ["Design delle pagine", 12],
          ["Sviluppo e contenuti", 24],
          ["Test e pubblicazione", 6],
        ],
        app: [
          ["Analisi e specifiche", 8],
          ["Interfaccia utente", 24],
          ["Backend e integrazioni", 40],
          ["Test e rilascio", 12],
        ],
        consulting: [
          ["Analisi tecnica", 4],
          ["Sessioni di consulenza", 8],
          ["Report e raccomandazioni", 2],
        ],
      };
      $("#quote-lines").insertAdjacentHTML(
        "beforeend",
        templates[id]
          .map(([description, hours]) => quoteLine({ description, hours }))
          .join(""),
      );
      const first = $(".quote-line");
      if (first && !$("[data-key=description]", first).value) first.remove();
      return calculateQuote();
    }
    if (a.startsWith("print-")) {
      const type = a.split("-")[1];
      const record = state[type === "quote" ? "quotes" : "invoices"].find(
        (x) => x.id === Number(id),
      );
      $("#print-area").innerHTML = documentHtml(type, record);
      window.print();
      return;
    }
    if (a.startsWith("quote-")) {
      const status = a.slice(6);
      return confirmAction(
        "Aggiorna stato preventivo",
        status === "accepted"
          ? "Confermi l’accordo del cliente? Il preventivo verrà bloccato e sarà creata automaticamente una fattura in bozza."
          : status === "sent"
            ? "Segna il preventivo come consegnato al cliente. Questa azione registra lo stato e non invia email."
            : "Registrare il rifiuto del preventivo?",
        async () => {
          await api("/api/quotes/status", { id, status });
          await saved(
            status === "accepted"
              ? "Accordo registrato. La fattura in bozza è pronta."
              : "Stato aggiornato.",
          );
        },
      );
    }
    if (a === "invoice-issued") return await fiscalWizard(id);
    if (a === "fiscal-settings") {
      $("#modal").close();
      location.hash = "settings";
      return;
    }
    if (a === "invoice-paid")
      return confirmAction(
        "Registra pagamento",
        "Confermi di avere ricevuto il pagamento completo?",
        async () => {
          await api("/api/invoices/status", { id, status: "paid" });
          await saved("Pagamento registrato.");
        },
      );
  } catch (e) {
    report(e);
  }
});
window.addEventListener("hashchange", () => {
  search = "";
  filter = "all";
  if (state) render();
});
async function booking() {
  const slug = location.pathname.split("/")[2];
  const info = await api("/api/booking/" + encodeURIComponent(slug));
  const params = new URLSearchParams(location.search);
  $("#root").innerHTML =
    `<main class="booking"><div class="brand"><span class="brand-mark">r</span>${esc(info.business_name)}</div><div class="booking-card"><section class="booking-info"><div class="eyebrow">Facciamo il primo passo</div><h1>${esc(info.booking_title)}</h1><p>${esc(info.booking_description)}</p><p><strong>${info.booking_duration} minuti</strong><br>Fuso orario: Europe/Rome</p><p class="hint">I dati inseriti vengono utilizzati per gestire l’appuntamento e sono visibili al professionista.</p></section><section class="booking-content" id="booking-content"></section></div><p class="booking-footer">Prenotazioni · ${esc(info.business_name)}</p></main>`;
  if (params.has("cancel")) {
    $("#booking-content").innerHTML =
      '<h2>Gestisci la prenotazione</h2><p>Puoi annullare il tuo appuntamento e liberare l’orario.</p><button class="primary" id="cancel-booking">Annulla appuntamento</button><div class="error" role="alert"></div>';
    $("#cancel-booking").onclick = async () => {
      try {
        await api("/api/cancel-booking", { token: params.get("cancel") });
        $("#booking-content").innerHTML =
          '<h2>Prenotazione annullata</h2><p>L’orario è nuovamente disponibile.</p><a class="button" href="' +
          location.pathname +
          '">Prenota un altro incontro</a>';
      } catch (e) {
        $(".error").textContent = e.message;
      }
    };
    return;
  }
  if (!info.booking_enabled) {
    $("#booking-content").innerHTML =
      "<h2>Prenotazioni in pausa</h2><p>Al momento non ci sono nuovi orari disponibili.</p>";
    return;
  }
  $("#booking-content").innerHTML =
    `<h2>Scegli il momento giusto</h2><form id="booking-form"><div class="section-gap">${field("Giorno", "day", "date", futureDay(1), `required min="${today()}" max="${futureDay(info.booking_horizon)}"`)}</div><div id="slots" class="slot-grid" aria-live="polite"></div><div id="booking-details" hidden><div class="form-grid">${field("Nome e cognome", "name", "text", "", "required")}${field("Email", "email", "email", "", "required")}${area("Di cosa vorresti parlare?", "notes")}</div><p class="hint" id="selected-slot"></p><div class="error" role="alert"></div><button class="primary" type="submit">Conferma appuntamento</button></div></form>`;
  let selected = null,
    version = 0;
  async function loadSlots() {
    const v = ++version;
    selected = null;
    $("#booking-details").hidden = true;
    $("#slots").textContent = "Cerco gli orari disponibili…";
    try {
      const data = await api(
        "/api/booking/" +
          encodeURIComponent(slug) +
          "?day=" +
          $("#f-day").value,
      );
      if (v !== version) return;
      $("#slots").innerHTML = data.slots.length
        ? data.slots
            .map(
              (s) =>
                `<button type="button" class="slot" data-start="${s.start}" data-end="${s.end}">${s.label}</button>`,
            )
            .join("")
        : '<p class="muted">Nessun orario disponibile. Prova un altro giorno.</p>';
      $$(".slot").forEach(
        (b) =>
          (b.onclick = () => {
            $$(".slot").forEach((x) => x.classList.remove("selected"));
            b.classList.add("selected");
            selected = { start: b.dataset.start, end: b.dataset.end };
            $("#booking-details").hidden = false;
            $("#selected-slot").textContent =
              "Hai scelto: " + timeLabel(selected.start) + " · Europe/Rome";
          }),
      );
    } catch (e) {
      $("#slots").textContent = e.message;
    }
  }
  $("#f-day").onchange = loadSlots;
  await loadSlots();
  $("#booking-form").onsubmit = async (e) => {
    e.preventDefault();
    if (!selected) return;
    const f = e.target,
      b = $("[type=submit]", f);
    b.disabled = true;
    try {
      const d = Object.fromEntries(new FormData(f)),
        result = await api("/api/booking/" + encodeURIComponent(slug), {
          ...d,
          start: selected.start,
        });
      const cancel =
        location.origin + location.pathname + "?cancel=" + result.cancel_token;
      $("#booking-content").innerHTML =
        `<div class="eyebrow">Ci vediamo presto</div><h2>Appuntamento confermato.</h2><p>${timeLabel(result.start)} · Europe/Rome</p><p>Salva l’evento nel calendario e conserva il link per gestire la prenotazione. Non viene inviata una email automatica.</p><button class="primary" id="save-ics">Aggiungi al calendario</button><p><a href="${esc(cancel)}">Link personale per annullare l’appuntamento</a></p><p class="hint">Conserva questo link: permette di gestire la tua prenotazione.</p>`;
      $("#save-ics").onclick = () =>
        downloadICS(
          {
            ...result,
            name: d.name,
            notes:
              info.booking_description + "\nGestisci prenotazione: " + cancel,
          },
          info.booking_title,
        );
    } catch (e) {
      $(".error", f).textContent = e.message;
      b.disabled = false;
    }
  };
}
(async () => {
  try {
    if (location.pathname.startsWith("/book/")) return await booking();
    const s = await api("/api/session");
    if (!s.authenticated) return auth(s.setup);
    await refresh();
  } catch (e) {
    $("#root").innerHTML =
      '<div class="empty"><strong>Impossibile caricare il workspace</strong><p>' +
      esc(e.message) +
      '</p><a href="/">Riprova</a></div>';
  }
})();
