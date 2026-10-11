// 诊断 Agent：规划（选维度）→ 解读（只能引用证据）→ 校验（引用/数字/合规）→ 反思重试 → 兜底。
// 职责边界：数字只来自 evidence.js；LLM 负责理解问题、组织解读、提出待验证问题；校验器负责“不信任 LLM”。
import { DIMENSIONS } from './config.js';
import { chatJSON, llmConfigured } from './llm.js';

const DIM_KEYS = Object.keys(DIMENSIONS);

// ---------- 合规 ----------
const ADVICE_PATTERNS = /(能不能买|可以买吗|能买吗|值得买|该不该买|要不要买|买入|卖出|抄底|加仓|减仓|清仓|止损|止盈|目标价|会涨|会跌|能涨|涨到|跌到|明天|下周.*(涨|跌)|推荐.*股)/;
// 买卖建议 / 涨跌预测 / 收益承诺 / 好坏标签
// 只拦“操作建议 / 涨跌预测 / 收益承诺 / 好坏标签”这类短语；单个中性词（持有现金、业务布局、股价曾反弹）不拦
const BANNED_OUTPUT = /(建议(买入|卖出|持有|增持|减持|加仓|减仓|观望|关注)|买入|卖出|增持|减持|加仓|减仓|建仓|清仓|抄底|逃顶|目标价|必涨|必跌|稳赚|翻倍|上涨空间|下跌空间|上行空间|下行空间|上升空间|上涨潜力|上涨概率|(将|会|可能|预计.{0,4})(上涨|下跌|走高|走低|反弹|见底)|股价会涨|股价会跌|值得投资|投资价值|强烈推荐|看涨|看多|看空|看跌|看好|看淡|逢低|(提前|适时)布局|布局机会|(适当|可以|建议)配置|配置价值|(继续|长期|可以|可|建议|值得)持有|拿着|入手|上车|低吸|高抛|止盈|止损|追高|买点|卖点|可以买|安全边际|估值合理|估值洼地|性价比|收益可期|有望(上涨|反弹|走强|回升|修复|企稳|走出|见底)|大概率(上涨|下跌|反弹)|好公司|好股票|坏公司|优秀(的)?公司|优质(公司|股|标的)|白马股|劣质|低估|高估(?!值)|便宜|偏贵|护城河|前景(广阔|向好|光明)|拐点已现|迎来拐点)/;

// 否定豁免只认固定短语（如“不提供买入建议”“不构成投资建议”），“不建议卖出”这类隐含持有建议的说法不豁免
const NEGATION_OK = /(不提供|不构成|不给出|不作出|不做出|无法判断|不代表|不涉及|不对.{0,6}作)/;
export function bannedHit(text) {
  const re = new RegExp(BANNED_OUTPUT.source, 'g');
  let m;
  while ((m = re.exec(String(text || '')))) {
    // 否定豁免的作用域：同一分句内、命中词之前（如“不提供买入、持有或卖出建议”）
    const clauseStart = Math.max(...['，', '。', '；', ',', ';', '！', '？', '\n'].map((c) => text.lastIndexOf(c, m.index - 1))) + 1;
    const before = text.slice(Math.max(clauseStart, m.index - 20), m.index);
    if (!NEGATION_OK.test(before)) return m[0];
  }
  return null;
}

