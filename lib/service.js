// 服务编排：采集 → 证据 → (可选) Agent 解读。Vercel 函数与本地 dev server 共用。
import { createFuyaoClient } from './fuyao.js';
import { collect } from './collect.js';
import { buildEvidence } from './evidence.js';
import { runAgent } from './agent.js';
import { PRESETS, DEFAULT_THSCODE } from './config.js';
import { llmConfigured } from './llm.js';
import crypto from 'node:crypto';

// 问答接口复用前端已拿到的诊断结果（避免重复调用数据源）；用 HMAC 签名防止证据在客户端被篡改。
const CORE_KEYS = ['thscode', 'name', 'preset', 'report', 'profile', 'evidence', 'contradictions', 'risks', 'risk_checks', 'open_questions', 'stats', 'generated_at'];
export function pickCore(d) { const o = {}; for (const k of CORE_KEYS) o[k] = d[k]; return o; }
function sign(core) {
  const secret = process.env.SIGN_SECRET || process.env.FUYAO_API_KEY || 'dev';
  return crypto.createHmac('sha256', secret).update(JSON.stringify(pickCore(core))).digest('hex');
}

let client;
async function getClient() {
  if (client) return client;
  let mock = null;
  if (process.env.MOCK_DATA === '1') mock = (await import('../fixtures/mock.js')).mockFuyao;
  client = createFuyaoClient({ mock });
  return client;
}

export function normalizeCode(c) {
  const code = String(c || DEFAULT_THSCODE).trim().toUpperCase();
  if (!PRESETS[code]) throw Object.assign(new Error(`暂不支持该标的：${code}（当前支持：${Object.keys(PRESETS).join('、')}）`), { status: 400 });
  return code;
}

export async function getDiagnosis(thscode) {
  const c = await getClient();
  const t0 = Date.now();
  const collected = await collect(c, thscode);
  if (process.env.VERCEL) console.log(`[service] collect ${Date.now() - t0}ms`);
  const diag = buildEvidence(collected);
  if (process.env.VERCEL) console.log(`[service] build ${Date.now() - t0}ms`);
  const out = {
    ...diag,
    generated_at: Date.now(),
    meta: {
      generated_at: Date.now(),
      data_mode: process.env.MOCK_DATA === '1' ? 'mock' : 'live',
      llm: llmConfigured() ? (process.env.LLM_MODEL || 'deepseek-chat') : null,
      fuyao_key: !!process.env.FUYAO_API_KEY,
    },
  };
  out.core_sig = sign(out);
  return out;
}

export async function ask(thscode, question, core = null, sig = null) {
  const t0 = Date.now();
  let diag, reused = false;
  if (core && sig && core.thscode === thscode && sign(core) === sig && Date.now() - core.generated_at < 30 * 60 * 1000) {
    diag = core; reused = true; // 签名有效且 30 分钟内：直接复用，不再调用数据源
  } else {
    diag = await getDiagnosis(thscode);
  }
  // 函数总时限 60s：若本次需要重新采集，Agent 的时间预算相应扣减
  const result = await runAgent(question, diag, { deadlineMs: Math.max(20000, 55000 - (Date.now() - t0)) });
  return { thscode, question, ...result, evidence_stats: diag.stats, evidence_reused: reused, evidence_generated_at: diag.generated_at, generated_at: Date.now() };
}

export function sendError(res, e) {
  res.status(e.status || 500).json({ error: e.message || String(e), code: e.code || null });
}
