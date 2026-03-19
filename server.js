const express = require('express');
const axios   = require('axios');

const app = express();

// ─────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────
const VIEW_KEY = 'Q8d7fhJ1D5MR1yjlmdTUGINn2slht2x2OtMweKxqPP4';
const BASE     = 'https://vimeus.com';
const PORT     = process.env.PORT || 7001;
const HOST     = process.env.HOST || `http://localhost:${PORT}`;
const TMDB_KEY = process.env.TMDB_KEY || 'c38f916ce25f02182165b028993509d4';

const HEADERS = {
  'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Referer'        : 'https://goodstream.one/',
  'Origin'         : 'https://goodstream.one',
  'Accept'         : '*/*',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
};

function getHeaders(url) {
  if (url.includes('goodstream.one')) return { ...HEADERS };
  if (url.includes('hlswish.com'))    return { ...HEADERS, 'Referer': 'https://hlswish.com/', 'Origin': 'https://hlswish.com' };
  return HEADERS;
}

// ─────────────────────────────────────────────
//  CACHE  (10 minutos)
// ─────────────────────────────────────────────
const cache     = new Map();
const CACHE_TTL = 10 * 60 * 1000;

function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL) { cache.delete(key); return null; }
  return e.data;
}
function cacheSet(key, data) { cache.set(key, { data, ts: Date.now() }); }

// ─────────────────────────────────────────────
//  TMDB — convertir IMDb a TMDB
// ─────────────────────────────────────────────
const imdbCache = new Map();

