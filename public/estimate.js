/* Scope-driven estimates share the workspace's form and dialog primitives. */
async function estimateModal(projectId) {
  if (!state.projects.length) {
    toast("Crea prima il progetto e descrivi il lavoro concordato.");
    return projectModal();
  }
  const catalog = await api("/api/estimates/catalog");
  const selectedProject = projectId || state.projects[0].id;
  const previousFor = (id) =>
    state.quotes.find((q) => q.project_id === Number(id) && q.estimate)
      ?.estimate;
  let seed = previousFor(selectedProject);
  const generationKey = crypto.randomUUID();
  showModal(
    "Preventivo automatico dal progetto",
    `<form id="estimate-form">
    <p class="subtitle">Traduci il perimetro concordato in attività e quantità. Le ore iniziali sono esempi: adattale al tuo modo di lavorare.</p>
    <div class="form-grid section-gap">
      ${select(
        "Progetto concordato",
        "project_id",
        state.projects.map((p) => [
          p.id,
          p.title + " · " + client(p.client_id).name,
        ]),
        selectedProject,
      )}
      ${select(
        "Tipologia di lavoro",
        "kind",
        Object.entries(catalog).map(([k, v]) => [k, v.name]),
        seed?.scope.kind || "website",
      )}
      ${field("Titolo del preventivo", "title", "text", ("Proposta · " + project(selectedProject).title).slice(0, 300), 'required maxlength="300"')}
      ${field("Valido fino al", "valid_until", "date", futureDay(30), `required min="${today()}"`)}
    </div>
    <div class="callout section-gap" id="estimate-brief"></div>
    <fieldset class="estimate-fieldset"><legend>Funzionalità e quantità concordate</legend><p class="hint">Quantità 0 esclude l’attività. Ore/unità indica il tempo prima del fattore di complessità.</p><div id="estimate-modules"></div></fieldset>
    <div class="form-grid section-gap">
      ${field("Tariffa oraria (€)", "rate", "number", seed?.rate || state.settings.hourly_rate, 'required min="0" max="100000" step="0.01"')}
      ${field("Complessità (moltiplicatore)", "complexity", "number", seed?.scope.complexity || "1", 'required min="0.5" max="3" step="0.01"')}
      ${field("Test e verifiche (%)", "testing", "number", seed?.scope.testing || "0", 'required min="0" max="100" step="0.01"')}
      ${field("Coordinamento e revisioni (%)", "coordination", "number", seed?.scope.coordination || "0", 'required min="0" max="100" step="0.01"')}
      ${field("Riserva per imprevisti (%)", "contingency", "number", seed?.scope.contingency || "0", 'required min="0" max="100" step="0.01"')}
      ${field("Ore disponibili alla settimana", "weekly_hours", "number", seed?.scope.weekly_hours || "20", 'required min="1" max="80" step="0.01"')}
      ${field("Costi extra concordati (€)", "expenses", "number", seed?.scope.expenses || "0", 'required min="0" max="1000000" step="0.01"')}
      ${field("IVA (%)", "vat_rate", "number", state.settings.vat_rate, 'required min="0" max="100" step="0.01"')}
      ${area("Condizioni aggiuntive", "notes", "Pagamento a 30 giorni. Variazioni al perimetro da concordare separatamente.")}
    </div>
    <div id="estimate-preview" class="section-gap" role="status" aria-live="polite"></div>
    ${formBottom("Genera preventivo in bozza")}
  </form>`,
    async (d, form) => {
      const result = await api("/api/estimates", {
        ...readScope(form),
        generation_key: generationKey,
      });
      await saved(
        "Preventivo generato. Puoi rivedere le voci prima di condividerlo.",
      );
      quoteModal(result.id);
    },
  );
  const form = $("#estimate-form");
  const preview = $("#estimate-preview", form);
  const submit = $("[type=submit]", form);
  let revision = 0,
    timer;
  function readScope(f) {
    const d = Object.fromEntries(new FormData(f));
    return {
      ...d,
      scope: {
        ...Object.fromEntries(
          [
            "kind",
            "complexity",
            "testing",
            "coordination",
            "contingency",
            "weekly_hours",
            "expenses",
          ].map((k) => [k, d[k]]),
        ),
        modules: $$(".estimate-module", f).map((m) => ({
          key: m.dataset.key,
          quantity: $("[data-quantity]", m).value,
          hours: $("[data-hours]", m).value,
        })),
      },
    };
  }
  function updateBrief() {
    const p = project(form.project_id.value);
    $("#estimate-brief", form).textContent =
      p.description ||
      "Questo progetto non ha ancora una descrizione: verifica che le funzionalità selezionate coprano tutto il lavoro concordato.";
  }
  function modules(kind, previous) {
    $("#estimate-modules", form).innerHTML = catalog[kind].modules
      .map((m) => {
        const v = previous?.modules.find((x) => x.key === m.key) || m;
        return `<div class="estimate-module" data-key="${m.key}"><div><strong>${esc(m.name)}</strong><small>${esc(m.unit)}</small></div><div><label for="qty-${m.key}">Quantità · ${esc(m.name)}</label><input id="qty-${m.key}" type="number" min="0" max="1000" step="1" value="${esc(v.quantity)}" data-quantity required></div><div><label for="unit-${m.key}">Ore/unità · ${esc(m.name)}</label><input id="unit-${m.key}" type="number" min="0.01" max="1000" step="0.01" value="${esc(v.hours)}" data-hours required></div></div>`;
      })
      .join("");
  }
  async function previewNow(v) {
    try {
      if (!form.checkValidity())
        throw new Error(
          "Completa i campi e correggi i valori non validi per calcolare la stima.",
        );
      const result = await api("/api/estimates/preview", readScope(form));
      if (v !== revision || !form.isConnected) return;
      preview.innerHTML = estimateSummary(result);
      submit.disabled = false;
    } catch (error) {
      if (v === revision && form.isConnected)
        preview.innerHTML = `<p class="error">${esc(error.message)}</p>`;
    }
  }
  function schedule() {
    const v = ++revision;
    submit.disabled = true;
    preview.textContent = "Aggiornamento della stima…";
    clearTimeout(timer);
    timer = setTimeout(() => previewNow(v), 200);
  }
  form.kind.onchange = () => {
    modules(form.kind.value);
    schedule();
  };
  form.project_id.onchange = () => {
    seed = previousFor(form.project_id.value);
    form.kind.value = seed?.scope.kind || "website";
    form.elements.title.value = (
      "Proposta · " + project(form.project_id.value).title
    ).slice(0, 300);
    for (const k of [
      "complexity",
      "testing",
      "coordination",
      "contingency",
      "weekly_hours",
      "expenses",
    ]) {
      form.elements[k].value =
        seed?.scope[k] || { complexity: "1", weekly_hours: "20" }[k] || "0";
    }
    form.rate.value = seed?.rate || state.settings.hourly_rate;
    modules(form.kind.value, seed?.scope);
    updateBrief();
    schedule();
  };
  $("#modal").oninput = schedule;
  modules(form.kind.value, seed?.scope);
  updateBrief();
  schedule();
}

