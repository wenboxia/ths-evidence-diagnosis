// 前端：证据看板 + Agent 轨迹 + 钻取抽屉。原生 JS，无构建步骤。
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cnDate = (ms) => (ms ? new Date(ms + 8 * 3600e3).toISOString().slice(0, 10) : '--');
const cnTime = (ms) => (ms ? new Date(ms + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19) : '--');
const yi = (v) => (v === null || v === undefined || !isFinite(v) ? '--' : (v / 1e8).toFixed(2));

const DIM_LABEL = {
  operating_quality: '经营质量', financial_trend: '财务趋势', valuation: '估值', market: '行情特征',
  industry: '行业位置', driver: '经营驱动', events: '重要事件', risk: '风险',
};
const STATE = { diag: null, dimFilter: null, code: '300033.SZ' };
// 与服务端 lib/service.js 的 CORE_KEYS 保持一致：问答时回传已签名的证据，避免重复调用数据源
const CORE_KEYS = ['thscode', 'name', 'preset', 'report', 'profile', 'evidence', 'contradictions', 'risks', 'risk_checks', 'open_questions', 'stats', 'generated_at'];
const pickCore = (d) => { if (!d) return null; const o = {}; for (const k of CORE_KEYS) o[k] = d[k]; return o; };

// ---------------- 数据加载 ----------------
async function load(code) {
  STATE.code = code;
  $('#dataMode').textContent = '采集数据中…';
  $('#board').innerHTML = `<div class="loading"><span class="spinner"></span> 正在调用扶摇数据工具（约 24 次调用）并计算证据…</div>`;
  $('#agent').classList.add('hidden');
  try {
    const r = await fetch(`/api/diagnose?thscode=${encodeURIComponent(code)}`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    STATE.diag = d;
    render();
  } catch (e) {
    $('#board').innerHTML = `<div class="banner">数据加载失败：${esc(e.message)}。页面不会展示任何推断结论。</div>`;
    $('#dataMode').textContent = '加载失败';
  }
}

function render() {
  const d = STATE.diag;
  const mode = $('#dataMode');
  if (d.meta.data_mode === 'mock') { mode.className = 'pill mock'; mode.textContent = '⚠ 构造数据（非真实）'; }
  else if (d.stats.calls_stale) { mode.className = 'pill mock'; mode.textContent = `⚠ 实时调用失败 · 使用快照/缓存数据（${d.stats.calls_stale}/${d.stats.calls_total}）`; }
  else if (d.stats.calls_failed) { mode.className = 'pill mock'; mode.textContent = `⚠ ${d.stats.calls_failed}/${d.stats.calls_total} 个数据调用失败`; }
  else { mode.className = 'pill live'; mode.textContent = `扶摇实时数据 · ${cnTime(d.meta.generated_at)}`; }
  const banner = $('#banner');
  const msgs = [];
  if (d.meta.data_mode === 'mock') msgs.push('当前为构造数据模式（MOCK_DATA=1），所有数字均为程序生成，仅用于演示交互，不代表真实公司情况。');
  if (!d.meta.fuyao_key && d.meta.data_mode !== 'mock') msgs.push('服务端未配置扶摇 API Key，所有数据调用失败。');
  if (d.circuit?.open) msgs.push(`熔断：${d.circuit.reason}。`);
  if (d.stats.calls_stale) msgs.push(`${d.stats.calls_stale} 个数据工具实时调用失败，已回退到最近一次成功抓取的快照/缓存；相关证据标记为“可能过期”，抓取时间见各条证据与调用记录。`);
  if (d.stats.calls_failed) msgs.push(`${d.stats.calls_failed} / ${d.stats.calls_total} 个数据工具调用失败，相关证据已标记为“未知”，不会生成正常结论。`);
  if (!d.meta.llm) msgs.push('未配置 LLM，AI 解读将降级为“仅事实”的模板输出。');
  banner.innerHTML = msgs.map(esc).join('<br>');
  banner.classList.toggle('hidden', !msgs.length);

  $('#coName').textContent = d.name;
  $('#coCode').textContent = d.thscode;
  const k = d.series.kline;
  const last = k[k.length - 1];
  $('#coMeta').textContent = `${d.preset.board} · ${d.preset.industry_label}${last ? ` · 最新收盘 ${last[1]} 元（${cnDate(last[0])}，前复权）` : ''} · 最新财报 ${d.report || '--'} · 季报口径：${d.quarterly_basis.label}`;
  const d1 = d.evidence.find((e) => e.id === 'D1');
  $('#profile').innerHTML = `<span class="tag type" title="${esc(d.profile.why)}">公司类型：${esc(d.profile.type_label || d.profile.type)}</span>` +
    d.profile.traits.map((t) => {
      const weak = !!t.weak;
      return `<span class="tag ${weak ? 'unsupported' : ''}" title="${weak ? '行业属性预设，数据支持较弱（D1 相关系数 <0.6），仅作参考' : '依据 ' + t.ref}">${esc(t.label)} <span class="cite" data-ev="${t.ref}">${t.ref}</span></span>`;
    }).join('') +
    `<span class="muted small" style="margin-left:4px">${esc(d.profile.why)}</span>`;
  $('#stats').innerHTML = `
    <div class="stat pos"><b>${d.stats.positive}</b><span>正面</span></div>
    <div class="stat neg"><b>${d.stats.negative}</b><span>负面</span></div>
    <div class="stat con"><b>${d.contradictions.length}</b><span>矛盾</span></div>
    <div class="stat unk"><b>${d.stats.unknown}</b><span>未知</span></div>
    <div class="hero-calls">条数不代表权重，不构成综合评价 · ${d.stats.calls_total} 次工具调用 · 失败 ${d.stats.calls_failed} · 缓存命中 ${d.stats.calls_cached}${d.stats.calls_stale ? ` · 回退旧数据 ${d.stats.calls_stale}` : ''}</div>`;
  renderDimFilter();
  renderBoard();
  renderOpenQs();
  renderCalls();
}

function renderDimFilter() {
  const dims = Object.keys(DIM_LABEL).filter((k) => k === 'risk' || STATE.diag.evidence.some((e) => e.dim === k));
  $('#dimFilter').innerHTML = `<button data-dim="" class="${!STATE.dimFilter ? 'on' : ''}">全部维度</button>` +
    dims.map((k) => `<button data-dim="${k}" class="${STATE.dimFilter === k ? 'on' : ''}">${DIM_LABEL[k]}</button>`).join('');
}

function evCard(e) {
  const statusTxt = { error: '调用失败', missing: '缺失', stale: '可能过期', conflict: '数据冲突' }[e.status];
  return `<div class="ev" data-ev="${e.id}">
    <div class="ev-top"><span>${e.id} · ${DIM_LABEL[e.dim] || e.dim}${e.kind === 'derived' ? ' · 派生' : e.kind === 'opinion' ? ' · 观点' : ''}</span>${statusTxt ? `<span class="ev-status">${statusTxt}</span>` : `<span>${esc(e.period || '')}</span>`}</div>
    <div class="ev-title">${esc(e.title)}</div>
    <div class="ev-val">${esc(e.status === 'ok' || e.status === 'stale' || e.status === 'conflict' ? e.display : e.reason)}</div>
  </div>`;
}

function renderBoard() {
  const d = STATE.diag;
  const riskRefs = new Set((d.risk_checks || []).filter((c) => c.triggered).flatMap((c) => c.refs));
  const f = (e) => !STATE.dimFilter || e.dim === STATE.dimFilter || (STATE.dimFilter === 'risk' && riskRefs.has(e.id));
  const ev = d.evidence.filter(f);
  const pos = ev.filter((e) => (e.status === 'ok' || e.status === 'stale') && e.polarity === 'positive');
  const neg = ev.filter((e) => (e.status === 'ok' || e.status === 'stale') && e.polarity === 'negative');
  const unk = ev.filter((e) => e.status === 'missing' || e.status === 'error' || e.status === 'conflict');
  const neu = ev.filter((e) => (e.status === 'ok' || e.status === 'stale') && e.polarity === 'neutral');
  const cons = d.contradictions.filter((c) => !STATE.dimFilter || STATE.dimFilter === 'risk' || c.refs.some((id) => d.evidence.find((e) => e.id === id)?.dim === STATE.dimFilter));
  const risks = d.risks.filter((r) => !STATE.dimFilter || STATE.dimFilter === 'risk' || r.refs.some((id) => d.evidence.find((e) => e.id === id)?.dim === STATE.dimFilter));
  const col = (cls, title, inner, n) => `<div class="col ${cls}"><div class="col-head"><span>${title}</span><span>${n}</span></div>${inner || '<div class="muted small" style="padding:4px">无</div>'}</div>`;
  const conHtml = cons.map((c) => `<div class="ev con-card"><div class="ev-top"><span>${c.id} · 规则识别</span></div><div class="ev-title">${esc(c.title)}</div><div class="ev-val">${esc(c.explain)}</div><div class="refs">${c.refs.map((r) => `<span class="cite" data-ev="${r}">${r}</span>`).join('')}</div></div>`).join('');
  const checks = d.risk_checks || [];
  const untriggered = checks.filter((c) => !c.triggered);
  const riskHtml = `<div class="col-head" style="margin-top:10px;color:var(--neg)"><span>风险信号（规则检查 ${checks.length} 项，触发 ${checks.filter((c) => c.triggered).length} 项）</span><span>${risks.length}</span></div>` +
    (risks.length ? risks.map((r) => `<div class="ev"><div class="ev-top"><span>${r.id} · 风险等级 ${esc(r.level)}</span></div><div class="ev-title">${esc(r.title)}</div><div class="ev-val muted small">规则：${esc(r.rule || '')}</div><div class="refs">${r.refs.slice(0, 8).map((x) => `<span class="cite" data-ev="${x}">${x}</span>`).join('')}${r.refs.length > 8 ? `<span class="muted small"> …等 ${r.refs.length} 条</span>` : ''}</div></div>`).join('') : '<div class="muted small" style="padding:4px">当前没有触发的规则风险信号（不代表没有风险）</div>') +
    (untriggered.length ? `<details class="risk-more"><summary>已检查、未触发的规则（${untriggered.length}）</summary>${untriggered.map((c) => `<div class="small" style="margin:4px 0">${c.id} ${esc(c.title)}<span class="muted">｜${esc(c.rule)}${c.not_applicable ? '（该公司类型不适用）' : c.available ? '' : '（相关证据不可用，无法检查）'}</span> ${c.refs.map((x) => `<span class="cite" data-ev="${x}">${x}</span>`).join('')}</div>`).join('')}</details>` : '');
  $('#board').innerHTML =
    col('pos', '正面证据', pos.map(evCard).join(''), pos.length) +
    col('neg', '负面证据', neg.map(evCard).join('') + riskHtml, neg.length) +
    col('con', '矛盾 / 张力', conHtml, cons.length) +
    col('unk', '未知 / 无法验证', unk.map(evCard).join(''), unk.length);
  $('#neutralCount').textContent = `（${neu.length}）`;
  $('#neutralList').innerHTML = neu.map(evCard).join('');
}

function renderOpenQs() {
  $('#openQs').innerHTML = STATE.diag.open_questions.map((q) => `<div class="oq" id="oq-${esc(q.id)}">
    <div class="q">${esc(q.question)}</div>
    <div class="why">为何无法回答：${esc(q.why)}</div>
    <div class="how">建议验证路径：${esc(q.how)}</div>
    <div>${(q.refs || []).map((r) => `<span class="cite" data-ev="${r}">${r}</span>`).join('')} <button class="oq-ask" data-q="${esc(q.question)}">就此追问 →</button></div>
  </div>`).join('');
}

function renderCalls() {
  const calls = STATE.diag.calls;
  $('#callsSummary').textContent = `${calls.length} 次 · 失败 ${calls.filter((c) => !c.ok).length}`;
  $('#calls').innerHTML = `<table><thead><tr><th>状态</th><th>工具</th><th>接口与参数</th><th class="num">耗时</th><th>request_id</th><th>数据时点</th><th>条数</th></tr></thead><tbody>${calls.map((c) => `
    <tr><td>${c.ok ? '<span class="ok-dot">● 成功</span>' : `<span class="err-dot">● ${esc(c.message)}</span>`}${c.cache === 'hit' ? ' <span class="muted">(缓存)</span>' : (c.cache === 'stale' || c.cache === 'snapshot') ? ` <span class="err-dot">(实时失败：${esc(c.stale_reason)}；已回退到 ${cnTime(c.fetched_at)} 的${c.cache === 'snapshot' ? '快照' : '缓存'})</span>` : ''}</td>
    <td>${esc(c.tool)}</td><td><code>${esc(c.path)}</code><br><code>${esc(JSON.stringify(c.params))}</code></td>
    <td class="num">${c.latency_ms ?? '--'}ms${c.attempts > 1 ? `<br>重试${c.attempts - 1}次` : ''}</td><td><code>${esc(c.request_id || '--')}</code></td>
    <td>${c.data_timestamp ? cnDate(c.data_timestamp) : '--'}</td><td>${c.item_count ?? '--'}</td></tr>`).join('')}</tbody></table>`;
}

// ---------------- Agent ----------------
async function askAgent(question) {
  // 已签名证据超过 25 分钟（服务端 30 分钟失效）时先刷新，避免问答接口重新采集导致超时
  if (STATE.diag && Date.now() - STATE.diag.generated_at > 25 * 60 * 1000) await load(STATE.code);
  const box = $('#agent');
  box.classList.remove('hidden');
  $('#askBtn').disabled = true;
  box.innerHTML = `<div class="steps">${['规划诊断维度', '组织解读', '证据校验', '输出'].map((s, i) => `<span class="step ${i === 0 ? 'running' : ''}">${i === 0 ? '<span class="spinner"></span>' : ''}${s}</span>`).join('<span class="arrow">→</span>')}</div>
    <div class="loading">Agent 运行中（约 20–40 秒）：LLM 只能引用证据看板中的证据 ID，输出后由校验器检查引用、数字、方向与合规，未通过的陈述会带着校验意见定点修复…</div>`;
  try {
    const r = await fetch('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ thscode: STATE.code, question, core: pickCore(STATE.diag), core_sig: STATE.diag?.core_sig }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    renderAgent(d);
  } catch (e) {
    box.innerHTML = `<div class="banner">诊断失败：${esc(e.message)}。证据看板仍可正常查看。</div>`;
  } finally { $('#askBtn').disabled = false; }
}

const STEP_LABEL = { plan: '规划', plan_check: '规划合规检查', interpret: '解读', relabel: '事实/推断改判', verify: '校验', reflect: '反思', fallback: '降级' };
const STATUS_LABEL = { fixed: '已替换', ok: '完成', pass: '通过', fail: '未通过', retry: '重试', repair: '定点修复', fallback: '降级', error: '失败', skipped: '跳过', template: '模板输出' };

function cites(ids) { return (ids || []).map((id) => `<span class="cite" data-ev="${esc(id)}">${esc(id)}</span>`).join(''); }
function stmt(s, forceType) {
  const type = forceType || (['fact', 'inference'].includes(s.type) ? s.type : 'inference');
  const label = type === 'fact' ? '事实' : type === 'inference' ? `推断${s.confidence ? '·' + s.confidence : ''}` : type === 'tension' ? '矛盾' : '未知';
  return `<div class="stmt"><span class="badge ${type}">${label}</span><div>${esc(s.text)}${cites(s.evidence_ids)}${s.relabeled ? `<span class="muted small">（${esc(s.relabeled)}）</span>` : ''}${(s.flags || []).map((f) => `<span class="flag">⚠ 未通过校验：${esc(f)}</span>`).join('')}</div></div>`;
}

function renderAgent(d) {
  const it = d.interpretation;
  const v = d.verification;
  const steps = d.trace.map((t) => `<span class="step ${t.status}" title="${esc(t.error || t.reason || '')}">${STEP_LABEL[t.step] || t.step}${t.attempt ? '#' + t.attempt : ''} · ${STATUS_LABEL[t.status] || t.status}${t.latency_ms ? ` · ${(t.latency_ms / 1000).toFixed(1)}s` : ''}</span>`).join('<span class="arrow">→</span>');
  const plan = d.plan;
  const html = [];
  html.push(`<div class="steps">${steps}</div>`);
  html.push(`<div class="muted small">证据生成于 ${cnTime(d.evidence_generated_at)}${d.evidence_reused ? '（复用页面已加载的已签名证据，未重复调用数据源）' : '（本次重新采集）'}</div>`);
  if (d.data_notice) html.push(`<div class="banner">${esc(d.data_notice)} 以下解读据此生成，每条证据的抓取时间见抽屉。</div>`);
  html.push(`<div class="plan"><b>Agent 规划</b>（${plan.source === 'llm' ? 'LLM 规划' : '规则规划兜底'}）：${esc(plan.intent)}
    <div class="dims">${plan.dimensions.map((x, i) => `<span class="tag dim" title="${esc(x.reason)}">${i + 1}. ${DIM_LABEL[x.key] || x.key}<span class="muted">｜${esc(x.reason)}</span></span>`).join('')}</div></div>`);
  if (plan.compliance?.flag) html.push(`<div class="compliance">合规提示：${esc(plan.compliance.note)}</div>`);
  if (plan.clarify) html.push(`<div class="clarify">需要澄清：${esc(plan.clarify)}（已按默认理解继续诊断）</div>`);
  html.push(`<div class="headline"><span class="badge inference" style="font-size:11px;vertical-align:2px">概述·推断</span> ${esc(it.headline_body || it.headline)} ${cites(it.headline_ids)}${(it.headline_flags || []).map((f) => `<span class="flag">⚠ ${esc(f)}</span>`).join('')}</div>`);
  if (it.answer?.length) html.push(`<div><div class="subhead">回应你的问题</div><div class="stmts">${it.answer.map((s) => stmt(s)).join('')}</div></div>`);
  if (it.dimensions?.length) html.push(`<div class="grid2">${it.dimensions.map((dm) => `<div class="dim-block"><h4>${DIM_LABEL[dm.key] || dm.key}</h4><div class="stmts">${(dm.points || []).map((s) => stmt(s)).join('')}</div></div>`).join('')}</div>`);
  html.push(`<div class="grid2">
    <div><div class="subhead">矛盾与张力</div><div class="stmts">${(it.tensions || []).map((s) => stmt(s, 'tension')).join('') || '<span class="muted small">无</span>'}</div></div>
    <div><div class="subhead">暂无法判断</div><div class="stmts">${(it.unknowns || []).map((s) => stmt(s, 'unknown')).join('') || '<span class="muted small">无</span>'}</div></div>
  </div>`);
  if (it.risks?.length) html.push(`<div><div class="subhead">规则风险信号</div><div class="stmts">${it.risks.map((s) => stmt(s, 'unknown')).join('')}</div></div>`);
  const notCovered = Object.keys(DIM_LABEL).filter((k) => STATE.diag.evidence.some((e) => e.dim === k) && !(it.dimensions || []).some((x) => x.key === k));
  if (notCovered.length) html.push(`<div class="muted small">本次解读未展开的维度：${notCovered.map((k) => DIM_LABEL[k]).join('、')}（证据见下方看板）</div>`);
  if (it.next_steps?.length) html.push(`<div class="next"><div class="subhead">沿证据继续研究</div>${it.next_steps.map((n) => `<button data-q="${esc(n.question)}">→ ${esc(n.question)} <span class="muted small">${esc(n.why || '')}</span> ${cites(n.evidence_ids)}</button>`).join('')}</div>`);
  html.push(`<details class="verify"><summary>校验报告：${v.mode === 'template' ? 'LLM 不可用，模板输出（仅事实）' : `${v.passed ? '✅ 通过' : '⚠ 仍有问题（已在对应陈述旁标注）'} · 共 ${v.statements} 条陈述 · 严重问题 ${v.major} · 轻微 ${v.minor}${v.repaired ? ` · 定点修复 ${v.repaired} 条` : ''}${v.dropped?.length ? ` · 删除 ${v.dropped.length} 条无法修复的陈述` : ''}`}</summary>
    <div style="margin-top:6px">校验规则：①每条陈述必须引用存在的证据 ID；②陈述中的数字须能在所引证据中找到（正则比对，有局限）；③缺失/失败/冲突的证据不能作为结论依据；④措辞方向须与证据的规则判定一致；⑤不得出现买卖建议、涨跌预测、收益承诺或好坏标签（未通过的句子会被隐去原文）；⑥含评价性措辞的“事实”会被系统改判为推断。</div>
    ${v.dropped?.length ? `<div style="margin-top:6px">被删除的陈述：${v.dropped.map((x) => `<code>${esc(x.path)}</code>（${esc((x.problems || []).join('；'))}）`).join('；')}</div>` : ''}
    ${v.issues?.length ? `<table style="margin-top:6px"><thead><tr><th>位置</th><th>类型</th><th>问题</th></tr></thead><tbody>${v.issues.map((i) => `<tr><td><code>${esc(i.path)}</code></td><td>${esc(i.type)}${i.minor ? '（轻微）' : ''}</td><td>${esc(i.detail)}</td></tr>`).join('')}</tbody></table>` : ''}
    ${d.trace.filter((t) => t.step === 'verify').map((t) => `<div style="margin-top:6px">第 ${t.attempt} 次校验：${t.status === 'pass' ? '通过' : `未通过（${t.major} 处严重问题）`}</div>`).join('')}${d.trace.filter((t) => t.step === 'reflect').map((t) => `<div>反思：${esc(t.reason || t.error || '')}</div>`).join('')}
  </details>`);
  $('#agent').innerHTML = html.join('');
}

// ---------------- 钻取抽屉 ----------------
function openEvidence(id) {
  const d = STATE.diag;
  const e = d.evidence.find((x) => x.id === id);
  if (!e) return;
  document.querySelectorAll('.ev.hl').forEach((x) => x.classList.remove('hl'));
  document.querySelectorAll(`.ev[data-ev="${id}"]`).forEach((x) => x.classList.add('hl'));
  const pol = { positive: '正面', negative: '负面', neutral: '中性', unknown: '未知' }[e.polarity];
  $('#drawerTitle').innerHTML = `<div class="muted small">${e.id} · ${DIM_LABEL[e.dim]} · ${e.kind === 'derived' ? '派生指标' : e.kind === 'opinion' ? '观点（非事实）' : e.kind === 'conflict' ? '数据冲突' : '客观事实'}</div><div class="big">${esc(e.title)}</div>`;
  const body = [];
  body.push(`<dl class="kv">
    <dt>取值</dt><dd><b>${esc(e.status === 'ok' || e.status === 'stale' || e.status === 'conflict' ? e.display : '—')}</b>${e.detail ? `<br><span class="muted">${esc(e.detail)}</span>` : ''}</dd>
    <dt>状态</dt><dd>${{ ok: '正常', stale: '可能过期', error: '调用失败', missing: '数据缺失', conflict: '数据冲突' }[e.status]}${e.reason ? `：${esc(e.reason)}` : ''}</dd>
    <dt>判定</dt><dd>${pol}${e.rule ? `<br><span class="muted">规则：${esc(e.rule)}</span>` : ''}</dd>
    <dt>单位</dt><dd>${esc(e.unit || '无（文本/事件）')}</dd>
    <dt>报告期/区间</dt><dd>${esc(e.period || '--')}</dd>
    <dt>口径</dt><dd>${esc(e.basis || '--')}</dd>
    <dt>计算</dt><dd><code>${esc(e.calc || '--')}</code></dd>
  </dl>`);
  if (e.series && e.id === 'F3') body.push(tableHtml(['报告期', '营收同比', '归母净利同比'], e.series.map((s) => [s.period, fmtPct(s.rev), fmtPct(s.np)])));
  const drill = e.drill || {};
  if (drill.type === 'financials') body.push(finTable(drill.statement, drill.field));
  if (drill.type === 'price') body.push(priceBlock(drill));
  if (drill.type === 'peers') body.push(peerTable(drill.field));
  if (drill.type === 'driver') body.push(driverBlock());
  if (drill.type === 'hot_rank' && e.series) body.push(`<div><div class="subhead">热榜排名走势（数值越小越靠前）</div>${lineChart([{ pts: e.series.map((s) => [Date.parse(s.date), -s.rank]), color: '#e8590c' }], { fmtY: (v) => String(-Math.round(v)) })}</div>`);
  if (e.events) body.push(tableHtml(['除权日', '每股派现(元,税前)', '每股送转'], e.events.map((x) => [cnDate(x.ex_date_ms), x.dividend_per_share, x.per_share_bonus])));
  body.push(`<div><div class="subhead">原始来源（可回溯到接口字段）</div>${(e.sources || []).length ? tableHtml(['工具', '接口 / 参数', '字段', 'request_id', '抓取时间', '数据时点', '状态'], e.sources.map((s) => [
    esc(s.tool || s.key), `<code>${esc(s.path || '')}</code><br><code>${esc(JSON.stringify(s.params || {}))}</code>`, (s.fields || []).map((f) => `<code>${esc(f)}</code>`).join(' '),
    `<code>${esc(s.request_id || '--')}</code>`, cnTime(s.fetched_at), s.data_timestamp ? `${cnDate(s.data_timestamp)}${d.last_trade_date && ['valuations', 'anomaly'].includes(s.key) && cnDate(s.data_timestamp) !== d.last_trade_date ? `（对应交易日 ${d.last_trade_date}）` : ''}` : '--',
    (s.ok ? '成功' : `失败 ${esc(s.code ?? '')}`) + (s.cache === 'snapshot' || s.cache === 'stale' ? `<br><span class="err-dot">实时失败，使用${s.cache === 'snapshot' ? '快照' : '缓存'}</span>` : '')]), true) : `<span class="muted small">${e.unavailable === 'not_integrated' ? '未接入：iFinD MCP 可提供公告/新闻，需要 iFinD 账号授权，本次未取得；扶摇资讯事件库仅限同花顺 AI 客户端。' : '该项没有可追溯的接口调用。'}</span>`}</div>`);
  const relQ = d.open_questions.filter((q) => (q.refs || []).includes(id));
  if (relQ.length) body.push(`<div><div class="subhead">相关待验证问题</div>${relQ.map((q) => `<div class="oq" style="margin-bottom:8px"><div class="q">${esc(q.question)}</div><div class="why">为何无法回答：${esc(q.why)}</div><div class="how">建议验证路径：${esc(q.how)}</div><a href="#oq-${esc(q.id)}" class="jump">在“待验证问题”中查看</a> <button class="oq-ask" data-q="${esc(q.question)}">就此追问 →</button></div>`).join('')}</div>`);
  const refBy = [...d.contradictions, ...d.risks].filter((c) => c.refs.includes(id));
  const relChecks = (d.risk_checks || []).filter((c) => !c.triggered && c.refs.includes(id));
  if (relChecks.length) body.push(`<div><div class="subhead">相关风险规则（未触发）</div>${relChecks.map((c) => `<div class="small">${c.id} ${esc(c.title)}<span class="muted">｜${esc(c.rule)}</span></div>`).join('')}</div>`);
  if (refBy.length) body.push(`<div><div class="subhead">被以下矛盾/风险引用</div>${refBy.map((c) => `<div>${c.id} ${esc(c.title)}</div>`).join('')}</div>`);
  $('#drawerBody').innerHTML = body.join('');
  $('#drawer').classList.add('open');
  $('#scrim').classList.add('open');
  bindRange(drill);
}
function closeDrawer() { $('#drawer').classList.remove('open'); $('#scrim').classList.remove('open'); }

const fmtPct = (v) => (v === null || v === undefined || !isFinite(v) ? '--' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`);
function tableHtml(head, rows, raw = false) {
  return `<div class="table-scroll"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${raw ? c : esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

const FIELD_LABEL = {
  operating_income: '营业收入', operating_costs: '营业成本', sales_fee: '销售费用', manage_fee: '管理费用', research_and_development_expenses: '研发费用',
  operating_profit: '营业利润', net_profit: '净利润', parent_holder_net_profit: '归母净利润', basic_eps: '基本EPS(元)',
  assets_total: '资产总计', total_current_assets: '流动资产', cash: '货币资金', accounts_receivable: '应收账款', total_debt: '负债合计', holder_equity_total: '所有者权益',
  act_cash_flow_net: '经营现金流净额', invest_cash_flow_net: '投资现金流净额', financing_cash_flow_net: '筹资现金流净额', pay_dividends_profits_interest_cash: '分配股利等支付的现金',
};
function finTable(statement, field) {
  const s = STATE.diag.series;
  const list = { income: s.income_q, income_a: s.income_a, balance_q: s.balance_q, balance_a: s.balance_a, cash_a: s.cash_a, cash_q: s.cash_q }[statement] || [];
  if (!list.length) return '<div class="muted">无可用财务数据</div>';
  const fields = Object.keys(FIELD_LABEL).filter((f) => list.some((x) => x[f] !== undefined));
  const cols = list.slice(0, 8);
  const pl = (x) => `${x.fiscal_year}${x.fiscal_period}`;
  return `<div><div class="subhead">财务期次钻取（单位：亿元，${STATE.diag.quarterly_basis.label}；高亮为本证据所用字段）</div><div class="table-scroll"><table>
    <thead><tr><th>科目</th>${cols.map((c) => `<th class="num">${pl(c)}<br><span class="muted">披露日* ${cnDate(c.report_date_ms)}</span></th>`).join('')}</tr></thead>
    <tbody>${fields.map((f) => `<tr class="${f === field ? 'hl' : ''}"><td>${FIELD_LABEL[f]}<br><code>${f}</code></td>${cols.map((c) => `<td class="num">${c[f] === null || c[f] === undefined ? '<span class="muted">未披露</span>' : f === 'basic_eps' ? c[f] : yi(c[f])}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div><div class="muted small">* 披露日取自接口 report_date_ms。上年同期记录的披露日若晚于其报告期（例如显示为今年的日期），说明该值来自较新的披露版本（本期报告中的比较数据，可能经追溯调整）。</div></div>`;
}

function peerTable(field) {
  const pt = STATE.diag.peer_table;
  const cols = [['revenue', '营收(亿元)'], ['net_profit', '归母净利(亿元)'], ['net_margin', '净利率(%)'], ['revenue_yoy', '营收同比(%)'], ['profit_yoy', '净利同比(%)'], ['roe', 'ROE(接口,%)'], ['pe_ttm', 'PE TTM(倍)'], ['pb_mrq', 'PB(倍)'], ['ps_ttm', 'PS(倍)'], ['pcf_ttm', 'PCF(倍)']];
  const f = (k, v) => (v === null || v === undefined || !isFinite(v) ? '--' : ['revenue', 'net_profit'].includes(k) ? yi(v) : ['net_margin', 'revenue_yoy', 'profit_yoy', 'roe'].includes(k) ? `${v.toFixed(1)}%` : v.toFixed(2));
  return `<div><div class="subhead">同行对比（${esc(pt.period)}；${esc(pt.rule)}）</div><div class="table-scroll"><table>
    <thead><tr><th>公司</th>${cols.map(([k, l]) => `<th class="num ${k === field ? 'hl' : ''}">${l}</th>`).join('')}</tr></thead>
    <tbody>${pt.rows.map((r) => `<tr class="${r.is_target ? 'hl' : ''}"><td>${esc(r.name)}<br><code>${r.thscode}</code>${r.comparable === false ? `<br><span class="ev-status" title="${esc(r.conflict_reason)}">营收口径不可比·不参与营收类排名</span>` : ''}</td>${cols.map(([k]) => `<td class="num ${k === field ? 'hl' : ''}">${f(k, r[k])}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div>${pt.excluded.length ? `<div class="muted small">未纳入：${pt.excluded.map((e) => `${esc(e.name)}（${esc(e.reason)}）`).join('；')}</div>` : ''}<div class="muted small">估值为最新快照；财务为同一报告期${esc(STATE.diag.quarterly_basis.label)}。</div></div>`;
}

function driverBlock() {
  const e = STATE.diag.evidence.find((x) => x.id === 'D1');
  if (!e || !e.series) return '';
  return `<div><div class="subhead">报告期对齐：两市成交额同比 vs 公司营收同比</div>${tableHtml(['报告期', '两市成交额同比', '营收同比'], e.series.map((s) => [s.period, fmtPct(s.market_yoy), fmtPct(s.revenue_yoy)]))}</div>`;
}

function priceBlock(drill) {
  return `<div><div class="subhead">行情区间钻取（前复权收盘价）</div>
    <div class="range" id="rangeBtns">${[['1月', 20], ['3月', 60], ['6月', 120], ['1年', 250], ['3年', 750]].map(([l, n]) => `<button data-n="${n}" class="${n === (drill.range || 250) ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div id="priceChart"></div><div id="rangeStats" class="muted small"></div>
    <details style="margin-top:8px"><summary class="small">最近 ${(STATE.diag.series.kline_tail || []).length} 个交易日原始 K 线（前复权，单位：元 / 亿元）</summary>${tableHtml(['日期', '开', '高', '低', '收', '成交额(亿元)'], (STATE.diag.series.kline_tail || []).slice().reverse().map((b) => [cnDate(b.date_ms), b.open?.toFixed(2), b.high?.toFixed(2), b.low?.toFixed(2), b.close?.toFixed(2), yi(b.turnover)]))}</details></div>`;
}
function bindRange(drill) {
  const btns = document.querySelectorAll('#rangeBtns button');
  if (!btns.length) return;
  const draw = (n) => {
    const d = STATE.diag;
    const k = d.series.kline.slice(-(n + 1)); // n 个交易日的涨跌需要 n+1 根 K 线，与证据 M1 口径一致
    if (!k.length) { $('#priceChart').innerHTML = '<div class="muted">无行情数据</div>'; return; }
    const lines = [{ pts: k.map((b) => [b[0], b[1] / k[0][1] * 100]), color: '#e93030', name: d.name }];
    const colors = ['#1c7ed6', '#868e96'];
    d.series.benchmarks.forEach((b, i) => {
      const bb = b.bars.filter((x) => x[0] >= k[0][0]);
      if (bb.length) lines.push({ pts: bb.map((x) => [x[0], x[1] / bb[0][1] * 100]), color: colors[i] || '#adb5bd', name: b.name });
    });
    $('#priceChart').innerHTML = `<div class="legend">${lines.map((l) => `<span><i style="background:${l.color}"></i>${esc(l.name)}</span>`).join('')}<span class="muted">（起点归一为 100）</span></div>` + lineChart(lines, { highlight: drill.highlight });
    const ret = (k[k.length - 1][1] / k[0][1] - 1) * 100;
    const hi = Math.max(...k.map((b) => b[1])), lo = Math.min(...k.map((b) => b[1]));
    $('#rangeStats').textContent = `${cnDate(k[0][0])} ~ ${cnDate(k[k.length - 1][0])}：区间涨跌 ${fmtPct(ret)}，区间最高收盘 ${hi.toFixed(2)} 元，最低收盘 ${lo.toFixed(2)} 元，共 ${k.length - 1} 个交易日（前端按所选区间实时计算，前复权）`;
    btns.forEach((b) => b.classList.toggle('on', Number(b.dataset.n) === n));
  };
  btns.forEach((b) => b.addEventListener('click', () => draw(Number(b.dataset.n))));
  draw(drill.range || 250);
}

function lineChart(lines, { highlight = null, fmtY = (v) => v.toFixed(0) } = {}) {
  const W = 680, H = 240, P = { l: 44, r: 10, t: 10, b: 24 };
  const all = lines.flatMap((l) => l.pts);
  if (!all.length) return '';
  const xs = all.map((p) => p[0]), ys = all.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const sx = (x) => P.l + (x - x0) / (x1 - x0 || 1) * (W - P.l - P.r);
  const sy = (y) => H - P.b - (y - y0) / (y1 - y0 || 1) * (H - P.t - P.b);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => y0 + (y1 - y0) * t);
  const xt = [0, 0.5, 1].map((t) => x0 + (x1 - x0) * t);
  let hl = '';
  if (highlight && highlight[0] >= x0) hl = `<rect x="${sx(highlight[0])}" y="${P.t}" width="${Math.max(2, sx(highlight[1]) - sx(highlight[0]))}" height="${H - P.t - P.b}" fill="rgba(232,89,12,.12)"><title>最大回撤区间</title></rect>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    ${ticks.map((t) => `<line x1="${P.l}" x2="${W - P.r}" y1="${sy(t)}" y2="${sy(t)}" stroke="#eef0f3"/><text x="${P.l - 6}" y="${sy(t) + 4}" font-size="10" text-anchor="end" fill="#86909c">${fmtY(t)}</text>`).join('')}
    ${xt.map((t, i) => `<text x="${sx(t)}" y="${H - 6}" font-size="10" text-anchor="${i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}" fill="#86909c">${cnDate(t)}</text>`).join('')}
    ${hl}
    ${lines.map((l) => `<polyline fill="none" stroke="${l.color}" stroke-width="1.6" points="${l.pts.map((p) => `${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join(' ')}"/>`).join('')}
  </svg>`;
}

// ---------------- 事件绑定 ----------------
document.addEventListener('click', (ev) => {
  const c = ev.target.closest('[data-ev]');
  if (c) { ev.preventDefault(); ev.stopPropagation(); openEvidence(c.dataset.ev); return; }
  const dimBtn = ev.target.closest('#dimFilter button');
  if (dimBtn) { STATE.dimFilter = dimBtn.dataset.dim || null; renderDimFilter(); renderBoard(); return; }
  const jump = ev.target.closest('a.jump');
  if (jump) { closeDrawer(); return; }
  const q = ev.target.closest('#suggest button, .next button, .oq-ask');
  if (q) { closeDrawer(); $('#question').value = q.dataset.q; window.scrollTo({ top: 0, behavior: 'smooth' }); askAgent(q.dataset.q); }
});
$('#askForm').addEventListener('submit', (e) => { e.preventDefault(); askAgent($('#question').value.trim()); });
$('#drawerClose').addEventListener('click', closeDrawer);
$('#scrim').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
$('#stock').addEventListener('change', (e) => load(e.target.value));
load($('#stock').value);
