const express    = require('express');
const axios      = require('axios');
const puppeteer  = require('puppeteer-core');

const app = express();

// ─────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────
const VIEW_KEY        = 'Q8d7fhJ1D5MR1yjlmdTUGINn2slht2x2OtMweKxqPP4';
const BASE            = 'https://vimeus.com';
const PORT            = process.env.PORT || 7001;
const HOST            = process.env.HOST || `http://localhost:${PORT}`;
const TMDB_KEY        = process.env.TMDB_KEY || 'c38f916ce25f02182165b028993509d4';
const BROWSERLESS_KEY = process.env.BROWSERLESS_KEY || '2UBBQ73kcdGF6IV230e231c2508133ce41982112d9c6f001d';

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
  if (url.includes('vimeos'))         return { ...HEADERS, 'Referer': 'https://vimeos.net/', 'Origin': 'https://vimeos.net' };
  return HEADERS;
}

// ─────────────────────────────────────────────
//  CACHE
// ─────────────────────────────────────────────
const cache      = new Map();
const CACHE_TTL  = 10 * 60 * 1000;
const m3u8Cache  = new Map();
const M3U8_TTL   = 90 * 1000;

function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL) { cache.delete(key); return null; }
  return e.data;
}
function cacheSet(key, data) { cache.set(key, { data, ts: Date.now() }); }

function m3u8Get(key) {
  const e = m3u8Cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > M3U8_TTL) { m3u8Cache.delete(key); return null; }
  return e.url;
}
function m3u8Set(key, url) { m3u8Cache.set(key, { url, ts: Date.now() }); }

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
    if (tmdbId) { imdbCache.set(key, tmdbId); console.log(`  [tmdb] ${imdbId} → ${tmdbId}`); }
    return tmdbId;
  } catch (err) {
    console.log(`  [tmdb] Error: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────
//  VIMEUS — obtener embeds
//  Maneja películas, series Y anime
// ─────────────────────────────────────────────
async function fetchEmbeds(url) {
  const { data: html } = await axios.get(url, {
    headers: { ...HEADERS, 'Referer': 'https://vimeus.com/', 'Origin': 'https://vimeus.com' },
    timeout: 30000,
  });
  const match = html.match(/<script[^>]+id="data"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return null;
  const data = JSON.parse(match[1].trim());
  if (data.seasons && (!data.embeds || !data.embeds.length)) return null;
  return { title: data.title, embeds: data.embeds || [] };
}

async function getEmbeds(embedUrl, type, id) {
  console.log(`  [vimeus] ${embedUrl}`);
  try {
    const result = await fetchEmbeds(embedUrl);
    if (result) {
      console.log(`  [vimeus] "${result.title}" — ${result.embeds.length} fuentes`);
      return result.embeds;
    }
  } catch (err) {
    // 404 o sin embeds — intentar con anime si es series
    if (err.response?.status !== 404 && !err.message.includes('404')) throw err;
  }

  // Si serie falla, intentar con anime
  if (type === 'series' || type === 'anime') {
    const parts   = id.split(':');
    const baseId  = parts[0] === 'tmdb' ? parts[1] : parts[0];
    const season  = parts[0] === 'tmdb' ? parts[2] : parts[1];
    const episode = parts[0] === 'tmdb' ? parts[3] : parts[2];
    const param   = baseId.startsWith('tt') ? `imdb=${baseId}` : `tmdb=${baseId}`;
    let animeUrl  = `${BASE}/e/anime?${param}&view_key=${VIEW_KEY}`;
    if (season && episode) animeUrl += `&se=${season}&ep=${episode}`;

    console.log(`  [vimeus] Reintentando como anime: ${animeUrl}`);
    try {
      const result = await fetchEmbeds(animeUrl);
      if (result) {
        console.log(`  [vimeus] ✅ Anime: "${result.title}" — ${result.embeds.length} fuentes`);
        return result.embeds;
      }
    } catch (err2) {
      console.log(`  [vimeus] Anime también falló: ${err2.message}`);
    }
  }

  return [];
}

// ─────────────────────────────────────────────
//  GOODSTREAM — extraer m3u8
// ─────────────────────────────────────────────
async function extractFromGoodstream(embedUrl) {
  console.log(`  [goodstream] ${embedUrl}`);
  const { data: html } = await axios.get(embedUrl, { headers: HEADERS, timeout: 30000 });
  const m3u8 = html.match(/https:\/\/[^"'\s]+\.m3u8[^"'\s]*/);
  if (m3u8) { console.log(`  [goodstream] ✅`); return m3u8[0]; }
  return null;
}

// ─────────────────────────────────────────────
//  VIMEOS — extraer m3u8 via Browserless
// ─────────────────────────────────────────────
async function extractFromVimeos(embedUrl) {
  console.log(`  [vimeos/browserless] ${embedUrl}`);
  let browser;
  try {
    browser = await puppeteer.connect({
      browserWSEndpoint: `wss://production-sfo.browserless.io?token=${BROWSERLESS_KEY}&stealth=true&blockAds=true`,
    });
    const page   = await browser.newPage();
    let m3u8     = null;
    const client = await page.createCDPSession();
    await client.send('Network.enable');
    client.on('Network.requestWillBeSent', ({ request }) => {
      if (!m3u8 && request.url.includes('.m3u8')) {
        m3u8 = request.url;
        console.log(`  [vimeos/browserless] ✅ ${request.url.slice(0, 80)}...`);
      }
    });
    await page.setExtraHTTPHeaders({ 'Referer': 'https://vimeus.com/', 'Origin': 'https://vimeus.com' });
    await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const deadline = Date.now() + 20000;
    while (!m3u8 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500));
    }
    await page.close();
    return m3u8;
  } catch (err) {
    console.error(`  [vimeos/browserless] Error: ${err.message}`);
    return null;
  } finally {
    if (browser) await browser.disconnect();
  }
}

