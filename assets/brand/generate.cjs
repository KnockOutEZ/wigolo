// Regenerate the wigolo brand assets from the spec (see README.md in this folder).
// Usage: node assets/brand/generate.cjs
// Downloads Inter (ExtraBold) and renders the wordmark, icon, and banners with
// the bundled browser engine. Requires the project's dev dependencies installed.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');

const OUT = __dirname;
const OFFWHITE = '#f5f3ee';
const BLACK = '#1a1a1a';
const MUTED = '#9a938c';
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

  const browser = await chromium.launch();

  // --- Wordmarks (transparent) ---
  const wordmarkHtml = `<!doctype html><meta charset="utf8"><style>${FONTS}
html,body{background:transparent}
.wm{font-family:Inter;font-weight:${WEIGHT};letter-spacing:-0.055em;text-transform:lowercase;font-size:240px;line-height:1;display:inline-block;padding:0.14em 0.07em 0.24em;}
#wm-dark{color:${OFFWHITE}} #wm-light{color:${BLACK}}
</style><div id="wm-dark" class="wm">wigolo</div><br><div id="wm-light" class="wm">wigolo</div>`;
  const p1 = await browser.newPage({ deviceScaleFactor: 3 });
  await p1.setContent(wordmarkHtml, { waitUntil: 'load' });
  await p1.evaluate(() => document.fonts.ready);
  for (const [id, file] of [['wm-dark', 'wigolo-wordmark-dark.png'], ['wm-light', 'wigolo-wordmark-light.png']]) {
    await (await p1.$('#' + id)).screenshot({ path: path.join(OUT, file), omitBackground: true });
  }

  // --- App icon (512 square) ---
  const iconHtml = `<!doctype html><meta charset="utf8"><style>${FONTS}
html,body{width:512px;height:512px;background:transparent}
.icon{width:512px;height:512px;background:${BLACK};border-radius:115px;display:flex;align-items:center;justify-content:center;overflow:hidden}
.icon span{font-family:Inter;font-weight:${WEIGHT};color:${OFFWHITE};font-size:360px;line-height:1;letter-spacing:-0.05em;transform:translateY(-0.015em)}
</style><div class="icon"><span>w</span></div>`;
  const p2 = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 3 });
  await p2.setContent(iconHtml, { waitUntil: 'load' });
  await p2.evaluate(() => document.fonts.ready);
  await p2.screenshot({ path: path.join(OUT, 'wigolo-icon.png') });

  // --- Hero banner (rounded dark card, transparent corners) ---
  const bannerHtml = `<!doctype html><meta charset="utf8"><style>${FONTS}
html,body{width:1200px;height:400px;background:transparent}
.banner{width:1200px;height:400px;background:${OFFWHITE};border-radius:36px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px}
.banner .wm{font-family:Inter;font-weight:${WEIGHT};letter-spacing:-0.055em;color:${BLACK};font-size:150px;line-height:1}
.banner .tag{font-family:Inter;font-weight:600;letter-spacing:-0.01em;color:#6f6862;font-size:32px}
</style><div class="banner"><div class="wm">wigolo</div><div class="tag">The go-to web for your agent</div></div>`;
  const p3 = await browser.newPage({ viewport: { width: 1200, height: 400 }, deviceScaleFactor: 2 });
  await p3.setContent(bannerHtml, { waitUntil: 'load' });
  await p3.evaluate(() => document.fonts.ready);
  await p3.screenshot({ path: path.join(OUT, 'wigolo-banner.png'), omitBackground: true });

  // --- Social preview (1280x640, full-bleed) ---
  const socialHtml = `<!doctype html><meta charset="utf8"><style>${FONTS}
html,body{width:1280px;height:640px}
.social{width:1280px;height:640px;background:${BLACK};display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px}
.social .wm{font-family:Inter;font-weight:${WEIGHT};letter-spacing:-0.055em;color:${OFFWHITE};font-size:210px;line-height:1}
.social .tag{font-family:Inter;font-weight:700;letter-spacing:-0.015em;color:${OFFWHITE};font-size:44px}
.social .sub{font-family:Inter;font-weight:500;color:${MUTED};font-size:27px}
</style><div class="social"><div class="wm">wigolo</div><div class="tag">The go-to web for your agent</div><div class="sub">Local-first web intelligence over MCP · no keys, no cloud</div></div>`;
  const p4 = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 2 });
  await p4.setContent(socialHtml, { waitUntil: 'load' });
  await p4.evaluate(() => document.fonts.ready);
  await p4.screenshot({ path: path.join(OUT, 'wigolo-social.png') });

  await browser.close();
  console.log('wrote wordmarks, icon, banner, social');
})();
