// 生成“最近一次成功采集快照”：在能访问扶摇的机器上运行，产物不入库（.gitignore），随 Vercel 部署打包。
// 用法：node scripts/snapshot.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFuyaoClient } from '../lib/fuyao.js';
import { collect } from '../lib/collect.js';
import { PRESETS } from '../lib/config.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
process.env.DISABLE_SNAPSHOT = '1';
fs.mkdirSync(path.join(root, 'snapshots'), { recursive: true });
for (const code of Object.keys(PRESETS)) {
  const c = await collect(createFuyaoClient(), code, { budgetMs: 90000 });
  const failed = Object.values(c.raw).filter((r) => !r.ok);
  console.log(code, 'calls', Object.keys(c.raw).length, 'failed', failed.map((f) => f.key));
  fs.writeFileSync(path.join(root, 'snapshots', `${code}.json`), JSON.stringify({ thscode: code, created_at: Date.now(), raw: c.raw }));
}
