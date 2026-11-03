# Design — Sito freelancer + gestionale REALINDI (note, calendario/planner, integrazioni)

Data: 2026-11-03 · Stato: **approvato** dall'utente (autorizzazione piena del 2026-11-03; mockup visivi rinunciati dall'utente — da mobile)
Repo: REALINDI SYSTEMS · Deploy target: https://realindi-systems.vercel.app

## Intento

Trasformare `realindi-systems.vercel.app` da "CRM a tutto schermo" in un **sito da freelancer** completo: vetrina pubblica + link-in-bio dietro cui vive il **gestionale già presente** (il CRM REALINDI), esteso con le due sezioni che mancano — **Note** e **Calendario/Planner** — collegate a **Google (Gmail + Google Calendar)** e **Apple (Apple Mail/iCloud)**. Il tutto con uno stile **neumorfismo misto a brutalismo**. La struttura pubblica e la struttura del gestionale si ispirano a quanto verificato su uttf.vercel.app e nel progetto UTTF locale (dashboard con viste laterali, Note `NotesManager`, Calendario con `CalendarWidget`+`ShiftPlanner`+`Planner`).

## Goals

1. Sito pubblico in `/` con struttura "sito per un freelancer": hero, servizi (righe numerate), chi sono, lavori, contatti/CTA, footer. Contenuti in italiano, placeholder segnalati dove servono dati reali.
2. Pagina **link-in-bio** in `/bio` (identità, link impilati, social, contatti), stile UTTF `/bio`, editabile dal gestionale.
3. Gestionale spostato in `/app`: **tutte le funzioni attuali intatte** (clienti, progetti, preventivatore, fatture FPR12, documenti, prenotazioni `/book`, dashboard, impostazioni, backup) + shell con viste laterali stile dashboard UTTF.
4. Nuove sezioni nel gestionale: **Note** (CRUD, opzionalmente agganciate a cliente/progetto, pin) e **Calendario/Planner** (vista mensile + lista planner, unifica Appuntamenti esistenti, Blocchi e nuovi eventi).
5. **Sync calendario bidirezionale** con Google Calendar (OAuth2) e iCloud Calendar (CalDAV): eventi letti e rispecchiati in entrambi i versi.
6. **Email**: invio dalla sezione Note/Calendario (condividi nota, invito evento `.ics`) e lettura inbox recente, via Gmail API (OAuth2) e Apple (SMTP/IMAP con password specifica Apple ID).
7. Design **neumorfismo + brutalism** su sito pubblico e gestionale (tokens condivisi).
8. Integrazioni in **degradazione graziosa**: senza credenziali, i pannelli mostrano "Collega account" e tutto il resto funziona.
9. I 12 test esistenti restano verdi; nuovi test sui nuovi endpoint e sulla logica di sync.

## Non-goals / Anti-goals

- Non si riscrive il frontend in Next.js (strada B scartata).
- Niente webhook/push real-time Google v1 (sync on-open + outbound immediato).
- Niente multi-tenant, niente account multipli per provider (1 Google + 1 Apple per installazione).
- Non si tocca la logica fiscale/fatture/preventivi né `data/crm.sqlite3` del server Python locale.
- Non si viola la CSP attuale (`default-src 'self'`): nessun CDN, font/immagini solo locali o inline.
- Non si inventano dati personali reali: copy pubblico = placeholder esplicito, editabile dall'utente.
- `/book/:slug` e i link già condivisi devono continuare a funzionare.

## Vincoli

