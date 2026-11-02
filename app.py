"""REALINDI Systems — CRM personale, Python 3.10+, nessuna dipendenza."""
import base64
import estimator
import fiscal
from contextlib import contextmanager
import hashlib
import hmac
import io
import json
import os
import re
import secrets
import sqlite3
from socketserver import TCPServer
import time
import zipfile
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get('CRM_DATA_DIR', ROOT / 'data'))
TZ = ZoneInfo('Europe/Rome')
DEFAULTS = {'business_name': '', 'owner_name': '', 'email': '', 'address': '',
            'vat_number': '', 'tax_code': '', 'iban': '', 'tax_label': '',
            'vat_rate': '0', 'hourly_rate': '60', 'booking_title': 'Parliamo del tuo progetto',
            'booking_description': 'Un primo incontro per capire obiettivi, tempi e possibilità.',
            'booking_duration': 30, 'booking_start': 9, 'booking_end': 18,
            'booking_days': [0, 1, 2, 3, 4], 'booking_enabled': True,
            'booking_notice': 24, 'booking_horizon': 30, 'public_url': ''}

DEFAULTS.update(fiscal.PROFILE_DEFAULTS)

class Invalid(Exception):
    pass

@contextmanager
def db():
    c = sqlite3.connect(DATA / 'crm.sqlite3', timeout=20)
    c.row_factory = sqlite3.Row
    c.execute('PRAGMA foreign_keys=ON')
    try:
        with c:
            yield c
    finally:
        c.close()

def init():
    DATA.mkdir(parents=True, exist_ok=True, mode=0o700)
    (DATA / 'documents').mkdir(exist_ok=True, mode=0o700)
    with db() as c:
        c.executescript('''
        CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, expires REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS clients(id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL,
          company TEXT NOT NULL, phone TEXT NOT NULL, vat_number TEXT NOT NULL, address TEXT NOT NULL,
          notes TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS projects(id INTEGER PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES clients(id),
          title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL, deadline TEXT NOT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS quotes(id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id),
          title TEXT NOT NULL, items TEXT NOT NULL, subtotal INTEGER NOT NULL, vat INTEGER NOT NULL,
          total INTEGER NOT NULL, vat_rate TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
          valid_until TEXT NOT NULL, notes TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS invoices(id INTEGER PRIMARY KEY, quote_id INTEGER UNIQUE REFERENCES quotes(id),
          project_id INTEGER NOT NULL REFERENCES projects(id), number TEXT UNIQUE, snapshot TEXT NOT NULL,
          subtotal INTEGER NOT NULL, vat INTEGER NOT NULL, total INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
          due_date TEXT NOT NULL, issued_at TEXT, paid_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS documents(id INTEGER PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES clients(id),
          project_id INTEGER REFERENCES projects(id), name TEXT NOT NULL, storage_name TEXT NOT NULL UNIQUE,
          size INTEGER NOT NULL, sha256 TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS appointments(id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL,
          notes TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'confirmed',
          cancel_token TEXT NOT NULL UNIQUE, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS blocks(id INTEGER PRIMARY KEY, start TEXT NOT NULL, end TEXT NOT NULL, reason TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS login_attempts(ip TEXT PRIMARY KEY, count INTEGER NOT NULL, reset REAL NOT NULL);
        ''')
        # Additive migration: keep existing quotes and restored backups usable.
        quote_columns = {r['name'] for r in c.execute('PRAGMA table_info(quotes)')}
        if 'estimate' not in quote_columns:
            c.execute('ALTER TABLE quotes ADD COLUMN estimate TEXT')
        if 'generation_key' not in quote_columns:
            c.execute('ALTER TABLE quotes ADD COLUMN generation_key TEXT')
        c.execute('CREATE UNIQUE INDEX IF NOT EXISTS quote_generation_key ON quotes(generation_key)')
        client_columns = {r['name'] for r in c.execute('PRAGMA table_info(clients)')}
        for key in fiscal.CLIENT_FIELDS:
            if key not in client_columns:
                c.execute(f"ALTER TABLE clients ADD COLUMN {key} TEXT NOT NULL DEFAULT ''")
        invoice_columns = {r['name'] for r in c.execute('PRAGMA table_info(invoices)')}
        for key, kind in [('xml', 'BLOB'), ('xml_filename', 'TEXT')]:
            if key not in invoice_columns:
                c.execute(f'ALTER TABLE invoices ADD COLUMN {key} {kind}')
        for k, v in DEFAULTS.items():
            c.execute('INSERT OR IGNORE INTO settings VALUES(?,?)', (k, json.dumps(v)))
        c.execute('INSERT OR IGNORE INTO settings VALUES(?,?)', ('booking_slug', json.dumps(secrets.token_urlsafe(16))))

