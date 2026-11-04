import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const root=path.resolve('android/assets');
http.createServer((req,res)=>{
 const u=new URL(req.url,'http://localhost');const name=u.pathname==='/'?'index.html':u.pathname.slice(1);
 if(!/^[a-zA-Z0-9._-]+$/.test(name)){res.writeHead(403).end();return;}
 const file=path.join(root,name);if(!fs.existsSync(file)){res.writeHead(404).end();return;}
 res.writeHead(200,{'Content-Type':name.endsWith('.js')?'application/javascript; charset=utf-8':name.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src https://*.supabase.co https://*.supabase.in; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'self'"});fs.createReadStream(file).pipe(res);
}).listen(Number(process.env.NOTAFLOW_PORT||8879),'127.0.0.1',()=>console.log('NotaFlow preview http://127.0.0.1:'+(process.env.NOTAFLOW_PORT||8879)));
