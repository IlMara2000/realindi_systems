# REALINDI SYSTEMS — Freelancer workspace

CRM in italiano per consulenti e sviluppatori indipendenti, con profilo fiscale configurabile dall’azienda. Backend Python, SQLite e interfaccia responsive; lxml convalida gli XML contro lo schema FatturaPA ufficiale incluso. L’obiettivo è un prodotto vendibile: la versione attuale separa le aziende tramite installazioni/database indipendenti, non tramite account multi-tenant nella stessa istanza.

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
