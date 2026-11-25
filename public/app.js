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

// Theme toggle initialization.
// Controllo del tema condiviso con le viste: la pagina di accesso lo applica in
// modo "transitorio" (segue il sistema e non memorizza il clic), il workspace
// invece ripristina la preferenza salvata.
const themeControl = {
  transient: false,
  apply() {},
  useSystem() {},
  restore() {},
};

// Il bottone è nel guscio disegnato da render(), quindi qui si prepara solo il
// tema sulla radice e si ascolta il click per delega: al caricamento il bottone
// non esiste ancora.
(function initThemeToggle() {
  const root = document.documentElement;
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let transitionTimer = null;

  function startTransition() {
    if (reducedMotion.matches) return;
    root.classList.add("theme-transition");
    window.clearTimeout(transitionTimer);
    transitionTimer = window.setTimeout(
      () => root.classList.remove("theme-transition"),
      320
    );
  }

  function applyTheme(theme) {
    root.classList.toggle("dark-mode", theme === "dark");
    root.classList.toggle("light-mode", theme === "light");
    const button = document.getElementById("theme-toggle");
    if (button) button.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
  }

  themeControl.apply = applyTheme;
  themeControl.useSystem = () => applyTheme(media.matches ? "dark" : "light");
  themeControl.restore = () =>
    applyTheme(localStorage.getItem("theme") || (media.matches ? "dark" : "light"));

  themeControl.restore();

  document.addEventListener("click", (event) => {
    const button = event.target.closest && event.target.closest("#theme-toggle");
    if (!button) return;
    const next = root.classList.contains("dark-mode") ? "light" : "dark";
    // Sul login la scelta vale per la visita: niente localStorage, così la
    // pagina continua a seguire il sistema al prossimo accesso.
    if (!themeControl.transient) localStorage.setItem("theme", next);
    startTransition();
    applyTheme(next);
  });

  media.addEventListener("change", (event) => {
    if (!localStorage.getItem("theme")) {
      applyTheme(event.matches ? "dark" : "light");
    }
  });
})();
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
  channels: "Canali",
  tools: "Strumenti",
  security: "Sicurezza",
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
  tools:
    "M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1 M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1 M3 3h6v6H3z M15 15h6v6h-6z",
  security: "M5 11h14v10H5z M8 11V7a4 4 0 0 1 8 0v4 M12 15v2",
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
// Riga fissa sotto il campo password: il link per creare la password per le app
// serve prima di poterla inserire, non solo quando il valore è già sbagliato.
const APPLE_PASSWORD_HINT =
  '<p class="hint">Serve una password per le app, non quella dell\'ID Apple: ' +
  '<a href="https://account.apple.com/account/manage" target="_blank" rel="noopener noreferrer">' +
  "creala su account.apple.com</a> → Accesso e sicurezza → Password per le app.</p>";

// Form di collegamento Apple: avviso sulla forma della password mentre si scrive,
// conferma esplicita prima di inviare un valore che Apple rifiuterebbe.
function bindAppleForm(formApple) {
    const bottoneApple = $("[type=submit]", formApple);
    const etichettaApple = "Salva collegamento Apple";
    // Le password per le app sono xxxx-xxxx-xxxx-xxxx: se il valore non ha quella
    // forma è quasi sempre la password dell'ID Apple, che Apple rifiuta.
    const passwordApp = /^[a-z]{4}(-[a-z]{4}){3}$/;
    const testoAvviso =
      "Attenzione: una password per le app ha la forma xxxx-xxxx-xxxx-xxxx (16 lettere " +
      "in quattro gruppi). Questa sembra la password dell'ID Apple e Apple la rifiuterà. " +
      "Se non l'hai ancora creata, prima va attivata l'autenticazione a due fattori su " +
      "account.apple.com.";
    const avvisoPassword = () => {
      let p = $(".apple-password-warning", formApple);
      if (!p) {
        p = document.createElement("p");
        p.className = "hint apple-password-warning";
        p.hidden = true;
        $(".error", formApple).before(p);
      }
      return p;
    };
    const formaSbagliata = () => {
      const valore = String($("[name=app_password]", formApple)?.value ?? "").trim();
      return Boolean(valore) && !passwordApp.test(valore);
    };
    // Aggiornamento live: si aggancia all'input, non solo all'invio.
    const aggiornaAvviso = () => {
      const sbagliata = formaSbagliata();
      const p = avvisoPassword();
      p.hidden = !sbagliata;
      p.textContent = sbagliata ? testoAvviso : "";
      if (!sbagliata) {
        delete formApple.dataset.confermaPassword;
        bottoneApple.textContent = etichettaApple;
      }
    };
    $("[name=app_password]", formApple)?.addEventListener("input", aggiornaAvviso);
    formApple.onsubmit = async (e) => {
      e.preventDefault();
      const f = formApple;
      const d = Object.fromEntries(new FormData(f));
      const b = bottoneApple;
      if (formaSbagliata() && f.dataset.confermaPassword !== "1") {
        // L'avviso è già a schermo mentre scriveva: qui si chiede la conferma.
        aggiornaAvviso();
        avvisoPassword().textContent = testoAvviso + " Premi di nuovo per inviare comunque.";
        f.dataset.confermaPassword = "1";
        b.textContent = "Invia comunque";
        return;
      }
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
        b.textContent = etichettaApple;
        // Un invio fallito non deve lasciare la conferma attiva per il tentativo dopo.
        delete f.dataset.confermaPassword;
      }
    };
}

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
/**
 * Riquadro del solo login: la password è salvata come hash, quindi non si
 * recupera e non arriva via email. La via è il comando sul computer del
 * gestionale, e va detto che non è una procedura remota.
 */
const RECUPERO_PASSWORD =
  '<details class="hint auth-recovery">' +
  "<summary>Password dimenticata?</summary>" +
  "<p>Se hai salvato uno dei codici di emergenza mostrati al setup (o all'ultima " +
  "reimpostazione), incollalo nel campo password: entra come la password, ma una " +
  "volta sola. Altrimenti " +
  "va reimpostata dal computer dove gira il gestionale, con doppio clic su " +
  "<strong>Reimposta password.command</strong> (oppure con " +
  "<code>npm run password:reimposta</code>): chiede la nuova password, chiude le " +
  "sessioni aperte e sblocca i tentativi falliti, senza toccare clienti, documenti " +
  "e fatture. Non è una procedura remota.</p>" +
  "</details>";

/**
 * Codici di emergenza appena generati: esistono solo in questa risposta, quindi
 * si mostrano una volta con un pulsante per copiarli e uno per entrare. Nel
 * database ne restano gli hash e ogni uso ne consuma uno, quindi se si perdono
 * si rigenerano con il comando di reset.
 */
function mostraEmergenza(codici) {
  $("#auth-form").closest(".auth-form").innerHTML =
    '<div class="eyebrow">Workspace creato</div>' +
    "<h1>Salva i codici di emergenza.</h1>" +
    `<p class="subtitle">Sono ${codici.length} e ognuno entra al posto della password una volta sola, senza terminale né accesso al database. Non vengono mostrati di nuovo.</p>` +
    `<ol class="codice-lista">${codici.map((c) => `<li><code>${esc(c)}</code></li>`).join("")}</ol>` +
    '<div class="actions"><button type="button" class="secondary" id="emergenza-copia">Copia tutti</button>' +
    '<button type="button" class="primary" id="emergenza-entra">L’ho salvato, entra</button></div>' +
    '<p class="hint">Conservali nel gestore password accanto alla password. Se li perdi, «Reimposta password.command» ne genera altri.</p>';
  $("#emergenza-copia").onclick = async () => {
    try {
      await navigator.clipboard.writeText(codici.join("\n"));
      $("#emergenza-copia").textContent = "Copiati";
    } catch {
      // Senza permesso per gli appunti resta il testo a schermo, da copiare a mano.
      $("#emergenza-copia").textContent = "Copia a mano";
    }
  };
  $("#emergenza-entra").onclick = () => refresh();
}

