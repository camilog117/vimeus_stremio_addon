const axios = require('axios');

const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Referer': 'https://vimeus.com/',
};

async function test(name, url) {
  try {
    const r = await axios.get(url, { headers, timeout: 15000 });
    const m3u8 = r.data.match(/https?:\/\/[^\s"']+\.m3u8[^\s"']*/);
    console.log(`\n=== ${name} ===`);
    console.log('STATUS:', r.status);
    console.log('m3u8:', m3u8 ? m3u8[0] : 'NO ENCONTRADO');
    if (!m3u8) console.log('HTML:', r.data.slice(0, 300));
  } catch(e) {
    console.log(`\n=== ${name} ===`);
    console.log('FAIL:', e.response?.status, e.message);
  }
}

async function main() {
  await test('hlswish',    'https://hlswish.com/e/x1sxsr21nfon');
  await test('voe',        'https://voe.sx/e/hwejxsd2okgj');
  await test('goodstream', 'https://goodstream.one/embed-dnbnjb8ltj5l.html');
}

main();