// 事实陈述中出现评价/推断性措辞 → 确定性改判为推断
const EVAL_WORDS = /(偏高|偏低|强劲|疲弱|缩量|放量|改善|恶化|意味|表明|说明|显示出|可能|或许|大概|较为|明显|显著|敏感|稳健|承压|有限|充足|良好|较好|较差|偏正面|偏负面|偏平|主要(来自|由于|因为|得益|受)|来自于|由于|因为|导致|由.{0,10}驱动|驱动因素|弹性|需持续|值得关注|反映出|体现出)/;
// “声称证据缺失”的措辞：若所引证据并非缺失，说明 LLM 把已知说成了未知
const MISSING_CLAIM = /(未出现|未提供|没有提供|清单(中)?(没有|无|未)|缺少相关证据|无法评述|没有.{0,6}证据)/;
// 陈述本身在说“未知/缺失”时，引用缺失证据是正当的
const UNKNOWN_WORDS = /(缺失|无法|未接入|不可用|待验证|不可比|冲突|不一致|未知|暂无)/;

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
  const full = !q; // 全面诊断：覆盖公司类型下的全部维度
  return {
    source: 'rule',
    intent: q ? `理解为：${q}` : '全面诊断公司当前状态',
    compliance: advice ? { flag: true, note: '问题涉及买卖决策或涨跌判断。本产品不提供买卖建议或涨跌预测，改为呈现与该决策相关的客观维度：估值、业绩趋势与风险。' } : { flag: false, note: '' },
    clarify: null,
    dimensions: dims.slice(0, full ? 8 : 6).map((d) => ({ key: d, reason: hits.includes(d) ? '问题关键词命中' : full ? `全面诊断，按公司类型（${profile.type}）排序` : `公司类型（${profile.type}）的优先维度` })),
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
  let dims = (json.dimensions || []).filter((d) => DIM_KEYS.includes(d?.key) && (d.key !== 'driver' || diag.profile.priority.includes('driver')));
  if (!dims.length) throw Object.assign(new Error('规划结果无有效维度'), { code: 'PLAN_EMPTY' });
  // 规则命中的维度必须保留：LLM 只能排序或追加，不能漏掉（避免“问风险却没看经营质量”）
  const rp = rulePlan(question, diag.profile);
  const mustHave = rp.dimensions.filter((d) => d.reason === '问题关键词命中' || (rp.compliance.flag && ['valuation', 'financial_trend', 'risk'].includes(d.key)));
  for (const d of mustHave) if (!dims.some((x) => x.key === d.key)) dims.push({ key: d.key, reason: '规则补齐：问题关键词命中' });
  dims = dims.slice(0, 7);
  // 合规以规则为准：LLM 漏判时由规则补上
  const ruleAdvice = ADVICE_PATTERNS.test(question || '');
  const compliance = json.compliance?.flag || ruleAdvice
    ? { flag: true, note: json.compliance?.note || rulePlan(question, diag.profile).compliance.note }
    : { flag: false, note: '' };
  return { source: 'llm', model, latency_ms, llm_attempts: attempts, intent: json.intent || question, compliance, clarify: json.clarify || null, dimensions: dims };
}

// 规划器输出的文字同样要过合规检查（意图、维度理由、合规说明、追问）
export function sanitizePlan(plan, question, profile) {
  const hits = [];
  const fallback = rulePlan(question, profile);
  const check = (txt, path) => { const h = bannedHit(txt); if (h) hits.push({ path, hit: h }); return !h; };
  const mask = (txt) => { let t = txt; for (let i = 0; i < 5; i++) { const h = bannedHit(t); if (!h) break; t = t.replace(h, '［已隐去］'); } return t; };
  if (!check(plan.intent, 'intent')) plan.intent = plan.compliance?.flag ? '用户询问买卖或涨跌相关问题（已改为呈现与之相关的客观维度）' : mask(plan.intent);
  if (plan.compliance?.note && !check(plan.compliance.note, 'compliance.note')) plan.compliance.note = fallback.compliance.note || '本产品不提供买卖建议或涨跌预测。';
  if (plan.clarify && !check(plan.clarify, 'clarify')) plan.clarify = mask(plan.clarify);
  plan.dimensions = plan.dimensions.map((d, i) => (check(d.reason, `dimensions[${i}].reason`) ? d : { ...d, reason: mask(d.reason) }));
  return hits;
}

