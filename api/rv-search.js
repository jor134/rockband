// BACKLIT: RhythmVerse search via Parse (https://parse.bot). Vercel serverless function.
// Requires the environment variable PARSE_API_KEY (Vercel > Project > Settings > Environment Variables).
// The key never reaches the browser. Only same-site requests are accepted, with a light per-visitor limit
// and a 10-minute cache so repeat searches don't spend credits.
const ENDPOINT = 'https://api.parse.bot/scraper/62112df8-7404-4bf6-8f5a-c989e7da94df/search_songfiles';
const cache = new Map();
const hits = new Map();

const num = x => { const n = parseInt(x, 10); return Number.isFinite(n) ? n : null; };
const safeUrl = u => {
  try { const x = new URL(u); return x.protocol === 'https:' && /(^|\.)rhythmverse\.co$/.test(x.hostname) ? x.href : ''; }
  catch (e) { return ''; }
};

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const key = process.env.PARSE_API_KEY;
  if (!key) return res.status(500).json({ error: 'PARSE_API_KEY is not set on Vercel' });

  // same-site only, so other sites can't spend your credits
  const host = req.headers.host || '';
  const from = req.headers.origin || req.headers.referer || '';
  try { if (!from || new URL(from).host !== host) return res.status(403).json({ error: 'forbidden' }); }
  catch (e) { return res.status(403).json({ error: 'forbidden' }); }

  // light per-visitor limit: 10 searches a minute
  const now = Date.now();
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const recent = (hits.get(ip) || []).filter(t => now - t < 60000);
  if (recent.length >= 10) return res.status(429).json({ error: 'too many searches, wait a minute' });
  recent.push(now); hits.set(ip, recent);
  if (hits.size > 500) hits.delete(hits.keys().next().value);

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};
  const query = String(body.query || '').trim().slice(0, 100);
  const page = Math.max(1, Math.min(40, parseInt(body.page, 10) || 1));

  const ck = query.toLowerCase() + '|' + page;
  const hit = cache.get(ck);
  if (hit && now - hit.t < 600000) return res.status(200).json(hit.v);

  const payload = { page: String(page), records: '25' };
  if (query) payload.query = query;
  else { payload.sort_by = 'downloads'; payload.sort_order = 'DESC'; }

  let r, j;
  try {
    r = await fetch(ENDPOINT, { method: 'POST', headers: { 'X-API-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    j = await r.json().catch(() => null);
  } catch (e) {
    return res.status(502).json({ error: 'search service unreachable' });
  }
  if (r.status === 429) return res.status(429).json({ error: 'search limit reached, try again in a minute' });
  if (r.status === 401 || r.status === 403) return res.status(502).json({ error: 'Parse rejected the API key' });
  if (!r.ok || !j || (j.status && j.status !== 'success')) return res.status(502).json({ error: 'search service error (' + r.status + ')' });

  const d = j.data || j;
  const songs = (Array.isArray(d.songs) ? d.songs : []).map(s => ({
    title: String(s.title || ''), artist: String(s.artist || ''), album: String(s.album || ''),
    year: num(s.year), length: num(s.song_length), format: String(s.gameformat || '').toLowerCase(),
    author: String(s.author_name || ''), downloads: num(s.downloads) || 0,
    diffs: { guitar: num(s.diff_guitar), bass: num(s.diff_bass), drums: num(s.diff_drums), vocals: num(s.diff_vocals) },
    page_url: safeUrl(s.download_page_url) || safeUrl(s.file_url)
  }));
  const v = { page, total: num(d.total_filtered) || songs.length, songs };
  cache.set(ck, { t: now, v });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return res.status(200).json(v);
};
