// BACKLIT leaderboards. Vercel serverless function backed by Upstash Redis (REST).
// Needs a REST URL + token for Upstash Redis. Any of these naming schemes works:
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN   (Upstash console)
//   KV_REST_API_URL / KV_REST_API_TOKEN                 (Vercel Storage > Upstash, incl. old Vercel KV)
//   <PREFIX>_KV_REST_API_URL / <PREFIX>_KV_REST_API_TOKEN (Vercel Storage with a custom prefix)
// GET  /api/scores?list=songs                          -> songs that have scores
// GET  /api/scores?song=ID&part=drums&diff=expert      -> top 10
// POST /api/scores {song:{id,title,artist},name,entries:[{part,diff,score,hits,total,streak}]} -> ranks
const PARTS = new Set(['guitar', 'bass', 'drums', 'vocals']);
const DIFFS = new Set(['easy', 'medium', 'hard', 'expert']);
const KEEP = 100, SHOW = 10, POSTS_PER_HOUR = 30;

function dbConfig() {
  const env = process.env;
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) return { url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN };
  if (env.KV_REST_API_URL && env.KV_REST_API_TOKEN) return { url: env.KV_REST_API_URL, token: env.KV_REST_API_TOKEN };
  for (const k of Object.keys(env)) {
    if (k.endsWith('_KV_REST_API_URL')) { const t = env[k.replace(/_URL$/, '_TOKEN')]; if (env[k] && t) return { url: env[k], token: t }; }
    if (k.endsWith('_REDIS_REST_URL')) { const t = env[k.replace(/_URL$/, '_TOKEN')]; if (env[k] && t) return { url: env[k], token: t }; }
  }
  return null;
}
// explain what's missing without revealing any values
function whyMissing() {
  const names = Object.keys(process.env).filter(k => /REDIS|KV_|UPSTASH/.test(k));
  if (!names.length) return 'no database variables found. Connect the Upstash database to this project in Vercel Storage, then redeploy';
  if (names.some(k => /REDIS_URL$|KV_URL$/.test(k)) && !names.some(k => /REST/.test(k)))
    return 'found ' + names.join(', ') + ' but no REST URL/token. This database type needs Upstash for Redis (it provides KV_REST_API_URL and KV_REST_API_TOKEN)';
  return 'found ' + names.join(', ') + ' but no matching REST URL + token pair';
}
let DB = null;
async function redis(cmds) {
  const r = await fetch(DB.url.replace(/\/$/, '') + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + DB.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds)
  });
  if (!r.ok) throw new Error('database error ' + r.status);
  const j = await r.json();
  return j.map(x => { if (x.error) throw new Error(x.error); return x.result; });
}
const idOk = s => typeof s === 'string' && /^[a-z0-9-]{3,120}$/.test(s);
const boardKey = (song, part, diff) => `bl:lb:${song}:${part}:${diff}`;
const cleanName = n => String(n || '').normalize('NFKC').replace(/[^\p{L}\p{N} ._'-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 16);
const int = x => { const n = parseInt(x, 10); return Number.isFinite(n) ? n : NaN; };
function rowsFrom(flat) {
  const out = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    try { const m = JSON.parse(flat[i]); out.push({ name: m.n, acc: m.a, streak: m.s, date: m.d, score: Number(flat[i + 1]) }); } catch (e) {}
  }
  return out;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  DB = dbConfig();
  if (!DB) return res.status(500).json({ error: 'leaderboard database not connected: ' + whyMissing() });

  // same-site only
  const host = req.headers.host || '', from = req.headers.origin || req.headers.referer || '';
  try { if (!from || new URL(from).host !== host) return res.status(403).json({ error: 'forbidden' }); }
  catch (e) { return res.status(403).json({ error: 'forbidden' }); }

  try {
    if (req.method === 'GET') {
      const q = req.query || Object.fromEntries(new URL(req.url, 'http://x').searchParams);
      if (q.list === 'songs') {
        const [h] = await redis([['HGETALL', 'bl:songs']]);
        const songs = [], flat = Array.isArray(h) ? h : Object.entries(h || {}).flat();
        for (let i = 0; i + 1 < flat.length; i += 2) { try { songs.push(Object.assign({ id: flat[i] }, JSON.parse(flat[i + 1]))); } catch (e) {} }
        songs.sort((a, b) => String(a.title).localeCompare(String(b.title)));
        return res.status(200).json({ songs });
      }
      if (!idOk(q.song) || !PARTS.has(q.part) || !DIFFS.has(q.diff)) return res.status(400).json({ error: 'bad request' });
      const [flat] = await redis([['ZREVRANGE', boardKey(q.song, q.part, q.diff), '0', String(SHOW - 1), 'WITHSCORES']]);
      return res.status(200).json({ rows: rowsFrom(flat || []) });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST only' });

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};
    const song = body.song || {};
    if (!idOk(song.id)) return res.status(400).json({ error: 'unknown song' });
    const name = cleanName(body.name);
    if (!name) return res.status(400).json({ error: 'enter a name' });

    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    const [n] = await redis([['INCR', 'bl:rl:' + ip]]);
    if (n === 1) await redis([['EXPIRE', 'bl:rl:' + ip, '3600']]);
    if (n > POSTS_PER_HOUR) return res.status(429).json({ error: 'too many posts, try again later' });

    const date = new Date().toISOString().slice(0, 10);
    const cmds = [['HSET', 'bl:songs', song.id, JSON.stringify({ title: String(song.title || '').slice(0, 80), artist: String(song.artist || '').slice(0, 80) })]];
    const valid = [], seen = new Set();
    for (const e of (Array.isArray(body.entries) ? body.entries : []).slice(0, 4)) {
      if (!e || !PARTS.has(e.part) || !DIFFS.has(e.diff) || seen.has(e.part)) continue;
      const total = int(e.total), hits = int(e.hits), score = int(e.score), streak = int(e.streak) || 0;
      // plausibility: can't beat the maximum possible score for that many notes
      const maxPer = e.part === 'vocals' ? 400 : 200;
      if (!(total > 0 && total < 20000 && hits >= 0 && hits <= total && score > 0 && score <= total * maxPer && streak >= 0 && streak <= hits)) continue;
      seen.add(e.part);
      const member = JSON.stringify({ n: name, a: Math.round(100 * hits / total), s: streak, d: date, id: Math.random().toString(36).slice(2, 10) });
      const key = boardKey(song.id, e.part, e.diff);
      cmds.push(['ZADD', key, String(score), member], ['ZREMRANGEBYRANK', key, '0', String(-KEEP - 1)], ['ZREVRANK', key, member]);
      valid.push({ part: e.part, diff: e.diff, score });
    }
    if (!valid.length) return res.status(400).json({ error: 'no valid scores to post' });
    const out = await redis(cmds);
    const ranks = valid.map((v, i) => { const r = out[1 + i * 3 + 2]; return Object.assign(v, { rank: r == null ? null : r + 1 }); });
    return res.status(200).json({ ranks });
  } catch (e) {
    return res.status(502).json({ error: 'leaderboard unavailable' });
  }
};