// ---------- LLM 解读 ----------
const INTERPRET_SYSTEM = `你是同花顺个股诊断 Agent 的“解读器”，面向普通投资者。你只能基于提供的“证据清单”进行解读。
硬性规则：
1. 每条陈述都必须在 evidence_ids 中引用至少 1 个证据 ID；只能引用清单里存在的 ID。
2. 不得写出证据中没有的数字；如需引用数字，原样使用证据 value/detail 中的写法。
3. 每条陈述标注 type：fact（直接复述证据）或 inference（基于证据的推断）。inference 必须给出 confidence（高/中/低），并在文本中体现推理依据。
4. 每条证据带有 judged_as（规则判定的正/负/中性）与 rule（判定规则）。复述时措辞方向必须与 judged_as 一致，不得把正面证据说成负面或反之；若你认为规则判定不妥，应写成 inference 并说明理由。\n5. status 为 missing/error/conflict 的证据代表“未知”，不得当作正常结论使用，只能写进 unknowns。status 为 stale 的证据来自快照/缓存，可以使用，但涉及它的陈述须写明“截至/快照”时点。
6. 严禁：买卖建议、目标价、涨跌预测、收益承诺、“值得/不值得投资”等结论；不要给公司打“好/坏”标签（如好公司、优质、低估、高估、便宜、护城河）。正负证据和矛盾要并列呈现。
8. 用户问风险时，必须覆盖 rule_risk_checks 中 triggered=true 的风险、所有 judged_as=负面 的证据，以及未知/冲突项；triggered=false 的规则只能写成“已检查、未触发”，不得列为风险；提到风险条数时以 triggered=true 的数量为准；不得声称清单中“没有”某类证据而实际存在。
7. 中文，简洁，每条陈述不超过 60 字。数量上限：answer ≤6 条，每个维度 points ≤4 条，tensions ≤4，unknowns ≤4，next_steps ≤4。宁少勿多，不要逐条复述看板，优先写证据之间的关系。
9. 提到估值倍数时，区分“估值本身（如 PE 41.27 倍）”和“相对同行中位数的倍数（如为中位数的 0.47 倍）”，不得混用。描述增速变化时，以单季口径证据（F3 利润、F6 营收）为准，营收与利润的方向要分开说。
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
  // 除计划维度外，始终带上：负面证据、非正常状态证据、矛盾与风险规则所引用的证据（避免“问风险却拿不到估值/行情证据”）
  const refUsed = new Set([...diag.contradictions.flatMap((c) => c.refs), ...(diag.risk_checks || []).flatMap((c) => c.refs)]);
  const ev = catalog(diag).filter((e) => dimKeys.includes(e.dim) || e.status !== 'ok' || e.polarity === 'negative' || refUsed.has(e.id));
  const user = JSON.stringify({
    question: question || '请全面诊断这家公司当前的状态',
    company: `${diag.name}（${diag.thscode}），${diag.preset.industry_label}`,
    company_type: diag.profile.type,
    plan: plan.dimensions,
    compliance_note: plan.compliance.flag ? plan.compliance.note : undefined,
    evidence: ev,
    rule_contradictions: diag.contradictions.map((c) => ({ title: c.title, refs: c.refs })),
    rule_risk_checks: (diag.risk_checks || []).map((r) => ({ title: r.title, triggered: r.triggered, rule: r.rule, refs: r.refs })),
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
  const dropped = [];
  for (const f of json.fixes || []) {
    if (!bad.has(f.path)) continue;
    if (f.path === 'headline') {
      if (!f.drop && f.text) { patched.headline = f.text; patched.headline_ids = f.evidence_ids || patched.headline_ids; count++; }
      continue;
    }
    const target = getAt(patched, f.path);
    if (!target) continue;
    if (f.drop) { target.__drop = true; dropped.push({ path: f.path, problems: bad.get(f.path).problems }); count++; continue; }
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
  return { patched, count, dropped, latency_ms, model };
}

// ---------- 校验器 ----------
function statements(out) {
  const s = [];
  if (out.headline && !out.headline_system) s.push({ path: 'headline', text: out.headline_body || out.headline, evidence_ids: out.headline_ids || [], type: 'inference' });
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

function evidenceText(e, withRule) {
  return [e.title, e.display, e.detail, e.period, e.basis, e.reason, withRule ? e.rule : '', String(e.value ?? '')].join(' ');
}

// 规则阈值（如 0.6、50%）只有在陈述明确谈“规则/阈值/标准”时才算有依据
function numberSupported(n, cited, text = '') {
  const v = Math.abs(Number(n));
  const withRule = /(规则|阈值|标准|门槛|判定线)/.test(text);
  for (const e of cited) {
    const txt = evidenceText(e, withRule);
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
    if (s.type !== 'unknown' && s.type !== 'next' && !UNKNOWN_WORDS.test(s.text)) {
      const bad = cited.filter((e) => ['missing', 'error', 'conflict'].includes(e.status));
      if (bad.length && bad.length === cited.length) issues.push({ path: s.path, type: 'unknown_as_fact', text: s.text, detail: `把缺失/失败/冲突数据（${bad.map((e) => e.id).join(',')}）当作结论依据` });
    }
    if ((s.type === 'fact' || s.type === 'inference') && MISSING_CLAIM.test(s.text) && !/(历史|分位|分部|构成|原因|公告|新闻|研报|原文|单季|明细|管理层)/.test(s.text) && cited.length && cited.some((e) => e.status === 'ok' || e.status === 'stale')) {
      issues.push({ path: s.path, type: 'false_missing_claim', text: s.text, detail: `声称证据缺失/未提供（“${s.text.match(MISSING_CLAIM)[0]}”），但所引证据并未缺失；请核对看板，可能把已有数据说成了没有` });
    }
    if (!out.template && (s.type === 'fact' || s.type === 'inference') && cited.length && cited.every((e) => e.status === 'stale') && !/(快照|过期|截至|缓存)/.test(s.text)) {
      issues.push({ path: s.path, type: 'stale_unmarked', text: s.text, detail: '所引证据均为快照/过期数据，陈述未注明时点（页面已在解读区顶部统一提示）', minor: true });
    }
    for (const n of numbersIn(s.text)) {
      if (!numberSupported(n, cited, s.text)) issues.push({ path: s.path, type: 'unsupported_number', text: s.text, detail: `数字 ${n} 在所引用证据中找不到` });
    }
    if (s.type === 'fact' || s.type === 'inference') {
      const pols = new Set(cited.filter((e) => e.status === 'ok' || e.status === 'stale').map((e) => e.polarity));
      if (pols.size === 1 && pols.has('positive') && NEG_WORDS.test(s.text) && !TURN_WORDS.test(s.text)) issues.push({ path: s.path, type: 'direction_mismatch', text: s.text, detail: `措辞偏负面（“${s.text.match(NEG_WORDS)[0]}”），但所引证据均被规则判定为正面，方向可能读反` });
      if (pols.size === 1 && pols.has('negative') && POS_WORDS.test(s.text) && !TURN_WORDS.test(s.text)) issues.push({ path: s.path, type: 'direction_mismatch', text: s.text, detail: `措辞偏正面（“${s.text.match(POS_WORDS)[0]}”），但所引证据均被规则判定为负面，方向可能读反` });
    }
    // 营收/利润的方向必须与单季口径证据一致（全局检查，不依赖 LLM 是否引用了 F6/F3）
    if ((s.type === 'fact' || s.type === 'inference' || s.path === 'headline') && s.type !== 'unknown') {
      const f6 = byId.get('F6'), f3 = byId.get('F3');
      if (f6 && ['ok', 'stale'].includes(f6.status) && f6.value > 5 && /(营收|收入)[^，。；,;]{0,12}(放缓|回落|减速|走弱|下滑)/.test(s.text) && !/单季利润|利润[^，。；]{0,4}(放缓|回落|减速)/.test(s.text.match(/(营收|收入)[^，。；,;]{0,12}/)?.[0] || '')) {
        issues.push({ path: s.path, type: 'direction_mismatch', text: s.text, detail: `营收增速实际在加速（F6：${f6.display.split(' ← ').slice(0, 2).join(' ← ')}），陈述却说营收放缓/回落` });
      }
      if (f3 && ['ok', 'stale'].includes(f3.status) && f3.value < -5 && /(利润|净利)[^，。；,;]{0,8}(加速|提速|走强)/.test(s.text)) {
        issues.push({ path: s.path, type: 'direction_mismatch', text: s.text, detail: `单季利润增速实际在放缓（F3），陈述却说利润加速` });
      }
    }
    const banned = bannedHit(s.text);
    if (banned) issues.push({ path: s.path, type: 'compliance', text: s.text, detail: `命中合规禁用表述：“${banned}”` });
    if (s.type === 'inference' && !s.confidence && !s.path.startsWith('headline')) issues.push({ path: s.path, type: 'no_confidence', text: s.text, detail: '推断缺少置信度', minor: true });
    if (s.type === 'tension' && ids.length < 2) issues.push({ path: s.path, type: 'weak_tension', text: s.text, detail: '矛盾陈述应至少引用 2 条证据', minor: true });
  }
  const major = issues.filter((i) => !i.minor);
  return { passed: major.length === 0, statements: all.length, issues, major: major.length, minor: issues.length - major.length };
}

// 未通过校验的陈述：打上标记交给前端显式提示；合规问题隐去原文（修复时被删除的陈述另行计数并说明原因）
export function annotate(out, report) {
  const flagged = new Map();
  for (const i of report.issues.filter((x) => !x.minor)) {
    if (!flagged.has(i.path)) flagged.set(i.path, []);
    flagged.get(i.path).push(i.detail);
  }
  const compliancePaths = new Set(report.issues.filter((x) => x.type === 'compliance').map((x) => x.path));
  const MASK = '（此句因合规校验未通过已隐去）';
  const mark = (obj, path) => {
    if (!flagged.has(path)) return obj;
    const o = { ...obj, flags: flagged.get(path) };
    if (compliancePaths.has(path)) { if ('question' in o) o.question = MASK; o.text = MASK; o.why = ''; o.masked = true; }
    return o;
  };
  const headlineMasked = compliancePaths.has('headline');
  return {
    ...out,
    headline: headlineMasked ? MASK : out.headline,
    headline_flags: flagged.get('headline') || null,
    answer: (out.answer || []).map((x, i) => mark(x, `answer[${i}]`)),
    dimensions: (out.dimensions || []).map((d, i) => ({ ...d, points: (d.points || []).map((x, j) => mark(x, `dimensions[${i}].points[${j}]`)) })),
    tensions: (out.tensions || []).map((x, i) => mark(x, `tensions[${i}]`)),
    unknowns: (out.unknowns || []).map((x, i) => mark(x, `unknowns[${i}]`)),
    next_steps: (out.next_steps || []).map((x, i) => mark(x, `next_steps[${i}]`)),
  };
}

// 事实 → 推断的确定性改判（LLM 自报的 type 不可全信）
export function relabel(out, diag = null) {
  let n = 0;
  const byId = new Map((diag?.evidence || []).map((e) => [e.id, e]));
  const fix = (x) => {
    if (!x) return x;
    if (!['fact', 'inference'].includes(x.type)) { n++; return { ...x, type: 'inference', confidence: x.confidence || '低', relabeled: '类型缺失或非法，系统按推断处理' }; }
    if (x.type !== 'fact') return x;
    // 先去掉与所引证据原文重合的片段（标题、取值、口径、规则），避免把证据原文里的词当成 LLM 的评价
    let cleaned = String(x.text || '');
    for (const e of (x.evidence_ids || []).map((id) => byId.get(id)).filter(Boolean)) {
      for (const frag of [e.title, e.display, e.detail, e.basis, e.rule].join('；').split(/[；;，,。（）()]/).map((f) => f.trim()).filter((f) => f.length >= 4)) cleaned = cleaned.split(frag).join(' ');
    }
    if (EVAL_WORDS.test(cleaned)) { n++; return { ...x, type: 'inference', confidence: x.confidence || '中', relabeled: `含评价性措辞“${cleaned.match(EVAL_WORDS)[0]}”，系统改判为推断` }; }
    const op = (x.evidence_ids || []).map((id) => byId.get(id)).find((e) => e && (e.kind === 'opinion' || e.kind === 'derived'));
    if (op) { n++; return { ...x, type: 'inference', confidence: x.confidence || '中', relabeled: `引用了${op.kind === 'opinion' ? '观点类' : '派生'}证据 ${op.id}，系统改判为推断` }; }
    return x;
  };
  out.answer = (out.answer || []).map(fix);
  out.dimensions = (out.dimensions || []).map((d) => ({ ...d, points: (d.points || []).map(fix) }));
  return n;
}

function staleNotice(diag) {
  const stale = diag.evidence.filter((e) => e.status === 'stale');
  if (!stale.length) return null;
  const total = diag.evidence.length;
  const snap = stale.filter((e) => (e.sources || []).some((s) => s.cache === 'snapshot' || s.cache === 'stale'));
  const parts = [];
  if (snap.length) {
    const ts = snap.flatMap((e) => e.sources || []).filter((s) => (s.cache === 'snapshot' || s.cache === 'stale') && s.fetched_at).map((s) => s.fetched_at);
    const when = ts.length ? new Date(Math.min(...ts) + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') : '较早时间';
    const word = snap.length === total ? '全部' : snap.length >= total * 0.6 ? '大部分' : '部分';
    parts.push(`${word}证据（${snap.length}/${total} 条）因实时调用失败，使用 ${when} 抓取的快照/缓存`);
  }
  const aged = stale.length - snap.length;
  if (aged) parts.push(`${aged} 条行情证据的最新 K 线较旧（如遇长假休市属正常）`);
  return `【${parts.join('；')}，可能过期】`;
}

// ---------- 模板兜底（LLM 不可用时，仍输出“只有事实、没有推断”的结构化结果） ----------
export function templateInterpret(plan, diag) {
  const ok = diag.evidence.filter((e) => e.status === 'ok' || e.status === 'stale');
  const triggered = (diag.risk_checks || []).filter((c) => c.triggered);
  const dims = plan.dimensions.map((d) => d.key === 'risk' ? ({
    key: 'risk',
    points: triggered.length
      ? triggered.map((c) => ({ text: `规则风险：${c.title}（规则：${c.rule}）`, type: 'fact', evidence_ids: c.refs.slice(0, 6) }))
      : [{ text: `已检查 ${(diag.risk_checks || []).length} 项风险规则，均未触发（不代表没有风险）`, type: 'fact', evidence_ids: (diag.risk_checks || []).flatMap((c) => c.refs).slice(0, 3) }],
  }) : ({
    key: d.key,
    points: ok.filter((e) => e.dim === d.key).slice(0, 5).map((e) => (e.kind === 'derived' || e.kind === 'opinion'
      ? { text: `${e.title}：${e.display}`, type: 'inference', confidence: e.kind === 'derived' ? '派生指标' : '观点', evidence_ids: [e.id] }
      : { text: `${e.title}：${e.display}`, type: 'fact', evidence_ids: [e.id] })),
  }));
  return {
    headline: `${staleNotice(diag) || ''}${diag.name}：AI 解读不可用，以下仅按维度展示规则化事实，并列出矛盾 ${diag.contradictions.length} 组、未知 ${diag.stats.unknown} 项（条数不代表权重，不构成综合评价）`,
    headline_ids: [],
    headline_system: true,
    answer: [],
    dimensions: dims,
    tensions: diag.contradictions.map((c) => ({ text: `${c.title}：${c.explain}`, evidence_ids: c.refs })),
    unknowns: diag.open_questions.slice(0, 4).map((q) => ({ text: `${q.question}（${q.why}）`, evidence_ids: q.refs })),
    template: true,
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
  if (!(question || '').trim()) {
    plan = rulePlan('', diag.profile);
    step('plan', 'ok', { source: 'rule-full', dimensions: plan.dimensions.map((d) => d.key), reason: '全面诊断：按公司类型覆盖全部维度' });
  } else if (llmConfigured()) {
    try { plan = await llmPlan(question, diag, { deadline: t0 + deadlineMs }); step('plan', 'ok', { source: 'llm', model: plan.model, latency_ms: plan.latency_ms, llm_attempts: plan.llm_attempts, dimensions: plan.dimensions.map((d) => d.key) }); }
    catch (e) { plan = rulePlan(question, diag.profile); step('plan', 'fallback', { source: 'rule', error: e.message, llm_attempts: e.attempts }); }
  } else { plan = rulePlan(question, diag.profile); step('plan', 'fallback', { source: 'rule', error: '未配置 LLM_API_KEY' }); }
  const planHits = sanitizePlan(plan, question, diag.profile);
  if (planHits.length) step('plan_check', 'fixed', { reason: `规划文字命中合规词 ${planHits.map((h) => `${h.path}:“${h.hit}”`).join('，')}，已替换为规则文本` });
  const notice = staleNotice(diag);

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
      const nRel = relabel(out, diag);
      if (nRel) step('relabel', 'ok', { reason: `${nRel} 条陈述的事实/推断类型被系统改判` });
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
          relabel(out, diag);
          repairs = r.count;
          step('reflect', 'repair', { attempt: 1, latency_ms: r.latency_ms, model: r.model, reason: `定点修复 ${r.count} 条陈述${r.dropped.length ? `，其中删除 ${r.dropped.length} 条无法修复的陈述` : ''}`, dropped: r.dropped });
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
    return { plan, interpretation: fb, verification: { ...verify(fb, diag), mode: 'template' }, trace, mode: 'template', data_notice: notice };
  }
  const final = annotate(out, report);
  // 违规原文不随响应返回：校验报告与轨迹中只保留位置、类型和原因
  const strip = (arr) => (arr || []).map(({ text, ...rest }) => rest);
  report = { ...report, issues: strip(report.issues) };
  for (const t of trace) if (t.issues) t.issues = strip(t.issues);
  if (notice) { final.headline_body = final.headline; final.headline = `${notice}${final.headline}`; final.headline_notice = notice; }
  const dropped = trace.filter((t) => t.step === 'reflect').flatMap((t) => t.dropped || []);
  return { plan, interpretation: final, verification: { ...report, attempts: repairs ? 2 : 1, repaired: repairs, dropped }, trace, mode: 'llm', data_notice: notice };
}
