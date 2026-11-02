import hashlib
import json
from datetime import date, timedelta
from pathlib import Path
from lxml import etree as ET
import fiscal
import test_crm

class FiscalTest(test_crm.CRMTest):
    # Reuse only the integration fixture, not the inherited CRM test cases.
    pass

for _name in list(vars(test_crm.CRMTest)):
    if _name.startswith('test_'):
        setattr(FiscalTest, _name, None)

class FiscalFlowTest(FiscalTest):
    def draft(self):
        cid,pid=self.project()
        _,q=self.request('/api/quotes',{'project_id':pid,'title':'Consulenza','valid_until':(date.today()+timedelta(days=30)).isoformat(),
            'vat_rate':'22','items':[{'description':'Analisi & sviluppo','hours':'10','rate':'100'}]})
        self.request('/api/quotes/status',{'id':q['id'],'status':'accepted'})
        return cid,self.state()['invoices'][0]['id']

    def test_blank_profile_and_mandatory_review(self):
        cid,iid=self.draft()
        _,context=self.request(f'/api/invoices/{iid}/fiscal')
        self.assertEqual(context['business']['tax_regime'],'')
        self.assertEqual(context['business']['vat_number'],'')
        self.assertEqual(context['business']['ateco'],'')
        self.assertTrue(context['profile_errors'])
        _,r=self.request('/api/invoices/fiscal-check',{'id':iid,'config':context['config']})
        self.assertFalse(r['valid'])
        self.assertIsNone(self.state()['invoices'][0]['number'])
        self.configure_fiscal(cid)
        _,context=self.request(f'/api/invoices/{iid}/fiscal')
        _,check=self.request('/api/invoices/fiscal-check',{'id':iid,'config':context['config']})
        self.assertTrue(check['valid'],check)
        payload={'id':iid,'config':context['config'],'review_hash':check['review_hash']}
        self.assertEqual(self.request('/api/invoices/finalize',payload)[0],400)
        # Another tab changes the issuing business after the review.
        self.request('/api/settings',{'business_name':'Studio cambiato'})
        self.assertEqual(self.request('/api/invoices/finalize',{**payload,'confirmed':True})[0],400)
        self.assertIsNone(self.state()['invoices'][0]['number'])
        _,_,result=self.finalize_invoice(iid)
        code,xml=self.request(f'/api/invoices/{iid}/xml')
        self.assertEqual(code,200)
        fiscal.validate_xml(xml)
        self.assertIn(b'Studio cambiato',xml)
        self.assertNotIn(b'Studio test',xml)
        self.assertEqual(self.request(f'/api/invoices/{iid}/xml',public=True)[0],401)
        self.assertEqual(self.request('/api/invoices/finalize',{**payload,'confirmed':True})[1],result)
        original=hashlib.sha256(xml).hexdigest()
        self.request('/api/settings',{'business_name':'Nuovo nome','vat_number':'12345678903','tax_regime':'RF19'})
        self.assertEqual(hashlib.sha256(self.request(f'/api/invoices/{iid}/xml')[1]).hexdigest(),original)

    def test_ordinary_fund_withholding_and_payment(self):
        cid,iid=self.draft();self.configure_fiscal(cid)
        cfg,check,_=self.finalize_invoice(iid,{'cassa_mode':'yes','cassa_type':'TC22','cassa_rate':'4',
            'cassa_base_percent':'100','cassa_vat_rate':'22','cassa_nature':'','cassa_reference':'',
            'cassa_withholding':'yes','withholding_mode':'yes','withholding_type':'RT01',
            'withholding_rate':'20','withholding_base_percent':'100','withholding_reason':'A'})
        r=check['report']
        self.assertEqual((r['subtotal'],r['contribution'],r['vat'],r['withholding'],r['total'],r['payable']),
                         (100000,4000,22880,20800,126880,106080))
        xml=self.request(f'/api/invoices/{iid}/xml')[1]
        doc=ET.fromstring(xml)
        self.assertEqual(doc.findtext('.//ImportoPagamento'),'1060.80')
        self.assertEqual(doc.findtext('.//RegimeFiscale'),'RF01')
        self.assertEqual(doc.findtext('.//ImportoContributoCassa'),'40.00')
        self.assertEqual(doc.findtext('.//Descrizione'),'Analisi & sviluppo')
        self.assertEqual(self.request('/api/invoices/status',{'id':iid,'status':'paid'})[0],200)
        self.assertEqual(self.state()['invoices'][0]['snapshot']['fiscal']['report']['payable'],106080)

    def test_forfettario_bollo_and_invalid_vat(self):
        cid,iid=self.draft();self.configure_fiscal(cid,'RF19')
        _,ctx=self.request(f'/api/invoices/{iid}/fiscal')
        bad={**ctx['config'],'taxes':[{'vat_rate':'22','nature':'','reference':''}]}
        self.assertFalse(self.request('/api/invoices/fiscal-check',{'id':iid,'config':bad})[1]['valid'])
        _,check,_=self.finalize_invoice(iid,{'stamp_mode':'yes','stamp_amount':'2'})
        self.assertEqual(check['report']['stamp'],200)
        self.assertEqual(check['report']['payable'],100000) # bollo borne by issuer
        doc=ET.fromstring(self.request(f'/api/invoices/{iid}/xml')[1])
        self.assertEqual(doc.findtext('.//RegimeFiscale'),'RF19')
        self.assertEqual(doc.findtext('.//BolloVirtuale'),'SI')
        self.assertEqual(doc.findtext('.//Natura'),'N2.2')
        self.assertEqual(doc.findtext('.//Imposta'),'0.00')

    def test_foreign_recipient_and_backup_xml(self):
        cid,iid=self.draft();self.configure_fiscal(cid)
        old=next(c for c in self.state()['clients'] if c['id']==cid)
        self.request('/api/clients',{**old,'country':'FR','tax_country':'FR','vat_number':'FR12345678901',
            'postcode':'00000','province':'','city':'Paris','recipient_code':''})
        _,_,result=self.finalize_invoice(iid,{'taxes':[{'vat_rate':'0','nature':'N2.1','reference':'Art. 7-ter DPR 633/1972'}]})
        xml=self.request(f'/api/invoices/{iid}/xml')[1]
        self.assertEqual(ET.fromstring(xml).findtext('.//CodiceDestinatario'),'XXXXXXX')
        _,archive=self.request('/api/backup')
        backup=Path(self.temp.name)/'tax.zip';backup.write_bytes(archive)
        import manage,sqlite3
        manage.restore(backup,Path(self.temp.name)/'restored')
        with sqlite3.connect(Path(self.temp.name)/'restored/crm.sqlite3') as c:
            restored=c.execute('SELECT xml FROM invoices WHERE id=?',(iid,)).fetchone()[0]
        self.assertEqual(restored,xml)

    def test_file_naming_and_private_customer(self):
        self.assertEqual(fiscal.file_progressive(1),'00001')
        self.assertEqual(len(fiscal.file_progressive(100000)),5)
        self.assertNotEqual(fiscal.file_progressive(100000),fiscal.file_progressive(100001))
        with self.assertRaises(fiscal.FiscalError):
            fiscal.file_progressive(36**5)
        cid,iid=self.draft();self.configure_fiscal(cid)
        old=next(c for c in self.state()['clients'] if c['id']==cid)
        self.request('/api/clients',{**old,'buyer_type':'private','vat_number':'','tax_country':'','tax_code':''})
        _,ctx=self.request(f'/api/invoices/{iid}/fiscal')
        self.assertTrue(any('codice fiscale obbligatorio' in error for error in ctx['profile_errors']))
        self.request('/api/clients',{**old,'buyer_type':'private','vat_number':'','tax_country':'','tax_code':'RSSMRA80A01H501U'})
        self.finalize_invoice(iid)
        doc=ET.fromstring(self.request(f'/api/invoices/{iid}/xml')[1])
        self.assertEqual(doc.findtext('.//CodiceDestinatario'),'0000000')
        self.assertEqual(doc.findtext('.//CessionarioCommittente/DatiAnagrafici/CodiceFiscale'),'RSSMRA80A01H501U')

    def test_mixed_vat_and_split_payment(self):
        cid,iid=self.draft();self.configure_fiscal(cid)
        # Preserve invariant: accepted quote values are immutable. Separate fixture draft with two rows.
        import app
        with app.db() as c:
            inv=app.row(c,'invoices',iid);snap=json.loads(inv['snapshot'])
            snap['items']=[{'description':'Servizio A','amount':10000}, {'description':'Servizio B','amount':5000}]
            c.execute('UPDATE invoices SET snapshot=?,subtotal=? WHERE id=?',(json.dumps(snap),15000,iid))
        _,checked,_=self.finalize_invoice(iid,{'taxes':[{'vat_rate':'22','nature':'','reference':''},
            {'vat_rate':'0','nature':'N4','reference':'Operazione esente'}],'vat_timing':'S'})
        self.assertEqual(checked['report']['vat'],2200)
        self.assertEqual(checked['report']['total'],17200)
        self.assertEqual(checked['report']['payable'],15000)
