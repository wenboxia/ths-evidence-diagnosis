import { ask, normalizeCode, sendError } from '../lib/service.js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: '仅支持 POST' });
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const thscode = normalizeCode(body.thscode);
    const question = String(body.question || '').slice(0, 300);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(await ask(thscode, question, body.core || null, body.core_sig || null));
  } catch (e) { sendError(res, e); }
}
