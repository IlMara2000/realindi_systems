// @vitest-environment happy-dom
// Form di collegamento Apple senza server: DOM simulato e rete finta.
// Copre l'avviso sulla forma della password (mentre si scrive e prima dell'invio).
import { beforeAll, describe, expect, it, vi } from "vitest";

const invii: Array<Record<string, unknown>> = [];

function json(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeAll(async () => {
  document.body.innerHTML = '<div id="root"></div>';
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init: { body?: unknown } = {}) => {
      const u = String(url);
      if (u === "/api/session") return json({ authenticated: false, setup: false });
      if (u === "/api/integrations/apple") {
        invii.push(JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>);
        return json({ ok: true });
      }
      return json({});
    }),
  );
  // @ts-ignore: public/app.js non ha dichiarazioni TypeScript, importa solo per side-effect
  await import("../public/app.js");
  await accoda();
  expect(typeof (window as unknown as { crmBindAppleForm?: unknown }).crmBindAppleForm).toBe(
    "function",
  );
});

async function accoda(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Stesso markup che app.js genera nel pannello Integrazioni, compreso il link
 * per creare la password per le app (APPLE_PASSWORD_HINT). */
function formApple(): HTMLFormElement {
  document.body.innerHTML =
    '<div id="root"></div>' +
    '<form id="apple-form">' +
    '<input name="apple_id" value="dany@icloud.com">' +
    '<input name="app_password">' +
    '<p class="hint">Serve una password per le app, non quella dell\'ID Apple: ' +
    '<a href="https://account.apple.com/account/manage" target="_blank" rel="noopener noreferrer">' +
    "creala su account.apple.com</a> → Accesso e sicurezza → Password per le app.</p>" +
    '<input name="sender_email" value="dany@icloud.com">' +
    '<div class="error" role="alert"></div>' +
    '<div class="form-actions"><button type="submit">Salva collegamento Apple</button></div>' +
    "</form>";
  const form = document.querySelector("#apple-form") as HTMLFormElement;
  (window as unknown as { crmBindAppleForm: (f: HTMLFormElement) => void }).crmBindAppleForm(form);
  return form;
}

const campo = (f: HTMLFormElement) => f.querySelector("[name=app_password]") as HTMLInputElement;
const avviso = (f: HTMLFormElement) => f.querySelector(".apple-password-warning") as HTMLElement | null;
const pulsante = (f: HTMLFormElement) => f.querySelector("[type=submit]") as HTMLButtonElement;

function scrivi(f: HTMLFormElement, valore: string): void {
  const c = campo(f);
  c.value = valore;
  c.dispatchEvent(new Event("input", { bubbles: true }));
}

function invia(f: HTMLFormElement): void {
  f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

describe("form Apple: avviso sulla password", () => {
  it("il link per creare la password per le app è presente nel form", () => {
    const f = formApple();
    const link = f.querySelector('a[href="https://account.apple.com/account/manage"]');
    expect(link, "il link deve esistere nel form").not.toBeNull();
    expect(link!.getAttribute("target")).toBe("_blank");
    expect(link!.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link!.textContent).toBe("creala su account.apple.com");

    const hint = f.querySelector(".hint");
    expect(hint, "il paragrafo hint deve esistere").not.toBeNull();
    expect(hint!.textContent).toContain("Serve una password per le app, non quella dell'ID Apple");
    expect(hint!.textContent).toContain("→ Accesso e sicurezza → Password per le app");
  });
  it("compare mentre si scrive e sparisce quando la forma torna corretta", () => {
    const f = formApple();
    expect(avviso(f)?.hidden ?? true).toBe(true);

    scrivi(f, "PasswordDiApple1!");
    expect(avviso(f), "l'avviso deve esistere appena si digita").not.toBeNull();
    expect(avviso(f)!.hidden).toBe(false);
    expect(avviso(f)!.textContent).toContain("xxxx-xxxx-xxxx-xxxx");
    expect(avviso(f)!.textContent).toContain("due fattori");

    scrivi(f, "abcd-efgh-ijkl-mnop");
    expect(avviso(f)!.hidden).toBe(true);
    expect(avviso(f)!.textContent).toBe("");

    scrivi(f, "");
    expect(avviso(f)!.hidden).toBe(true);
  });

  it("chiede conferma prima di inviare e poi manda un solo invio", async () => {
    const f = formApple();
    scrivi(f, "PasswordDiApple1!");
    const prima = invii.length;

    invia(f);
    await accoda();
    expect(invii.length).toBe(prima);
    expect(pulsante(f).textContent).toBe("Invia comunque");
    expect(avviso(f)!.textContent).toContain("Premi di nuovo per inviare comunque");

    invia(f);
    await accoda();
    expect(invii.length).toBe(prima + 1);
    expect(invii[invii.length - 1].app_password).toBe("PasswordDiApple1!");
    expect(invii[invii.length - 1].apple_id).toBe("dany@icloud.com");
    expect(pulsante(f).textContent).toBe("Salva collegamento Apple");
    expect(pulsante(f).disabled).toBe(false);
  });

  it("una password nella forma giusta parte al primo invio e non mostra avvisi", async () => {
    const f = formApple();
    scrivi(f, "abcd-efgh-ijkl-mnop");
    expect(avviso(f)!.hidden).toBe(true);
    const prima = invii.length;

    invia(f);
    await accoda();
    expect(invii.length).toBe(prima + 1);
    expect(pulsante(f).textContent).toBe("Salva collegamento Apple");
  });

  it("se l'invio fallisce la conferma non resta attiva", async () => {
    const f = formApple();
    scrivi(f, "PasswordDiApple1!");
    const finto = globalThis.fetch as unknown as {
      mockImplementationOnce: (fn: () => Promise<unknown>) => void;
    };
    finto.mockImplementationOnce(async () => json({ error: "Rete non raggiungibile." }, 400));

    invia(f); // primo colpo: avviso, nessuna richiesta
    await accoda();
    invia(f); // secondo: parte e fallisce
    await accoda();
    expect(f.querySelector(".error")!.textContent).toBe("Rete non raggiungibile.");
    expect(pulsante(f).textContent).toBe("Salva collegamento Apple");

    // Il tentativo successivo deve tornare a chiedere conferma.
    invia(f);
    await accoda();
    expect(pulsante(f).textContent).toBe("Invia comunque");
  });
});
