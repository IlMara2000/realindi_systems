# Sito freelancer + gestionale REALINDI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (esecuzione nativa già autorizzata dall'utente: "procedi senza intoppi, ti autorizzo tutto"). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trasformare realindi-systems.vercel.app in sito pubblico freelance (vetrina + `/bio`) con dietro il CRM esistente spostato su `/app`, esteso con Note e Calendario/Planner sincronizzati a Google Calendar/Gmail e Apple (CalDAV/SMTP/IMAP), in stile neumorfismo+brutalism.

**Architecture:** SPA statica esistente (`public/` + `src/handler.ts` if-chain su `path`, Prisma/Postgres su Vercel). Il CRM `index.html` viene rinominato `app.html` (radice `/` = nuovo sito statico); nuovi modelli Prisma `Note`, `CalendarEvent`, `EventLink`, `SyncState`; nuovi moduli TS `crypto/notes/events/integrations/sync/email`; sync pull-on-open + outbound immediato con merge LWW e link per provider; credenziali cifrate AES-256-GCM in `settings`.

**Tech Stack:** TypeScript, Prisma 7 (Postgres), vitest + `scripts/dev-server.ts` (harness HTTP reale), HTML/CSS/JS vanilla (CSP `default-src 'self'`, niente CDN), `fast-xml-parser` (CalDAV), nuove dipendenze: `nodemailer` (SMTP Apple), `imapflow` (IMAP Apple).

**Spec:** `docs/superpowers/specs/2026-11-03-realindi-sito-gestionale-design.md`

## Global Constraints

- CSP invariata: nessun CDN, nessun font/immagine esterna; solo file in `public/`.
- UI interamente in italiano; nessun dato personale inventato: copy pubblico = placeholder segnalato; indirizzo mittente inserito dall'utente in Impostazioni.
- API esistenti e flusso `/book/:slug` **invariati**; i 12 test esistenti restano verdi (`npm test`).
- Convenzione campi API/DB `snake_case` (come lo schema attuale); endpoint autenticati via cookie `crm_session`, 401 senza sessione; nessun secret in risposta, log o `NEXT_PUBLIC_*`.
- Finestra sync −1 mese/+4 mesi con filtri (`fromGmail|birthday|outOfOffice|workingLocation` esclusi), paginazione, nessun full-sync (Vercel Hobby).
- Segreti in `settings` cifrati con `INTEGRATIONS_KEY` (AES-256-GCM, formato `v1:<iv>:<tag>:<ct>` base64). Key assente/cambiata ⇒ `connected:false` + "Riconnetti", mai crash.
- `/` = sito, `/app` = CRM, `/bio` = link-in-bio, `/book/*` = booking (destinazione `app.html`).

## Review Focus

Ogni riga ha il test che la pina, nel task che possiede il codice.

1. **Endpoint nuovi non autenticati per sbaglio** → Task5/6/7/9: `public: true` deve dare 401 su notes/events/sync/integrations/email; unica eccezione `GET /api/site` (Task3).
2. **Rottura routing dopo il rename** (`/`, `/app`, `/book`, asset) → Task1: test che assicura i marcatori delle quattro route + asset statici.
3. **OAuth callback Google** (`state` forzato, `error` da Google, cambio code) → Task7: test con fetch mockato: state errato → 403; scambio fallito → `connected:false` senza token parziali.
4. **Conflitti/collassi sync** (LWW, 410 GONE, ETag 412, provider giù) → Task8: test funzionali `mergeRemote` (LWW), reset token su 410, `errors[]` in risposta con dati locali intatti; risposta sync **mai** contiene secret.
5. **Segreti** (key assente, ciphertext manomesso, leak in status) → Task2/7: roundtrip, tamper → errore, `GET /api/integrations/status` non contiene mai token/password (asserzione `not.toContain` su chiavi note).

---

### Task 1: Routing statico — rename CRM, route pubbliche, vercel.json

