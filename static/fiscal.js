/* Company-owned tax configuration; no hardcoded VAT number, ATECO or regime. */
function fiscalSelect(label, name, values, value = "") {
  return select(label, name, [["", "Seleziona…"], ...values], value);
}
function taxChoices(key) {
  return state.fiscal_catalog[key].map(([v, t]) => [v, v + " · " + t]);
}
function yesNo(label, name, value) {
  return fiscalSelect(
    label,
    name,
    [
      ["no", "Non si applica"],
      ["yes", "Si applica"],
    ],
    value,
  );
}
function fiscalAddressFields(s, isClient = false) {
  return `${field("Nazione sede (codice ISO, es. IT)", "country", "text", s.country, 'maxlength="2"')}${field("Comune / città", "city", "text", s.city, 'maxlength="60"')}${field("CAP (00000 per estero)", "postcode", "text", s.postcode, 'maxlength="5" inputmode="numeric"')}${field("Provincia italiana (sigla)", "province", "text", s.province, 'maxlength="2"')}${isClient ? field("Codice fiscale", "tax_code", "text", s.tax_code, 'maxlength="16"') : ""}`;
}
function fiscalAdjustmentFields(s) {
  return `${yesNo("Bollo virtuale", "stamp_mode", s.stamp_mode)}${field("Importo bollo (€, a carico emittente)", "stamp_amount", "number", s.stamp_amount, 'min="0.01" max="100000" step="0.01"')}
    ${yesNo("Contributo previdenziale", "cassa_mode", s.cassa_mode)}${fiscalSelect("Cassa previdenziale", "cassa_type", taxChoices("funds"), s.cassa_type)}
    ${field("Aliquota contributo (%)", "cassa_rate", "number", s.cassa_rate, 'min="0.01" max="100" step="0.01"')}${field("Quota imponibile soggetta a contributo (%)", "cassa_base_percent", "number", s.cassa_base_percent, 'min="0.01" max="100" step="0.01"')}
    ${fiscalSelect(
      "Contributo soggetto a ritenuta",
      "cassa_withholding",
      [
        ["no", "No"],
        ["yes", "Sì"],
      ],
      s.cassa_withholding,
    )}
    ${yesNo("Ritenuta", "withholding_mode", s.withholding_mode)}${fiscalSelect("Tipo ritenuta", "withholding_type", taxChoices("withholdings"), s.withholding_type)}
    ${field("Aliquota ritenuta (%)", "withholding_rate", "number", s.withholding_rate, 'min="0.01" max="100" step="0.01"')}${field("Quota compensi soggetta a ritenuta (%)", "withholding_base_percent", "number", s.withholding_base_percent, 'min="0.01" max="100" step="0.01"')}${fiscalSelect("Causale pagamento ritenuta (CU)", "withholding_reason", taxChoices("reasons"), s.withholding_reason)}`;
}
function fiscalSettings(s) {
  return `<section class="panel section-gap"><div class="panel-head"><h2>Profilo fiscale dell’azienda</h2></div><div class="panel-body">
    <p class="subtitle">Ogni azienda inserisce i propri dati. Le preferenze vengono proposte nelle nuove fatture e devono essere verificate per la singola operazione.</p>
    <div class="form-grid section-gap">${fiscalAddressFields(s)}
    ${fiscalSelect("Regime fiscale dichiarato dall’azienda", "tax_regime", taxChoices("regimes"), s.tax_regime)}${field("Codice ATECO (anagrafico, facoltativo)", "ateco", "text", s.ateco, 'maxlength="20"')}
    ${field("IVA proposta nelle fatture (%)", "invoice_vat_rate", "number", s.invoice_vat_rate, 'min="0" max="100" step="0.01"')}${fiscalSelect(
      "Natura per operazioni senza IVA",
      "invoice_nature",
      taxChoices("natures").filter(([v]) => !["N2", "N3", "N6"].includes(v)),
      s.invoice_nature,
    )}
    ${field("Riferimento normativo per IVA zero", "invoice_reference", "text", s.invoice_reference, 'maxlength="100"')}${fiscalSelect(
      "Esigibilità IVA proposta",
      "vat_timing",
      [
        ["I", "Immediata"],
        ["D", "Differita"],
        ["S", "Scissione pagamenti (split payment)"],
      ],
      s.vat_timing,
    )}
    ${fiscalSelect("Modalità di pagamento proposta", "payment_method", taxChoices("payments"), s.payment_method)}
    ${fiscalAdjustmentFields(s)}</div><p class="hint">ATECO e località non determinano automaticamente il regime o l’IVA. Nessuna preferenza fiscale viene applicata senza il controllo della fattura. Il generatore attuale gestisce TD01/FPR12 per emittenti italiani e clienti imprese o privati; altre giurisdizioni e PA richiedono flussi dedicati. Il bollo viene registrato a carico dell’emittente, senza addebito automatico al cliente.</p></div></section>`;
}
function fiscalClientFields(c) {
  return `<div class="field full"><h3>Dati per fatturazione elettronica</h3></div>
    ${fiscalSelect(
      "Tipo cliente",
      "buyer_type",
      [
        ["business", "Impresa / professionista"],
        ["private", "Privato"],
        ["public", "Pubblica amministrazione (flusso da attivare)"],
      ],
      c.buyer_type,
    )}
    ${field("Paese identificativo IVA (es. IT)", "tax_country", "text", c.tax_country, 'maxlength="2"')}${fiscalAddressFields(c, true)}
    ${field("Codice destinatario (7 caratteri)", "recipient_code", "text", c.recipient_code, 'maxlength="7"')}${field("PEC destinatario (facoltativa)", "pec", "email", c.pec)}
    <p class="hint field full">Partita IVA senza prefisso paese e codice fiscale sono campi distinti. Per un’impresa italiana senza codice canale indica 0000000. Il codice per clienti esteri è impostato dal generatore. I dati vengono controllati prima di generare l’XML.</p>`;
}
function fiscalTotals(r) {
  return `<div class="totals"><div><span>Compensi</span><b>${money(r.subtotal)}</b></div>${r.contribution ? `<div><span>Contributo previdenziale</span><b>${money(r.contribution)}</b></div>` : ""}<div><span>IVA</span><b>${money(r.vat)}</b></div><div><span>Totale documento</span><b>${money(r.total)}</b></div>${r.withholding ? `<div><span>Ritenuta</span><b>− ${money(r.withholding)}</b></div>` : ""}${r.split_vat ? `<div><span>IVA split payment</span><b>− ${money(r.split_vat)}</b></div>` : ""}<div class="grand"><span>Da pagare</span><b>${money(r.payable)}</b></div>${r.stamp ? `<p class="hint">Bollo virtuale ${money(r.stamp)} a carico dell’emittente.</p>` : ""}</div>`;
}
function invoicePayable(i) {
  return i.snapshot?.fiscal?.report.payable ?? i.total;
}
function fiscalPrint(record) {
  const f = record.snapshot.fiscal;
  return `${table(
    ["Aliquota / natura", "Imponibile", "IVA", "Riferimento normativo"],
    f.report.groups.map(
      (g) =>
        `<tr><td>${esc(g.vat_rate)}% ${esc(g.nature)}</td><td>${money(g.base)}</td><td>${money(g.vat)}</td><td>${esc(g.reference)}</td></tr>`,
    ),
  )}${fiscalTotals(f.report)}`;
}
async function fiscalWizard(id) {
  const context = await api("/api/invoices/" + id + "/fiscal");
  const cfg = context.config;
  showModal(
    "Verifica fiscale della fattura",
    `<form id="fiscal-form">
    <p class="subtitle">Le preferenze aziendali sono proposte iniziali. Controlla i dati e il trattamento di questa operazione prima di numerare il documento.</p>
    ${context.profile_errors.length ? `<div class="callout section-gap"><strong>Dati da completare</strong><ul>${context.profile_errors.map((x) => `<li>${esc(x)}</li>`).join("")}</ul><div class="actions">${btn("Completa azienda", "fiscal-settings")}${btn("Completa cliente", "edit-client", context.client.id)}</div></div>` : ""}
    <div class="form-grid section-gap">${field("Data documento", "document_date", "date", cfg.document_date, "required")}${field("Scadenza pagamento", "due_date", "date", cfg.due_date, "required")}
    ${fiscalSelect("Modalità di pagamento", "payment_method", taxChoices("payments"), cfg.payment_method)}${fiscalSelect(
      "Esigibilità IVA",
      "vat_timing",
      [
        ["I", "Immediata"],
        ["D", "Differita"],
        ["S", "Scissione pagamenti (split payment)"],
      ],
      cfg.vat_timing,
    )}</div>
    <h3 class="section-gap">Trattamento fiscale delle voci</h3>
    <div id="fiscal-lines">${context.items
      .map(
        (item, n) =>
          `<fieldset class="estimate-fieldset fiscal-line" data-index="${n}"><legend>${n + 1}. ${esc(item.description)} · ${money(item.amount)}</legend><div class="form-grid">${field("IVA (%)", "tax_rate_" + n, "number", cfg.taxes[n].vat_rate, 'min="0" max="100" step="0.01"')}${fiscalSelect(
            "Natura se IVA zero",
            "tax_nature_" + n,
            taxChoices("natures").filter(
              ([v]) => !["N2", "N3", "N6"].includes(v),
            ),
            cfg.taxes[n].nature,
          )}${field("Riferimento normativo se IVA zero", "tax_reference_" + n, "text", cfg.taxes[n].reference, 'maxlength="100"')}</div></fieldset>`,
      )
      .join("")}</div>
    <h3 class="section-gap">Bollo, contributi e ritenute</h3><div class="form-grid">${fiscalAdjustmentFields(cfg)}
    ${field("IVA contributo previdenziale (%)", "cassa_vat_rate", "number", cfg.cassa_vat_rate, 'min="0" max="100" step="0.01"')}${fiscalSelect(
      "Natura contributo se IVA zero",
      "cassa_nature",
      taxChoices("natures").filter(([v]) => !["N2", "N3", "N6"].includes(v)),
      cfg.cassa_nature,
    )}${field("Riferimento normativo contributo", "cassa_reference", "text", cfg.cassa_reference, 'maxlength="100"')}</div>
    <p class="hint">La quota di base della ritenuta si applica uniformemente ai compensi e all’eventuale contributo soggetto a ritenuta. Il bollo è a carico dell’emittente. Per operazioni che richiedono trattamenti diversi, non usare questi parametri come approssimazione.</p>
    <div class="section-gap"><button type="button" id="fiscal-check" class="secondary">Verifica dati e calcola riepilogo</button></div>
    <div id="fiscal-result" class="section-gap" aria-live="polite"></div>
    <div class="check-row section-gap"><label><input type="checkbox" name="fiscal_confirmed">Ho verificato azienda, destinatario e trattamento fiscale di questa fattura.</label></div>
    <p class="hint">Genera un XML validato e assegna il numero definitivo. Il file non viene inviato allo SdI. L’accettazione SdI e la conservazione richiedono un servizio collegato.</p>${formBottom("Numera e genera XML")}
    </form>`,
    async (d, form) => {
      if (!review || !form.elements.fiscal_confirmed.checked)
        throw new Error(
          "Verifica il riepilogo e conferma i dati prima di generare.",
        );
      await api("/api/invoices/finalize", {
        id,
        config: readConfig(form),
        confirmed: true,
        review_hash: review,
      });
      await saved("XML generato e validato. Puoi scaricarlo dalla fattura.");
      viewInvoice(id);
    },
  );
  const form = $("#fiscal-form"),
    button = $("[type=submit]", form),
    output = $("#fiscal-result", form),
    check = $("#fiscal-check", form);
  let review = null,
    version = 0;
  button.disabled = true;
  function readConfig(f) {
    const d = Object.fromEntries(new FormData(f));
    delete d.fiscal_confirmed;
    d.taxes = context.items.map((_, n) => ({
      vat_rate: d["tax_rate_" + n],
      nature: d["tax_nature_" + n],
      reference: d["tax_reference_" + n],
    }));
    Object.keys(d)
      .filter((k) => k.startsWith("tax_"))
      .forEach((k) => delete d[k]);
    return d;
  }
  $("#modal").oninput = (e) => {
    if (e.target.name !== "fiscal_confirmed") {
      review = null;
      version++;
      output.textContent = "Dati modificati: verifica nuovamente il riepilogo.";
      form.elements.fiscal_confirmed.checked = false;
    }
    button.disabled = !review || !form.elements.fiscal_confirmed.checked;
  };
  check.onclick = async () => {
    const v = ++version;
    review = null;
    button.disabled = true;
    check.disabled = true;
    form.elements.fiscal_confirmed.checked = false;
    try {
      const r = await api("/api/invoices/fiscal-check", {
        id,
        config: readConfig(form),
      });
      if (v !== version || !form.isConnected) return;
      if (!r.valid) {
        output.innerHTML = `<div class="error" role="alert"><strong>Prima di generare, correggi:</strong><ul>${r.errors.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>`;
        return;
      }
      review = r.review_hash;
      output.innerHTML = `<div class="callout"><strong>Controlli e schema XML superati</strong><p>Emittente: ${esc(r.business.business_name)} · P. IVA ${esc(r.business.vat_number)} · ${esc(r.business.tax_regime)}<br>${esc(r.business.address)}, ${esc(r.business.postcode)} ${esc(r.business.city)} (${esc(r.business.country)})</p><p>Destinatario: ${esc(r.client.company || r.client.name)} · IVA ${esc(r.client.vat_number || "—")} · CF ${esc(r.client.tax_code || "—")}<br>${esc(r.client.address)}, ${esc(r.client.postcode)} ${esc(r.client.city)} (${esc(r.client.country)})</p><p class="hint">Il controllo formale non verifica l’esistenza dei dati nei registri fiscali né sostituisce l’esito SdI.</p></div>${table(
        ["IVA / natura", "Imponibile", "Imposta"],
        r.report.groups.map(
          (g) =>
            `<tr><td>${esc(g.vat_rate)}% ${esc(g.nature)}</td><td>${money(g.base)}</td><td>${money(g.vat)}</td></tr>`,
        ),
      )}${fiscalTotals(r.report)}`;
    } catch (e) {
      output.textContent = e.message;
    } finally {
      check.disabled = false;
    }
  };
}
