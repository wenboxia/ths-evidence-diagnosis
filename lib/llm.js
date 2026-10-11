// OpenAI 兼容的 Chat Completions 客户端，支持多供应商自动切换（主：DeepSeek，备：GLM（快）→ Kimi（强但慢））。
// 任一供应商超时/报错/输出非 JSON，自动切到下一家；每次尝试都记录到 attempts，供轨迹展示与复盘。

export function providers() {
  const list = [];
  // reasoning_effort=low：这几家都是推理模型，默认推理过长会超出 60s 函数时限（实测 GLM 默认 >55s，low 约 4–20s）
  // cap：主模型单次最长等待（实测通常 12–20s），超过即切换，给备用模型留出足够时间
  if (process.env.LLM_API_KEY) list.push({ name: 'deepseek', base: process.env.LLM_BASE_URL || 'https://api.deepseek.com', key: process.env.LLM_API_KEY, model: process.env.LLM_MODEL || 'deepseek-flash', extra: { reasoning_effort: 'low' }, cap: 26000 });
  if (process.env.GLM_API_KEY) list.push({ name: 'glm', base: 'https://open.bigmodel.cn/api/paas/v4', key: process.env.GLM_API_KEY, model: process.env.GLM_MODEL || 'glm-5.3-flash', extra: { reasoning_effort: 'low' } });
  if (process.env.KIMI_API_KEY) list.push({ name: 'kimi', base: 'https://api.moonshot.cn/v1', key: process.env.KIMI_API_KEY, model: process.env.KIMI_MODEL || 'kimi-k3', temperature: 1, extra: { reasoning_effort: 'low' } });
  return list;
}

export function llmConfigured() {
  return providers().length > 0;
}

async function callOne(p, { system, user, timeoutMs, temperature, maxTokens, fetchImpl, cancel }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onCancel = () => ctrl.abort();
  cancel?.addEventListener?.('abort', onCancel);
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
    let body = null;
    try { body = await resp.json(); } catch (err) {
      if (err?.name === 'AbortError') throw err; // 读响应体时超时：按超时处理，不能误报成“输出为空”
    }
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
    if (cancel?.aborted) throw Object.assign(new Error('已取消（其他供应商先返回）'), { code: 'LLM_CANCELLED' });
    if (e?.name === 'AbortError') throw Object.assign(new Error(`超时（>${timeoutMs}ms）`), { code: 'LLM_TIMEOUT' });
    throw e;
  } finally {
    clearTimeout(timer);
    cancel?.removeEventListener?.('abort', onCancel);
  }
}

// 对冲请求：主模型发出后若 hedgeMs 内未返回（或已失败），立即并发请求下一家；谁先返回合法 JSON 用谁，其余取消。
// 相比“串行等超时再切换”，备用模型能拿到足够的时间，主模型偶发变慢时不再整体降级。
export async function chatJSON({ system, user, timeoutMs = 30000, temperature = 0.2, maxTokens = 8000, fetchImpl = globalThis.fetch, deadline = Date.now() + 55000, hedgeMs = 12000 }) {
  const list = providers();
  if (!list.length) throw Object.assign(new Error('服务端未配置任何 LLM Key'), { code: 'NO_LLM_KEY' });
  const attempts = [];
  const cancel = new AbortController();
  return await new Promise((resolve, reject) => {
    let next = 0, running = 0, done = false, hedgeTimer = null;
    const finishFail = () => {
      if (done || running > 0 || next < list.length) return;
      done = true;
      reject(Object.assign(new Error(`所有 LLM 供应商均失败：${attempts.map((a) => `${a.provider}(${a.error})`).join('；')}`), { code: 'LLM_ALL_FAILED', attempts }));
    };
    const launch = () => {
      if (done || next >= list.length) return finishFail();
      const p = list[next++];
      const remain = deadline - Date.now();
      if (remain < 5000) { attempts.push({ provider: p.name, model: p.model, ok: false, error: '剩余时间不足，跳过' }); return launch(); }
      running++;
      const started = Date.now();
      clearTimeout(hedgeTimer);
      if (next < list.length) hedgeTimer = setTimeout(launch, hedgeMs); // 到点仍未返回 → 并发下一家
      callOne(p, { system, user, timeoutMs: Math.min(timeoutMs, remain - 500), temperature, maxTokens, fetchImpl, cancel: cancel.signal })
        .then((r) => {
          running--;
          attempts.push({ provider: p.name, model: p.model, ok: true, latency_ms: Date.now() - started });
          if (done) return;
          done = true; clearTimeout(hedgeTimer); cancel.abort();
          resolve({ json: r.json, usage: r.usage, model: `${p.name}/${p.model}`, latency_ms: Date.now() - started, attempts });
        })
        .catch((e) => {
          running--;
          if (e.code !== 'LLM_CANCELLED') attempts.push({ provider: p.name, model: p.model, ok: false, latency_ms: Date.now() - started, error: e.message });
          if (done) return;
          if (next < list.length) { clearTimeout(hedgeTimer); launch(); } // 失败立即接力
          else finishFail();
        });
    };
    launch();
  });
}