def settings(c):
    return {r['key']: json.loads(r['value']) for r in c.execute('SELECT * FROM settings') if r['key'] != 'password'}

def required(d, k, max_len=300):
    v = str(d.get(k, '')).strip()
    if not v or len(v) > max_len:
        raise Invalid(f'Il campo {k} è obbligatorio (massimo {max_len} caratteri).')
    return v

def optional(d, k, max_len=5000):
    v = str(d.get(k, '')).strip()
    if len(v) > max_len:
        raise Invalid(f'Il campo {k} è troppo lungo.')
    return v

def email(d):
    v = required(d, 'email', 254)
    if not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', v):
        raise Invalid('Indirizzo email non valido.')
    return v

def number(v, minimum=0, maximum=1000000):
    try:
        n = Decimal(str(v))
        if not n.is_finite() or not Decimal(str(minimum)) <= n <= Decimal(str(maximum)):
            raise InvalidOperation
        return n
    except (InvalidOperation, ValueError):
        raise Invalid('Valore numerico non valido.')

def cents(v):
    return int((v * 100).quantize(Decimal('1'), rounding=ROUND_HALF_UP))

def check_date(v):
    try:
        return date.fromisoformat(str(v)).isoformat()
    except ValueError:
        raise Invalid('Data non valida.')

def instant(v):
    try:
        dt = datetime.fromisoformat(v.replace('Z', '+00:00'))
        if dt.tzinfo is None:
            raise ValueError
        return dt.astimezone(timezone.utc)
    except (ValueError, TypeError, AttributeError):
        raise Invalid('Data e ora devono includere il fuso orario.')

def iso(dt):
    return dt.astimezone(timezone.utc).isoformat(timespec='seconds')

def row(c, table, id):
    r = c.execute(f'SELECT * FROM {table} WHERE id=?', (id,)).fetchone()
    if r is None:
        raise Invalid('Elemento non trovato.')
    return dict(r)

def calculate(items, rate):
    if not isinstance(items, list) or not 1 <= len(items) <= 100:
        raise Invalid('Inserisci da 1 a 100 voci nel preventivo.')
    lines, subtotal = [], 0
    for item in items:
        desc = required(item, 'description', 500)
        hours = number(item.get('hours'), 0, 100000)
        price = number(item.get('rate'), 0, 100000)
        factor = number(item.get('factor', 1), 0.1, 10)
        extra = number(item.get('extra', 0), 0, 1000000)
        amount = cents(hours * price * factor + extra)
        subtotal += amount
        lines.append(dict(description=desc, hours=str(hours), rate=str(price), factor=str(factor), extra=str(extra), amount=amount))
    tax_rate = number(rate, 0, 100)
    vat = int((Decimal(subtotal) * tax_rate / 100).quantize(Decimal('1'), rounding=ROUND_HALF_UP))
    return dict(items=lines, subtotal=subtotal, vat=vat, total=subtotal + vat, vat_rate=str(tax_rate))

def available(c, day):
    s = settings(c)
    d = date.fromisoformat(check_date(day))
    now = datetime.now(timezone.utc)
    if not s['booking_enabled'] or d.weekday() not in s['booking_days'] or d > datetime.now(TZ).date() + timedelta(days=s['booking_horizon']):
        return []
    busy = [dict(r) for r in c.execute("SELECT start,end FROM appointments WHERE status='confirmed' UNION ALL SELECT start,end FROM blocks")]
    slots = []
    cursor = datetime(d.year, d.month, d.day, s['booking_start'], tzinfo=TZ)
    limit = cursor.replace(hour=s['booking_end'])
    while cursor + timedelta(minutes=s['booking_duration']) <= limit:
        end = cursor + timedelta(minutes=s['booking_duration'])
        a, b = iso(cursor), iso(end)
        if cursor >= now + timedelta(hours=s['booking_notice']) and not any(a < r['end'] and b > r['start'] for r in busy):
            slots.append({'start': a, 'end': b, 'label': cursor.strftime('%H:%M')})
        cursor = end
    return slots

