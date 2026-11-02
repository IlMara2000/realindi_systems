# Fonti e perimetro della validazione XML

Recuperati dal portale ufficiale il 30 ottobre 2026:

- [Pagina formato FatturaPA](https://www.fatturapa.gov.it/it/norme-e-regole/documentazione-fattura-elettronica/formato-fatturapa/)
- [Schema FPR12 versione 1.2.3](https://www.fatturapa.gov.it/export/documenti/fatturapa/v1.4/Schema_VFPR12_v1.2.3.xsd), salvato senza modifiche in `fatturapa-1.2.3.xsd`.
- [XML Signature schema W3C](https://www.w3.org/TR/2002/REC-xmldsig-core-20020212/xmldsig-core-schema.xsd), importazione richiesta dallo schema ufficiale, salvata in `xmldsig-core-schema.xsd`.

La validazione usa lxml con risoluzione locale dell'import, accesso di rete disabilitato e nessuna espansione di entità nei documenti. Codici regime fiscale, natura IVA, cassa, ritenuta e pagamento sono letti dalle enumerazioni dello schema; non si ricavano da ATECO o località.

L'XSD convalida la struttura, non l'esistenza dei dati nei registri, la qualificazione tributaria dell'operazione o tutti i controlli SdI. L'applicazione aggiunge controlli di completezza, coerenza, checksum P. IVA italiana/IBAN, calcoli e conferma esplicita dei dati. Non effettua invii o interrogazioni a servizi fiscali.

Implementato: TD01, EUR, FPR12, emittente con sede in Italia, clienti imprese/privati italiani o esteri. IVA/natura per riga, un contributo previdenziale, una ritenuta con percentuale uniforme di base, esigibilità IVA, bollo esplicito a carico emittente, pagamento unico.

Non implementati: fatture PA/FPA12 e firma, note di credito, autofatture, rappresentanti fiscali/stabili organizzazioni, iscrizione REA e altre anagrafiche societarie speciali, dichiarazioni d'intento strutturate, più casse/ritenute contemporanee, ritenute selettive per riga, addebito automatico del bollo, invio e ricevute SdI, verifiche anagrafiche remote o conservazione. Non presentare questo sottoinsieme come supporto universale di tutti i casi fiscali.

Prima della distribuzione commerciale occorre validare il perimetro tributario richiesto, collegare un servizio di invio/conservazione e mantenere schemi e controlli aggiornati.

## SHA-256 degli artefatti

- `fatturapa-1.2.3.xsd`: `152944f6eef9f5d69ef6e955ee173b32142b00a8c1c5222fc97dfab5910e8a8c`
- `xmldsig-core-schema.xsd`: `35cf8197da812c85e40d57891b35c94187569ed474a2dac813ce5090dafcd35c`
