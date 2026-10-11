// Agent：规则规划、校验器、LLM 不可用时的模板降级
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { rulePlan, verify, runAgent } from '../lib/agent.js';
import { llmConfigured } from '../lib/llm.js';
import { buildDiag, withoutEnv, LLM_ENV } from './helpers.js';

let diag;
before(async () => { ({ diag } = await buildDiag()); });

const ev = (id) => diag.evidence.find((e) => e.id === id);
const check = (point) => verify({ answer: [point] }, diag);
const types = (rep) => rep.issues.map((i) => i.type);

test('合规规划：买卖问题打合规标记并转向估值', () => {
  const p = rulePlan('现在能买吗？', diag.profile);
  assert.equal(p.source, 'rule');
  assert.equal(p.compliance.flag, true);
  assert.ok(p.compliance.note.length > 0);
  const keys = p.dimensions.map((d) => d.key);
  assert.ok(keys.includes('valuation'));
  assert.ok(keys.includes('risk'));
});

test('合规规划：估值问题优先估值维度', () => {
  const p = rulePlan('估值贵不贵', diag.profile);
  assert.equal(p.compliance.flag, false);
  assert.equal(p.dimensions[0].key, 'valuation');
});

test('合规规划：空问题（全面诊断）覆盖公司画像下的全部维度', () => {
  const p = rulePlan('', diag.profile);
  assert.equal(p.compliance.flag, false);
  assert.deepEqual(p.dimensions.map((d) => d.key), diag.profile.priority);
  assert.ok(p.dimensions.some((d) => d.key === 'risk'));
});

test('校验器：未引用证据', () => {
  const r = check({ text: '公司经营稳定', type: 'fact', evidence_ids: [] });
  assert.ok(types(r).includes('no_citation'));
  assert.equal(r.passed, false);
});

test('校验器：引用不存在的证据', () => {
  const r = check({ text: '公司经营稳定', type: 'fact', evidence_ids: ['Z9'] });
  assert.ok(types(r).includes('bad_citation'));
  assert.equal(r.passed, false);
});

test('校验器：编造数字', () => {
  const r = check({ text: '营收增长 123.45%', type: 'fact', evidence_ids: ['F1'] });
  const issue = r.issues.find((i) => i.type === 'unsupported_number');
  assert.ok(issue, JSON.stringify(r.issues));
  assert.match(issue.detail, /123\.45/);
});

test('校验器：合规禁用表述', () => {
  const r = check({ text: '建议买入', type: 'inference', confidence: '低', evidence_ids: ['F1'] });
  assert.ok(types(r).includes('compliance'));
  assert.equal(r.passed, false);
});

test('校验器：缺失数据当事实', () => {
  assert.equal(ev('E9').status, 'missing');
  const r = check({ text: '近期没有重大公告', type: 'fact', evidence_ids: ['E9'] });
  assert.ok(types(r).includes('unknown_as_fact'));
  // 放在 unknowns 里则合法
  const ok = verify({ unknowns: [{ text: '近期没有重大公告', evidence_ids: ['E9'] }] }, diag);
  assert.equal(ok.major, 0);
});

test('校验器：忠实复述通过', () => {
  const f1 = ev('F1');
  assert.equal(f1.status, 'ok');
  const r = check({ text: f1.display, type: 'fact', evidence_ids: ['F1'] });
  assert.equal(r.major, 0, JSON.stringify(r.issues));
  assert.equal(r.passed, true);
});

test('校验器：方向读反', () => {
  const pos = diag.evidence.find((e) => e.status === 'ok' && e.polarity === 'positive');
  assert.ok(pos, 'mock 数据中应至少有 1 条正面证据');
  const r = check({ text: '该项指标明显恶化', type: 'fact', evidence_ids: [pos.id] });
  assert.ok(types(r).includes('direction_mismatch'), JSON.stringify(r.issues));
  // 带转折词不误报
  const t = check({ text: '虽然该项指标恶化', type: 'fact', evidence_ids: [pos.id] });
  assert.ok(!types(t).includes('direction_mismatch'));
});

test('LLM 不可用降级：模板模式只输出事实', async () => {
  const restore = withoutEnv(LLM_ENV);
  try {
    assert.equal(llmConfigured(), false);
    const r = await runAgent('业绩在改善吗', diag);
    assert.equal(r.mode, 'template');
    assert.equal(r.plan.source, 'rule');
    assert.equal(r.plan.dimensions[0].key, 'financial_trend');
    const dims = r.interpretation.dimensions;
    assert.ok(dims.length > 0);
    const points = dims.flatMap((d) => d.points);
    assert.ok(points.length > 0);
    for (const p of points) {
      assert.equal(p.type, 'fact');
      assert.ok(p.evidence_ids.length > 0);
    }
    assert.equal(r.verification.mode, 'template');
    assert.ok(r.trace.some((s) => s.step === 'plan' && s.status === 'fallback'));
  } finally {
    restore();
  }
});
