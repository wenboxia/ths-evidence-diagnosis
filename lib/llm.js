// OpenAI 兼容的 Chat Completions 客户端，支持多供应商自动切换（主：DeepSeek，备：GLM（快）→ Kimi（强但慢））。
// 任一供应商超时/报错/输出非 JSON，自动切到下一家；每次尝试都记录到 attempts，供轨迹展示与复盘。

export function providers() {
  const list = [];
  // reasoning_effort=low：这几家都是推理模型，默认推理过长会超出 60s 函数时限（实测 GLM 默认 >55s，low 约 4–20s）
  if (process.env.LLM_API_KEY) list.push({ name: 'deepseek', base: process.env.LLM_BASE_URL || 'https://api.deepseek.com', key: process.env.LLM_API_KEY, model: process.env.LLM_MODEL || 'deepseek-flash', extra: { reasoning_effort: 'low' } });
  if (process.env.GLM_API_KEY) list.push({ name: 'glm', base: 'https://open.bigmodel.cn/api/paas/v4', key: process.env.GLM_API_KEY, model: process.env.GLM_MODEL || 'glm-5.3-flash', extra: { reasoning_effort: 'low' } });
  if (process.env.KIMI_API_KEY) list.push({ name: 'kimi', base: 'https://api.moonshot.cn/v1', key: process.env.KIMI_API_KEY, model: process.env.KIMI_MODEL || 'kimi-k3', temperature: 1, extra: { reasoning_effort: 'low' } });
  return list;
}

export function llmConfigured() {
  return providers().length > 0;
}

async function callOne(p, { system, user, timeoutMs, temperature, maxTokens, fetchImpl }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(`${p.base.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.key}` },
      body: JSON.stringify({
        model: p.model, temperature: p.temperature ?? temperature, max_tokens: maxTokens,
        response_format: { type: 'json_object' },
        ...(p.extra || {}),
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
      signal: ctrl.signal,
    });
    const body = await resp.json().catch(() => null);
    if (!resp.ok) throw Object.assign(new Error(`HTTP ${resp.status} ${body?.error?.message || ''}`.trim()), { code: `LLM_HTTP_${resp.status}` });
    const text = body?.choices?.[0]?.message?.content || '';
    if (!text) throw Object.assign(new Error(`输出为空（finish_reason=${body?.choices?.[0]?.finish_reason}；${JSON.stringify(body?.error || body)?.slice(0, 160)}）`), { code: 'LLM_EMPTY' });
    let json;
    try { json = JSON.parse(text); } catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) throw Object.assign(new Error('输出不是合法 JSON'), { code: 'LLM_BAD_JSON' });
      json = JSON.parse(m[0]);
    }
    return { json, usage: body?.usage || null };
  } catch (e) {
    if (e?.name === 'AbortError') throw Object.assign(new Error(`超时（>${timeoutMs}ms）`), { code: 'LLM_TIMEOUT' });
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function chatJSON({ system, user, timeoutMs = 30000, temperature = 0.2, maxTokens = 8000, fetchImpl = globalThis.fetch, deadline = Date.now() + 55000 }) {
  const list = providers();
  if (!list.length) throw Object.assign(new Error('服务端未配置任何 LLM Key'), { code: 'NO_LLM_KEY' });
  const attempts = [];
  for (const [i, p] of list.entries()) {
    const remain = deadline - Date.now();
    const left = list.length - i - 1; // 给后面的供应商预留时间
    if (remain < 5000) { attempts.push({ provider: p.name, model: p.model, ok: false, error: '剩余时间不足，跳过' }); continue; }
    const started = Date.now();
    try {
      const r = await callOne(p, { system, user, timeoutMs: Math.max(5000, Math.min(timeoutMs, remain - 1000 - left * 8000)), temperature, maxTokens, fetchImpl });
      attempts.push({ provider: p.name, model: p.model, ok: true, latency_ms: Date.now() - started });
      return { json: r.json, usage: r.usage, model: `${p.name}/${p.model}`, latency_ms: Date.now() - started, attempts };
    } catch (e) {
      attempts.push({ provider: p.name, model: p.model, ok: false, latency_ms: Date.now() - started, error: e.message });
    }
  }
  throw Object.assign(new Error(`所有 LLM 供应商均失败：${attempts.map((a) => `${a.provider}(${a.error})`).join('；')}`), { code: 'LLM_ALL_FAILED', attempts });
}
