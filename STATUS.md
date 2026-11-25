# Stato del lavoro — 30 ottobre 2026

Obiettivo originale: CRM freelancer con conservazione documenti, fatture automatiche, prenotazioni personalizzate e preventivatore per lavoro concordato.

Implementata e verificata la base locale: clienti, progetti, preventivi da modelli e regole, fatture gestionali automatiche da accettazione, documenti originali e backup ripristinabile, calendario prenotabile con blocchi e controllo concorrente. UI italiana responsive.

Non dichiarare completo il goal: restano configurazione fiscale e integrazioni effettive, pubblicazione della pagina prenotazioni e validazione dell'uso reale. Chiesta all'utente la giurisdizione/regime fiscale e l'eventuale fornitore di fatturazione elettronica. Risposta ancora da ricevere.

Test: `python3 -m unittest discover -s tests -v` (6 test integrati passati). Browser: creazione cliente, progetto, preventivo da modello e accettazione con fattura generata; prenotazione pubblica confermata, evento ICS scaricato e verificato, schermate mobile e layout di stampa ispezionati. I dati di prova browser sono separati in `/tmp/realindi-browser-check`; non sono dati reali.

Prossime attività: completare fatturazione adatta al regime effettivo; definire destinazione pubblica e integrazioni calendari/email; completare audit rispetto all'obiettivo reale.

Server reale avviato su http://127.0.0.1:8080; verificato HTTP 200 e setup iniziale ancora da completare da parte del titolare. Nessun dato di prova nel database reale.

## Aggiornamento: preventivatore dal progetto

Aggiunti `estimator.py` e `static/estimate.js`: selezione tipologia e moduli, quantità e ore unitarie modificabili, complessità, test, coordinamento, riserva imprevisti, extra, tariffa e IVA. Generazione server della bozza, anteprima spiegabile e carico in settimane. Ipotesi iniziali conservate nella colonna `quotes.estimate`; migrazione additiva ripetibile. Chiave univoca di generazione per evitare duplicati sui retry. I preventivi restano modificabili e la fattura riflette le voci finali.

Verifiche: 6 test HTTP integrati passati, inclusi calcoli con percentuali, generazione concorrente, conservazione delle ipotesi dopo modifica, conversione fattura e backup/ripristino delle stime. Browser: generata una proposta per applicazione con complessità/test/coordinamento/imprevisti/IVA; riapertura riprende le ipotesi precedenti; zero errori JavaScript. Controllata vista mobile del generatore e dell'editor. Nuovo server reale riavviato su 8080 con migrazione; il workspace reale resta in attesa della password iniziale del titolare.

Restano da chiarire regime fiscale/servizio elettronico e destinazione pubblica; nessuna risposta del titolare ancora ricevuta. Goal ancora attivo: questa iterazione costituisce progresso concreto, non un'attesa o una dichiarazione di completamento.

## Aggiornamento: fatturazione fiscale

Aggiunti `fiscal.py` e `static/fiscal.js` con schemi ufficiali in `schemas/`. Il profilo fiscale è per azienda (partita IVA, codice fiscale, sede, regime, ATECO anagrafico, preferenze) e nessun valore è preimpostato. Dall'accettazione del preventivo nasce una bozza; la verifica controlla cliente, IVA o natura per riga, contributi, ritenuta e bollo, poi assegna numero annuale e genera un XML FPR12 validato contro lo schema 1.2.3. XML e dati fiscali sono immutabili e inclusi nel backup; modifiche successive richiedono una nuova verifica e la rigenerazione non duplica.

Verifiche: 12 test HTTP integrati passati (ordinario con contributo/ritenuta, forfettario con bollo, privato italiano, cliente estero, IVA mista/split payment, profilo incompleto, modifiche dopo conferma, XML immutabili, backup/ripristino degli XML). Controllo sintassi frontend superato. Server avviato e verificato: pagina di setup del workspace reale servita correttamente su http://127.0.0.1:8080, database reale ancora privo di password e di dati.

Limiti dichiarati: la validazione XSD non è certificazione tributaria né accettazione SdI; trasmissione, ricevute e conservazione a norma non sono collegate. Restano aperti la scelta tra SaaS multi-tenant e installazioni indipendenti, e un host sempre attivo per la pagina di prenotazione.

