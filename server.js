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
//  CONVERSIÓN DE IDs A TMDB
// ─────────────────────────────────────────────
const idCache = new Map();

// IMDb → TMDB
async function imdbToTmdb(imdbId, type) {
  const key = `imdb:${type}:${imdbId}`;
  if (idCache.has(key)) return idCache.get(key);
  try {
    const { data } = await axios.get(
      `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_KEY}&external_source=imdb_id`,
      { timeout: 10000 }
    );
    const result = type === 'movie' ? data.movie_results?.[0] : data.tv_results?.[0];
    const tmdbId = result?.id?.toString() || null;
    if (tmdbId) { idCache.set(key, tmdbId); console.log(`  [tmdb] ${imdbId} → ${tmdbId}`); }
    return tmdbId;
  } catch (err) {
    console.log(`  [tmdb] Error: ${err.message}`);
    return null;
  }
}

// Kitsu → TMDB (via API de Kitsu para obtener el título, luego buscar en TMDB)
async function kitsuToTmdb(kitsuId) {
  const key = `kitsu:${kitsuId}`;
  if (idCache.has(key)) return idCache.get(key);
  try {
    // Obtener info del anime desde Kitsu
    const kitsuRes = await axios.get(
      `https://kitsu.io/api/edge/anime/${kitsuId}`,
      { timeout: 10000, headers: { 'Accept': 'application/vnd.api+json' } }
    );
    const attrs = kitsuRes.data?.data?.attributes;
    if (!attrs) return null;

    // Intentar con el ID de TVDB que Kitsu a veces expone
    const mappingsRes = await axios.get(
      `https://kitsu.io/api/edge/anime/${kitsuId}/mappings`,
      { timeout: 10000, headers: { 'Accept': 'application/vnd.api+json' } }
    ).catch(() => null);

    if (mappingsRes) {
      const mappings = mappingsRes.data?.data || [];
      const tmdbMapping = mappings.find(m => m.attributes?.externalSite === 'thetvdb');
      if (tmdbMapping) {
        const tvdbId = tmdbMapping.attributes.externalId;
        const tmdbRes = await axios.get(
          `https://api.themoviedb.org/3/find/${tvdbId}?api_key=${TMDB_KEY}&external_source=tvdb_id`,
          { timeout: 10000 }
        );
        const result = tmdbRes.data?.tv_results?.[0];
        if (result) {
          const tmdbId = result.id.toString();
          idCache.set(key, tmdbId);
          console.log(`  [kitsu→tvdb→tmdb] ${kitsuId} → ${tmdbId}`);
          return tmdbId;
        }
      }
    }

    // Fallback: buscar por título en TMDB
    const title = attrs.canonicalTitle || attrs.titles?.en;
    if (!title) return null;
    console.log(`  [kitsu] Buscando por título: ${title}`);
    const searchRes = await axios.get(
      `https://api.themoviedb.org/3/search/tv?api_key=${TMDB_KEY}&query=${encodeURIComponent(title)}`,
      { timeout: 10000 }
    );
    const tmdbId = searchRes.data?.results?.[0]?.id?.toString() || null;
    if (tmdbId) {
      idCache.set(key, tmdbId);
      console.log(`  [kitsu→tmdb] ${kitsuId} → ${tmdbId} (${title})`);
    }
    return tmdbId;
  } catch (err) {
    console.log(`  [kitsu] Error: ${err.message}`);
    return null;
  }
}

// MAL → TMDB (via TMDB external IDs)
async function malToTmdb(malId) {
  const key = `mal:${malId}`;
  if (idCache.has(key)) return idCache.get(key);
  try {
    const { data } = await axios.get(
      `https://api.themoviedb.org/3/find/${malId}?api_key=${TMDB_KEY}&external_source=myanimelist_id`,
      { timeout: 10000 }
    );
    const result = data.tv_results?.[0] || data.movie_results?.[0];
    const tmdbId = result?.id?.toString() || null;
    if (tmdbId) { idCache.set(key, tmdbId); console.log(`  [mal→tmdb] ${malId} → ${tmdbId}`); }
    return tmdbId;
  } catch (err) {
    // TMDB no siempre tiene MAL IDs, fallback a Kitsu
    console.log(`  [mal] Error: ${err.message}`);
    return null;
  }
}

