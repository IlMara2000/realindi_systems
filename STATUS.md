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
