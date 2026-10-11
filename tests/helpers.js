// 测试辅助：用构造数据跑通 采集 → 证据，并提供可替换的 fetch 桩。
import { createFuyaoClient } from '../lib/fuyao.js';
import { collect } from '../lib/collect.js';
import { buildEvidence } from '../lib/evidence.js';
import { mockFuyao } from '../fixtures/mock.js';

export const CODE = '300033.SZ';

// 用 mock（或包装过的 mock）构建完整诊断对象
export async function buildDiag(mock = mockFuyao, evidenceOpts) {
  const client = createFuyaoClient({ mock });
  const collected = await collect(client, CODE);
  return { collected, diag: buildEvidence(collected, evidenceOpts) };
}

// 把请求 URL 拆回 (path, params)，交给 handler 生成信封；handler 返回 Response 时原样透传
export function fetchFrom(handler) {
  const calls = [];
  const impl = async (url, init) => {
    const u = new URL(url);
    const i = u.pathname.indexOf('/api/');
    const path = i >= 0 ? u.pathname.slice(i) : u.pathname;
    const params = Object.fromEntries(u.searchParams.entries());
    calls.push({ path, params, init });
    const out = await handler(path, params, init);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  impl.calls = calls;
  return impl;
}

export const LLM_ENV = ['LLM_API_KEY', 'KIMI_API_KEY', 'GLM_API_KEY'];

// 临时删除环境变量，返回恢复函数
export function withoutEnv(keys) {
  const saved = {};
  for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
  return () => { for (const k of keys) if (saved[k] !== undefined) process.env[k] = saved[k]; };
}