// Función principal de conversión de cualquier ID a TMDB
async function resolveToTmdb(prefix, id, type) {
  switch(prefix) {
    case 'tt':      return await imdbToTmdb(prefix + id, type);
    case 'kitsu':   return await kitsuToTmdb(id);
    case 'mal':     return await malToTmdb(id);
    case 'anilist': return null; // Sin soporte directo, se puede agregar después
    case 'anidb':   return null;
    default:        return null;
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

  if (data.seasons && (!data.embeds || !data.embeds.length)) {
    console.log(`  [vimeus] Anime sin episodio — se necesita se+ep en la URL`);
    return [];
  }

  console.log(`  [vimeus] "${data.title}" — ${data.embeds?.length || 0} fuentes`);
  return data.embeds || [];
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
//  GET STREAM — resuelve cualquier ID a TMDB
// ─────────────────────────────────────────────
async function getStream(type, id) {
  const cacheKey = `${type}:${id}`;
  const cached   = cacheGet(cacheKey);
  if (cached) { console.log(`  [CACHE] ${cacheKey}`); return cached; }

  const parts  = id.split(':');
  const prefix = parts[0];
  let tmdbId   = null;
  let season   = null;
  let episode  = null;

  if (prefix === 'tmdb') {
    // tmdb:12345 o tmdb:12345:1:1
    tmdbId  = parts[1];
    season  = parts[2] || null;
    episode = parts[3] || null;
  } else if (prefix === 'kitsu' || prefix === 'mal' || prefix === 'anilist' || prefix === 'anidb') {
    // kitsu:12345:1:1
    const rawId = parts[1];
    season      = parts[2] || null;
    episode     = parts[3] || null;
    tmdbId      = await resolveToTmdb(prefix, rawId, type);
    if (!tmdbId) { console.log(`  → No TMDB ID para ${prefix}:${rawId}`); return null; }
  } else if (parts[0].startsWith('tt')) {
    // tt1234567 o tt1234567:1:1
    tmdbId  = await imdbToTmdb(parts[0], type);
    season  = parts[1] || null;
    episode = parts[2] || null;
    if (!tmdbId) { console.log(`  → No TMDB ID para ${parts[0]}`); return null; }
  } else {
    // ID numérico directo: 12345 o 12345:1:1
    tmdbId  = parts[0];
    season  = parts[1] || null;
    episode = parts[2] || null;
  }

  // Construir ID final con tmdb
  const finalId = season && episode
    ? `${tmdbId}:${season}:${episode}`
    : tmdbId;

  const embedUrl = buildEmbedUrl(type, finalId);
  if (!embedUrl) return null;

  const embeds = await getEmbeds(embedUrl);
  if (!embeds.length) return null;

  const results = await getM3U8FromEmbeds(embeds);
  if (results.length) cacheSet(cacheKey, results);
  return results.length ? results : null;
}

// ─────────────────────────────────────────────
//  PROXY
// ─────────────────────────────────────────────
app.get('/proxy/goodstream', async (req, res) => {
  const { embed: embedB64 } = req.query;
  const embedUrl = Buffer.from(embedB64, 'base64').toString('utf8');

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

  console.log(`  [proxy/goodstream] Token fresco para: ${embedUrl}`);
  try {
    const m3u8 = await extractFromGoodstream(embedUrl);
    if (!m3u8) return res.status(404).send('No se encontró m3u8');
    return await serveM3U8(m3u8);
  } catch (err) {
    console.error(`  [proxy/goodstream] Error: ${err.message}`);
    return res.status(500).send('Error');
  }
});

app.get('/proxy/vimeos', async (req, res) => {
  const { url: urlB64 } = req.query;
  const embedUrl = Buffer.from(urlB64, 'base64').toString('utf8');
  console.log(`  [proxy/vimeos] ${embedUrl}`);
  try {
    const m3u8 = await extractFromVimeos(embedUrl);
    if (!m3u8) return res.status(404).send('No se encontró m3u8');
    const encoded = Buffer.from(m3u8).toString('base64');
    res.redirect(`/proxy/master?url=${encoded}`);
  } catch (err) {
    console.error(`  [proxy/vimeos] Error: ${err.message}`);
    res.status(500).send('Error');
  }
});

app.get('/proxy/master', async (req, res) => {
  const realUrl = Buffer.from(req.query.url, 'base64').toString('utf8');
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
    version     : '10.0.0',
    resources   : ['stream'],
    types       : ['movie', 'series', 'anime'],
    catalogs    : [],
    idPrefixes  : ['tt', 'tmdb:', 'kitsu:', 'mal:', 'anilist:', 'anidb:'],
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

    const streams = [];
    for (const r of results) {
      if (r.embedUrl) {
        // Goodstream: stream interno para Stremio
        const encoded  = Buffer.from(r.embedUrl).toString('base64');
        const proxyUrl = `${HOST}/proxy/goodstream?embed=${encoded}`;
        streams.push({
          name : `Vimeus · ${r.quality || 'HD'} · ${r.lang || ''}`.trim(),
          title: '▶ Goodstream',
          url  : proxyUrl,
        });
        // También como enlace externo para Web Video Caster
        streams.push({
          name       : `Vimeus · ${r.quality || 'HD'} · ${r.lang || ''} · Externo`.trim(),
          title      : '🌐 Goodstream (externo)',
          externalUrl: r.embedUrl,
        });
      } else if (r.vimeosEmbed) {
        streams.push({
          name       : `Vimeus · ${r.quality || 'HD'} · ${r.lang || ''}`.trim(),
          title      : '🌐 Vimeos (HD)',
          externalUrl: r.vimeosEmbed,
        });
      } else if (r.externalUrl) {
        streams.push({
          name       : `Vimeus · ${r.quality || 'HD'} · ${r.lang || ''}`.trim(),
          title      : `🌐 ${r.source}`,
          externalUrl: r.externalUrl,
        });
      }
    }

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
  cache.clear(); idCache.clear();
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
  console.log(`\n✅ Addon Vimeus v10.0 corriendo en http://localhost:${PORT}`);
  console.log(`   Manifest → http://localhost:${PORT}/manifest.json`);
  console.log(`   Debug    → http://localhost:${PORT}/debug/movie/tt2395427`);
  console.log(`   Anime    → http://localhost:${PORT}/debug/anime/kitsu:12:1:1\n`);
});
