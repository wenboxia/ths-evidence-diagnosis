// 数据采集层（工具调用编排）：确定“要调哪些工具”，并发受限地执行，保留每次调用的完整记录。
// 这一层不做任何判断，只负责把原始数据和调用状态如实交给下游。
import { PRESETS, MARKET_TURNOVER_INDEXES } from './config.js';
import { cnDate } from './fuyao.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 部署时随函数打包的“最近一次成功采集快照”（不进入公开仓库）。实时调用失败时逐项回退，并显式标注。
function loadSnapshot(thscode) {
  if (process.env.DISABLE_SNAPSHOT === '1') return null;
  // 相对本文件定位（本地与 Vercel 的工作目录不同）；Vercel 通过 includeFiles 把 snapshots/ 打进函数包
  const candidates = [path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'snapshots'), path.join(process.cwd(), 'snapshots')];
  for (const dir of candidates) {
    try { return JSON.parse(fs.readFileSync(path.join(dir, `${thscode}.json`), 'utf8')); } catch { /* 尝试下一个位置 */ }
  }
  return null;
}
// 只有“可恢复”的失败（网络、超时、限流、上游不可用、熔断）才回退快照；鉴权/权限/参数/标的不存在等业务错误必须如实暴露为失败
export const RECOVERABLE = new Set(['TIMEOUT', 'NETWORK', 'BUDGET', 'CIRCUIT_OPEN', 'HTTP_429', 'HTTP_5XX', 4001, 5001, 5002, 5003]);
export function applySnapshot(raw, keys, snap) {
  if (!snap) return;
  for (const k of keys) {
    const live = raw[k];
    const s = snap.raw?.[k];
    if (live && !live.ok && RECOVERABLE.has(live.code) && s?.ok) raw[k] = { ...s, key: k, cache: 'snapshot', stale_reason: live.message, live_attempts: live.attempts };
  }
}

const YEAR_MS = 365 * 24 * 3600 * 1000;

