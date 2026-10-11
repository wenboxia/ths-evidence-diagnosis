// 数据客户端：限流重试、业务错误不重试、超时、总时限
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFuyaoClient } from '../lib/fuyao.js';
import { fetchFrom } from './helpers.js';

const PATH = '/api/a-share/valuations/snapshot';
const okEnv = { code: 0, message: 'success', request_id: 'r1', data: { timestamp: 1, item: [{ thscode: '300033.SZ', pe_ttm: 62.3 }] } };

test('限流重试：429 后重试成功', async () => {
  let n = 0;
  const fetchImpl = fetchFrom(() => (++n === 1 ? new Response('', { status: 429 }) : okEnv));
  const client = createFuyaoClient({ apiKey: 'test', fetchImpl, maxAttempts: 2 });
  const r = await client.call('估值', PATH, { thscodes: '300033.SZ' });
  assert.equal(r.ok, true);
  assert.equal(r.code, 0);
  assert.equal(r.attempts, 2);
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(r.data.item[0].pe_ttm, 62.3);
  assert.equal(fetchImpl.calls[0].init.headers['X-api-key'], 'test');

  // 成功结果进入缓存，再次调用不发请求
  const again = await client.call('估值', PATH, { thscodes: '300033.SZ' });
  assert.equal(again.cache, 'hit');
  assert.equal(fetchImpl.calls.length, 2);
});

test('业务错误 2001 不重试', async () => {
  const fetchImpl = fetchFrom(() => ({ code: 2001, message: 'unauth', request_id: 'r2', data: null }));
  const client = createFuyaoClient({ apiKey: 'test', fetchImpl, maxAttempts: 2 });
  const r = await client.call('估值', PATH, { thscodes: '300033.SZ' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 2001);
  assert.match(r.message, /未认证/);
  assert.equal(fetchImpl.calls.length, 1, '2001 不应重试');
});

// 回归：失败调用记录真实请求次数（曾恒为 maxAttempts，见 AI 使用与验证记录 #15）
test('业务错误 2001 的 attempts 字段为 1', async () => {
  const fetchImpl = fetchFrom(() => ({ code: 2001, message: 'unauth', request_id: 'r2', data: null }));
  const client = createFuyaoClient({ apiKey: 'test', fetchImpl, maxAttempts: 2 });
  const r = await client.call('估值', PATH, { thscodes: '300033.SZ' });
  assert.equal(r.attempts, 1);
});

function hangingFetch() {
  let called = 0;
  const impl = (url, { signal } = {}) => {
    called++;
    return new Promise((_, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  };
  impl.count = () => called;
  return impl;
}

test('超时：请求挂起被中止返回 TIMEOUT', async () => {
  // 用 1600ms 覆盖“单次超时”路径；<1500ms 的情况见下一条回归测试
  const fetchImpl = hangingFetch();
  const client = createFuyaoClient({ apiKey: 'test', fetchImpl, timeoutMs: 1600, maxAttempts: 1 });
  const t0 = Date.now();
  const r = await client.call('估值', PATH, { thscodes: '300033.SZ' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'TIMEOUT');
  assert.equal(fetchImpl.count(), 1);
  assert.ok(Date.now() - t0 < 5000);
});

// 回归：timeoutMs < 1500 时仍会发出请求（曾被误判为 BUDGET，见 AI 使用与验证记录 #15）
test('超时：timeoutMs=200 应返回 TIMEOUT', async () => {
  const fetchImpl = hangingFetch();
  const client = createFuyaoClient({ apiKey: 'test', fetchImpl, timeoutMs: 200, maxAttempts: 1 });
  const r = await client.call('估值', PATH, { thscodes: '300033.SZ' });
  assert.equal(r.code, 'TIMEOUT');
});

test('总时限已到：返回 BUDGET 且不发请求', async () => {
  const fetchImpl = hangingFetch();
  const client = createFuyaoClient({ apiKey: 'test', fetchImpl, maxAttempts: 2 });
  const r = await client.call('估值', PATH, { thscodes: '300033.SZ' }, { deadline: Date.now() - 1000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'BUDGET');
  assert.equal(fetchImpl.count(), 0);
});

test('实时调用失败时回退到最近一次成功结果，并标记为 stale', async () => {
  let fail = false;
  const fetchImpl = fetchFrom(() => (fail ? { code: 5003, message: 'down', request_id: 'r9', data: null } : okEnv));
  const cache = new Map();
  const client = createFuyaoClient({ apiKey: 'test', fetchImpl, maxAttempts: 1, cache });
  const first = await client.call('估值', PATH, { thscodes: '300033.SZ' });
  assert.equal(first.ok, true);
  for (const v of cache.values()) v.cached_at -= 11 * 60 * 1000; // 超过 10 分钟新鲜期
  fail = true;
  const r = await client.call('估值', PATH, { thscodes: '300033.SZ' });
  assert.equal(r.ok, true);
  assert.equal(r.cache, 'stale');
  assert.match(r.stale_reason, /数据源不可用/);
  assert.equal(r.data.item[0].pe_ttm, 62.3);
  // 超过 24h 不再回退
  for (const v of cache.values()) v.cached_at -= 25 * 3600 * 1000;
  const r2 = await client.call('估值', PATH, { thscodes: '300033.SZ' });
  assert.equal(r2.ok, false);
});