**Files:**
- Rename: `public/index.html` → `public/app.html` (contenuto CRM invariato)
- Create: `public/site.html` (placeholder con `id="site-root"` e `<title>REALINDI SYSTEMS</title>`), `public/bio.html` (placeholder `id="bio-root"`), `public/site.css`, `public/site.js` (vuoti)
- Modify: `src/handler.ts:83-101` (`MIME`, `STATIC_FILES`, `serveStatic`), `vercel.json` (rewrites), `public/app.js` (link interni `"/"` → `"/app"`, logo/home/logout)
- Test: `tests/site.test.ts`

**Interfaces:**
- `serveStatic(path)` → mappa: `/`→`index.html`, `/bio`→`bio.html`, `/app` e `/book/*`→`app.html`; `STATIC_FILES` include `/site.css`, `/site.js`.
- `vercel.json`: `{"source":"/app","destination":"/app.html"}`, `{"source":"/bio","destination":"/bio.html"}`, `{"source":"/book/:slug*","destination":"/app.html"}` (sostituisce `/index.html`); `/api/(*)` invariato.

- [ ] **Step 1: test di routing (fallito)** — `tests/site.test.ts` con `startServer`/`makeClient` come `crm.test.ts`: `GET /` → 200 + `bytes.toString()` contiene `id="site-root"`; `GET /app` → contiene `id="root"`; `GET /bio` → `id="bio-root"`; `GET /book/prova` → `id="root"`; `GET /site.css` e `/style.css` → 200.
- [ ] **Step 2: esegui e verifica FAIL** — `npx vitest run tests/site.test.ts` → FAIL (404 su `/` o file mancanti).
- [ ] **Step 3: implementa** rename + `serveStatic`/`MIME`/`STATIC_FILES` + rewrites + fix link `app.js` (`grep -n 'href="/"\|"/" ' public/app.js`; logo → `/app`).
- [ ] **Step 4: verifica PASS** — `npx vitest run tests/site.test.ts` + `npx tsc --noEmit`.
- [ ] **Step 5: Commit** — `feat: routing sito pubblico, CRM su /app, bio su /bio`

### Task 2: Prisma — modelli Note/CalendarEvent/EventLink/SyncState + crypto

**Files:**
- Modify: `prisma/schema.prisma` (coda), `tests/helpers.ts` (`resetDb` TRUNCATE)
- Create: `src/crypto.ts`
- Test: `tests/integrations.test.ts`

**Interfaces:**
```prisma
model Note { id Int @id @default(autoincrement()); title String; body String @default(""); pinned Boolean @default(false); client_id Int?; project_id Int?; created_at String @default(dbgenerated("to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS')")); updated_at String @default(dbgenerated("to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS')")); @@map("notes") }
model CalendarEvent { id Int @id @default(autoincrement()); title String; start String; end String; all_day Boolean @default(false); description String?; location String?; updated_at BigInt; dirty Boolean @default(true); deleted_at String?; appointment_id Int?; @@map("calendar_events") }
model EventLink { id Int @id @default(autoincrement()); event_id Int; source String; external_id String; etag String?; dirty Boolean @default(true); deleted_at String?; @@unique([source, external_id]); @@map("event_links") }
model SyncState { provider String @id; token String?; calendar_path String?; last_sync_at String?; @@map("sync_state") }
```
- `src/crypto.ts`: `sealSecret(plain: string): string` (usa `process.env.INTEGRATIONS_KEY`, lancia `"INTEGRATIONS_KEY mancante"` se assente); `openSecret(sealed: string): string` (lancia su key assente o decifrazione fallita — tag GCM). Formato `v1:base64(iv):base64(tag):base64(ct)`, key = SHA-256 dell'env.
- `resetDb()`: aggiunge `event_links, calendar_events, notes, sync_state` al TRUNCATE.

