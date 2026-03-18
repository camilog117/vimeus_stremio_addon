const axios = require('axios');

async function main() {
  // Step 1: verificar que el master.m3u8 es accesible
  const masterUrl = 'https://hls1.goodstream.one/hls2/02/00018/dnbnjb8ltj5l_,n,h,.urlset/master.m3u8?t=rVKuiZX9Z3ts-sRDVSLS_Z0Q1rL3TVTUNyEvhh_uSmA&s=1773804034&e=43200&v=247584090&srv=s1&i=0.3&sp=0';
  
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer': 'https://goodstream.one/',
    'Origin': 'https://goodstream.one',
  };

  try {
    const r1 = await axios.get(masterUrl, { headers, timeout: 15000 });
    console.log('master.m3u8 STATUS:', r1.status);
    console.log('Contenido:\n', r1.data.slice(0, 500));

    // Step 2: sacar la primera variante y probar
    const lines = r1.data.split('\n');
    const variantUrl = lines.find(l => l.includes('.m3u8'));
    if (variantUrl) {
      const absVariant = variantUrl.startsWith('http') ? variantUrl : 
        masterUrl.substring(0, masterUrl.lastIndexOf('/') + 1) + variantUrl;
      console.log('\nProbando variante:', absVariant);
      const r2 = await axios.get(absVariant.trim(), { headers, timeout: 15000 });
      console.log('variante STATUS:', r2.status);
      console.log('Contenido:\n', r2.data.slice(0, 500));

      // Step 3: sacar el primer segmento .ts
      const lines2 = r2.data.split('\n');
      const segUrl = lines2.find(l => l.includes('.ts'));
      if (segUrl) {
        const absSeg = segUrl.startsWith('http') ? segUrl :
          absVariant.substring(0, absVariant.lastIndexOf('/') + 1) + segUrl;
        console.log('\nProbando segmento:', absSeg.trim().slice(0, 100));
        const r3 = await axios.get(absSeg.trim(), { headers, responseType: 'arraybuffer', timeout: 15000 });
        console.log('segmento STATUS:', r3.status, 'Bytes:', r3.data.byteLength);
      }
    }
  } catch(e) {
    console.log('FAIL:', e.response?.status, e.message);
  }
}

main();
