/**
 * Image-based palette extraction for `extract mode: 'brand'`.
 *
 * Pipeline:
 *   1. Validate the input buffer (size cap, MIME type — reject SVG/non-raster).
 *   2. Decode + resize via sharp (already a transitive dependency through
 *      @huggingface/transformers, so no new bundle cost). Resize to <=200px
 *      on the long edge before quantization — k-means over 2000x2000 is the
 *      sort of accident that turns a 2s budget into a 12s budget.
 *   3. Quantize to k=5 clusters with a small k-means (10 iterations).
 *   4. Filter near-monochrome clusters (white/black/grey) when at least one
 *      saturated cluster exists. Real logos are usually mostly white/transparent
 *      with the brand mark as a small accent — without this filter we'd return
 *      ["#ffffff", "#fefefe"] on every site.
 *   5. Sort surviving clusters by cluster size and emit hex codes.
 *
 * We pick k-means over node-vibrant because sharp + a ~80-line k-means
 * adds zero new dependencies (~0KB bundle delta) versus node-vibrant's
 * ~500KB. The trade-off is we lose Vibrant's perceptual-LAB heuristics,
 * but the saturation/lightness filter below recovers most of the
 * downstream signal for brand palette use.
 */
import sharp from 'sharp';
import { createLogger } from '../logger.js';

const log = createLogger('extract');

/** Hard cap on input image bytes. >2MB inputs blow the 2s round-trip budget. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** Hard cap on declared input pixels (width × height). 50M pixels covers any
 *  realistic logo (5000×10000) while blocking pixel-bomb decode attacks that
 *  declare absurd canvas sizes to exhaust memory. libvips would otherwise
 *  default to ~1B pixels. */
const MAX_INPUT_PIXELS = 50_000_000;

/** Long-edge target for resize before quantization. 200px gives 40,000 pixels max — k-means converges fast. */
const RESIZE_LONG_EDGE = 200;

/** k-means cluster count. 5 captures common brand palette breadth without overfitting. */
const K = 5;

/** k-means iteration cap. 10 is plenty on 40K pixels — convergence is usually <=6 iterations. */
const MAX_ITERS = 10;

/** Saturated-color threshold. RGB max-min spread <30 means near-grey. */
const SATURATION_SPREAD_MIN = 30;

/** Near-white threshold. All channels >=240 collapses to "#ffffff" for palette purposes. */
const NEAR_WHITE = 240;

/** Near-black threshold. All channels <=15 collapses to "#000000" for palette purposes. */
const NEAR_BLACK = 15;

/** Final palette cap. Two is the spec minimum; five gives downstream UIs a bit of breadth without flood. */
const MAX_OUT_COLORS = 5;

export interface PaletteResult {
  colors: string[];
}

interface ClusterAccumulator {
  rSum: number;
  gSum: number;
  bSum: number;
  count: number;
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  const hex = (n: number) => clamp(n).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return {
    r: (n >> 16) & 0xff,
    g: (n >> 8) & 0xff,
    b: n & 0xff,
  };
}

function spread(r: number, g: number, b: number): number {
  return Math.max(r, g, b) - Math.min(r, g, b);
}

function isNearWhite(r: number, g: number, b: number): boolean {
  return r >= NEAR_WHITE && g >= NEAR_WHITE && b >= NEAR_WHITE;
}

function isNearBlack(r: number, g: number, b: number): boolean {
  return r <= NEAR_BLACK && g <= NEAR_BLACK && b <= NEAR_BLACK;
}

function isNearGrey(r: number, g: number, b: number): boolean {
  return spread(r, g, b) < SATURATION_SPREAD_MIN;
}

function isRasterMime(mime: string): boolean {
  const m = mime.toLowerCase();
  // Reject SVG and other XML/text formats. Whitelist common raster MIMEs.
  if (m.includes('svg')) return false;
  if (m.includes('xml')) return false;
  return (
    m.includes('png') ||
    m.includes('jpeg') ||
    m.includes('jpg') ||
    m.includes('webp') ||
    m.includes('gif') ||
    m.includes('avif') ||
    m.includes('image') // last-resort raster fallback; sharp will reject if bytes don't decode
  );
}

