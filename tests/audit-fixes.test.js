// 针对逐句审计发现的问题的回归测试：快照模式、同行口径冲突、字段空值、合规拦截、事实/推断改判、快照回退边界
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFuyaoClient } from '../lib/fuyao.js';
import { collect, applySnapshot } from '../lib/collect.js';
import { buildEvidence } from '../lib/evidence.js';
import { verify, bannedHit, relabel, sanitizePlan, annotate, rulePlan } from '../lib/agent.js';
import { mockFuyao } from '../fixtures/mock.js';
import { CODE } from './helpers.js';

async function collectWith(mock) {
  return collect(createFuyaoClient({ mock }), CODE);
}

test('快照模式：矛盾与风险不被静默清空，并标注“基于快照/过期数据”', async () => {
  const base = buildEvidence(await collectWith(mockFuyao));
  const col = await collectWith(mockFuyao);
  for (const r of Object.values(col.raw)) if (r.ok) { r.cache = 'snapshot'; r.stale_reason = '测试：数据源不可达'; }
  const d = buildEvidence(col);
  assert.ok(d.evidence.filter((e) => e.status === 'stale').length >= 20);
  assert.equal(d.contradictions.length, base.contradictions.length);
  assert.ok(d.contradictions.every((c) => c.title.includes('快照')));
  assert.equal(d.risks.filter((r) => r.level !== '数据').length, base.risks.filter((r) => r.level !== '数据').length);
  assert.ok(d.risks.some((r) => r.id === 'R91'), '应触发“基于快照/过期数据”的数据风险');
  assert.ok(d.stats.positive + d.stats.negative > 0, '过期证据仍按规则判定，只是标注过期');
});

test('风险规则清单：全部规则都被检查，未触发的也保留', async () => {
  const d = buildEvidence(await collectWith(mockFuyao));
  assert.ok(d.risk_checks.length >= 12);
  assert.ok(d.risk_checks.every((c) => typeof c.triggered === 'boolean' && c.rule));
  assert.deepEqual(d.risks.map((r) => r.id), d.risk_checks.filter((c) => c.triggered).map((c) => c.id));
});

test('同行口径冲突：净利率 >100% 的同行标为不可比，不参与排名并生成 X2', async () => {
  const mock = async (path, p) => {
    const env = await mockFuyao(path, p);
    if (path.includes('income-statements') && p.thscode === '300059.SZ') for (const it of env.data.item) it.parent_holder_net_profit = it.operating_income * 3.5;
    return env;
  };
  const d = buildEvidence(await collectWith(mock));
  const row = d.peer_table.rows.find((r) => r.thscode === '300059.SZ');
  assert.equal(row.comparable, false);
  assert.match(row.conflict_reason, /不可比/);
  const x2 = d.evidence.find((e) => e.id === 'X2');
  assert.equal(x2.status, 'conflict');
  assert.ok(d.open_questions.some((q) => q.id === 'U-X2'));
  const i1 = d.evidence.find((e) => e.id === 'I1');
  assert.match(i1.display, /\/ 4/, '营收类排名应剔除不可比同行');
  assert.equal(i1.polarity, 'neutral', '排名不完整时不做正负判定');
  const i2 = d.evidence.find((e) => e.id === 'I2');
  assert.match(i2.display, /\/ 5/, '净利润可比，不应剔除');
  assert.ok(d.risks.some((r) => r.id === 'R92'));
});

test('字段为空：不得算出 0% 等“正常”值，E2 只统计正的现金分红', async () => {
  const mock = async (path, p) => {
    const env = await mockFuyao(path, p);
    if (p.thscode === CODE && path.includes('balance-sheets') && p.period === 'quarterly') env.data.item[0].total_debt = null;
    if (p.thscode === CODE && path.includes('income-statements') && p.period === 'annual') env.data.item[0].parent_holder_net_profit = null;
    if (path.includes('adjustment-factors')) env.data.item = env.data.item.map((x, i) => ({ ...x, dividend_per_share: i === 0 ? 1.5 : 0 }));
    return env;
  };
  const d = buildEvidence(await collectWith(mock));
  const get = (id) => d.evidence.find((e) => e.id === id);
  assert.equal(get('Q5').status, 'missing');
  assert.equal(get('Q4').status, 'missing');
  assert.equal(get('F4').status, 'missing');
  assert.equal(get('E2').value, 1, '只有 1 年有正的现金分红');
  assert.notEqual(get('E2').polarity, 'positive');
  assert.ok(!d.profile.traits.some((t) => t.k === 'light_asset'), '负债率缺失时不得生成“低负债”特征');
});

