// 确定性证据层：所有数字都在这里由代码计算，LLM 只能引用这里产出的证据 ID。
// 每条证据都带：取值、单位、报告期/区间、判定规则、计算公式、原始来源（接口 + 参数 + request_id + 抓取时间）。
import { cnDate } from './fuyao.js';
import { MARKET_TURNOVER_INDEXES } from './config.js';

const DAY_MS = 24 * 3600 * 1000;

// ---------- 格式化 ----------
export const fmt = {
  yi: (v) => (v === null || v === undefined || !isFinite(v) ? '--' : `${(v / 1e8).toFixed(2)} 亿元`),
  pct: (v, d = 2) => (v === null || v === undefined || !isFinite(v) ? '--' : `${v >= 0 ? '' : ''}${v.toFixed(d)}%`),
  spct: (v, d = 2) => (v === null || v === undefined || !isFinite(v) ? '--' : `${v > 0 ? '+' : ''}${v.toFixed(d)}%`),
  x: (v, d = 2) => (v === null || v === undefined || !isFinite(v) ? '--' : `${v.toFixed(d)} 倍`),
  num: (v, d = 2) => (v === null || v === undefined || !isFinite(v) ? '--' : v.toFixed(d)),
};

const yoy = (cur, prev) => (isNum(cur) && isNum(prev) && prev !== 0 ? ((cur - prev) / Math.abs(prev)) * 100 : null);
const isNum = (v) => typeof v === 'number' && isFinite(v);
const median = (arr) => {
  const a = arr.filter(isNum).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const periodLabel = (it) => (it ? `${it.fiscal_year}${it.fiscal_period === 'FY' ? '年报' : it.fiscal_period === 'Q4' ? '年报(Q4)' : it.fiscal_period === 'Q2' ? '中报' : it.fiscal_period === 'Q1' ? '一季报' : it.fiscal_period === 'Q3' ? '三季报' : it.fiscal_period}` : '--');
const reportLabel = (r) => { const m = /^(\d{4})-(\d)$/.exec(r || ''); return m ? `${m[1]}${{ 1: '一季报', 2: '中报', 3: '三季报', 4: '年报' }[m[2]]}` : (r || '--'); };
const items = (r) => (r?.ok && Array.isArray(r.data?.item) ? r.data.item : []);
const samePeriodLastYear = (list, it) => list.find((x) => x.fiscal_year === it.fiscal_year - 1 && x.fiscal_period === it.fiscal_period);

function srcOf(raw, key, fields, note) {
  const r = raw[key];
  if (!r) return { key, tool: key, ok: false };
  return {
    key, tool: r.tool, path: r.path, params: r.params, fields,
    request_id: r.request_id || null, fetched_at: r.fetched_at || null,
    data_timestamp: r.data_timestamp ?? null, ok: !!r.ok, code: r.code, source: r.source, note,
    cache: r.cache || null, stale_reason: r.stale_reason || null,
  };
}

// ---------- 单季拆分（季报为年初累计值时：单季 = 本期累计 − 上一季度累计，Q1 取原值） ----------
const QN = { Q1: 1, Q2: 2, Q3: 3, Q4: 4, FY: 4 };
function singleQuarter(list, field, cumulative) {
  const out = new Map();
  for (const it of list) {
    const q = QN[it.fiscal_period];
    let v = null;
    if (!cumulative || q === 1) v = isNum(it[field]) ? it[field] : null;
    else {
      const pq = list.find((x) => x.fiscal_year === it.fiscal_year && QN[x.fiscal_period] === q - 1);
      v = pq && isNum(it[field]) && isNum(pq[field]) ? it[field] - pq[field] : null;
    }
    out.set(`${it.fiscal_year}-${q}`, v);
  }
  return out;
}
function sqYoySeries(list, field, cumulative, n = 5) {
  const sq = singleQuarter(list, field, cumulative);
  const res = [];
  for (const it of list.slice(0, n)) {
    const q = QN[it.fiscal_period];
    const cur = sq.get(`${it.fiscal_year}-${q}`), prev = sq.get(`${it.fiscal_year - 1}-${q}`);
    const g = isNum(cur) && isNum(prev) && prev !== 0 ? ((cur - prev) / Math.abs(prev)) * 100 : null;
    if (isNum(g)) res.push({ period: `${it.fiscal_year}Q${q}`, yoy: g, value: cur, prev, it, q });
  }
  return res;
}

// ---------- 证据簿 ----------
class Book {
  constructor(raw) { this.raw = raw; this.list = []; }
  add(e) {
    const item = { status: 'ok', kind: 'fact', polarity: 'neutral', ...e };
    const stale = (item.sources || []).filter((s) => s.cache === 'stale' || s.cache === 'snapshot');
    if (stale.length && item.status === 'ok') {
      item.status = 'stale';
      item.detail = `${item.detail ? item.detail + '；' : ''}实时调用失败（${stale[0].stale_reason}），使用 ${new Date(stale[0].fetched_at + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')} 抓取的${stale[0].cache === 'snapshot' ? '快照' : '缓存'}数据`;
    }
    this.list.push(item);
    return e.id;
  }
  missing(e, keys = []) {
    const failed = keys.map((k) => this.raw[k]).filter((r) => r && !r.ok);
    const reason = e.reason || (failed.length ? failed.map((r) => `${r.tool}：${r.message}`).join('；') : '接口返回中缺少所需字段');
    this.list.push({
      kind: 'fact', polarity: 'unknown', value: null, display: '数据缺失', ...e,
      status: failed.length ? 'error' : 'missing', reason,
      sources: e.sources || keys.map((k) => srcOf(this.raw, k, [])),
    });
    return e.id;
  }
  get(id) { return this.list.find((x) => x.id === id); }
}

// ---------- K 线工具 ----------
function bars(r) {
  return items(r).filter((b) => isNum(b.close_price)).sort((a, b) => a.date_ms - b.date_ms);
}
function retOver(bs, n) {
  if (bs.length <= n) return null;
  const a = bs[bs.length - 1 - n].close_price, b = bs[bs.length - 1].close_price;
  return yoy(b, a);
}
function volatility(bs, n = 250) {
  const s = bs.slice(-n - 1);
  if (s.length < 30) return null;
  const rets = [];
  for (let i = 1; i < s.length; i++) rets.push(Math.log(s[i].close_price / s[i - 1].close_price));
  const m = rets.reduce((x, y) => x + y, 0) / rets.length;
  const v = rets.reduce((x, y) => x + (y - m) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(v) * Math.sqrt(252) * 100;
}
function maxDrawdown(bs, n = 250) {
  const s = bs.slice(-n);
  if (s.length < 30) return null;
  let peak = s[0].close_price, mdd = 0, peakDate = s[0].date_ms, troughDate = s[0].date_ms, curPeakDate = s[0].date_ms;
  for (const b of s) {
    if (b.close_price > peak) { peak = b.close_price; curPeakDate = b.date_ms; }
    const dd = (b.close_price / peak - 1) * 100;
    if (dd < mdd) { mdd = dd; peakDate = curPeakDate; troughDate = b.date_ms; }
  }
  return { mdd, peakDate, troughDate };
}

// ---------- 主函数 ----------
export function buildEvidence(collected, { now = Date.now() } = {}) {
  const { raw, preset, thscode } = collected;
  const B = new Book(raw);
  const incQ = items(raw.income_q).sort((a, b) => b.period_end_ms - a.period_end_ms);
  const incA = items(raw.income_a).sort((a, b) => b.period_end_ms - a.period_end_ms);
  const balQ = items(raw.balance_q).sort((a, b) => b.period_end_ms - a.period_end_ms);
  const balA = items(raw.balance_a).sort((a, b) => b.period_end_ms - a.period_end_ms);
  const cashA = items(raw.cash_a).sort((a, b) => b.period_end_ms - a.period_end_ms);
  const latest = incQ[0];
  const latestA = incA[0];

  // 季报口径识别：Q4 季报值 == 年报值 → 季报为“年初至报告期末累计值”
  let cumulative = { value: true, basis: 'assumed' };
  const q4 = incQ.find((x) => x.fiscal_period === 'Q4' || x.fiscal_period === 'FY');
  if (q4) {
    const fy = incA.find((x) => x.fiscal_year === q4.fiscal_year);
    if (fy && isNum(fy.operating_income) && isNum(q4.operating_income)) {
      cumulative = { value: Math.abs(q4.operating_income / fy.operating_income - 1) < 0.005, basis: 'verified' };
    }
  }
  const qBasis = cumulative.value ? '年初至报告期末累计值' : '单季度值';

  // ===== 财务趋势 =====
  if (latest) {
    const prev = samePeriodLastYear(incQ, latest);
    const rg = yoy(latest.operating_income, prev?.operating_income);
    const pg = yoy(latest.parent_holder_net_profit, prev?.parent_holder_net_profit);
    // 上年同期记录的披露日晚于本期期末 → 该值来自较新的披露版本（本期报告中的比较数据，可能经追溯调整）
    const restated = prev && isNum(prev.report_date_ms) && prev.report_date_ms > latest.period_end_ms
      ? `；上年同期值取自 ${cnDate(prev.report_date_ms)} 披露的版本（接口 report_date_ms，可能为追溯调整后的比较数据）` : '';
    if (rg !== null) {
      B.add({
        id: 'F1', dim: 'financial_trend', title: `${periodLabel(latest)}营业收入同比`, value: rg, unit: '%', display: fmt.spct(rg),
        detail: `${fmt.yi(latest.operating_income)}（上年同期 ${fmt.yi(prev.operating_income)}）`,
        period: periodLabel(latest), basis: `合并报表；季报为${qBasis}${cumulative.basis === 'assumed' ? '（按 A 股惯例推定，未能交叉验证）' : '（已用年报交叉验证）'}${restated}`,
        polarity: rg >= 10 ? 'positive' : rg < 0 ? 'negative' : 'neutral', rule: '同比 ≥10% 记正面，<0 记负面，其余中性',
        calc: '(本期 operating_income − 上年同期) / |上年同期|', drill: { type: 'financials', statement: 'income', field: 'operating_income' },
        sources: [srcOf(raw, 'income_q', ['operating_income', 'fiscal_year', 'fiscal_period', 'report_date_ms'])],
      });
    } else B.missing({ id: 'F1', dim: 'financial_trend', title: '最新报告期营业收入同比', reason: '缺少上年同期数据' }, ['income_q']);
    if (pg !== null) {
      B.add({
        id: 'F2', dim: 'financial_trend', title: `${periodLabel(latest)}归母净利润同比`, value: pg, unit: '%', display: fmt.spct(pg),
        detail: `${fmt.yi(latest.parent_holder_net_profit)}（上年同期 ${fmt.yi(prev.parent_holder_net_profit)}）`,
        period: periodLabel(latest), basis: `合并报表归属于母公司股东的净利润；${qBasis}${restated}`,
        polarity: pg >= 10 ? 'positive' : pg < 0 ? 'negative' : 'neutral', rule: '同比 ≥10% 记正面，<0 记负面，其余中性',
        calc: '(本期 parent_holder_net_profit − 上年同期) / |上年同期|', drill: { type: 'financials', statement: 'income', field: 'parent_holder_net_profit' },
        sources: [srcOf(raw, 'income_q', ['parent_holder_net_profit'])],
      });
    } else B.missing({ id: 'F2', dim: 'financial_trend', title: '最新报告期归母净利润同比', reason: '缺少上年同期数据' }, ['income_q']);

    // 边际变化用单季口径判断（累计口径会把前几个季度的高增长“摊”进来，掩盖拐点）
    const npS = sqYoySeries(incQ, 'parent_holder_net_profit', cumulative.value);
    const revS = sqYoySeries(incQ, 'operating_income', cumulative.value);
    const cumNp = incQ.slice(0, 5).map((it) => ({ it, prev: samePeriodLastYear(incQ, it) })).filter((x) => x.prev)
      .map((x) => ({ period: periodLabel(x.it), np: yoy(x.it.parent_holder_net_profit, x.prev.parent_holder_net_profit) })).filter((x) => isNum(x.np));
    const sqBasis = cumulative.value ? '单季值 = 本期累计 − 上一季度累计（Q1 取原值），对上年同一季度' : '接口为单季值，对上年同一季度';
    if (npS.length < 2) B.missing({ id: 'F3', dim: 'financial_trend', title: '归母净利润单季同比增速变化', reason: `可计算单季同比的季度不足 2 个（${npS.length} 个），可能有字段为空` }, ['income_q']);
    else {
      const [a, b] = npS;
      const acc = a.yoy - b.yoy;
      B.add({
        id: 'F3', dim: 'financial_trend', title: '归母净利润单季同比增速变化', value: acc, unit: 'pct', display: npS.map((x) => `${x.period} ${fmt.spct(x.yoy, 1)}`).join(' ← '),
        detail: `单季：${a.period} 较 ${b.period} 增速变化 ${acc > 0 ? '+' : ''}${acc.toFixed(1)} 个百分点；累计口径对照：${cumNp.slice(0, 3).map((x) => `${x.period} ${fmt.spct(x.np, 1)}`).join(' ← ')}`,
        period: `${npS[npS.length - 1].period} ~ ${a.period}`, basis: sqBasis, polarity: acc > 5 ? 'positive' : acc < -5 ? 'negative' : 'neutral',
        rule: '单季同比增速提升 >5pct 记正面（边际改善），下降 >5pct 记负面（边际走弱）', calc: '逐季计算单季同比后取最新两季之差',
        drill: { type: 'financials', statement: 'income', field: 'parent_holder_net_profit' },
        series: npS.map((x) => ({ period: x.period, np: x.yoy, rev: revS.find((r) => r.period === x.period)?.yoy ?? null })),
        sources: [srcOf(raw, 'income_q', ['parent_holder_net_profit', 'fiscal_period'])],
      });
    }
    if (revS.length < 2) B.missing({ id: 'F6', dim: 'financial_trend', title: '营业收入单季同比增速变化', reason: `可计算单季同比的季度不足 2 个（${revS.length} 个）` }, ['income_q']);
    else {
      const [a, b] = revS;
      const acc = a.yoy - b.yoy;
      B.add({
        id: 'F6', dim: 'financial_trend', title: '营业收入单季同比增速变化', value: acc, unit: 'pct', display: revS.map((x) => `${x.period} ${fmt.spct(x.yoy, 1)}`).join(' ← '),
        detail: `单季：${a.period} 营收 ${fmt.yi(a.value)}（上年同季 ${fmt.yi(a.prev)}），较 ${b.period} 增速变化 ${acc > 0 ? '+' : ''}${acc.toFixed(1)} 个百分点`,
        period: `${revS[revS.length - 1].period} ~ ${a.period}`, basis: sqBasis, polarity: acc > 5 ? 'positive' : acc < -5 ? 'negative' : 'neutral',
        rule: '单季同比增速提升 >5pct 记正面（加速），下降 >5pct 记负面（减速）', calc: '逐季计算单季同比后取最新两季之差',
        drill: { type: 'financials', statement: 'income', field: 'operating_income' },
        series: revS.map((x) => ({ period: x.period, rev: x.yoy, np: npS.find((r) => r.period === x.period)?.yoy ?? null })),
        sources: [srcOf(raw, 'income_q', ['operating_income', 'fiscal_period'])],
      });
    }
  } else {
    B.missing({ id: 'F1', dim: 'financial_trend', title: '最新报告期营业收入同比' }, ['income_q']);
    B.missing({ id: 'F2', dim: 'financial_trend', title: '最新报告期归母净利润同比' }, ['income_q']);
  }
  if (incA.length >= 2) {
    const [a, b] = incA;
    const g = yoy(a.operating_income, b.operating_income), p = yoy(a.parent_holder_net_profit, b.parent_holder_net_profit);
    if (p === null || g === null) B.missing({ id: 'F4', dim: 'financial_trend', title: `${a.fiscal_year} 年度营收 / 归母净利同比`, reason: '年报中营业收入或归母净利润字段为空，无法计算同比' }, ['income_a']);
    else B.add({
      id: 'F4', dim: 'financial_trend', title: `${a.fiscal_year} 年度营收 / 归母净利同比`, value: p, unit: '%', display: `营收 ${fmt.spct(g)} / 归母净利 ${fmt.spct(p)}`,
      detail: `营收 ${fmt.yi(a.operating_income)}，归母净利 ${fmt.yi(a.parent_holder_net_profit)}`, period: `${a.fiscal_year} 年报`, basis: '合并报表年度值',
      polarity: p >= 10 ? 'positive' : p < 0 ? 'negative' : 'neutral', rule: '以归母净利同比判定：≥10% 正面，<0 负面',
      calc: '年度值同比', drill: { type: 'financials', statement: 'income_a', field: 'parent_holder_net_profit' },
      sources: [srcOf(raw, 'income_a', ['operating_income', 'parent_holder_net_profit'])],
    });
    if (incA.length >= 4) {
      const old = incA[incA.length - 1], n = a.fiscal_year - old.fiscal_year;
      const cagr = isNum(old.operating_income) && old.operating_income > 0 && isNum(a.operating_income) && a.operating_income > 0 ? (Math.pow(a.operating_income / old.operating_income, 1 / n) - 1) * 100 : null;
      if (cagr !== null) B.add({
        id: 'F5', dim: 'financial_trend', title: `${old.fiscal_year}–${a.fiscal_year} 营收年复合增速`, value: cagr, unit: '%', display: fmt.spct(cagr),
        period: `${old.fiscal_year}–${a.fiscal_year} 年报`, basis: '年度营业收入 CAGR', polarity: cagr >= 10 ? 'positive' : cagr < 0 ? 'negative' : 'neutral',
        rule: 'CAGR ≥10% 正面，<0 负面', calc: '(末年/首年)^(1/年数) − 1', drill: { type: 'financials', statement: 'income_a', field: 'operating_income' },
        sources: [srcOf(raw, 'income_a', ['operating_income'])],
      });
      else B.missing({ id: 'F5', dim: 'financial_trend', title: '营收年复合增速', reason: '首年或末年营业收入字段为空/非正' }, ['income_a']);
    }
  } else B.missing({ id: 'F4', dim: 'financial_trend', title: '年度营收/利润同比' }, ['income_a']);

  // ===== 经营质量 =====
  if (latestA) {
    const gm = (it) => (isNum(it?.operating_income) && isNum(it?.operating_costs) && it.operating_income ? (1 - it.operating_costs / it.operating_income) * 100 : null);
    const g0 = gm(latestA), g1 = gm(incA[1]);
    if (g0 !== null) B.add({
      id: 'Q1', dim: 'operating_quality', title: `${latestA.fiscal_year} 年毛利率`, value: g0, unit: '%', display: fmt.pct(g0),
      detail: g1 !== null ? `上年 ${fmt.pct(g1)}，变化 ${(g0 - g1 > 0 ? '+' : '')}${(g0 - g1).toFixed(2)} pct` : '无上年对比',
      period: `${latestA.fiscal_year} 年报`, basis: '(营业收入 − 营业成本) / 营业收入，合并报表',
      polarity: g1 !== null && g0 - g1 < -3 ? 'negative' : g0 >= 60 ? 'positive' : 'neutral', rule: '较上年下降 >3pct 记负面；毛利率 ≥60% 记正面（高附加值）',
      calc: '1 − operating_costs / operating_income', drill: { type: 'financials', statement: 'income_a', field: 'operating_costs' },
      sources: [srcOf(raw, 'income_a', ['operating_income', 'operating_costs'])],
    });
    else B.missing({ id: 'Q1', dim: 'operating_quality', title: `${latestA.fiscal_year} 年毛利率`, reason: '营业收入或营业成本字段为空' }, ['income_a']);
    const rev = isNum(latestA.operating_income) && latestA.operating_income > 0 ? latestA.operating_income : null;
    const sr = rev && isNum(latestA.sales_fee) ? latestA.sales_fee / rev * 100 : null;
    const mr = rev && isNum(latestA.manage_fee) ? latestA.manage_fee / rev * 100 : null;
    const rr = rev && isNum(latestA.research_and_development_expenses) ? latestA.research_and_development_expenses / rev * 100 : null;
    if (rev === null || (rr === null && sr === null && mr === null)) B.missing({ id: 'Q2', dim: 'operating_quality', title: `${latestA.fiscal_year} 年费用结构`, reason: '营业收入或费用字段为空' }, ['income_a']);
    else B.add({
      id: 'Q2', dim: 'operating_quality', title: `${latestA.fiscal_year} 年费用结构`, value: rr, unit: '%',
      display: `研发 ${fmt.pct(rr, 1)} / 销售 ${fmt.pct(sr, 1)} / 管理 ${fmt.pct(mr, 1)}`, period: `${latestA.fiscal_year} 年报`,
      basis: '各项费用 / 营业收入', polarity: 'neutral', rule: '结构性信息，不做正负判定（研发投入高既是壁垒也是成本）',
      calc: 'research_and_development_expenses、sales_fee、manage_fee 分别除以 operating_income', drill: { type: 'financials', statement: 'income_a', field: 'research_and_development_expenses' },
      sources: [srcOf(raw, 'income_a', ['research_and_development_expenses', 'sales_fee', 'manage_fee', 'operating_income'])],
    });
    const cf = cashA.find((x) => x.fiscal_year === latestA.fiscal_year);
    // 单年现金流波动大（如含财务公司存贷款变动），以近 3 年合计判定
    const yrs = incA.slice(0, 3).map((a) => ({ a, c: cashA.find((x) => x.fiscal_year === a.fiscal_year) }))
      .filter((x) => x.c && isNum(x.c.act_cash_flow_net) && isNum(x.a.net_profit));
    if (cf && isNum(cf.act_cash_flow_net) && isNum(latestA.net_profit) && latestA.net_profit !== 0) {
      const ratio1 = cf.act_cash_flow_net / latestA.net_profit;
      const sumNp = yrs.reduce((t, x) => t + x.a.net_profit, 0);
      const ratio = yrs.length >= 2 && sumNp > 0 ? yrs.reduce((t, x) => t + x.c.act_cash_flow_net, 0) / sumNp : ratio1;
      const multi = yrs.length >= 2 && sumNp > 0;
      B.add({
        id: 'Q3', dim: 'operating_quality', title: multi ? `净利润现金含量（${yrs[yrs.length - 1].a.fiscal_year}–${latestA.fiscal_year} 合计）` : `${latestA.fiscal_year} 年净利润现金含量`, value: ratio, unit: '倍',
        display: multi ? `${fmt.x(ratio)}（${latestA.fiscal_year} 年单年 ${fmt.x(ratio1)}）` : fmt.x(ratio),
        detail: `${latestA.fiscal_year} 年：经营现金流净额 ${fmt.yi(cf.act_cash_flow_net)} / 净利润 ${fmt.yi(latestA.net_profit)}${multi ? `；近 ${yrs.length} 年合计：${fmt.yi(yrs.reduce((t, x) => t + x.c.act_cash_flow_net, 0))} / ${fmt.yi(sumNp)}` : ''}`,
        period: multi ? `${yrs[yrs.length - 1].a.fiscal_year}–${latestA.fiscal_year} 年报` : `${latestA.fiscal_year} 年报`,
        basis: '经营活动现金流量净额 / 净利润（均为合并口径）；以多年合计判定，避免单年波动', polarity: ratio >= 1 ? 'positive' : ratio < 0.8 ? 'negative' : 'neutral',
        rule: '多年合计 ≥1 倍正面（利润有现金支撑），<0.8 倍负面', calc: 'Σact_cash_flow_net / Σnet_profit',
        drill: { type: 'financials', statement: 'cash_a', field: 'act_cash_flow_net' },
        sources: [srcOf(raw, 'cash_a', ['act_cash_flow_net']), srcOf(raw, 'income_a', ['net_profit'])],
      });
    } else B.missing({ id: 'Q3', dim: 'operating_quality', title: '净利润现金含量' }, ['cash_a', 'income_a']);
    const bA = balA.find((x) => x.fiscal_year === latestA.fiscal_year);
    const indA = indicatorMap(raw.indicators_a) || (collected.report === `${latestA.fiscal_year}-4` ? indicatorMap(raw.indicators) : null);
    const roeOfficial = indA?.index_weighted_avg_roe;
    const approx = bA && isNum(bA.holder_equity_total) && bA.holder_equity_total > 0 && isNum(latestA.parent_holder_net_profit) ? latestA.parent_holder_net_profit / bA.holder_equity_total * 100 : null;
    if (isNum(roeOfficial) || isNum(approx)) {
      const roe = isNum(roeOfficial) ? roeOfficial : approx;
      B.add({
        id: 'Q4', dim: 'operating_quality', title: `${latestA.fiscal_year} 年 ROE${isNum(roeOfficial) ? '（加权平均）' : '（近似）'}`, value: roe, unit: '%', display: fmt.pct(roe),
        detail: isNum(roeOfficial) && isNum(approx) ? `财务指标接口加权平均 ROE；对照：归母净利 / 期末所有者权益 = ${fmt.pct(approx)}（期末口径偏低，属口径差异）` : '',
        period: `${latestA.fiscal_year} 年报`, basis: isNum(roeOfficial) ? '财务指标接口 index_weighted_avg_roe（加权平均净资产收益率）' : '归母净利润 / 期末所有者权益合计（含少数股东权益，非加权平均口径；指标接口不可用时的近似值）',
        polarity: roe >= 15 ? 'positive' : roe < 8 ? 'negative' : 'neutral', rule: '≥15% 正面，<8% 负面', calc: isNum(roeOfficial) ? '接口原值' : 'parent_holder_net_profit / holder_equity_total',
        drill: { type: 'financials', statement: 'balance_a', field: 'holder_equity_total' },
        sources: [...(isNum(roeOfficial) ? [srcOf(raw, raw.indicators_a ? 'indicators_a' : 'indicators', ['index_weighted_avg_roe'])] : []), srcOf(raw, 'income_a', ['parent_holder_net_profit']), srcOf(raw, 'balance_a', ['holder_equity_total'])],
      });
    } else B.missing({ id: 'Q4', dim: 'operating_quality', title: `${latestA.fiscal_year} 年 ROE（近似）`, reason: '归母净利润或期末所有者权益字段为空/非正' }, ['income_a', 'balance_a']);
  } else B.missing({ id: 'Q1', dim: 'operating_quality', title: '年度经营质量指标' }, ['income_a']);
  if (balQ[0] && isNum(balQ[0].assets_total) && balQ[0].assets_total > 0 && isNum(balQ[0].total_debt)) {
    const d = balQ[0].total_debt / balQ[0].assets_total * 100;
    B.add({
      id: 'Q5', dim: 'operating_quality', title: `${periodLabel(balQ[0])}资产负债率`, value: d, unit: '%', display: fmt.pct(d),
      detail: `负债 ${fmt.yi(balQ[0].total_debt)} / 资产 ${fmt.yi(balQ[0].assets_total)}；货币资金 ${fmt.yi(balQ[0].cash)}`, period: periodLabel(balQ[0]),
      basis: '负债合计 / 资产总计', polarity: d < 40 ? 'positive' : d > 70 ? 'negative' : 'neutral', rule: '<40% 正面，>70% 负面（金融类公司不适用此规则）',
      calc: 'total_debt / assets_total', drill: { type: 'financials', statement: 'balance_q', field: 'total_debt' },
      sources: [srcOf(raw, 'balance_q', ['total_debt', 'assets_total', 'cash'])],
    });
  } else B.missing({ id: 'Q5', dim: 'operating_quality', title: '资产负债率', reason: balQ[0] ? '负债合计或资产总计字段为空' : undefined }, ['balance_q']);
  // 应收账款增速 vs 营收增速
  if (balQ[0] && latest) {
    const bPrev = samePeriodLastYear(balQ, balQ[0]);
    const iPrev = samePeriodLastYear(incQ, latest);
    const arg = yoy(balQ[0].accounts_receivable, bPrev?.accounts_receivable);
    const rg = yoy(latest.operating_income, iPrev?.operating_income);
    if (arg !== null && rg !== null && balQ[0].fiscal_year === latest.fiscal_year && balQ[0].fiscal_period === latest.fiscal_period) {
      const gap = arg - rg;
      const arShare = isNum(balQ[0].accounts_receivable) && latest.operating_income > 0 ? balQ[0].accounts_receivable / latest.operating_income * 100 : null;
      const immaterial = isNum(arShare) && arShare < 5; // 应收规模很小时，增速不具参考意义
      B.add({
        id: 'Q6', dim: 'operating_quality', title: `${periodLabel(latest)}应收账款增速 vs 营收增速`, value: gap, unit: 'pct',
        display: `应收 ${fmt.spct(arg, 1)} vs 营收 ${fmt.spct(rg, 1)}`, detail: `应收账款余额 ${fmt.yi(balQ[0].accounts_receivable)}，占同期营收 ${fmt.pct(arShare, 1)}${immaterial ? '；应收规模很小，增速不具参考意义，不做正负判定' : ''}`, period: periodLabel(latest),
        basis: '期末应收账款余额同比 − 营业收入同比', polarity: immaterial ? 'neutral' : gap > 20 ? 'negative' : gap < 0 ? 'positive' : 'neutral',
        rule: '应收占营收 ≥5% 时：应收增速超出营收增速 >20pct 记负面（回款压力），低于营收增速记正面；应收占营收 <5% 时不判定', calc: 'yoy(accounts_receivable) − yoy(operating_income)',
        drill: { type: 'financials', statement: 'balance_q', field: 'accounts_receivable' },
        sources: [srcOf(raw, 'balance_q', ['accounts_receivable']), srcOf(raw, 'income_q', ['operating_income'])],
      });
    }
  }

  // ===== 交叉校验：报表计算值 vs 财务指标接口值（同一报告期） =====
  const ind = indicatorMap(raw.indicators);
  const conflicts = [];
  if (latest && ind && isNum(latest.operating_income) && isNum(latest.operating_costs)) {
    const calcGm = (1 - latest.operating_costs / latest.operating_income) * 100;
    const apiGm = ind.sale_gross_margin;
    if (isNum(apiGm)) {
      const diff = Math.abs(calcGm - apiGm);
      B.add({
        id: 'X1', dim: 'operating_quality', kind: diff > 1 ? 'conflict' : 'fact', title: `${periodLabel(latest)}毛利率双源校验`, value: diff, unit: 'pct',
        display: `报表计算 ${fmt.pct(calcGm)} vs 指标接口 ${fmt.pct(apiGm)}`, period: periodLabel(latest),
        basis: '同一报告期两个数据源的一致性检查', polarity: diff > 1 ? 'unknown' : 'neutral', status: diff > 1 ? 'conflict' : 'ok',
        rule: '差异 >1pct 视为数据冲突，相关结论降级为“待验证”', calc: '|1 − operating_costs/operating_income − sale_gross_margin|',
        sources: [srcOf(raw, 'income_q', ['operating_income', 'operating_costs']), srcOf(raw, 'indicators', ['sale_gross_margin'])],
      });
      if (diff > 1) conflicts.push('X1');
    }
  }
  if (ind) {
    const roe = ind.index_weighted_avg_roe;
    if (isNum(roe)) B.add({
      id: 'Q7', dim: 'operating_quality', title: `${reportLabel(collected.report)}加权 ROE（指标接口）`, value: roe, unit: '%', display: fmt.pct(roe),
      period: reportLabel(collected.report), basis: '财务指标接口 index_weighted_avg_roe；季报为报告期累计、未年化',
      polarity: /-4$/.test(collected.report) ? (roe >= 15 ? 'positive' : roe < 8 ? 'negative' : 'neutral') : 'neutral',
      rule: '仅年报期按 ≥15% 正面 / <8% 负面判定；季报期未年化，不做判定', calc: '接口原值',
      sources: [srcOf(raw, 'indicators', ['index_weighted_avg_roe'])],
    });
  } else B.missing({ id: 'Q7', dim: 'operating_quality', title: '财务指标（ROE/周转等）' }, ['indicators']);

  // 最近交易日（用于把“接口时点/抓取时间”对齐到交易日，避免周末日期被误读为当日数据）
  const kbEarly = bars(raw.kline);
  const lastTradeDate = kbEarly.length ? cnDate(kbEarly[kbEarly.length - 1].date_ms) : null;
  const tradeNote = (ms) => `${cnDate(ms)}${lastTradeDate && cnDate(ms) !== lastTradeDate ? `（最近交易日 ${lastTradeDate}）` : ''}`;

  // ===== 估值 =====
  const vals = items(raw.valuations);
  const vT = vals.find((v) => v.thscode === thscode);
  const vPeers = vals.filter((v) => v.thscode !== thscode);
  const peerTable = buildPeerTable(collected, incQ, latest);
  if (vT) {
    const metrics = [
      { k: 'pe_ttm', id: 'V1', name: '市盈率 PE(TTM)' },
      { k: 'pb_mrq', id: 'V2', name: '市净率 PB(MRQ)' },
      { k: 'ps_ttm', id: 'V3', name: '市销率 PS(TTM)' },
      { k: 'pcf_ttm', id: 'V4', name: '市现率 PCF(TTM)' },
    ];
    for (const m of metrics) {
      const v = vT[m.k];
      const bad = new Set(peerTable.rows.filter((r) => r.comparable === false).map((r) => r.thscode));
      const validPeers = vPeers.filter((p) => !bad.has(p.thscode) && p[m.k] > 0);
      const med = median(validPeers.map((p) => p[m.k]));
      const nPeer = validPeers.length;
      const spread = nPeer ? Math.max(...validPeers.map((p) => p[m.k])) / Math.min(...validPeers.map((p) => p[m.k])) : null;
      const tooFew = nPeer < 3, tooWide = !tooFew && spread > 5;
      if (!isNum(v)) { B.missing({ id: m.id, dim: 'valuation', title: m.name, reason: '估值接口返回 null（可能为亏损或数据未就绪）', sources: [srcOf(raw, 'valuations', [m.k])] }); continue; }
      const rel = med && v > 0 ? v / med : null;
      B.add({
        id: m.id, dim: 'valuation', title: m.name, value: v, unit: '倍', display: fmt.x(v),
        detail: rel !== null ? `同行中位数 ${fmt.x(med)}（${nPeer} 家${bad.size ? `，已剔除口径不可比的 ${peerTable.rows.filter((r) => r.comparable === false).map((r) => r.name).join('、')}` : ''}），为中位数的 ${rel.toFixed(2)} 倍${tooFew ? '；有效同行不足 3 家，不做相对判定' : tooWide ? `；同行最高/最低相差 ${spread.toFixed(1)} 倍，分化过大，不做相对判定` : ''}` : '同行数据不足',
        period: `估值快照，接口时点 ${tradeNote(raw.valuations.data_timestamp || raw.valuations.fetched_at)}`, basis: '扶摇估值快照原值；同行为人工同行池，仅取正值计算中位数',
        polarity: v <= 0 ? 'negative' : rel === null || tooFew || tooWide ? 'neutral' : rel > 1.3 ? 'negative' : rel < 0.8 ? 'positive' : 'neutral',
        rule: '有效同行 ≥3 家且最高/最低 ≤5 倍时：相对同行中位数 >1.3 倍记负面（估值偏高），<0.8 倍记正面；为负值时记负面（盈利/现金流为负）；否则不做相对判定',
        calc: `${m.k} / median(同行 ${m.k})`, drill: { type: 'peers', field: m.k },
        sources: [srcOf(raw, 'valuations', [m.k, 'name'])],
      });
    }
    const pg = B.get('F2')?.value;
    if (isNum(vT.pe_ttm) && isNum(pg) && pg > 0 && vT.pe_ttm > 0) {
      const peg = vT.pe_ttm / pg;
      B.add({
        id: 'V5', dim: 'valuation', kind: 'derived', title: 'PE / 利润增速（类 PEG）', value: peg, unit: '无量纲', display: `${fmt.num(peg)}（无量纲）`,
        detail: `PE(TTM) ${fmt.num(vT.pe_ttm)} 倍 ÷ 最新报告期归母净利同比 ${fmt.num(pg)}（百分数数值）`, period: '估值快照 × 最新报告期',
        basis: '派生指标：分母为单期同比增速，非多年预期增速，仅作粗略参照', polarity: peg < 1 ? 'positive' : peg > 2 ? 'negative' : 'neutral',
        rule: '<1 正面，>2 负面（口径粗糙，仅作辅助）', calc: 'V1 / F2', refs: ['V1', 'F2'],
        sources: [srcOf(raw, 'valuations', ['pe_ttm']), srcOf(raw, 'income_q', ['parent_holder_net_profit'])],
      });
    }
  } else {
    for (const [id, name] of [['V1', '市盈率 PE(TTM)'], ['V2', '市净率 PB(MRQ)']]) B.missing({ id, dim: 'valuation', title: name }, ['valuations']);
  }

  // ===== 行情特征 =====
  const kb = bars(raw.kline);
  if (kb.length >= 30) {
    const last = kb[kb.length - 1];
    const ageDays = Math.floor((now - last.date_ms) / DAY_MS);
    const stale = ageDays > 7; // 自然日；7 天以内的空档（周末、短假）不算过期
    const common = { dim: 'market', sources: [srcOf(raw, 'kline', ['close_price', 'date_ms'], '前复权日 K')], status: stale ? 'stale' : 'ok' };
    const staleNote = stale ? `（最新 K 线为 ${cnDate(last.date_ms)}，距今 ${ageDays} 天，数据可能过期；如遇长假休市属正常）` : '';
    const r250 = retOver(kb, Math.min(250, kb.length - 1)), r60 = retOver(kb, 60), r20 = retOver(kb, 20);
    B.add({
      ...common, id: 'M1', title: '区间涨跌幅（前复权）', value: r250, unit: '%', display: `近1年 ${fmt.spct(r250, 1)} / 近3月 ${fmt.spct(r60, 1)} / 近1月 ${fmt.spct(r20, 1)}`,
      detail: `最新收盘 ${last.close_price} 元（${cnDate(last.date_ms)}，前复权）${staleNote}`, period: `截至 ${cnDate(last.date_ms)}`, basis: '按交易日计：1年=250、3月=60、1月=20 个交易日',
      polarity: 'neutral', rule: '涨跌本身不做好坏判定，与基准对比见 M2', calc: 'close[t] / close[t−n] − 1', drill: { type: 'price', range: 250 },
    });
    const rel = [];
    for (const b of preset.benchmarks) {
      const bb = bars(raw[`bench:${b.thscode}`]);
      if (bb.length > 250) {
        const br = retOver(bb, 250);
        rel.push({ name: b.name, thscode: b.thscode, ret: br, excess: r250 - br });
      }
    }
    if (rel.length) {
      const e0 = rel[0].excess;
      B.add({
        ...common, id: 'M2', title: '近1年相对基准超额收益', value: e0, unit: 'pct', display: rel.map((r) => `vs ${r.name} ${e0 >= 0 && r === rel[0] ? '' : ''}${r.excess > 0 ? '+' : ''}${r.excess.toFixed(1)}pct`).join(' / '),
        detail: rel.map((r) => `${r.name}近1年 ${fmt.spct(r.ret, 1)}`).join('；'), period: `近 250 个交易日，截至 ${cnDate(last.date_ms)}`,
        basis: '个股前复权涨跌幅 − 指数涨跌幅（指数为价格指数，未含分红）', polarity: e0 > 10 ? 'positive' : e0 < -10 ? 'negative' : 'neutral',
        rule: `相对 ${rel[0].name} 超额 >10pct 记正面（相对强势），<−10pct 记负面`, calc: 'M1(1年) − 指数1年涨跌幅', drill: { type: 'price', range: 250, compare: true },
        sources: [...common.sources, ...rel.map((r) => srcOf(raw, `bench:${r.thscode}`, ['close_price']))], rel,
      });
    } else B.missing({ id: 'M2', dim: 'market', title: '相对基准超额收益' }, preset.benchmarks.map((b) => `bench:${b.thscode}`));
    const vol = volatility(kb);
    const mdd = maxDrawdown(kb);
    B.add({
      ...common, id: 'M3', title: '近1年波动与回撤', value: vol, unit: '%', display: `年化波动 ${fmt.pct(vol, 1)} / 最大回撤 ${fmt.pct(mdd?.mdd, 1)}`,
      detail: mdd ? `最大回撤区间 ${cnDate(mdd.peakDate)} → ${cnDate(mdd.troughDate)}` : '', period: `近 250 个交易日`,
      basis: '日对数收益标准差 × √252；回撤按收盘价计算', polarity: vol > 50 || (mdd && mdd.mdd < -35) ? 'negative' : vol < 25 ? 'positive' : 'neutral',
      rule: '年化波动 >50% 或最大回撤 >35% 记负面（波动风险高），波动 <25% 记正面', calc: 'std(ln(Pt/Pt−1))·√252；min(P/峰值 − 1)',
      drill: { type: 'price', range: 250, highlight: mdd ? [mdd.peakDate, mdd.troughDate] : null },
    });
    const w = kb.slice(-250);
    const hi = Math.max(...w.map((b) => b.high_price ?? b.close_price)), lo = Math.min(...w.map((b) => b.low_price ?? b.close_price));
    const pos = hi > lo ? (last.close_price - lo) / (hi - lo) * 100 : null;
    const avg = (arr) => arr.reduce((x, y) => x + y, 0) / arr.length;
    const tv20 = kb.slice(-20).map((b) => b.turnover).filter(isNum), tv120 = kb.slice(-120).map((b) => b.turnover).filter(isNum);
    const tvOk = tv20.length >= 15 && tv120.length >= 90; // 成交额缺失过多时不计算活跃度比值
    const t20 = tvOk ? avg(tv20) : null, t120 = tvOk ? avg(tv120) : null;
    B.add({
      ...common, id: 'M4', title: '价格位置与成交活跃度', value: pos, unit: '%', display: `52周区间位置 ${fmt.pct(pos, 0)} / ${tvOk ? `近20日日均成交额为近120日的 ${(t20 / t120).toFixed(2)} 倍` : '成交额数据缺失，活跃度不计算'}`,
      detail: `52周最高 ${hi.toFixed(2)} 元、最低 ${lo.toFixed(2)} 元（前复权，按日内最高/最低价）；${tvOk ? `近20日日均成交额 ${fmt.yi(t20)}（有效样本 ${tv20.length}/${tv120.length} 日）` : `成交额有效样本不足（近20日 ${tv20.length} 日、近120日 ${tv120.length} 日）`}`, period: `截至 ${cnDate(last.date_ms)}`,
      sources: [srcOf(raw, 'kline', ['close_price', 'high_price', 'low_price', 'turnover', 'date_ms'], '前复权日 K')],
      basis: '位置 = (现价 − 区间最低) / (区间最高 − 区间最低)', polarity: 'neutral', rule: '描述性信息，不做正负判定',
      calc: '(close − low52) / (high52 − low52)；mean(turnover,20) / mean(turnover,120)', drill: { type: 'price', range: 250 },
    });
  } else {
    B.missing({ id: 'M1', dim: 'market', title: '行情特征（K线）', reason: kb.length ? `K 线样本不足（${kb.length} 根）` : undefined }, ['kline']);
  }

  // ===== 行业位置 =====
  if (peerTable.rows.length >= 2) {
    const rank = (field, desc = true) => {
      // 口径不可比的同行只从依赖“营收”字段的排名中剔除（净利润本身可比，保留）
      const revenueBased = true; // 口径不可比的同行（业务模式不同）不参与任何排名
      const rows = peerTable.rows.filter((r) => isNum(r[field]) && (!revenueBased || r.comparable !== false));
      const sorted = [...rows].sort((a, b) => (desc ? b[field] - a[field] : a[field] - b[field]));
      const idx = sorted.findIndex((r) => r.thscode === thscode);
      const dropped = revenueBased ? peerTable.rows.filter((r) => r.comparable === false).map((r) => r.name) : [];
      return idx >= 0 ? { rank: idx + 1, n: sorted.length, value: sorted[idx][field], dropped } : null;
    };
    const defs = [
      { id: 'I1', field: 'revenue', title: '营收规模排名', show: (v) => fmt.yi(v) },
      { id: 'I2', field: 'net_profit', title: '归母净利润排名', show: (v) => fmt.yi(v) },
      { id: 'I3', field: 'net_margin', title: '归母净利率排名', show: (v) => fmt.pct(v, 1) },
      { id: 'I4', field: 'revenue_yoy', title: '营收同比排名', show: (v) => fmt.spct(v, 1) },
    ];
    for (const d of defs) {
      const r = rank(d.field);
      if (!r) { B.missing({ id: d.id, dim: 'industry', title: d.title, reason: '目标公司该字段为空，无法排名' }, ['income_q']); continue; }
      B.add({
        id: d.id, dim: 'industry', title: `${d.title}（${peerTable.period}）`, value: r.rank, unit: '名', display: `第 ${r.rank} / ${r.n}（${d.show(r.value)}）`,
        period: peerTable.period, basis: `人工同行池：${preset.peers.map((p) => p.name).join('、')}；仅比较同一报告期${r.dropped.length ? `；本项已剔除口径不可比的同行：${r.dropped.join('、')}（见 X2），排名不完整` : ''}`,
        polarity: r.dropped.length || peerTable.excluded.length ? 'neutral' : r.n >= 3 && r.rank === 1 ? 'positive' : r.n >= 3 && r.rank === r.n ? 'negative' : 'neutral',
        rule: r.dropped.length || peerTable.excluded.length ? `同行不完整（${[...r.dropped, ...peerTable.excluded.map((x) => x.name)].join('、')} 未参与），不做正负判定` : '同行中第 1 记正面，末位记负面（同行 ≥3 家时）',
        calc: `按 ${d.field} 降序排名`, drill: { type: 'peers', field: d.field },
        sources: [srcOf(raw, 'income_q', ['operating_income', 'parent_holder_net_profit']), ...preset.peers.map((p) => srcOf(raw, `peer_income:${p.thscode}`, ['operating_income', 'parent_holder_net_profit']))],
      });
    }
    const bad = peerTable.rows.filter((x) => x.comparable === false);
    if (bad.length) {
      B.add({
        id: 'X2', dim: 'industry', kind: 'conflict', status: 'conflict', polarity: 'unknown', title: '同行财务口径冲突',
        value: bad.length, unit: '家', display: bad.map((x) => `${x.name}：${x.conflict_reason}`).join('；'), period: peerTable.period,
        basis: '合理性检查：归母净利率应在 −100%~100% 之间，且盈利时归母净利润不应大于营业收入；不满足说明该公司的 operating_income 字段口径与其他同行不可比（如券商的手续费、利息收入不计入）',
        rule: '口径冲突的同行（业务模式与报表口径不可比）不参与任何同行排名（I1–I4）与估值中位数（V1–V4），并列为待验证问题', calc: 'parent_holder_net_profit / operating_income',
        drill: { type: 'peers', field: 'net_margin' },
        sources: bad.map((x) => srcOf(raw, `peer_income:${x.thscode}`, ['operating_income', 'parent_holder_net_profit'])),
      });
      conflicts.push('X2');
    }
    if (peerTable.excluded.length) {
      B.missing({ id: 'I9', dim: 'industry', title: '部分同行未纳入对比', reason: peerTable.excluded.map((e) => `${e.name}：${e.reason}`).join('；'), sources: peerTable.excluded.map((e) => srcOf(raw, `peer_income:${e.thscode}`, [])) });
    }
  } else B.missing({ id: 'I1', dim: 'industry', title: '同行对比', reason: '可比同行数据不足（<2 家）' }, preset.peers.map((p) => `peer_income:${p.thscode}`));

  // ===== 经营驱动（按公司类型）：市场活跃度 =====
  if (preset.drivers.includes('market_activity')) buildMarketDriver(B, raw, incQ, cumulative, now);

  // ===== 重要事件 =====
  if (latest) B.add({
    id: 'E1', dim: 'events', title: '最近一次定期报告', value: latest.report_date_ms, unit: '', display: `${periodLabel(latest)}，披露日 ${cnDate(latest.report_date_ms)}`,
    period: periodLabel(latest), basis: '利润表 report_date_ms', polarity: 'neutral', rule: '事件记录', calc: '接口原值',
    sources: [srcOf(raw, 'income_q', ['report_date_ms', 'period_end_ms'])],
  });
  const ca = items(raw.corp_actions);
  if (raw.corp_actions?.ok) {
    const byYear = {};
    for (const c of ca) {
      if (!(isNum(c.dividend_per_share) && c.dividend_per_share > 0)) continue; // 只送股/无现金分红的事件不计入
      const y = cnDate(c.ex_date_ms).slice(0, 4); byYear[y] = (byYear[y] || 0) + c.dividend_per_share;
    }
    const years = Object.keys(byYear).sort().reverse();
    B.add({
      id: 'E2', dim: 'events', title: '近5年现金分红（按除权日）', value: years.length, unit: '年', display: years.length ? years.map((y) => `${y}: ${byYear[y].toFixed(3)} 元/股`).join('；') : '近5年无分红记录',
      period: '近 5 年', basis: '复权事件流 dividend_per_share（税前，元/股），按除权日年份汇总', polarity: years.length >= 3 ? 'positive' : years.length === 0 ? 'negative' : 'neutral',
      rule: '近5年 ≥3 年有现金分红（每股派现 >0）记正面，无分红记负面', calc: 'Σ dividend_per_share(>0) by year(ex_date_ms)', events: ca.slice(0, 10),
      sources: [srcOf(raw, 'corp_actions', ['ex_date_ms', 'dividend_per_share', 'per_share_bonus'])],
    });
  } else B.missing({ id: 'E2', dim: 'events', title: '分红送转事件' }, ['corp_actions']);
  if (raw.anomaly?.ok) {
    const a = items(raw.anomaly)[0];
    if (a) B.add({
      id: 'E3', dim: 'events', kind: 'opinion', title: `当日异动：${a.tag_name || ''}`, value: null, unit: '', display: a.analysis_content,
      detail: a.keyword_list?.length ? `关键词：${a.keyword_list.join('、')}` : '', period: tradeNote(raw.anomaly.data_timestamp || raw.anomaly.fetched_at),
      basis: '同花顺异动原因解析（第三方解读文本，属观点而非事实，需回到公告/新闻原文验证）', polarity: 'neutral', rule: '观点类信息，不参与正负判定',
      calc: '接口原文', sources: [srcOf(raw, 'anomaly', ['analysis_content', 'keyword_list', 'tag_name'])],
    });
    else B.add({ id: 'E3', dim: 'events', title: '当日异动', value: null, display: `接口当日快照无异动记录（查询于 ${cnDate(raw.anomaly.fetched_at)}${lastTradeDate ? `，最近交易日 ${lastTradeDate}` : ''}）`, period: tradeNote(raw.anomaly.data_timestamp || raw.anomaly.fetched_at), basis: '异动原因接口返回空列表', polarity: 'neutral', rule: '事件记录', calc: '—', sources: [srcOf(raw, 'anomaly', [])] });
  } else B.missing({ id: 'E3', dim: 'events', title: '当日异动原因' }, ['anomaly']);
  const hr = items(raw.hot_rank).filter((x) => isNum(x.rank));
  if (hr.length) {
    const best = Math.min(...hr.map((x) => x.rank)), lastR = hr[hr.length - 1];
    const avgR = hr.reduce((s, x) => s + x.rank, 0) / hr.length;
    B.add({
      id: 'E4', dim: 'events', title: '近90天同花顺热榜排名', value: lastR.rank, unit: '名', display: `最新 ${lastR.rank} 名（${lastR.date}）/ 区间最好 ${best} 名 / 均值 ${avgR.toFixed(0)} 名`,
      period: `${hr[0].date} ~ ${lastR.date}`, basis: '同花顺热榜（关注度指标，反映情绪而非基本面）', polarity: 'neutral', rule: '情绪类信息，不参与正负判定',
      calc: 'min / last / mean(rank)', series: hr.map((x) => ({ date: x.date, rank: x.rank })), drill: { type: 'hot_rank' },
      sources: [srcOf(raw, 'hot_rank', ['rank', 'date'])],
    });
  } else B.missing({ id: 'E4', dim: 'events', title: '热榜排名走势' }, ['hot_rank']);
  // 已知数据盲区（不是调用失败，而是当前数据源不提供）
  B.missing({ id: 'E9', dim: 'events', title: '公告 / 新闻 / 研报原文', reason: '未接入：扶摇“资讯事件库”仅在同花顺 AI 客户端内提供；iFinD MCP 可提供公告/新闻，但需要 iFinD 账号授权，本次未取得。近期公告、监管或业务事件无法从原文核验', how: '在巨潮资讯网（cninfo.com.cn）检索该公司近 3 个月公告；或接入 iFinD MCP 的公告/新闻工具', unavailable: 'not_integrated', sources: [] });

  // ===== 衍生：矛盾、风险、待验证 =====
  // 必出清单：每个维度预先声明会产出的证据；因前提不满足或上游失败而没算出来的，一律进入“未知”，不允许静默消失
  const EXPECTED = {
    F1: ['financial_trend', '最新报告期营业收入同比'], F2: ['financial_trend', '最新报告期归母净利润同比'], F3: ['financial_trend', '归母净利润单季同比增速变化'],
    F4: ['financial_trend', '年度营收 / 归母净利同比'], F5: ['financial_trend', '营收年复合增速'], F6: ['financial_trend', '营业收入单季同比增速变化'],
    Q1: ['operating_quality', '年度毛利率'], Q2: ['operating_quality', '年度费用结构'], Q3: ['operating_quality', '净利润现金含量'], Q4: ['operating_quality', '年度 ROE'],
    Q5: ['operating_quality', '资产负债率'], Q6: ['operating_quality', '应收账款增速 vs 营收增速'], Q7: ['operating_quality', '加权 ROE（最新报告期）'],
    V1: ['valuation', '市盈率 PE(TTM)'], V2: ['valuation', '市净率 PB(MRQ)'], V3: ['valuation', '市销率 PS(TTM)'], V4: ['valuation', '市现率 PCF(TTM)'], V5: ['valuation', 'PE / 利润增速（类 PEG）'],
    M1: ['market', '区间涨跌幅'], M2: ['market', '近1年相对基准超额收益'], M3: ['market', '近1年波动与回撤'], M4: ['market', '价格位置与成交活跃度'],
    I1: ['industry', '营收规模排名'], I2: ['industry', '归母净利润排名'], I3: ['industry', '归母净利率排名'], I4: ['industry', '营收同比排名'],
    E1: ['events', '最近一次定期报告'], E2: ['events', '近5年现金分红'], E3: ['events', '异动原因'], E4: ['events', '热榜排名走势'],
    ...(preset.drivers.includes('market_activity') ? { D1: ['driver', '营收同比 vs 两市成交额同比的相关性'], D2: ['driver', '最新报告期后至今两市成交额同比'] } : {}),
  };
  for (const [id, [dim, title]] of Object.entries(EXPECTED)) {
    if (B.get(id)) continue;
    if (id === 'V5' && B.get('V1') && B.get('F2')?.status === 'ok' && !(B.get('F2').value > 0)) {
      B.missing({ id, dim, title, reason: '最新报告期归母净利同比 ≤0，类 PEG 不适用', na: true, sources: [] });
    } else B.missing({ id, dim, title, reason: '前提不满足或上游数据不可用，未能计算（详见工具调用记录）', sources: [] });
  }

  const profile = profileCompany(B, incA, preset);
  if (profile.type === '金融/类金融') {
    const q5 = B.get('Q5');
    if (q5 && q5.status === 'ok') { q5.polarity = 'neutral'; q5.rule += '；公司画像为金融/类金融，高负债是业务属性，本规则不适用，记中性'; }
  }
  const contradictions = findContradictions(B);
  const { risks, checks: riskChecks } = findRisks(B, collected);
  const openQuestions = buildOpenQuestions(B, collected, conflicts);

  return {
    thscode, name: vT?.name || preset.name, preset: { name: preset.name, board: preset.board, industry_label: preset.industry_label, peers: preset.peers, peer_rule: preset.peer_rule, benchmarks: preset.benchmarks },
    report: collected.report, quarterly_basis: { cumulative: cumulative.value, basis: cumulative.basis, label: qBasis },
    evidence: B.list, contradictions, risks, risk_checks: riskChecks, open_questions: openQuestions, profile, peer_table: peerTable,
    circuit: collected.circuit || null,
    last_trade_date: lastTradeDate,
    series: {
      kline: kb.slice(-750).map((b) => [b.date_ms, b.close_price, b.turnover]),
      kline_tail: kb.slice(-20).map((b) => ({ date_ms: b.date_ms, open: b.open_price, high: b.high_price, low: b.low_price, close: b.close_price, volume: b.volume, turnover: b.turnover })),
      benchmarks: preset.benchmarks.map((b) => ({ ...b, bars: bars(raw[`bench:${b.thscode}`]).slice(-750).map((x) => [x.date_ms, x.close_price]) })),
      income_q: incQ, income_a: incA, balance_q: balQ, balance_a: balA, cash_a: cashA, cash_q: items(raw.cash_q),
      indicators: raw.indicators?.ok ? raw.indicators.data : null,
    },
    calls: collected.calls,
    stats: summarize(B.list, collected.calls),
  };
}

function indicatorMap(r) {
  if (!r?.ok || !r.data?.abilities) return null;
  const m = {};
  for (const a of r.data.abilities) for (const i of a.indicators || []) m[i.index_id] = i.value === null ? null : Number(i.value);
  return m;
}

function buildPeerTable(collected, incQ, latest) {
  const { raw, preset, thscode } = collected;
  const rows = [], excluded = [];
  const vals = items(raw.valuations);
  const target = latest;
  const period = target ? periodLabel(target) : '--';
  const mk = (code, name, list, key) => {
    const it = target ? list.find((x) => x.fiscal_year === target.fiscal_year && x.fiscal_period === target.fiscal_period) : null;
    if (!it) { excluded.push({ thscode: code, name, reason: raw[key]?.ok ? `未找到与目标公司相同的报告期（${period}）` : (raw[key]?.message || '数据不可用') }); return; }
    const prev = samePeriodLastYear(list, it);
    const v = vals.find((x) => x.thscode === code) || {};
    rows.push({
      thscode: code, name, revenue: it.operating_income, net_profit: it.parent_holder_net_profit,
      net_margin: isNum(it.parent_holder_net_profit) && it.operating_income ? it.parent_holder_net_profit / it.operating_income * 100 : null,
      revenue_yoy: yoy(it.operating_income, prev?.operating_income), profit_yoy: yoy(it.parent_holder_net_profit, prev?.parent_holder_net_profit),
      pe_ttm: v.pe_ttm ?? null, pb_mrq: v.pb_mrq ?? null, ps_ttm: v.ps_ttm ?? null, pcf_ttm: v.pcf_ttm ?? null,
      roe: indicatorMap(raw[code === thscode ? 'indicators' : `peer_ind:${code}`])?.index_weighted_avg_roe ?? null,
      is_target: code === thscode,
    });
    const row = rows[rows.length - 1];
    const nm = row.net_margin;
    if (isNum(nm) && (nm > 100 || nm < -100 || (row.revenue > 0 && row.net_profit > row.revenue))) {
      row.comparable = false;
      row.conflict_reason = `归母净利 ${fmt.yi(row.net_profit)} / 营收 ${fmt.yi(row.revenue)}，净利率 ${nm.toFixed(1)}%，营收字段口径与同行不可比`;
    }
  };
  mk(thscode, preset.name, incQ, 'income_q');
  for (const p of preset.peers) mk(p.thscode, p.name, items(raw[`peer_income:${p.thscode}`]), `peer_income:${p.thscode}`);
  return { period, rows, excluded, rule: preset.peer_rule };
}

function buildMarketDriver(B, raw, incQ, cumulative, now) {
  const mkt = MARKET_TURNOVER_INDEXES.map((m) => bars(raw[`mkt:${m.thscode}`]));
  if (mkt.some((x) => x.length < 200)) {
    B.missing({ id: 'D1', dim: 'driver', title: '收入 vs 两市成交额（市场活跃度驱动）' }, MARKET_TURNOVER_INDEXES.map((m) => `mkt:${m.thscode}`));
    return;
  }
  // 只使用所有指数当日成交额都有效的交易日；任一交易所缺失过多则不计算（避免只用单边市场冒充“两市”）
  const perIdx = mkt.map((s) => new Map(s.filter((b) => isNum(b.turnover)).map((b) => [b.date_ms, b.turnover])));
  const allDates = new Set(mkt.flatMap((s) => s.map((b) => b.date_ms)));
  const daily = new Map();
  for (const d of allDates) if (perIdx.every((m) => m.has(d))) daily.set(d, perIdx.reduce((x, m) => x + m.get(d), 0));
  if (daily.size < allDates.size * 0.9) {
    B.missing({ id: 'D1', dim: 'driver', title: '收入 vs 两市成交额（市场活跃度驱动）', reason: `两市成交额有效交易日不足（${daily.size}/${allDates.size}），任一交易所成交额缺失时不计算`, sources: MARKET_TURNOVER_INDEXES.map((m) => srcOf(raw, `mkt:${m.thscode}`, ['turnover'])) });
    return;
  }
  const minDay = Math.min(...daily.keys());
  const sumRange = (a, b) => { let s = 0; for (const [d, v] of daily) if (d >= a && d <= b) s += v; return s; };
  const qStart = (it) => {
    const y = it.fiscal_year, q = { Q1: 1, Q2: 2, Q3: 3, Q4: 4, FY: 4 }[it.fiscal_period];
    return cumulative.value ? Date.parse(`${y}-01-01T00:00:00+08:00`) : Date.parse(`${y}-${String((q - 1) * 3 + 1).padStart(2, '0')}-01T00:00:00+08:00`);
  };
  // 单季口径：营收单季同比 vs 同一季度两市成交额同比（各点互不重叠，样本独立）
  const qWin = (y, q) => [Date.parse(`${y}-${String((q - 1) * 3 + 1).padStart(2, '0')}-01T00:00:00+08:00`), Date.parse(`${q === 4 ? y + 1 : y}-${String(q === 4 ? 1 : q * 3 + 1).padStart(2, '0')}-01T00:00:00+08:00`) - 1];
  const sqPts = [];
  for (const x of sqYoySeries(incQ, 'operating_income', cumulative.value, incQ.length)) {
    const [s0, e0] = qWin(x.it.fiscal_year, x.q), [s1, e1] = qWin(x.it.fiscal_year - 1, x.q);
    if (s1 < minDay - 10 * DAY_MS) continue; // 去年同季区间不完整（允许起点前的节假日空档）
    const m = yoy(sumRange(s0, e0), sumRange(s1, e1));
    if (isNum(m)) sqPts.push({ period: x.period, market_yoy: m, revenue_yoy: x.yoy });
  }
  const pts = [];
  for (const it of incQ) {
    const prev = samePeriodLastYear(incQ, it);
    if (!prev) continue;
    const s0 = qStart(it), e0 = it.period_end_ms + DAY_MS - 1, s1 = qStart(prev), e1 = prev.period_end_ms + DAY_MS - 1;
    if (s1 < minDay - 10 * DAY_MS) continue; // 去年同期区间不完整（允许起点前的节假日空档）
    const m = yoy(sumRange(s0, e0), sumRange(s1, e1));
    const r = yoy(it.operating_income, prev.operating_income);
    if (isNum(m) && isNum(r)) pts.push({ period: periodLabel(it), market_yoy: m, revenue_yoy: r });
  }
  const pearson = (arr) => {
    const xs = arr.map((p) => p.market_yoy), ys = arr.map((p) => p.revenue_yoy);
    const mx = xs.reduce((a, b) => a + b) / xs.length, my = ys.reduce((a, b) => a + b) / ys.length;
    const cov = xs.reduce((t, x, i) => t + (x - mx) * (ys[i] - my), 0);
    return cov / Math.sqrt(xs.reduce((t, x) => t + (x - mx) ** 2, 0) * ys.reduce((t, y) => t + (y - my) ** 2, 0));
  };
  const useSq = sqPts.length >= 6;
  if (useSq) {
    const corr = pearson(sqPts);
    const corrCum = pts.length >= 3 ? pearson(pts) : null;
    B.add({
      id: 'D1', dim: 'driver', kind: 'derived', title: '营收单季同比 vs 两市成交额同比的相关性', value: corr, unit: '无量纲', display: `相关系数 ${corr.toFixed(2)}（${sqPts.length} 个季度，单季口径）`,
      detail: `${sqPts.map((p) => `${p.period}: 成交额 ${fmt.spct(p.market_yoy, 0)} / 营收 ${fmt.spct(p.revenue_yoy, 0)}`).join('；')}${corrCum !== null ? `；对照：年初累计口径 r=${corrCum.toFixed(2)}（${pts.length} 个报告期，区间重叠、样本不独立）` : ''}`,
      period: `${sqPts[sqPts.length - 1].period} ~ ${sqPts[0].period}`,
      basis: '两市成交额 = 上证指数（全部沪市）+ 深证综指（全部深市）日成交额之和，按自然季度与单季营收对齐；样本有限，相关不代表因果',
      polarity: 'neutral', rule: '描述性：r ≥0.6 视为强正相关，提示业绩对市场活跃度敏感', calc: 'Pearson(两市成交额单季同比, 营收单季同比)', series: sqPts,
      drill: { type: 'driver' }, sources: [srcOf(raw, 'income_q', ['operating_income', 'fiscal_period']), ...MARKET_TURNOVER_INDEXES.map((m) => srcOf(raw, `mkt:${m.thscode}`, ['turnover', 'date_ms']))],
    });
  } else if (pts.length < 3) {
    B.missing({ id: 'D1', dim: 'driver', title: '收入 vs 两市成交额（市场活跃度驱动）', reason: `可配对的报告期不足（${pts.length} 个，需 ≥3）`, sources: [srcOf(raw, 'income_q', []), ...MARKET_TURNOVER_INDEXES.map((m) => srcOf(raw, `mkt:${m.thscode}`, ['turnover']))] });
  } else {
    const xs = pts.map((p) => p.market_yoy), ys = pts.map((p) => p.revenue_yoy);
    const mx = xs.reduce((a, b) => a + b) / xs.length, my = ys.reduce((a, b) => a + b) / ys.length;
    const cov = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0);
    const corr = cov / Math.sqrt(xs.reduce((s, x) => s + (x - mx) ** 2, 0) * ys.reduce((s, y) => s + (y - my) ** 2, 0));
    B.add({
      id: 'D1', dim: 'driver', kind: 'derived', title: '营收同比 vs 两市成交额同比的相关性', value: corr, unit: '无量纲', display: `相关系数 ${corr.toFixed(2)}（${pts.length} 个报告期）`,
      detail: pts.map((p) => `${p.period}: 成交额 ${fmt.spct(p.market_yoy, 0)} / 营收 ${fmt.spct(p.revenue_yoy, 0)}`).join('；'), period: `${pts[pts.length - 1].period} ~ ${pts[0].period}`,
      basis: `两市成交额 = 上证指数（全部沪市）+ 深证综指（全部深市）日成交额之和，区间与报告期对齐（${cumulative.value ? '年初至期末' : '单季'}）；样本少，相关不代表因果`,
      polarity: 'neutral', rule: '描述性：|r| ≥0.6 视为强相关，提示业绩对市场活跃度敏感', calc: 'Pearson(两市成交额同比, 营收同比)', series: pts,
      drill: { type: 'driver' }, sources: [srcOf(raw, 'income_q', ['operating_income']), ...MARKET_TURNOVER_INDEXES.map((m) => srcOf(raw, `mkt:${m.thscode}`, ['turnover', 'date_ms']))],
    });
  }
  // 最新报告期之后至今的两市成交额（领先信号，事实层）
  const latest = incQ[0];
  if (latest) {
    const lastDay = Math.max(...daily.keys());
    const s = latest.period_end_ms + DAY_MS, e = Math.min(now, lastDay);
    const lastYearS = s - 365 * DAY_MS, lastYearE = e - 365 * DAY_MS;
    if (lastYearS >= minDay) {
      const cur = sumRange(s, e), prev = sumRange(lastYearS, lastYearE);
      const g = yoy(cur, prev);
      if (isNum(g) && cur > 0) B.add({
        id: 'D2', dim: 'driver', title: '最新报告期后至今两市成交额同比', value: g, unit: '%', display: fmt.spct(g, 1),
        detail: `${cnDate(s)} 至 ${cnDate(e)} 累计 ${(cur / 1e12).toFixed(2)} 万亿元，上年同期 ${(prev / 1e12).toFixed(2)} 万亿元`, period: `${cnDate(s)} ~ ${cnDate(e)}`,
        basis: '两市成交额 = 上证指数（全部沪市）+ 深证综指（全部深市）成交额；与上年同一自然日区间对比', polarity: g > 10 ? 'positive' : g < -10 ? 'negative' : 'neutral',
        rule: '>+10% 正面、<−10% 负面（仅指市场环境，对公司业绩的传导需等待下一期财报验证）', calc: 'Σturnover(区间) / Σturnover(上年同期) − 1',
        drill: { type: 'driver' }, sources: MARKET_TURNOVER_INDEXES.map((m) => srcOf(raw, `mkt:${m.thscode}`, ['turnover', 'date_ms'])),
      });
    }
  }
}

function findContradictions(B) {
  const g = (id) => B.get(id);
  const out = [];
  const valid = (id) => ['ok', 'stale'].includes(g(id)?.status);
  const pos = (id) => valid(id) && g(id)?.polarity === 'positive';
  const neg = (id) => valid(id) && g(id)?.polarity === 'negative';
  if (pos('F2') && neg('V1')) out.push({ id: 'C1', title: '利润高增长 vs 估值高于同行', refs: ['F2', 'V1'], explain: '增长可以部分解释更高的估值水平，但更高的估值也意味着对增长持续性的要求更高；两者需要放在一起看。' });
  if ((pos('F2') || pos('F4')) && neg('Q3')) out.push({ id: 'C2', title: '利润增长 vs 现金含量偏低', refs: [pos('F2') ? 'F2' : 'F4', 'Q3'], explain: '账面利润增长但经营现金流未同步，需要核查回款与收入确认节奏。' });
  if (pos('F1') && neg('Q1')) out.push({ id: 'C3', title: '收入增长 vs 毛利率下滑', refs: ['F1', 'Q1'], explain: '增收但毛利率下降，可能是产品结构或成本端变化。' });
  if (pos('M2') && (neg('F2') || neg('F4'))) out.push({ id: 'C4', title: '股价相对强势 vs 利润下滑', refs: ['M2', neg('F2') ? 'F2' : 'F4'], explain: '市场表现与最新基本面方向不一致，可能反映预期或情绪因素。' });
  if (neg('M2') && pos('F2')) out.push({ id: 'C5', title: '利润增长 vs 股价相对弱势', refs: ['F2', 'M2'], explain: '基本面改善尚未体现在相对表现上，原因无法从现有数据判断。' });
  const f2 = g('F2'), f4 = g('F4');
  if (f2?.status === 'ok' && f4?.status === 'ok' && isNum(f2.value) && isNum(f4.value) && Math.sign(f2.value) !== Math.sign(f4.value)) {
    out.push({ id: 'C6', title: '最新报告期与上一年度利润方向相反', refs: ['F2', 'F4'], explain: '短期趋势与年度趋势方向不一致，判断“改善/恶化”时需区分时间窗口。' });
  }
  if (pos('F2') && neg('F3')) out.push({ id: 'C8', title: '利润仍高增长 vs 增速边际放缓', refs: ['F2', 'F3'], explain: '同比仍是高增长，但较上一期明显减速；“改善”与“走弱”取决于看水平还是看边际变化。' });
  const vPos = ['V1', 'V2', 'V3', 'V4'].filter(pos), vNeg = ['V1', 'V2', 'V3', 'V4'].filter(neg);
  if (vPos.length && vNeg.length) out.push({ id: 'C9', title: '不同估值口径给出相反信号', refs: [...vPos, ...vNeg], explain: '相对同行，部分估值指标偏低、部分偏高；单看任一指标都会得出片面结论，需要结合盈利能力（高 ROE 往往对应高 PB）理解。' });
  if (pos('F6') && neg('F3')) out.push({ id: 'C12', title: '单季收入加速 vs 单季利润减速', refs: ['F6', 'F3'], explain: '单季营收同比在加速，单季利润同比却在放缓，差异可能来自成本或费用端，需结合费用结构（Q2）与下一期财报验证。' });
  if (neg('F6') && pos('F3')) out.push({ id: 'C13', title: '单季利润加速 vs 单季收入减速', refs: ['F3', 'F6'], explain: '利润增速提升但收入增速回落，可能来自费用控制或一次性因素，持续性需验证。' });
  if (neg('D2') && pos('F2')) out.push({ id: 'C10', title: '已披露利润高增 vs 报告期后市场活跃度回落', refs: ['F2', 'D2'], explain: '财报反映的是过去；报告期后的市场环境走弱尚未被财报验证。' });
  if (pos('D2') && neg('F2')) out.push({ id: 'C7', title: '市场活跃度回升 vs 已披露利润下滑', refs: ['D2', 'F2'], explain: '已披露财报反映的是过去，报告期后的市场环境变化尚未被财报验证。' });
  // 引用了过期/快照证据的矛盾：标题注明
  for (const c of out) if (c.refs.some((id) => g(id)?.status === 'stale')) { c.title += '（基于快照/过期数据）'; c.stale = true; }
  return out;
}

function findRisks(B, collected) {
  // 风险规则清单：全部规则都会被检查，已触发的进入 risks，未触发的也保留（页面可展开），避免“风险为空”被误读为“没有检查”
  const g = (id) => B.get(id);
  const valid = (id) => ['ok', 'stale'].includes(g(id)?.status);
  const neg = (id) => valid(id) && g(id).polarity === 'negative';
  const checks = [
    { id: 'R1', title: '估值（PE）显著高于同行中位数', rule: 'V1 判定为负面（>1.3 倍同行中位数或为负）', refs: ['V1'], level: '中', hit: neg('V1') },
    { id: 'R2', title: '估值（PB）显著高于同行中位数', rule: 'V2 判定为负面', refs: ['V2'], level: '中', hit: neg('V2') },
    { id: 'R3', title: '业绩与市场成交额强正相关，具有顺周期属性', rule: 'D1 相关系数 ≥ 0.6（负相关另列为数据风险）', refs: ['D1'], level: '中', hit: valid('D1') && g('D1').value >= 0.6, na: !collected.preset.drivers.includes('market_activity') },
    { id: 'R4', title: '报告期后市场成交额同比下滑', rule: 'D2 判定为负面（<−10%）', refs: ['D2'], level: '中', hit: neg('D2'), na: !collected.preset.drivers.includes('market_activity') },
    { id: 'R5', title: '股价近 1 年显著跑输基准', rule: 'M2 判定为负面（超额 <−10pct）', refs: ['M2'], level: '中', hit: neg('M2') },
    { id: 'R6', title: '股价波动/回撤较大', rule: 'M3 判定为负面（年化波动 >50% 或最大回撤 >35%）', refs: ['M3'], level: '中', hit: neg('M3') },
    { id: 'R7', title: '利润增速边际放缓', rule: 'F3 判定为负面（最新一期同比增速较上一期下降 >5pct）', refs: ['F3'], level: '低', hit: neg('F3') },
    { id: 'R8', title: '最新报告期利润大幅下滑', rule: 'F2 < −20%', refs: ['F2'], level: '高', hit: valid('F2') && g('F2').value < -20 },
    { id: 'R9', title: '利润的现金支撑不足', rule: 'Q3 判定为负面（净利润现金含量 <0.8 倍）', refs: ['Q3'], level: '中', hit: neg('Q3') },
    { id: 'R10', title: '应收账款增速明显快于营收', rule: 'Q6 判定为负面（超出 >20pct）', refs: ['Q6'], level: '中', hit: neg('Q6') },
    { id: 'R11', title: '资产负债率偏高', rule: 'Q5 判定为负面（>70%，金融类除外）', refs: ['Q5'], level: '中', hit: neg('Q5') },
  ];
  const failed = collected.calls.filter((c) => !c.ok);
  const staleEv = B.list.filter((e) => e.status === 'stale');
  const conflictEv = B.list.filter((e) => e.status === 'conflict');
  checks.push(
    { id: 'R90', title: `数据风险：${failed.length} 个工具调用失败，相关维度结论不完整`, rule: '存在调用失败', refs: B.list.filter((e) => e.status === 'error').map((e) => e.id), level: '数据', hit: failed.length > 0 },
    { id: 'R91', title: `数据风险：${staleEv.length} 条证据基于快照/过期数据`, rule: '存在过期或快照证据', refs: staleEv.map((e) => e.id), level: '数据', hit: staleEv.length > 0 },
    { id: 'R92', title: `数据风险：${conflictEv.length} 处数据口径冲突`, rule: '存在双源不一致或同行口径不可比', refs: conflictEv.map((e) => e.id), level: '数据', hit: conflictEv.length > 0 },
    { id: 'R93', title: '数据风险：营收与市场成交额呈强负相关，与行业属性预设相反，需核实数据', rule: 'D1 相关系数 ≤ −0.6', refs: ['D1'], level: '数据', hit: valid('D1') && g('D1').value <= -0.6, na: !collected.preset.drivers.includes('market_activity') },
  );
  for (const c of checks) {
    c.not_applicable = !!c.na; delete c.na;
    c.triggered = !c.not_applicable && !!c.hit; delete c.hit;
    c.available = c.not_applicable || c.level === '数据' || c.refs.some((id) => valid(id));
    if (c.triggered && c.refs.some((id) => g(id)?.status === 'stale') && c.level !== '数据') { c.title += '（基于快照/过期数据）'; c.stale = true; }
  }
  return { risks: checks.filter((c) => c.triggered), checks };
}

function buildOpenQuestions(B, collected, conflicts) {
  const out = [];
  for (const e of B.list.filter((x) => (x.status === 'error' || x.status === 'missing') && !x.na)) {
    out.push({ id: `U-${e.id}`, question: `${e.title}：当前无法验证`, why: e.reason, how: e.how || (e.status === 'error' ? '稍后重试；若持续失败，检查 API Key 权限或接口状态' : '需要引入其他数据源（如巨潮资讯网公告原文）'), refs: [e.id] });
  }
  for (const id of conflicts) {
    if (id === 'X2') out.push({ id: 'U-X2', question: '口径不可比的同行，在统一口径（如营业总收入）下的规模与盈利排名如何？', why: B.get(id).display, how: '查阅该公司年报利润表中的“营业总收入”（含手续费及佣金、利息净收入），或改用业务可比的同行', refs: [id] });
    else out.push({ id: `U-${id}`, question: '两个数据源对同一指标给出不一致的数值，应以哪个为准？', why: B.get(id).display, how: '回到定期报告原文核对营业收入与营业成本', refs: [id] });
  }
  const preset = collected.preset;
  if (preset.drivers.includes('market_activity')) out.push({ id: 'U-biz', question: '收入中增值电信服务、软件销售、广告及互联网推广各占多少？哪部分对市场活跃度最敏感？', why: '扶摇财务报表不含分部收入', how: '查阅年报“主营业务分析”中的分产品收入表', refs: ['D1'] });
  out.push({ id: 'U-val', question: '当前估值在公司自身历史中处于什么位置？', why: '估值接口仅提供最新快照，不提供历史估值序列', how: '需要历史 PE 序列（可用历史价格 × 历史 TTM 利润重建，本版未做）', refs: ['V1'] });
  return out;
}

function profileCompany(B, incA, preset) {
  const ok = (id) => ['ok', 'stale'].includes(B.get(id)?.status);
  const gm = ok('Q1') ? B.get('Q1').value : null;
  const a0 = incA[0];
  const rd = a0 && isNum(a0.research_and_development_expenses) && a0.operating_income ? a0.research_and_development_expenses / a0.operating_income * 100 : null;
  const debt = ok('Q5') ? B.get('Q5').value : null;
  const d1 = B.get('D1');
  const traits = [];
  if (isNum(gm) && gm >= 60) traits.push({ k: 'high_margin', label: `高毛利（${gm.toFixed(1)}%）`, ref: 'Q1' });
  if (isNum(rd) && rd >= 10) traits.push({ k: 'rd_heavy', label: `研发密集（${rd.toFixed(1)}%）`, ref: 'Q2' });
  if (isNum(debt) && debt < 40) traits.push({ k: 'light_asset', label: `低负债（${debt.toFixed(1)}%）`, ref: 'Q5' });
  if (isNum(debt) && debt > 80) traits.push({ k: 'financial_like', label: `高杠杆（${debt.toFixed(1)}%，类金融）`, ref: 'Q5' });
  if (preset.drivers.includes('market_activity')) {
    const r = d1 && ['ok', 'stale'].includes(d1.status) ? d1.value : null;
    const strength = r === null ? '待数据验证' : r >= 0.6 ? `数据支持较强，r=${r.toFixed(2)}` : r <= -0.6 ? `数据显示负相关，r=${r.toFixed(2)}，与预设相反` : `数据支持较弱，r=${r.toFixed(2)}`;
    traits.push({ k: 'market_beta', label: `收入受市场活跃度驱动（行业属性预设；${strength}）`, ref: 'D1', weak: r === null || r < 0.6 });
  }
  let type = '一般工商业';
  if (traits.some((t) => t.k === 'financial_like')) type = '金融/类金融';
  else if (traits.some((t) => t.k === 'market_beta') && traits.some((t) => t.k === 'high_margin')) type = '轻资产金融信息服务（顺周期）';
  else if (traits.some((t) => t.k === 'high_margin') && traits.some((t) => t.k === 'rd_heavy')) type = '轻资产软件/科技';
  else if (traits.some((t) => t.k === 'high_margin')) type = '高毛利消费/品牌';
  const priority = {
    '轻资产金融信息服务（顺周期）': ['driver', 'financial_trend', 'valuation', 'operating_quality', 'market', 'industry', 'events', 'risk'],
    '轻资产软件/科技': ['financial_trend', 'operating_quality', 'valuation', 'industry', 'market', 'events', 'risk'],
    '高毛利消费/品牌': ['operating_quality', 'financial_trend', 'valuation', 'industry', 'market', 'events', 'risk'],
    '金融/类金融': ['valuation', 'financial_trend', 'market', 'industry', 'events', 'risk'],
    '一般工商业': ['financial_trend', 'operating_quality', 'valuation', 'market', 'industry', 'events', 'risk'],
  }[type];
  const focus = {
    '轻资产金融信息服务（顺周期）': '优先看“经营驱动”（收入与两市成交额的关系）与财务趋势',
    '轻资产软件/科技': '优先看收入增长持续性与研发投入',
    '高毛利消费/品牌': '优先看毛利率稳定性与现金含量',
    '金融/类金融': '高杠杆是业务属性，资产负债率规则不适用，PB 比 PE 更有参考意义',
    '一般工商业': '按通用框架诊断',
  }[type];
  const basisTxt = traits.length ? `判定依据：${traits.map((t) => `${t.label}[${t.ref}]`).join('、')}` : '未触发任何画像特征';
  const why = `${focus}${traits.some((t) => t.k === 'light_asset') ? '；负债率低，偿债类指标权重下调' : ''}。${basisTxt}。`;
  const weakBeta = traits.some((t) => t.k === 'market_beta' && t.weak);
  const type_label = type === '轻资产金融信息服务（顺周期）' && weakBeta ? '轻资产金融信息服务（顺周期属性待验证）' : type;
  return { type, type_label, traits, priority, why };
}

function summarize(list, calls) {
  const by = (f) => list.filter(f).length;
  return {
    evidence_total: list.length,
    positive: by((e) => (e.status === 'ok' || e.status === 'stale') && e.polarity === 'positive'),
    negative: by((e) => (e.status === 'ok' || e.status === 'stale') && e.polarity === 'negative'),
    neutral: by((e) => (e.status === 'ok' || e.status === 'stale') && e.polarity === 'neutral'),
    unknown: by((e) => e.status !== 'ok' && e.status !== 'stale'),
    stale: by((e) => e.status === 'stale'),
    calls_total: calls.length,
    calls_failed: calls.filter((c) => !c.ok).length,
    calls_cached: calls.filter((c) => c.cache === 'hit').length,
    calls_stale: calls.filter((c) => c.cache === 'stale' || c.cache === 'snapshot').length,
  };
}