/**
 * Sample `K` distinct seed pixels from the buffer for k-means init.
 * We stride evenly through the pixel array so seeds come from spatially
 * different regions of the image — picking sequential pixels would seed
 * from a single corner and produce a low-quality starting partition.
 */
function pickSeeds(pixels: Uint8Array, k: number): Array<[number, number, number]> {
  const totalPx = pixels.length / 3;
  const seeds: Array<[number, number, number]> = [];
  const seen = new Set<string>();
  const stride = Math.max(1, Math.floor(totalPx / (k * 4)));
  for (let i = 0; i < totalPx && seeds.length < k; i += stride) {
    const off = i * 3;
    const r = pixels[off];
    const g = pixels[off + 1];
    const b = pixels[off + 2];
    const key = `${r},${g},${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    seeds.push([r, g, b]);
  }
  // Pad with random pixels if dedup left us short (very low-color images).
  while (seeds.length < k) {
    const idx = Math.floor(Math.random() * totalPx) * 3;
    seeds.push([pixels[idx], pixels[idx + 1], pixels[idx + 2]]);
  }
  return seeds;
}

function sqDist(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return dr * dr + dg * dg + db * db;
}

/**
 * Run k-means on RGB pixels. Returns final centroids + their pixel counts
 * so callers can sort by dominance.
 */
function kmeans(pixels: Uint8Array, k: number): Array<{ r: number; g: number; b: number; count: number }> {
  const totalPx = pixels.length / 3;
  if (totalPx === 0) return [];

  let centroids = pickSeeds(pixels, k).map(([r, g, b]) => ({ r, g, b }));
  const acc: ClusterAccumulator[] = Array.from({ length: k }, () => ({
    rSum: 0,
    gSum: 0,
    bSum: 0,
    count: 0,
  }));

  for (let iter = 0; iter < MAX_ITERS; iter++) {
    for (let i = 0; i < k; i++) {
      acc[i].rSum = 0;
      acc[i].gSum = 0;
      acc[i].bSum = 0;
      acc[i].count = 0;
    }

    // Assignment step.
    for (let p = 0; p < totalPx; p++) {
      const off = p * 3;
      const r = pixels[off];
      const g = pixels[off + 1];
      const b = pixels[off + 2];
      let bestIdx = 0;
      let bestDist = sqDist(r, g, b, centroids[0].r, centroids[0].g, centroids[0].b);
      for (let i = 1; i < k; i++) {
        const d = sqDist(r, g, b, centroids[i].r, centroids[i].g, centroids[i].b);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }
      acc[bestIdx].rSum += r;
      acc[bestIdx].gSum += g;
      acc[bestIdx].bSum += b;
      acc[bestIdx].count++;
    }

    // Update step.
    let moved = false;
    for (let i = 0; i < k; i++) {
      if (acc[i].count === 0) continue;
      const nr = acc[i].rSum / acc[i].count;
      const ng = acc[i].gSum / acc[i].count;
      const nb = acc[i].bSum / acc[i].count;
      // Early-exit when no centroid shifts more than 1 unit per channel.
      if (Math.abs(nr - centroids[i].r) > 1 || Math.abs(ng - centroids[i].g) > 1 || Math.abs(nb - centroids[i].b) > 1) {
        moved = true;
      }
      centroids[i] = { r: nr, g: ng, b: nb };
    }
    if (!moved) break;
  }

  return centroids.map((c, i) => ({
    r: c.r,
    g: c.g,
    b: c.b,
    count: acc[i].count,
  }));
}

/**
 * Apply brand-color heuristics to the raw k-means output:
 *   1. Drop empty clusters.
 *   2. Dedupe near-identical centroids (within 8 RGB units in every channel).
 *   3. Promote saturated clusters above near-monochrome ones.
 *   4. Sort by cluster size within each tier.
 * Returns hex codes capped at MAX_OUT_COLORS.
 */
function rankAndFilterClusters(
  clusters: Array<{ r: number; g: number; b: number; count: number }>,
): string[] {
  const populated = clusters.filter((c) => c.count > 0);
  if (populated.length === 0) return [];

  // Categorize each cluster as saturated / monochrome.
  const enriched = populated.map((c) => {
    const r = Math.round(c.r);
    const g = Math.round(c.g);
    const b = Math.round(c.b);
    const mono = isNearWhite(r, g, b) || isNearBlack(r, g, b) || isNearGrey(r, g, b);
    return { ...c, r, g, b, mono };
  });

  const saturated = enriched.filter((c) => !c.mono).sort((a, b) => b.count - a.count);
  const monochrome = enriched.filter((c) => c.mono).sort((a, b) => b.count - a.count);

  // Saturated clusters first (brand color is what we're after). Fall back
  // to monochrome only if we don't yet have ≥2 colors — a logo that is
  // pure black/white still benefits from `["#000000", "#ffffff"]` as a
  // signal of "this brand is monochrome by design".
  const ordered: typeof enriched = [];
  for (const c of saturated) {
    ordered.push(c);
    if (ordered.length >= MAX_OUT_COLORS) break;
  }
  if (ordered.length < 2) {
    for (const c of monochrome) {
      ordered.push(c);
      if (ordered.length >= MAX_OUT_COLORS) break;
    }
  }

  // Dedupe centroids that round to the same hex / are within tolerance.
  const out: string[] = [];
  const seen: Array<{ r: number; g: number; b: number }> = [];
  const TOL = 8;
  for (const c of ordered) {
    const tooClose = seen.some(
      (s) => Math.abs(s.r - c.r) <= TOL && Math.abs(s.g - c.g) <= TOL && Math.abs(s.b - c.b) <= TOL,
    );
    if (tooClose) continue;
    seen.push({ r: c.r, g: c.g, b: c.b });
    out.push(rgbToHex(c.r, c.g, c.b));
    if (out.length >= MAX_OUT_COLORS) break;
  }

  return out;
}

/**
 * Extract a dominant-color palette from an image buffer.
 *
 * Returns null when:
 *   - input exceeds MAX_IMAGE_BYTES,
 *   - MIME type is non-raster (SVG, XML),
 *   - sharp fails to decode the buffer,
 *   - quantization produces no surviving clusters.
 *
 * On success: returns ≥1 hex code (best-effort to surface ≥2 when bitmap
 * has multiple distinct regions). Caller decides whether the result is
 * usable; if `colors.length < 2`, caller may choose to set provenance
 * back to 'unknown'.
 */
export async function extractPaletteFromBuffer(
  buffer: Buffer,
  mimeType: string,
): Promise<PaletteResult | null> {
  if (buffer.length > MAX_IMAGE_BYTES) {
    log.debug('palette: input exceeds byte cap', { bytes: buffer.length, cap: MAX_IMAGE_BYTES });
    return null;
  }
  if (!isRasterMime(mimeType)) {
    log.debug('palette: non-raster MIME, skipping', { mimeType });
    return null;
  }

  let raw: { data: Buffer; info: sharp.OutputInfo };
  try {
    raw = await sharp(buffer, {
      failOn: 'none',
      // Decode only the first frame of animated GIF/WebP/AVIF inputs.
      // Without these, a malicious 1000-frame GIF could blow the memory
      // budget; even a legitimate animated logo would have its palette
      // averaged across frames (the dominant color of a fade animation
      // is not the brand color).
      pages: 1,
      animated: false,
      // Cap declared pixels to block decode-bomb inputs. 50M = 7000×7000;
      // any real logo fits well under that.
      limitInputPixels: MAX_INPUT_PIXELS,
    })
      .resize(RESIZE_LONG_EDGE, RESIZE_LONG_EDGE, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .removeAlpha() // alpha-blended logos would otherwise dump alpha into the cluster bias
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch (err) {
    log.debug('palette: sharp decode failed', { error: String(err) });
    return null;
  }

  if (raw.info.channels !== 3) {
    log.debug('palette: unexpected channel count after removeAlpha', { channels: raw.info.channels });
    return null;
  }

  const clusters = kmeans(new Uint8Array(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength), K);
  const colors = rankAndFilterClusters(clusters);
  if (colors.length === 0) return null;
  return { colors };
}

export const __internal = {
  hexToRgb,
  rgbToHex,
  isNearWhite,
  isNearBlack,
  isNearGrey,
  isRasterMime,
  kmeans,
  rankAndFilterClusters,
};
