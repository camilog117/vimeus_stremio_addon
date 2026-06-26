const axios = require('axios');

const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Referer': 'https://voe.sx/',
  'Origin': 'https://voe.sx',
};

async function main() {
  const embedUrl = 'https://voe.sx/e/ljp3rszhxpsc';
  const fileCode = embedUrl.split('/e/')[1];
  console.log('fileCode:', fileCode);

  // Intentar URL alternativa sin /e/
  const urls = [
    `https://voe.sx/${fileCode}`,
    `https://voe.sx/e/${fileCode}`,
    `https://voe.sx/dl?op=download_orig&id=${fileCode}`,
    `https://voe.sx/api/source/${fileCode}`,
    `https://voe.sx/player/${fileCode}`,
  ];

  for (const url of urls) {
    try {
      console.log(`\nProbando: ${url}`);
      const r = await axios.get(url, { headers, timeout: 10000, maxRedirects: 5 });
      console.log('STATUS:', r.status);
      const m3u8 = r.data.toString().match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/);
      const mp4  = r.data.toString().match(/https?:\/\/[^"'\s]+\.mp4[^"'\s]*/);
      if (m3u8) console.log('✅ m3u8:', m3u8[0]);
      else if (mp4) console.log('✅ mp4:', mp4[0]);
      else console.log('HTML:', r.data.toString().slice(0, 200));
    } catch(e) {
      console.log('FAIL:', e.response?.status, e.message);
    }
  }
}

main();
