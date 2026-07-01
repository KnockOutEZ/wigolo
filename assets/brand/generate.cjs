// Regenerate the wigolo brand PNGs from the spec (see README.md in this folder).
// Usage: node assets/brand/generate.cjs
// Downloads Inter (ExtraBold) and renders the wordmark + icon with the bundled
// browser engine. Requires the project's dev dependencies to be installed.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');

const OUT = __dirname;
const OFFWHITE = '#f5f3ee';
const BLACK = '#1a1a1a';
const WEIGHT = process.env.WM_WEIGHT || '800';

const FONT_URLS = {
  800: 'https://cdn.jsdelivr.net/npm/@fontsource/inter/files/inter-latin-800-normal.woff2',
  900: 'https://cdn.jsdelivr.net/npm/@fontsource/inter/files/inter-latin-900-normal.woff2',
};

async function fetchFont(weight) {
  const cache = path.join(os.tmpdir(), `wigolo-inter-${weight}.woff2`);
  if (!fs.existsSync(cache)) {
    const res = await fetch(FONT_URLS[weight]);
    if (!res.ok) throw new Error(`font ${weight} download failed: ${res.status}`);
    fs.writeFileSync(cache, Buffer.from(await res.arrayBuffer()));
  }
  return fs.readFileSync(cache).toString('base64');
}

(async () => {
  const f800 = await fetchFont(800);
  const f900 = await fetchFont(900);
  const FONTS = `
@font-face{font-family:Inter;font-weight:800;src:url(data:font/woff2;base64,${f800}) format('woff2');}
@font-face{font-family:Inter;font-weight:900;src:url(data:font/woff2;base64,${f900}) format('woff2');}
*{margin:0;padding:0;box-sizing:border-box}`;

  const wordmarkHtml = `<!doctype html><meta charset="utf8"><style>${FONTS}
html,body{background:transparent}
.wm{font-family:Inter;font-weight:${WEIGHT};letter-spacing:-0.055em;text-transform:lowercase;font-size:240px;line-height:1;display:inline-block;padding:0.14em 0.07em 0.24em;}
#wm-dark{color:${OFFWHITE}} #wm-light{color:${BLACK}}
</style><div id="wm-dark" class="wm">wigolo</div><br><div id="wm-light" class="wm">wigolo</div>`;

  const iconHtml = `<!doctype html><meta charset="utf8"><style>${FONTS}
html,body{width:512px;height:512px;background:transparent}
.icon{width:512px;height:512px;background:${BLACK};border-radius:115px;display:flex;align-items:center;justify-content:center;overflow:hidden}
.icon span{font-family:Inter;font-weight:${WEIGHT};color:${OFFWHITE};font-size:360px;line-height:1;letter-spacing:-0.05em;transform:translateY(-0.015em)}
</style><div class="icon"><span>w</span></div>`;

  const browser = await chromium.launch();

  const p1 = await browser.newPage({ deviceScaleFactor: 3 });
  await p1.setContent(wordmarkHtml, { waitUntil: 'load' });
  await p1.evaluate(() => document.fonts.ready);
  for (const [id, file] of [['wm-dark', 'wigolo-wordmark-dark.png'], ['wm-light', 'wigolo-wordmark-light.png']]) {
    await (await p1.$('#' + id)).screenshot({ path: path.join(OUT, file), omitBackground: true });
  }

  const p2 = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 3 });
  await p2.setContent(iconHtml, { waitUntil: 'load' });
  await p2.evaluate(() => document.fonts.ready);
  await p2.screenshot({ path: path.join(OUT, 'wigolo-icon.png') });

  await browser.close();
  console.log('wrote wigolo-wordmark-{dark,light}.png and wigolo-icon.png');
})();
