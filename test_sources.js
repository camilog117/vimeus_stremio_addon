const axios = require('axios');

const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Referer': 'https://vimeus.com/',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

async function testSource(name, url) {
  try {
    console.log(`\n=== ${name} ===`);
    console.log(`URL: ${url}`);
    
    const r = await axios.get(url, { headers, timeout: 15000 });
    console.log(`STATUS: ${r.status}`);
    
    // Buscar m3u8 directo
    const m3u8 = r.data.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/);
    if (m3u8) {
      console.log(`✅ m3u8 encontrado: ${m3u8[0].slice(0, 100)}`);
      
      // Probar si el m3u8 es accesible
      try {
        const r2 = await axios.get(m3u8[0], { 
          headers: { ...headers, 'Referer': new URL(url).origin + '/' },
          timeout: 10000 
        });
        console.log(`✅ m3u8 accesible! Status: ${r2.status}`);
        console.log(`Contenido: ${r2.data.slice(0, 200)}`);
      } catch(e) {
        console.log(`❌ m3u8 bloqueado: ${e.response?.status} ${e.message}`);
      }
    } else {
      console.log(`❌ m3u8 NO encontrado en HTML`);
      // Mostrar snippet del HTML para diagnóstico
      console.log(`HTML snippet: ${r.data.slice(0, 300)}`);
    }
  } catch(e) {
    console.log(`❌ FAIL: ${e.response?.status} ${e.message}`);
  }
}

async function main() {
  // URLs de El Señor de los Anillos: La Comunidad del Anillo
  await testSource('hlswish',    'https://hlswish.com/e/amctkm9h559u');
  await testSource('voe',        'https://voe.sx/e/ljp3rszhxpsc');
  await testSource('filemoon',   'https://filemoon.sx/e/nbzvccc8aikc');
}

main();
