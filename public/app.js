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
const chatTime = (v) => {
  if (!v) return "—";
  const iso = /Z|[+-]\d{2}:\d{2}$/.test(v) ? v : v.replace(" ", "T") + "Z";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("it-IT", {
    timeZone: "Europe/Rome",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
};
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
  planner: "Calendario",
  notes: "Note",
  messages: "Messaggi",
  channels: "Canali & AI",
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
  planner: "M4 5h16v16H4z M16 3v4 M8 3v4 M4 11h16 M8 15h2 M14 15h2",
  notes: "M6 3h12a1 1 0 0 1 1 1v16l-3.5-2.5L12 20l-3.5-2.5L5 20V4a1 1 0 0 1 1-1z M9 8h6 M9 12h6",
  messages:
    "M21 11.5a8.4 8.4 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7A8.5 8.5 0 0 1 4 11.5 8.4 8.4 0 0 1 12.5 3 8.4 8.4 0 0 1 21 11.5z",
  channels: "M9 2v6 M15 2v6 M6 8h12v4a6 6 0 0 1-12 0z M12 18v4",
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
  filter = "all",
  plannerMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  selectedDay = today(),
  eventsCache = [],
  eventsFrom = "",
  eventsTo = "",
  pendingToast = "",
  activeConversation = null,
  threadCache = null;
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
function field(label, name, type = "text", value = "", extra = "", idPrefix = "") {
  const id = idPrefix ? `${idPrefix}-${name}` : name;
  return `<div class="field"><label for="f-${id}">${label}</label><input id="f-${id}" name="${name}" type="${type}" value="${esc(value)}" ${extra}></div>`;
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
    `<div class="auth-page"><section class="auth-story"><div class="brand"><img class="brand-mark" src="/assets/logo-realindi.png" alt="" width="32" height="32"> REALINDI</div><div><div class="eyebrow">Un solo posto. Tutto il tuo lavoro.</div><h1>Più spazio ai progetti.<br>Meno alla burocrazia.</h1><p>Clienti, proposte, documenti e appuntamenti. Il workspace pensato per il tuo lavoro indipendente.</p></div><small>REALINDI SYSTEMS · Freelancer workspace</small></section><section class="auth-form"><div class="brand"><img class="brand-mark" src="/assets/logo-realindi.png" alt="" width="32" height="32"> REALINDI</div><div class="eyebrow">Il tuo nuovo punto di partenza</div><h1>${setup ? "Crea il tuo workspace" : "Bentornato nel workspace"}</h1><p class="subtitle">${setup ? "Scegli la password per proteggere clienti e documenti." : "Accedi per riprendere da dove avevi lasciato."}</p><form id="auth-form">${field("Password", "password", "password", "", 'required minlength="12" maxlength="256" autocomplete="' + (setup ? "new-password" : "current-password") + '"')}${setup ? field("Ripeti password", "confirm", "password", "", 'required minlength="12" autocomplete="new-password"') : ""}<div class="error" role="alert"></div><button class="primary" type="submit">${setup ? "Crea workspace" : "Accedi al workspace"} →</button><p class="hint">${setup ? "Almeno 12 caratteri. I dati vengono conservati nella cartella locale del progetto." : "Sessione privata · accesso protetto"}</p></form></section></div>`;
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
/* Menu di navigazione mobile: pannello laterale + linguetta di riapertura. */
function setMenu(open) {
  const drawer = $("#crm-menu");
  if (!drawer) return;
  drawer.classList.toggle("is-open", open);
  document.body.classList.toggle("drawer-open", open);
  const toggle = $(".nav-toggle");
  if (toggle) toggle.setAttribute("aria-expanded", String(open));
  const tab = $(".drawer-tab");
  if (tab) tab.setAttribute("aria-expanded", String(open));
  if (open) {
    const first = $(".nav a", drawer);
    if (first) first.focus({ preventScroll: true });
  } else if (toggle) {
    toggle.focus({ preventScroll: true });
  }
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.body.classList.contains("drawer-open")) setMenu(false);
});
window.addEventListener("resize", () => {
  if (window.innerWidth > 850 && document.body.classList.contains("drawer-open")) setMenu(false);
});
function render() {
  // Ogni render ricostruisce il guscio: il pannello torna chiuso.
  document.body.classList.remove("drawer-open");
  route = location.hash.slice(1) || "dashboard";
  if (!labels[route]) route = "dashboard";
  $("#root").innerHTML =
    `<div class="shell"><div class="drawer-scrim" data-action="menu-close" aria-hidden="true"></div><button type="button" class="drawer-tab" data-action="menu-open" aria-controls="crm-menu" aria-expanded="false" aria-label="Apri il menu"><span aria-hidden="true">‹</span></button><aside class="sidebar" id="crm-menu"><button type="button" class="drawer-close" data-action="menu-close" aria-label="Chiudi il menu">×</button><a class="brand" href="#dashboard"><img class="brand-mark" src="/assets/logo-realindi.png" alt="" width="32" height="32"> REALINDI</a><div class="brand-sub">FREELANCER WORKSPACE</div><div class="nav-label">WORKSPACE</div><nav class="nav" aria-label="Menu principale">${["dashboard", "messages", "clients", "projects", "quotes", "invoices", "ricevute", "documents", "calendar", "planner", "notes", "channels", "settings"].map((k) => k === "ricevute" ? `<a href="/ricevute">${icon("invoices")}Ricevute</a>` : `<a href="#${k}" class="${route === k ? "active" : ""}" ${route === k ? 'aria-current="page"' : ""}>${icon(k)}${labels[k]}</a>`).join("")}</nav><div class="sidebar-bottom"><div class="nav-label">IL TUO BUSINESS, IN ORDINE.</div><div class="account"><span class="avatar">${esc((state.settings.owner_name || "RS").slice(0, 2).toUpperCase())}</span><div>${esc(state.settings.owner_name || "Il tuo workspace")}<small>Consulente indipendente</small></div></div></div></aside><main class="main"><header class="topbar"><div class="topbar-head"><a class="back-site" href="/">Torna al sito</a><div class="crumb">Workspace <span>/ &nbsp; ${labels[route]}</span></div></div><div class="top-right"><span class="local-status"><i class="status-dot"></i>Archivio locale</span>${btn("Esci", "logout", "", "secondary small")}<button type="button" class="nav-toggle" data-action="menu-toggle" aria-controls="crm-menu" aria-expanded="false" aria-label="Apri il menu"><span class="nav-toggle-bars" aria-hidden="true"></span></button></div></header><div class="content" id="content"></div></main></div>`;
  renderContent();
  if (pendingToast) {
    const t = pendingToast;
    pendingToast = "";
    toast(t);
  }
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
    planner,
    notes,
    messages: messagesView,
    channels: channelsView,
    settingsView,
  };
  $("#content").innerHTML = (
    route === "settings" ? settingsView : views[route]
  )();
  if (route === "dashboard" && (!state.settings.tax_regime || !state.settings.vat_number)) {
    $("#content").insertAdjacentHTML("afterbegin", '<div class="callout"><strong>Configura la tua azienda</strong><br>Inserisci dati fiscali e preferenze di fatturazione prima di generare il primo XML. <a href="#settings">Apri impostazioni →</a></div>');
  }
  bindView();
  if (route === "planner") loadPlannerEvents();
  if (route === "messages" && activeConversation && !threadCache) loadThread(activeConversation);
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
const isoDate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const toLocalInput = (iso) => {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const dayIso = (v) => String(v || "").slice(0, 10);
const excerpt = (s, n = 150) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
};
function noteLinks(n) {
  const chips = [];
  if (n.client_id) {
    const c = client(n.client_id);
    if (c.id) chips.push(`<span class="pill">Cliente · ${esc(c.name)}</span>`);
  }
  if (n.project_id) {
    const p = project(n.project_id);
    if (p.id) chips.push(`<span class="pill">Progetto · ${esc(p.title)}</span>`);
  }
  return chips.join("");
}
function notes() {
  const q = search.trim().toLowerCase();
  const list = (state.notes || []).filter((n) => {
    if (!q) return true;
    const hay = (
      n.title +
      " " +
      n.body +
      " " +
      (client(n.client_id).name || "") +
      " " +
      (project(n.project_id).title || "")
    ).toLowerCase();
    return hay.includes(q);
  });
  return (
    title(
      "Tutto ciò che conta, in ordine.",
      "Appunti e promemoria, opzionalmente agganciati a cliente o progetto.",
      btn("+ Nuova nota", "new-note", "", "primary"),
    ) +
    searchbar("Cerca nota…") +
    (list.length
      ? `<div class="note-grid">${list.map(noteCard).join("")}</div>`
      : empty(
          "notes",
          q ? "Nessuna nota trovata." : "Nessuna nota per ora.",
          q
            ? "Prova con un’altra parola."
            : "Crea la tua prima nota: idee, appunti, promemoria per i clienti.",
          btn("+ Nuova nota", "new-note", "", "primary"),
        ))
  );
}
function noteCard(n) {
  const chips = noteLinks(n);
  return `<article class="note-card${n.pinned ? " pinned" : ""}"><div class="note-head"><h3>${esc(n.title)}</h3>${n.pinned ? '<span class="pill confirmed">Fissata</span>' : ""}</div><p>${esc(excerpt(n.body))}</p>${chips ? `<div class="note-links">${chips}</div>` : ""}<div class="actions note-actions">${btn("Modifica", "edit-note", n.id)}${btn("Email", "email-note", n.id)}${btn(n.pinned ? "Sblocca" : "Fissa", "pin-note", n.id)}${btn("Elimina", "delete-note", n.id, "secondary small danger")}</div></article>`;
}
function noteModal(id) {
  const n = id ? (state.notes || []).find((x) => x.id === Number(id)) : null;
  showModal(
    n ? "Modifica nota" : "Nuova nota",
    `<form class="form-grid">${field("Titolo", "title", "text", n?.title || "", 'required maxlength="160"')}${area("Contenuto", "body", n?.body || "")}${select(
      "Cliente",
      "client_id",
      [["", "Nessun cliente"], ...state.clients.map((c) => [String(c.id), c.name])],
      n?.client_id || "",
    )}${select(
      "Progetto",
      "project_id",
      [["", "Nessun progetto"], ...state.projects.map((p) => [String(p.id), p.title])],
      n?.project_id || "",
    )}<div class="field full check-row"><label><input type="checkbox" name="pinned" ${n?.pinned ? "checked" : ""}>Fissa in cima all’elenco</label></div>${formBottom("Salva nota")}</form>`,
    async (d) => {
      await api("/api/notes", {
        ...(n ? { id: n.id } : {}),
        title: d.title,
        body: d.body,
        pinned: Boolean(d.pinned),
        client_id: d.client_id ? Number(d.client_id) : null,
        project_id: d.project_id ? Number(d.project_id) : null,
      });
      $("#modal").close();
      await refresh();
      toast("Nota salvata.");
    },
  );
}
function emailNoteModal(id) {
  const n = (state.notes || []).find((x) => x.id === Number(id));
  if (!n) return;
  const to = n.client_id ? client(n.client_id).email || "" : "";
  const sender = state.integrations?.sender || "";
  showModal(
    "Invia nota via email",
    `<form class="form-grid">${field("A", "to", "email", to, 'required placeholder="cliente@example.com"')}${field("Oggetto", "subject", "text", n.title, 'required maxlength="200"')}${area("Messaggio", "body", n.body)}<div class="field full"><p class="hint">${
      sender
        ? "Mittente: " + esc(sender)
        : "Nessun mittente collegato: aggiungilo in Impostazioni → Integrazioni per inviare email."
    }</p></div>${formBottom("Invia")}</form>`,
    async (d) => {
      await api("/api/email/send", { to: d.to, subject: d.subject, body: d.body });
      $("#modal").close();
      toast("Email inviata.");
    },
  );
}
function emailEventModal(id) {
  const e = eventsCache.find((x) => x.id === Number(id));
  if (!e) return;
  const sender = state.integrations?.sender || "";
  showModal(
    "Condividi evento via email",
    `<form class="form-grid">${field("A", "to", "email", "", 'required placeholder="cliente@example.com"')}${field("Oggetto", "subject", "text", e.title, 'required maxlength="200"')}${area(
      "Messaggio",
      "body",
      e.description || `Quando: ${timeLabel(e.start)} · Europe/Rome`,
    )}<div class="field full check-row"><label><input type="checkbox" name="with_ics" checked>Allega l’invito .ics</label></div><div class="field full"><p class="hint">${
      sender
        ? "Mittente: " + esc(sender)
        : "Nessun mittente collegato: aggiungilo in Impostazioni → Integrazioni per inviare email."
    }</p></div>${formBottom("Invia")}</form>`,
    async (d) => {
      const payload = { to: d.to, subject: d.subject, body: d.body };
      if (d.with_ics) payload.ics = { title: e.title, start: e.start, end: e.end };
      await api("/api/email/send", payload);
      $("#modal").close();
      toast("Email inviata.");
    },
  );
}
function eventModal(id, dateIso) {
  const e = id ? eventsCache.find((x) => x.id === Number(id)) : null;
  const start = e ? toLocalInput(e.start) : (dateIso || today()) + "T09:00";
  const end = e ? toLocalInput(e.end) : (dateIso || today()) + "T10:00";
  showModal(
    e ? "Modifica evento" : "Nuovo evento",
    `<form class="form-grid">${field("Titolo", "title", "text", e?.title || "", 'required maxlength="200"')}${field("Inizio", "start", "datetime-local", start, "required")}${field("Fine", "end", "datetime-local", end, "required")}${field("Luogo", "location", "text", e?.location || "", 'maxlength="300"')}${area("Descrizione", "description", e?.description || "")}${formBottom("Salva evento")}</form>`,
    async (d) => {
      await api("/api/events", {
        ...(e ? { id: e.id } : {}),
        title: d.title,
        start: new Date(d.start).toISOString(),
        end: new Date(d.end).toISOString(),
        location: d.location || null,
        description: d.description || null,
      });
      $("#modal").close();
      invalidateEvents();
      await loadPlannerEvents();
      toast("Evento salvato.");
    },
  );
}
function invalidateEvents() {
  eventsFrom = "";
  eventsTo = "";
}
async function loadPlannerEvents() {
  const y = plannerMonth.getFullYear(),
    m = plannerMonth.getMonth();
  const from = isoDate(new Date(y, m, 1));
  const to = isoDate(new Date(y, m + 1, 0));
  if (eventsFrom === from && eventsTo === to) return;
  try {
    const r = await api(`/api/events?from=${from}&to=${to}`);
    eventsCache = r.events;
    eventsFrom = from;
    eventsTo = to;
    if (route === "planner") renderContent();
  } catch (e) {
    report(e);
  }
}
function planner() {
  const integ = state.integrations || { google: {}, apple: {} };
  const y = plannerMonth.getFullYear(),
    m = plannerMonth.getMonth();
  const monthLabel = plannerMonth.toLocaleDateString("it-IT", {
    month: "long",
    year: "numeric",
  });
  const offset = (new Date(y, m, 1).getDay() + 6) % 7;
  const days = new Date(y, m + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < offset; i++)
    cells.push('<div class="day-cell other" aria-hidden="true"></div>');
  for (let d = 1; d <= days; d++) {
    const iso = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const evs = eventsCache.filter((e) => dayIso(e.start) === iso);
    cells.push(
      `<button type="button" class="day-cell${iso === selectedDay ? " selected" : ""}${iso === today() ? " today" : ""}" data-action="pick-day" data-id="${iso}" aria-label="${iso}"><span class="day-num">${d}</span>${evs
        .slice(0, 2)
        .map(
          (e) =>
            `<span class="event-chip" title="${esc(e.title)}">${timeLabel(e.start)} ${esc(e.title)}</span>`,
        )
        .join("")}${evs.length > 2 ? `<span class="more-chip">+${evs.length - 2} eventi</span>` : ""}</button>`,
    );
  }
  const dayEvents = eventsCache
    .filter((e) => dayIso(e.start) === selectedDay)
    .sort((a, b) => a.start.localeCompare(b.start));
  const nowIso = new Date().toISOString();
  const upcoming = eventsCache
    .filter((e) => String(e.end) >= nowIso)
    .sort((a, b) => a.start.localeCompare(b.start));
  const selectedLabel = new Date(selectedDay + "T00:00:00").toLocaleDateString(
    "it-IT",
    { weekday: "long", day: "numeric", month: "long" },
  );
  const chip = (cls, text) => `<span class="provider-chip ${cls}">${text}</span>`;
  return (
    title(
      "Il calendario al lavoro che conta.",
      "Vista mensile, planner e sincronizzazione con Google Calendar e Apple iCloud.",
      btn("+ Nuovo evento", "new-event", "", "primary"),
    ) +
    `<div class="sync-row">${chip(
      integ.google.connected ? "on" : "off",
      `Google Calendar ${integ.google.connected ? (integ.google.needs_reauth ? "· riautentica" : "· collegato") : "· non collegato"}`,
    )}${chip(
      integ.apple.connected ? "on" : "off",
      `Apple CalDAV ${integ.apple.connected ? "· collegato" : "· non collegato"}`,
    )}${integ.key_configured === false ? chip("warn", "INTEGRATIONS_KEY non configurata") : ""}<span class="hint">${
      integ.google.connected || integ.apple.connected
        ? "Sincronizza per aggiornare gli eventi dai provider."
        : "Collega Google o Apple in Impostazioni → Integrazioni per sincronizzare."
    }</span><span class="actions">${btn("Sincronizza ora", "planner-sync")}</span></div>` +
    `<div class="grid-two"><section class="panel"><div class="panel-head"><div class="month-head"><button type="button" class="month-nav" data-action="month-prev" aria-label="Mese precedente">‹</button><h2>${monthLabel}</h2><button type="button" class="month-nav" data-action="month-next" aria-label="Mese successivo">›</button></div>${btn("Oggi", "month-today", "", "secondary small")}</div><div class="month-grid">${["Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"]
      .map((w) => `<div class="wd">${w}</div>`)
      .join("")}${cells.join("")}</div></section>` +
    `<section class="panel"><div class="panel-head"><h2 class="day-title">${esc(selectedLabel)}</h2>${btn("+ Evento", "new-event", selectedDay, "secondary small")}</div><div class="panel-body">${
      dayEvents.length
        ? dayEvents
            .map(
              (e) =>
                `<div class="list-row"><div class="list-info"><strong>${esc(e.title)}</strong><small>${timeLabel(e.start)} → ${timeLabel(e.end)}${e.location ? " · " + esc(e.location) : ""}</small></div><div class="actions">${btn("Modifica", "edit-event", e.id)}${btn("Email", "event-email", e.id)}${btn("Elimina", "delete-event", e.id, "secondary small danger")}</div></div>`,
            )
            .join("")
        : '<p class="subtitle">Nessun evento in questo giorno.</p>'
    }</div></section></div>` +
    panel(
      "Eventi in programma",
      upcoming.length
        ? table(
            ["Quando", "Evento", ""],
            upcoming.map(
              (e) =>
                `<tr><td>${timeLabel(e.start)}</td><td><strong>${esc(e.title)}</strong><small>${esc(
                  excerpt(e.description || e.location || "", 80),
                )}</small></td><td><div class="actions">${btn("Apri", "edit-event", e.id)}${btn("Email", "event-email", e.id)}</div></td></tr>`,
            ),
          )
        : '<div class="panel-body"><p class="subtitle">Nessun evento futuro in questo mese.</p></div>',
    )
  );
}
function settingsView() {
  const s = state.settings;
  const integ = state.integrations || { google: {}, apple: {} };
  const chip = (cls, text) => `<span class="provider-chip ${cls}">${text}</span>`;
  const integChips = `<div class="sync-row">${chip(
    integ.google.connected ? "on" : "off",
    `Google ${integ.google.connected ? (integ.google.needs_reauth ? "· riautentica" : "· collegato") : "· non collegato"}`,
  )}${chip(
    integ.apple.connected ? "on" : "off",
    `Apple ${integ.apple.connected ? "· collegato" : "· non collegato"}`,
  )}<span class="hint">${
    integ.sender
      ? "Mittente email: " + esc(integ.sender)
      : "Nessun mittente email configurato."
  }</span></div>${
    integ.key_configured === false
      ? '<div class="callout"><strong>Configurazione mancante</strong><br>La variabile INTEGRATIONS_KEY non è presente nel file .env: le integrazioni restano disattivate finché non la aggiungi.</div>'
      : ""
  }`;
  const googleBlock = `<div class="section-gap"><h3>Google Calendar e Gmail</h3><p class="subtitle">${
    integ.google.connected
      ? "Sincronizzazione calendario attiva e inbox Gmail disponibile."
      : "Consente la sincronizzazione del calendario e la lettura dell'inbox Gmail."
  }</p><div class="actions">${btn(
    integ.google.needs_reauth ? "Riconnetti Google" : "Collega Google",
    "google-connect",
    "",
    "primary",
  )}</div><p class="hint">Ti verrà chiesto di autorizzare Calendar e Gmail (sola lettura per l'inbox). L'invio delle email avviene solo tramite Apple.</p></div>`;
  const appleBlock = `<div class="section-gap"><h3>Apple (iCloud)</h3><form id="apple-form" class="form-grid">${field(
    "Apple ID",
    "apple_id",
    "email",
    "",
    'placeholder="nome@icloud.com" autocomplete="username"',
  )}${field(
    "Password specifica per le app",
    "app_password",
    "password",
    "",
    `placeholder="${
      integ.apple.connected
        ? "Già salvata — per cambiarla inseriscine una nuova"
        : "xxxx-xxxx-xxxx-xxxx"
    }" autocomplete="new-password"`,
  )}${field(
    "Mittente email",
    "sender_email",
    "email",
    integ.sender || s.email || "",
    'placeholder="nome@icloud.com"',
  )}<div class="error" role="alert"></div><div class="form-actions"><button class="primary" type="submit">Salva collegamento Apple</button></div></form>${
    integ.apple.connected
      ? `<div class="actions section-gap">${btn("Disconnetti Apple", "apple-disconnect", "", "secondary small danger")}</div>`
      : ""
  }<p class="hint">Crea la password per le app su account.apple.com → Accesso e sicurezza. Serve per SMTP (invio) e IMAP (lettura) di iCloud; la password non viene mai riletta dal server.</p></div>`;
  return (
    title(
      "Un workspace che ti somiglia.",
      "Dati attività, parametri economici e disponibilità.",
    ) +
    `<form id="settings-form"><div class="settings-grid">${panel("Attività e fatturazione", `<div class="panel-body form-grid">${field("Nome attività", "business_name", "text", s.business_name, "required")}${field("Il tuo nome", "owner_name", "text", s.owner_name)}${field("Email attività", "email", "email", s.email)}${field("Partita IVA", "vat_number", "text", s.vat_number)}${field("Codice fiscale", "tax_code", "text", s.tax_code)}${field("IBAN", "iban", "text", s.iban)}${area("Indirizzo completo", "address", s.address)}${field("Dicitura aggiuntiva", "tax_label", "text", s.tax_label)}${field("IVA indicativa preventivi (%)", "vat_rate", "number", s.vat_rate, 'min="0" max="100" step="0.01" required')}${field("Tariffa oraria (€)", "hourly_rate", "number", s.hourly_rate, 'min="0" step="0.01" required')}<p class="hint">Partita IVA senza prefisso paese. Completa il profilo fiscale aziendale qui sotto: ogni fattura richiederà una verifica dedicata.</p></div>`)}${panel("Pagina di prenotazione", `<div class="panel-body form-grid">${field("Titolo dell’incontro", "booking_title", "text", s.booking_title, "required")}${field("Durata (minuti)", "booking_duration", "number", s.booking_duration, 'min="15" max="180" required')}${area("Presentazione", "booking_description", s.booking_description)}${field("Disponibile dalle (ora)", "booking_start", "number", s.booking_start, 'min="0" max="23" required')}${field("Alle (ora)", "booking_end", "number", s.booking_end, 'min="1" max="23" required')}${field("Preavviso minimo (ore)", "booking_notice", "number", s.booking_notice, 'min="0" max="720" required')}${field("Prenotabile entro (giorni)", "booking_horizon", "number", s.booking_horizon, 'min="1" max="180" required')}${field("Indirizzo pubblico (HTTPS)", "public_url", "url", s.public_url, 'placeholder="https://prenotazioni.esempio.it"')}<p class="hint">Indirizzo su cui i clienti aprono le prenotazioni, solo dominio senza percorso. Vuoto: il link usa l'indirizzo da cui stai navigando. «Pubblica prenotazioni.command» lo imposta automaticamente quando avvia il tunnel.</p><div class="field full"><label>Giorni disponibili · Europe/Rome</label><div class="check-row">${["Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"].map((t, i) => `<label><input type="checkbox" name="day" value="${i}" ${s.booking_days.includes(i) ? "checked" : ""}>${t}</label>`).join("")}</div></div><div class="field full check-row"><label><input type="checkbox" name="booking_enabled" ${s.booking_enabled ? "checked" : ""}>Accetta nuove prenotazioni</label></div></div>`)}</div>${fiscalSettings(s)}<div class="error" role="alert"></div><div class="form-actions"><button class="primary" type="submit">Salva impostazioni</button></div></form><div class="section-gap">${panel("I tuoi dati restano tuoi", `<div class="panel-body"><p class="subtitle">Esporta database e documenti in un archivio ZIP. Il backup contiene dati personali: conservalo in un luogo protetto.</p><div class="section-gap"><a class="button" href="/api/backup">Scarica backup completo ↓</a></div><p class="hint">Il ripristino è disponibile con lo strumento manage.py incluso nel progetto.</p></div>`)}</div><div class="section-gap">${panel(
      "Integrazioni",
      `<div class="panel-body">${integChips}${googleBlock}${appleBlock}</div>`,
    )}</div>`
  );
}
/* ------------------------------------------------------- messaggi e canali */
function conversationName(c) {
  return c.contact_name || c.contact || "Contatto";
}
function messagesView() {
  const channels = state.channels || [];
  const conversations = state.conversations || [];
  const actions = btn("Aggiorna", "refresh-inbox") + btn("Canali & AI", "open-channels");
  if (!channels.length) {
    return (
      title("Messaggi", "WhatsApp, Instagram e SMS in un'unica inbox.", actions) +
      empty(
        "messages",
        "Nessun canale collegato",
        "Collega WhatsApp, Instagram o un numero SMS: i messaggi arriveranno qui e l'assistente potrà rispondere da solo.",
        btn("Configura i canali", "open-channels", "", "primary"),
      )
    );
  }
  const list = conversations.length
    ? conversations
        .map(
          (c) =>
            `<button type="button" class="conv ${activeConversation === c.id ? "is-active" : ""}" data-action="open-conv" data-id="${c.id}"><span class="conv-top"><strong>${esc(conversationName(c))}</strong><time>${chatTime(c.last_message_at)}</time></span><span class="conv-sub">${esc(c.channel.provider_name)} · ${esc(c.preview || "Nessun messaggio")}</span>${c.unread ? `<b class="unread">${c.unread}</b>` : ""}</button>`,
        )
        .join("")
    : '<p class="hint">Nessuna conversazione: comparirà qui appena un cliente scrive.</p>';
  return (
    title("Messaggi", "WhatsApp, Instagram e SMS in un'unica inbox.", actions) +
    `<div class="inbox"><section class="conv-list"><div class="conv-list-head"><span>Conversazioni</span><a href="#channels">Canali →</a></div>${list}</section><section class="thread">${threadView()}</section></div>`
  );
}
function threadView() {
  if (!activeConversation)
    return `<div class="thread-empty"><strong>Scegli una conversazione</strong><p>Qui trovi la cronologia completa e puoi prendere in carico la risposta.</p></div>`;
  if (!threadCache) return `<div class="thread-empty">Caricamento della conversazione…</div>`;
  const { conversation, channel, messages } = threadCache;
  const rows = (messages || [])
    .map((m) => {
      const out = m.direction === "out";
      const author =
        m.author === "assistant"
          ? "Assistente"
          : m.author === "human"
            ? "Tu"
            : m.author === "system"
              ? "Sistema"
              : conversation.contact_name || "Cliente";
      return `<div class="bubble-row ${out ? "out" : "in"}"><div class="bubble ${out ? "out" : "in"} ${m.status === "failed" ? "failed" : ""}"><small>${esc(author)} · ${chatTime(m.created_at)}</small><p>${esc(m.body)}</p></div></div>`;
    })
    .join("");
  return `<div class="thread-head"><div><strong>${esc(conversationName(conversation))}</strong><small>${esc(channel.provider_name)} · ${esc(conversation.contact)}</small></div><div class="thread-actions"><label class="check-inline"><input type="checkbox" id="conv-auto" ${conversation.auto_reply ? "checked" : ""}> Auto-risposta</label>${conversation.status === "human" ? btn("Riprendi assistente", "conv-resume", conversation.id, "secondary small") : ""}</div></div><div class="thread-body">${rows || '<p class="hint">Nessun messaggio.</p>'}</div><form id="reply-form" class="composer"><textarea id="reply-text" rows="2" maxlength="4000" placeholder="Scrivi come titolare…" aria-label="Risposta"></textarea><button class="primary" type="submit">Invia</button></form>`;
}
async function loadThread(id) {
  try {
    threadCache = await api(`/api/conversations/${id}`);
    if (route === "messages") renderContent();
  } catch (e) {
    report(e);
  }
}
function channelChip(c) {
  if (!c) return '<span class="provider-chip off">Non collegato</span>';
  return `<span class="provider-chip ${c.status === "connected" ? "on" : "warn"}">${c.status === "connected" ? "Collegato" : "Da verificare"}</span>`;
}
function providerFields(provider, c, prefix) {
  const keep = (label) => `placeholder="${label}" autocomplete="off"`;
  if (provider === "whatsapp") {
    return (
      field("Access token", "access_token", "password", "", c ? keep("Già salvato — lascia vuoto per non cambiarlo") : 'required autocomplete="off"', prefix) +
      field("Phone number ID", "phone_number_id", "text", c?.external_id || "", c ? "" : "required", prefix) +
      field("App secret · firma webhook", "app_secret", "password", "", keep(c?.has_app_secret ? "Già salvato" : "consigliato"), prefix) +
      field("WABA ID (facoltativo)", "waba_id", "text", "", "", prefix) +
      field("Token di verifica webhook", "verify_token", "text", c?.verify_token || "", c ? "readonly" : 'placeholder="Generato automaticamente"', prefix)
    );
  }
  if (provider === "instagram") {
    return (
      field("Access token della Pagina", "access_token", "password", "", c ? keep("Già salvato — lascia vuoto per non cambiarlo") : 'required autocomplete="off"', prefix) +
      field("ID account Instagram", "ig_user_id", "text", c?.external_id || "", c ? "" : "required", prefix) +
      field("App secret · firma webhook", "app_secret", "password", "", keep(c?.has_app_secret ? "Già salvato" : "consigliato"), prefix) +
      field("Token di verifica webhook", "verify_token", "text", c?.verify_token || "", c ? "readonly" : 'placeholder="Generato automaticamente"', prefix)
    );
  }
  return (
    field("Account SID", "account_sid", "text", c ? "" : "", c ? keep("AC… già salvato") : 'required placeholder="AC…"', prefix) +
    field("Auth token", "auth_token", "password", "", c ? keep("Già salvato — lascia vuoto per non cambiarlo") : 'required autocomplete="off"', prefix) +
    field("Numero mittente", "from", "tel", c?.external_id || "", 'required placeholder="+393331234567"', prefix)
  );
}
function channelCard(p) {
  const c = (state.channels || []).find((x) => x.provider === p.id);
  const webhook = `${location.origin}${p.webhook}`;
  return panel(
    p.name,
    `<div class="panel-body provider-card"><div class="sync-row">${channelChip(c)}${c && c.detail ? `<span class="hint">${esc(c.detail)}</span>` : ""}</div>${c?.last_error ? `<div class="error">${esc(c.last_error)}</div>` : ""}<form id="channel-form-${p.id}" data-channel="${p.id}" class="form-grid">${c ? `<input type="hidden" name="id" value="${c.id}">` : ""}${field("Etichetta", "label", "text", c?.label || p.name, "", p.id)}${providerFields(p.id, c, p.id)}<div class="field full check-row"><label><input type="checkbox" name="auto_reply" ${!c || c.auto_reply ? "checked" : ""}>Risposta automatica su questo canale</label></div><div class="error" role="alert"></div><div class="form-actions"><button class="primary" type="submit">${c ? "Aggiorna e verifica" : "Collega"}</button>${c ? btn("Verifica", "channel-verify", c.id) : ""}${c ? btn("Disconnetti", "channel-delete", c.id, "secondary small danger") : ""}</div></form><div class="webhook-box"><span>Webhook URL</span><code>${esc(webhook)}</code><button type="button" class="secondary small" data-action="copy-webhook" data-provider="${p.id}">Copia</button></div>${c ? `<div class="test-row"><input id="test-to-${p.id}" aria-label="Destinatario di prova" placeholder="${p.id === "instagram" ? "IGSID del destinatario" : "+39…"}"><button type="button" class="secondary small" data-action="channel-test" data-id="${c.id}" data-provider="${p.id}">Invia test</button></div>` : ""}<p class="hint">${p.hint}</p></div>`,
  );
}
function channelsView() {
  const a = state.assistant || {};
  const k = state.knowledge || { docs: [], chars: 0, trained_at: "" };
  const providers = [
    {
      id: "whatsapp",
      name: "WhatsApp Business",
      webhook: "/api/webhooks/whatsapp",
      hint: "Meta → WhatsApp → Configurazione API: copia Phone number ID e un token permanente. In Configuration → Webhook incolla l'URL qui sopra e lo stesso token di verifica, poi iscriviti al campo messages.",
    },
    {
      id: "instagram",
      name: "Instagram",
      webhook: "/api/webhooks/instagram",
      hint: "Serve un account professionale collegato a una Pagina Facebook e un'app Meta con instagram_basic e instagram_manage_messages. Webhook sull'oggetto instagram, campo messages.",
    },
    {
      id: "sms",
      name: "SMS · Twilio",
      webhook: "/api/webhooks/sms",
      hint: "Twilio → Numbers → Messaging: incolla l'URL in «A message comes in» (metodo POST). Il mittente deve essere un numero acquistato o verificato; ogni SMS ha un costo.",
    },
  ];
  const assistantForm = `<form id="assistant-form"><div class="panel-body form-grid">${field("Nome dell'assistente", "assistant_name", "text", a.name || "")}${select("Tono", "assistant_tone", [["professionale", "Professionale"], ["amichevole", "Amichevole"], ["diretto", "Diretto"], ["formale", "Formale"]], a.tone || "professionale")}${select("Lingua", "assistant_language", [["auto", "Lingua del cliente"], ["it", "Italiano"], ["en", "Inglese"]], a.language || "auto")}${field("Lunghezza massima risposta", "assistant_max_chars", "number", a.max_chars || 700, 'min="200" max="2000" step="1"')}${field("Firma (facoltativa)", "assistant_signature", "text", a.signature || "")}${field("Email per i casi da gestire a mano", "assistant_handoff_email", "email", a.handoff_email || "")}${field("Sito da cui apprendere", "assistant_site_url", "url", a.site_url || "", `placeholder="${location.origin}"`)}${field("Modello", "assistant_model", "text", a.model || "gpt-4o-mini")}${field("Base URL OpenAI-compatibile", "assistant_base_url", "url", a.base_url || "https://api.openai.com/v1")}${field("Chiave API (salvata cifrata)", "api_key", "password", "", `placeholder="${a.key_configured ? "Già salvata — incolla una nuova per cambiarla" : "sk-…"}" autocomplete="off"`)}${area("Istruzioni aggiuntive", "assistant_notes", a.notes || "")}<div class="field full check-row"><label><input type="checkbox" name="assistant_enabled" ${a.enabled ? "checked" : ""}>Risposta automatica attiva sui canali</label><label><input type="checkbox" name="remove_key">Rimuovi la chiave salvata</label></div><div class="error" role="alert"></div><div class="form-actions"><button class="primary" type="submit">Salva assistente</button></div></div></form>`;
  const knowledgePanel = `<div class="panel-body"><p class="subtitle">L'assistente usa solo ciò che trova qui: le pagine del sito e la scheda attività costruita dalle impostazioni. Aggiorna dopo ogni modifica a servizi, prezzi o orari.</p><div class="sync-row"><span class="provider-chip ${k.trained_at ? "on" : "off"}">${k.trained_at ? "Aggiornato il " + esc(k.trained_at.slice(0, 10)) : "Mai aggiornato"}</span><span class="hint">${(k.docs || []).length} fonti · ${k.chars || 0} caratteri</span></div><div class="actions section-gap">${btn("Aggiorna conoscenza dal sito", "train-assistant", "", "primary")}${btn("Apri il sito", "open-site")}</div><div id="train-result" class="hint"></div><ul class="doc-list">${(k.docs || []).map((d) => `<li><strong>${esc(d.title)}</strong><small>${esc(d.url)} · ${d.chars} caratteri</small></li>`).join("") || "<li><small>Nessuna fonte raccolta: premi il pulsante per leggere il sito.</small></li>"}</ul></div>`;
  const playground = `<div class="panel-body"><p class="subtitle">Simula un messaggio di un cliente: usa la conoscenza raccolta e non invia nulla.</p><form id="assistant-test-form"><div class="field full"><label for="assistant-test-text">Messaggio del cliente</label><textarea id="assistant-test-text" name="text" rows="3" required placeholder="Ciao, fate anche manutenzione di siti esistenti?"></textarea></div><div class="error" role="alert"></div><div class="form-actions"><button class="primary" type="submit">Genera risposta</button></div></form><div id="assistant-test-result" class="assistant-result" aria-live="polite"></div></div>`;
  return (
    title("Canali & AI", "Collega WhatsApp, Instagram e SMS e addestra l'assistente sulla tua attività.", btn("Apri inbox", "open-inbox")) +
    `<div class="callout"><strong>Come funziona</strong><br>Collega un canale, incolla l'URL del webhook nel pannello del provider e premi «Aggiorna conoscenza dal sito». Da quel momento l'assistente risponde con le informazioni della tua attività e tu vedi tutto in Messaggi.</div>` +
    panel("Assistente AI", assistantForm) +
    `<div class="section-gap">${panel("Auto-apprendimento dal sito", knowledgePanel)}</div>` +
    `<div class="section-gap provider-grid">${providers.map(channelCard).join("")}</div>` +
    `<div class="section-gap">${panel("Prova l'assistente", playground)}</div>`
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
  if ($("#apple-form"))
    $("#apple-form").onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target,
        d = Object.fromEntries(new FormData(f));
      const b = $("[type=submit]", f);
      b.disabled = true;
      $(".error", f).textContent = "";
      try {
        await api("/api/integrations/apple", d);
        await refresh();
        toast("Collegamento Apple salvato.");
      } catch (err) {
        $(".error", f).textContent = err.message;
      } finally {
        b.disabled = false;
      }
    };
  $$("form[data-channel]").forEach((form) => {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      const d = Object.fromEntries(new FormData(f));
      d.provider = f.dataset.channel;
      d.auto_reply = Boolean(f.auto_reply?.checked);
      if (d.id) d.id = Number(d.id);
      const submit = $("[type=submit]", f);
      submit.disabled = true;
      $(".error", f).textContent = "";
      try {
        const res = await api("/api/channels", d);
        await refresh();
        const v = res.verification;
        toast(
          v
            ? v.ok
              ? "Canale collegato e verificato."
              : "Canale salvato, ma la verifica non è riuscita: " + v.error
            : "Canale salvato.",
        );
      } catch (err) {
        $(".error", f).textContent = err.message;
      } finally {
        submit.disabled = false;
      }
    };
  });
  if ($("#assistant-form"))
    $("#assistant-form").onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      const d = Object.fromEntries(new FormData(f));
      d.assistant_enabled = Boolean(f.assistant_enabled?.checked);
      d.remove_key = Boolean(f.remove_key?.checked);
      const submit = $("[type=submit]", f);
      submit.disabled = true;
      $(".error", f).textContent = "";
      try {
        await api("/api/assistant", d);
        await refresh();
        toast("Assistente aggiornato.");
      } catch (err) {
        $(".error", f).textContent = err.message;
      } finally {
        submit.disabled = false;
      }
    };
  if ($("#assistant-test-form"))
    $("#assistant-test-form").onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      const text = $("#assistant-test-text").value.trim();
      const box = $("#assistant-test-result");
      if (!text) return;
      const submit = $("[type=submit]", f);
      submit.disabled = true;
      $(".error", f).textContent = "";
      box.innerHTML = '<p class="hint">L’assistente sta scrivendo…</p>';
      try {
        const res = await api("/api/assistant/preview", { text });
        box.innerHTML = `<div class="bubble out"><small>${esc(res.model)}</small><p>${esc(res.reply)}</p></div><p class="hint">Fonti: ${(res.sources || []).map((s) => esc(s.title)).join(" · ") || "scheda attività"}</p>`;
      } catch (err) {
        box.innerHTML = `<p class="error">${esc(err.message)}</p>`;
      } finally {
        submit.disabled = false;
      }
    };
  if ($("#reply-form"))
    $("#reply-form").onsubmit = async (e) => {
      e.preventDefault();
      const text = $("#reply-text").value.trim();
      if (!text) return;
      const submit = $("[type=submit]", e.target);
      submit.disabled = true;
      try {
        await api("/api/conversations/reply", { id: activeConversation, body: text });
        threadCache = null;
        await refresh();
        toast("Messaggio inviato.");
      } catch (err) {
        report(err);
      } finally {
        submit.disabled = false;
      }
    };
  if ($("#conv-auto"))
    $("#conv-auto").onchange = async (e) => {
      const wanted = e.target.checked;
      try {
        await api("/api/conversations/state", { id: activeConversation, auto_reply: wanted });
        threadCache = null;
        await refresh();
        toast(wanted ? "Auto-risposta attiva." : "Auto-risposta sospesa.");
      } catch (err) {
        e.target.checked = !wanted;
        report(err);
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
  if (a === "menu-open") return setMenu(true);
  if (a === "menu-close") return setMenu(false);
  if (a === "menu-toggle") return setMenu(!document.body.classList.contains("drawer-open"));
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
    if (a === "open-channels") {
      location.hash = "channels";
      return;
    }
    if (a === "open-inbox") {
      location.hash = "messages";
      return;
    }
    if (a === "open-site") {
      window.open("/", "_blank", "noopener");
      return;
    }
    if (a === "open-conv") {
      activeConversation = Number(id);
      threadCache = null;
      renderContent();
      return loadThread(activeConversation);
    }
    if (a === "refresh-inbox") {
      threadCache = null;
      await refresh();
      return toast("Inbox aggiornata.");
    }
    if (a === "train-assistant") {
      b.disabled = true;
      const site = ($("#f-assistant_site_url")?.value || "").trim();
      const box = $("#train-result");
      if (box) box.textContent = "Lettura del sito in corso…";
      try {
        const r = await api("/api/assistant/train", site ? { site_url: site } : {});
        await refresh();
        toast(`Conoscenza aggiornata: ${r.pages} pagine, ${r.chars} caratteri.`);
      } catch (e) {
        if (box) box.textContent = e.message;
        report(e);
      } finally {
        b.disabled = false;
      }
      return;
    }
    if (a === "copy-webhook") {
      await navigator.clipboard.writeText(`${location.origin}/api/webhooks/${b.dataset.provider}`);
      return toast("URL del webhook copiato.");
    }
    if (a === "channel-verify") {
      b.disabled = true;
      try {
        const r = await api("/api/channels/verify", { id: Number(id) });
        await refresh();
        toast(
          r.verification.ok
            ? `Verificato: ${r.verification.detail || "collegamento attivo"}`
            : `Verifica non riuscita: ${r.verification.error}`,
        );
      } catch (e) {
        report(e);
      } finally {
        b.disabled = false;
      }
      return;
    }
    if (a === "channel-delete")
      return confirmAction(
        "Scollegare il canale?",
        "Verranno eliminate anche le conversazioni e i messaggi di questo canale. I token salvati saranno rimossi.",
        async () => {
          await api("/api/channels/delete", { id: Number(id) });
          activeConversation = null;
          threadCache = null;
          await refresh();
          toast("Canale scollegato.");
        },
      );
    if (a === "channel-test") {
      const provider = b.dataset.provider;
      const to = ($(`#test-to-${provider}`)?.value || "").trim();
      if (!to) return toast("Inserisci il destinatario del messaggio di prova.");
      b.disabled = true;
      try {
        await api("/api/channels/test", { id: Number(id), to });
        toast("Messaggio di prova inviato.");
      } catch (e) {
        report(e);
      } finally {
        b.disabled = false;
      }
      return;
    }
    if (a === "conv-resume") {
      await api("/api/conversations/state", { id: Number(id), status: "open" });
      threadCache = null;
      await refresh();
      return toast("Assistente riattivato sulla conversazione.");
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
    if (a === "google-connect") {
      b.disabled = true;
      try {
        const r = await api("/api/integrations/google/connect");
        location.assign(r.url);
      } catch (e) {
        report(e);
        b.disabled = false;
      }
      return;
    }
    if (a === "apple-disconnect") {
      await api("/api/integrations/apple/delete", {});
      await refresh();
      return toast("Apple disconnesso.");
    }
    if (a === "new-note") return noteModal();
    if (a === "edit-note") return noteModal(id);
    if (a === "email-note") return emailNoteModal(id);
    if (a === "event-email") return emailEventModal(id);
    if (a === "pin-note") {
      const n = (state.notes || []).find((x) => x.id === Number(id));
      if (!n) return;
      await api("/api/notes", {
        id: n.id,
        title: n.title,
        body: n.body,
        pinned: !n.pinned,
        client_id: n.client_id,
        project_id: n.project_id,
      });
      await refresh();
      return toast(n.pinned ? "Nota sbloccata." : "Nota fissata in cima.");
    }
    if (a === "delete-note")
      return confirmAction(
        "Eliminare la nota?",
        "La nota verrà rimossa definitivamente.",
        async () => {
          await api("/api/notes/delete", { id: Number(id) });
          await refresh();
          toast("Nota eliminata.");
        },
      );
    if (a === "new-event") return eventModal(undefined, id || undefined);
    if (a === "edit-event") return eventModal(id);
    if (a === "delete-event")
      return confirmAction(
        "Eliminare l’evento?",
        "L’evento sparirà dal calendario e, alla prossima sincronizzazione, anche dai provider collegati.",
        async () => {
          await api("/api/events/delete", { id: Number(id) });
          invalidateEvents();
          await loadPlannerEvents();
          toast("Evento eliminato.");
        },
      );
    if (a === "pick-day") {
      selectedDay = id;
      return renderContent();
    }
    if (a === "month-prev" || a === "month-next") {
      plannerMonth = new Date(
        plannerMonth.getFullYear(),
        plannerMonth.getMonth() + (a === "month-next" ? 1 : -1),
        1,
      );
      invalidateEvents();
      renderContent();
      return loadPlannerEvents();
    }
    if (a === "month-today") {
      plannerMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
      selectedDay = today();
      invalidateEvents();
      renderContent();
      return loadPlannerEvents();
    }
    if (a === "planner-sync") {
      b.disabled = true;
      try {
        const r = await api("/api/sync/calendar", {});
        await refresh();
        invalidateEvents();
        await loadPlannerEvents();
        const msg = `Google: ${r.google.pulled} importati, ${r.google.sent} inviati · Apple: ${r.apple.pulled} importati, ${r.apple.sent} inviati${
          r.errors.length
            ? " — " + r.errors.slice(0, 2).join("; ") + (r.errors.length > 2 ? "…" : "")
            : ""
        }`;
        return toast("Sincronizzazione completata. " + msg);
      } finally {
        b.disabled = false;
      }
    }
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
    `<main class="booking"><div class="brand"><img class="brand-mark" src="/assets/logo-realindi.png" alt="" width="32" height="32">${esc(info.business_name)}</div><div class="booking-card"><section class="booking-info"><div class="eyebrow">Facciamo il primo passo</div><h1>${esc(info.booking_title)}</h1><p>${esc(info.booking_description)}</p><p><strong>${info.booking_duration} minuti</strong><br>Fuso orario: Europe/Rome</p><p class="hint">I dati inseriti vengono utilizzati per gestire l’appuntamento e sono visibili al professionista.</p></section><section class="booking-content" id="booking-content"></section></div><p class="booking-footer">Prenotazioni · ${esc(info.business_name)}</p></main>`;
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
    const qs = new URLSearchParams(location.search);
    if (qs.get("view") === "settings") location.hash = "#settings";
    if (qs.get("linked") === "google")
      pendingToast = "Google collegato: ora puoi sincronizzare il calendario.";
    if ([...qs.keys()].length)
      history.replaceState(null, "", location.pathname);
    const s = await api("/api/session");
    if (!s.authenticated) return auth(s.setup);
    await refresh();
  } catch (e) {
    $("#root").innerHTML =
      '<div class="empty"><strong>Impossibile caricare il workspace</strong><p>' +
      esc(e.message) +
      '</p><a href="/app">Riprova</a></div>';
  }
})();
