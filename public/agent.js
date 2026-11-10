(() => {
  "use strict";

  const STORAGE_KEY = "realindi.buffy.v1";
  const WELCOME =
    "Ciao, sono Buffy. Leggo clienti, progetti, preventivi, fatture, documenti, appuntamenti, note, ricevute e canali del workspace. Dimmi cosa ti serve: se una modifica è utile te la propongo, e la applico solo dopo la tua conferma.";
  const SUGGESTIONS = [
    "Cosa ho in scadenza?",
    "Fammi un riepilogo della settimana",
    "Controlla le fatture non pagate",
  ];

  const root = document.createElement("div");
  root.id = "buffy-root";
  root.innerHTML = `
    <div class="buffy-scrim" data-buffy-close hidden></div>
    <aside id="buffy-panel" class="buffy-panel" role="dialog" aria-modal="true" aria-labelledby="buffy-title" aria-hidden="true">
      <header class="buffy-head">
        <div class="buffy-avatar" aria-hidden="true">B</div>
        <div class="buffy-head-text">
          <span class="buffy-eyebrow">REALINDI · OPERATIVO</span>
          <h2 id="buffy-title">Buffy</h2>
        </div>
        <button type="button" class="buffy-icon-button" data-buffy-new title="Nuova chat" aria-label="Nuova chat">+</button>
        <button type="button" class="buffy-icon-button buffy-close" data-buffy-close aria-label="Chiudi Buffy">×</button>
      </header>
      <div class="buffy-context"><span class="buffy-dot" aria-hidden="true"></span>Collegata al gestionale</div>
      <div class="buffy-messages" id="buffy-messages" aria-live="polite"></div>
      <div class="buffy-typing" id="buffy-typing" role="status" aria-live="polite" hidden>
        <span class="buffy-typing-dots" aria-hidden="true"><i></i><i></i><i></i></span>
        <span class="buffy-typing-text">Buffy sta leggendo il gestionale…</span>
      </div>
      <form class="buffy-composer" id="buffy-form">
        <label class="sr-only" for="buffy-input">Scrivi a Buffy</label>
        <textarea id="buffy-input" rows="1" maxlength="4000" placeholder="Chiedi qualcosa sul workspace…" autocomplete="off"></textarea>
        <button type="submit" class="buffy-send" aria-label="Invia messaggio">↑</button>
      </form>
      <p class="buffy-footnote">Le modifiche vengono applicate solo dopo la tua conferma.</p>
    </aside>`;
  document.body.appendChild(root);

  const panel = root.querySelector("#buffy-panel");
  const scrim = root.querySelector(".buffy-scrim");
  const messagesEl = root.querySelector("#buffy-messages");
  const form = root.querySelector("#buffy-form");
  const input = root.querySelector("#buffy-input");
  const sendButton = root.querySelector(".buffy-send");
  const typing = root.querySelector("#buffy-typing");
  const typingText = root.querySelector(".buffy-typing-text");

  let messages = load();
  let busy = false;
  let lastFocus = null;

  function welcomeMessage() {
    return { role: "assistant", content: WELCOME, actions: [] };
  }

  function load() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (Array.isArray(parsed)) {
        const clean = parsed
          .filter(
            (item) =>
              item &&
              (item.role === "user" || item.role === "assistant") &&
              typeof item.content === "string" &&
              item.content.trim(),
          )
          .slice(-40)
          .map((item) => ({
            role: item.role,
            content: item.content.slice(0, 6000),
            actions: Array.isArray(item.actions)
              ? item.actions
                  .filter((action) => action && typeof action.type === "string")
                  .slice(0, 6)
                  .map((action) => ({
                    type: action.type,
                    label: typeof action.label === "string" ? action.label.slice(0, 100) : "",
                    summary:
                      typeof action.summary === "string" ? action.summary.slice(0, 240) : "",
                    data:
                      action.data && typeof action.data === "object" && !Array.isArray(action.data)
                        ? action.data
                        : {},
                    applied: action.applied === true,
                  }))
              : [],
          }));
        if (clean.length) return clean;
      }
    } catch {
      // storage non disponibile o corrotto: si riparte dalla chat nuova
    }
    return [welcomeMessage()];
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-40)));
    } catch {
      // la chat funziona anche senza storage
    }
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }

  function setBusy(value, label) {
    busy = value;
    input.disabled = value;
    sendButton.disabled = value;
    typing.hidden = !value;
    typingText.textContent = label || "Buffy sta leggendo il gestionale…";
  }

  function updateLaunchers() {
    const isOpen = root.classList.contains("buffy-open");
    document.querySelectorAll('[data-action="agent-open"]').forEach((el) => {
      el.setAttribute("aria-expanded", String(isOpen));
    });
  }

  function open(prefill) {
    if (!root.classList.contains("buffy-open")) lastFocus = document.activeElement;
    root.classList.add("buffy-open");
    document.body.classList.add("buffy-open");
    panel.setAttribute("aria-hidden", "false");
    scrim.hidden = false;
    if (typeof prefill === "string" && prefill.trim()) {
      input.value = prefill.trim().slice(0, 4000);
      autoGrow();
    }
    updateLaunchers();
    requestAnimationFrame(() => {
      input.focus();
      scrollToBottom();
    });
  }

  function close() {
    root.classList.remove("buffy-open");
    document.body.classList.remove("buffy-open");
    panel.setAttribute("aria-hidden", "true");
    scrim.hidden = true;
    updateLaunchers();
    if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
  }

  function autoGrow() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 120) + "px";
  }

  // Il corpo dei messaggi e le note si leggono per intero: sono il contenuto
  // che il proprietario deve approvare prima dell'invio.
  const FULL_TEXT_KEYS = new Set(["body", "notes", "reason"]);

  function formatActionValue(value, key) {
    if (value === null || value === undefined || value === "") return "—";
    if (typeof value === "string") {
      const limit = FULL_TEXT_KEYS.has(key) ? 4000 : 140;
      return value.length > limit ? value.slice(0, limit) + "…" : value;
    }
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (Array.isArray(value)) {
      return value.map((item) => formatActionValue(item)).join(", ").slice(0, 160);
    }
    try {
      return JSON.stringify(value).slice(0, 160);
    } catch {
      return "…";
    }
  }

  function confirmLabel(action) {
    if (action.type === "update_quote_status") {
      if (action.data && action.data.status === "accepted") return "Accetta";
      if (action.data && action.data.status === "rejected") return "Rifiuta";
      return "Invia";
    }
    if (action.type === "send_client_message") return "Invia messaggio";
    if (action.type === "create_receipt") return "Emetti ricevuta";
    if (action.type === "cancel_receipt") return "Annulla ricevuta";
    if (action.type === "mark_invoice_paid") return "Segna pagata";
    return "Applica";
  }

  function appliedLabel(action) {
    if (action.type === "send_client_message") return "Inviato";
    if (action.type === "create_receipt") return "Emessa";
    if (action.type === "cancel_receipt") return "Annullata";
    if (action.type === "mark_invoice_paid") return "Pagata";
    if (action.type === "update_quote_status") {
      if (action.data && action.data.status === "accepted") return "Accettato";
      if (action.data && action.data.status === "rejected") return "Rifiutato";
      return "Inviato";
    }
    return "Applicata";
  }

  function actionCard(message, action) {
    const card = document.createElement("div");
    card.className = "buffy-action" + (action.applied ? " is-applied" : "");

    const title = document.createElement("strong");
    title.textContent = action.label || action.summary || "Azione proposta";
    card.appendChild(title);

    if (action.summary && action.summary !== title.textContent) {
      const summary = document.createElement("p");
      summary.textContent = action.summary;
      card.appendChild(summary);
    }

    const entries = Object.entries(action.data || {}).filter(([, value]) => value !== undefined);
    if (entries.length) {
      const details = document.createElement("dl");
      details.className = "buffy-action-data";
      entries.slice(0, 10).forEach(([key, value]) => {
        const row = document.createElement("div");
        const label = document.createElement("dt");
        label.textContent = key.replace(/_/g, " ");
        const valueEl = document.createElement("dd");
        valueEl.textContent = formatActionValue(value, key);
        row.append(label, valueEl);
        details.appendChild(row);
      });
      if (entries.length > 10) {
        const more = document.createElement("div");
        const label = document.createElement("dt");
        label.textContent = "…";
        const valueEl = document.createElement("dd");
        valueEl.textContent = `altri ${entries.length - 10} campi`;
        more.append(label, valueEl);
        details.appendChild(more);
      }
      card.appendChild(details);
    }

    const apply = document.createElement("button");
    apply.type = "button";
    apply.className = "buffy-action-apply";
    apply.textContent = action.applied ? appliedLabel(action) : confirmLabel(action);
    apply.disabled = action.applied || busy;
    if (!action.applied) {
      apply.addEventListener("click", () => applyActions(message, [action], apply));
    }
    card.appendChild(apply);
    return card;
  }

  function render() {
    messagesEl.replaceChildren();
    for (const message of messages) {
      const row = document.createElement("div");
      row.className = "buffy-row " + message.role;

      const bubble = document.createElement("div");
      bubble.className = "buffy-bubble";
      const text = document.createElement("p");
      text.textContent = message.content;
      bubble.appendChild(text);

      if (message.actions && message.actions.length) {
        const actions = document.createElement("div");
        actions.className = "buffy-actions";
        message.actions.forEach((action) => actions.appendChild(actionCard(message, action)));
        const pending = message.actions.filter((action) => !action.applied);
        if (pending.length > 1) {
          const all = document.createElement("button");
          all.type = "button";
          all.className = "buffy-apply-all";
          all.textContent = "Conferma tutte";
          all.disabled = busy;
          all.addEventListener("click", () => applyActions(message, pending, all));
          actions.appendChild(all);
        }
        bubble.appendChild(actions);
      }

      row.appendChild(bubble);
      messagesEl.appendChild(row);
    }

    if (!busy && !messages.some((message) => message.role === "user")) {
      const suggestions = document.createElement("div");
      suggestions.className = "buffy-suggestions";
      SUGGESTIONS.forEach((suggestion) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "buffy-suggestion";
        button.textContent = suggestion;
        button.addEventListener("click", () => send(suggestion));
        suggestions.appendChild(button);
      });
      messagesEl.appendChild(suggestions);
    }
    scrollToBottom();
  }

  async function readJson(response) {
    try {
      return await response.json();
    } catch {
      return {};
    }
  }

  async function send(raw) {
    const content = String(raw || "").trim().slice(0, 4000);
    if (!content || busy) return;

    messages.push({ role: "user", content, actions: [] });
    input.value = "";
    autoGrow();
    persist();
    setBusy(true, "Buffy sta leggendo il gestionale…");
    render();

    try {
      const history = messages
        .filter((message) => message.content)
        .slice(-20)
        .map((message) => ({ role: message.role, content: message.content }));
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history }),
      });
      const data = await readJson(response);
      if (!response.ok) {
        throw new Error(typeof data.error === "string" ? data.error : "Buffy non è disponibile.");
      }
      const reply = typeof data.reply === "string" ? data.reply : "Non ho una risposta da darti.";
      const actions = Array.isArray(data.actions)
        ? data.actions
            .filter((action) => action && typeof action.type === "string")
            .slice(0, 6)
            .map((action) => ({
              type: action.type,
              label: typeof action.label === "string" ? action.label.slice(0, 100) : "",
              summary: typeof action.summary === "string" ? action.summary.slice(0, 240) : "",
              data:
                action.data && typeof action.data === "object" && !Array.isArray(action.data)
                  ? action.data
                  : {},
              applied: false,
            }))
        : [];
      messages.push({ role: "assistant", content: reply, actions });
    } catch (error) {
      messages.push({
        role: "assistant",
        content:
          "Non riesco a rispondere: " +
          (error instanceof Error ? error.message : "errore di rete."),
        actions: [],
      });
    } finally {
      setBusy(false);
      persist();
      render();
    }
  }

  async function applyActions(message, actions, trigger) {
    if (busy) return;
    const pending = actions.filter((action) => !action.applied);
    if (!pending.length) return;

    setBusy(true, "Applico le modifiche…");
    if (trigger) trigger.disabled = true;
    render();

    try {
      const response = await fetch("/api/agent/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actions: pending.map((action) => ({ type: action.type, data: action.data })),
        }),
      });
      const data = await readJson(response);
      if (!response.ok) {
        throw new Error(
          typeof data.error === "string" ? data.error : "Non riesco ad applicare le modifiche.",
        );
      }
      const results = Array.isArray(data.results) ? data.results : [];
      pending.forEach((action, index) => {
        if (results[index] && results[index].ok) action.applied = true;
      });

      const done = results.filter((result) => result.ok).map((result) => result.message);
      const failed = results.filter((result) => !result.ok).map((result) => result.message);
      const lines = [];
      if (done.length) lines.push("Fatto: " + done.join(" "));
      if (failed.length) lines.push("Non riuscito: " + failed.join(" "));
      if (!lines.length) lines.push("Nessun esito ricevuto dal server.");
      messages.push({ role: "assistant", content: lines.join("\n"), actions: [] });

      if (typeof window.crmRefresh === "function") {
        try {
          await window.crmRefresh();
        } catch {
          // il gestionale si aggiornerà al prossimo cambio vista
        }
      }
      if (typeof window.crmToast === "function" && done.length) {
        window.crmToast("Modifiche applicate al gestionale.");
      }
    } catch (error) {
      messages.push({
        role: "assistant",
        content:
          "Non riesco ad applicare le modifiche: " +
          (error instanceof Error ? error.message : "errore di rete."),
        actions: [],
      });
    } finally {
      setBusy(false);
      persist();
      render();
      input.focus();
    }
  }

  function newChat() {
    if (busy) return;
    const hasConversation = messages.some((message) => message.role === "user");
    if (hasConversation && !window.confirm("Vuoi iniziare una nuova chat con Buffy?")) return;
    messages = [welcomeMessage()];
    persist();
    render();
    input.focus();
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    send(input.value);
  });

  input.addEventListener("input", autoGrow);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      send(input.value);
    }
  });

  root.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest("[data-buffy-close]")) {
      event.preventDefault();
      close();
      return;
    }
    if (target.closest("[data-buffy-new]")) {
      event.preventDefault();
      newChat();
    }
  });

  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const opener = target.closest('[data-action="agent-open"]');
    if (opener) {
      event.preventDefault();
      open();
      return;
    }
    if (target.closest('[data-action="logout"]')) {
      close();
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        // niente storage: nessun dato locale da rimuovere
      }
      messages = [welcomeMessage()];
      render();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && root.classList.contains("buffy-open")) {
      event.preventDefault();
      close();
    }
  });

  panel.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      panel.querySelectorAll("button:not([disabled]), textarea:not([disabled]), a[href]"),
    ).filter((element) => element.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  window.addEventListener("buffy:open", (event) => {
    const detail = event instanceof CustomEvent ? event.detail : null;
    open(detail && typeof detail.prompt === "string" ? detail.prompt : "");
  });

  const host = document.getElementById("root");
  if (host) {
    new MutationObserver(updateLaunchers).observe(host, { childList: true });
  }

  render();
  updateLaunchers();
})();
