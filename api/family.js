// BACKLIT family song server. Vercel serverless function.
// Songs live in a Cloudflare R2 bucket (a NAS can mirror into it). Family members sign in with a shared
// family password; the browser then downloads zips straight from R2 with short-lived signed links.
//
// Environment variables (Vercel > Project > Settings > Environment Variables):
//   FAMILY_PASSWORD        the password family members type in
//   SESSION_SECRET         any long random text (32+ characters); changing it signs everyone out
//   R2_ACCOUNT_ID          Cloudflare account ID
//   R2_ACCESS_KEY_ID       R2 API token access key (read-only is enough)
//   R2_SECRET_ACCESS_KEY   R2 API token secret
//   R2_BUCKET              bucket name
//   R2_PREFIX              optional folder inside the bucket, e.g. "songs/" (default: whole bucket)
// Optional: the Upstash variables used by the leaderboard also enable a sign-in attempt limit.
const crypto = require('crypto');
const env = process.env;
const DAYS = 30, LINK_SECONDS = 3600;

// ---------- AWS Signature V4 presigning (R2 speaks the S3 API) ----------
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
const sha = d => crypto.createHash('sha256').update(d).digest('hex');
const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const encPath = k => k.split('/').map(enc).join('/');
const amzDate = d => d.toISOString().replace(/[:-]|\.\d{3}/g, '');
function presign({ host, path, region, accessKey, secret, expires, now, query = {} }) {
  const t = amzDate(now || new Date()), day = t.slice(0, 8), scope = `${day}/${region}/s3/aws4_request`;
  const q = Object.assign({ 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${accessKey}/${scope}`,
    'X-Amz-Date': t, 'X-Amz-Expires': String(expires), 'X-Amz-SignedHeaders': 'host' }, query);
  const qs = Object.keys(q).sort().map(k => enc(k) + '=' + enc(q[k])).join('&');
  const canonical = ['GET', path, qs, 'host:' + host + '\n', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', t, scope, sha(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac('AWS4' + secret, day), region), 's3'), 'aws4_request');
  return `https://${host}${path}?${qs}&X-Amz-Signature=${crypto.createHmac('sha256', key).update(toSign).digest('hex')}`;
}
const r2 = () => ({ host: `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, region: 'auto', accessKey: env.R2_ACCESS_KEY_ID, secret: env.R2_SECRET_ACCESS_KEY });
const prefix = () => String(env.R2_PREFIX || '').replace(/^\/+/, '');
const unxml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

async function listZips() {
  const out = []; let token = null;
  for (let i = 0; i < 10; i++) {
    const query = { 'list-type': '2', 'max-keys': '1000' };
    if (prefix()) query.prefix = prefix();
    if (token) query['continuation-token'] = token;
    const url = presign(Object.assign(r2(), { path: '/' + enc(env.R2_BUCKET), expires: 60, query }));
    const r = await fetch(url);
    const xml = await r.text();
    if (!r.ok) throw new Error('storage error ' + r.status + (/<Code>([^<]+)/.exec(xml) || [, ''])[1].replace(/^/, ' '));
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = unxml((/<Key>([\s\S]*?)<\/Key>/.exec(m[1]) || [])[1] || '');
      if (!/\.zip$/i.test(key)) continue;
      out.push({ key, size: +((/<Size>(\d+)<\/Size>/.exec(m[1]) || [])[1] || 0),
        etag: unxml((/<ETag>([\s\S]*?)<\/ETag>/.exec(m[1]) || [])[1] || '').replace(/"/g, '') });
    }
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? unxml((/<NextContinuationToken>([\s\S]*?)</.exec(xml) || [])[1] || '') : null;
    if (!token) break;
  }
  return out;
}

// ---------- sessions (signed cookie; changing FAMILY_PASSWORD or SESSION_SECRET signs everyone out) ----------
const sig = d => crypto.createHmac('sha256', env.SESSION_SECRET).update(d).digest('base64url');
const pwVersion = () => sig('pw:' + env.FAMILY_PASSWORD).slice(0, 10);
function makeSession(name) { const p = Buffer.from(JSON.stringify({ n: name, v: pwVersion(), e: Date.now() + DAYS * 864e5 })).toString('base64url'); return p + '.' + sig(p); }
function readSession(req) {
  const m = /(?:^|;\s*)bl_s=([^;]+)/.exec(String(req.headers.cookie || '')); if (!m) return null;
  const [p, s] = m[1].split('.'); if (!p || !s) return null;
  const want = sig(p); if (s.length !== want.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(want))) return null;
  try { const o = JSON.parse(Buffer.from(p, 'base64url').toString()); return o.e > Date.now() && o.v === pwVersion() ? o : null; } catch (e) { return null; }
}
const cookie = (res, v, age) => res.setHeader('Set-Cookie', `bl_s=${v}; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`);
const cleanName = n => String(n || '').normalize('NFKC').replace(/[^\p{L}\p{N} ._'-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 16);
function samePassword(a, b) { const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest(); return crypto.timingSafeEqual(x, y); }

// ---------- optional sign-in attempt limit (uses the leaderboard's Upstash database if present) ----------
function db() {
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) return { url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN };
  if (env.KV_REST_API_URL && env.KV_REST_API_TOKEN) return { url: env.KV_REST_API_URL, token: env.KV_REST_API_TOKEN };
  for (const k of Object.keys(env)) if (k.endsWith('_KV_REST_API_URL') && env[k.replace(/_URL$/, '_TOKEN')]) return { url: env[k], token: env[k.replace(/_URL$/, '_TOKEN')] };
  return null;
}
async function tooManyAttempts(ip) {
  const d = db(); if (!d) return false;
  try {
    const r = await fetch(d.url.replace(/\/$/, '') + '/pipeline', { method: 'POST', headers: { Authorization: 'Bearer ' + d.token, 'Content-Type': 'application/json' },
      body: JSON.stringify([['INCR', 'bl:login:' + ip], ['EXPIRE', 'bl:login:' + ip, '900']]) });
    const j = await r.json(); return j[0].result > 10;
  } catch (e) { return false; }
}

const REQUIRED = ['FAMILY_PASSWORD', 'SESSION_SECRET', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const missing = REQUIRED.filter(k => !env[k]);
  if (missing.length) return res.status(500).json({ error: 'family server not set up on Vercel, missing: ' + missing.join(', ') });
  if (env.SESSION_SECRET.length < 32) return res.status(500).json({ error: 'SESSION_SECRET must be at least 32 characters' });

  const host = req.headers.host || '', from = req.headers.origin || req.headers.referer || '';
  try { if (!from || new URL(from).host !== host) return res.status(403).json({ error: 'forbidden' }); }
  catch (e) { return res.status(403).json({ error: 'forbidden' }); }

  const q = req.query || Object.fromEntries(new URL(req.url, 'http://x').searchParams);
  let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } } body = body || {};
  const action = q.action;

  try {
    if (req.method === 'POST' && action === 'login') {
      const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
      if (await tooManyAttempts(ip)) return res.status(429).json({ error: 'too many attempts, wait 15 minutes' });
      const name = cleanName(body.name);
      if (!name) return res.status(400).json({ error: 'enter your name' });
      if (!samePassword(body.password || '', env.FAMILY_PASSWORD)) return res.status(401).json({ error: 'wrong family password' });
      cookie(res, makeSession(name), DAYS * 86400);
      return res.status(200).json({ name });
    }
    if (req.method === 'POST' && action === 'logout') { cookie(res, '', 0); return res.status(200).json({ ok: true }); }

    const s = readSession(req);
    if (!s) return res.status(401).json({ error: 'sign in first' });
    if (req.method !== 'GET') return res.status(405).json({ error: 'not allowed' });
    if (action === 'me') return res.status(200).json({ name: s.n });
    if (action === 'list') return res.status(200).json({ songs: await listZips() });
    if (action === 'url') {
      const key = String(q.key || '');
      if (!/\.zip$/i.test(key) || !key.startsWith(prefix()) || key.includes('..')) return res.status(400).json({ error: 'bad song' });
      return res.status(200).json({ url: presign(Object.assign(r2(), { path: '/' + enc(env.R2_BUCKET) + '/' + encPath(key), expires: LINK_SECONDS })) });
    }
    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    return res.status(502).json({ error: String(e.message || 'server error').slice(0, 120) });
  }
};
module.exports.presign = presign;
