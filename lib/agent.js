// 诊断 Agent：规划（选维度）→ 解读（只能引用证据）→ 校验（引用/数字/合规）→ 反思重试 → 兜底。
// 职责边界：数字只来自 evidence.js；LLM 负责理解问题、组织解读、提出待验证问题；校验器负责“不信任 LLM”。
import { DIMENSIONS } from './config.js';
import { chatJSON, llmConfigured } from './llm.js';

const DIM_KEYS = Object.keys(DIMENSIONS);

// ---------- 合规 ----------
const ADVICE_PATTERNS = /(能不能买|可以买吗|能买吗|值得买|该不该买|要不要买|买入|卖出|抄底|加仓|减仓|清仓|止损|止盈|目标价|会涨|会跌|能涨|涨到|跌到|明天|下周.*(涨|跌)|推荐.*股)/;
const BANNED_OUTPUT = /(建议(买入|卖出|持有|增持|减持|加仓|减仓)|买入|卖出|增持|减持|抄底|逃顶|目标价|必涨|必跌|稳赚|翻倍|上涨空间|下跌空间|将会?上涨|将会?下跌|股价会涨|股价会跌|值得投资|不值得投资|强烈推荐)/;

// 合规命中需排除否定语境（如“不提供买入建议”“无法判断能否买入”）
function bannedHit(text) {
  const re = new RegExp(BANNED_OUTPUT.source, 'g');
  let m;
  while ((m = re.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 8), m.index);
    if (!/(不|无|非|勿|未|没有|并非|避免)/.test(before)) return m[0];
  }
  return null;
}

const NEG_WORDS = /(恶化|下滑|承压|走弱|未随|跟不上|偏弱|不足|拖累|压力|风险上升|放缓|下降)/;
const POS_WORDS = /(改善|提升|增强|向好|优于|领先|充裕|稳健|强劲)/;
const TURN_WORDS = /(但|然而|不过|虽然|尽管|同时)/;

// ---------- 规则规划器（LLM 不可用时的兜底，也是 LLM 规划的校验基准） ----------
const KEYWORDS = [
  [/估值|贵|便宜|PE|PB|市盈|市净|性价比/i, ['valuation', 'industry', 'financial_trend']],
  [/业绩|增长|营收|收入|利润|财报|季报|年报|改善/, ['financial_trend', 'operating_quality', 'driver']],
  [/风险|雷|隐患|担心|问题/, ['risk', 'operating_quality', 'market', 'valuation']],
  [/走势|股价|行情|波动|回撤|涨|跌|强势|弱势/, ['market', 'events', 'driver']],
  [/行业|同行|竞争|地位|对手|龙头/, ['industry', 'valuation']],
  [/事件|消息|公告|异动|分红|热度|热榜/, ['events', 'market']],
  [/质量|现金流|ROE|毛利|费用|研发|含金量/i, ['operating_quality', 'financial_trend']],
  [/成交|市场活跃|牛市|熊市|周期|驱动/, ['driver', 'financial_trend', 'market']],
];

export function rulePlan(question, profile) {
  const q = (question || '').trim();
  const advice = ADVICE_PATTERNS.test(q);
  const hits = [];
  for (const [re, dims] of KEYWORDS) if (re.test(q)) for (const d of dims) if (!hits.includes(d)) hits.push(d);
  let dims = hits.length ? hits : [...profile.priority];
  if (advice) dims = Array.from(new Set(['valuation', 'financial_trend', 'risk', ...dims]));
  dims = dims.filter((d) => DIM_KEYS.includes(d) && (d !== 'driver' || profile.priority.includes('driver')));
  return {
    source: 'rule',
    intent: q ? `理解为：${q}` : '全面诊断公司当前状态',
    compliance: advice ? { flag: true, note: '问题涉及买卖决策或涨跌判断。本产品不提供买卖建议或涨跌预测，改为呈现与该决策相关的客观维度：估值、业绩趋势与风险。' } : { flag: false, note: '' },
    clarify: null,
    dimensions: dims.slice(0, 6).map((d) => ({ key: d, reason: hits.includes(d) ? '问题关键词命中' : `公司类型（${profile.type}）的优先维度` })),
  };
}

