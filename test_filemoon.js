const axios = require('axios');

const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Referer': 'https://filemoon.sx/',
  'Origin': 'https://filemoon.sx',
};

async function main() {
  const embedUrl = 'https://filemoon.sx/e/nbzvccc8aikc';
  const fileCode = embedUrl.split('/e/')[1];
  
  console.log('fileCode:', fileCode);
  
  // Intentar API de filemoon
  const apis = [
    `https://filemoon.sx/api/source/${fileCode}`,
    `https://filemoon.sx/dl?op=embed&file_code=${fileCode}&auto=1`,
    `https://filemoon.sx/dl?op=download_orig&id=${fileCode}`,
  ];
  
  for (const api of apis) {
    try {
      console.log(`\nProbando: ${api}`);
      const r = await axios.post(api, `r=&d=${fileCode}`, { 
        headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000 
      });
      console.log('STATUS:', r.status);
      console.log('DATA:', JSON.stringify(r.data).slice(0, 300));
    } catch(e) {
      try {
        const r = await axios.get(api, { headers, timeout: 10000 });
        console.log('STATUS GET:', r.status);
        const m3u8 = r.data.toString().match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/);
        if (m3u8) console.log('✅ m3u8:', m3u8[0]);
        else console.log('DATA:', r.data.toString().slice(0, 300));
      } catch(e2) {
        console.log('FAIL:', e2.response?.status, e2.message);
      }
    }
  }
}

main();