async function imdbToTmdb(imdbId, type) {
  const key = `${type}:${imdbId}`;
  if (imdbCache.has(key)) return imdbCache.get(key);
  try {
    const url = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_KEY}&external_source=imdb_id`;
    const { data } = await axios.get(url, { timeout: 10000 });
    const result = type === 'movie' ? data.movie_results?.[0] : data.tv_results?.[0];
    const tmdbId = result?.id?.toString() || null;
    if (tmdbId) {
      imdbCache.set(key, tmdbId);
      console.log(`  [tmdb] ${imdbId} → ${tmdbId}`);
    }
    return tmdbId;
  } catch (err) {
    console.log(`  [tmdb] Error: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────
//  VIMEUS — obtener embeds
// ─────────────────────────────────────────────
async function getEmbeds(embedUrl) {
  console.log(`  [vimeus] ${embedUrl}`);
  const { data: html } = await axios.get(embedUrl, {
    headers: { ...HEADERS, 'Referer': 'https://vimeus.com/', 'Origin': 'https://vimeus.com' },
    timeout: 30000,
  });
  const match = html.match(/<script[^>]+id="data"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('No se encontró bloque de datos');
  const data = JSON.parse(match[1].trim());
  console.log(`  [vimeus] "${data.title}" — ${data.embeds?.length || 0} fuentes`);
  return data.embeds || [];
}

// ─────────────────────────────────────────────
//  GOODSTREAM — extraer m3u8
// ─────────────────────────────────────────────
async function extractFromGoodstream(embedUrl) {
  console.log(`  [goodstream] ${embedUrl}`);
  const { data: html } = await axios.get(embedUrl, {
    headers: HEADERS,
    timeout: 30000,
  });
  const m3u8 = html.match(/https:\/\/[^"'\s]+\.m3u8[^"'\s]*/);
  if (m3u8) {
    console.log(`  [goodstream] ✅ ${m3u8[0].slice(0, 80)}...`);
    return m3u8[0];
  }
  return null;
}

// ─────────────────────────────────────────────
//  ORQUESTADOR
// ─────────────────────────────────────────────
const SOURCE_PRIORITY = ['goodstream.one', 'hlswish.com', 'voe.sx', 'filemoon.sx', 'vimeos.net', 'vimeos.zip', 'vimeos.tv'];

async function getM3U8FromEmbeds(embeds) {
  const sorted = [...embeds].sort((a, b) => {
    const ai = SOURCE_PRIORITY.findIndex(s => a.url.includes(s));
    const bi = SOURCE_PRIORITY.findIndex(s => b.url.includes(s));
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  const results = [];
  for (const embed of sorted) {
    try {
      let m3u8 = null;
      if (embed.url.includes('goodstream.one')) m3u8 = await extractFromGoodstream(embed.url);
      if (m3u8) {
        results.push({ m3u8, lang: embed.lang, quality: embed.quality, source: 'goodstream' });
      } else {
        const hostname = new URL(embed.url).hostname;
        results.push({ externalUrl: embed.url, lang: embed.lang, quality: embed.quality, source: hostname });
      }
    } catch (err) {
      console.log(`  [warn] ${err.message}`);
    }
  }
  return results;
}

// ─────────────────────────────────────────────
//  BUILD EMBED URL
// ─────────────────────────────────────────────
function buildEmbedUrl(type, id) {
  const parts   = id.split(':');
  let baseId, season, episode;
  if (parts[0] === 'tmdb') {
    baseId  = parts[1];
    season  = parts[2] || null;
    episode = parts[3] || null;
  } else {
    baseId  = parts[0];
    season  = parts[1] || null;
    episode = parts[2] || null;
  }
  const param = baseId.startsWith('tt') ? `imdb=${baseId}` : `tmdb=${baseId}`;

  if (type === 'movie') return `${BASE}/e/movie?${param}&view_key=${VIEW_KEY}`;
  if (type === 'series') {
    let url = `${BASE}/e/serie?${param}&view_key=${VIEW_KEY}`;
    if (season && episode) url += `&se=${season}&ep=${episode}`;
    return url;
  }
  if (type === 'anime') {
    let url = `${BASE}/e/anime?${param}&view_key=${VIEW_KEY}`;
    if (season && episode) url += `&se=${season}&ep=${episode}`;
    return url;
  }
  return null;
}

// ─────────────────────────────────────────────
//  GET STREAM
// ─────────────────────────────────────────────
async function getStream(type, id) {
  const cacheKey = `${type}:${id}`;
  const cached   = cacheGet(cacheKey);
  if (cached) { console.log(`  [CACHE] ${cacheKey}`); return cached; }

  // Convertir IMDb a TMDB si necesario
  const parts  = id.split(':');
  const baseId = parts[0] === 'tmdb' ? parts[1] : parts[0];
  if (baseId.startsWith('tt')) {
    const tmdbId = await imdbToTmdb(baseId, type);
    if (!tmdbId) { console.log(`  → No TMDB ID para ${baseId}`); return null; }
    const newId = parts[0] === 'tmdb'
      ? ['tmdb', tmdbId, ...parts.slice(2)].join(':')
      : [tmdbId, ...parts.slice(1)].join(':');
    id = newId;
  }

  const embedUrl = buildEmbedUrl(type, id);
  if (!embedUrl) return null;

  const embeds = await getEmbeds(embedUrl);
  if (!embeds.length) return null;

  const results = await getM3U8FromEmbeds(embeds);
  if (results.length) cacheSet(cacheKey, results);
  return results.length ? results : null;
}

// ─────────────────────────────────────────────
//  PROXY — con auto-refresh de token en 403
// ─────────────────────────────────────────────
async function fetchM3U8(url) {
  const r = await axios.get(url, { headers: getHeaders(url), timeout: 30000 });
  let content = r.data;
  const base  = url.substring(0, url.lastIndexOf('/') + 1);
  content = content.replace(/^([^#\r\n][^\r\n]+\.m3u8[^\r\n]*)$/gm, line => {
    const abs = line.trim().startsWith('http') ? line.trim() : base + line.trim();
    return `${HOST}/proxy/rendition?url=${Buffer.from(abs).toString('base64')}`;
  });
  return content;
}

app.get('/proxy/master', async (req, res) => {
  const { url: urlB64, type, id } = req.query;
  const realUrl = Buffer.from(urlB64, 'base64').toString('utf8');
  console.log(`  [proxy/master] ${realUrl.slice(0, 80)}...`);

  try {
    const content = await fetchM3U8(realUrl);
    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.set('Access-Control-Allow-Origin', '*');
    res.send(content);
  } catch (err) {
    console.error(`  [proxy/master] Error ${err.response?.status}: ${err.message}`);

    // Token expirado — regenerar si tenemos type/id
    if (err.response?.status === 403 && type && id) {
      console.log(`  [proxy/master] Regenerando token...`);
      try {
        cache.delete(`${type}:${id}`);
        const streams = await getStream(type, id);
        if (streams) {
          const fresh = streams.find(s => s.m3u8);
          if (fresh) {
            const content = await fetchM3U8(fresh.m3u8);
            res.set('Content-Type', 'application/vnd.apple.mpegurl');
            res.set('Access-Control-Allow-Origin', '*');
            return res.send(content);
          }
        }
      } catch (e) {
        console.error(`  [proxy/master] Regeneración falló: ${e.message}`);
      }
    }
    res.status(500).send('Error fetching master');
  }
});

app.get('/proxy/rendition', async (req, res) => {
  const realUrl = Buffer.from(req.query.url, 'base64').toString('utf8');
  try {
    const r    = await axios.get(realUrl, { headers: getHeaders(realUrl), timeout: 30000 });
    let content = r.data;
    const base  = realUrl.substring(0, realUrl.lastIndexOf('/') + 1);
    content = content.replace(/^([^#\r\n][^\r\n]+\.ts[^\r\n]*)$/gm, line => {
      const abs = line.trim().startsWith('http') ? line.trim() : base + line.trim();
      return `${HOST}/proxy/segment?url=${Buffer.from(abs).toString('base64')}`;
    });
    content = content.replace(/URI="([^"]+)"/g, (_, uri) => {
      const abs = uri.startsWith('http') ? uri : base + uri;
      return `URI="${HOST}/proxy/segment?url=${Buffer.from(abs).toString('base64')}"`;
    });
    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.set('Access-Control-Allow-Origin', '*');
    res.send(content);
  } catch (err) {
    res.status(500).send('Error fetching rendition');
  }
});

app.get('/proxy/segment', async (req, res) => {
  const realUrl = Buffer.from(req.query.url, 'base64').toString('utf8');
  try {
    const r = await axios.get(realUrl, {
      headers     : getHeaders(realUrl),
      responseType: 'stream',
      timeout     : 60000,
    });
    res.set('Content-Type', r.headers['content-type'] || 'video/MP2T');
    res.set('Access-Control-Allow-Origin', '*');
    r.data.pipe(res);
  } catch (err) {
    res.status(500).send('Error fetching segment');
  }
});

// ─────────────────────────────────────────────
//  CORS
// ─────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  next();
});

// ─────────────────────────────────────────────
//  RUTAS
// ─────────────────────────────────────────────
app.get('/manifest.json', (req, res) => {
  res.json({
    id          : 'org.vimeus.hls',
    name        : 'Vimeus',
    description : 'Stream HLS dinámico desde Vimeus',
    version     : '6.0.0',
    resources   : ['stream'],
    types       : ['movie', 'series'],
    catalogs    : [],
    idPrefixes  : ['tt', 'tmdb:'],
    behaviorHints: { configurable: false },
  });
});

app.get('/stream/:type/:id.json', handleStream);
app.get('/stream/:type/:id',      handleStream);

async function handleStream(req, res) {
  const { type, id } = req.params;
  console.log(`\n▶ [${type}] ${id}`);
  try {
    const results = await getStream(type, id);
    if (!results) return res.json({ streams: [] });

    const streams = results.map(r => {
      if (r.m3u8) {
        // Incluir type e id en la URL del proxy para poder regenerar el token
        const encoded = Buffer.from(r.m3u8).toString('base64');
        const proxyUrl = `${HOST}/proxy/master?url=${encoded}&type=${type}&id=${id}`;
        return {
          name : `Vimeus · ${r.quality || 'HD'} · ${r.lang || ''}`.trim(),
          title: `▶ ${r.source}`,
          url  : proxyUrl,
        };
      } else {
        return {
          name       : `Vimeus · ${r.quality || 'HD'} · ${r.lang || ''}`.trim(),
          title      : `🌐 ${r.source}`,
          externalUrl: r.externalUrl,
        };
      }
    });

    return res.json({ streams });
  } catch (err) {
    console.error(`  → Error: ${err.message}`);
    return res.json({ streams: [] });
  }
}

app.get('/debug/:type/:id', async (req, res) => {
  const { type, id } = req.params;
  console.log(`\n[DEBUG] ${type}/${id}`);
  try {
    const results = await getStream(type, id);
    if (!results) return res.json({ found: false });
    res.json({ found: true, count: results.length, results });
  } catch (err) {
    res.json({ error: err.message });
  }
});

app.get('/cache/clear', (req, res) => { cache.clear(); res.json({ ok: true }); });

// ─────────────────────────────────────────────
//  KEEP-ALIVE
// ─────────────────────────────────────────────
setInterval(() => {
  axios.get(`${HOST}/manifest.json`).catch(() => {});
  console.log('[keep-alive] ping');
}, 5 * 60 * 1000);

// ─────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ Addon Vimeus v6.0 corriendo en http://localhost:${PORT}`);
  console.log(`   Manifest → http://localhost:${PORT}/manifest.json`);
  console.log(`   Debug    → http://localhost:${PORT}/debug/movie/tt2395427\n`);
});