function catalog(diag) {
  return diag.evidence.map((e) => ({
    id: e.id, dim: e.dim, kind: e.kind, title: e.title, value: e.display, detail: e.detail || '', period: e.period || '',
    polarity: e.polarity, judged_as: { positive: '正面', negative: '负面', neutral: '中性', unknown: '未知' }[e.polarity], rule: e.rule || undefined,
    status: e.status, basis: e.basis || '', reason: e.reason || undefined,
  }));
}

// ---------- LLM 规划 ----------
export async function llmPlan(question, diag, { deadline } = {}) {
  const system = `你是同花顺个股诊断 Agent 的“规划器”。根据用户问题与公司画像，决定本次诊断应优先查看哪些维度。
可选维度（key: 含义）：${DIM_KEYS.map((k) => `${k}: ${DIMENSIONS[k].label}（${DIMENSIONS[k].desc}）`).join('；')}
要求：
1. 输出 JSON：{"intent": "一句话复述用户真正想了解的问题", "compliance": {"flag": bool, "note": "若用户在问买卖/涨跌，说明不提供建议并改为呈现哪些客观维度；否则空字符串"}, "clarify": "问题过于模糊时给出一句追问，否则 null", "dimensions": [{"key": "维度key", "reason": "为何选它（结合问题与公司类型，20字内）"}]}
2. dimensions 选 3–6 个，按重要性排序；公司类型决定默认优先级：${diag.profile.priority.join(' > ')}。
3. 只输出 JSON。`;
  const user = JSON.stringify({ question, company: `${diag.name}（${diag.thscode}）`, profile: { type: diag.profile.type, traits: diag.profile.traits.map((t) => t.label), why: diag.profile.why } });
  const { json, latency_ms, model, attempts } = await chatJSON({ system, user, timeoutMs: 20000, maxTokens: 3000, deadline });
  const dims = (json.dimensions || []).filter((d) => DIM_KEYS.includes(d?.key));
  if (!dims.length) throw Object.assign(new Error('规划结果无有效维度'), { code: 'PLAN_EMPTY' });
  // 合规以规则为准：LLM 漏判时由规则补上
  const ruleAdvice = ADVICE_PATTERNS.test(question || '');
  const compliance = json.compliance?.flag || ruleAdvice
    ? { flag: true, note: json.compliance?.note || rulePlan(question, diag.profile).compliance.note }
    : { flag: false, note: '' };
  return { source: 'llm', model, latency_ms, llm_attempts: attempts, intent: json.intent || question, compliance, clarify: json.clarify || null, dimensions: dims.slice(0, 6) };
}

// ---------- LLM 解读 ----------
const INTERPRET_SYSTEM = `你是同花顺个股诊断 Agent 的“解读器”，面向普通投资者。你只能基于提供的“证据清单”进行解读。
硬性规则：
1. 每条陈述都必须在 evidence_ids 中引用至少 1 个证据 ID；只能引用清单里存在的 ID。
2. 不得写出证据中没有的数字；如需引用数字，原样使用证据 value/detail 中的写法。
3. 每条陈述标注 type：fact（直接复述证据）或 inference（基于证据的推断）。inference 必须给出 confidence（高/中/低），并在文本中体现推理依据。
4. 每条证据带有 judged_as（规则判定的正/负/中性）与 rule（判定规则）。复述时措辞方向必须与 judged_as 一致，不得把正面证据说成负面或反之；若你认为规则判定不妥，应写成 inference 并说明理由。\n5. status 为 missing/error/conflict 的证据代表“未知”，不得当作正常结论使用，只能写进 unknowns。
6. 严禁：买卖建议、目标价、涨跌预测、收益承诺、“值得/不值得投资”等结论；不要给公司打“好/坏”标签。正负证据和矛盾要并列呈现。
7. 中文，简洁，每条陈述不超过 60 字。
输出 JSON：
{
 "headline": "一句话描述公司当前状态（中性、不打标签，需引用证据）", "headline_ids": ["证据ID"],
 "answer": [{"text": "针对用户问题的直接回应", "type": "fact|inference", "confidence": "高|中|低", "evidence_ids": ["..."]}],
 "dimensions": [{"key": "维度key", "points": [{"text": "...", "type": "fact|inference", "confidence": "高|中|低", "evidence_ids": ["..."]}]}],
 "tensions": [{"text": "相互矛盾的证据及其含义", "evidence_ids": ["至少2个"]}],
 "unknowns": [{"text": "当前无法判断的事项及原因", "evidence_ids": ["..."]}],
 "next_steps": [{"question": "建议用户继续研究的问题", "why": "原因", "evidence_ids": ["..."]}]
}`;

