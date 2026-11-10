# REALINDI SYSTEMS — Freelancer workspace

[![Verifica](https://github.com/IlMara2000/realindi_systems/actions/workflows/verifica.yml/badge.svg)](https://github.com/IlMara2000/realindi_systems/actions/workflows/verifica.yml)

CRM in italiano per consulenti e sviluppatori indipendenti, con profilo fiscale configurabile dall’azienda. L’obiettivo è un prodotto vendibile: la versione attuale separa le aziende tramite installazioni/database indipendenti, non tramite account multi-tenant nella stessa istanza.

## Versione attuale: sito + gestionale (TypeScript/Vercel)

Il repository contiene la versione deployata su Vercel (`realindi-systems.vercel.app`): SPA statica TypeScript + Prisma/PostgreSQL con interfaccia neomorfista/brutalista. La documentazione Python qui sotto descrive la versione originale del progetto.

| Percorso | Contenuto |
|---|---|
| `/` | Sito pubblico da freelancer (servizi, profilo, contatti), modificabile dalla pagina |
| `/bio` | Link-in-bio, modificabile dalla pagina |
| `/book/<slug>` | Pagina di prenotazione pubblica (senza login) |
| `/app` | Gestionale CRM (login con password del workspace) |

Vetrina e link-in-bio si modificano direttamente dalle pagine: con la sessione del gestionale aperta il server inserisce un pulsante «Modifica» accanto a ogni sezione (senza sessione i bottoni non esistono nel markup). Il salvataggio sostituisce per intero il contenuto precedente — nessun campo viene ereditato — e il contenuto scritto nell'HTML resta la base solo finché non si salva la prima volta. Non ci sono più controlli del sito nelle Impostazioni del CRM.

Oltre alle funzioni originarie, il gestionale include **Note** (CRUD, pin, aggancio a cliente/progetto, invio email) e **Calendario/Planner** (vista mensile, eventi, sincronizzazione bidirezionale con Google Calendar e Apple iCloud).

### Integrazioni Google e Apple

Variabili d’ambiente (opzionali; senza di esse le integrazioni restano disattivate):

| Variabile | Uso |
|---|---|
| `DATABASE_URL` | Connessione PostgreSQL (Prisma) |
| `DATABASE_URL_TEST` | Connessione **modello** per la suite di test: i test girano su un database creato per ogni esecuzione accanto a questo (vedi sotto) |
| `INTEGRATIONS_KEY` | Chiave per cifrare (AES-256-GCM) le credenziali Google/Apple, dei canali WhatsApp/Instagram/SMS e la chiave AI: generane una lunga e casuale e non cambiarla mai dopo il primo collegamento |
| `GOOGLE_CLIENT_ID` | Client OAuth di Google Cloud |
| `GOOGLE_CLIENT_SECRET` | Segreto OAuth di Google Cloud |

**Suite di test (`npm test`).** `DATABASE_URL_TEST` non è il database su cui girano i test: è solo il modello di connessione, da cui la suite ricava host, credenziali e `sslmode`, mentre il nome del database serve solo come punto di partenza. Ogni esecuzione crea accanto a questo un database proprio — `realindi_test_run_<timestamp>_<nonce>` — vi applica le migrazioni di `prisma/migrations` e lo elimina alla fine; quelli rimasti da una run interrotta vengono cancellati al successivo avvio dopo un'ora. Due `npm test` in parallelo non si toccano e il database indicato in `DATABASE_URL_TEST` non viene mai modificato.

Servono due cose: che quel database **esista** (può restare vuoto, nessuna tabella: basta `createdb realindi_test`) e che il ruolo Postgres abbia il privilegio **`CREATEDB`**, perché la suite crea e distrugge database. Con un ruolo senza quel privilegio il primo test si ferma con `permission denied to create database`. La variabile può arrivare anche dall'ambiente invece che dal file `.env` — è il caso della CI — e in quel caso ha la precedenza sul file.

**Google (Calendar + Gmail):** crea un progetto su console.cloud.google.com, attiva le API *Google Calendar* e *Gmail*, crea una credenziale OAuth client di tipo *Web application* con tra i redirect URI autorizzati `https://<dominio>/api/integrations/google/callback`, poi imposta le tre variabili. In Impostazioni → Integrazioni premi **Collega Google**; l’app è in Production, quindi i primi accessi vanno autorizzati utente per utente. Google serve per la sincronizzazione del calendario e per leggere l’inbox Gmail.

**Apple (iCloud — SMTP/IMAP):** su account.apple.com → Accesso e sicurezza → crea una *password specifica per le app*; in Impostazioni → Integrazioni compila Apple ID, password specifica e mittente. Il server verifica il login IMAP prima di salvare (le credenziali restano cifrate e non vengono mai rilette dall’interfaccia). L’invio delle email usa solo Apple SMTP.

### Canali di messaggistica e assistente AI

La pagina **Canali & AI** collega WhatsApp Business, Instagram e SMS (Twilio) direttamente dall'app, senza modificare il codice né riavviare il server. Le credenziali sono cifrate con `INTEGRATIONS_KEY` (AES-256-GCM) e non vengono mai restituite al browser. Ogni installazione (o copia) dell'app ha database e chiave propri: i canali vanno configurati una volta per workspace, con i token di quell'attività.

Cosa include:

- **Collegamento guidato** per i tre provider, con verifica reale delle credenziali e invio di un messaggio di prova.
- **Webhook già pronti**: ogni scheda mostra l'URL da incollare nel pannello del provider, con pulsante Copia. Per Meta il token di verifica è generato dal CRM e mostrato accanto al canale.
- **Inbox unificata** in *Messaggi*: una conversazione per contatto e canale, cronologia completa, risposta manuale, presa in carico e auto-risposta attivabile per canale o per singola conversazione.
- **Auto-apprendimento dal sito**: *Aggiorna conoscenza dal sito* legge la home, `/bio` e le pagine interne collegate, più una scheda attività costruita dalle Impostazioni (nome, contatti, prenotazione, note). I contenuti finiscono in `knowledge_docs` e sono l'unica fonte ammessa per le risposte.
- **Regole di risposta**: nessun prezzo, tempo o promessa inventati; se un dato manca l'assistente chiede i recapiti o propone la call; tono, lingua, firma e limite di lunghezza configurabili; casi ambigui passati al titolare.

#### Collegare WhatsApp Business

1. In Meta for Developers crea un'app di tipo Business e aggiungi il prodotto *WhatsApp*.
2. In WhatsApp → Configurazione API copia **Phone number ID** e genera un **token permanente** (utente di sistema con `whatsapp_business_messaging`).
3. In Canali & AI incolla i due valori e, se vuoi la verifica della firma, l'**App secret** (Impostazioni app → Base).
4. Copia l'URL del webhook mostrato dal CRM in WhatsApp → Configuration → Webhook, incolla il **token di verifica** del CRM e iscriviti al campo `messages`.
5. Premi *Collega*, poi *Invia test* verso il tuo numero. Il cliente può scrivere solo dopo che il numero è attivo e verificato su Meta.

#### Collegare Instagram

Serve un account **professionale** collegato a una Pagina Facebook e un'app Meta con i permessi `instagram_basic`, `instagram_manage_messages` e `pages_manage_metadata`. In Canali & AI inserisci il token della Pagina e l'**ID numerico** dell'account Instagram, copia l'URL del webhook in *Instagram → Webhook* (oggetto `instagram`, campo `messages`) e usa lo stesso token di verifica. Meta richiede la revisione dell'app per rispondere a utenti esterni al team di test.

#### Collegare gli SMS (Twilio)

In Twilio → Numbers → Messaging incolla l'URL del webhook in *A message comes in* (POST), inserisci Account SID, Auth token e numero mittente in formato internazionale. Il CRM verifica la firma `X-Twilio-Signature` usando l'URL esatto con cui Twilio chiama il webhook: se usi un tunnel o un dominio personalizzato, quell'indirizzo deve essere quello configurato in Twilio. Ogni SMS inviato ha un costo sul tuo account.

#### Provider AI

L'assistente chiama un endpoint **OpenAI-compatibile** (`/chat/completions`). Il default è la **Developer API di Freebuff**, `https://freebuff.com/api/v1/paid`: la chiave si crea da Account → Developer API su [freebuff.com/account/api](https://freebuff.com/account/api) e i modelli disponibili sono elencati da `GET https://freebuff.com/api/v1/paid/models`. Il default è `deepseek-v4.1-flash`: fascia di costo bassa, buon multilingua e nessun tempo di ragionamento, quindi risposte brevi entro il timeout di 12 secondi. Alternative: `glm-5.3-flash` (circa la metà del costo, ma con ragionamento), `gpt-6-luna` (più caro, qualità GPT) e `gemini-3.8-flash` (solo piani paid). Va bene comunque qualsiasi altro gateway compatibile, come OpenAI o Z.ai: in *Canali & AI → Assistente* puoi incollare nome modello, base URL e chiave API, che viene cifrata nel database.

Per verificare chiave ed endpoint senza aprire il CRM: `npm run diagnose:ai` invia un messaggio minimo e stampa provider, modello, latenza e l'eventuale errore del provider; un messaggio personalizzato si passa come argomento (`npm run diagnose:ai -- "Ciao, fate siti?"`). La chiave viene usata ma mai stampata — si vedono solo provenienza (database o variabile d'ambiente) e lunghezza — e il testo restituito dal provider passa da una redazione, perché un errore può ripeterla. Uscita 0 risposta ricevuta, 1 provider in errore o irraggiungibile, 2 chiave assente. Se il database non risponde il comando usa le sole variabili d'ambiente, utile per capire se il guasto è l'AI o la connessione al database.

In alternativa imposta `AI_API_KEY`, `AI_BASE_URL` e `AI_MODEL` nelle variabili d'ambiente: è la via comoda su Vercel, dove il database non contiene la chiave. Se presenti, `AI_BASE_URL` e `AI_MODEL` hanno la precedenza sui valori salvati dall'interfaccia; per la chiave invece vale prima quella salvata nell'app e poi `AI_API_KEY` (o `OPENAI_API_KEY`). La chiave non viene mai inviata al browser né scritta nei log.

#### Come istruire l'assistente

1. Completa **Impostazioni** (nome attività, email, sede, pagina di prenotazione): la scheda attività è la prima fonte di conoscenza.
2. Tieni aggiornato il sito pubblico: servizi, cosa fai e cosa non fai, tempi tipici, zone, condizioni. L'assistente legge home, `/bio` e le pagine collegate.
3. In **Istruzioni aggiuntive** scrivi le regole commerciali: come parlare dei prezzi, cosa proporre prima di un preventivo, orari, urgenze, frasi da evitare, quando passare la conversazione a te. Esempio: «Non indicare cifre. Proponi sempre una call di 30 minuti dal link di prenotazione. Se chiedono assistenza su un sito esistente, chiedi URL e piattaforma».
4. Scegli tono, lingua e firma; imposta un'email per i casi da gestire a mano.
5. Premi **Aggiorna conoscenza dal sito**, poi prova un messaggio reale nel riquadro *Prova l'assistente*: la risposta mostra anche le fonti usate.
6. Dopo ogni modifica a sito, listino o servizi ripeti l'aggiornamento. Quando rispondi manualmente, la conversazione passa al titolare e l'auto-risposta si ferma: riattivala con *Riprendi assistente*.

L'auto-risposta si attiva solo con tre condizioni: interruttore globale in *Assistente*, interruttore sul canale e interruttore sulla conversazione. In più il CRM ferma l'assistente dopo tre risposte ravvicinate nella stessa conversazione (10 minuti), per evitare loop con i bot. Senza chiave AI o senza conoscenza raccolta l'assistente non risponde: il messaggio resta in inbox e viene segnalato.

#### Limiti da conoscere

- WhatsApp e Instagram accettano messaggi liberi solo entro 24 ore dall'ultimo messaggio del cliente; fuori da quella finestra serve un template approvato.
- Le funzioni Vercel hanno un tempo massimo per richiesta: la generazione ha un timeout di 12 secondi e la lettura del sito si ferma dopo 20 secondi. Se il piano gratuito interrompe la richiesta, il messaggio resta in inbox senza risposta e l'addestramento va ripetuto (su un piano con più tempo, o in locale, completa senza problemi).
- La firma del webhook Twilio dipende dall'URL pubblico esatto; con un tunnel temporaneo l'indirizzo cambia a ogni avvio e va aggiornato in Twilio.
- I messaggi e i canali vivono nel database dell'istanza: il backup ZIP legacy non li include.

### Verifiche (versione TypeScript)

```sh
npm test          # suite Vitest (applica le migrazioni al database della run)
npx tsc --noEmit  # controllo tipi
npm run diagnose:ai # messaggio di prova alla Developer API: provider, modello, latenza, errore
npm run db:check  # migrazioni ancora allineate a schema.prisma
npm run build     # generate + migrazioni + tsc
```

**Test end-to-end di Buffy.** `npm test` include `tests/agent.e2e.test.ts`: avvia il server HTTP reale sul database della run e un provider AI locale OpenAI-compatibile, con `AGENT_API_KEY` di prova verificata come Bearer. Copre azioni solo proposte senza scritture, preventivo con totali, accettazione con fattura bozza, pagamento dopo la numerazione fiscale, ricevuta emessa e annullata, messaggio al cliente inviato solo alla conferma. Per un controllo in sola lettura sul provider vero configurato in `.env`: `AGENT_E2E_LIVE=1 npm test -- tests/agent.e2e.test.ts` (una chiamata reale, nessuna azione applicata).

### Test in locale senza il database cloud

La suite e il controllo delle migrazioni hanno bisogno di un database. In CI usano un Postgres 17 effimero; in locale si fa lo stesso, invece di puntare all'istanza Prisma Postgres:

```sh
npm run test:locale
```

Lo script avvia un container `postgres:17` sulla porta 5432, attende che accetti connessioni TCP, esporta `DATABASE_URL` e `DATABASE_URL_TEST` verso `postgresql://postgres:postgres@localhost:5432/postgres` (la stessa URL della CI), esegue `db:migrate`, `db:check` e `npm test`, e infine rimuove il container. Se un container con quel nome è già attivo lo riusa e non lo ferma. Serve Docker; con la porta 5432 occupata: `PORTA_PG=5433 npm run test:locale`.

Il file `.env` non viene modificato: le variabili valgono solo per quella esecuzione. Puntare i test all'endpoint diretto del database cloud non è una scorciatoia consigliata: le connessioni dirette sono limitate dal piano, la suite ne apre più di una in parallelo e ogni esecuzione crea database temporanei.

`db:check` crea e distrugge database, quindi rifiuta di partire su un host remoto: serve un Postgres locale, oppure `npm run db:check -- --consenti-remoto` per assumersene la responsabilità.

### Migrazioni del database

Lo schema vive in `prisma/migrations/`, non più in un `db push`: ogni modifica è un file SQL versionato, applicato una sola volta e registrato in `_prisma_migrations`.

```sh
npm run db:migrate   # applica le migrazioni mancanti (lo usa anche il deploy Vercel)
```

Le migrazioni e i comandi Prisma usano `DIRECT_URL` quando è impostata, e altrimenti `DATABASE_URL`. Conviene tenerle separate: `DIRECT_URL` punta all'endpoint diretto (`db.prisma.io`), perché il pooler non conserva lo stato di sessione che `migrate` richiede; `DATABASE_URL` resta quella pooled, usata dall'applicazione, perché le connessioni dirette sono limitate dal piano.

Per cambiare lo schema: modifica `prisma/schema.prisma`, crea la migrazione con `npx prisma migrate dev --name <nome>` (serve un database su cui poter creare il database ombra), rileggi il file SQL generato e committalo insieme allo schema. Una modifica allo schema senza migrazione non arriva più in produzione, e la CI la intercetta: `npm run db:check` costruisce due database temporanei, uno dalle migrazioni e uno dal solo schema, e confronta tabelle, colonne, tipi e indici. Non confronta i default, perché Postgres li riscrive aggiungendo i cast `::text` e segnalerebbe differenze inesistenti.

Un database già popolato non ha storia di migrazioni: alla prima esecuzione `npm run db:migrate` lo riconosce (errore P3005) e, dopo aver verificato che tutte le tabelle dello schema esistano, marca la migrazione iniziale come applicata invece di ricreare tutto. Se invece mancano tabelle si ferma e lo dice: l'allineamento va fatto a mano.

## Avvio

Richiede Python 3.10 o successivo con database dei fusi orari (presente su macOS).

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python app.py
```

Apri http://127.0.0.1:8080 e crea la password del workspace (almeno 12 caratteri). Nessun account o dato dimostrativo viene creato nell'archivio reale. Il server resta attivo finché il processo è in esecuzione; Ctrl+C lo arresta. È disponibile anche `Avvia CRM.command` per macOS; `Pubblica prenotazioni.command` rende online la pagina di prenotazione (vedi sotto).

## Funzioni disponibili

- **Clienti**: contatti, azienda, riferimenti fiscali, indirizzo, note, ricerca e modifica.
- **Progetti**: cliente, descrizione del lavoro concordato, scadenza, avanzamento e filtri.
- **Preventivatore dal progetto**: selezione delle funzionalità e quantità concordate, ore per unità modificabili, complessità, test, coordinamento, imprevisti e costi extra. Generazione server di tutte le voci, dettaglio del carico di lavoro e conservazione delle ipotesi originali anche dopo modifiche manuali. Il salvataggio ritentato non duplica la proposta.
- **Preventivi manuali**: modelli iniziali per sito, applicazione e consulenza; righe personalizzabili; calcolo server di ore × tariffa × complessità + extra; IVA configurabile e arrotondamento ai centesimi. Stampe salvabili in PDF dal browser.
- **Fatturazione configurabile**: ogni azienda inserisce partita IVA, codice fiscale, sede, regime e preferenze. L’accettazione del preventivo genera una bozza; ogni fattura richiede verifica di cliente, IVA/natura per riga, contributi, ritenuta e bollo. Dopo il riepilogo e la conferma, vengono assegnati numero annuale e XML FPR12 validato. XML e dati fiscali restano immutabili; il backup li comprende. L’ATECO è anagrafico, non determina il trattamento fiscale. I compensi concordati restano fissi, mentre il trattamento fiscale definitivo può differire dalla stima del preventivo.
- **Documenti**: file originali fino a 10 MB, associazione a cliente/progetto, download autenticato, impronta SHA-256, backup e ripristino.
- **Prenotazioni**: pagina separata senza login per l'ospite, titolo e descrizione personalizzabili, giorni e ore disponibili, durata, preavviso, orizzonte, assenze; impedimento transazionale delle sovrapposizioni; link personale di annullamento ed esportazione `.ics`. Con un indirizzo pubblico configurato il link da condividere è quello HTTPS, non quello locale.
- **Dashboard**: importi incassati e da incassare, progetti attivi, appuntamenti e fatture da completare. I valori sono calcolati dai dati reali.

## Flusso consigliato

1. Completa Impostazioni con dati dell’attività, tariffa e **Profilo fiscale dell’azienda**. Nessuna partita IVA, ATECO o regime è preimpostato. Le nuove aziende possono salvare il profilo progressivamente; gli elementi mancanti bloccano la generazione XML.
2. Aggiungi un cliente con tipo soggetto, paese, indirizzo strutturato, identificativi fiscali e canale destinatario, poi crea il progetto concordato.
3. Dal progetto scegli **Stima automatica**: imposta tipologia, quantità, ore unitarie e coefficienti. Verifica il riepilogo e genera la bozza. Puoi modificare le voci prima di inviarla; da **Apri → Ipotesi iniziali** ritrovi sempre la stima originale. In alternativa usa **Preventivo manuale**.
4. Stampa o salva PDF e consegnalo al cliente. “Segna consegnato” registra lo stato; non invia email.
5. Quando il cliente accetta, scegli “Registra accettazione”: trovi la fattura in bozza in Fatture.
6. Apri **Verifica fiscale e genera XML**. Correggi le informazioni mancanti, verifica il riepilogo e conferma il trattamento dell’operazione. **Numera e genera XML** salva un file validato, scaricabile dalla fattura. Le modifiche ai dati dopo la verifica richiedono un nuovo controllo; ripetere la generazione non produce duplicati.
7. Registra il pagamento ricevuto per aggiornare gli incassi.
8. Configura disponibilità e prova la pagina di prenotazione da Appuntamenti.
9. Quando vuoi condividerla con i clienti avvia `Pubblica prenotazioni.command` (vedi sotto).

## Pubblicare la pagina di prenotazione

La pagina `/book/<slug>` non richiede login ed è pensata per i clienti, ma nasce su `127.0.0.1`: per raggiungerla da Internet serve un indirizzo HTTPS. Lo script per macOS avvia il CRM se non è attivo, apre un tunnel Cloudflare e salva l'indirizzo in **Impostazioni → Pagina di prenotazione**, così il link mostrato in Appuntamenti è già quello da inviare.

```sh
./Pubblica prenotazioni.command
```

Al primo avvio scarica il client del tunnel in `tools/` (circa 40 MB, escluso dal versionamento). Il comando stampa il link pubblico; alla chiusura con Ctrl+C il tunnel si chiude e l'indirizzo pubblico viene azzerato, mentre il CRM già avviato resta attivo in locale. L'indirizzo `trycloudflare.com` cambia a ogni avvio: va bene per condividere la pagina per un periodo, non come indirizzo definitivo.

Per un link stabile su un tuo dominio serve un account Cloudflare con il dominio e un tunnel con nome:

```sh
tools/cloudflared tunnel login
tools/cloudflared tunnel create realindi
```

Poi crea `~/.cloudflared/config.yml` con l'hostname scelto e avvia il tunnel:

```yaml
tunnel: realindi
credentials-file: /Users/tu/.cloudflared/<uuid>.json
ingress:
  - hostname: prenota.tuodominio.it
    service: http://127.0.0.1:8080
  - service: http_status:404
```

```sh
tools/cloudflared tunnel route dns realindi prenota.tuodominio.it
tools/cloudflared tunnel run realindi
.venv/bin/python manage.py public-url https://prenota.tuodominio.it
```

Da quel momento il link resta lo stesso; `manage.py public-url` senza argomenti mostra il link attivo e `public-url ""` lo riporta al locale.

Da tenere presente:

- Il tunnel espone anche l'area riservata. Resta protetta da password, ma usane una lunga e, se lavori sempre in HTTPS, avvia il server con `CRM_SECURE_COOKIE=1`.
- La pagina risponde solo con il Mac acceso e sveglio e server e tunnel in esecuzione. Per una disponibilità continua serve un server sempre attivo (o un hosting con Python e HTTPS) e un tunnel avviato come servizio.
- Chiunque abbia il link può occupare gli orari liberi: condividilo solo con i clienti e annulla da Appuntamenti le prenotazioni indesiderate.
- I dati dell'ospite restano nel tuo archivio locale; nessuna email automatica viene inviata, quindi conferma a mano l'appuntamento se ti serve.

## Stato e integrazioni ancora da completare

Questa versione è pronta per una prova locale; il progetto complessivo resta in sviluppo.

- È presente la generazione XML TD01/FPR12 per emittenti italiani e clienti imprese/privati, con controlli applicativi e schema XSD 1.2.3. **La validazione non equivale a correttezza tributaria certificata o accettazione SdI**. Non sono collegati trasmissione, ricevute o conservazione fiscale. Il supporto di PA, altre giurisdizioni, note di credito e casistiche societarie/fiscali speciali resta da completare; vedi [fonti e perimetro](schemas/SOURCES.md).
- L'archivio documentale è memorizzazione locale con backup, non un servizio di conservazione a norma.
- Il link di prenotazione è utilizzabile dai clienti tramite tunnel HTTPS, ma dipende dal computer acceso: non è un servizio sempre disponibile e l'indirizzo temporaneo cambia a ogni avvio. Un dominio stabile richiede un tunnel con nome su un dominio proprio, oppure il trasferimento dell'app su un server sempre attivo. Non esporre direttamente la porta HTTP su Internet.
- Non sono configurate email automatiche, promemoria, videoconferenze o sincronizzazione bidirezionale Google/Outlook. Il download `.ics` permette l'importazione manuale dell'evento.
- Il preventivatore genera voci e importi dal perimetro strutturato del progetto, non interpreta autonomamente accordi in testo libero. Le ore per unità sono esempi di partenza da adattare; il carico stimato non è una promessa di consegna. Un nuovo preventivo dello stesso progetto riprende le ultime ipotesi salvate.
- Un solo titolare/account per istanza. Per vendere un SaaS condiviso servono ancora organizzazioni, autenticazione e isolamento multi-tenant; la configurazione fiscale autonoma non sostituisce l’isolamento dei dati. La scelta commerciale tra SaaS e installazioni indipendenti è stata chiesta all’utente.

## Dati e backup

I dati reali si trovano in `data/crm.sqlite3` e `data/documents/`. Non sono cifrati dall'applicazione; usa la protezione del disco e conserva copie di backup separate.

Da Impostazioni scarica il backup ZIP: contiene database SQL, XML delle fatture e originali dei documenti, senza password e sessioni attive. Per ripristinarlo in una **nuova cartella vuota**, a server fermo:

```sh
python3 manage.py restore /percorso/realindi-backup.zip --destination /percorso/archivio-ripristinato
CRM_DATA_DIR=/percorso/archivio-ripristinato .venv/bin/python app.py
```

Al primo accesso scegli una nuova password. Il ripristino verifica integrità SQLite, relazioni e SHA-256 degli allegati; rifiuta destinazioni già contenenti dati. Accetta solo backup propri e attendibili.

## Configurazione tecnica

| Variabile | Default | Uso |
|---|---|---|
| `CRM_DATA_DIR` | `data/` accanto a `app.py` | Directory persistente |
| `CRM_HOST` | `127.0.0.1` | Interfaccia di ascolto |
| `CRM_PORT` | `8080` | Porta HTTP locale |
| `CRM_SECURE_COOKIE` | disattivato | `1` per cookie Secure dietro HTTPS |

L'indirizzo pubblico della pagina di prenotazione è un'impostazione dell'applicazione, non una variabile: si modifica in Impostazioni oppure con `python3 manage.py public-url https://…`. Accetta solo un'origine `https://` (o `http://` su localhost), senza percorso.

Password con PBKDF2 e sale casuale; sessioni memorizzate come hash, HttpOnly e SameSite Strict, durata 12 ore. Controllo dell'origine delle mutazioni e limite dei tentativi di login. Gli allegati non sono serviti come contenuti attivi e richiedono login. Calcoli, controlli dei riferimenti, numerazione e prenotazioni sono verificati lato server.

## Verifiche

```sh
.venv/bin/python -m unittest discover -s tests -v
node --check static/app.js
node --check static/estimate.js
node --check static/fiscal.js
```

I test integrati HTTP usano una cartella temporanea: coprono calcolo importi, blocco preventivi accettati, conversione unica in fattura, progressivo, dati storici della fattura, accessi, origine richieste, logout, allegati, backup/ripristino e doppia prenotazione concorrente. Coprono inoltre il preventivatore dal progetto, la conservazione delle ipotesi, le richieste di generazione concorrenti e il ripristino delle stime. I casi fiscali includono ordinario con contributo/ritenuta, forfettario con bollo, privato italiano, cliente estero, IVA mista/split payment, modifiche dopo conferma, XML immutabili e backup/ripristino degli XML. Node serve solo per il controllo della sintassi frontend; non è richiesto per avviare il CRM.

Struttura: `app.py` (API e persistenza), `estimator.py` (regole di stima), `fiscal.py` (controlli, calcoli fiscali, XML/XSD), `schemas/` (schemi ufficiali e fonti), `manage.py` (ripristino), `static/` (interfaccia), `tests/` (test), `.21st/` (contesto visuale).
