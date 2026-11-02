"""Deterministic scope-to-effort estimator. Defaults are editable planning examples."""
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

CATALOG = {
    'website': {'name': 'Sito web', 'modules': [
        {'key': 'discovery', 'name': 'Analisi e struttura del sito', 'unit': 'progetto', 'hours': '4', 'quantity': 1},
        {'key': 'pages', 'name': 'Design e sviluppo pagine', 'unit': 'pagina distinta', 'hours': '4', 'quantity': 5},
        {'key': 'cms', 'name': 'Gestione contenuti CMS', 'unit': 'tipologia di contenuto', 'hours': '6', 'quantity': 0},
        {'key': 'forms', 'name': 'Form e acquisizione contatti', 'unit': 'form', 'hours': '3', 'quantity': 1},
        {'key': 'languages', 'name': 'Configurazione lingua aggiuntiva', 'unit': 'lingua', 'hours': '4', 'quantity': 0},
        {'key': 'release', 'name': 'Pubblicazione e passaggio di consegne', 'unit': 'rilascio', 'hours': '4', 'quantity': 1},
    ]},
    'application': {'name': 'Applicazione web', 'modules': [
        {'key': 'discovery', 'name': 'Analisi e architettura', 'unit': 'progetto', 'hours': '8', 'quantity': 1},
        {'key': 'screens', 'name': 'Schermate e flussi applicativi', 'unit': 'schermata', 'hours': '6', 'quantity': 5},
        {'key': 'entities', 'name': 'Gestione dati e API', 'unit': 'entità', 'hours': '6', 'quantity': 3},
        {'key': 'auth', 'name': 'Accesso e gestione ruoli', 'unit': 'sistema di accesso', 'hours': '12', 'quantity': 1},
        {'key': 'integrations', 'name': 'Integrazioni con servizi esterni', 'unit': 'integrazione', 'hours': '8', 'quantity': 0},
        {'key': 'migration', 'name': 'Importazione dati esistenti', 'unit': 'sorgente dati', 'hours': '8', 'quantity': 0},
        {'key': 'release', 'name': 'Rilascio e documentazione', 'unit': 'rilascio', 'hours': '6', 'quantity': 1},
    ]},
    'consulting': {'name': 'Consulenza / assistenza', 'modules': [
        {'key': 'audit', 'name': 'Analisi tecnica iniziale', 'unit': 'sistema', 'hours': '4', 'quantity': 1},
        {'key': 'sessions', 'name': 'Sessioni di consulenza', 'unit': 'sessione', 'hours': '2', 'quantity': 2},
        {'key': 'interventions', 'name': 'Interventi tecnici concordati', 'unit': 'intervento', 'hours': '4', 'quantity': 0},
        {'key': 'report', 'name': 'Report e raccomandazioni', 'unit': 'report', 'hours': '3', 'quantity': 1},
        {'key': 'training', 'name': 'Formazione e affiancamento', 'unit': 'sessione', 'hours': '2', 'quantity': 0},
    ]},
}


def decimal(value, low, high, label):
    try:
        result = Decimal(str(value))
        if not result.is_finite() or not Decimal(str(low)) <= result <= Decimal(str(high)):
            raise InvalidOperation
        # Two decimals keep the inputs and the generated quote rows reproducible.
        if result != result.quantize(Decimal('0.01')):
            raise InvalidOperation
        return result
    except (InvalidOperation, ValueError):
        raise ValueError(f'{label}: inserisci un valore tra {low} e {high}, con massimo due decimali.')


def hours(value):
    return value.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)