export async function llmInterpret(question, plan, diag, { feedback = null, timeoutMs = 35000, deadline } = {}) {
  const dimKeys = plan.dimensions.map((d) => d.key);
  const ev = catalog(diag).filter((e) => dimKeys.includes(e.dim) || e.dim === 'risk' || e.status !== 'ok');
  const user = JSON.stringify({
    question: question || '请全面诊断这家公司当前的状态',
    company: `${diag.name}（${diag.thscode}），${diag.preset.industry_label}`,
    company_type: diag.profile.type,
    plan: plan.dimensions,
    compliance_note: plan.compliance.flag ? plan.compliance.note : undefined,
    evidence: ev,
    rule_contradictions: diag.contradictions.map((c) => ({ title: c.title, refs: c.refs })),
    rule_risks: diag.risks.map((r) => ({ title: r.title, refs: r.refs })),
    ...(feedback ? { revise_instructions: `上一版输出未通过校验，请逐条修正后重新输出完整 JSON：\n${feedback}` } : {}),
  });
  const { json, latency_ms, model, usage, attempts } = await chatJSON({ system: INTERPRET_SYSTEM, user, timeoutMs, maxTokens: 12000, deadline });
  return { json, latency_ms, model, usage, attempts };
}

// ---------- 定点修复（反思） ----------
function getAt(obj, path) {
  return path.split('.').reduce((o, seg) => {
    if (!o) return undefined;
    const m = seg.match(/^(\w+)\[(\d+)\]$/);
    return m ? o[m[1]]?.[Number(m[2])] : o[seg];
  }, obj);
}

export async function llmRepair(out, report, diag, { timeoutMs = 25000, deadline } = {}) {
  const bad = new Map();
  for (const i of report.issues.filter((x) => !x.minor)) {
    if (!bad.has(i.path)) bad.set(i.path, { path: i.path, text: i.text, problems: [] });
    bad.get(i.path).problems.push(i.detail);
  }
  const ids = new Set();
  for (const b of bad.values()) {
    const st = b.path === 'headline' ? { evidence_ids: out.headline_ids } : getAt(out, b.path);
    (st?.evidence_ids || []).forEach((x) => ids.add(x));
  }
  const evidence = catalog(diag).filter((e) => ids.has(e.id) || ids.size === 0);
  const system = `你是同花顺个股诊断 Agent 的“修复器”。下面是未通过校验的陈述及问题，请逐条修复：只能使用给出的证据与其中的数字；措辞方向与 judged_as 一致；不得出现买卖建议、目标价、涨跌预测（否定句也尽量避免出现“买入/卖出”字样）；无法修复的陈述返回 drop=true。
输出 JSON：{"fixes": [{"path": "原 path", "drop": false, "text": "修复后的陈述", "type": "fact|inference", "confidence": "高|中|低", "evidence_ids": ["..."]}]}`;
  const user = JSON.stringify({ to_fix: [...bad.values()], evidence });
  const { json, latency_ms, model } = await chatJSON({ system, user, timeoutMs, maxTokens: 4000, deadline });
  const patched = JSON.parse(JSON.stringify(out));
  let count = 0;
  for (const f of json.fixes || []) {
    if (!bad.has(f.path)) continue;
    if (f.path === 'headline') {
      if (!f.drop && f.text) { patched.headline = f.text; patched.headline_ids = f.evidence_ids || patched.headline_ids; count++; }
      continue;
    }
    const target = getAt(patched, f.path);
    if (!target) continue;
    if (f.drop) { target.__drop = true; count++; continue; }
    if (f.text) {
      if ('question' in target) target.question = f.text; else target.text = f.text;
      if (f.evidence_ids?.length) target.evidence_ids = f.evidence_ids;
      if (f.type && 'type' in target) target.type = f.type;
      if (f.confidence) target.confidence = f.confidence;
      count++;
    }
  }
  const keep = (arr) => (arr || []).filter((x) => !x.__drop);
  patched.answer = keep(patched.answer);
  patched.tensions = keep(patched.tensions);
  patched.unknowns = keep(patched.unknowns);
  patched.next_steps = keep(patched.next_steps);
  patched.dimensions = (patched.dimensions || []).map((d) => ({ ...d, points: keep(d.points) }));
  return { patched, count, latency_ms, model };
}

