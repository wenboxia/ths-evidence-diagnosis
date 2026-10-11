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

// ---------- 第二轮复核发现的问题 ----------
async function diagWith(patch) {
  const mock = async (path, p) => { const env = await mockFuyao(path, p); patch(path, p, env); return env; };
  return buildEvidence(await collectWith(mock));
}

test('字段为空（二）：F3/F5/Q2 不得用空值算出结论', async () => {
  const d = await diagWith((path, p, env) => {
    if (p.thscode !== CODE || !path.includes('income-statements')) return;
    if (p.period === 'quarterly') { env.data.item[0].parent_holder_net_profit = null; env.data.item[1].parent_holder_net_profit = null; env.data.item[2].parent_holder_net_profit = null; env.data.item[3].parent_holder_net_profit = null; }
    if (p.period === 'annual') { env.data.item[0].operating_income = null; }
  });
  const g = (id) => d.evidence.find((e) => e.id === id);
  assert.equal(g('F3').status, 'missing');
  assert.notEqual(g('F5')?.status, 'ok');
  assert.equal(g('Q2').status, 'missing');
});

test('字段为空（三）：成交额缺失时 M4 不算活跃度，单边市场缺失时 D1 不计算', async () => {
  const d = await diagWith((path, p, env) => {
    if (path.includes('/prices/historical') && p.thscode === CODE) for (const b of env.data.item.slice(-30)) b.turnover = null;
    if (path.includes('a-share-index/prices/historical') && p.thscode === '399106.SZ') for (const b of env.data.item) b.turnover = null;
  });
  const g = (id) => d.evidence.find((e) => e.id === id);
  assert.match(g('M4').display, /成交额数据缺失/);
  assert.ok(!/NaN/.test(g('M4').display + g('M4').detail));
  assert.equal(g('D1').status, 'missing');
});

test('合规词表（二）：持仓/观望/买点/安全边际/看好/有望修复等变体被拦截，“并非”不再豁免', () => {
  for (const t of ['股价可能上涨', '这并非卖出时机', '可以考虑加仓', '具备投资价值', '后市看好', '估值合理，具备安全边际', '是不错的买点', '股价有较大上升空间', '可以继续拿着', '不必止损', '建议观望', '不宜追高', '估值洼地', '性价比较高', '有望走出底部', '是一只好股票', '前景广阔']) {
    assert.ok(bannedHit(t), `应拦截：${t}`);
  }
  assert.equal(bannedHit('本产品不提供买入、持有或卖出建议'), null);
});

test('校验器：把已有数据说成“清单未提供”时判为严重问题', async () => {
  const d = buildEvidence(await collectWith(mockFuyao));
  const r = verify({ answer: [{ text: '现金含量与负债率对应证据未出现在本清单中，无法评述', type: 'inference', confidence: '低', evidence_ids: ['F2'] }] }, d);
  assert.ok(r.issues.some((i) => i.type === 'false_missing_claim' && !i.minor));
});

test('事实/推断（二）：引用派生/观点证据或带因果措辞的“事实”被改判', async () => {
  const d = buildEvidence(await collectWith(mockFuyao));
  const out = { answer: [
    { text: '相关系数 0.50', type: 'fact', evidence_ids: ['D1'] },
    { text: '利润增长主要来自市场成交回暖', type: 'fact', evidence_ids: ['F2'] },
    { text: '营收同比 +2.01%', type: 'fact', evidence_ids: ['F1'] },
    { text: '没有类型的陈述', evidence_ids: ['F1'] },
  ] };
  relabel(out, d);
  assert.deepEqual(out.answer.map((x) => x.type), ['inference', 'inference', 'fact', 'inference']);
});

test('规划器文字：命中禁用词时意图改为固定文本，不再回显用户原句', async () => {
  const d = buildEvidence(await collectWith(mockFuyao));
  const plan = { intent: '理解为：现在能不能买入，可以继续持有吗', compliance: { flag: true, note: '' }, clarify: null, dimensions: [{ key: 'valuation', reason: '估值' }] };
  sanitizePlan(plan, '现在能不能买入，可以继续持有吗', d.profile);
  assert.equal(bannedHit(plan.intent), null);
});

// ---------- 第三轮：查漏发现的问题 ----------
test('合规（三）：按短语拦截，不误伤中性陈述', () => {
  for (const t of ['期末持有货币资金 124.49 亿元', '公司在 AI 业务上的布局持续推进', '股价近 1 月反弹 8.9%', '资产配置以现金为主', '建议查阅年报中的分产品收入', '可以考虑在巨潮资讯网检索近 3 个月公告', '高估值意味着对增长持续性的要求更高', '市场情绪处于观望状态']) {
    assert.equal(bannedHit(t), null, `不应拦截：${t}`);
  }
  for (const t of ['可以继续持有', '建议观望', '股价将反弹', '有望见底回升', '估值偏贵', '存在高估']) assert.ok(bannedHit(t), `应拦截：${t}`);
});

test('校验器：未知/待验证类陈述（历史分位、分部构成）不触发 false_missing_claim', async () => {
  const d = buildEvidence(await collectWith(mockFuyao));
  const r = verify({
    unknowns: [{ text: '估值的历史分位未提供，无法评述', evidence_ids: ['V1'] }],
    answer: [{ text: '分部收入构成未提供，无法评述哪块业务最敏感', type: 'inference', confidence: '低', evidence_ids: ['D1'] }],
  }, d);
  assert.ok(!r.issues.some((i) => i.type === 'false_missing_claim'));
});

test('事实/推断（三）：证据原文中的词不触发改判', async () => {
  const d = buildEvidence(await collectWith(mockFuyao));
  const v2 = d.evidence.find((e) => e.id === 'V2');
  const out = { answer: [{ text: `${v2.title} ${v2.display}，规则：${v2.rule}`, type: 'fact', evidence_ids: ['V2'] }] };
  relabel(out, d);
  assert.equal(out.answer[0].type, 'fact');
});

test('风险规则：茅台无经营驱动维度，R3/R4 标为不适用；X2 文案写明 I2 仍纳入', async () => {
  const col = await collect(createFuyaoClient({ mock: mockFuyao }), '600519.SH');
  const d = buildEvidence(col);
  for (const id of ['R3', 'R4']) assert.equal(d.risk_checks.find((c) => c.id === id).not_applicable, true);
  const mock = async (path, p) => { const env = await mockFuyao(path, p); if (path.includes('income-statements') && p.thscode === '300059.SZ') for (const it of env.data.item) it.parent_holder_net_profit = it.operating_income * 3.5; return env; };
  const d2 = buildEvidence(await collectWith(mock));
  assert.match(d2.evidence.find((e) => e.id === 'X2').rule, /I2.*仍纳入/);
});
