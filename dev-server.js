// 本地开发服务器：模拟 Vercel 的静态目录 + /api 函数路由，无需安装依赖。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
if (fs.existsSync(path.join(root, '.env'))) {
  for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    const file = path.join(root, 'api', url.pathname.slice(5) + '.js');
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    let body = '';
    for await (const chunk of req) body += chunk;
    req.query = Object.fromEntries(url.searchParams);
    try { req.body = body ? JSON.parse(body) : {}; } catch { req.body = body; }
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(o)); return res; };
    const mod = await import(file + '?t=' + Date.now());
    return mod.default(req, res);
  }
  const p = path.join(root, 'public', url.pathname === '/' ? 'index.html' : url.pathname);
  if (!p.startsWith(path.join(root, 'public')) || !fs.existsSync(p)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
}).listen(process.env.PORT || 3000, () => console.log(`dev server: http://localhost:${process.env.PORT || 3000}  (data=${process.env.MOCK_DATA === '1' ? 'mock' : 'live'}, llm=${process.env.LLM_API_KEY ? 'on' : 'off'})`));