// ---------- 校验器 ----------
function statements(out) {
  const s = [];
  if (out.headline) s.push({ path: 'headline', text: out.headline, evidence_ids: out.headline_ids || [], type: 'inference' });
  (out.answer || []).forEach((x, i) => s.push({ path: `answer[${i}]`, ...x }));
  (out.dimensions || []).forEach((d, i) => (d.points || []).forEach((x, j) => s.push({ path: `dimensions[${i}].points[${j}]`, ...x })));
  (out.tensions || []).forEach((x, i) => s.push({ path: `tensions[${i}]`, ...x, type: 'tension' }));
  (out.unknowns || []).forEach((x, i) => s.push({ path: `unknowns[${i}]`, ...x, type: 'unknown' }));
  (out.next_steps || []).forEach((x, i) => s.push({ path: `next_steps[${i}]`, text: `${x.question} ${x.why || ''}`, evidence_ids: x.evidence_ids, type: 'next' }));
  return s;
}

function numbersIn(text) {
  return (String(text).match(/[-+]?\d+(?:\.\d+)?/g) || [])
    .map((n) => n.replace(/^\+/, ''))
    .filter((n) => {
      const v = Math.abs(Number(n));
      if (/^\d{4}$/.test(n) && v >= 2000 && v <= 2100) return false; // 年份
      if (Number.isInteger(v) && v <= 12) return false; // 小整数（期数、排名、月份）
      return true;
    });
}

function evidenceText(e) {
  return [e.title, e.display, e.detail, e.period, e.basis, e.reason, e.rule, String(e.value ?? '')].join(' ');
}

function numberSupported(n, cited) {
  const v = Math.abs(Number(n));
  for (const e of cited) {
    const txt = evidenceText(e);
    const nums = (txt.match(/[-+]?\d+(?:\.\d+)?/g) || []).map((x) => Math.abs(Number(x)));
    if (nums.some((x) => Math.abs(x - v) <= Math.max(0.051, Math.abs(x) * 0.005))) return true;
    if (typeof e.value === 'number' && [0, 1, 2].some((d) => Math.abs(Math.abs(Number(e.value.toFixed(d))) - v) < 1e-9)) return true;
  }
  return false;
}