- [ ] **Step 1: test (fallito)** — `tests/integrations.test.ts`: roundtrip `sealSecret`→`openSecret` uguale; `openSecret` su stringa manomessa → throw; senza `INTEGRATIONS_KEY` → `sealSecret` throw; test di esistenza tabelle: `sql("SELECT COUNT(*) FROM notes")` (da `helpers`) non lancia.
- [ ] **Step 2: FAIL** — `npx vitest run tests/integrations.test.ts`.
- [ ] **Step 3: implementa** schema + crypto + resetDb; poi `npm run generate` e push schema su DB test: `DATABASE_URL="$(grep '^DATABASE_URL_TEST=' .env | cut -d= -f2-)" npx prisma db push --skip-generate`.
- [ ] **Step 4: PASS + no regressioni** — `npx vitest run tests/integrations.test.ts` e `npm test` (12 esistenti verdi).
- [ ] **Step 5: Commit** — `feat: modelli note/calendario e crittografia segreti`

### Task 3: Endpoint pubblico `/api/site` (booking + bio)

**Files:**
- Modify: `src/handler.ts` (GET/POST in testi pubblici, PRIMA del guard di auth come `/api/booking/`)
- Test: `tests/site.test.ts`

**Interfaces:**
- `GET /api/site` (pubblico, nessun cookie) → `200 { booking_path: "/book/<settings.booking_slug>", bio: { tagline: string, links: [{ id, label, url, section: "main"|"socials"|"contacts", visible: boolean, order }] } }`. `bio` letto da `settings` chiave `site_bio` (JSON); default `{ tagline: "...", links: [] }`.
- `POST /api/site { bio }` (auth) → valida: `tagline` stringa ≤300; ogni link `label` ≤80, `url` inizia con `http://` o `https://`, `section` nel set, `order` intero; salva JSON → `200 { ok: true }`; invalido → 400. Mai salvare URL non http(s) (anti-XSS javascript:).
- Errore formato → `400` con messaggio italiano; nessun dato segreto nel payload.

- [ ] **Step 1: test (fallito)** — in `tests/site.test.ts`: GET pubblico 200 con `booking_path` che inizia `/book/`; GET senza bio salvato → `bio.links` array vuoto; POST senza cookie → 401; POST autenticato con link valido → 200 e GET riflette label/url/section; POST con `url: "javascript:alert(1)"` → 400.
- [ ] **Step 2: FAIL** — `npx vitest run tests/site.test.ts`.
- [ ] **Step 3: implementa** in `src/handler.ts` (helper `getBio()/saveBio()` letti da `settings`).
- [ ] **Step 4: PASS** — `npx vitest run tests/site.test.ts` + `npx tsc --noEmit`.
- [ ] **Step 5: Commit** — `feat: endpoint pubblico sito/bio con validazione URL`

### Task 4: Sito pubblico + pagina `/bio` (HTML/CSS/JS neo-brutalist)

**Files:**
- Modify: `public/index.html` (creato in Task1: sezioni reali), `public/bio.html`, `public/site.css`, `public/site.js`
- Test: `tests/site.test.ts` (asserzioni contenuto)

**Interfacce:**
- Sezioni index.html (in ordine): top strip (`REALINDI SYSTEMS` + link `Area riservata` → `/app`), hero (h1 + CTA `Prenota un incontro` href = `booking_path` da `/api/site`), `01 / SERVIZI` (4 righe numerate placeholder: Sviluppo web, Consulenza software, Automazione, Design — copy placeholder segnalato con `<!-- placeholder -->`), `02 / CHI SONO`, `03 / LAVORI` (3 card placeholder), `04 / CONTATTI` (CTA email placeholder + link `/bio`), footer (© REALINDI SYSTEMS, `/app`, `/privacy`… inesistente → solo `/app` e `/bio`).
- `site.js` (DOMContentLoaded): `fetch("/api/site")` → imposta href CTA booking, render link bio (visibili, ordinati, sezioni) su `bio.html`, `copy link` con `navigator.clipboard` + feedback testuale; nessun altro dato.
- `site.css`: tokens `:root` neo-brutalist — `--ink:#111` (bordi), `--paper:#fff`, `--bg:#f5f6f3`, `--green:#276247`, `--lime:#d2ed98`, bordo `2px solid #111`, ombre dure `6px 6px 0 #111` su CTA/card strutturali, card neumorfiche `box-shadow: -6px -6px 12px #fff9, 6px 6px 12px #00014` (definite una volta in `.card-neo`), bottoni con press (`transform: translate(3px,3px)` + ombra ridotta), display `font-weight:900; text-transform:uppercase; letter-spacing:-0.02em`, etichette `ui-monospace`, righe numerate `01/` in mono. Responsive 320-1440, `prefers-reduced-motion` rispettato, focus visibile.
- Nessun JS per la home oltre `site.js`; bio renderizzata lato JS con escape (`textContent`, mai `innerHTML` con dati).