- Stack esistente: SPA statica (`public/index.html` + `app.js` 1052 righe + `style.css` 1172 righe) + API TypeScript in `src/handler.ts` (910 righe, if-chain su `path`) + Prisma 7 (Postgres su Vercel) + `api/index.ts` entry. Deploy: `npx vercel deploy --prod`.
- Oggi `handler.ts` serve `index.html` per `/` e `/book/*` — va esteso per le nuove pagine statiche.
- Serverless Vercel: nessun processo in background ⇒ la sync gira su richiesta.
- Modelli Prisma attuali: Setting, Session, Client, Project, Quote, Invoice, Document, Appointment, Block, LoginAttempt.
- Dipendenze già presenti utili: `fast-xml-parser` (XML CalDAV), `pg`/Prisma.
- Credenziali utente necessarie: `GOOGLE_CLIENT_ID/SECRET` (progetto Google Cloud dell'utente, **app OAuth pubblicata in Production** come da sua scelta), `APPLE_ID` + password specifica Apple ID, `INTEGRATIONS_KEY` (chiave AES-256-GCM per crittografare i token in DB). Senza queste: integrazioni disabilitate con UI "Collega account".
- Lingua UI: italiano. Test: `npm test` (vitest, 12 esistenti).
- Assunto piano **Vercel Hobby**: sync limitata a finestra + paginazione, nessuna invocazione che rischi il full-sync di calendari grandi (limite payload 4.5MB).

## Approcci considerati

- **A — Stendere su quello che c'è (SCELTO)**: stessa SPA statica + stesso backend TS/Prisma. Nuove pagine pubbliche statiche, nuove viste nel gestionale, nuovi moduli di sync in TS. Pro: funzioni intatte, 12 test verdi, pipeline deploy già provata. Contro: `app.js` cresce (si splitta in moduli se servono).
- **B — Riscrittura Next.js stile UTTF (SCARTATO)**: coerenza "gratis" ma rischio alto su logica fiscale/preventivi maturati, tempi ~3×, contraddice "mantenendo le funzioni attuali".

Motivo della scelta di A: l'utente ha risposto esplicitamente "mantenendo le funzioni attuali" e ha confermato la strada A.

## Decisioni assunte (e qui documentate come mie call, salvo correzione)

1. **Routing**: `/` = sito pubblico (`site.html`), `/bio` = link-in-bio (`bio.html`), **CRM da `/` a `/app`** (`index.html`, che resta servito anche per `/book/*`), redirect/niente rotti: `app.js` tratta `/app` come CRM root e `/book/*` come booking (logica già esistente). Link "Area riservata" nel sito pubblico → `/app`. Conseguenza accettata: i vecchi bookmark su `/` mostrano il sito vetrina (un click su «Area riservata» riapre il CRM); `/book/:slug` e le API non cambiano percorso.
2. **Nuovi modelli Prisma**:
   - `Note`: id, title, body, pinned, clientId?, projectId?, createdAt, updatedAt.
   - `CalendarEvent`: id, source (`local|google|icloud`), externalId?, title, start, end, allDay, description?, location?, updatedAt, tombstone (deletedAt?). Gli `Appointment` esistenti restano la fonte per la prenotazione pubblica; il calendario li visualizza e può legare un evento al loro stato (nessuna migrazione dei dati esistenti).
   - Credenziali integrative: nella tabella `Setting` esistente, **cifrate AES-256-GCM** con `INTEGRATIONS_KEY`; se la chiave manca o non decifra più (chiave cambiata/persa), le integrazioni risultano discollegate con prompt «Riconnetti», senza crash. Nessuna rotazione prevista: la chiave è stabile per la vita dell'installazione.
   - `SyncState`: provider PK, syncToken/ctag di Google/CalDAV, lastSyncAt — evita full sync a ogni apertura; `410 GONE` Google → reset a full sync. (Aggiunto su segnalazione del builder-check.)
3. **Endpoint nuovi** (stesso stile if-chain): `/api/notes` (CRUD), `/api/events` (CRUD + merge), `/api/sync/calendar` (pull), `/api/integrations/status|google/connect|google/callback|apple`, `/api/email/send`, `/api/email/inbox`. Tutti autenticati con sessione (401 senza login): **nessuna route pubblica** (`/`, `/bio`, `/book`) tocca mai `/api/email/*` o `/api/events`.
4. **Engine di sync** (pull-on-open + outbound immediato):
   - **Finestra e filtri**: si importa solo la finestra **−1 mese / +4 mesi**, escludendo gli `eventTypes` Google `fromGmail|birthday|outOfOffice|workingLocation`; paginazione (`nextPageToken`/`syncToken`) entro i limiti Vercel (piano Hobby assunto — nessuna full sync dello storico).
   - **Calendari sincronizzati**: Google = calendario `primary`; iCloud = **calendario predefinito** dell'account, scoperto con discovery CalDAV (`PROPFIND current-user-principal` → `calendar-home-set`; host partizione per-account, **mai hardcoded**, path persistiti in `SyncState`). Esclusi `schedule-inbox` e collezioni read-only.
   - **Inbound**: all'apertura del calendario o con «Sincronizza» → Google `calendars.events.list` + CalDAV `REPORT calendar-query` (XML con `fast-xml-parser`). Merge per `externalId`, dedup.
   - **Conflitti**: last-write-wins su `updatedAt` locale — scelta documentata (strumento personale, perdita accettata in caso di doppia modifica simultanea); su CalDAV `If-Match` **sempre quotato** (ETag) per non far bloccare la sync con 412.
   - **Outbound**: creazione/modifica/cancellazione locale → push immediato al provider se l'evento ha `externalId` (ETag/`If-Match` per CalDAV), altrimenti solo locale; ritentato alla sync successiva. **Gli `Appointment` di `/book` vengono proiettati**: al booking nasce un `CalendarEvent` shadow (`source=local`) pushato ai provider, l'annullamento lo cancella — l'appuntamento prenotato arriva sul calendario reale.
   - Nessun webhook v1.
5. **Email**: **invio = solo SMTP Apple** `smtp.mail.me.com:587` con password specifica Apple ID (mittente = indirizzo iCloud scelto dall'utente, campo configurabile in Impostazioni, reply-to identico; nessun indirizzo inventato dal builder). Dopo questa scelta si elimina lo scope `gmail.send`: l'OAuth Google resta per il calendario (+ `gmail.readonly` opzionale per l'inbox). Inbox recente = Gmail API + IMAP Apple (`imap.mail.me.com`). Invito evento = allegato `.ics` (generazione ICS già esistente per booking). Nuove dipendenze: `nodemailer` (SMTP Apple) + `imapflow` (IMAP). Google OAuth: REST raw con `fetch` (niente `googleapis`). Inbox: **solo dentro `/app`**, ultimi 20 messaggi, mittente/oggetto/data/snippet (mai corpo completo), sola lettura.
6. **Design system neo-brutalista + neumorfico** (tokens in `:root`, estesi da `style.css`):
   - Base neumorfica: sfondo tono unico soft, card con doppia ombra chiara/scura, input inset, bottoni con press.
   - Struttura brutalista: bordi neri 2–3px, ombre dure offset senza blur su bordi/CTA, display tipografia ultra-bold/uppercase, etichette mono, righe numerate (01/02/…) e griglie grezze.
   - Palette: identità attuale REALINDI (ink scuro `#20332d`, verde `#276247`, lime `#d2ed98`, paper `#fff`, bg `#f5f6f3`) mantenuta; nero puro per bordi/ombre dure. Font: Inter/system + `ui-monospace` (nessun CDN, per CSP).
   - Shell gestionale: barra laterale viste (Dashboard, Clienti, Progetti, Preventivi, Fatture, Documenti, Appuntamenti, **Calendario**, **Note**, Impostazioni) come la dashboard UTTF (viste `activeView`), overview in alto, superfici piatte miste a card neumorfiche.
7. **Sito pubblico — sezioni** (adattamento freelancer della struttura UTTF): top strip (nome + Area riservata), hero, `01 / SERVIZI` (righe numerate stile lab UTTF), `02 / CHI SONO`, `03 / LAVORI` (card placeholder), `04 / CONTATTI` con CTA "Prenota un incontro" → `/book` (usa la funzione già presente), footer. `/bio`: pannello identità + link (sito/servizi, social, contatti) + azione copia link; contenuti in `Setting`, editabili dal gestionale (pannello "Sito & Bio" in Impostazioni).
8. **Test**: vitest — auth su nuovi endpoint (401 senza sessione), CRUD note, merge sync con provider mockati, round-trip crittografia, invio email mockato, invariante `/book` e `/app` routing. I 12 esistenti restano verdi.

## Decisioni del cliente (2026-11-03)

1. **Google OAuth**: app **pubblicata in Production** sul progetto Google Cloud dell'utente (consent screen External + stato Production; scope `calendar.events` e opzionale `gmail.readonly`). Se Google richiede la verifica degli scope ristretti Gmail, il builder segnala e si procede insieme; nel frattempo l'inbox Gmail degrada con avviso dedicato senza bloccare calendario e resto.
2. **Mittente email**: **indirizzo iCloud** dell'utente → invio via SMTP Apple, reply-to identico, indirizzo inserito dall'utente in Impostazioni → Mittente email.
3. **Vetrina**: brand **REALINDI SYSTEMS** (hero, `/bio`, footer).
4. Look neo-brutalista confermato per autorizzazione piena («procedi senza intoppi»); mockup visivi rinunciati dall'utente da mobile.

## Cosa resta al builder

Ordinamento implementativo, split eventuali di `app.js`, copy definitivo, test.