export function verify(out, diag) {
  const byId = new Map(diag.evidence.map((e) => [e.id, e]));
  const issues = [];
  const all = statements(out);
  for (const s of all) {
    const ids = Array.isArray(s.evidence_ids) ? s.evidence_ids : [];
    if (!ids.length) { issues.push({ path: s.path, type: 'no_citation', text: s.text, detail: '没有引用任何证据' }); continue; }
    const unknownIds = ids.filter((id) => !byId.has(id));
    if (unknownIds.length) issues.push({ path: s.path, type: 'bad_citation', text: s.text, detail: `引用了不存在的证据：${unknownIds.join(',')}` });
    const cited = ids.map((id) => byId.get(id)).filter(Boolean);
    if (s.type !== 'unknown' && s.type !== 'next') {
      const bad = cited.filter((e) => e.status === 'missing' || e.status === 'error');
      if (bad.length && bad.length === cited.length) issues.push({ path: s.path, type: 'unknown_as_fact', text: s.text, detail: `把缺失数据（${bad.map((e) => e.id).join(',')}）当作结论依据` });
    }
    for (const n of numbersIn(s.text)) {
      if (!numberSupported(n, cited)) issues.push({ path: s.path, type: 'unsupported_number', text: s.text, detail: `数字 ${n} 在所引用证据中找不到` });
    }
    if (s.type === 'fact' || s.type === 'inference') {
      const pols = new Set(cited.filter((e) => e.status === 'ok').map((e) => e.polarity));
      if (pols.size === 1 && pols.has('positive') && NEG_WORDS.test(s.text) && !TURN_WORDS.test(s.text)) issues.push({ path: s.path, type: 'direction_mismatch', text: s.text, detail: `措辞偏负面（“${s.text.match(NEG_WORDS)[0]}”），但所引证据均被规则判定为正面，方向可能读反` });
      if (pols.size === 1 && pols.has('negative') && POS_WORDS.test(s.text) && !TURN_WORDS.test(s.text)) issues.push({ path: s.path, type: 'direction_mismatch', text: s.text, detail: `措辞偏正面（“${s.text.match(POS_WORDS)[0]}”），但所引证据均被规则判定为负面，方向可能读反` });
    }
    const banned = bannedHit(s.text);
    if (banned) issues.push({ path: s.path, type: 'compliance', text: s.text, detail: `命中合规禁用表述：“${banned}”` });
    if (s.type === 'inference' && !s.confidence && !s.path.startsWith('headline')) issues.push({ path: s.path, type: 'no_confidence', text: s.text, detail: '推断缺少置信度', minor: true });
    if (s.type === 'tension' && ids.length < 2) issues.push({ path: s.path, type: 'weak_tension', text: s.text, detail: '矛盾陈述应至少引用 2 条证据', minor: true });
  }
  const major = issues.filter((i) => !i.minor);
  return { passed: major.length === 0, statements: all.length, issues, major: major.length, minor: issues.length - major.length };
}

// 未通过校验的陈述：不静默删除，而是打上标记交给前端显式提示
function annotate(out, report) {
  const flagged = new Map();
  for (const i of report.issues.filter((x) => !x.minor)) {
    if (!flagged.has(i.path)) flagged.set(i.path, []);
    flagged.get(i.path).push(i.detail);
  }
  const mark = (obj, path) => (flagged.has(path) ? { ...obj, flags: flagged.get(path) } : obj);
  return {
    ...out,
    headline_flags: flagged.get('headline') || null,
    answer: (out.answer || []).map((x, i) => mark(x, `answer[${i}]`)),
    dimensions: (out.dimensions || []).map((d, i) => ({ ...d, points: (d.points || []).map((x, j) => mark(x, `dimensions[${i}].points[${j}]`)) })),
    tensions: (out.tensions || []).map((x, i) => mark(x, `tensions[${i}]`)),
    unknowns: out.unknowns || [],
    next_steps: (out.next_steps || []).map((x, i) => mark(x, `next_steps[${i}]`)),
  };
}

// ---------- 模板兜底（LLM 不可用时，仍输出“只有事实、没有推断”的结构化结果） ----------
export function templateInterpret(plan, diag) {
  const ok = diag.evidence.filter((e) => e.status === 'ok');
  const dims = plan.dimensions.map((d) => ({
    key: d.key,
    points: ok.filter((e) => e.dim === d.key).slice(0, 5).map((e) => ({ text: `${e.title}：${e.display}`, type: 'fact', evidence_ids: [e.id] })),
  }));
  return {
    headline: `${diag.name}：正面证据 ${diag.stats.positive} 条、负面证据 ${diag.stats.negative} 条、矛盾 ${diag.contradictions.length} 组、未知 ${diag.stats.unknown} 项（AI 解读不可用，仅展示事实）`,
    headline_ids: [],
    answer: [],
    dimensions: dims,
    tensions: diag.contradictions.map((c) => ({ text: `${c.title}：${c.explain}`, evidence_ids: c.refs })),
    unknowns: diag.open_questions.slice(0, 4).map((q) => ({ text: `${q.question}（${q.why}）`, evidence_ids: q.refs })),
    next_steps: [],
  };
}

