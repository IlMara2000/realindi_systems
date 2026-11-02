import base64
import concurrent.futures
import http.cookiejar
import io
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import zipfile
from datetime import datetime, timedelta
from pathlib import Path
from http.server import ThreadingHTTPServer
import app
import manage

class CRMTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        app.DATA = Path(self.temp.name) / 'data'
        app.init()
        self.server = app.Server(('127.0.0.1', 0), app.Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = 'http://127.0.0.1:' + str(self.server.server_port)
        self.client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.request('/api/setup', {'password': 'Test-password-123!'})

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.temp.cleanup()

    def request(self, path, data=None, public=False, headers=None):
        req = urllib.request.Request(self.base+path, data=json.dumps(data).encode() if data is not None else None, headers=headers or ({'Content-Type':'application/json'} if data is not None else {}))
        try:
            with (urllib.request.urlopen(req) if public else self.client.open(req)) as r:
                body = r.read()
                return r.status, json.loads(body) if 'application/json' in r.headers['Content-Type'] else body
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def state(self):
        return self.request('/api/state')[1]

    def project(self):
        code, c = self.request('/api/clients', {'name':'Ada','email':'ada@example.test','company':'Studio Ada','address':'Via Test 1','vat_number':'IT123'})
        self.assertEqual(code, 200)
        code, p = self.request('/api/projects', {'client_id':c['id'],'title':'Portale clienti'})
        self.assertEqual(code, 200)
        return c['id'], p['id']

    def configure_fiscal(self, cid, regime='RF01'):
        self.assertEqual(self.request('/api/settings', {
            'business_name':'Studio test', 'address':'Via Test 1', 'city':'Roma', 'postcode':'00100',
            'province':'RM', 'country':'IT', 'vat_number':'01234567897', 'tax_regime':regime,
            'invoice_vat_rate':'22' if regime == 'RF01' else '0',
            'invoice_nature':'' if regime == 'RF01' else 'N2.2',
            'invoice_reference':'' if regime == 'RF01' else 'Operazione senza applicazione IVA - regime forfettario',
            'payment_method':'MP01', 'vat_timing':'I', 'stamp_mode':'no', 'cassa_mode':'no', 'withholding_mode':'no'
        })[0], 200)
        old = next(x for x in self.state()['clients'] if x['id']==cid)
        self.assertEqual(self.request('/api/clients', {**old,'country':'IT','city':'Roma','postcode':'00100',
            'province':'RM','vat_number':'12345678903','tax_country':'IT','buyer_type':'business','recipient_code':'0000000'})[0],200)

    def finalize_invoice(self, id, overrides=None):
        code, context = self.request(f'/api/invoices/{id}/fiscal')
        self.assertEqual(code,200,context)
        cfg={**context['config'], **(overrides or {})}
        code, checked=self.request('/api/invoices/fiscal-check',{'id':id,'config':cfg})
        self.assertEqual(code,200,checked)
        self.assertTrue(checked['valid'], checked)
        code,result=self.request('/api/invoices/finalize',{'id':id,'config':cfg,'confirmed':True,'review_hash':checked['review_hash']})
        self.assertEqual(code,200,result)
        return cfg,checked,result

    def test_quote_invoice_lifecycle_and_snapshots(self):
        cid, pid = self.project()
        data = {'project_id':pid,'title':'Portale','valid_until':'2027-01-30','vat_rate':'22','items':[{'description':'Sviluppo','hours':'10.25','rate':'65','factor':'1.2','extra':'25.50'}]}
        code, q = self.request('/api/quotes', data)
        self.assertEqual(code, 200)
        quote = self.state()['quotes'][0]
        self.assertEqual((quote['subtotal'], quote['vat'], quote['total']), (82500,18150,100650))
        self.assertEqual(self.request('/api/quotes/status', {'id':q['id'],'status':'accepted'})[0],200)
        self.assertEqual(self.request('/api/quotes/status', {'id':q['id'],'status':'accepted'})[0],400)
        self.assertEqual(len(self.state()['invoices']),1)
        self.assertEqual(self.request('/api/quotes', {**data,'id':q['id']})[0],400)
        invoice = self.state()['invoices'][0]
        self.assertEqual(self.request('/api/invoices/status', {'id':invoice['id'],'status':'issued'})[0],400)
        self.request('/api/settings', {'business_name':'Studio test','address':'Roma','vat_number':'123','email':'studio@example.test','tax_label':'Configurazione test'})
        self.configure_fiscal(cid)
        self.finalize_invoice(invoice['id'])
        self.request('/api/clients', {'id':cid,'name':'Nome nuovo','email':'new@example.test'})
        self.request('/api/settings', {'business_name':'Nome nuovo'})
        invoice = self.state()['invoices'][0]
        self.assertEqual(invoice['snapshot']['client']['name'],'Ada')
        self.assertEqual(invoice['snapshot']['business']['business_name'],'Studio test')
        self.assertTrue(invoice['number'].endswith('/00001'))
        self.assertEqual(self.request('/api/invoices/status', {'id':invoice['id'],'status':'paid'})[0],200)
        self.assertEqual(self.request('/api/invoices/status', {'id':invoice['id'],'status':'issued'})[0],400)

    def test_document_backup_restore_and_access(self):
        cid, pid = self.project()
        content = b'Contratto riservato\x00\xff'
        code, d = self.request('/api/documents', {'client_id':cid,'project_id':pid,'name':'contratto.pdf','content':base64.b64encode(content).decode()})
        self.assertEqual(code,200)
        self.assertEqual(self.request('/api/documents/'+str(d['id']))[1],content)
        self.assertEqual(self.request('/api/documents/'+str(d['id']), public=True)[0],401)
        code, archive = self.request('/api/backup')
        self.assertEqual(code,200)
        backup = Path(self.temp.name)/'backup.zip'
        backup.write_bytes(archive)
        destination = Path(self.temp.name)/'restored'
        manage.restore(backup,destination)
        self.assertEqual(len(list((destination/'documents').iterdir())),1)
        import sqlite3
        with sqlite3.connect(destination/'crm.sqlite3') as c:
            self.assertEqual(c.execute('SELECT COUNT(*) FROM clients').fetchone()[0],1)
            self.assertIsNone(c.execute("SELECT value FROM settings WHERE key='password'").fetchone())
        with self.assertRaises(ValueError):
            manage.restore(backup,destination)
        with zipfile.ZipFile(io.BytesIO(archive)) as z:
            self.assertNotIn('Test-password',z.read('database.sql').decode())

    def test_booking_race_block_cancel(self):
        self.request('/api/settings', {'booking_days':list(range(7)),'booking_notice':0})
        slug=self.state()['settings']['booking_slug']
        date=(datetime.now(app.TZ)+timedelta(days=1)).date().isoformat()
        url='/api/booking/'+slug
        slots=self.request(url+'?day='+date,public=True)[1]['slots']
        self.assertTrue(slots)
        data={'name':'Cliente','email':'test@example.test','start':slots[0]['start']}
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda _:self.request(url,data,public=True),range(2)))
        self.assertEqual(sorted(r[0] for r in results),[200,400])
        successful=next(r[1] for r in results if r[0]==200)
        self.assertNotIn(slots[0],self.request(url+'?day='+date,public=True)[1]['slots'])
        self.assertEqual(self.request('/api/cancel-booking',{'token':successful['cancel_token']},public=True)[0],200)
        self.assertIn(slots[0],self.request(url+'?day='+date,public=True)[1]['slots'])
        self.request('/api/blocks',{'start':slots[0]['start'],'end':slots[0]['end'],'reason':'Pausa'})
        self.assertNotIn(slots[0],self.request(url+'?day='+date,public=True)[1]['slots'])
        self.assertEqual(self.request(url,data,public=True)[0],400)
        self.assertNotIn('email',self.request(url,public=True)[1])

    def test_scope_estimate_to_quote_and_invoice(self):
        cid, pid = self.project()
        self.request('/api/projects', {'id': pid, 'client_id': cid, 'title': 'Portale clienti', 'description': 'Cinque schermate e integrazione catalogo.'})
        scope = {'kind': 'application', 'modules': [
            {'key': 'screens', 'quantity': 5, 'hours': '6'},
            {'key': 'integrations', 'quantity': 1, 'hours': '8'}],
            'complexity': '1.25', 'testing': '20', 'coordination': '10',
            'contingency': '15', 'weekly_hours': '20', 'expenses': '50'}
        payload = {'project_id': pid, 'scope': scope, 'rate': '60', 'vat_rate': '22',
                   'title': 'Proposta portale', 'valid_until': (datetime.now(app.TZ) + timedelta(days=30)).date().isoformat(),
                   'generation_key': 'estimate-test-request-1234'}
        code, estimate = self.request('/api/estimates/preview', payload)
        self.assertEqual(code, 200, estimate)
        self.assertEqual(len(self.state()['quotes']), 0, 'Preview must not save anything')
        # 38 * 1.25 = 47.50; tests 9.50; coordination 4.75; reserve 9.26.
        self.assertEqual(estimate['total_hours'], '71.01')
        self.assertEqual(estimate['workload_weeks'], '3.55')
        self.assertEqual(estimate['subtotal'], 431060)  # 71.01 * 60 + 50
        self.assertEqual(estimate['vat'], 94833)
        self.assertEqual(estimate['total'], 525893)
        code, saved = self.request('/api/estimates', payload)
        self.assertEqual(code, 200, saved)
        self.assertEqual(self.request('/api/estimates', payload)[1], saved)
        self.assertEqual(len(self.state()['quotes']), 1)
        quote = self.state()['quotes'][0]
        self.assertEqual(quote['items'], estimate['items'])
        self.assertEqual(quote['total'], estimate['total'])
        self.assertEqual(quote['estimate']['scope']['complexity'], '1.25')
        self.assertIn('Cinque schermate', quote['notes'])
        # Editing a generated draft must preserve original estimation assumptions.
        edited = {**quote, 'title': 'Proposta rivista', 'items': [{'description': 'Accordo rivisto', 'hours': '1', 'rate': '100'}]}
        self.assertEqual(self.request('/api/quotes', edited)[0], 200)
        revised = self.state()['quotes'][0]
        self.assertEqual(revised['total'], 12200)
        self.assertEqual(revised['estimate']['total'], 525893)
        self.assertEqual(self.request('/api/quotes/status', {'id': saved['id'], 'status': 'accepted'})[0], 200)
        self.assertEqual(self.state()['invoices'][0]['total'], 12200)
        # Schema migration is safe to repeat on a populated database.
        app.init()
        self.assertEqual(self.state()['quotes'][0]['estimate']['total'], 525893)

    def test_estimate_validation_access_and_backup(self):
        cid, pid = self.project()
        payload = {'project_id': pid, 'title': 'Consulenza', 'valid_until': (datetime.now(app.TZ) + timedelta(days=30)).date().isoformat(),
                   'generation_key': 'estimate-retry-abcdef', 'rate': '75', 'vat_rate': '0',
                   'scope': {'kind': 'consulting', 'modules': [{'key': 'audit', 'quantity': 1, 'hours': '4'}]}}
        self.assertEqual(self.request('/api/estimates/catalog', public=True)[0], 401)
        self.assertEqual(self.request('/api/estimates', payload, public=True)[0], 400)
        for scope in [None, {}, {'kind': 'unknown'},
                      {'kind': 'consulting', 'modules': [{'key': 'audit', 'quantity': 0, 'hours': '4'}]},
                      {'kind': 'consulting', 'modules': [{'key': 'audit', 'quantity': 1.5, 'hours': '4'}]},
                      {'kind': 'consulting', 'modules': [{'key': 'screens', 'quantity': 1, 'hours': '4'}]},
                      {**payload['scope'], 'complexity': 'NaN'},
                      {**payload['scope'], 'weekly_hours': '0'},
                      {**payload['scope'], 'modules': payload['scope']['modules'] * 2}]:
            code, _ = self.request('/api/estimates/preview', {**payload, 'scope': scope})
            self.assertEqual(code, 400, scope)
        self.assertEqual(self.request('/api/estimates', {**payload, 'valid_until': '2000-01-01'})[0], 400)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: self.request('/api/estimates', payload), range(2)))
        self.assertEqual([r[0] for r in results], [200, 200])
        self.assertEqual(results[0][1], results[1][1])
        self.assertEqual(len(self.state()['quotes']), 1)
        code, backup = self.request('/api/backup')
        self.assertEqual(code, 200)
        archive = Path(self.temp.name) / 'estimated.zip'
        archive.write_bytes(backup)
        destination = Path(self.temp.name) / 'restored-estimate'
        manage.restore(archive, destination)
        import sqlite3
        with sqlite3.connect(destination / 'crm.sqlite3') as c:
            stored = json.loads(c.execute('SELECT estimate FROM quotes').fetchone()[0])
        self.assertEqual(stored['total'], 30000)

    def test_security_and_validation(self):
        self.assertEqual(self.request('/api/state',public=True)[0],401)
        self.assertEqual(self.request('/api/backup',public=True)[0],401)
        self.assertEqual(self.request('/api/setup',{'password':'another-long-password'},public=True)[0],400)
        self.assertEqual(self.request('/api/settings',{'business_name':'Hostile'},headers={'Content-Type':'application/json','Origin':'https://evil.test'})[0],403)
        for value in ['NaN','Infinity','-1']:
            self.assertEqual(self.request('/api/quotes/calculate',{'items':[{'description':'test','hours':value,'rate':'20'}]})[0],400)
        self.assertEqual(self.request('/api/projects',{'client_id':999,'title':'Missing client'})[0],400)
        self.request('/api/logout',{})
        self.assertEqual(self.request('/api/state')[0],401)
        self.assertEqual(self.request('/api/login',{'password':'Test-password-123!'})[0],200)

if __name__ == '__main__':
    unittest.main()