function estimateSummary(e) {
  return `<section class="estimate-result"><h3>Come si compone la stima</h3>
    <dl class="estimate-breakdown">
      <div><dt>Attività, inclusa complessità</dt><dd>${esc(e.base_hours)} h</dd></div>
      <div><dt>Test e verifiche</dt><dd>${esc(e.test_hours)} h</dd></div>
      <div><dt>Coordinamento e revisioni</dt><dd>${esc(e.coordination_hours)} h</dd></div>
      <div><dt>Riserva per imprevisti</dt><dd>${esc(e.contingency_hours)} h</dd></div>
      <div><dt>Impegno totale</dt><dd><strong>${esc(e.total_hours)} h</strong></dd></div>
      <div><dt>Carico a ${esc(e.scope.weekly_hours)} h/settimana</dt><dd>${esc(e.workload_weeks)} settimane</dd></div>
      <div><dt>Imponibile, inclusi extra</dt><dd>${money(e.subtotal)}</dd></div>
      <div><dt>IVA ${esc(e.vat_rate)}%</dt><dd>${money(e.vat)}</dd></div>
      <div class="estimate-grand"><dt>Totale preventivo</dt><dd>${money(e.total)}</dd></div>
    </dl><p class="hint">Il carico stimato non è una data di consegna. Test e coordinamento sono percentuali sulle attività; la riserva comprende anche test e coordinamento. Verifica disponibilità, dipendenze e condizioni prima di inviare.</p></section>`;
}

function estimateSource(id) {
  const q = state.quotes.find((q) => q.id === Number(id));
  if (!q?.estimate) return;
  const e = q.estimate;
  showModal(
    "Ipotesi della stima iniziale",
    `<p class="subtitle">Conservate al momento della generazione. Le voci del preventivo potrebbero essere state modificate successivamente.</p>
    <div class="callout section-gap">${esc(e.project.title)}<br>${esc(e.project.description || "Nessuna descrizione aggiuntiva.")}</div>
    ${table(
      ["Attività", "Quantità", "Ore/unità"],
      e.scope.modules
        .filter((m) => m.quantity > 0)
        .map(
          (m) =>
            `<tr><td>${esc(m.name)}</td><td>${esc(m.quantity)}</td><td>${esc(m.hours)}</td></tr>`,
        ),
    )}
    <p>Tariffa ${money(Number(e.rate) * 100)}/h · Complessità × ${esc(e.scope.complexity)}</p>
    ${estimateSummary(e)}<ul class="hint">${e.assumptions.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>`,
  );
}