def estimate(scope, rate):
    if not isinstance(scope, dict) or scope.get('kind') not in CATALOG:
        raise ValueError('Seleziona una tipologia di lavoro valida.')
    catalog = CATALOG[scope['kind']]
    inputs = scope.get('modules')
    if not isinstance(inputs, list) or not 1 <= len(inputs) <= len(catalog['modules']):
        raise ValueError('Indica le funzionalità concordate con il cliente.')
    tariff = decimal(rate, 0, 100000, 'Tariffa oraria')
    factor = decimal(scope.get('complexity', '1'), 0.5, 3, 'Complessità')
    testing = decimal(scope.get('testing', '0'), 0, 100, 'Test e verifiche (%)')
    coordination = decimal(scope.get('coordination', '0'), 0, 100, 'Coordinamento (%)')
    contingency = decimal(scope.get('contingency', '0'), 0, 100, 'Imprevisti (%)')
    weekly = decimal(scope.get('weekly_hours', '20'), 1, 80, 'Ore disponibili alla settimana')
    expenses = decimal(scope.get('expenses', '0'), 0, 1000000, 'Costi extra')
    definitions = {m['key']: m for m in catalog['modules']}
    seen, normalized, lines = set(), [], []
    base_hours = Decimal(0)
    for entry in inputs:
        if not isinstance(entry, dict) or entry.get('key') not in definitions or entry['key'] in seen:
            raise ValueError('Funzionalità sconosciuta o ripetuta.')
        key = entry['key']
        seen.add(key)
        module = definitions[key]
        qty = decimal(entry.get('quantity'), 0, 1000, 'Quantità')
        if qty != int(qty):
            raise ValueError('La quantità deve essere un numero intero.')
        unit_hours = decimal(entry.get('hours'), 0.01, 1000, 'Ore per unità')
        normalized.append({'key': key, 'name': module['name'], 'unit': module['unit'], 'quantity': int(qty), 'hours': str(unit_hours)})
        if qty == 0:
            continue
        effort = hours(qty * unit_hours * factor)
        base_hours += effort
        lines.append({'description': f"{module['name']} ({int(qty)} × {unit_hours} h × {factor})", 'hours': str(effort), 'rate': str(tariff), 'factor': '1', 'extra': '0'})
    if not lines:
        raise ValueError('Seleziona almeno una funzionalità con quantità maggiore di zero.')
    test_hours = hours(base_hours * testing / 100)
    coordination_hours = hours(base_hours * coordination / 100)
    contingency_hours = hours((base_hours + test_hours + coordination_hours) * contingency / 100)
    for label, effort in [('Test e verifiche', test_hours), ('Coordinamento e revisioni', coordination_hours), ('Riserva per imprevisti', contingency_hours)]:
        if effort:
            lines.append({'description': label, 'hours': str(effort), 'rate': str(tariff), 'factor': '1', 'extra': '0'})
    if expenses:
        lines.append({'description': 'Costi extra concordati', 'hours': '0', 'rate': '0', 'factor': '1', 'extra': str(expenses)})
    total_hours = base_hours + test_hours + coordination_hours + contingency_hours
    normalized_scope = {'kind': scope['kind'], 'modules': normalized, 'complexity': str(factor), 'testing': str(testing), 'coordination': str(coordination), 'contingency': str(contingency), 'weekly_hours': str(weekly), 'expenses': str(expenses)}
    return {'version': 1, 'scope': normalized_scope, 'rate': str(tariff), 'items': lines,
            'base_hours': str(base_hours), 'test_hours': str(test_hours),
            'coordination_hours': str(coordination_hours), 'contingency_hours': str(contingency_hours),
            'total_hours': str(total_hours), 'workload_weeks': str(hours(total_hours / weekly)),
            'assumptions': [
                'Ore per unità e quantità sono ipotesi modificabili, non misure di lavoro già svolto.',
                f'Complessità × {factor} applicata alle attività selezionate.',
                f'Test {testing}% e coordinamento {coordination}% calcolati sulle attività; imprevisti {contingency}% sul lavoro comprensivo di test e coordinamento.',
                'Il carico in settimane dipende dalle ore disponibili; non costituisce una data di consegna.',
                'Sono esclusi servizi ricorrenti, licenze e attività non selezionate, salvo i costi extra indicati.',
            ]}