// ─────────────────────────────────────────────
//  ORQUESTADOR
// ─────────────────────────────────────────────
const SOURCE_PRIORITY = ['goodstream.one', 'vimeos.net', 'vimeos.zip', 'vimeos.tv', 'hlswish.com', 'voe.sx', 'filemoon.sx'];
const VIMEOS_DOMAINS  = ['vimeos.net', 'vimeos.zip', 'vimeos.tv'];

async function getM3U8FromEmbeds(embeds) {
  const sorted = [...embeds].sort((a, b) => {
    const ai = SOURCE_PRIORITY.findIndex(s => a.url.includes(s));
    const bi = SOURCE_PRIORITY.findIndex(s => b.url.includes(s));
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  const promises = sorted.map(async embed => {
    try {
      const hostname = new URL(embed.url).hostname;
      const isVimeos = VIMEOS_DOMAINS.some(d => embed.url.includes(d));
      if (embed.url.includes('goodstream.one')) {
        const m3u8 = await extractFromGoodstream(embed.url);
        if (m3u8) return { m3u8, lang: embed.lang, quality: embed.quality, source: 'goodstream', embedUrl: embed.url };
      } else if (isVimeos) {
        return { vimeosEmbed: embed.url, lang: embed.lang, quality: embed.quality, source: hostname };
      } else {
        return { externalUrl: embed.url, lang: embed.lang, quality: embed.quality, source: hostname };
      }
    } catch (err) {
      console.log(`  [warn] ${err.message}`);
    }
    return null;
  });

  return (await Promise.all(promises)).filter(Boolean);
}

// ─────────────────────────────────────────────
//  BUILD EMBED URL
// ─────────────────────────────────────────────
function buildEmbedUrl(type, id) {
  const parts = id.split(':');
  let baseId, season, episode;
  if (parts[0] === 'tmdb') {
    baseId = parts[1]; season = parts[2] || null; episode = parts[3] || null;
  } else {
    baseId = parts[0]; season = parts[1] || null; episode = parts[2] || null;
  }
  const param = baseId.startsWith('tt') ? `imdb=${baseId}` : `tmdb=${baseId}`;

  if (type === 'movie') {
    return `${BASE}/e/movie?${param}&view_key=${VIEW_KEY}`;
  }
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
  const prefix = parts[0];
  const baseId = prefix === 'tmdb' || prefix === 'kitsu' ? parts[1] : parts[0];

  if (baseId.startsWith('tt')) {
    const tmdbId = await imdbToTmdb(baseId, type);
    if (!tmdbId) { console.log(`  → No TMDB ID para ${baseId}`); return null; }
    const newId = prefix === 'tmdb'
      ? ['tmdb', tmdbId, ...parts.slice(2)].join(':')
      : [tmdbId, ...parts.slice(1)].join(':');
    id = newId;
  }

  const embedUrl = buildEmbedUrl(type, id);
  if (!embedUrl) return null;

  const embeds = await getEmbeds(embedUrl, type, id);
  if (!embeds.length) return null;

  const results = await getM3U8FromEmbeds(embeds);
  if (results.length) cacheSet(cacheKey, results);
  return results.length ? results : null;
}

// ─────────────────────────────────────────────
//  PROXY
// ─────────────────────────────────────────────
app.get('/proxy/goodstream', async (req, res) => {
  const { embed: embedB64, type, id } = req.query;
  const embedUrl = Buffer.from(embedB64, 'base64').toString('utf8');
  const cacheKey = `m3u8:${embedUrl}`;

  const serveM3U8 = async (m3u8Url) => {
    const r    = await axios.get(m3u8Url, { headers: getHeaders(m3u8Url), timeout: 30000 });
    let content = r.data;
    const base  = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1);
    content = content.replace(/^([^#\r\n][^\r\n]+\.m3u8[^\r\n]*)$/gm, line => {
      const abs = line.trim().startsWith('http') ? line.trim() : base + line.trim();
      return `${HOST}/proxy/rendition?url=${Buffer.from(abs).toString('base64')}`;
    });
    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.set('Access-Control-Allow-Origin', '*');
    res.send(content);
  };

  // Siempre token fresco — expira muy rápido en goodstream
  console.log(`  [proxy/goodstream] Obteniendo token fresco`);
  try {
    m3u8 = await extractFromGoodstream(embedUrl);
    if (!m3u8) return res.status(404).send('No se encontró m3u8');
    m3u8Set(cacheKey, m3u8);
    return await serveM3U8(m3u8);
  } catch (err) {
    console.error(`  [proxy/goodstream] Error: ${err.message}`);
    return res.status(500).send('Error');
  }
});

app.get('/proxy/vimeos', async (req, res) => {
  const { url: urlB64, type, id } = req.query;
  const embedUrl = Buffer.from(urlB64, 'base64').toString('utf8');
  console.log(`  [proxy/vimeos] ${embedUrl}`);
  try {
    const m3u8 = await extractFromVimeos(embedUrl);
    if (!m3u8) return res.status(404).send('No se encontró m3u8');
    const encoded = Buffer.from(m3u8).toString('base64');
    res.redirect(`/proxy/master?url=${encoded}&type=${type}&id=${id}`);
  } catch (err) {
    console.error(`  [proxy/vimeos] Error: ${err.message}`);
    res.status(500).send('Error');
  }
});

app.get('/proxy/master', async (req, res) => {
  const { url: urlB64 } = req.query;
  const realUrl = Buffer.from(urlB64, 'base64').toString('utf8');
  console.log(`  [proxy/master] ${realUrl.slice(0, 80)}...`);
  try {
    const r    = await axios.get(realUrl, { headers: getHeaders(realUrl), timeout: 30000 });
    let content = r.data;
    const base  = realUrl.substring(0, realUrl.lastIndexOf('/') + 1);
    content = content.replace(/^([^#\r\n][^\r\n]+\.m3u8[^\r\n]*)$/gm, line => {
      const abs = line.trim().startsWith('http') ? line.trim() : base + line.trim();
      return `${HOST}/proxy/rendition?url=${Buffer.from(abs).toString('base64')}`;
    });
    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.set('Access-Control-Allow-Origin', '*');
    res.send(content);
  } catch (err) {
    console.error(`  [proxy/master] Error: ${err.message}`);
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
    version     : '9.0.0',
    resources   : ['stream'],
    types       : ['movie', 'series', 'anime'],
    catalogs    : [],
    idPrefixes  : ['tt', 'tmdb:', 'kitsu:'],
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
      if (r.embedUrl) {
        const encoded  = Buffer.from(r.embedUrl).toString('base64');
        const proxyUrl = `${HOST}/proxy/goodstream?embed=${encoded}&type=${type}&id=${id}`;
        return {
          name : `Vimeus · ${r.quality || 'HD'} · ${r.lang || ''}`.trim(),
          title: '▶ Goodstream',
          url  : proxyUrl,
        };
      } else if (r.vimeosEmbed) {
        return {
          name       : `Vimeus · ${r.quality || 'HD'} · ${r.lang || ''}`.trim(),
          title      : '🌐 Vimeos (HD)',
          externalUrl: r.vimeosEmbed,
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

app.get('/cache/clear', (req, res) => {
  cache.clear(); m3u8Cache.clear();
  res.json({ ok: true });
});

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
  console.log(`\n✅ Addon Vimeus v9.0 corriendo en http://localhost:${PORT}`);
  console.log(`   Manifest → http://localhost:${PORT}/manifest.json`);
  console.log(`   Debug    → http://localhost:${PORT}/debug/movie/tt2395427`);
  console.log(`   Anime    → http://localhost:${PORT}/debug/anime/70881:1:1\n`);
});
