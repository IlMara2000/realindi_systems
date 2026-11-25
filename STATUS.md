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
