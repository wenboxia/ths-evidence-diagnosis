// 扶摇金融数据 REST 客户端：统一处理信封、错误码、超时、限流退避与缓存。
// 每一次调用都会产出一条“工具调用记录”，进入 trace，供页面追溯与评测复盘。

const BASE_URL = process.env.FUYAO_BASE_URL || 'https://fuyao.aicubes.cn';

export const FUYAO_ERRORS = {
  1001: '缺少必填参数',
  1002: '参数格式错误',
  1003: '参数取值越界',
  1004: '参数冲突',
  2001: '未认证（API Key 缺失或无效）',
  2003: '权限不足（API Key 无权访问该能力）',
  3001: '标的不存在',
  3002: '数据未就绪',
  3004: '标的类型不支持该能力',
  4001: '频率超限',
  5001: '服务内部错误',
  5002: '上游服务超时',
  5003: '数据源不可用',
};

const RETRYABLE = new Set([4001, 5002, 5003, 'HTTP_429', 'TIMEOUT', 'NETWORK']);
// 允许回退到缓存的错误：仅限可恢复的网络/上游问题；鉴权、权限、参数、标的不存在等业务错误不回退
const RECOVERABLE_CODES = new Set([4001, 5001, 5002, 5003, 'HTTP_429', 'TIMEOUT', 'NETWORK', 'BUDGET']);
const TTL_MS = 10 * 60 * 1000;
const STALE_MAX_MS = 24 * 3600 * 1000; // 调用失败时，可回退到 24h 内最近一次成功结果（显式标注为过期）

function buildQuery(params = {}) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  }
  return sp.toString();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createFuyaoClient({
  apiKey = process.env.FUYAO_API_KEY,
  fetchImpl = globalThis.fetch,
  timeoutMs = 12000,
  maxAttempts = 2,
  cache = new Map(),
  mock = null, // (path, params) => envelope；仅本地开发/测试使用
} = {}) {
  async function call(tool, path, params = {}, { deadline = Infinity } = {}) {
    const query = buildQuery(params);
    const key = `${path}?${query}`;
    const started = Date.now();
    const hit = cache.get(key);
    if (hit && Date.now() - hit.cached_at < TTL_MS) {
      return { ...hit.result, cache: 'hit' };
    }

    const base = { tool, path, params, url: `${BASE_URL}${path}${query ? '?' + query : ''}` };

    if (mock) {
      const env = await mock(path, params);
      const result = normalize(base, env, started, 1, 'mock');
      if (result.ok) cache.set(key, { cached_at: Date.now(), result });
      return result;
    }

    if (!apiKey) {
      return {
        ...base, ok: false, code: 'NO_KEY', message: '服务端未配置 FUYAO_API_KEY',
        fetched_at: Date.now(), latency_ms: 0, attempts: 0, source: 'fuyao',
      };
    }

    let last;
    let made = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const remainMs = deadline - Date.now();
      const budget = Math.min(timeoutMs, remainMs);
      if (remainMs < 1500) {
        last = last || { ...base, ok: false, code: 'BUDGET', message: '本次诊断的数据采集总时限已到，未发起/未重试该调用' };
        break;
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), budget);
      made++;
      try {
        const resp = await fetchImpl(base.url, { headers: { 'X-api-key': apiKey }, signal: ctrl.signal });
        if (resp.status === 429) {
          clearTimeout(timer);
          last = { ...base, ok: false, code: 'HTTP_429', message: '触发限流（HTTP 429）' };
        } else {
          let env;
          try { env = await resp.json(); } catch (err) {
            if (err?.name === 'AbortError') throw err; // 响应体传输超时，交给外层按超时处理
            env = { code: 'BAD_JSON', message: `响应无法解析（HTTP ${resp.status}）` };
          } finally { clearTimeout(timer); }
          last = normalize(base, env, started, attempt, 'fuyao');
          if (process.env.VERCEL) console.log(`[fuyao] ${tool} code=${last.code} ${Date.now() - started}ms`);
          if (last.ok) {
            cache.set(key, { cached_at: Date.now(), result: last });
            return last;
          }
        }
      } catch (e) {
        clearTimeout(timer);
        const timeout = e?.name === 'AbortError';
        if (process.env.VERCEL) console.log(`[fuyao] ${tool} ${timeout ? 'TIMEOUT' : 'NETWORK ' + (e?.cause?.code || e?.message)} ${Date.now() - started}ms`);
        last = { ...base, ok: false, code: timeout ? 'TIMEOUT' : 'NETWORK', message: timeout ? `请求超时（>${budget}ms）` : `网络错误：${e?.message || e}` };
      }
      if (!RETRYABLE.has(last.code) || attempt === maxAttempts) break;
      await sleep(600 * attempt); // 限流/超时：退避后重试一次，避免立即连续重试
    }
    const failed = { ...last, fetched_at: Date.now(), latency_ms: Date.now() - started, attempts: made, source: 'fuyao' };
    if (hit && Date.now() - hit.cached_at < STALE_MAX_MS && RECOVERABLE_CODES.has(failed.code)) {
      // 回退：用最近一次成功结果，但标记 cache='stale'，下游证据会被标为“可能过期”
      return { ...hit.result, cache: 'stale', stale_reason: failed.message, attempts: made, latency_ms: failed.latency_ms };
    }
    return failed;
  }

  return { call };
}

function normalize(base, env, started, attempt, source) {
  const code = env?.code;
  const ok = code === 0;
  return {
    ...base,
    ok,
    code,
    message: ok ? 'success' : (FUYAO_ERRORS[code] ? `${FUYAO_ERRORS[code]}（code=${code}）` : (env?.message || `未知错误 code=${code}`)),
    request_id: env?.request_id || null,
    data: ok ? env.data : null,
    data_timestamp: ok ? (env.data?.timestamp ?? null) : null,
    fetched_at: Date.now(),
    latency_ms: Date.now() - started,
    attempts: attempt,
    source,
  };
}

// 便捷时间工具（Asia/Shanghai）
export const CN_OFFSET_MS = 8 * 3600 * 1000;
export function cnDate(ms) {
  if (ms === null || ms === undefined) return null;
  return new Date(ms + CN_OFFSET_MS).toISOString().slice(0, 10);
}
export function cnDayStartMs(dateStr) {
  return Date.parse(`${dateStr}T00:00:00+08:00`);
}
