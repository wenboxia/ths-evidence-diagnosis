import { getDiagnosis, normalizeCode, sendError } from '../lib/service.js';

export default async function handler(req, res) {
  const t0 = Date.now();
  try {
    const url = new URL(req.url, 'http://localhost');
    const thscode = normalizeCode(url.searchParams.get('thscode'));
    const diag = await getDiagnosis(thscode);
    const t1 = Date.now();
    const body = JSON.stringify(diag);
    console.log(`[diagnose] ${thscode} collect+build=${t1 - t0}ms stringify=${Date.now() - t1}ms bytes=${body.length}`);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(body);
  } catch (e) { console.error('[diagnose] error', e); sendError(res, e); }
}