## Aggiornamento: pagina di prenotazione pubblica

Aggiunti l'impostazione `public_url` (origine HTTPS senza percorso, validata lato server e usata per il link da condividere) e `Pubblica prenotazioni.command`, che avvia il CRM se necessario, apre un tunnel Cloudflare, salva l'indirizzo pubblico e stampa il link. `manage.py public-url` mostra o imposta l'indirizzo da terminale; alla chiusura lo script azzera il link per non lasciarne uno morto. Client del tunnel in `tools/`, escluso dal versionamento.

Verifiche: 12 test integrati ancora passati e controllo sintassi frontend superato. Prova reale con archivio temporaneo su porta 8091 e link `trycloudflare.com`: pagina pubblica servita in HTTPS, 18 orari disponibili, prenotazione creata dal pubblico, seconda prenotazione sullo stesso orario rifiutata (400), richiesta da origine esterna rifiutata (403), annullamento con token riuscito, `/api/state` senza login 401, pagina resa nel browser con orari caricati e nessun errore JavaScript. Alla chiusura tunnel, app di prova e indirizzo pubblico sono stati rimossi; il database reale non è stato toccato.

Limite dichiarato: il link è raggiungibile solo con Mac acceso, server e tunnel attivi, e l'indirizzo temporaneo cambia a ogni avvio; per un link stabile serve un tunnel con nome su un dominio proprio o un server sempre attivo.

## Pooler Prisma, endpoint diretto e controllo di salute (8 novembre 2026)

**Diagnosi.** L'endpoint pooled `pooled.db.prisma.io` non è affidabile per i database **appena creati**: la connessione risponde `Failed to connect to upstream database. Please contact Prisma support if the problem persists.` mentre l'endpoint diretto `db.prisma.io` raggiunge lo stesso database senza problemi. Verificato due volte, creando database temporanei: la creazione riesce, la connessione successiva attraverso il pooler no. I database esistenti (`postgres`, `realindi_test`) funzionano su entrambi gli endpoint, e stamattina il pooler è tornato raggiungibile da solo. Il giorno prima il guasto era più ampio e coinvolgeva anche i database esistenti, quindi resta un ticket da aprire a Prisma: le evidenze sono riproducibili con `scripts/diagnose-pooler.mjs`.

**Cosa è cambiato.**

- `DIRECT_URL` opzionale: `prisma7.config.ts` e `scripts/migrate.ts` usano `DIRECT_URL` quando è impostata e altrimenti `DATABASE_URL`; il runtime dell'applicazione resta su `DATABASE_URL` (pooled), perché le connessioni dirette sono limitate dal piano.
- `db:check` passa dall'endpoint diretto quando `DIRECT_URL` c'è: crea e interroga database temporanei, che attraverso il pooler non sarebbero raggiungibili. Il processo figlio di `prisma migrate deploy` riceve **entrambe** le variabili: senza, il config avrebbe preferito `DIRECT_URL` del `.env` e il deploy del controllo sarebbe finito sul database di produzione. Verificato dopo la correzione che la produzione è intatta (2 migrazioni applicate, 21 tabelle, nessun rollback).
- `scripts/host-guard.ts` con test: `db:check` rifiuta un host che non sia locale, perché crea e distrugge database; per procedere serve `npm run db:check -- --consenti-remoto`.
- `/api/health` pubblico: una `SELECT 1` con limite di 2 s, 200 `{"status":"ok"}` oppure 503 `{"status":"degraded"}`, nessun dettaglio nella risposta. È servito **prima** di `ensureDefaults()`, che interroga il database: senza, con il server irraggiungibile la risposta arrivava dopo 77 s invece che dopo 2.
- `npm run test:locale`: Postgres 17 in container con le stesse URL della CI, così la suite non dipende dal database cloud.
- `.github/workflows/sorveglianza.yml` e `scripts/diagnose-pooler.mjs`: controllo ogni 30 minuti dell'endpoint di salute e dei due endpoint del database, con notifica.