- [ ] **Step 1: test contenuto (fallito)** — `tests/site.test.ts` aggiunte: `GET /` contiene `01 / SERVIZI` e `Area riservata`; `GET /bio` contiene `id="bio-root"` e `<script src="/site.js">`; `GET /site.css` contiene `--green:#276247`.
- [ ] **Step 2: FAIL**.
- [ ] **Step 3: implementa** HTML/CSS/JS (copy italiano placeholder, nessuna risorsa esterna).
- [ ] **Step 4: PASS** — `npx vitest run tests/site.test.ts`.
- [ ] **Step 5: Commit** — `feat: sito pubblico e link-in-bio in stile neo-brutalista`

### Task 5: `/api/notes` CRUD

**Files:**
- Create: `src/notes.ts`
- Modify: `src/handler.ts`
- Test: `tests/notes.test.ts`

**Interfaces:**
- `GET /api/notes` (auth) → `{ notes: [{ id, title, body, pinned, client_id, project_id, created_at, updated_at }] }` ordinati `pinned desc, updated_at desc`.
- `POST /api/notes` (auth) body `{ id? } & { title, body?, pinned?, client_id?, project_id? }`: senza `id` → crea; con `id` → update (404 se inesistente); `title` stringa non vuota ≤200, `body` ≤20000, `client_id/project_id` devono esistere (400 altrimenti); `updated_at` aggiornato.
- `POST /api/notes/delete { id }` (auth) → `200 { ok: true }` / 404.

- [ ] **Step 1: test (fallito)** — `tests/notes.test.ts` con `fresh()`: 401 pubblico su GET/POST/delete; CRUD completo (create → GET riflette → update pin → delete → GET vuoto); `client_id: 999` → 400; `title: ""` → 400.
- [ ] **Step 2: FAIL**.
- [ ] **Step 3: implementa** (`src/notes.ts` con funzioni pure `validateNote(input)` + handler routes).
- [ ] **Step 4: PASS** — `npx vitest run tests/notes.test.ts` + `npx tsc --noEmit`.
- [ ] **Step 5: Commit** — `feat: sezione note con CRUD autenticato`

### Task 6: `/api/notes` + `/api/events` con merge appuntamenti e proiezione prenotazioni

**Files:**
- Create: `src/events.ts`
- Modify: `src/handler.ts`, `src/booking.ts` (hook al booking)
- Test: `tests/events.test.ts`