test('合规：扩充词表与收窄的否定豁免', () => {
  for (const t of ['后市看涨', '短期大概率上涨', '具备较大上行空间', '建议逢低布局', '可以适当配置', '值得长期持有', '未来一年收益可期', '不建议卖出，可继续持有', '同花顺是一家好公司', '估值明显低估']) {
    assert.ok(bannedHit(t), `应拦截：${t}`);
  }
  for (const t of ['本产品不提供买入建议', '以下内容不构成买入或卖出建议', '营收同比 +48.68%']) {
    assert.equal(bannedHit(t), null, `不应拦截：${t}`);
  }
});

test('校验器：冲突数据不得当作事实；“缺失/不可比”类陈述豁免', async () => {
  const mock = async (path, p) => {
    const env = await mockFuyao(path, p);
    if (path.includes('income-statements') && p.thscode === '300059.SZ') for (const it of env.data.item) it.parent_holder_net_profit = it.operating_income * 3.5;
    return env;
  };
  const d = buildEvidence(await collectWith(mock));
  const bad = verify({ answer: [{ text: '同行数据一致可靠', type: 'fact', evidence_ids: ['X2'] }] }, d);
  assert.ok(bad.issues.some((i) => i.type === 'unknown_as_fact'));
  const ok = verify({ unknowns: [{ text: '东方财富口径不可比，排名待验证', evidence_ids: ['X2'] }], answer: [{ text: '同行口径不可比，规模排名待验证', type: 'fact', evidence_ids: ['X2'] }] }, d);
  assert.ok(!ok.issues.some((i) => i.type === 'unknown_as_fact'));
});

test('事实/推断：含评价性措辞的“事实”被确定性改判为推断', () => {
  const out = { answer: [{ text: '报告期后成交额同比 +5.5%，市场环境偏平', type: 'fact', evidence_ids: ['D2'] }, { text: '营收同比 +48.68%', type: 'fact', evidence_ids: ['F1'] }] };
  const n = relabel(out);
  assert.equal(n, 1);
  assert.equal(out.answer[0].type, 'inference');
  assert.ok(out.answer[0].relabeled);
  assert.equal(out.answer[1].type, 'fact');
});

test('合规：规划器文字命中禁用词时替换为规则文本', async () => {
  const d = buildEvidence(await collectWith(mockFuyao));
  const plan = { intent: '判断现在是否适合买入', compliance: { flag: true, note: '建议逢低布局' }, clarify: null, dimensions: [{ key: 'valuation', reason: '当前估值影响买入安全边际' }] };
  const hits = sanitizePlan(plan, '现在能买吗', d.profile);
  assert.ok(hits.length >= 3);
  assert.equal(bannedHit(plan.intent), null);
  assert.equal(bannedHit(plan.compliance.note), null);
  assert.equal(bannedHit(plan.dimensions[0].reason), null);
});

test('合规：修复后仍违规的句子隐去原文，unknowns 也会被标注', async () => {
  const d = buildEvidence(await collectWith(mockFuyao));
  const f1 = d.evidence.find((e) => e.id === 'F1');
  const out = { headline: f1.display, headline_ids: ['F1'], answer: [{ text: '建议买入', type: 'fact', evidence_ids: ['F1'] }], unknowns: [{ text: '无引用的未知项', evidence_ids: [] }] };
  const rep = verify(out, d);
  const a = annotate(out, rep);
  assert.equal(a.answer[0].masked, true);
  assert.ok(!a.answer[0].text.includes('买入'));
  assert.ok(a.unknowns[0].flags?.length, 'unknowns 也应被标注');
});

test('快照回退只用于可恢复错误：鉴权/权限等业务错误保持失败', () => {
  const raw = { a: { key: 'a', ok: false, code: 2001, message: '未认证' }, b: { key: 'b', ok: false, code: 'NETWORK', message: '网络错误' }, c: { key: 'c', ok: false, code: 2003, message: '权限不足' } };
  const snap = { raw: { a: { ok: true, data: { item: [1] } }, b: { ok: true, data: { item: [2] } }, c: { ok: true, data: { item: [3] } } } };
  applySnapshot(raw, ['a', 'b', 'c'], snap);
  assert.equal(raw.a.ok, false);
  assert.equal(raw.c.ok, false);
  assert.equal(raw.b.ok, true);
  assert.equal(raw.b.cache, 'snapshot');
});

test('全面诊断规划覆盖风险维度', async () => {
  const d = buildEvidence(await collectWith(mockFuyao));
  assert.ok(rulePlan('', d.profile).dimensions.some((x) => x.key === 'risk'));
});