**Verifiche.** `npx tsc --noEmit` → 0. `vitest run` → 13 file, **137 test**, uscita 0. `/api/health`: 200 in 27 ms con database sano; 503 in 2,005 s con indirizzo che non risponde; `/api/notes` e `/api/clients` ancora 401. `db:check` verde con `DIRECT_URL` (uscita 0, «Migrazioni allineate allo schema.») e rifiutato senza consenso su host remoto (uscita 1). `db:migrate` con `DATABASE_URL` irraggiungibile e `DIRECT_URL` valido: 21 tabelle e 3 migrazioni applicate su un database nuovo, poi eliminato. Nessun database temporaneo residuo.

**Da completare.** Aggiungere `DIRECT_URL` fra le variabili di Vercel; `SLACK_WEBHOOK_URL` se serve la notifica Slack (oggi resta l'email di GitHub); `test:locale` non è stato eseguito perché Docker non è installato su questa macchina; la segnalazione a Prisma va ancora inviata.

## Sorveglianza attiva (25 novembre 2026)

Impostate su GitHub la variable `PROD_URL=https://realindi.vercel.app` e il secret `DATABASE_URL_TEST` (database `realindi_test`): la X rossa delle run precedenti era solo questa configurazione mancante, non un guasto. Run manuale [45610064432](https://github.com/IlMara2000/realindi_systems/actions/runs/45610064432) verde: `/api/health` 200 `{"status":"ok"}`, pooler e endpoint diretto 3/3 su entrambi.

Il controllo di salute interroga davvero il database (`SELECT 1` via Prisma, timeout 2 s): con `DATABASE_URL` irraggiungibile risponde 503 `{"status":"degraded"}` in pochi millisecondi, verificato in locale. Ora il workflow accetta un 200 solo se il corpo contiene `"status":"ok"`, così un proxy o una pagina d'errore non passano per un servizio sano.

## Reimpostazione password con Portachiavi (25 novembre 2026)

`npm run password:reimposta -- --sì --portachiavi` fa tutto in un passo: scrive l'hash della password nuova nel database, chiude le sessioni, azzera i tentativi falliti e salva **password e codici di emergenza nel Portachiavi di macOS**, senza mai stamparli a terminale (quindi né nella cronologia della shell né in chat).

Voci create, sempre con lo stesso nome: `REALINDI CRM - password` e `REALINDI CRM - codici di emergenza` (account `realindi`). Si leggono da *Accesso Portachiavi* cercando «REALINDI CRM», oppure da terminale:

```
security find-generic-password -a realindi -s "REALINDI CRM - password" -w
security find-generic-password -a realindi -s "REALINDI CRM - codici di emergenza" -w
```

Dettagli che contano:

- I codici sono salvati **su una riga sola**, separati da `; `. `security` restituisce in esadecimale i valori che contengono ritorni a capo: un valore così non si legge né si verifica a occhio. La funzione `codiciSuUnaRiga()` isola la regola, con un test in `tests/password-reset.test.ts`.
- Dopo la scrittura ogni voce viene **riletta e confrontata**: se il Portachiavi non ha il valore atteso il comando esce con errore, invece di dichiarare un successo non verificato.
- I segreti passano a `security` come argomenti di `execFileSync` (nessuna shell, nessuna interpolazione) e non vengono stampati: in caso di errore il messaggio riporta solo il nome della voce.
- L'opzione è solo per macOS; altrove il comando resta quello di prima e stampa i codici una volta sola. Se macOS chiede il permesso di accesso al Portachiavi, va concesso e il comando va ripetuto.
- Se in seguito si cambia la password da `/app`, l'app rigenera i codici: le voci nel Portachiavi vanno aggiornate (basta rilanciare il comando) o cancellate.

Procedura consigliata, quindi: `npm run password:reimposta -- --sì --portachiavi`, poi aprire l'app e salvare nulla a mano.

**Verifica end-to-end (25 novembre 2026).** Provata su un Postgres 17 temporaneo locale (porta 55432, cartella in `/tmp`, poi eliminata), non sulla produzione, con le voci vere del Portachiavi salvate prima e ripristinate dopo: `tests/password-reset.test.ts` 11/11 verde sul database temporaneo, `npm run password:reimposta -- --sì --portachiavi` uscita 0 senza stampare segreti, poi confronto diretto fra Portachiavi e hash nel database — password corrispondente, 8 codici su 8 validi, valore su una riga sola. Le due voci originali sono state riscritte e risultano identiche byte per byte al backup. `npx tsc --noEmit` → 0. Il database temporaneo e il cluster sono stati spenti e rimossi: nessun residuo, la produzione non è stata toccata.

**Produzione in 503 (25 novembre 2026).** `https://realindi.vercel.app/api/health` risponde `{"status":"degraded"}`: Prisma rifiuta la connessione con «Your account has restrictions: planLimitReached». La causa sono i database `realindi_test_run_*` accumulati dalle vecchie run della suite (oggi non ne crea più). Finché l'account non viene sbloccato restano fermi anche `npm run password:reimposta` e `npm run db:pulisci-test`; sblocco da console Prisma (eliminare i vecchi `realindi_test_run_*`) o tramite il supporto Prisma, poi `npm run db:pulisci-test` e nuova verifica di `/api/health`.

## Email dei contatti normalizzate anche nel database (25 novembre 2026)

L'import normalizza le email alla scrittura (commit `f61d537`), ma i contatti arrivati prima conservano la maiuscola: `Mario@Example.com` resta così nel campo `emails`, quindi ricerca per email e doppioni non lo riconoscono.

`npm run db:normalizza-email` è il passaggio una tantum: legge tutti i contatti, applica la stessa regola dell'import (`normalizeEmail`, niente spazi attorno, niente doppioni) e riscrive **solo** il campo `emails` delle righe che cambiano. Ogni `UPDATE` è condizionato al valore appena letto, così una scrittura concorrente della sincronizzazione non viene sovrascritta. Le righe il cui `emails` non è un elenco JSON di stringhe non si toccano: sono da guardare a mano, e il comando esce con 1 elencandone gli id.

- `npm run db:normalizza-email` — sola lettura: elenca righe e valori che cambierebbero.
- `npm run db:normalizza-email -- --applica` — scrive, poi **rilegge tutto** e dice se resta qualcosa da normalizzare.

**Verifica (25 novembre 2026).** Provato su un Postgres 17 temporaneo (porta 55440, cartella in `/tmp`, poi eliminata) con 7 contatti di prova: 4 righe corrette, 6 valori cambiati, 1 riga con `emails` illeggibile lasciata intatta e segnalata, uscita 0; seconda esecuzione con 0 righe scritte (idempotente); contenuto finale riletto con `psql`. Nuovo `tests/normalizza-email-contatti.test.ts` (6 test): regola, conteggio in sola lettura senza scritture, scrittura con conteggio e verifica, idempotenza. Suite completa 224 passati / 1 saltato, `npx tsc --noEmit` → 0. Cluster temporaneo spento e rimosso.

**Sulla produzione il conteggio non c'è ancora:** l'account Prisma risponde `planLimitReached` anche in sola lettura (uscita 1). Appena l'account è sbloccato: `npm run db:normalizza-email -- --applica` e il numero di righe toccate è nella riga «Righe scritte».

## Email normalizzate anche in lettura (25 novembre 2026)

Finché il backfill non gira sulla produzione (Prisma bloccato), il confronto dei contatti non deve dipendere da come la riga è stata salvata: `emailsDelContatto()` in `src/contacts.ts` legge il campo `emails` e applica la stessa regola della scrittura (`normalizeEmail`, niente spazi, niente doppioni). Anche `npm run db:normalizza-email` usa quella funzione (`emailsNormalizzate` aggiunge solo il rifiuto dei valori illeggibili), quindi regola e backfill non possono divergere. La ricerca del contatto già esistente durante la sincronizzazione (`matchExisting`) usa questa funzione, quindi un contatto salvato come `Mario@Example.com` viene trovato da un'email `mario@example.com` e fuso invece di duplicato; un valore illeggibile vale come nessuna email e non fa fallire la ricerca.

**Verifica.** Nuovo test unitario su `emailsDelContatto` e nuovo test end-to-end in `tests/contacts.test.ts`: riga nel database con `["Mario@Example.com"]`, scheda iCloud con `mario@example.com` → `imported: 0`, `merged: 1`, un solo contatto con `["mario@example.com"]`. Controprova: togliendo la normalizzazione in lettura lo stesso test fallisce (`expected 1 to be +0`), quindi il test difende davvero il comportamento. Suite completa 226 passati / 1 saltato, `npx tsc --noEmit` → 0, su Postgres 17 temporaneo (porta 55441, poi spento e rimosso).

## Contatti nell'archivio di backup (25 novembre 2026)

L'archivio esportato da `/api/backup` non conteneva la rubrica: un ripristino avrebbe perso email e telefoni importati da iCloud e Google. Ora `src/backup.ts` aggiunge al dump la tabella `contacts` (stesso dialetto SQLite delle altre) e tutte le righe, comprese quelle cancellate dalla sincronizzazione: l'archivio è una copia fedele, non la vista dell'app. `updated_at` è un `BIGINT` e viene scritto come numero, non fra apici.

Il ripristino legacy (`python3 manage.py restore`) non cambia: esegue il dump così com'è, quindi crea e popola anche `contacts` senza modifiche. Le vecchie istanze continuano a leggere gli archivi nuovi (la tabella in più non dà fastidio a `app.py`), e gli archivi vecchi restano ripristinabili.

**Verifica.** Nuovo `tests/backup-contatti.test.ts`: crea un cliente e due contatti (uno legato al cliente con email e telefono reali, uno cancellato), scarica `/api/backup`, controlla che il dump contenga la tabella e gli INSERT, poi esegue davvero `python3 manage.py restore` in una cartella temporanea e riapre il `crm.sqlite3` risultante con `node:sqlite`: 2 contatti con valori intatti (email non alterata, `client_id`, telefono, `updated_at`, `deleted_at`), 1 cliente e nessuna password. Se il ripristino legacy si rompesse, il test fallirebbe lì. Suite completa 228 passati / 1 saltato su Postgres 17 temporaneo (porta 55444, poi spento e rimosso); `npx tsc --noEmit` → 0.

## Archivio completo: note, ricevute, calendario, link/QR e conversazioni (25 novembre 2026)

Dopo i contatti, `src/backup.ts` esporta anche le altre tabelle di dati che restavano fuori: `notes`, `receipts`, `calendar_events` + `event_links`, `short_links` + `link_visits` + `qr_codes`, `channels` + `conversations` + `messages` + `message_attachments`. Righe complete, comprese quelle cancellate o annullate (un evento `deleted_at`, una ricevuta `cancelled_at`): dopo un ripristino la sincronizzazione deve sapere cosa era stato cancellato, e un numero di ricevuta non si riusa.

Scelte:

- I media delle conversazioni e i loghi dei QR stanno nel dump come BLOB, come gli XML delle fatture: `manage.py restore` non cambia e non serve una cartella nuova.
- `channels.credentials` viene esportato **vuoto**: è cifrato con `INTEGRATIONS_KEY`, che non viaggia nel backup, quindi sarebbe solo un blob inutile da tenere in giro. Al ripristino i canali vanno ricollegati.
- Restano fuori, di proposito: sessioni, tentativi di accesso, eventi di login, `assistant_hits`, stato di sincronizzazione (`sync_state`, `sync_calendars`, `sync_channels`, `sync_addressbooks`, `sync_conflicts`) e `knowledge_docs` — sono stato dell'istanza o dati rigenerabili, non dati del CRM.

**Verifica.** Secondo test in `tests/backup.test.ts` (file rinominato da `backup-contatti.test.ts`, ora copre entrambe le parti): semina una riga per ognuna delle tabelle nuove, scarica `/api/backup`, esegue `python3 manage.py restore` e riapre il `crm.sqlite3`: valori, booleani, `BIGINT` (`updated_at`, `at`), BLOB del logo e dell'allegato tornano identici, `credentials` del canale è vuoto e la stringa cifrata non compare nel dump. Suite completa 229 passati / 1 saltato su Postgres 17 temporaneo (porta 55445, poi spento e rimosso); `npx tsc --noEmit` → 0.

`.github/workflows/verifica.yml` ha ora anche `workflow_dispatch`, così la CI si può lanciare a mano quando GitHub perde l'evento di un push (è successo con `cd70a8f`).

`verifica.yml` usa ora `actions/checkout@v5` e `actions/setup-node@v5`: sparisce l'annotation di GitHub sul Node 20 deprecato. `sorveglianza.yml` è ancora su `@v4` (funziona: le action v4 girano su Node 24 forzato), quindi l'avviso resta in quel workflow finché non si aggiorna anche lì.
## Invio delle fatture allo SdI via PEC (25 novembre 2026)

`src/sdi.ts` collega il gestionale allo SdI con il canale PEC: l'XML validato viene spedito a `sdi01@pec.fatturapa.it` dalla casella PEC dell'azienda e le notifiche tornano sulla stessa casella. Il codice destinatario non viene generato: è del destinatario (assegnato dall'Agenzia a chi ha un canale di ricezione, o quello dell'intermediario).

Come si attiva: Impostazioni → Invio allo SdI (PEC), con host/porta SMTP e IMAP, indirizzo PEC, mittente e password. La password è cifrata con `INTEGRATIONS_KEY` (AES-256-GCM) e non viene mai riletta dal server. Il riquadro elenca cosa manca: chiave, PEC, partita IVA, regime fiscale.

Cosa succede dopo:

- appena una fattura è numerata e l'XML esiste, `invioAutomatico` la trasmette se PEC e dati azienda sono completi; un errore non annulla la numerazione, resta scritto sulla riga con il motivo e si può ritentare con «Invia allo SdI»;
- lo stato per fattura è `not_sent → sent → delivered | rejected | failed | accepted | refused`, con data di invio e ultimo esito; `POST /api/sdi/esiti` (o «Aggiorna ricevute SdI») rilegge la posta e applica `RicevutaConsegna`, `NotificaScarto`, `NotificaMancataConsegna`, `NotificaEsito` (EC01/EC02) e `NotificaDecorrenzaTermini`, riconoscendo la fattura dal `<NomeFile>`;
- gli XML restano immutabili; le ricevute non li toccano.

**Verifica.** `tests/sdi.test.ts` su Postgres 17 temporaneo: notifiche riconosciute, PEC salvata senza restituire la password, elenco di ciò che manca, invio con trasporto simulato (destinatario `sdi01@pec.fatturapa.it`, file e contenuto corretti, stato `sent`), errore di autenticazione registrato e ritentabile, rifiuto senza XML e senza PEC, nessun invio automatico senza PEC, ricevute applicate e notifica di un'altra fattura ignorata. Suite completa 240 passati / 1 saltato (porta 55448, poi spenta e rimossa); `npx tsc --noEmit` → 0.

**Limiti dichiarati:** l'invio reale non è stato provato (serve la PEC dell'azienda); la conservazione a norma resta da collegare. Le notifiche si leggono su richiesta oppure dal cron ogni mezz'ora (vedi la sezione successiva).

## Ordine delle notifiche SdI (25 novembre 2026)

La casella PEC viene riletta intera a ogni «Aggiorna ricevute»: la vecchia `RicevutaConsegna` tornava quindi a ogni lettura e poteva riportare `accepted` a `delivered`, o addirittura far tornare `rejected` una fattura già reinviata. Lo stesso poteva succedere dentro una sola lettura, perché l'ordine dei messaggi non è garantito.

Ogni fattura ha ora `sdi_event_at`: l'istante dell'evento che ha prodotto lo stato attuale, cioè la `<DataOraConsegna>`/`<DataOra>` della notifica oppure, dopo un invio, l'istante ISO dell'invio stesso. `piuRecente()` in `src/sdi.ts` accetta una notifica solo se è successiva a quell'istante; senza date (alcune notifiche non ne hanno) decide l'ordine degli stati `not_sent < sent < delivered | failed < rejected < accepted | refused`, così non si torna mai indietro. Le notifiche scartate per questo motivo non toccano la riga e vengono contate a parte (`superate`): il messaggio a schermo le distingue da quelle «senza fattura».

L'ancora dell'invio è ciò che risolve il reinvio: dopo uno scarto, «Invia allo SdI» registra il nuovo istante, e la vecchia `NotificaScarto` che resta in casella risulta precedente. Le date SdI arrivano in ora italiana senza fuso orario e vengono convertite con lo scostamento di `Europe/Rome` (ora legale compresa); quelle scritte da noi sono ISO con la `Z`.

**Verifica.** `tests/sdi.test.ts` copre tre casi nuovi: notifica più vecchia applicata dopo una più recente (aggiorna una volta, poi nessun'altra modifica), notifiche senza data che non fanno regredire lo stato, scarto riletto dopo il reinvio che non riporta la fattura a `rejected`.

Migrazione: `prisma/migrations/20261125193000_sdi_ordine_notifiche` (colonna `invoices.sdi_event_at`). Le fatture esistenti partono con il campo vuoto: la prima notifica che arriva viene applicata e da lì in poi vale l'ordine.

## Lettura automatica delle ricevute SdI (25 novembre 2026)

Le ricevute non hanno più bisogno del pulsante: `POST /api/sdi/cron` rilegge la PEC e aggiorna gli stati, e `.github/workflows/ricevute-sdi.yml` la chiama ogni 30 minuti (più `workflow_dispatch`).

**Autorizzazione.** La rotta sta fra quelle senza sessione — la chiama un cron, non un browser — e accetta solo `Authorization: Bearer <CRON_SECRET>`, confrontato con `timingSafeEqualStr`. Se `CRON_SECRET` non è impostata sul server la rotta resta **chiusa** (401): un deploy senza la variabile non espone la lettura. La 401 non distingue assente, sbagliata o di lunghezza diversa. Con PEC non collegata risponde `200 {ok:true, skipped:"not_configured"}`, così il workflow non fallisce ogni mezz'ora per una cosa che si sistema dalle Impostazioni.

**Finestra di lettura.** `notifications()` cerca ora `{ from: sdi01@pec.fatturapa.it, since: oggi - 30 giorni }` (`GIORNI_RICEVUTE` in `src/sdi.ts`): la casella si riempie di anni di notifiche e la lettura gira in una funzione con un tempo limite. La finestra vale anche per il pulsante in Impostazioni, che usa lo stesso codice; le notifiche SdI arrivano entro pochi giorni dall'invio.

**Attivazione (una volta sola):**

1. su Vercel, variabile d'ambiente `CRON_SECRET` con un valore lungo e casuale (`openssl rand -base64 32`);
2. su GitHub, secret `CRON_SECRET` con **lo stesso** valore e la variabile di repository `PROD_URL` (già usata da `sorveglianza.yml`);
3. `INTEGRATIONS_KEY` e PEC configurate su Vercel, e uscita IMAP 993 consentita dalla funzione;
4. per provarlo subito: `workflow_dispatch` del workflow «Lettura ricevute SdI».

Il cron nativo di Vercel (`"crons"` in `vercel.json`) resta un'alternativa, ma su piano Hobby la frequenza minima è una volta al giorno: per questo il workflow GitHub. GitHub non è puntuale (10-20 minuti di ritardo con `*/30`), irrilevante per delle ricevute.

**Verifica.** `tests/sdi.test.ts` avvia il server vero (`startServer`) e controlla la rotta: 401 senza header, con segreto diverso e con `Bearer` vuoto; 200 con `skipped` quando la PEC non è collegata; di nuovo 401 quando `CRON_SECRET` manca sul server. Il resto della suite copre che i POST autenticati non siano cambiati.

## Ultima lettura delle ricevute visibile in Impostazioni (25 novembre 2026)

Da fuori non si distingueva «il cron non gira» da «gira e non trova niente». La tabella `sdi_sync` (una riga sola, `id = 1`) registra ogni lettura: `last_at` (ISO), `updated`, `ignorate`, `superate`, `ok`, `error`. `aggiornaEsiti()` la riscrive sempre, anche quando la PEC risponde con un errore: `ok = false` e il motivo, così il pannello può dire *perché* l'ultima volta non è andata. Se il guasto è il database la registrazione stessa fallisce e resta l'errore originale, che è la cosa utile da mostrare. Trattandosi di stato dell'istanza, `sdi_sync` non entra nel backup.

In Impostazioni → Invio allo SdI, sotto il riquadro delle cose che mancano, ora compare «Ultima lettura delle ricevute: 25 nov, 18:40 · 3 aggiornate, 1 senza fattura, 2 più vecchie di quelle registrate», oppure un avviso rosso con l'errore dell'ultima lettura, oppure «Nessuna lettura delle ricevute» se non è mai stata fatta (né dal cron né dal pulsante). L'ora è mostrata in `Europe/Rome` con `timeLabel`.

**Verifica.** `tests/sdi.test.ts` controlla che `last_lettura` inizialmente sia vuota, che dopo una lettura riporti `updated 1 / ignorate 1 / superate 0` con `ok: true` e la data ISO, che una lettura successiva sostituisca i numeri invece di sommarli, e che un guasto IMAP finisca in `last_lettura` con `ok: false` e il messaggio dell'errore.

Migrazione: `prisma/migrations/20261125200000_sdi_letture`.

## Conteggi delle sole notifiche nuove (25 novembre 2026)

La casella viene riletta intera ogni 30 minuti (`{ from, since: oggi - 30 giorni }`), quindi le stesse notifiche tornavano a ogni giro e i due numeri che non dipendono da un cambiamento reale — «senza fattura» e «più vecchie di quelle registrate» — restavano identici per sempre, facendo sembrare fermo il cron.

Ora `elaboraEsiti()` ricorda l'impronta SHA-256 del file di ogni notifica nella tabella `sdi_notifiche` (`chiave` = impronta, `vista_il` = ISO). Una notifica già vista **viene comunque applicata** (l'ordine di `piuRecente()` decide, così una fattura importata dopo può ancora ricevere la sua ricevuta), ma non entra più nei contatori: `ignorate` e `superate` sono le novità di quella lettura. Le righe con `vista_il` più vecchio della finestra di lettura si eliminano a ogni giro, quindi la tabella resta dell'ordine delle notifiche degli ultimi 30 giorni. `updated` non cambia: un aggiornamento è già di per sé un fatto nuovo.

Nel pannello la riga lo dice esplicitamente: «… · 3 aggiornate, 1 senza fattura, 2 più vecchie di quelle registrate (solo le notifiche nuove di quel giro)».

**Verifica.** Due letture delle stesse notifiche danno la seconda volta `0 / 0 / 0`; una notifica senza fattura conta una volta sola e non si ripete; lo scarto già visto dopo un reinvio viene scartato senza essere ricontato. Migrazione: `prisma/migrations/20261125203000_sdi_notifiche_viste` (tabella `sdi_notifiche`, esclusa dal backup come `sdi_sync`: è stato dell'istanza).

## Avviso «il cron non sta girando» (25 novembre 2026)

Il pannello diceva *quando* era avvenuta l'ultima lettura, ma con uno sguardo veloce una data vecchia non si distingue da una di mezz'ora prima: se il workflow «Lettura ricevute SdI» si fermava, le fatture restavano in attesa di ricevuta senza che niente lo dicesse.

Ora, se `last_lettura.at` è più vecchio di **90 minuti**, al posto della riga informativa compare un riquadro rosso: «Il cron non sta girando · 25 nov, 18:40 — L'ultima lettura delle ricevute risale a oltre 90 minuti fa, mentre il cron la esegue ogni 30. Controlla il workflow "Lettura ricevute SdI" su GitHub e la variabile CRON_SECRET su Vercel». La soglia sta in `SDI_CRON_FERMO_MINUTI` in `public/app.js`; 90 minuti sono tre giri saltati, quindi un ritardo di GitHub (10-20 minuti) non fa scattare l'avviso, un cron fermo sì.

Gli altri casi restano come prima e hanno la precedenza: senza letture «Nessuna lettura delle ricevute», con `ok: false` l'errore dell'ultima lettura (che è la causa vera, non il silenzio). Il calcolo è nel browser sulla data ISO già presente in `state.sdi.last_lettura` (la risposta di `/api/state`), quindi nessuna migrazione e nessun campo nuovo sul server.

**Verifica.** Nuovo `tests/sdi-cron.test.ts` (happy-dom, come `apple-form.test.ts`) chiama la funzione che disegna la riga: con una lettura di due ore fa compare «Il cron non sta girando» e la soglia; con dieci minuti fa resta la riga informativa con i conteggi; senza letture resta «Nessuna lettura delle ricevute». Suite completa 245 passati / 1 saltato, `npx tsc --noEmit` → 0, `node --check public/app.js` ok.

**Limite.** Il pannello non è stato aperto nel browser: la resa del riquadro è verificata solo sul testo prodotto dalla funzione.
