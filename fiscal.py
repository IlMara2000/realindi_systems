"""Company-configured Italian FPR12 invoices, with local official-XSD validation.

Does not choose a fiscal regime, infer taxation from ATECO, transmit to SdI or
certify registration of tax IDs. Every finalization requires explicit review.
"""
from collections import defaultdict
from datetime import date
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from functools import lru_cache
from pathlib import Path
import re
from lxml import etree as ET

ROOT = Path(__file__).resolve().parent
NS = 'http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2'
XS = {'xs': 'http://www.w3.org/2001/XMLSchema'}
PROFILE_DEFAULTS = dict(country='', city='', postcode='', province='', tax_regime='', ateco='',
    invoice_vat_rate='', invoice_nature='', invoice_reference='', payment_method='', vat_timing='',
    stamp_mode='', stamp_amount='', cassa_mode='', cassa_type='', cassa_rate='',
    cassa_base_percent='100', cassa_withholding='no', withholding_mode='', withholding_type='',
    withholding_rate='', withholding_base_percent='100', withholding_reason='')
CLIENT_FIELDS = ['country', 'city', 'postcode', 'province', 'tax_country', 'tax_code', 'recipient_code', 'pec', 'buyer_type']
COUNTRIES = set('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split())

class FiscalError(ValueError):
    def __init__(self, errors):
        self.errors = errors if isinstance(errors, list) else [errors]
        super().__init__(' '.join(self.errors))

class LocalResolver(ET.Resolver):
    def resolve(self, url, public_id, context):
        if url.endswith('xmldsig-core-schema.xsd'):
            return self.resolve_filename(str(ROOT / 'schemas/xmldsig-core-schema.xsd'), context)
        raise FiscalError('Lo schema richiede una risorsa esterna non consentita.')

@lru_cache(maxsize=1)
def schema():
    parser = ET.XMLParser(no_network=True, resolve_entities=False, load_dtd=False)
    parser.resolvers.add(LocalResolver())
    document = ET.fromstring((ROOT / 'schemas/fatturapa-1.2.3.xsd').read_bytes(), parser)
    return ET.XMLSchema(document)

@lru_cache(maxsize=1)
def catalog():
    doc = ET.fromstring((ROOT / 'schemas/fatturapa-1.2.3.xsd').read_bytes())
    result = {}
    for key, typename in [('regimes','RegimeFiscaleType'),('natures','NaturaType'),('payments','ModalitaPagamentoType'),('funds','TipoCassaType'),('withholdings','TipoRitenutaType'),('reasons','CausalePagamentoType')]:
        values = doc.xpath(f'//xs:simpleType[@name="{typename}"]//xs:enumeration', namespaces=XS)
        result[key] = [[v.get('value'), ' '.join(' '.join(v.xpath('.//xs:documentation/text()', namespaces=XS)).split()) or v.get('value')] for v in values]
    return result

def choices(key):
    return {v[0] for v in catalog()[key]}

def dec(value, label, low=0, high=100):
    try:
        v = Decimal(str(value))
        if not v.is_finite() or not Decimal(str(low)) <= v <= Decimal(str(high)) or v != v.quantize(Decimal('.01')):
            raise InvalidOperation
        return v
    except (ValueError, InvalidOperation):
        raise FiscalError(f'{label}: valore obbligatorio tra {low} e {high}, con massimo due decimali.')

def rounded(v):
    return int(v.quantize(Decimal('1'), rounding=ROUND_HALF_UP))

def amount(cents):
    return f'{Decimal(cents) / 100:.2f}'

def clean(d, key):
    return str(d.get(key, '')).strip()

def vat_ok(value):
    if not re.fullmatch(r'\d{11}', value):
        return False
    digits = list(map(int, value))
    total = sum(digits[0:10:2]) + sum(2*x if x < 5 else 2*x-9 for x in digits[1:10:2])
    return (10 - total % 10) % 10 == digits[-1] and value != '00000000000'

def profile_errors(s, c):
    errors = []
    for prefix, d, namekey in [('Azienda',s,'business_name'), ('Cliente',c,'name')]:
        for k, label, limit in [(namekey,'denominazione',80),('address','indirizzo',60),('city','comune',60),('postcode','CAP',5),('country','nazione',2)]:
            if not clean(d,k) or len(clean(d,k)) > limit:
                errors.append(f'{prefix}: {label} obbligatorio, massimo {limit} caratteri.')
        country = clean(d,'country').upper()
        if country not in COUNTRIES:
            errors.append(f'{prefix}: scegli una nazione ISO valida.')
        if not re.fullmatch(r'\d{5}', clean(d,'postcode')):
            errors.append(f'{prefix}: CAP di 5 cifre richiesto dal tracciato; per indirizzi esteri usa 00000.')
        if country == 'IT' and not re.fullmatch(r'[A-Z]{2}', clean(d,'province').upper()):
            errors.append(f'{prefix}: provincia italiana obbligatoria (2 lettere).')
        cf = clean(d,'tax_code').upper()
        if cf and not re.fullmatch(r'(?:[A-Z0-9]{16}|\d{11})', cf):
            errors.append(f'{prefix}: codice fiscale non valido nel formato.')
    if clean(s,'country').upper() != 'IT':
        errors.append('Il generatore FatturaPA attuale richiede un emittente stabilito in Italia. Le altre giurisdizioni richiedono un connettore dedicato.')
    if not vat_ok(clean(s,'vat_number')):
        errors.append('Azienda: partita IVA italiana di 11 cifre con controllo formale valido obbligatoria, senza prefisso IT.')
    if clean(s,'tax_regime') not in choices('regimes'):
        errors.append('Azienda: seleziona esplicitamente il regime fiscale nelle impostazioni.')
    kind = clean(c,'buyer_type')
    if kind not in ['business','private']:
        errors.append('Cliente: scegli impresa/professionista o privato. Il flusso PA non è ancora disponibile.')
    country, vat_country, vat = clean(c,'country').upper(), clean(c,'tax_country').upper(), clean(c,'vat_number')
    if kind == 'business' and (not vat or vat_country not in COUNTRIES):
        errors.append('Cliente impresa: identificativo IVA e paese fiscale obbligatori.')
    if vat and vat_country == 'IT' and not vat_ok(vat):
        errors.append('Cliente: partita IVA italiana non valida nel controllo formale.')
    if country != 'IT' and (not vat or vat_country not in COUNTRIES):
        errors.append('Cliente estero: identificativo fiscale estero e paese fiscale obbligatori.')
    if kind == 'private' and country == 'IT' and not clean(c,'tax_code'):
        errors.append('Cliente privato italiano: codice fiscale obbligatorio.')
    code = clean(c,'recipient_code').upper()
    if country == 'IT' and kind == 'business' and not re.fullmatch('[A-Z0-9]{7}', code):
        errors.append('Cliente: codice destinatario di 7 caratteri obbligatorio; indica 0000000 se non disponibile.')
    if country == 'IT' and code == 'XXXXXXX':
        errors.append('Il codice XXXXXXX è riservato ai destinatari esteri.')
    if clean(c,'pec') and not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+',clean(c,'pec')):
        errors.append('Cliente: indirizzo PEC non valido.')
    if clean(s,'iban'):
        iban = clean(s,'iban').replace(' ','').upper()
        if not re.fullmatch('[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}', iban):
            errors.append('Azienda: IBAN non valido.')
        else:
            n = ''.join(str(ord(ch)-55) if ch.isalpha() else ch for ch in iban[4:]+iban[:4])
            if int(n) % 97 != 1:
                errors.append('Azienda: checksum IBAN non valido.')
    return errors

def defaults(s, items, due_date):
    result = {k:s.get(k,'') for k in PROFILE_DEFAULTS if k.startswith(('cassa_','withholding_','stamp_'))}
    result.update(document_date=date.today().isoformat(), due_date=due_date, payment_method=s.get('payment_method',''), vat_timing=s.get('vat_timing',''),
        taxes=[dict(vat_rate=s.get('invoice_vat_rate',''), nature=s.get('invoice_nature',''), reference=s.get('invoice_reference','')) for _ in items],
        cassa_vat_rate=s.get('invoice_vat_rate',''), cassa_nature=s.get('invoice_nature',''), cassa_reference=s.get('invoice_reference',''))
    return result

def tax_line(t, label, regime):
    if not isinstance(t,dict):
        raise FiscalError(f'{label}: trattamento IVA mancante.')
    rate = dec(t.get('vat_rate',''),label+' IVA')
    nature, reference = clean(t,'nature'), clean(t,'reference')
    if rate == 0 and (nature not in choices('natures') or nature in ['N2','N3','N6'] or not reference):
        raise FiscalError(f'{label}: IVA zero richiede natura dettagliata e riferimento normativo.')
    if rate > 0 and nature:
        raise FiscalError(f'{label}: rimuovi la natura per le operazioni con IVA.')
    if regime in ['RF19','RF02'] and rate > 0:
        raise FiscalError(f'{label}: il regime selezionato non è compatibile con IVA esposta.')
    if len(reference)>100:
        raise FiscalError(f'{label}: riferimento normativo massimo 100 caratteri.')
    return dict(vat_rate=f'{rate:.2f}',nature=nature,reference=reference)

def prepare(s, c, items, config, number, progressive):
    errors = profile_errors(s,c)
    if errors:
        raise FiscalError(errors)
    if not isinstance(config,dict):
        raise FiscalError('Compila la verifica fiscale per questa fattura.')
    for key,label in [('stamp_mode','Bollo'),('cassa_mode','Contributo previdenziale'),('withholding_mode','Ritenuta')]:
        if config.get(key) not in ['yes','no']:
            raise FiscalError(f'{label}: scegli esplicitamente se si applica a questa fattura.')
    try:
        document_date = date.fromisoformat(config.get('document_date',''))
        due = date.fromisoformat(config.get('due_date',''))
        if document_date > date.today() or due < document_date:
            raise ValueError
    except (ValueError,TypeError):
        raise FiscalError('Date non valide: emissione non futura e scadenza non precedente alla data documento.')
    if config.get('payment_method') not in choices('payments'):
        raise FiscalError('Seleziona la modalità di pagamento.')
    if config.get('vat_timing') not in ['I','D','S']:
        raise FiscalError('Seleziona l’esigibilità IVA dell’operazione.')
    if config['payment_method'] == 'MP05' and not clean(s,'iban'):
        raise FiscalError('Inserisci l’IBAN aziendale per il pagamento con bonifico.')
    taxes = config.get('taxes')
    if not isinstance(taxes,list) or len(taxes) != len(items):
        raise FiscalError('Verifica il trattamento IVA di ogni voce della fattura.')
    result = {'taxes':[], 'groups':[], 'contribution':0, 'withholding':0, 'stamp':0}
    groups = defaultdict(int)
    subtotal = sum(int(i['amount']) for i in items)
    if subtotal <= 0:
        raise FiscalError('La fattura deve avere un imponibile positivo.')
    for n,(item,t) in enumerate(zip(items,taxes),1):
        t = tax_line(t,f'Voce {n}',s['tax_regime'])
        result['taxes'].append(t)
        groups[(t['vat_rate'],t['nature'],t['reference'])] += int(item['amount'])
    if config['stamp_mode']=='yes':
        result['stamp'] = rounded(dec(config.get('stamp_amount',''),'Importo bollo',.01,100000)*100)
    if config['cassa_mode']=='yes':
        if config.get('cassa_type') not in choices('funds'):
            raise FiscalError('Seleziona la cassa previdenziale.')
        rate = dec(config.get('cassa_rate',''),'Aliquota cassa',.01,100)
        base_pct = dec(config.get('cassa_base_percent',''),'Base cassa (%)',.01,100)
        base = rounded(Decimal(subtotal)*base_pct/100)
        result['contribution'] = rounded(Decimal(base)*rate/100)
        result['contribution_base'] = base
        t = tax_line({'vat_rate':config.get('cassa_vat_rate',''), 'nature':config.get('cassa_nature',''), 'reference':config.get('cassa_reference','')},'Contributo previdenziale',s['tax_regime'])
        result['contribution_tax'] = t
        groups[(t['vat_rate'],t['nature'],t['reference'])] += result['contribution']
        if config.get('cassa_withholding') not in ['yes','no']:
            raise FiscalError('Indica se il contributo previdenziale è soggetto a ritenuta.')
    if config['withholding_mode']=='yes':
        if s['tax_regime'] in ['RF19','RF02']:
            raise FiscalError('Il regime selezionato non è compatibile con la ritenuta configurata.')
        if config.get('withholding_type') not in choices('withholdings') or config.get('withholding_reason') not in choices('reasons'):
            raise FiscalError('Seleziona tipo e causale della ritenuta.')
        rate = dec(config.get('withholding_rate',''),'Aliquota ritenuta',.01,100)
        base_pct = dec(config.get('withholding_base_percent',''),'Base ritenuta (%)',.01,100)
        base = subtotal + (result['contribution'] if config.get('cassa_withholding')=='yes' else 0)
        result['withholding_base'] = rounded(Decimal(base)*base_pct/100)
        result['withholding'] = rounded(Decimal(result['withholding_base'])*rate/100)
    elif config['cassa_mode']=='yes' and config.get('cassa_withholding')=='yes':
        raise FiscalError('Il contributo è indicato soggetto a ritenuta ma la ritenuta non è attiva.')
    for (rate,nature,reference),base in groups.items():
        result['groups'].append(dict(vat_rate=rate,nature=nature,reference=reference,base=base,vat=rounded(Decimal(base)*Decimal(rate)/100)))
    result['subtotal'] = subtotal
    result['vat'] = sum(g['vat'] for g in result['groups'])
    # Stamp is borne by issuer; reimbursements must be explicit taxed invoice lines.
    result['total'] = subtotal + result['contribution'] + result['vat']
    result['split_vat'] = result['vat'] if config['vat_timing']=='S' else 0
    result['payable'] = result['total'] - result['withholding'] - result['split_vat']
    if result['payable']<0:
        raise FiscalError('Il netto da pagare non può essere negativo.')
    xml = build_xml(s,c,items,config,result,number,progressive)
    validate_xml(xml)
    return result,xml

def file_progressive(identifier):
    # FatturaPA filename suffix: at most five alphanumeric characters.
    if not 0 < identifier < 36**5:
        raise FiscalError('Spazio dei progressivi file esaurito: configura una nuova serie di trasmissione.')
    value = ''
    while identifier:
        identifier, remainder = divmod(identifier,36)
        value = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'[remainder] + value
    return value.rjust(5,'0')

def node(parent, name, value=None):
    e=ET.SubElement(parent,name)
    if value is not None: e.text=str(value)
    return e

def tax_id(parent,country,value):
    e=node(parent,'IdFiscaleIVA');node(e,'IdPaese',country);node(e,'IdCodice',value)

def address(parent,d):
    e=node(parent,'Sede')
    for tag,key in [('Indirizzo','address'),('CAP','postcode'),('Comune','city')]: node(e,tag,clean(d,key))
    if clean(d,'province') and clean(d,'country').upper()=='IT': node(e,'Provincia',clean(d,'province').upper())
    node(e,'Nazione',clean(d,'country').upper())

def build_xml(s,c,items,conf,r,number,progressive):
    root=ET.Element('{'+NS+'}FatturaElettronica',nsmap={'p':NS},versione='FPR12')
    header=node(root,'FatturaElettronicaHeader');trans=node(header,'DatiTrasmissione')
    sender=node(trans,'IdTrasmittente');node(sender,'IdPaese','IT');node(sender,'IdCodice',s['vat_number'])
    node(trans,'ProgressivoInvio',progressive);node(trans,'FormatoTrasmissione','FPR12')
    code='XXXXXXX' if c['country'].upper()!='IT' else ('0000000' if c['buyer_type']=='private' else c['recipient_code'].upper())
    node(trans,'CodiceDestinatario',code)
    if code=='0000000' and clean(c,'pec'):node(trans,'PECDestinatario',c['pec'])
    seller=node(header,'CedentePrestatore');an=node(seller,'DatiAnagrafici');tax_id(an,'IT',s['vat_number'])
    if clean(s,'tax_code'):node(an,'CodiceFiscale',s['tax_code'].upper())
    node(node(an,'Anagrafica'),'Denominazione',s['business_name']);node(an,'RegimeFiscale',s['tax_regime']);address(seller,s)
    buyer=node(header,'CessionarioCommittente');an=node(buyer,'DatiAnagrafici')
    if clean(c,'vat_number'):tax_id(an,c['tax_country'].upper(),c['vat_number'])
    if clean(c,'tax_code'):node(an,'CodiceFiscale',c['tax_code'].upper())
    node(node(an,'Anagrafica'),'Denominazione',c['company'] or c['name']);address(buyer,c)
    body=node(root,'FatturaElettronicaBody');general=node(node(body,'DatiGenerali'),'DatiGeneraliDocumento')
    for tag,value in [('TipoDocumento','TD01'),('Divisa','EUR'),('Data',conf['document_date']),('Numero',number)]:node(general,tag,value)
    if r['withholding']:
        w=node(general,'DatiRitenuta')
        for tag,value in [('TipoRitenuta',conf['withholding_type']),('ImportoRitenuta',amount(r['withholding'])),('AliquotaRitenuta',f"{Decimal(conf['withholding_rate']):.2f}"),('CausalePagamento',conf['withholding_reason'])]:node(w,tag,value)
    if r['stamp']:
        stamp=node(general,'DatiBollo');node(stamp,'BolloVirtuale','SI');node(stamp,'ImportoBollo',amount(r['stamp']))
    if r['contribution']:
        fund=node(general,'DatiCassaPrevidenziale');t=r['contribution_tax']
        for tag,value in [('TipoCassa',conf['cassa_type']),('AlCassa',f"{Decimal(conf['cassa_rate']):.2f}"),('ImportoContributoCassa',amount(r['contribution'])),('ImponibileCassa',amount(r['contribution_base'])),('AliquotaIVA',t['vat_rate'])]:node(fund,tag,value)
        if conf.get('cassa_withholding')=='yes':node(fund,'Ritenuta','SI')
        if t['nature']:node(fund,'Natura',t['nature'])
    node(general,'ImportoTotaleDocumento',amount(r['total']))
    goods=node(body,'DatiBeniServizi')
    for n,(item,t) in enumerate(zip(items,r['taxes']),1):
        line=node(goods,'DettaglioLinee')
        # Price already includes quoted hours, complexity and extras: one agreed deliverable.
        for tag,value in [('NumeroLinea',n),('Descrizione',item['description']),('Quantita','1.00'),('PrezzoUnitario',amount(item['amount'])),('PrezzoTotale',amount(item['amount'])),('AliquotaIVA',t['vat_rate'])]:node(line,tag,value)
        if r['withholding']:node(line,'Ritenuta','SI')
        if t['nature']:node(line,'Natura',t['nature'])
    for g in r['groups']:
        summary=node(goods,'DatiRiepilogo');node(summary,'AliquotaIVA',g['vat_rate'])
        if g['nature']:node(summary,'Natura',g['nature'])
        node(summary,'ImponibileImporto',amount(g['base']));node(summary,'Imposta',amount(g['vat']))
        if Decimal(g['vat_rate'])>0:node(summary,'EsigibilitaIVA',conf['vat_timing'])
        if g['reference']:node(summary,'RiferimentoNormativo',g['reference'])
    pay=node(body,'DatiPagamento');node(pay,'CondizioniPagamento','TP02');detail=node(pay,'DettaglioPagamento')
    for tag,value in [('ModalitaPagamento',conf['payment_method']),('DataScadenzaPagamento',conf['due_date']),('ImportoPagamento',amount(r['payable']))]:node(detail,tag,value)
    if clean(s,'iban'):node(detail,'IBAN',s['iban'].replace(' ','').upper())
    return ET.tostring(root,encoding='utf-8',xml_declaration=True,pretty_print=True)

def validate_xml(xml):
    doc=ET.fromstring(xml,ET.XMLParser(no_network=True,resolve_entities=False))
    try:
        schema().assertValid(doc)
    except ET.DocumentInvalid as exc:
        raise FiscalError(['XML non conforme allo schema: '+e.message for e in list(exc.error_log)[:8]])
