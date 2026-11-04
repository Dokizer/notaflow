/* Runs the packaged interface in a disposable Chromium profile; no npm dependencies. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {spawn} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const assets = path.join(root, 'android', 'assets');
const browser = process.env.NOTAFLOW_CHROME || [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/chromium', '/usr/bin/google-chrome'
].find(p => fs.existsSync(p));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

class CDP {
  constructor(socket) {
    this.socket = socket; this.next = 0; this.pending = new Map(); this.errors = [];
    socket.addEventListener('message', event => {
      const msg = JSON.parse(event.data);
      if (msg.method === 'Runtime.exceptionThrown') this.errors.push(msg.params.exceptionDetails.text + ': ' + (msg.params.exceptionDetails.exception?.description || ''));
      if (!msg.id) return;
      const pending = this.pending.get(msg.id); if (!pending) return;
      this.pending.delete(msg.id); clearTimeout(pending.timeout); msg.error ? pending.reject(new Error(msg.error.message)) : pending.resolve(msg.result);
    });
    socket.addEventListener('close',()=>{for(const pending of this.pending.values()){clearTimeout(pending.timeout);pending.reject(new Error('Browser connection closed'));}this.pending.clear();});
  }
  command(method, params = {}) { const id = ++this.next; return new Promise((resolve, reject) => {const timeout=setTimeout(()=>{this.pending.delete(id);reject(new Error('CDP command timed out: '+method));},5000);this.pending.set(id, {resolve,reject,timeout}); this.socket.send(JSON.stringify({id,method,params})); }); }
  async evaluate(expression) { const result = await this.command('Runtime.evaluate', {expression,returnByValue:true,awaitPromise:true}); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; }
  async until(expression) { for(let i=0;i<100;i++){if(await this.evaluate(expression))return;await delay(40);}throw new Error('Timed out: '+expression); }
  async click(selector) { await this.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); }
  async fill(selector, value) { await this.evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}));})()`); }
  async change(selector,value) { await this.evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('change',{bubbles:true}));})()`); }
  async upload(selector,files) {const doc=await this.command('DOM.getDocument');const node=await this.command('DOM.querySelector',{nodeId:doc.root.nodeId,selector});await this.command('DOM.setFileInputFiles',{nodeId:node.nodeId,files});}
}

test('packaged frontend: 360px layout, safe CRUD, history, persistence and exports', {skip: !browser,timeout:60000}, async () => {
  const server = http.createServer((req,res) => {
    const name = req.url.split('?')[0] === '/' ? 'index.html' : req.url.split('?')[0].slice(1);
    if(!['index.html','styles.css','app.js','core.js','cloud.js','config.js','importer.js','import-worker.js','xlsx.full.min.js'].includes(name)){res.writeHead(404);res.end();return;}
    res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https:; img-src 'self' data:; object-src 'none'; base-uri 'none'");
    res.end(fs.readFileSync(path.join(assets,name)));
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const profile = path.join(root,'work','browser-tests','profile-'+process.pid+'-'+Date.now());fs.mkdirSync(profile,{recursive:true});
  const child = spawn(browser,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
  let cdp;
  try {
    const portFile = path.join(profile,'DevToolsActivePort');
    for(let i=0;i<150&&!fs.existsSync(portFile);i++)await delay(100);
    assert.ok(fs.existsSync(portFile),'Disposable browser starts');
    const port = Number(fs.readFileSync(portFile,'utf8').split('\n')[0]);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const ws = new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});cdp=new CDP(ws);
    await cdp.command('Runtime.enable');await cdp.command('Page.enable');
    await cdp.command('Emulation.setDeviceMetricsOverride',{width:360,height:800,deviceScaleFactor:1,mobile:true});
    await cdp.command('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/`});
    await cdp.until(`document.querySelector('h1')?.textContent === 'Seu fluxo, em dia.'`);
    assert.deepEqual(cdp.errors,[],'No browser script errors');
    assert.equal(await cdp.evaluate(`document.querySelectorAll('.nav-item').length`),5);
    assert.equal(await cdp.evaluate(`document.documentElement.scrollWidth <= innerWidth`),true,'No horizontal overflow at 360px');
    assert.equal(await cdp.evaluate(`document.querySelector('.mode-banner').textContent.includes('Modo local.')`),true);
    await cdp.click('[data-action="new"]');
    const payload='<img src=x onerror="window.xssExecuted=true">';
    await cdp.fill('[name="client_name"]',payload);await cdp.fill('[name="nf_number"]','=42');await cdp.fill('[name="billing_date"]','2026-01-01');await cdp.fill('[name="term_days"]','5');await cdp.fill('[name="consultant"]','Raimundo Sergio');await cdp.fill('[name="amount"]','1.234,56');await cdp.fill('[name="funding_source"]','own');
    assert.ok((await cdp.evaluate(`document.querySelector('#due-preview').textContent`)).includes('6 de janeiro de 2026'));
    await cdp.evaluate(`document.querySelector('#invoice-form').requestSubmit()`);await cdp.until(`document.querySelector('#overlay').hidden`);
    assert.equal(await cdp.evaluate(`JSON.parse(localStorage.getItem('notaflow-state')).invoices.length`),1);
    assert.equal(await cdp.evaluate(`window.xssExecuted === undefined && document.querySelector('main img') === null`),true,'Client data is escaped');
    const screenshot=await cdp.command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(root,'work','frontend-360.png'),Buffer.from(screenshot.data,'base64'));
    await cdp.click('[data-tab="invoices"]');assert.equal(await cdp.evaluate(`document.querySelectorAll('.invoice-card').length`),1);
    await cdp.click('[data-action="edit"]');await cdp.fill('[name="client_name"]','Studio Aurora');await cdp.fill('[name="billing_date"]',await cdp.evaluate('NFCore.today()'));await cdp.fill('[name="term_days"]','2');await cdp.evaluate(`document.querySelector('#invoice-form').requestSubmit()`);await cdp.until(`document.querySelector('#overlay').hidden`);
    await cdp.fill('#invoice-search','aurora');assert.equal(await cdp.evaluate(`document.querySelectorAll('.invoice-card').length`),1);
    await cdp.fill('#invoice-search','missing-client');assert.equal(await cdp.evaluate(`document.querySelectorAll('.invoice-card').length`),0);await cdp.fill('#invoice-search','');
    await cdp.click('[data-action="pay"]');await cdp.click('[data-action="confirm-pay"]');await cdp.until(`document.querySelector('#overlay').hidden`);assert.equal(await cdp.evaluate(`document.querySelector('.badge').textContent`),'Paga');
    await cdp.click('[data-action="reopen"]');await cdp.click('[data-action="confirm-reopen"]');await cdp.until(`document.querySelector('#overlay').hidden`);assert.equal(await cdp.evaluate(`document.querySelector('.badge').textContent`),'Em dia');
    await cdp.click('[data-action="history"]');assert.equal(await cdp.evaluate(`document.querySelectorAll('.timeline-item').length`),3);await cdp.click('[data-action="close"]');
    await cdp.command('Page.reload');await cdp.until(`document.querySelector('h1')?.textContent === 'Seu fluxo, em dia.'`);assert.equal(await cdp.evaluate(`JSON.parse(localStorage.getItem('notaflow-state')).invoices[0].client_name`),'Studio Aurora');
    await cdp.evaluate(`window.exportedFiles=[];window.Native={shareFile:(name,content,mime)=>exportedFiles.push({name,content,mime}),writeState:()=>{},cacheInvoices:()=>{},notificationsEnabled:()=>false};`);
    await cdp.click('[data-tab="settings"]');await cdp.click('[data-action="export-csv"]');await cdp.click('[data-action="export-backup"]');
    const files=await cdp.evaluate('exportedFiles');assert.equal(files.length,2);assert.ok(files[0].content.includes('"\'=42"'),'CSV formulas are neutralized');const backup=JSON.parse(files[1].content);assert.equal(backup.invoices.length,1);assert.equal(backup.events.length,4);assert.equal(backup.version,2);assert.equal(backup.consultants.length,5);assert.equal(backup.cloud,undefined,'Backup has no cloud session or credentials');
    await cdp.evaluate('delete window.Native');
    await cdp.click('[data-tab="invoices"]');await cdp.click('[data-action="delete"]');assert.equal(await cdp.evaluate(`JSON.parse(localStorage.getItem('notaflow-state')).invoices.length`),1,'Deletion requires confirmation');await cdp.click('[data-action="confirm-delete"]');await cdp.until(`document.querySelector('#overlay').hidden`);assert.equal(await cdp.evaluate(`document.querySelectorAll('.invoice-card').length`),0);await cdp.click('[data-tab="clients"]');assert.ok((await cdp.evaluate(`document.querySelector('main').textContent`)).includes('Studio Aurora'),'Deleted invoice retains client history');
    const fixtureDir=path.join(root,'work','browser-tests','fixtures-'+process.pid);fs.mkdirSync(fixtureDir,{recursive:true});
    const csvPath=path.join(fixtureDir,'import.csv');fs.writeFileSync(csvPath,'ERP;NF;Emissão;Valor;Vendedor;Telefone;Prazo\nCliente CSV;00055;2026-11-03;50,10;Ana Importada;+5571999991234;5\nCLIENTE CSV;55;2026-11-03;60,00;Ana Importada;+5571999991234;5\nCliente inválido;56;31/02/2026;abc;Ana Importada;;5','utf8');
    await cdp.click('[data-tab="invoices"]');await cdp.click('[data-action="spreadsheet"]');await cdp.upload('#spreadsheet-file',[csvPath]);await cdp.until(`document.querySelector('#import-mapping-client_name') !== null`);await cdp.change('#import-mapping-client_name','0');
    assert.match(await cdp.evaluate(`document.querySelector('.import-counts').textContent`),/1 válidas1 duplicadas1 com erros/);assert.equal(await cdp.evaluate(`JSON.parse(localStorage.getItem('notaflow-state')).invoices.length`),0,'Preview does not persist');
    await cdp.click('[data-action="commit-import"]');await cdp.until(`document.querySelector('h1')?.textContent === 'Histórico de Importações'`);assert.equal(await cdp.evaluate(`JSON.parse(localStorage.getItem('notaflow-state')).invoices.length`),1);assert.match(await cdp.evaluate(`document.querySelector('main').textContent`),/1 importadas/);
    const X=require('../android/assets/xlsx.full.min.js'),book=X.utils.book_new();X.utils.book_append_sheet(book,X.utils.aoa_to_sheet([['Cliente','NF','Emissão','Valor'],['Outra aba','88','2026-11-03',1]]),'Primeira');X.utils.book_append_sheet(book,X.utils.aoa_to_sheet([['Relatório'],['Cliente','NF','Emissão','Valor'],['Cliente Excel','00077','2026-11-03',123.45]]),'Notas extras');const xlsxPath=path.join(fixtureDir,'import.xlsx');fs.writeFileSync(xlsxPath,X.write(book,{type:'buffer',bookType:'xlsx',compression:true}));
    await cdp.click('[data-action="spreadsheet"]');await cdp.upload('#spreadsheet-file',[xlsxPath]);await cdp.until(`document.querySelector('#import-sheet')?.options.length === 2`);await cdp.change('#import-sheet','1');await cdp.until(`document.querySelector('#import-sheet')?.value === '1' && document.querySelector('#import-header-row') !== null && !document.querySelector('.import-loading')`);await cdp.change('#import-header-row','2');await cdp.until(`document.querySelector('.import-counts')?.textContent.includes('1 válidas')`);assert.match(await cdp.evaluate(`document.querySelector('.preview-table').textContent`),/Cliente Excel/);await cdp.click('[data-action="commit-import"]');await cdp.until(`document.querySelector('h1')?.textContent === 'Histórico de Importações'`);assert.equal(await cdp.evaluate(`JSON.parse(localStorage.getItem('notaflow-state')).invoices.length`),2);
    await cdp.command('Page.reload');await cdp.until(`document.querySelector('h1')?.textContent === 'Seu fluxo, em dia.'`);assert.equal(await cdp.evaluate(`JSON.parse(localStorage.getItem('notaflow-state')).imports.length`),2);
    assert.deepEqual(cdp.errors,[],'No runtime errors throughout CRUD and real worker imports');
  } finally {
    if(cdp){cdp.command('Browser.close').catch(()=>{});cdp.socket.close();}
    child.kill();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  }
});