def public_url(v):
    # The address clients open: an origin only, so /book/ and /api/ stay on the same host.
    v = str(v).strip().rstrip('/')
    if not v:
        return ''
    u = urlparse(v)
    if u.scheme not in ('https', 'http') or not u.hostname or u.path or u.query or u.fragment or u.username or u.password:
        raise Invalid('Indirizzo pubblico non valido: usa il formato https://prenotazioni.esempio.it, senza percorso.')
    if u.scheme == 'http' and u.hostname not in ('127.0.0.1', 'localhost'):
        raise Invalid('Usa un indirizzo HTTPS: i clienti inseriscono dati personali.')
    return v

def hash_password(password, salt):
    return hashlib.pbkdf2_hmac('sha256', password.encode(), bytes.fromhex(salt), 300000).hex()

class Server(ThreadingHTTPServer):
    def server_bind(self):
        # Local startup must not wait for reverse DNS on the machine hostname.
        TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]

class Handler(BaseHTTPRequestHandler):
    server_version = 'Realindi'
    def log_message(self, fmt, *args):
        # Do not log booking cancellation tokens or document names.
        pass

    def send(self, value, status=200, content_type='application/json; charset=utf-8', headers=None):
        data = json.dumps(value, ensure_ascii=False).encode() if content_type.startswith('application/json') else value
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def auth(self, c):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get('Cookie', ''))
            token = cookie['crm_session'].value
        except Exception:
            return False
        r = c.execute('SELECT expires FROM sessions WHERE token=?', (hashlib.sha256(token.encode()).hexdigest(),)).fetchone()
        return r is not None and r[0] > time.time()

    def do_GET(self):
        try:
            self.get()
        except Invalid as e:
            self.send({'error': str(e)}, 400)
        except Exception:
            self.send({'error': 'Errore interno. Controlla il server.'}, 500)
            import traceback
            traceback.print_exc()

    def get(self):
        u = urlparse(self.path)
        p = u.path
        q = parse_qs(u.query)
        if p in ('/', '/app.js', '/estimate.js', '/fiscal.js', '/style.css') or p.startswith('/book/'):
            file = 'index.html' if p == '/' or p.startswith('/book/') else p[1:]
            mime = {'index.html': 'text/html; charset=utf-8', 'app.js': 'text/javascript; charset=utf-8', 'estimate.js': 'text/javascript; charset=utf-8', 'fiscal.js': 'text/javascript; charset=utf-8', 'style.css': 'text/css; charset=utf-8'}[file]
            return self.send((ROOT / 'static' / file).read_bytes(), content_type=mime)
        with db() as c:
            if p == '/api/session':
                return self.send({'setup': c.execute("SELECT 1 FROM settings WHERE key='password'").fetchone() is None, 'authenticated': self.auth(c)})
            if p.startswith('/api/booking/'):
                slug = p.split('/')[-1]
                s = settings(c)
                if slug != s['booking_slug']:
                    return self.send({'error': 'Pagina non trovata.'}, 404)
                info = {k: s[k] for k in ['business_name', 'booking_title', 'booking_description', 'booking_duration', 'booking_enabled', 'booking_horizon']}
                info['timezone'] = 'Europe/Rome'
                if 'day' in q:
                    info['slots'] = available(c, q['day'][0])
                return self.send(info)
            if not self.auth(c):
                return self.send({'error': 'Accedi per continuare.'}, 401)
            if p == '/api/estimates/catalog':
                return self.send(estimator.CATALOG)
            if p == '/api/state':
                result = {table: [dict(r) for r in c.execute(f'SELECT * FROM {table} ORDER BY id DESC')] for table in ['clients', 'projects', 'quotes', 'invoices', 'documents', 'appointments', 'blocks']}
                result['settings'] = settings(c)
                result['fiscal_catalog'] = fiscal.catalog()
                for r in result['quotes']:
                    r['items'] = json.loads(r['items'])
                    r['estimate'] = json.loads(r['estimate']) if r['estimate'] else None
                for r in result['invoices']:
                    r['snapshot'] = json.loads(r['snapshot'])
                    r['xml_generated'] = r.pop('xml') is not None
                return self.send(result)
            if re.fullmatch(r'/api/invoices/\d+/fiscal', p):
                inv = row(c, 'invoices', p.split('/')[3])
                snapshot = json.loads(inv['snapshot'])
                client = row(c, 'clients', row(c, 'projects', inv['project_id'])['client_id'])
                s = settings(c)
                return self.send({'business': s, 'client': client, 'items': snapshot['items'],
                    'config': fiscal.defaults(s, snapshot['items'], inv['due_date']), 'profile_errors': fiscal.profile_errors(s, client)})
            if re.fullmatch(r'/api/invoices/\d+/xml', p):
                inv = row(c, 'invoices', p.split('/')[3])
                if not inv['xml']:
                    raise Invalid('Questa fattura non ha ancora un XML validato.')
                return self.send(inv['xml'], content_type='application/xml; charset=utf-8', headers={'Content-Disposition': 'attachment; filename="' + inv['xml_filename'] + '"'})
            if p.startswith('/api/documents/'):
                r = row(c, 'documents', p.split('/')[-1])
                from urllib.parse import quote
                return self.send((DATA / 'documents' / r['storage_name']).read_bytes(), content_type='application/octet-stream', headers={'Content-Disposition': "attachment; filename*=UTF-8''" + quote(r['name'])})
            if p == '/api/backup':
                buf = io.BytesIO()
                target = sqlite3.connect(':memory:')
                c.backup(target)
                # Dump excludes live login sessions and credentials for a portable data export.
                target.execute('DELETE FROM sessions')
                target.execute('DELETE FROM login_attempts')
                target.execute("DELETE FROM settings WHERE key='password'")
                with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
                    z.writestr('database.sql', '\n'.join(target.iterdump()))
                    for r in c.execute('SELECT storage_name FROM documents'):
                        z.write(DATA / 'documents' / r[0], 'documents/' + r[0])
                    z.writestr('LEGGIMI.txt', 'Esportazione CRM. Ripristino: python3 manage.py restore archivio.zip --destination cartella-vuota\nAl primo avvio scegli una nuova password.\n')
                target.close()
                return self.send(buf.getvalue(), content_type='application/zip', headers={'Content-Disposition': 'attachment; filename="realindi-backup.zip"'})
        self.send({'error': 'Risorsa non trovata.'}, 404)

    def do_POST(self):
        try:
            origin = self.headers.get('Origin')
            if origin and urlparse(origin).netloc != self.headers.get('Host'):
                return self.send({'error': 'Origine non consentita.'}, 403)
            if self.headers.get('Sec-Fetch-Site') == 'cross-site':
                return self.send({'error': 'Origine non consentita.'}, 403)
            if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
                raise Invalid('Inviare dati JSON.')
            length = int(self.headers.get('Content-Length', '0'))
            if length < 1 or length > 15 * 1024 * 1024:
                raise Invalid('Richiesta troppo grande o vuota (documenti massimo 10 MB).')
            d = json.loads(self.rfile.read(length))
            if not isinstance(d, dict):
                raise Invalid('Richiesta non valida.')
            with db() as c:
                c.execute('BEGIN IMMEDIATE')
                result, headers = self.post(c, urlparse(self.path).path, d), None
                if isinstance(result, tuple):
                    result, headers = result
                c.commit()
            self.send(result, headers=headers)
        except (Invalid, ValueError, TypeError, KeyError) as e:
            self.send({'error': str(e) if isinstance(e, Invalid) else 'Dati non validi.'}, 400)
        except sqlite3.IntegrityError:
            self.send({'error': 'Operazione in conflitto con i dati esistenti.'}, 409)
        except Exception:
            self.send({'error': 'Errore interno. Riprova.'}, 500)
            import traceback
            traceback.print_exc()

    def post(self, c, p, d):
        if p in ['/api/setup', '/api/login']:
            password = required(d, 'password', 256)
            old = c.execute("SELECT value FROM settings WHERE key='password'").fetchone()
            if p == '/api/setup':
                if old:
                    raise Invalid('Configurazione già completata.')
                if len(password) < 12:
                    raise Invalid('Usa una password di almeno 12 caratteri.')
                salt = secrets.token_hex(16)
                c.execute('INSERT INTO settings VALUES(?,?)', ('password', json.dumps([salt, hash_password(password, salt)])))
            else:
                ip = self.client_address[0]
                attempt = c.execute('SELECT * FROM login_attempts WHERE ip=?', (ip,)).fetchone()
                if attempt and attempt['reset'] > time.time() and attempt['count'] >= 10:
                    raise Invalid('Troppi tentativi. Riprova tra 15 minuti.')
                if not old:
                    raise Invalid('Configura prima il tuo account.')
                salt, saved = json.loads(old[0])
                if not hmac.compare_digest(saved, hash_password(password, salt)):
                    count = attempt['count'] + 1 if attempt and attempt['reset'] > time.time() else 1
                    reset = attempt['reset'] if attempt and attempt['reset'] > time.time() else time.time() + 900
                    c.execute('INSERT OR REPLACE INTO login_attempts VALUES(?,?,?)', (ip, count, reset))
                    c.commit()
                    raise Invalid('Password non corretta.')
                c.execute('DELETE FROM login_attempts WHERE ip=?', (ip,))
            token = secrets.token_urlsafe(32)
            c.execute('DELETE FROM sessions WHERE expires<?', (time.time(),))
            c.execute('INSERT INTO sessions VALUES(?,?)', (hashlib.sha256(token.encode()).hexdigest(), time.time() + 43200))
            secure = '; Secure' if os.environ.get('CRM_SECURE_COOKIE') == '1' else ''
            return {'ok': True}, {'Set-Cookie': f'crm_session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200{secure}'}
        if p.startswith('/api/booking/'):
            s = settings(c)
            if p.split('/')[-1] != s['booking_slug']:
                raise Invalid('Pagina non trovata.')
            start = instant(required(d, 'start'))
            found = next((slot for slot in available(c, start.astimezone(TZ).date().isoformat()) if slot['start'] == iso(start)), None)
            if not found:
                raise Invalid('Questo orario non è più disponibile. Scegline un altro.')
            token = secrets.token_urlsafe(32)
            c.execute('INSERT INTO appointments(name,email,notes,start,end,cancel_token) VALUES(?,?,?,?,?,?)', (required(d, 'name'), email(d), optional(d, 'notes'), found['start'], found['end'], token))
            return {'ok': True, 'start': found['start'], 'end': found['end'], 'cancel_token': token}
        if p == '/api/cancel-booking':
            token = required(d, 'token')
            r = c.execute('SELECT * FROM appointments WHERE cancel_token=?', (token,)).fetchone()
            if not r:
                raise Invalid('Prenotazione non trovata.')
            c.execute("UPDATE appointments SET status='cancelled' WHERE id=?", (r['id'],))
            return {'ok': True}
        if not self.auth(c):
            raise Invalid('Sessione scaduta. Accedi di nuovo.')
        if p == '/api/logout':
            cookie = SimpleCookie(self.headers.get('Cookie', ''))
            c.execute('DELETE FROM sessions WHERE token=?', (hashlib.sha256(cookie['crm_session'].value.encode()).hexdigest(),))
            return {'ok': True}, {'Set-Cookie': 'crm_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'}
        if p == '/api/settings':
            s = settings(c)
            for k in DEFAULTS:
                if k in d:
                    if k in ['booking_duration', 'booking_start', 'booking_end', 'booking_notice', 'booking_horizon']:
                        limits = {'booking_duration': (15, 180), 'booking_start': (0, 23), 'booking_end': (1, 23), 'booking_notice': (0, 720), 'booking_horizon': (1, 180)}
                        n = number(d[k], *limits[k])
                        if n != int(n):
                            raise Invalid('Inserisci un numero intero.')
                        s[k] = int(n)
                    elif k == 'booking_days':
                        if not isinstance(d[k], list) or not all(type(x) is int and x in range(7) for x in d[k]):
                            raise Invalid('Giorni non validi.')
                        s[k] = sorted(set(d[k]))
                    elif k == 'booking_enabled':
                        if not isinstance(d[k], bool):
                            raise Invalid('Disponibilità non valida.')
                        s[k] = d[k]
                    elif k in ['vat_rate', 'hourly_rate']:
                        s[k] = str(number(d[k], 0, 100 if k == 'vat_rate' else 100000))
                    elif k == 'public_url':
                        s[k] = public_url(d[k])
                    else:
                        s[k] = optional(d, k)
            if s['booking_start'] >= s['booking_end'] or ('business_name' in d and not s['business_name']):
                raise Invalid('Controlla nome attività e orari di disponibilità.')
            for k in DEFAULTS:
                # Upsert: a database created before a new setting existed gains it on first save.
                c.execute('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', (k, json.dumps(s[k])))
            return {'ok': True}
        if p == '/api/clients':
            values = [required(d, 'name'), email(d)] + [optional(d, k) for k in ['company', 'phone', 'vat_number', 'address', 'notes']]
            if d.get('id'):
                existing = row(c, 'clients', d['id'])
                for key in fiscal.CLIENT_FIELDS:
                    if key in d:
                        c.execute(f'UPDATE clients SET {key}=? WHERE id=?', (optional(d, key, 200), d['id']))
                c.execute('UPDATE clients SET name=?,email=?,company=?,phone=?,vat_number=?,address=?,notes=? WHERE id=?', (*values, d['id']))
                return {'id': d['id']}
            id = c.execute('INSERT INTO clients(name,email,company,phone,vat_number,address,notes) VALUES(?,?,?,?,?,?,?)', values).lastrowid
            for key in fiscal.CLIENT_FIELDS:
                if key in d:
                    c.execute(f'UPDATE clients SET {key}=? WHERE id=?', (optional(d, key, 200), id))
            return {'id': id}
        if p == '/api/projects':
            row(c, 'clients', d.get('client_id'))
            status = d.get('status', 'discovery')
            if status not in ['discovery', 'active', 'paused', 'completed']:
                raise Invalid('Stato progetto non valido.')
            deadline = check_date(d['deadline']) if d.get('deadline') else ''
            values = [d['client_id'], required(d, 'title'), optional(d, 'description'), status, deadline]
            if d.get('id'):
                old = row(c, 'projects', d['id'])
                if str(old['client_id']) != str(d['client_id']):
                    raise Invalid('Il cliente del progetto non può essere cambiato.')
                c.execute('UPDATE projects SET client_id=?,title=?,description=?,status=?,deadline=? WHERE id=?', (*values, d['id']))
                return {'id': d['id']}
            return {'id': c.execute('INSERT INTO projects(client_id,title,description,status,deadline) VALUES(?,?,?,?,?)', values).lastrowid}
        if p in ['/api/estimates/preview', '/api/estimates']:
            project = row(c, 'projects', d.get('project_id'))
            # A stable key makes a retry return the same draft, never a duplicate.
            key = None
            if p == '/api/estimates':
                key = required(d, 'generation_key', 80)
                if not re.fullmatch(r'[a-zA-Z0-9_-]{16,80}', key):
                    raise Invalid('Identificativo di generazione non valido.')
                previous = c.execute('SELECT id,project_id FROM quotes WHERE generation_key=?', (key,)).fetchone()
                if previous:
                    if previous['project_id'] != project['id']:
                        raise Invalid('La richiesta appartiene a un altro progetto.')
                    return {'id': previous['id']}
            s = settings(c)
            try:
                estimate = estimator.estimate(d.get('scope'), d.get('rate', s['hourly_rate']))
            except ValueError as exc:
                raise Invalid(str(exc))
            result = calculate(estimate['items'], d.get('vat_rate', s['vat_rate']))
            estimate.update(result)
            estimate['project'] = {k: project[k] for k in ['id', 'title', 'description', 'deadline']}
            estimate['created_at'] = iso(datetime.now(timezone.utc))
            if p == '/api/estimates/preview':
                return estimate
            valid_until = check_date(d.get('valid_until'))
            if valid_until < datetime.now(TZ).date().isoformat():
                raise Invalid('La validità del nuovo preventivo non può essere nel passato.')
            title = required(d, 'title')
            notes = optional(d, 'notes')
            brief = project['description']
            context = f'Perimetro concordato: {brief}\n\n' if brief else ''
            notes = context + '\n'.join(estimate['assumptions']) + ('\n\n' + notes if notes else '')
            id = c.execute('INSERT INTO quotes(project_id,title,items,subtotal,vat,total,vat_rate,valid_until,notes,estimate,generation_key) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                (project['id'], title, json.dumps(result['items']), result['subtotal'], result['vat'], result['total'], result['vat_rate'], valid_until, notes, json.dumps(estimate), key)).lastrowid
            return {'id': id}
        if p == '/api/quotes/calculate':
            return calculate(d.get('items'), d.get('vat_rate', settings(c)['vat_rate']))
        if p == '/api/quotes':
            row(c, 'projects', d.get('project_id'))
            calc = calculate(d.get('items'), d.get('vat_rate', settings(c)['vat_rate']))
            values = (d['project_id'], required(d, 'title'), json.dumps(calc['items']), calc['subtotal'], calc['vat'], calc['total'], calc['vat_rate'], check_date(d.get('valid_until')), optional(d, 'notes', 15000))
            if d.get('id'):
                q = row(c, 'quotes', d['id'])
                if q['estimate'] and str(q['project_id']) != str(d['project_id']):
                    raise Invalid('Il preventivo stimato deve restare associato al progetto di origine.')
                if q['status'] != 'draft':
                    raise Invalid('Puoi modificare soltanto preventivi in bozza.')
                c.execute('UPDATE quotes SET project_id=?,title=?,items=?,subtotal=?,vat=?,total=?,vat_rate=?,valid_until=?,notes=? WHERE id=?', (*values, d['id']))
                return {'id': d['id']}
            return {'id': c.execute('INSERT INTO quotes(project_id,title,items,subtotal,vat,total,vat_rate,valid_until,notes) VALUES(?,?,?,?,?,?,?,?,?)', values).lastrowid}
        if p == '/api/quotes/status':
            q = row(c, 'quotes', d.get('id'))
            status = d.get('status')
            allowed = {'draft': ['sent', 'accepted', 'rejected'], 'sent': ['accepted', 'rejected'], 'accepted': [], 'rejected': []}
            if status not in allowed[q['status']]:
                raise Invalid('Cambio di stato non consentito.')
            c.execute('UPDATE quotes SET status=? WHERE id=?', (status, q['id']))
            if status == 'accepted':
                project = row(c, 'projects', q['project_id'])
                client = row(c, 'clients', project['client_id'])
                snapshot = {'client': client, 'business': settings(c), 'title': q['title'], 'items': json.loads(q['items']), 'vat_rate': q['vat_rate'], 'notes': q['notes']}
                c.execute('INSERT INTO invoices(quote_id,project_id,snapshot,subtotal,vat,total,due_date) VALUES(?,?,?,?,?,?,?)', (q['id'], project['id'], json.dumps(snapshot), q['subtotal'], q['vat'], q['total'], (date.today() + timedelta(days=30)).isoformat()))
                c.execute("UPDATE projects SET status='active' WHERE id=? AND status='discovery'", (project['id'],))
            return {'ok': True}
        if p in ['/api/invoices/fiscal-check', '/api/invoices/finalize']:
            inv = row(c, 'invoices', d.get('id'))
            if p.endswith('/finalize') and inv['xml']:
                return {'id': inv['id'], 'filename': inv['xml_filename']}
            if inv['status'] != 'draft':
                raise Invalid('La fattura è già numerata. I documenti storici non vengono rigenerati.')
            config = d.get('config')
            snapshot = json.loads(inv['snapshot'])
            s = settings(c)
            client = row(c, 'clients', row(c, 'projects', inv['project_id'])['client_id'])
            year = check_date(config.get('document_date'))[:4] if isinstance(config, dict) else str(date.today().year)
            numbers = c.execute('SELECT number,issued_at FROM invoices WHERE number LIKE ?', (year+'/%',)).fetchall()
            last = max((int(r['number'].split('/')[1]) for r in numbers if r['number'].split('/')[1].isdigit()), default=0)
            next_number = f'{year}/{last+1:05}'
            try:
                progressive = fiscal.file_progressive(inv['id'])
                report, xml = fiscal.prepare(s, client, snapshot['items'], config, next_number, progressive)
                if any(r['issued_at'] and r['issued_at'] > config['document_date'] for r in numbers):
                    raise fiscal.FiscalError('La data documento precede una fattura già numerata nella stessa annualità.')
            except fiscal.FiscalError as exc:
                if p.endswith('/fiscal-check'):
                    return {'valid': False, 'errors': exc.errors}
                raise Invalid(str(exc))
            review_hash = hashlib.sha256(json.dumps([s,client,snapshot['items'],config,report], sort_keys=True).encode()).hexdigest()
            if p.endswith('/fiscal-check'):
                return {'valid': True, 'errors': [], 'report': report, 'review_hash': review_hash,
                        'business':s, 'client':client}
            if d.get('confirmed') is not True or d.get('review_hash') != review_hash:
                raise Invalid('Verifica nuovamente il riepilogo e conferma i dati fiscali aggiornati.')
            snapshot.update(business=s, client=client, fiscal={'config':config, 'report':report, 'schema':'1.2.3', 'reviewed_at':iso(datetime.now(timezone.utc))})
            filename = f"IT{s['vat_number']}_{progressive}.xml"
            c.execute('UPDATE invoices SET status=?,number=?,issued_at=?,snapshot=?,subtotal=?,vat=?,total=?,due_date=?,xml=?,xml_filename=? WHERE id=?',
                ('issued', next_number, config['document_date'], json.dumps(snapshot), report['subtotal'], report['vat'], report['total'], config['due_date'], xml, filename, inv['id']))
            return {'id':inv['id'], 'filename':filename}
        if p == '/api/invoices/status':
            inv = row(c, 'invoices', d.get('id'))
            status = d.get('status')
            if status == 'issued':
                raise Invalid('Usa la verifica fiscale e la generazione XML per numerare questa fattura.')
            elif status == 'paid' and inv['status'] == 'issued':
                c.execute('UPDATE invoices SET status=?,paid_at=? WHERE id=?', (status, date.today().isoformat(), inv['id']))
            else:
                raise Invalid('Cambio di stato non consentito.')
            return {'ok': True}
        if p == '/api/documents':
            client = row(c, 'clients', d.get('client_id'))
            project_id = d.get('project_id') or None
            if project_id and row(c, 'projects', project_id)['client_id'] != client['id']:
                raise Invalid('Il documento e il progetto devono appartenere allo stesso cliente.')
            name = required(d, 'name', 200).replace('\\', '/').split('/')[-1]
            if not name or any(ord(ch) < 32 for ch in name):
                raise Invalid('Nome file non valido.')
            try:
                content = base64.b64decode(d.get('content', ''), validate=True)
            except Exception:
                raise Invalid('File non valido.')
            if not 0 < len(content) <= 10 * 1024 * 1024:
                raise Invalid('Il file deve essere tra 1 byte e 10 MB.')
            storage = secrets.token_hex(24)
            (DATA / 'documents' / storage).write_bytes(content)
            id = c.execute('INSERT INTO documents(client_id,project_id,name,storage_name,size,sha256) VALUES(?,?,?,?,?,?)', (client['id'], project_id, name, storage, len(content), hashlib.sha256(content).hexdigest())).lastrowid
            return {'id': id}
        if p == '/api/appointments/cancel':
            row(c, 'appointments', d.get('id'))
            c.execute("UPDATE appointments SET status='cancelled' WHERE id=?", (d['id'],))
            return {'ok': True}
        if p == '/api/blocks':
            start, end = iso(instant(d.get('start'))), iso(instant(d.get('end')))
            if start >= end:
                raise Invalid('La fine deve essere successiva all’inizio.')
            return {'id': c.execute('INSERT INTO blocks(start,end,reason) VALUES(?,?,?)', (start, end, optional(d, 'reason'))).lastrowid}
        if p == '/api/blocks/delete':
            c.execute('DELETE FROM blocks WHERE id=?', (d.get('id'),))
            return {'ok': True}
        raise Invalid('Operazione non disponibile.')

if __name__ == '__main__':
    init()
    host = os.environ.get('CRM_HOST', '127.0.0.1')
    port = int(os.environ.get('CRM_PORT', '8080'))
    print(f'REALINDI CRM pronto: http://{host}:{port}', flush=True)
    Server((host, port), Handler).serve_forever()