async function runLimited(tasks, limit = 4) {
  const results = new Array(tasks.length);
  let i = 0;
  async function worker() {
    while (i < tasks.length) {
      const idx = i++;
      results[idx] = await tasks[idx]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

export function reportOf(item) {
  // fiscal_period → 财务指标接口的 report 参数
  const map = { Q1: 1, Q2: 2, Q3: 3, Q4: 4, FY: 4 };
  return `${item.fiscal_year}-${map[item.fiscal_period] || 4}`;
}

export async function collect(client, thscode, { now = Date.now(), budgetMs = 40000 } = {}) {
  const deadline = Date.now() + budgetMs;
  const preset = PRESETS[thscode];
  if (!preset) throw Object.assign(new Error(`暂未配置该标的：${thscode}`), { status: 400 });

  const peerCodes = preset.peers.map((p) => p.thscode);
  const start3y = now - 3 * YEAR_MS;
  const raw = {};
  const plan = [];
  const add = (key, tool, path, params) => plan.push({ key, tool, path, params });

  // —— 第一批：目标公司 + 同行快照
  add('income_q', '利润表(季)', '/api/a-share/financials/income-statements', { thscode, period: 'quarterly', limit: 12 });
  add('income_a', '利润表(年)', '/api/a-share/financials/income-statements', { thscode, period: 'annual', limit: 5 });
  add('balance_q', '资产负债表(季)', '/api/a-share/financials/balance-sheets', { thscode, period: 'quarterly', limit: 8 });
  add('balance_a', '资产负债表(年)', '/api/a-share/financials/balance-sheets', { thscode, period: 'annual', limit: 5 });
  add('cash_q', '现金流量表(季)', '/api/a-share/financials/cash-flow-statements', { thscode, period: 'quarterly', limit: 8 });
  add('cash_a', '现金流量表(年)', '/api/a-share/financials/cash-flow-statements', { thscode, period: 'annual', limit: 5 });
  add('kline', '历史K线(前复权)', '/api/a-share/prices/historical', { thscode, interval: '1d', start: start3y, end: now, adjust: 'forward' });
  add('valuations', '估值快照', '/api/a-share/valuations/snapshot', { thscodes: [thscode, ...peerCodes].join(',') });
  add('corp_actions', '分红送转事件', '/api/a-share/corporate-actions/adjustment-factors', { thscode, from: cnDate(now - 5 * YEAR_MS), to: cnDate(now) });
  add('anomaly', '个股异动原因(当日)', '/api/a-share/special-data/anomaly-analysis-stock', { thscodes: thscode });
  add('hot_rank', '热榜排名走势', '/api/a-share/special-data/hot-stock-rank-trend', { thscode, start_date: cnDate(now - 90 * 24 * 3600 * 1000), end_date: cnDate(now) });
  for (const b of preset.benchmarks) {
    add(`bench:${b.thscode}`, `基准指数K线·${b.name}`, '/api/a-share-index/prices/historical', { thscode: b.thscode, interval: '1d', start: start3y, end: now });
  }
  if (preset.drivers.includes('market_activity')) {
    for (const m of MARKET_TURNOVER_INDEXES) {
      add(`mkt:${m.thscode}`, `两市成交额·${m.name}`, '/api/a-share-index/prices/historical', { thscode: m.thscode, interval: '1d', start: start3y, end: now });
    }
  }
  for (const p of preset.peers) {
    add(`peer_income:${p.thscode}`, `同行利润表·${p.name}`, '/api/a-share/financials/income-statements', { thscode: p.thscode, period: 'quarterly', limit: 5 });
  }

  // 熔断：先用一次短时探测确认数据源可连通；连接层失败（超时/网络）且有快照时，直接整体回退快照，避免逐个调用等满超时
  const snapForBreaker = loadSnapshot(thscode);
  const probeIdx = plan.findIndex((t) => t.key === 'valuations');
  let probe = null;
  if (snapForBreaker && probeIdx >= 0) {
    const t = plan[probeIdx];
    probe = await client.call(t.tool, t.path, t.params, { deadline: Math.min(deadline, Date.now() + 6000) });
    if (!probe.ok && ['TIMEOUT', 'NETWORK', 'BUDGET'].includes(probe.code)) {
      const reason = `数据源连接失败（${probe.message}），已熔断并整体使用快照`;
      for (const t2 of plan) raw[t2.key] = { ...t2, ok: false, code: 'CIRCUIT_OPEN', message: reason, attempts: 0, fetched_at: Date.now(), source: 'fuyao' };
      raw.valuations = { ...raw.valuations, attempts: probe.attempts, latency_ms: probe.latency_ms };
      applySnapshot(raw, plan.map((t2) => t2.key), snapForBreaker);
      const snapKeys = Object.keys(snapForBreaker.raw || {}).filter((k) => !raw[k]);
      applySnapshot(Object.assign(raw, Object.fromEntries(snapKeys.map((k) => [k, { key: k, ok: false, code: 'CIRCUIT_OPEN', message: reason }]))), snapKeys, snapForBreaker);
      const latest0 = raw.income_q?.ok ? raw.income_q.data?.item?.[0] : null;
      const calls0 = Object.values(raw).map(({ data, ...meta }) => ({ ...meta, item_count: Array.isArray(data?.item) ? data.item.length : (data?.abilities ? data.abilities.length : null) }));
      return { thscode, preset, report: latest0 ? reportOf(latest0) : null, collected_at: Date.now(), raw, calls: calls0, circuit: { open: true, reason } };
    }
  }
  const first = await runLimited(plan.map((t, i) => () => (i === probeIdx && probe ? Promise.resolve(probe) : client.call(t.tool, t.path, t.params, { deadline }))));
  plan.forEach((t, i) => { raw[t.key] = { ...first[i], key: t.key }; });
  const snap = raw && Object.values(raw).some((r) => !r.ok) ? loadSnapshot(thscode) : null;
  applySnapshot(raw, plan.map((t) => t.key), snap);

  // —— 第二批：依赖第一批结果的调用（财务指标需要知道最新报告期）
  const latest = raw.income_q.ok ? raw.income_q.data?.item?.[0] : null;
  const report = latest ? reportOf(latest) : null;
  const second = [];
  if (report) {
    second.push({ key: 'indicators', tool: `财务指标·${report}`, path: '/api/a-share/financials/indicators', params: { thscode, report } });
    for (const p of preset.peers) {
      second.push({ key: `peer_ind:${p.thscode}`, tool: `同行财务指标·${p.name}·${report}`, path: '/api/a-share/financials/indicators', params: { thscode: p.thscode, report } });
    }
  } else {
    raw.indicators = { key: 'indicators', tool: '财务指标', ok: false, code: 'SKIPPED', message: '利润表不可用，无法确定最新报告期，跳过财务指标调用', fetched_at: Date.now() };
  }
  const secondRes = await runLimited(second.map((t) => () => client.call(t.tool, t.path, t.params, { deadline })));
  second.forEach((t, i) => { raw[t.key] = { ...secondRes[i], key: t.key }; });
  if (second.some((t) => !raw[t.key].ok)) applySnapshot(raw, second.map((t) => t.key), snap || loadSnapshot(thscode));

  const calls = Object.values(raw).map(({ data, ...meta }) => ({
    ...meta,
    item_count: Array.isArray(data?.item) ? data.item.length : (data?.abilities ? data.abilities.length : null),
  }));

  return { thscode, preset, report, collected_at: Date.now(), raw, calls };
}