**Interfaces:**
- `GET /api/events?from=YYYY-MM-DD&to=YYYY-MM-DD` (auth) → `{ events: [...] }` unito: `kind:"event"` (CalendarEvent non cancellati con i loro `links[]`), `kind:"appointment"` (Appointment `start` nel range, con `status`, `read_only:false` — gestibile con endpoint esistenti), `kind:"block"` (Block nel range). Ordinati per `start`.
- `POST /api/events` (auth) `{ id? , title, start, end, all_day?, description?, location? }` → crea/aggiorna `CalendarEvent` con `updated_at = Date.now()`, `dirty=true`; validazione: `title` ≤200, date ISO parseabili, `end >= start` (400 altrimenti).
- `POST /api/events/delete { id }` (auth) → `deleted_at` tombstone + `dirty=true` sui link (la rimozione fisica avviene a fine sync).
- Booking hook: dopo creazione `Appointment` (in `src/booking.ts`) → crea `CalendarEvent` (`title: "Appuntamento: <nome>"`, start/end dell'appointment, `appointment_id`, `dirty=true`); su `cancel-booking` → tomba l'evento collegato.

- [ ] **Step 1: test (fallito)** — `tests/events.test.ts`: 401 pubblico; create evento → GET con `from/to` lo include e `kind:"event"`; update riflette; booking pubblico (come in `crm.test.ts`) → compaiono `kind:"appointment"` **e** `kind:"event"` con `appointment_id`; cancel → evento tombato (non più in GET); `end < start` → 400; delete → tombstone.
- [ ] **Step 2: FAIL**.
- [ ] **Step 3: implementa** `src/events.ts` (query range, merge, validazione) + hook booking.
- [ ] **Step 4: PASS** — `npx vitest run tests/events.test.ts` + `npm test` (regressione booking/esistenti).
- [ ] **Step 5: Commit** — `feat: calendario eventi con proiezione appuntamenti booking`

### Task 7: Integrazioni — status, OAuth Google, credenziali Apple

**Files:**
- Create: `src/integrations.ts`
- Modify: `src/handler.ts`
- Test: `tests/integrations.test.ts`

**Interfaces:**
- `GET /api/integrations/status` (auth) → `{ key_configured: boolean, google: { connected: boolean, email?: string, needs_reauth?: boolean }, apple: { connected: boolean, email?: string }, sender: string }` — **mai** token/password/refresh nel payload.
- `GET /api/integrations/google/connect` (auth) → `{ url }` con `client_id=GOOGLE_CLIENT_ID`, scope `https://www.googleapis.com/auth/calendar.events openid email`, `redirect_uri=<origin>/api/integrations/google/callback`, `state=<nonce salvato in settings con scadenza 10 min>`, `access_type=offline`, `prompt=consent`. Se `GOOGLE_CLIENT_ID` o `INTEGRATIONS_KEY` assenti → 400 `"Configurazione Google mancante."`.
- `GET /api/integrations/google/callback?state&code|error` (auth) → `error` o state errato → 403 (nessun salvataggio); `code` → POST `https://oauth2.googleapis.com/token` (fetch) → salva `{ access_token, refresh_token, expires_at, email }` cifrati (`sealSecret(JSON.stringify(...))`, chiavi `int_google` in `settings`) → `302 /app?view=settings&linked=google`; scambio fallito → 400, nessun record parziale. `invalid_grant` in fase refresh → imposta `needs_reauth` (flag in `int_google_status`).
- `POST /api/integrations/apple` (auth) `{ apple_id, app_password, sender_email }` → tenta login IMAP reale (`imapflow`, timeout 10s, solo per questa chiamata) → ok: salva cifrato in `int_apple`; ko: 400 `"Credenziali Apple non valide."`. `POST /api/integrations/apple/delete { }` → rimuove. `sender_email` validato `^Reply pattern email` e salvato in `settings` chiave `email_sender` (plain — non è segreto).
- Refresh token Google: helper `googleTokens()` in `src/integrations.ts` → access token valido o refresh (salva nuovo cifrato) o `needs_reauth`.

- [ ] **Step 1: test (fallito)** — con `vi.stubEnv("GOOGLE_CLIENT_ID", …)`, `INTEGRATIONS_KEY=test-key…`, `vi.stubGlobal fetch` (o `vi.mock` del modulo fetch): status senza setup → tutti `connected:false` e `key_configured:true`, `expect(JSON.stringify(body)).not.toContain("refresh")`; connect → URL contiene scope calendar.events; callback con `state` sbagliato → 403 e status resta `connected:false`; callback con exchange mockato 200 → status `connected:true` e settings contiene solo stringhe `v1:` (assert non contiene il fake refresh token in chiaro); exchange 400 → 400 e `connected:false`; apple con login mockato ko → 400; apple ok → `connected:true` e `sender` = `sender_email`; senza `INTEGRATIONS_KEY` → status `key_configured:false` e connect 400.
- [ ] **Step 2: FAIL** — `npx vitest run tests/integrations.test.ts`.
- [ ] **Step 3: implementa** `src/integrations.ts` + route (callback pubblica solo in sessione esistente; nessun log del body).
- [ ] **Step 4: PASS** — `npx vitest run tests/integrations.test.ts` + `npx tsc --noEmit`.
- [ ] **Step 5: Commit** — `feat: integrazioni Google OAuth e credenziali Apple cifrate`

### Task 8: Engine di sync calendario

**Files:**
- Create: `src/sync.ts` (funzioni pure di merge + IO provider)
- Modify: `src/handler.ts` (`POST /api/sync/calendar`)
- Test: `tests/sync.test.ts`

**Interfaces:**
- Pure (testate senza rete): `mergeRemote(local: CalendarEvent|null, remote: RemoteEvent): "create"|"update"|"skip_local_wins"|"skip"` — LWW: se local non esiste → create; `local.dirty` → `skip_local_wins`; altrimenti se `remote.updated_at > local.updated_at` → update, altrimenti `skip`. `windowRange(now)` → `from = now-1m`, `to = now+4m`. `isImportable(remote)` → false per `eventTypes` Google `fromGmail|birthday|outOfOffice|workingLocation`.
- Google IO: `googleList(accessToken, syncToken|null, window)` → `{ events: RemoteEvent[], nextSyncToken?: string }` (`singleEvents:true`, `pageToken` loop, su `410` → riavvia con `syncToken:null`); `googleUpsert/GoogleDelete(accessToken, payload, externalId?, etag?)`.
- CalDAV IO: `caldavDiscover(appleId, appPassword)` → PROPFIND `current-user-principal` → `calendar-home-set` (host partizione **dal risultato**, mai hardcoded) → salva `calendar_path` in `SyncState`; `caldavReport(calendarPath, syncToken|null, window)` (REPORT calendar-query + `sync-token`, XML con `fast-xml-parser`); `caldavUpsert/caldavDelete` con `If-Match` **sempre quotato**.
- `POST /api/sync/calendar` (auth) → esegue outbound (eventi `dirty`: per ogni provider connesso con link → create/update/delete remoto; senza link → create e `external_id` assegnato; `412` → ricarica remoto e applica LWW) poi inbound per ogni provider connesso (merge, `SyncState.token` aggiornato, `last_sync_at`); risposta `{ imported, updated, removed, pending, errors: [{source, message}] }` con messaggi provider sanitizzati (niente URL con credenziali). Se nessun provider connesso → 400 `"Nessun calendario collegato."`.
- Finestra/filtri applicati come Global Constraints; se `INTEGRATIONS_KEY` assente → nessuna lettura credenziali (status `connected:false` → skip).

- [ ] **Step 1: test (fallito)** — `tests/sync.test.ts`: (a) `mergeRemote`: create/skip_local_wins/update/skip con timestamp noti; (b) `isImportable` esclude i 4 tipi; (c) `windowRange` = −1m/+4m; (d) integrazione con provider mockati (`vi.mock` di `./sync`-IO o fetch iniettato): sync dopo create locale → chiamata `googleEventsInsert` invocata e `dirty:false`; risposta contiene `errors:[{source:"icloud", message:…}]` quando il provider lancia **e** gli eventi locali restano; risposta JSON non contiene `"app_password"`; 410 Google → seconda chiamata con `syncToken:null`; `caldavUpsert` riceve etag citato (assert `If-Match` con virgolette); nessun provider → 400.
- [ ] **Step 2: FAIL**.
- [ ] **Step 3: implementa** `src/sync.ts` (pure prima, IO con `fetch` accettato come dipendenza per il mock) + route.
- [ ] **Step 4: PASS** — `npx vitest run tests/sync.test.ts` + `npx tsc --noEmit`.
- [ ] **Step 5: Commit** — `feat: sync calendario bidirezionale Google/iCloud`

### Task 9: Email — invio SMTP Apple e inbox

**Files:**
- Create: `src/email.ts`
- Modify: `src/handler.ts`
- Test: `tests/email.test.ts`

**Interfaces:**
- `POST /api/email/send` (auth) `{ to, subject, body, ics?: { title, start, end } }` → valida email destinataria, soggetto ≤200, testo ≤10000; se `ics` → allegato `text/calendar` generato con helper esistente ICS (stesso formato di booking, UID deterministico); mittente = `settings.email_sender`; spedizione con `nodemailer` → `smtp.mail.me.com:587`, auth `apple_id`/`app_password` decifrati da `int_apple`. Apple non collegato → 400 `"Collega prima l'account Apple."`. Risposta `{ ok: true }`; errore SMTP → 502 con messaggio sanitizzato (mai credenziali).
- `GET /api/email/inbox` (auth) → `{ provider: "apple"|"gmail", messages: [{ id, from, subject, date, snippet }] }` max 20, ordinati per data desc; solo envelope + snippet ≤200 (mai corpo); Apple collegato → IMAP (`imapflow`, `imap.mail.me.com:993`, cartella INBOX, fetch envelope); altrimenti Google collegato → Gmail API `users.messages.list?maxResults=20` + `format=metadata` (headers From/Subject/Date) + snippet; nessun provider → 400 `"Collega un account email."`.
- i default: priorità Apple (mittente scelto) — Gmail usato solo in lettura se Apple assente.

- [ ] **Step 1: test (fallito)** — con `vi.mock("nodemailer")` (createTransport→sendMail) e `vi.mock("imapflow")`: 401 pubblico; senza Apple → send 400; send ok → `sendMail` invocato con `from === email_sender` e con allegato `.ics` quando richiesto; `to` non valido → 400; inbox senza provider → 400; inbox con Apple mock → 20 campi `snippet` ≤200 e nessuna chiave del payload somiglia a `app_password`; inbox con solo Google (fetch mockato con lista+metadata) → provider `"gmail"`.
- [ ] **Step 2: FAIL**.
- [ ] **Step 3: implementa** `src/email.ts` (`buildIcs` riusa convenzioni esistenti) + route.
- [ ] **Step 4: PASS** — `npx vitest run tests/email.test.ts` + `npm test` intero.
- [ ] **Step 5: Commit** — `feat: invio email con ICS e inbox via Apple/Google`

### Task 10: Gestionale — shell a viste laterali, vista Note e Calendario/Planner

**Files:**
- Modify: `public/app.js` (nav + 2 viste), `public/style.css` (tokens neo-brutalist shell + `.nav-rail`), `public/app.html` (solo se serve mount point/title)
- Test: nessun test JS nuovo (asserzione HTML opzionale in `tests/site.test.ts` su `/app` che contiene `id="root"` — già coperto); verifica manuale strutturale: `grep` dei marker

**Interfacce:**
- Nav rail: elenco viste esistente + `Note` e `Calendario`; `activeView` segue lo stile UTTF (`view=settings` accettabile da query, usato dal callback OAuth: leggere `location.search` all'avvio).
- Vista `notes`: lista con pin in alto, ricerca per titolo, editor (nuova/modifica/elimina), aggancio cliente/progetto da select caricata da `state.clients/projects`, azione `Invia via email` → `POST /api/email/send` con body della nota (prompt destinatario in modal esistente).
- Vista `calendar`: mese corrente (griglia lun-dom, IT), navigazione ◀ ▶, eventi/uniti da `GET /api/events?from&to` con badge per `kind`; click giorno → creazione evento; editor evento (titolo/startDate/endDate/allDay/description/location) → `POST /api/events`; delete → tomba; sotto la griglia **planner**: lista prossimi 14 giorni con appuntamenti (con stato, annullamento via endpoint esistente) e blocchi; bottone `Sincronizza` → `POST /api/sync/calendar` con toast su `{imported, updated, removed, errors}`; chip stato provider da `GET /api/integrations/status` (`Google ✓ / Apple —`).
- Nessuna emoji (coerente con lo stile): solo testo, frecce Unicode `◀ ▶` e icone già presenti (lucide non esiste qui: usare caratteri testuali).
- CSS shell: barra laterale fissa (desktop), drawer su mobile, card `.card-neo` per pannelli, bottoni con press brutalist, palette invariata `--green/--lime` + bordi `#111`.

- [ ] **Step 1: implementa** nav + vista notes + vista calendar/planner + CSS (markup HTML creato via JS con `textContent`, nessun `innerHTML` con dati utente).
- [ ] **Step 2: verifica strutturale** — `grep -n "activeView.*notes\|api/sync/calendar\|api/notes" public/app.js` (presenza) e `npx vitest run tests/site.test.ts`.
- [ ] **Step 3: smoke browser locale** — `npm run dev` (dev-server su porta effettiva) + `register_preview`: `/` render, `/bio`, login `/app`, viste Note e Calendario aprono, nessun errore console.
- [ ] **Step 4: Commit** — `feat: gestionale con note e calendario/planner neo-brutalist`

### Task 11: Pannelli Impostazioni — Integrazioni, Mittente, Sito & Bio

**Files:**
- Modify: `public/app.js` (sezioni in `view=settings`), `public/style.css`
- Test: verifica strutturale + smoke

**Interfacce:**
- `Integrazioni`: stato da `GET /api/integrations/status`; bottone `Collega Google` → `window.location = url` (da `/connect`); callback torna con `?view=settings&linked=google` → toast; `needs_reauth` → bottone `Riconnetti Google`; Apple: form `apple_id`, `app_password` (type password, mai riletta dal server), `sender_email` → `POST /api/integrations/apple`; bottone `Disconnetti`; form mittente mostrato come campo di `settings.email_sender`.
- `Sito & Bio`: editor link bio (label, url, section, visible, order con ↑↓), tagline, salva → `POST /api/site { bio }`; anteprima link a `/bio`.
- Errori API italiani in toast, stato di caricamento sui bottoni, nessun secret renderizzato (i campi Apple sono write-only in UI).

- [ ] **Step 1: implementa** i due pannelli.
- [ ] **Step 2: verifica** — grep marker (`integrations/google/connect`, `api/site` in app.js) + `npx vitest run tests/site.test.ts`.
- [ ] **Step 3: smoke browser** — dev server: collegamento Google genera URL (errore 400 accettabile senza env), form Apple valida input, editor bio salva e `/bio` riflette (mock env).
- [ ] **Step 4: Commit** — `feat: pannelli integrazioni, mittente e editor sito/bio`

### Task 12: Verifica completa, build, deploy

**Files:**
- Modify: `.env.example` (nuove variabili documentate: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `INTEGRATIONS_KEY`), `README.md` (sezioni nuovo sito + integrazioni)

- [ ] **Step 1: controlli** — `npx tsc --noEmit` (exit 0) → `npm test` (tutti i file verdi: 12 esistenti + nuovi) → `npm run build` (generate + db push + tsc, exit 0).
- [ ] **Step 2: smoke locale completo** — dev server + preview browser: `/` (320/768/1440, nessun overflow), `/bio`, login `/app`, tutte le viste incluse Note/Calendario, `/book/<slug>` ancora pubblico; log console puliti.
- [ ] **Step 3: deploy preview** — `npx vercel deploy` → controlli HTTP: `GET /` 200 `text/html` marker sito; `GET /app` 200 marker CRM; `GET /book/x` 200; `GET /api/site` JSON pubblico; `GET /api/state` 401; CSP header invariati.
- [ ] **Step 4: commit + deploy prod** — `npx vercel deploy --prod` (autorizzato) → stessi check su `realindi-systems.vercel.app` + `git commit` doc/README.
- [ ] **Step 5: report finale** all'utente: cosa va configurato (progetto Google Cloud Production con i due ID env, `INTEGRATIONS_KEY` su Vercel, password specifica Apple) con i passi esatti.
