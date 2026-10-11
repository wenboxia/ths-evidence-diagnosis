// 采集 → 证据 全链路：正常、未配置 Key、接口业务错误、数据冲突、过期行情
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFuyaoClient } from '../lib/fuyao.js';
import { collect } from '../lib/collect.js';
import { buildEvidence } from '../lib/evidence.js';
import { mockFuyao } from '../fixtures/mock.js';
import { buildDiag, fetchFrom, withoutEnv, CODE } from './helpers.js';

const byId = (diag, id) => diag.evidence.find((e) => e.id === id);

test('主链路：mock 数据全部调用成功且证据可追溯', async () => {
  const { collected, diag } = await buildDiag();

  assert.ok(collected.calls.length >= 20, `调用数过少：${collected.calls.length}`);
  const failed = collected.calls.filter((c) => !c.ok);
  assert.deepEqual(failed.map((c) => `${c.key}:${c.code}`), []);

  const ids = new Set(diag.evidence.map((e) => e.id));
  for (const id of ['F1', 'F2', 'Q1', 'V1', 'M1', 'I1', 'D1', 'E2']) {
    assert.ok(ids.has(id), `缺少证据 ${id}`);
    assert.equal(byId(diag, id).status, 'ok', `${id} 状态应为 ok`);
  }

  for (const e of diag.evidence.filter((x) => x.status === 'ok')) {
    assert.ok(Array.isArray(e.sources) && e.sources.length > 0, `${e.id} 缺少 sources`);
    for (const s of e.sources) {
      assert.ok(typeof s.path === 'string' && s.path.startsWith('/api/'), `${e.id} 来源缺少 path`);
      assert.ok(Array.isArray(s.fields), `${e.id} 来源缺少 fields`);
    }
  }

  const st = diag.stats;
  assert.equal(st.positive + st.negative + st.neutral + st.unknown, st.evidence_total); // stale 是正/负/中性中的子集
  assert.equal(st.evidence_total, diag.evidence.length);
  assert.equal(diag.quarterly_basis.basis, 'verified');
  assert.equal(diag.quarterly_basis.cumulative, true);
});

test('未配置 Key：全部调用 NO_KEY，不产出正负结论', async () => {
  const restore = withoutEnv(['FUYAO_API_KEY']);
  try {
    let fetched = 0;
    const client = createFuyaoClient({ apiKey: '', fetchImpl: async () => { fetched++; throw new Error('不应发起请求'); } });
    const collected = await collect(client, CODE);
    assert.equal(fetched, 0);

    const real = collected.calls.filter((c) => c.code !== 'SKIPPED');
    assert.ok(real.length >= 19);
    for (const c of real) {
      assert.equal(c.ok, false);
      assert.equal(c.code, 'NO_KEY', `${c.key} 应为 NO_KEY`);
    }
    assert.equal(collected.raw.indicators.code, 'SKIPPED');

    const diag = buildEvidence(collected);
    const judged = diag.evidence.filter((e) => e.status === 'ok' && (e.polarity === 'positive' || e.polarity === 'negative'));
    assert.deepEqual(judged.map((e) => e.id), []);
    assert.equal(diag.stats.positive + diag.stats.negative, 0);
    assert.ok(diag.risks.some((r) => r.title.includes('数据风险')), '应提示数据风险');
    assert.ok(byId(diag, 'F1') && byId(diag, 'F1').status === 'error');
  } finally {
    restore();
  }
});

test('接口业务错误：财务接口 5003 时降级而不崩溃', async () => {
  const fetchImpl = fetchFrom((path, params) => (
    path.startsWith('/api/a-share/financials/')
      ? { code: 5003, message: 'down', request_id: 'x', data: null }
      : mockFuyao(path, params)
  ));
  const client = createFuyaoClient({ apiKey: 'test', fetchImpl, maxAttempts: 2 });
  const collected = await collect(client, CODE);
  const diag = buildEvidence(collected);

  for (const id of ['F1', 'F2']) {
    const e = byId(diag, id);
    assert.ok(e, `缺少 ${id}`);
    assert.equal(e.status, 'error');
    assert.equal(e.polarity, 'unknown');
    assert.match(e.reason, /数据源不可用/);
  }
  // 5003 可重试：每个财务调用应被请求 2 次
  const finCalls = fetchImpl.calls.filter((c) => c.path === '/api/a-share/financials/income-statements' && c.params.thscode === CODE && c.params.period === 'quarterly');
  assert.equal(finCalls.length, 2);

  const v1 = byId(diag, 'V1');
  assert.equal(v1.status, 'ok');
  assert.equal(v1.value, 62.3);
  assert.equal(byId(diag, 'M1').status, 'ok');

  assert.ok(diag.profile && typeof diag.profile.type === 'string');
  assert.ok(Array.isArray(diag.profile.priority) && diag.profile.priority.length > 0);

  assert.ok(diag.open_questions.some((q) => q.refs.includes('F1')), 'open_questions 应包含 F1');
  assert.ok(diag.risks.some((r) => r.title.includes('数据风险') && r.refs.includes('F1')));
});

test('数据冲突：毛利率双源差异 >1pct 记为冲突', async () => {
  const mock = async (path, params) => {
    const env = await mockFuyao(path, params);
    if (path === '/api/a-share/financials/indicators' && params.thscode === CODE) {
      for (const a of env.data.abilities) {
        for (const i of a.indicators) {
          if (i.index_id === 'sale_gross_margin') i.value = (Number(i.value) - 5).toFixed(4);
        }
      }
    }
    return env;
  };
  const { diag } = await buildDiag(mock);
  const x1 = byId(diag, 'X1');
  assert.ok(x1, '缺少 X1');
  assert.equal(x1.status, 'conflict');
  assert.equal(x1.polarity, 'unknown');
  assert.ok(x1.value > 1);
  assert.ok(diag.open_questions.some((q) => q.refs.includes('X1')), 'X1 应进入待验证问题');

  // 对照：未篡改时 X1 一致
  const { diag: clean } = await buildDiag();
  assert.equal(byId(clean, 'X1').status, 'ok');
});

test('过期行情：K 线落后 20 天标记 stale', async () => {
  const { collected } = await buildDiag();
  const bars = collected.raw.kline.data.item;
  const lastMs = Math.max(...bars.map((b) => b.date_ms));
  const now = lastMs + 20 * 86400000;
  const diag = buildEvidence(collected, { now });

  const m1 = byId(diag, 'M1');
  assert.equal(m1.status, 'stale');
  assert.match(m1.detail, /过期/);
  assert.ok(diag.risks.some((r) => r.title.includes('过期') && r.refs.includes('M1')));
  assert.ok(diag.stats.stale >= 1);
  const st = diag.stats;
  assert.equal(st.positive + st.negative + st.neutral + st.unknown, st.evidence_total); // stale 是正/负/中性中的子集

  // 对照：当天不过期
  const fresh = buildEvidence(collected, { now: lastMs + 86400000 });
  assert.equal(byId(fresh, 'M1').status, 'ok');
});