function auth(setup) {
  themeControl.transient = true;
  themeControl.useSystem();
  $("#root").innerHTML =
    `<div class="auth-page"><button type="button" class="theme-toggle auth-theme" id="theme-toggle" aria-label="Cambia tema" aria-pressed="${document.documentElement.classList.contains("dark-mode")}"><svg class="theme-icon-sun" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg><svg class="theme-icon-moon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg></button><section class="auth-story"><div class="brand"><img class="brand-mark" src="/assets/logo-realindi.png" alt="" width="32" height="32"> REALINDI</div><div><div class="eyebrow">Un solo posto. Tutto il tuo lavoro.</div><h1>Più spazio ai progetti.<br>Meno alla burocrazia.</h1><p>Clienti, proposte, documenti e appuntamenti. Il workspace pensato per il tuo lavoro indipendente.</p></div><small>REALINDI SYSTEMS · Freelancer workspace</small></section><section class="auth-form"><div class="brand"><img class="brand-mark" src="/assets/logo-realindi.png" alt="" width="32" height="32"> REALINDI</div><div class="eyebrow">Il tuo nuovo punto di partenza</div><h1>${setup ? "Crea il tuo workspace" : "Bentornato nel workspace"}</h1><p class="subtitle">${setup ? "Scegli la password per proteggere clienti e documenti." : "Accedi per riprendere da dove avevi lasciato."}</p><form id="auth-form">${field("Password", "password", "password", "", 'required minlength="12" maxlength="256" autocomplete="' + (setup ? "new-password" : "current-password") + '"')}${setup ? field("Ripeti password", "confirm", "password", "", 'required minlength="12" autocomplete="new-password"') : RECUPERO_PASSWORD}<div class="error" role="alert"></div><button class="primary" type="submit">${setup ? "Crea workspace" : "Accedi al workspace"} →</button><p class="hint">${setup ? "Almeno 12 caratteri. I dati vengono conservati nella cartella locale del progetto." : "Sessione privata · accesso protetto"}</p></form></section></div>`;
  $("#auth-form").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target,
      d = Object.fromEntries(new FormData(f));
    $("button", f).disabled = true;
    try {
      if (setup && d.password !== d.confirm)
        throw new Error("Le password non coincidono.");
      const res = await api(setup ? "/api/setup" : "/api/login", d);
      // I codici di emergenza arrivano solo in questa risposta: si mostrano
      // subito, perché dopo non sono più recuperabili.
      if (setup && res?.codici?.length) return mostraEmergenza(res.codici);
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
  themeControl.transient = false;
  themeControl.restore();
  if (!labels[route]) {
    route = "dashboard";
    if (location.hash) history.replaceState(null, "", "#dashboard");
  }
  $("#root").innerHTML =
    `<div class="shell"><div class="drawer-scrim" data-action="menu-close" aria-hidden="true"></div><button type="button" class="drawer-tab" data-action="menu-open" aria-controls="crm-menu" aria-expanded="false" aria-label="Apri il menu"><span aria-hidden="true">‹</span></button><aside class="sidebar" id="crm-menu"><button type="button" class="drawer-close" data-action="menu-close" aria-label="Chiudi il menu">×</button><a class="brand" href="#dashboard"><img class="brand-mark" src="/assets/logo-realindi.png" alt="" width="32" height="32"> REALINDI</a><div class="brand-sub">FREELANCER WORKSPACE</div><div class="nav-label">WORKSPACE</div><nav class="nav" aria-label="Menu principale">${["dashboard", "messages", "clients", "projects", "quotes", "invoices", "ricevute", "documents", "calendar", "planner", "notes", "tools", "channels", "security"].map((k) => k === "ricevute" ? `<a href="/ricevute">${icon("invoices")}Ricevute</a>` : `<a href="#${k}" class="${route === k ? "active" : ""}" ${route === k ? 'aria-current="page"' : ""}>${icon(k)}${labels[k]}</a>`).join("")}</nav><div class="sidebar-bottom"><div class="nav-label">IL TUO BUSINESS, IN ORDINE.</div><div class="account"><span class="avatar">${esc((state.settings.owner_name || "RS").slice(0, 2).toUpperCase())}</span><div>${esc(state.settings.owner_name || "Il tuo workspace")}<small>Consulente indipendente</small></div></div></div></aside><main class="main"><header class="topbar"><div class="topbar-head"><a class="back-site" href="/">Torna al sito</a><div class="crumb">Workspace <span>/ &nbsp; ${labels[route]}</span></div></div><div class="top-right"><button type="button" class="agent-launch" data-action="agent-open" aria-controls="buffy-panel" aria-expanded="false"><span class="agent-launch-mark" aria-hidden="true">B</span><span class="agent-launch-label">Buffy</span></button><span class="local-status"><i class="status-dot"></i>Archivio locale</span>${btn("Esci", "logout", "", "secondary small")}<button type="button" class="theme-toggle" id="theme-toggle" aria-label="Cambia tema" aria-pressed="${document.documentElement.classList.contains("dark-mode")}"><svg class="theme-icon-sun" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg><svg class="theme-icon-moon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg></button><button type="button" class="nav-toggle" data-action="menu-toggle" aria-controls="crm-menu" aria-expanded="false" aria-label="Apri il menu"><span class="nav-toggle-bars" aria-hidden="true"></span></button></div></header><div class="content" id="content"></div></main></div>`;
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
    tools: toolsView,
    messages: messagesView,
    channels: channelsView,
    security: securityView,
  };
  $("#content").innerHTML = views[route]();
  if (route === "dashboard" && (!state.settings.tax_regime || !state.settings.vat_number)) {
    $("#content").insertAdjacentHTML("afterbegin", '<div class="callout"><strong>Configura la tua azienda</strong><br>Inserisci dati fiscali e preferenze di fatturazione prima di generare il primo XML. <button type="button" class="link-button" data-action="agent-open">Chiedi a Buffy →</button></div>');
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
    `<div class="callout">Ogni fattura richiede la verifica dei dati aziendali e del trattamento fiscale. L'XML viene validato e numerato; se la PEC è collegata in Impostazioni, il file parte subito verso lo SdI e le ricevute aggiornano lo stato.</div>` +
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
    `<div class="grid-two">${panel("Il tuo link di prenotazione", `<div class="panel-body"><p class="subtitle">${esc(state.settings.booking_title)} · ${state.settings.booking_duration} minuti</p><p class="link-box">${esc(bookingUrl())}</p><div class="actions">${btn("Copia link", "copy-booking")}<button type="button" class="link-button" data-action="agent-open">Chiedi a Buffy →</button></div><p class="hint">${online ? "Link pubblico attivo: puoi condividerlo con i clienti. Funziona finché server e tunnel restano attivi." : "Questo link funziona solo su questo computer. Apri «Pubblica prenotazioni.command» per un indirizzo HTTPS condivisibile, oppure chiedi a Buffy di inserirlo."}</p></div>`)}${panel("Periodi non disponibili", `<div class="panel-body">${state.blocks.length ? state.blocks.map((b) => `<div class="list-row"><div class="list-info"><strong>${esc(b.reason || "Non disponibile")}</strong><small>${timeLabel(b.start)} → ${timeLabel(b.end)}</small></div>${btn("Rimuovi", "delete-block", b.id)}</div>`).join("") : '<p class="subtitle">Nessuna assenza impostata.</p>'}<div class="section-gap">${btn("+ Blocca un periodo", "new-block")}</div></div>`)}</div>` +
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
        : "Nessun mittente collegato: configura Apple in Canali → Integrazioni."
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
        : "Nessun mittente collegato: configura Apple in Canali → Integrazioni."
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
        : "Collega Google o Apple da Canali → Integrazioni per sincronizzare."
    }</span><span class="actions">${btn("Sincronizza ora", "planner-sync")}${btn("Integrazioni", "open-channels")}</span></div>` +
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
/**
 * Cambio password dall'app. Sta in una pagina sua e non nelle vecchie
 * Impostazioni: quella pagina non è più nel menu da quando il titolare
 * configura il workspace parlando con Buffy, e un pannello lì non sarebbe
 * raggiungibile.
 */
/**
 * Codici di emergenza appena generati (setup, cambio password, rigenerazione):
 * esistono solo in questa risposta, quindi si mostrano una volta con un pulsante
 * per copiarli. Nel database ne restano gli hash.
 */
function mostraCodici(codici, sottotitolo = "Ognuno entra al posto della password una volta sola. Non vengono mostrati di nuovo.") {
  showModal(
    "Codici di emergenza",
    `<p class="subtitle">${esc(sottotitolo)}</p><ol class="codice-lista">${codici
      .map((c) => `<li><code>${esc(c)}</code></li>`)
      .join("")}</ol><p class="hint">Conservali nel gestore password accanto alla password. I codici precedenti non valgono più.</p><div class="actions"><button type="button" class="secondary" data-action="copia-codici">Copia tutti</button><button type="button" class="primary" data-action="close">Fatto</button></div>`,
  );
}

/** Etichetta breve del browser di una sessione: il resto dell'user agent non dice niente. */
function browserLabel(ua) {
  const t = String(ua || "");
  if (/Edg\//.test(t)) return "Edge";
  if (/OPR\//.test(t)) return "Opera";
  if (/Chrome\//.test(t)) return "Chrome";
  if (/Firefox\//.test(t)) return "Firefox";
  if (/Safari\//.test(t)) return "Safari";
  return t ? "Browser" : "Browser sconosciuto";
}

/** Avviso quando l'ultimo accesso arriva da un IP mai visto prima. */
function avvisoAccesso() {
  const ultimo = (state.accessi || [])[0];
  if (!ultimo || !ultimo.nuovo) return "";
  return `<div class="callout"><strong>Ultimo accesso da un indirizzo nuovo</strong><br>${esc(
    ultimo.ip,
  )} · ${timeLabel(ultimo.at)}. Se non eri tu, cambia la password qui sotto.</div>`;
}

function securityView() {
  const accessi = state.accessi || [];
  const sessioni = state.sessioni || [];
  const codici = Number(state.codici_emergenza || 0);
  return (
    title("Accesso al workspace.", "La password che protegge clienti, documenti e fatture.") +
    panel(
      "Cambia password",
      `<div class="panel-body">${avvisoAccesso()}<form id="password-form" class="form-grid">${field(
        "Password attuale",
        "current",
        "password",
        "",
        'required maxlength="256" autocomplete="current-password"',
      )}${field(
        "Nuova password",
        "password",
        "password",
        "",
        'required minlength="12" maxlength="256" autocomplete="new-password"',
      )}${field(
        "Ripeti la nuova password",
        "confirm",
        "password",
        "",
        'required minlength="12" maxlength="256" autocomplete="new-password"',
      )}<div class="error" role="alert"></div><div class="form-actions"><button class="primary" type="submit">Cambia password</button></div></form><p class="hint">Almeno 12 caratteri. Cambiandola si chiudono le sessioni aperte sugli altri dispositivi; questa resta attiva. Se non ricordi quella attuale puoi incollare uno dei codici di emergenza: in quel caso il codice viene consumato. Senza password e senza codici, usa «Reimposta password.command» dal computer del gestionale.</p></div>`,
    ) +
    panel(
      "Codici di emergenza",
      `<div class="panel-body"><p class="subtitle">${
        codici
          ? `${codici} codici monouso ancora validi: ognuno entra una volta sola, senza terminale.`
          : "Nessun codice valido: se dimentichi la password devi reimpostarla dal computer del gestionale."
      }</p><div class="actions">${btn(
        "Genera nuovi codici",
        "nuovi-codici",
        "",
        codici ? "secondary" : "primary",
      )}</div><p class="hint">Rigenerarli invalida quelli attuali; i nuovi compaiono una volta sola, subito dopo.</p></div>`,
    ) +
    panel(
      "Sessioni attive",
      `<div class="panel-body">${
        sessioni.length
          ? sessioni
              .map(
                (s) =>
                  `<div class="list-row"><div class="list-info"><strong>${esc(
                    s.ip || "IP sconosciuto",
                  )} · ${browserLabel(s.user_agent)}</strong><small>aperta ${timeLabel(
                    (s.created_at || s.last_seen) * 1000,
                  )} · ultimo uso ${timeLabel(s.last_seen * 1000)}</small></div>${
                    s.corrente
                      ? '<span class="pill">questa sessione</span>'
                      : btn("Disconnetti", "revoca-sessione", s.id)
                  }</div>`,
              )
              .join("")
          : '<p class="subtitle">Nessuna sessione attiva.</p>'
      }${sessioni.length > 1 ? `<div class="section-gap">${btn("Disconnetti le altre sessioni", "revoca-altre")}</div>` : ""}<p class="hint">Una sessione dura dodici ore. Chiuderla qui la rende inutile subito, anche se il cookie è già sul dispositivo.</p></div>`,
    ) +
    panel(
      "Accessi recenti",
      `<div class="panel-body">${
        accessi.length
          ? accessi
              .map(
                (a) =>
                  `<div class="list-row"><div class="list-info"><strong>${timeLabel(
                    a.at,
                  )}</strong><small>${esc(a.ip)} · ${
                    a.via === "codice" ? "codice di emergenza" : "password"
                  }</small></div>${
                    a.nuovo ? '<span class="pill">nuovo indirizzo</span>' : ""
                  }</div>`,
              )
              .join("")
          : '<p class="subtitle">Nessun accesso registrato.</p>'
      }<p class="hint">Gli ultimi accessi riusciti, dal più recente: data, IP e credenziale usata. Gli errori non vengono registrati.</p></div>`,
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
  )}</div><p class="hint">Ti verrà chiesto di autorizzare Calendar e i contatti (e Gmail, se attivi l'inbox). L'invio delle email avviene solo tramite Apple.</p></div>`;
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
  )}${APPLE_PASSWORD_HINT}${field(
    "Mittente email",
    "sender_email",
    "email",
    integ.sender || s.email || "",
    'placeholder="nome@icloud.com"',
  )}<div class="error" role="alert"></div><div class="form-actions"><button class="primary" type="submit">Salva collegamento Apple</button></div></form>${
    integ.apple.connected
      ? `<div class="actions section-gap">${btn("Disconnetti Apple", "apple-disconnect", "", "secondary small danger")}</div>`
      : ""
  }<p class="hint">Serve per SMTP (invio) e IMAP (lettura) di iCloud; la password non viene mai riletta dal server.</p></div>`;
  return (
    title(
      "Un workspace che ti somiglia.",
      "Dati attività, parametri economici e disponibilità.",
    ) +
    `<form id="settings-form"><div class="settings-grid">${panel("Attività e fatturazione", `<div class="panel-body form-grid">${field("Nome attività", "business_name", "text", s.business_name, "required")}${field("Il tuo nome", "owner_name", "text", s.owner_name)}${field("Email attività", "email", "email", s.email)}${field("Partita IVA", "vat_number", "text", s.vat_number)}${field("Codice fiscale", "tax_code", "text", s.tax_code)}${field("IBAN", "iban", "text", s.iban)}${area("Indirizzo completo", "address", s.address)}${field("Dicitura aggiuntiva", "tax_label", "text", s.tax_label)}${field("IVA indicativa preventivi (%)", "vat_rate", "number", s.vat_rate, 'min="0" max="100" step="0.01" required')}${field("Tariffa oraria (€)", "hourly_rate", "number", s.hourly_rate, 'min="0" step="0.01" required')}<p class="hint">Partita IVA senza prefisso paese. Completa il profilo fiscale aziendale qui sotto: ogni fattura richiederà una verifica dedicata.</p></div>`)}${panel("Pagina di prenotazione", `<div class="panel-body form-grid">${field("Titolo dell’incontro", "booking_title", "text", s.booking_title, "required")}${field("Durata (minuti)", "booking_duration", "number", s.booking_duration, 'min="15" max="180" required')}${area("Presentazione", "booking_description", s.booking_description)}${field("Disponibile dalle (ora)", "booking_start", "number", s.booking_start, 'min="0" max="23" required')}${field("Alle (ora)", "booking_end", "number", s.booking_end, 'min="1" max="23" required')}${field("Preavviso minimo (ore)", "booking_notice", "number", s.booking_notice, 'min="0" max="720" required')}${field("Prenotabile entro (giorni)", "booking_horizon", "number", s.booking_horizon, 'min="1" max="180" required')}${field("Indirizzo pubblico (HTTPS)", "public_url", "url", s.public_url, 'placeholder="https://prenotazioni.esempio.it"')}<p class="hint">Indirizzo su cui i clienti aprono le prenotazioni, solo dominio senza percorso. Vuoto: il link usa l'indirizzo da cui stai navigando. «Pubblica prenotazioni.command» lo imposta automaticamente quando avvia il tunnel.</p><div class="field full"><label>Giorni disponibili · Europe/Rome</label><div class="check-row">${["Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"].map((t, i) => `<label><input type="checkbox" name="day" value="${i}" ${s.booking_days.includes(i) ? "checked" : ""}>${t}</label>`).join("")}</div></div><div class="field full check-row"><label><input type="checkbox" name="booking_enabled" ${s.booking_enabled ? "checked" : ""}>Accetta nuove prenotazioni</label></div></div>`)}</div>${fiscalSettings(s)}<div class="error" role="alert"></div><div class="form-actions"><button class="primary" type="submit">Salva impostazioni</button></div></form>${sdiSettingsPanel(state.sdi)}<div class="section-gap">${panel("I tuoi dati restano tuoi", `<div class="panel-body"><p class="subtitle">Esporta database e documenti in un archivio ZIP. Il backup contiene dati personali: conservalo in un luogo protetto.</p><div class="section-gap"><a class="button" href="/api/backup">Scarica backup completo ↓</a></div><p class="hint">Il ripristino è disponibile con lo strumento manage.py incluso nel progetto.</p></div>`)}</div><div class="section-gap">${panel(
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
  const actions = btn("Aggiorna", "refresh-inbox") + btn("Canali", "open-channels");
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
function integrationsPanel() {
  const integ = state.integrations || {};
  const googleState = integ.google || {};
  const appleState = integ.apple || {};
  const s = state.settings || {};
  const googleOn = Boolean(googleState.connected);
  const appleOn = Boolean(appleState.connected);
  const chips = `<div class="sync-row"><span class="provider-chip ${googleOn ? "on" : "off"}">Google ${googleOn ? (googleState.needs_reauth ? "· riautentica" : "· collegato") : "· non collegato"}</span><span class="provider-chip ${appleOn ? "on" : "off"}">Apple ${appleOn ? "· collegato" : "· non collegato"}</span><span class="hint">${integ.sender ? "Mittente email: " + esc(integ.sender) : "Nessun mittente email configurato."}</span></div>${integ.key_configured === false ? '<div class="callout"><strong>Configurazione mancante</strong><br>La variabile INTEGRATIONS_KEY non è presente nel file .env: le integrazioni restano disattivate finché non la aggiungi.</div>' : ""}`;
  const googleBlock = panel(
    "Google Calendar e Gmail",
    `<div class="panel-body"><p class="subtitle">${googleOn ? "Calendario sincronizzato e inbox Gmail disponibile." : "Consente la sincronizzazione del calendario e la lettura dell'inbox Gmail."}</p><div class="actions">${btn(googleOn ? "Riconnetti Google" : "Collega Google", "google-connect", "", "primary")}</div><p class="hint">Ti verrà chiesto di autorizzare Calendar e Gmail (sola lettura per l'inbox). Al ritorno tornerai su Canali.</p></div>`,
  );
  const appleBlock = panel(
    "Apple iCloud",
    `<div class="panel-body"><form id="apple-form" class="form-grid">${field("Apple ID", "apple_id", "email", "", 'placeholder="nome@icloud.com" autocomplete="username"')}${field("Password specifica per le app", "app_password", "password", "", `placeholder="${appleOn ? "Già salvata — per cambiarla inseriscine una nuova" : "xxxx-xxxx-xxxx-xxxx"}" autocomplete="new-password"`)}${APPLE_PASSWORD_HINT}${field("Mittente email", "sender_email", "email", integ.sender || s.email || "", 'placeholder="nome@icloud.com"')}<div class="error" role="alert"></div><div class="form-actions"><button class="primary" type="submit">Salva collegamento Apple</button></div></form>${appleOn ? `<div class="actions section-gap">${btn("Disconnetti Apple", "apple-disconnect", "", "secondary small danger")}</div>` : ""}<p class="hint">Serve per SMTP (invio) e IMAP (lettura) di iCloud; la password non viene mai riletta dal server.</p></div>`,
  );
  return panel(
    "Integrazioni",
    `<div class="panel-body">${chips}<div class="settings-grid">${googleBlock}${appleBlock}</div><p class="hint">Il mittente email usa iCloud. Per WhatsApp, Instagram e SMS usa le schede dei canali qui sotto.</p>${googleOn || appleOn ? `<div class="actions section-gap">${btn("Sincronizza ora", "planner-sync")}<a href="#planner">Apri calendario →</a></div>` : ""}</div>`,
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
  const assistantForm = `<form id="assistant-form"><div class="panel-body form-grid">${field("Nome dell'assistente", "assistant_name", "text", a.name || "")}${select("Tono", "assistant_tone", [["professionale", "Professionale"], ["amichevole", "Amichevole"], ["diretto", "Diretto"], ["formale", "Formale"]], a.tone || "professionale")}${select("Lingua", "assistant_language", [["auto", "Lingua del cliente"], ["it", "Italiano"], ["en", "Inglese"]], a.language || "auto")}${field("Lunghezza massima risposta", "assistant_max_chars", "number", a.max_chars || 700, 'min="200" max="2000" step="1"')}${field("Firma (facoltativa)", "assistant_signature", "text", a.signature || "")}${field("Email per i casi da gestire a mano", "assistant_handoff_email", "email", a.handoff_email || "")}${field("Sito da cui apprendere", "assistant_site_url", "url", a.site_url || "", `placeholder="${location.origin}"`)}${field("Modello", "assistant_model", "text", a.model || "deepseek-v4.1-flash")}${field("Base URL OpenAI-compatibile", "assistant_base_url", "url", a.base_url || "https://freebuff.com/api/v1/paid")}${field("Chiave API (salvata cifrata)", "api_key", "password", "", `placeholder="${a.key_configured ? "Già salvata — incolla una nuova per cambiarla" : "sk-…"}" autocomplete="off"`)}${area("Istruzioni aggiuntive", "assistant_notes", a.notes || "")}<div class="field full check-row"><label><input type="checkbox" name="assistant_enabled" ${a.enabled ? "checked" : ""}>Risposta automatica attiva sui canali</label><label><input type="checkbox" name="remove_key">Rimuovi la chiave salvata</label></div><div class="error" role="alert"></div><div class="form-actions"><button class="primary" type="submit">Salva assistente</button></div></div></form>`;
  const knowledgePanel = `<div class="panel-body"><p class="subtitle">L'assistente usa solo ciò che trova qui: le pagine del sito e la scheda attività costruita dalle impostazioni. Aggiorna dopo ogni modifica a servizi, prezzi o orari.</p><div class="sync-row"><span class="provider-chip ${k.trained_at ? "on" : "off"}">${k.trained_at ? "Aggiornato il " + esc(k.trained_at.slice(0, 10)) : "Mai aggiornato"}</span><span class="hint">${(k.docs || []).length} fonti · ${k.chars || 0} caratteri</span></div><div class="actions section-gap">${btn("Aggiorna conoscenza dal sito", "train-assistant", "", "primary")}${btn("Apri il sito", "open-site")}</div><div id="train-result" class="hint"></div><ul class="doc-list">${(k.docs || []).map((d) => `<li><strong>${esc(d.title)}</strong><small>${esc(d.url)} · ${d.chars} caratteri</small></li>`).join("") || "<li><small>Nessuna fonte raccolta: premi il pulsante per leggere il sito.</small></li>"}</ul></div>`;
  const playground = `<div class="panel-body"><p class="subtitle">Simula un messaggio di un cliente: usa la conoscenza raccolta e non invia nulla.</p><form id="assistant-test-form"><div class="field full"><label for="assistant-test-text">Messaggio del cliente</label><textarea id="assistant-test-text" name="text" rows="3" required placeholder="Ciao, fate anche manutenzione di siti esistenti?"></textarea></div><div class="error" role="alert"></div><div class="form-actions"><button class="primary" type="submit">Genera risposta</button></div></form><div id="assistant-test-result" class="assistant-result" aria-live="polite"></div></div>`;
  return (
    title("Canali", "WhatsApp, Instagram e SMS, con Google Calendar, Apple iCloud e mittente email.", btn("Apri inbox", "open-inbox")) +
    `<div class="callout"><strong>Canali e integrazioni</strong><br>Configura WhatsApp, Instagram e SMS nelle schede qui sotto; Google Calendar, Apple iCloud e il mittente email nel pannello Integrazioni. Per il gestionale usa Buffy.</div>` +
    `<div id="limiti-avviso" class="limiti-avviso" role="status" aria-live="polite" hidden></div>` +
    panel("Buffy, assistente operativo", `<div class="panel-body"><p class="subtitle">Legge clienti, progetti, preventivi, fatture, documenti, appuntamenti, note e ricevute. Può preparare modifiche da applicare con la tua conferma.</p><div class="actions"><button type="button" class="primary" data-action="agent-open">Apri Buffy</button></div></div>`) +
    `<div class="section-gap">${integrationsPanel()}</div>` +
    `<div class="section-gap provider-grid">${providers.map(channelCard).join("")}</div>`
  );
}
/* Strumenti: QR personalizzati (con foto al centro) e link brevi. */
const shortUrl = (slug) => `${location.origin}/l/${slug}`;
function toolsView() {
  const tools = state.tools || { links: [], qr: [] };
  return (
    title(
      "QR e link, pronti da condividere.",
      "Codici con qualsiasi contenuto interno e la tua foto al centro, più indirizzi brevi con il conteggio dei clic.",
      btn("+ Nuovo QR", "new-qr", "", "primary") + btn("+ Nuovo link", "new-link"),
    ) +
    `<div class="grid-two">${panel(
      "Link brevi",
      tools.links.length
        ? `<div>${tools.links.map(shortLinkRow).join("")}</div>`
        : empty(
            "tools",
            "Nessun link breve",
            "Accorcia un indirizzo e condividilo: ogni clic viene contato.",
          ),
    )}${panel(
      "QR personalizzati",
      tools.qr.length
        ? `<div class="panel-body"><div class="note-grid qr-grid">${tools.qr.map(qrCard).join("")}</div></div>`
        : empty(
            "tools",
            "Nessun QR salvato",
            "Crea un codice con un testo, un contatto o un link, e la tua foto al centro.",
          ),
    )}</div>` +
    `<p class="hint">I link brevi rispondono su questo indirizzo: ${esc(location.origin)}/l/… — chi apre il link viene reindirizzato alla destinazione.</p>`
  );
}
function shortLinkRow(l) {
  const visite = l.unique_visits === 1 ? "1 visita unica" : `${l.unique_visits} visite uniche`;
  return `<div class="list-row link-row"><div class="list-info"><strong>${esc(l.label || l.target)}</strong><small>${esc(shortUrl(l.slug))} · ${l.clicks} clic · ${visite}${l.active ? "" : " · disattivato"}</small><small>${esc(l.target)}</small></div><div class="actions">${btn("Copia", "copy-link", l.id)}${btn("QR", "link-qr", l.id)}${btn("Modifica", "edit-link", l.id)}${btn("Elimina", "delete-link", l.id, "secondary small danger")}</div></div>`;
}
/** Indirizzo del link breve, se esiste ancora. */
function shortUrlForLink(id) {
  const l = (state.tools?.links || []).find((x) => x.id === Number(id));
  return l ? shortUrl(l.slug) : "";
}
/** Contenuto effettivo del QR: l'indirizzo del link breve, se è dinamico. */
function qrPayload(item) {
  if (item && item.link_id) return shortUrlForLink(item.link_id) || String(item.payload || "");
  return String(item?.payload || "");
}
function qrCard(item) {
  const content = qrPayload(item);
  return `<article class="note-card qr-card"><canvas class="qr-canvas" data-qr-thumb="${item.id}" width="256" height="256" role="img" aria-label="Anteprima del QR ${esc(item.title)}"></canvas><div class="note-head"><h3>${esc(item.title)}</h3><div>${item.link_id ? '<span class="pill">Link breve</span> ' : ""}${item.has_logo ? '<span class="pill confirmed">Foto</span>' : ""}</div></div><p>${esc(content ? excerpt(content, 90) : "Il link collegato non esiste più: apri il QR per scegliere un nuovo contenuto.")}</p><p class="hint">${esc(item.foreground)} · ${esc(item.background)} · correzione ${esc(item.ecc)}</p><div class="actions note-actions">${btn("Apri", "edit-qr", item.id)}${btn("Elimina", "delete-qr", item.id, "secondary small danger")}</div></article>`;
}
// La matrice arriva dal server (una stringa di 0/1 per riga) e il disegno
// avviene qui: colori, foto al centro e PNG ad alta risoluzione senza servizi
// esterni. Le matrici identiche si riusano mentre si cambiano i colori.
const qrCache = new Map();
async function qrMatrixFor(payload, ecc) {
  const key = `${ecc}\n${payload}`;
  if (qrCache.has(key)) return qrCache.get(key);
  const data = await api("/api/tools/qr/render", { payload, ecc });
  if (qrCache.size > 40) qrCache.clear();
  qrCache.set(key, data);
  return data;
}
function imageFromSrc(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}
function dataUrlFromFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Impossibile leggere l'immagine."));
    reader.readAsDataURL(file);
  });
}
async function paintQr(canvas, opts) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  const quiet = 4;
  const payload = String(opts.payload || "").trim();
  let matrix = null;
  let error = "";
  if (!payload) {
    error = "Scrivi il contenuto per vedere l'anteprima.";
  } else {
    try {
      matrix = await qrMatrixFor(payload, opts.ecc || "H");
    } catch (err) {
      error = err.message;
    }
  }
  if (!matrix) {
    // Quadro vuoto invece di un codice vecchio rimasto a schermo.
    canvas.width = canvas.height = 256;
    ctx.clearRect(0, 0, 256, 256);
    return error;
  }
  const modules = matrix.size + quiet * 2;
  const scale = Math.max(1, Math.floor((opts.pixels || 320) / modules));
  const side = modules * scale;
  canvas.width = canvas.height = side;
  ctx.fillStyle = opts.background || "#ffffff";
  ctx.fillRect(0, 0, side, side);
  ctx.fillStyle = opts.foreground || "#111111";
  matrix.rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] === "1") ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
    }
  });
  if (opts.logo && opts.logo.width && opts.logo.height) {
    const box = Math.round(side * 0.24);
    const pad = Math.round(box * 0.1);
    const left = Math.round((side - box) / 2);
    ctx.fillStyle = opts.background || "#ffffff";
    ctx.fillRect(left - pad, left - pad, box + pad * 2, box + pad * 2);
    const ratio = Math.min(box / opts.logo.width, box / opts.logo.height);
    const w = opts.logo.width * ratio;
    const h = opts.logo.height * ratio;
    ctx.drawImage(opts.logo, left + (box - w) / 2, left + (box - h) / 2, w, h);
  }
  return "";
}
function qrFormValues() {
  const f = $("#modal form");
  if (!f) return null;
  const value = (name) => f.querySelector(`[name="${name}"]`)?.value ?? "";
  return {
    id: value("id") ? Number(value("id")) : null,
    title: value("title"),
    payload: value("payload"),
    foreground: value("foreground") || "#111111",
    background: value("background") || "#ffffff",
    ecc: value("ecc") || "H",
    link_id: value("link_id"),
    file: f.logo_file?.files?.[0] || null,
    removeLogo: Boolean(f.remove_logo?.checked),
  };
}
/** Con un link scelto il QR contiene quell'indirizzo, non il testo di riserva. */
function qrValuesPayload(values) {
  return (values.link_id && shortUrlForLink(values.link_id)) || values.payload;
}
async function qrLogoImage(values) {
  if (!values || values.removeLogo) return null;
  if (values.file) return imageFromSrc(await dataUrlFromFile(values.file));
  const item = values.id ? (state.tools?.qr || []).find((x) => x.id === values.id) : null;
  return item?.has_logo ? imageFromSrc(`/api/tools/qr/${item.id}/logo`) : null;
}
function qrPreview() {
  const canvas = $("#qr-preview-canvas");
  if (!canvas) return;
  clearTimeout(qrPreview.timer);
  // Le anteprime possono sovrapporsi mentre si scrive: conta solo l'ultima.
  const token = (qrPreview.token = (qrPreview.token || 0) + 1);
  qrPreview.timer = setTimeout(async () => {
    const values = qrFormValues();
    if (!values) return;
    const logo = await qrLogoImage(values);
    const error = await paintQr(canvas, { ...values, payload: qrValuesPayload(values), logo, pixels: 512 });
    const hint = $("#qr-hint");
    if (!hint || token !== qrPreview.token) return;
    hint.textContent =
      error ||
      (logo
        ? "Foto al centro attiva: con la correzione alta il codice resta leggibile."
        : "Il PNG scaricato conserva colori e foto.");
  }, 250);
}
async function downloadQr() {
  const values = qrFormValues();
  if (!values) return;
  const payload = qrValuesPayload(values);
  if (!payload.trim()) return toast("Scrivi il contenuto del QR o scegli un link breve.");
  const canvas = document.createElement("canvas");
  const logo = await qrLogoImage(values);
  const error = await paintQr(canvas, { ...values, payload, logo, pixels: 1024 });
  if (error) return toast(error);
  const name =
    (values.title || "qr")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "qr";
  const link = document.createElement("a");
  link.href = canvas.toDataURL("image/png");
  link.download = `${name}.png`;
  link.click();
  toast("QR scaricato in PNG.");
}
function linkModal(id) {
  const l = id ? (state.tools?.links || []).find((x) => x.id === Number(id)) : null;
  showModal(
    l ? "Modifica link breve" : "Nuovo link breve",
    `<form class="form-grid">${field("Etichetta", "label", "text", l?.label || "", 'maxlength="120" placeholder="Listino, portfolio…"')}${field("Destinazione", "target", "text", l?.target || "", 'required maxlength="2000" placeholder="https://esempio.it/pagina"')}${field("Slug (facoltativo)", "slug", "text", l?.slug || "", 'maxlength="40" placeholder="generato in automatico"')}<div class="field full check-row"><label><input type="checkbox" name="active" ${l && !l.active ? "" : "checked"}>Link attivo</label></div><p class="hint">La destinazione può essere un indirizzo https:// o un percorso interno (/…). Lo slug usa lettere minuscole, numeri e trattini.</p>${formBottom(l ? "Salva link" : "Crea link")}</form>`,
    async (d) => {
      await api("/api/tools/links", { ...d, id: l?.id, active: Boolean(d.active) });
      await saved(l ? "Link aggiornato." : "Link creato.");
    },
  );
}
function qrModal(id, preset) {
  const item = id ? (state.tools?.qr || []).find((x) => x.id === Number(id)) : null;
  const clientOptions = state.clients.length
    ? [...state.clients]
        .sort((a, b) => String(a.name).localeCompare(String(b.name)))
        .map((c) => `<option value="${c.id}">${esc(c.name + (c.company ? " · " + c.company : ""))}</option>`)
        .join("")
    : '<option value="">Nessun cliente</option>';
  const projectOptions = state.projects.length
    ? [...state.projects]
        .sort((a, b) => String(a.title).localeCompare(String(b.title)))
        .map((p) => `<option value="${p.id}">${esc(p.title)}</option>`)
        .join("")
    : '<option value="">Nessun progetto</option>';
  showModal(
    item ? "Modifica QR" : "Nuovo QR personalizzato",
    `<form class="form-grid">${item ? `<input type="hidden" name="id" value="${item.id}">` : ""}${field("Nome del QR", "title", "text", item?.title ?? preset?.title ?? "", 'required maxlength="120" placeholder="Scheda cliente, listino…"')}${select("Punta a", "link_id", [["", "Contenuto libero"], ...(state.tools?.links || []).map((l) => [String(l.id), `${l.label || l.slug} — /l/${l.slug}`])], item?.link_id ? String(item.link_id) : preset?.link_id ? String(preset.link_id) : "")}<p class="hint">Con un link breve il QR contiene quell'indirizzo: se cambi la destinazione del link il codice resta valido e non va ristampato. Il testo qui sotto, in quel caso, fa da riserva.</p>${area("Contenuto del QR", "payload", item?.payload ?? preset?.payload ?? "")}<div class="field full"><label>Dati dal gestionale</label><div class="actions"><select id="f-qr-client" aria-label="Cliente">${clientOptions}</select>${btn("Usa cliente", "qr-fill-client")}<select id="f-qr-project" aria-label="Progetto">${projectOptions}</select>${btn("Usa progetto", "qr-fill-project")}</div><p class="hint">Il contatto entra come vCard, il progetto come riepilogo. Il testo resta modificabile.</p></div>${field("Colore del codice", "foreground", "color", item?.foreground || "#111111")}${field("Sfondo", "background", "color", item?.background || "#ffffff")}${select("Correzione errori", "ecc", [["H", "Alta (consigliata con foto)"], ["Q", "Media"], ["M", "Bassa"], ["L", "Minima"]], item?.ecc || "H")}<div class="field full"><label for="f-qr-logo">Foto al centro (PNG, JPG o WebP, max 300 KB)</label><input id="f-qr-logo" name="logo_file" type="file" accept="image/png,image/jpeg,image/webp"></div>${item?.has_logo ? '<div class="field full check-row"><label><input type="checkbox" name="remove_logo">Rimuovi la foto attuale</label></div>' : ""}<div class="field full"><div class="qr-layout"><canvas class="qr-canvas" id="qr-preview-canvas" width="512" height="512" role="img" aria-label="Anteprima del QR"></canvas><div><p class="hint" id="qr-hint"></p><button type="button" class="secondary" data-action="qr-download">Scarica PNG</button></div></div></div>${formBottom(item ? "Salva QR" : "Crea QR")}</form>`,
    async (d, form) => {
      const file = form.logo_file?.files?.[0] || null;
      let logoData;
      if (file) {
        if (file.size > 300 * 1024) throw new Error("La foto è troppo grande: massimo 300 KB.");
        logoData = await dataUrlFromFile(file);
      }
      await api("/api/tools/qr", {
        ...d,
        id: item?.id,
        link_id: d.link_id || null,
        logo_data: logoData,
        remove_logo: form.remove_logo?.checked === true,
      });
      await saved(item ? "QR aggiornato." : "QR creato.");
    },
  );
  const form = $("#modal form");
  if (form) {
    form.oninput = qrPreview;
    form.onchange = qrPreview;
    if (form.logo_file) form.logo_file.onchange = qrPreview;
  }
  qrPreview();
}
function clientVcard(c) {
  const lines = ["BEGIN:VCARD", "VERSION:3.0", `FN:${c.name}`];
  if (c.company) lines.push(`ORG:${c.company}`);
  if (c.phone) lines.push(`TEL:${c.phone}`);
  if (c.email) lines.push(`EMAIL:${c.email}`);
  if (c.address) lines.push(`ADR:;;${c.address}`);
  if (c.vat_number) lines.push(`X-VAT:${c.vat_number}`);
  lines.push("END:VCARD");
  return lines.join("\n");
}
function projectPayload(p) {
  const c = client(p.client_id);
  return [
    `Progetto: ${p.title}`,
    `Cliente: ${c.name || "—"}`,
    c.company ? `Azienda: ${c.company}` : "",
    `Stato: ${labels[p.status] || p.status || "—"}`,
    p.deadline ? `Scadenza: ${p.deadline}` : "",
    p.description ? `\n${p.description}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
/** Riempe il contenuto del QR con i dati di un cliente o di un progetto aperti nell'editor. */
function qrFill(fromClient) {
  const c = fromClient ? client($("#f-qr-client")?.value) : null;
  const p = fromClient ? null : project($("#f-qr-project")?.value);
  if (fromClient && !c.id) return toast("Non c'è ancora un cliente da usare.");
  if (!fromClient && !p.id) return toast("Non c'è ancora un progetto da usare.");
  const target = $("#modal [name=payload]");
  if (target) target.value = fromClient ? clientVcard(c) : projectPayload(p);
  qrPreview();
}
function bindView() {
  $$("[data-height]").forEach(
    (b) => (b.style.height = b.dataset.height + "px"),
  );
  // Anteprime dei QR salvati: si disegnano dopo il markup, con la stessa
  // funzione usata dall'editor, così colore e foto sono quelli salvati.
  $$("[data-qr-thumb]").forEach((canvas) => {
    const item = (state.tools?.qr || []).find((x) => x.id === Number(canvas.dataset.qrThumb));
    if (!item) return;
    (async () => {
      const logo = item.has_logo ? await imageFromSrc(`/api/tools/qr/${item.id}/logo`) : null;
      await paintQr(canvas, { ...item, payload: qrPayload(item), logo, pixels: 320 });
    })();
  });
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
  if ($("#sdi-form"))
    $("#sdi-form").onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target,
        d = Object.fromEntries(new FormData(f));
      d.secure = f.secure.checked;
      const b = $("[type=submit]", f);
      b.disabled = true;
      try {
        await api("/api/sdi/config", d);
        await refresh();
        toast("PEC salvata.");
      } catch (err) {
        $(".error", f).textContent = err.message;
      } finally {
        b.disabled = false;
      }
    };
  if ($("#password-form"))
    $("#password-form").onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target,
        d = Object.fromEntries(new FormData(f)),
        errore = $(".error", f);
      if (d.password !== d.confirm) {
        errore.textContent = "Le password non coincidono.";
        return;
      }
      const b = $("[type=submit]", f);
      b.disabled = true;
      errore.textContent = "";
      try {
        const res = await api("/api/password", { current: d.current, password: d.password });
        f.reset();
        await refresh();
        toast("Password aggiornata: le altre sessioni sono state chiuse.");
        if (res?.codici?.length) {
          mostraCodici(
            res.codici,
            "Password aggiornata. Questi sono i nuovi codici di emergenza: quelli di prima non valgono più.",
          );
        }
      } catch (err) {
        errore.textContent = err.message;
      } finally {
        b.disabled = false;
      }
    };
  if ($("#apple-form")) bindAppleForm($("#apple-form"));
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
  const avvisoLimiti = $("#limiti-avviso");
  if (avvisoLimiti) window.mountLimitiAssistente?.(avvisoLimiti);
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
  )}${isInvoice && record.snapshot.fiscal ? fiscalPrint(record) : `<div class="totals"><div><span>Imponibile</span><b>${money(record.subtotal)}</b></div><div><span>IVA ${esc(isInvoice ? record.snapshot.vat_rate : record.vat_rate)}%</span><b>${money(record.vat)}</b></div><div class="grand"><span>Totale</span><b>${money(record.total)}</b></div></div>`}<div class="notes">${esc(notes)}</div><footer>${esc(isInvoice && record.snapshot.fiscal ? s.tax_regime : s.tax_label)}${s.iban ? "<br>IBAN: " + esc(s.iban) : ""}${isInvoice ? "<br>" + esc(record.xml_generated ? sdiLabel(record.sdi_state || "not_sent") : "XML non ancora generato") : ""}</footer></article>`;
}
function viewQuote(id) {
  const q = state.quotes.find((x) => x.id === Number(id));
  showModal(
    "Preventivo PRE-" + String(id).padStart(4, "0"),
    `<div class="actions">${q.estimate ? btn("Ipotesi iniziali", "estimate-source", id) : ""}${btn("Stampa / Salva PDF", "print-quote", id)}${q.status === "draft" ? btn("Segna consegnato", "quote-sent", id) : ""}${["draft", "sent"].includes(q.status) ? btn("Registra accettazione", "quote-accepted", id, "primary small") + btn("Rifiutato", "quote-rejected", id) : ""}</div>${documentHtml("quote", q)}`,
  );
}
const SDI_LABELS = {
  not_sent: "SdI: non inviata",
  sent: "SdI: in attesa di ricevuta",
  delivered: "SdI: consegnata",
  rejected: "SdI: scartata",
  failed: "SdI: mancata consegna",
  accepted: "SdI: accettata dal cliente",
  refused: "SdI: rifiutata dal cliente",
};
function sdiLabel(stato) {
  return SDI_LABELS[stato] || SDI_LABELS.not_sent;
}
function sdiPillClass(stato) {
  if (stato === "delivered" || stato === "accepted") return "paid";
  if (stato === "rejected" || stato === "failed" || stato === "refused") return "overdue";
  if (stato === "sent") return "sent";
  return "";
}
function sdiLastLettura(l) {
  if (!l) {
    return `<div class="callout"><strong>Nessuna lettura delle ricevute</strong><p>Il cron la esegue ogni 30 minuti; puoi provarla subito con «Aggiorna ricevute».</p></div>`;
  }
  const quando = esc(timeLabel(l.at));
  if (!l.ok) {
    return `<div class="callout"><strong>Ultima lettura non riuscita</strong> · ${quando}<p>${esc(l.error || "Errore sconosciuto.")}</p></div>`;
  }
  const conta = [`${l.updated} aggiornate`, `${l.ignorate} senza fattura`, `${l.superate} più vecchie di quelle registrate`].join(", ");
  return `<p class="hint"><strong>Ultima lettura delle ricevute:</strong> ${quando} · ${esc(conta)} <span class="muted">(solo le notifiche nuove di quel giro)</span></p>`;
}
function sdiSettingsPanel(sd) {
  const c = (sd && sd.config) || {};
  const attivo = !!(sd && sd.configured);
  return `<div class="section-gap"><section class="panel"><div class="panel-head"><h2>Invio allo SdI (PEC)</h2>${attivo ? '<span class="pill paid">Attivo</span>' : '<span class="pill">Da collegare</span>'}</div><div class="panel-body">
    <p class="subtitle">Appena l'XML di una fattura è generato, il file viene spedito dalla tua PEC a sdi01@pec.fatturapa.it. Le ricevute di consegna, scarto o esito tornano sulla stessa casella e aggiornano lo stato della fattura. Il codice destinatario è del cliente: non si genera qui.</p>
    <form id="sdi-form" class="form-grid">
      ${field("Host SMTP della PEC", "host", "text", c.host || "", 'placeholder="smtps.pec.esempio.it"')}${field("Porta SMTP", "port", "number", c.port || 465, 'min="1" max="65535"')}
      ${field("Host IMAP della PEC", "imap_host", "text", c.imap_host || "", 'placeholder="imaps.pec.esempio.it"')}${field("Porta IMAP", "imap_port", "number", c.imap_port || 993, 'min="1" max="65535"')}
      ${field("Indirizzo PEC", "user", "email", c.user || "", 'placeholder="nome@pec.esempio.it" autocomplete="username"')}${field("Mittente (di solito lo stesso indirizzo)", "from", "email", c.from || "", 'autocomplete="username"')}
      ${field("Password PEC (salvata cifrata)", "password", "password", "", `placeholder="${c.user ? "Già salvata — inseriscine una nuova per cambiarla" : "Password della casella"}" autocomplete="new-password"`)}
      <div class="field full check-row"><label><input type="checkbox" name="secure" ${c.secure !== false ? "checked" : ""}>Connessione cifrata TLS (consigliata)</label></div>
      <div class="error" role="alert"></div>
      <div class="form-actions"><button class="primary" type="submit">Salva PEC</button><button type="button" class="secondary" data-action="sdi-sync">Aggiorna ricevute</button></div>
    </form>
    ${sd && sd.missing && sd.missing.length ? `<div class="callout"><strong>Manca ancora</strong><ul>${sd.missing.map((m) => `<li>${esc(m)}</li>`).join("")}</ul></div>` : ""}
    ${sdiLastLettura(sd && sd.last_lettura)}
    <p class="hint">La password non viene mai riletta dal server. Gli stati restano scritti sulla fattura: un invio fallito si può ritentare.</p>
  </div></section></div>`;
}
function viewInvoice(id) {
  const i = state.invoices.find((x) => x.id === Number(id));
  const sd = i.sdi_state || "not_sent";
  showModal(
    "Fattura " + (i.number || "in bozza"),
    `<div class="actions">${btn("Stampa / Salva PDF", "print-invoice", id)}${i.xml_generated ? `<a class="button small" href="/api/invoices/${i.id}/xml">Scarica XML</a>` : ""}${i.status === "draft" ? btn("Verifica fiscale e genera XML", "invoice-issued", id, "primary small") : ""}${i.status === "issued" ? btn("Segna come pagata", "invoice-paid", id, "primary small") : ""}${i.xml_generated ? `<span class="pill ${sdiPillClass(sd)}">${esc(sdiLabel(sd))}</span>` : ""}${i.xml_generated ? btn(sd === "sent" ? "Reinvia allo SdI" : "Invia allo SdI", "invoice-sdi", id, "secondary small") : ""}${i.xml_generated ? btn("Aggiorna ricevute SdI", "sdi-sync", "", "secondary small") : ""}</div>${i.sdi_message ? `<p class="hint">${esc(i.sdi_message)}</p>` : ""}${documentHtml("invoice", i)}`,
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
    if (a === "nuovi-codici") {
      const res = await api("/api/emergenza", {});
      await refresh();
      if (res?.codici?.length)
        mostraCodici(res.codici, "I codici di prima non valgono più. Eccoli, una volta sola.");
      return;
    }
    if (a === "copia-codici") {
      const codici = $$("#modal .codice-lista code").map((c) => c.textContent.trim());
      try {
        await navigator.clipboard.writeText(codici.join("\n"));
        b.textContent = "Copiati";
      } catch {
        // Senza permesso per gli appunti resta l'elenco a schermo, da copiare a mano.
        b.textContent = "Copia a mano";
      }
      return;
    }
    if (a === "revoca-sessione") {
      await api("/api/sessions/revoke", { id });
      await refresh();
      toast("Sessione chiusa.");
      return;
    }
    if (a === "revoca-altre") {
      const res = await api("/api/sessions/revoke-others", {});
      await refresh();
      toast(res?.chiuse ? `Sessioni chiuse: ${res.chiuse}.` : "Nessun'altra sessione aperta.");
      return;
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
    if (a === "new-link") return linkModal();
    if (a === "edit-link") return linkModal(id);
    if (a === "delete-link")
      return confirmAction(
        "Eliminare il link breve?",
        "Il link smetterà di funzionare per chi lo ha già ricevuto. Il conteggio dei clic viene perso.",
        async () => {
          await api("/api/tools/links/delete", { id: Number(id) });
          await refresh();
          toast("Link eliminato.");
        },
      );
    if (a === "copy-link") {
      const l = (state.tools?.links || []).find((x) => x.id === Number(id));
      if (!l) return;
      try {
        await navigator.clipboard.writeText(shortUrl(l.slug));
        toast("Link copiato negli appunti.");
      } catch {
        toast(shortUrl(l.slug));
      }
      return;
    }
    if (a === "link-qr") {
      const l = (state.tools?.links || []).find((x) => x.id === Number(id));
      if (!l) return;
      return qrModal(undefined, { title: l.label || l.slug, link_id: l.id, payload: shortUrl(l.slug) });
    }
    if (a === "new-qr") return qrModal();
    if (a === "edit-qr") return qrModal(id);
    if (a === "delete-qr")
      return confirmAction(
        "Eliminare il QR?",
        "Il codice smetterà di puntare al suo contenuto. Le immagini già scaricate restano valide.",
        async () => {
          await api("/api/tools/qr/delete", { id: Number(id) });
          await refresh();
          toast("QR eliminato.");
        },
      );
    if (a === "qr-download") return downloadQr();
    if (a === "qr-fill-client" || a === "qr-fill-project") return qrFill(a === "qr-fill-client");
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
    if (a === "invoice-sdi") {
      const esito = await api("/api/invoices/sdi", { id });
      await refresh();
      toast("Fattura trasmessa allo SdI.");
      return viewInvoice(id);
    }
    if (a === "sdi-sync") {
      const esito = await api("/api/sdi/esiti", {});
      await refresh();
      toast(
        `Ricevute lette: ${esito.updated} aggiornate, ${esito.ignorate} senza fattura, ` +
          `${esito.superate || 0} più vecchie di quelle già registrate.`,
      );
      return;
    }
    if (a === "fiscal-settings") {
      $("#modal").close();
      window.dispatchEvent(new CustomEvent("buffy:open", { detail: { prompt: "Aiutami a completare i dati fiscali dell'azienda." } }));
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
window.crmBindAppleForm = bindAppleForm;
window.crmRefresh = refresh;
window.crmToast = toast;
(async () => {
  try {
    if (location.pathname.startsWith("/book/")) return await booking();
    const qs = new URLSearchParams(location.search);
    if (qs.get("view") === "settings") history.replaceState(null, "", "#dashboard");
    if (qs.get("view") === "channels") history.replaceState(null, "", "#channels");
    if (qs.get("linked") === "google")
      pendingToast = "Google collegato: ora puoi sincronizzare il calendario.";
    if ([...qs.keys()].length)
      history.replaceState(null, "", location.pathname + location.hash);
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