// ---------- 主流程 ----------
export async function runAgent(question, diag, { deadlineMs = 55000 } = {}) {
  const t0 = Date.now();
  const trace = [];
  const step = (name, status, extra = {}) => trace.push({ step: name, status, at_ms: Date.now() - t0, ...extra });

  // 1. 规划
  let plan;
  if (llmConfigured()) {
    try { plan = await llmPlan(question, diag, { deadline: t0 + deadlineMs }); step('plan', 'ok', { source: 'llm', model: plan.model, latency_ms: plan.latency_ms, llm_attempts: plan.llm_attempts, dimensions: plan.dimensions.map((d) => d.key) }); }
    catch (e) { plan = rulePlan(question, diag.profile); step('plan', 'fallback', { source: 'rule', error: e.message, llm_attempts: e.attempts }); }
  } else { plan = rulePlan(question, diag.profile); step('plan', 'fallback', { source: 'rule', error: '未配置 LLM_API_KEY' }); }

  // 2. 解读 + 3. 校验 + 4. 反思重试（最多 1 次）
  if (!llmConfigured()) {
    const out = templateInterpret(plan, diag);
    step('interpret', 'fallback', { source: 'template', error: '未配置 LLM_API_KEY' });
    return { plan, interpretation: out, verification: { ...verify(out, diag), mode: 'template' }, trace, mode: 'template' };
  }
  let out, report, lastErr = null, repairs = 0;
  for (let attempt = 1; attempt <= 2 && !out; attempt++) {
    const remain = deadlineMs - (Date.now() - t0);
    if (remain < 15000) { step('interpret', 'skipped', { attempt, error: '剩余时间不足，停止重试' }); break; }
    try {
      const r = await llmInterpret(question, plan, diag, { timeoutMs: Math.min(40000, remain - 2000), deadline: t0 + deadlineMs });
      out = r.json;
      step('interpret', 'ok', { attempt, latency_ms: r.latency_ms, model: r.model, tokens: r.usage?.total_tokens, llm_attempts: r.attempts });
    } catch (e) {
      lastErr = e;
      step('interpret', 'error', { attempt, error: e.message, llm_attempts: e.attempts });
    }
  }
  if (out) {
    report = verify(out, diag);
    step('verify', report.passed ? 'pass' : 'fail', { attempt: 1, statements: report.statements, major: report.major, minor: report.minor, issues: report.issues.slice(0, 12) });
    // 反思：只把未通过的陈述 + 校验意见交给 LLM 定点修复（比整篇重写更快、更不容易引入新错误）
    if (!report.passed) {
      const remain = deadlineMs - (Date.now() - t0);
      if (remain < 8000) step('reflect', 'skipped', { error: '剩余时间不足，保留原输出并在问题陈述旁标注' });
      else {
        try {
          const r = await llmRepair(out, report, diag, { timeoutMs: Math.min(25000, remain - 1500), deadline: t0 + deadlineMs });
          out = r.patched;
          repairs = r.count;
          step('reflect', 'repair', { attempt: 1, latency_ms: r.latency_ms, model: r.model, reason: `定点修复 ${r.count} 条陈述` });
          report = verify(out, diag);
          step('verify', report.passed ? 'pass' : 'fail', { attempt: 2, statements: report.statements, major: report.major, minor: report.minor, issues: report.issues.slice(0, 12) });
        } catch (e) {
          step('reflect', 'error', { error: e.message, llm_attempts: e.attempts });
        }
      }
    }
  }
  if (!out) {
    const fb = templateInterpret(plan, diag);
    step('fallback', 'template', { error: lastErr?.message || '解读失败' });
    return { plan, interpretation: fb, verification: { ...verify(fb, diag), mode: 'template' }, trace, mode: 'template' };
  }
  return { plan, interpretation: annotate(out, report), verification: { ...report, attempts: repairs ? 2 : 1, repaired: repairs }, trace, mode: 'llm' };
}
