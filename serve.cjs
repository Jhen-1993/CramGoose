/* Local-only static preview server. No user data or uploads are received. */
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=__dirname,port=8847;
const server=http.createServer((req,res)=>{
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405).end();return;}
  let pathname;try{pathname=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname);}catch{res.writeHead(400).end();return;}
  const file=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
  if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
  fs.readFile(file,(error,data)=>{if(error){res.writeHead(404).end('Not found');return;}res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.txt':'text/plain; charset=utf-8','.md':'text/plain; charset=utf-8'})[path.extname(file)]||'application/octet-stream');res.setHeader('Cache-Control','no-store');res.end(req.method==='HEAD'?undefined:data);});
});
server.on('error',error=>{console.error(error.code==='EADDRINUSE'?'Port 8847 is in use. Open http://127.0.0.1:8847 or close the previous preview first.':error.message);process.exitCode=1;});
server.listen(port,'127.0.0.1',()=>{console.log('CramGoose: http://127.0.0.1:8847');console.log('Keep this window open. Press Ctrl+C to stop.');});
