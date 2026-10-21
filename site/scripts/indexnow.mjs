#!/usr/bin/env node
// Tell IndexNow engines (Bing, Yandex, Seznam, Naver…) which URLs changed,
// so they recrawl within hours instead of on their own schedule. Google does
// not use IndexNow — submit the sitemap in Search Console for that.
//
//   npm run build && node scripts/indexnow.mjs            dry run: list URLs
//   node scripts/indexnow.mjs --submit                    POST them
//
// Run after a deploy is live. The key is public by design: the engines verify
// it by fetching https://wigolo.app/<key>.txt, which ships in public/.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "30849d3da27331f132af2733fb7a845b";
const HOST = "wigolo.app";
const SITE = join(dirname(fileURLToPath(import.meta.url)), "..");

const sitemap = readFileSync(join(SITE, "out", "sitemap.xml"), "utf8");
const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]).filter((u) => new URL(u).host === HOST);
if (urls.length === 0) throw new Error("No wigolo.app URLs in out/sitemap.xml — build with NEXT_PUBLIC_SITE_URL=https://wigolo.app first.");

if (!process.argv.includes("--submit")) {
  console.error(`${urls.length} URLs (dry run — pass --submit to send):\n  ${urls.join("\n  ")}`);
  process.exit(0);
}

const res = await fetch("https://api.indexnow.org/indexnow", {
  method: "POST",
  headers: { "content-type": "application/json; charset=utf-8" },
  body: JSON.stringify({ host: HOST, key: KEY, keyLocation: `https://${HOST}/${KEY}.txt`, urlList: urls }),
});
console.error(`IndexNow: ${res.status} ${res.statusText} for ${urls.length} URLs`);
if (!res.ok && res.status !== 202) process.exit(1);
