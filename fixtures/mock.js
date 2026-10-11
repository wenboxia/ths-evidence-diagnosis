// 构造数据（仅用于本地开发与自动化测试，页面会显著标注“构造数据”）。
// 数值为确定性伪随机生成，不代表任何公司的真实经营情况。

function rng(seed) {
  let s = 0;
  for (const c of seed) s = (s * 31 + c.charCodeAt(0)) >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
const ok = (data) => ({ code: 0, message: 'success', request_id: `mock-${Math.floor(Math.random() * 1e9).toString(16)}`, data });
const dayMs = 86400000;

const BASE = {
  '300033.SZ': { name: '同花顺', rev: 42e8, margin: 0.43, px: 280 },
  '300059.SZ': { name: '东方财富', rev: 116e8, margin: 0.83, px: 24 },
  '300803.SZ': { name: '指南针', rev: 15e8, margin: 0.08, px: 90 },
  '601519.SH': { name: '大智慧', rev: 7.5e8, margin: -0.05, px: 9 },
  '688318.SH': { name: '财富趋势', rev: 3.2e8, margin: 0.58, px: 110 },
  '600519.SH': { name: '贵州茅台', rev: 1700e8, margin: 0.52, px: 1500 },
  '000858.SZ': { name: '五粮液', rev: 890e8, margin: 0.36, px: 130 },
  '000568.SZ': { name: '泸州老窖', rev: 310e8, margin: 0.43, px: 120 },
  '600809.SH': { name: '山西汾酒', rev: 360e8, margin: 0.34, px: 190 },
  '002304.SZ': { name: '洋河股份', rev: 290e8, margin: 0.25, px: 70 },
};

function statements(code, period, limit, kind) {
  const b = BASE[code] || { rev: 10e8, margin: 0.1 };
  const r = rng(code + kind);
  const out = [];
  const now = new Date();
  let y = now.getFullYear(), q = Math.floor(now.getMonth() / 3); // 最新已披露季度（简化：上一季度）
  if (q === 0) { y -= 1; q = 4; }
  const growthByYear = (yy) => 1 + 0.18 * Math.sin(yy * 1.3) + 0.05;
  const annualRev = (yy) => { let v = b.rev; for (let k = 2024; k < yy; k++) v *= growthByYear(k); for (let k = yy; k < 2024; k++) v /= growthByYear(k); return v; };
  for (let i = 0; out.length < limit; i++) {
    let fy, fp, frac;
    if (period === 'annual') { fy = (now.getMonth() < 4 ? y - 1 : y) - i - (q === 4 ? 0 : 1) + (q === 4 ? 0 : 1) - (period === 'annual' && q !== 4 ? 1 : 0); fp = 'FY'; frac = 1; }
    else { const idx = q - 1 - i; fy = y + Math.floor(idx / 4); const qq = ((idx % 4) + 4) % 4 + 1; fp = `Q${qq}`; frac = [0.2, 0.45, 0.7, 1][qq - 1]; }
    const qn = { FY: 4, Q1: 1, Q2: 2, Q3: 3, Q4: 4 }[fp];
    const pe = Date.parse(`${fy}-${String(qn * 3).padStart(2, '0')}-${[31, 30, 30, 31][qn - 1]}T00:00:00+08:00`);
    const rev = annualRev(fy) * frac * (1 + (r() - 0.5) * 0.04);
    const np = rev * b.margin * (1 + (r() - 0.5) * 0.2);
    const base = { thscode: code, ticker: code.slice(0, 6), period, fiscal_year: fy, fiscal_period: fp, report_date_ms: pe + 30 * dayMs, period_end_ms: pe, currency: 'CNY' };
    if (kind === 'income') out.push({ ...base, operating_income: rev, operating_costs: rev * (0.12 + r() * 0.03), operating_expenses: rev * 0.5, sales_fee: rev * 0.1, manage_fee: rev * 0.08, research_and_development_expenses: rev * 0.25, operating_profit: np * 1.1, interest_expenses: 0, profit_total: np * 1.1, income_tax_expense: np * 0.1, net_profit: np, parent_holder_net_profit: np * 0.99, basic_eps: np / 5.37e8 });
    if (kind === 'balance') out.push({ ...base, assets_total: rev * 3.8, total_current_assets: rev * 3, non_current_nets_total: rev * 0.8, cash: rev * 1.5, accounts_receivable: rev * 0.03 * (1 + r() * 0.5), total_debt: rev * 1.2, holder_equity_total: rev * 2.6 });
    if (kind === 'cash') out.push({ ...base, act_cash_flow_net: np * (1.1 + r() * 0.5), invest_cash_flow_net: -rev * 0.3, financing_cash_flow_net: -np * 0.6, pay_fixed_assets_etc_cash: rev * 0.05, pay_dividends_profits_interest_cash: np * 0.6, cash_equivalents_net_addition: np * 0.2 });
  }
  // 修正年报期：让年报与 Q4 一致（验证累计口径识别逻辑）
  return out;
}

function annualFix(items) {
  return items.map((it, i) => ({ ...it, fiscal_year: it.fiscal_year }));
}

function kline(code, start, end, isIndex = false) {
  const r = rng(code + 'k');
  const out = [];
  let px = isIndex ? (code === '000001.SH' ? 3000 : code === '399001.SZ' ? 9500 : code === '000300.SH' ? 3600 : 1900) : (BASE[code]?.px || 20);
  for (let t = Date.parse(new Date(start).toISOString().slice(0, 10) + 'T00:00:00+08:00'); t <= end; t += dayMs) {
    const wd = new Date(t + 8 * 3600e3).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    const ch = (r() - 0.48) * (isIndex ? 0.025 : 0.05);
    const o = px; px = px * (1 + ch);
    const turnover = isIndex ? (code === '000001.SH' ? 5e11 : 6e11) * (0.6 + r() * 0.8) * (1 + 0.5 * Math.sin(t / (200 * dayMs))) : px * 3e7 * (0.5 + r());
    out.push({ date_ms: t, open_price: o, high_price: Math.max(o, px) * (1 + r() * 0.01), low_price: Math.min(o, px) * (1 - r() * 0.01), close_price: +px.toFixed(2), volume: turnover / px, turnover });
  }
  return out;
}

export async function mockFuyao(path, p) {
  const now = Date.now();
  switch (path) {
    case '/api/a-share/financials/income-statements': {
      let items = statements(p.thscode, p.period, Number(p.limit || 4), 'income');
      if (p.period === 'annual') {
        // 年报值 = Q4 累计值（与季报接口保持一致）
        const q = statements(p.thscode, 'quarterly', 20, 'income').filter((x) => x.fiscal_period === 'Q4');
        items = q.slice(0, Number(p.limit || 4)).map((x) => ({ ...x, period: 'annual', fiscal_period: 'FY' }));
      }
      return ok({ timestamp: items[0]?.period_end_ms, item: items });
    }
    case '/api/a-share/financials/balance-sheets': {
      let items = statements(p.thscode, 'quarterly', p.period === 'annual' ? 20 : Number(p.limit || 4), 'balance');
      if (p.period === 'annual') items = items.filter((x) => x.fiscal_period === 'Q4').slice(0, Number(p.limit || 4)).map((x) => ({ ...x, period: 'annual', fiscal_period: 'FY' }));
      return ok({ timestamp: items[0]?.period_end_ms, item: items });
    }
    case '/api/a-share/financials/cash-flow-statements': {
      let items = statements(p.thscode, 'quarterly', p.period === 'annual' ? 20 : Number(p.limit || 4), 'cash');
      if (p.period === 'annual') {
        const inc = statements(p.thscode, 'quarterly', 20, 'income');
        items = items.filter((x) => x.fiscal_period === 'Q4').slice(0, Number(p.limit || 4)).map((x) => {
          const np = inc.find((i) => i.fiscal_year === x.fiscal_year && i.fiscal_period === 'Q4')?.net_profit || 1;
          return { ...x, period: 'annual', fiscal_period: 'FY', act_cash_flow_net: np * 1.25 };
        });
      }
      return ok({ timestamp: items[0]?.period_end_ms, item: items });
    }
    case '/api/a-share/prices/historical':
      return ok({ timestamp: now, item: kline(p.thscode, Number(p.start), Number(p.end)) });
    case '/api/a-share-index/prices/historical':
      return ok({ timestamp: now, adjust: null, item: kline(p.thscode, Number(p.start), Number(p.end), true) });
    case '/api/a-share/prices/snapshot':
      return ok({ timestamp: now, total: 5000, item: p.thscodes.split(',').map((c) => ({ thscode: c, ticker: c.slice(0, 6), last_price: BASE[c]?.px || 10, price_change: 0.5, price_change_ratio_pct: 1.2, open_price: 1, high_price: 1, low_price: 1, prev_price: 1, volume: 1e7, turnover: 1e9 })) });
    case '/api/a-share/valuations/snapshot': {
      const pe = { '300033.SZ': 62.3, '300059.SZ': 38.5, '300803.SZ': 95.1, '601519.SH': -120.4, '688318.SH': 44.7, '600519.SH': 21.4, '000858.SZ': 15.2, '000568.SZ': 14.8, '600809.SH': 18.9, '002304.SZ': 13.1 };
      return ok({ timestamp: now, total: 5, item: p.thscodes.split(',').map((c) => ({ thscode: c, ticker: c.slice(0, 6), name: BASE[c]?.name || c, pe_ttm: pe[c] ?? 20, pe_mrq: (pe[c] ?? 20) * 0.9, pb_mrq: 8.1 * (c === '300033.SZ' ? 1.6 : 0.8), ps_ttm: 15.2, pcf_ttm: 40.3 })) });
    }
    case '/api/a-share/financials/indicators': {
      const inc = statements(p.thscode, 'quarterly', 4, 'income')[0];
      const gm = (1 - inc.operating_costs / inc.operating_income) * 100;
      return ok({ thscode: p.thscode, report: p.report, abilities: [
        { ability: 'growth', indicators: [{ index_id: 'net_profit_yoy_growth_ratio', value: '18.20' }, { index_id: 'operating_income_yoy_growth_ratio', value: '12.10' }] },
        { ability: 'profitability', indicators: [{ index_id: 'sale_gross_margin', value: gm.toFixed(4) }, { index_id: 'index_weighted_avg_roe', value: '14.3200' }] },
        { ability: 'solvency', indicators: [{ index_id: 'assets_debt_ratio', value: '31.5' }] },
        { ability: 'operation', indicators: [] },
        { ability: 'cash-flow', indicators: [{ index_id: 'net_profit_cash_content', value: '1.31' }] },
      ] });
    }
    case '/api/a-share/corporate-actions/adjustment-factors':
      return ok({ thscode: p.thscode, ticker: p.thscode.slice(0, 6), item: [0, 1, 2, 3].map((i) => ({ ticker: p.thscode.slice(0, 6), ex_date_ms: Date.parse(`${new Date().getFullYear() - i}-06-10T00:00:00+08:00`), dividend_per_share: 2.2 + i * 0.3, per_share_bonus: 0 })) });
    case '/api/a-share/special-data/anomaly-analysis-stock':
      return ok({ timestamp: now, item: [] });
    case '/api/a-share/special-data/hot-stock-rank-trend': {
      const r = rng(p.thscode + 'h');
      const item = [];
      for (let t = Date.parse(`${p.start_date}T00:00:00+08:00`); t <= Date.parse(`${p.end_date}T00:00:00+08:00`); t += dayMs) item.push({ thscode: p.thscode, ticker: p.thscode.slice(0, 6), date: new Date(t + 8 * 3600e3).toISOString().slice(0, 10), date_ms: t, rank: Math.floor(20 + r() * 300) });
      return ok({ timestamp: now, item });
    }
    default:
      return { code: 5003, message: 'mock: unsupported path', request_id: 'mock', data: null };
  }
}
