import type { Extractor, ExtractionResult } from '../../types.js';

// ─────────────────────────────────────────────────────────────────────────────
// YouTube site extractor
//
// Parses the `ytInitialPlayerResponse` and `ytInitialData` JSON blobs that
// YouTube inlines into every watch page. Returns video metadata + chapter list
// + caption-track descriptors.
//
// Transcript fetching is *not* performed here. The site-extractor interface is
// synchronous (`extract(html, url): ExtractionResult | null`) and transcripts
// live on a separate `timedtext` endpoint. To keep this extractor consistent
// with the rest of the pipeline (zero supplemental network calls), we surface
// `caption_tracks[]` and leave `transcript` as `[]`. A future async transcript
// fetcher can resolve those URLs out-of-band.
// ─────────────────────────────────────────────────────────────────────────────

// Hard caps on the inline-JSON scanner. YouTube's real blobs are well under
// 2 MB; anything larger is either a network anomaly or a malicious payload.
// Without these caps a never-closing `{` walks the entire HTML body and the
// final `html.slice()` allocates a multi-MB string before `JSON.parse` rejects.
const MAX_BLOB_BYTES = 5_000_000;
const MAX_SCAN_BYTES = 10_000_000;

// Caption track `baseUrl` is taken from inline JSON that YouTube emits, but a
// spoofed page (or future MITM scenario) could supply file://, internal IPs,
// or attacker-controlled hosts. Until a real consumer fetches these, treat
// them as untrusted and emit only the legitimate timedtext / googlevideo
// origins YouTube actually uses.
function isYoutubeOrGooglevideoHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === 'youtube.com' || h === 'www.youtube.com') return true;
  if (h.endsWith('.youtube.com')) return true;
  if (h === 'googlevideo.com' || h.endsWith('.googlevideo.com')) return true;
  return false;
}

function isSafeCaptionUrl(raw: string): boolean {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return false;
    return isYoutubeOrGooglevideoHost(u.hostname);
  } catch {
    return false;
  }
}

interface CaptionTrack {
  language_code: string;
  base_url: string;
  kind: string;
  name: string;
}

interface Chapter {
  start: number;
  title: string;
}

interface YoutubeMeta {
  video_id: string;
  channel: string;
  duration: string;
  duration_seconds: number;
  view_count: number;
  posted_at: string;
  chapters: Chapter[];
  caption_tracks: CaptionTrack[];
  transcript: Array<{ start: number; text: string }>;
  playability_status: string;
}

const WATCH_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
]);

function isYoutubeHost(hostname: string): boolean {
  if (WATCH_HOSTS.has(hostname)) return true;
  if (hostname === 'youtu.be') return true;
  return false;
}

function isWatchUrl(url: URL): boolean {
  const host = url.hostname;
  if (host === 'youtu.be') {
    // youtu.be/<id> short links — anything past the leading slash counts.
    return url.pathname.length > 1;
  }
  if (WATCH_HOSTS.has(host)) {
    return url.pathname === '/watch' && url.searchParams.has('v');
  }
  return false;
}

function extractJsonBlob(html: string, marker: string): unknown | null {
  // YouTube emits these as `var ytInitialPlayerResponse = { ... };` or
  // `window["ytInitialPlayerResponse"] = { ... };` — handle both by anchoring
  // on the marker, then scanning for the matching closing brace.
  const idx = html.indexOf(marker);
  if (idx === -1) return null;

  // Find the first `{` after the marker.
  const braceStart = html.indexOf('{', idx);
  if (braceStart === -1) return null;

  // Outer scan budget: a runaway/never-closing `{` must not walk a multi-MB
  // body. Cap absolute distance from braceStart at MAX_SCAN_BYTES.
  const scanEnd = Math.min(html.length, braceStart + MAX_SCAN_BYTES);

  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;

  for (let i = braceStart; i < scanEnd; i++) {
    const ch = html[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }

  if (end === -1) return null;

  // Inner cap: bail before allocating a multi-MB substring for JSON.parse.
  if (end - braceStart > MAX_BLOB_BYTES) return null;

  try {
    return JSON.parse(html.slice(braceStart, end + 1));
  } catch {
    return null;
  }
}

function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function toString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function formatIsoDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return 'PT0S';
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  let out = 'PT';
  if (hours > 0) out += `${hours}H`;
  if (minutes > 0) out += `${minutes}M`;
  if (seconds > 0 || (hours === 0 && minutes === 0)) out += `${seconds}S`;
  return out;
}

function parseCaptionTracks(player: Record<string, unknown>): CaptionTrack[] {
  const captions = player.captions as Record<string, unknown> | undefined;
  if (!captions) return [];
  const tracklist = captions.playerCaptionsTracklistRenderer as Record<string, unknown> | undefined;
  if (!tracklist) return [];
  const tracks = tracklist.captionTracks;
  if (!Array.isArray(tracks)) return [];

  const out: CaptionTrack[] = [];
  for (const raw of tracks) {
    if (!raw || typeof raw !== 'object') continue;
    const t = raw as Record<string, unknown>;
    const baseUrl = toString(t.baseUrl);
    if (!baseUrl) continue;
    // Drop entries whose baseUrl is not a legitimate youtube / googlevideo
    // HTTPS endpoint. Spoofed pages could otherwise inject file://, internal
    // IPs, or attacker-controlled hosts via the emitted `base_url`.
    if (!isSafeCaptionUrl(baseUrl)) continue;
    const nameObj = t.name as Record<string, unknown> | undefined;
    const name = nameObj ? toString(nameObj.simpleText) : '';
    out.push({
      language_code: toString(t.languageCode),
      base_url: baseUrl,
      kind: toString(t.kind),
      name,
    });
  }
  return out;
}

function parseChapters(initialData: unknown): Chapter[] {
  if (!initialData || typeof initialData !== 'object') return [];

  // The chapter blob is buried deep; walk known shape but bail on any mismatch.
  const playerOverlays = (initialData as Record<string, unknown>).playerOverlays;
  if (!playerOverlays || typeof playerOverlays !== 'object') return [];
  const por = (playerOverlays as Record<string, unknown>).playerOverlayRenderer;
  if (!por || typeof por !== 'object') return [];
  const outer = (por as Record<string, unknown>).decoratedPlayerBarRenderer;
  if (!outer || typeof outer !== 'object') return [];
  const inner = (outer as Record<string, unknown>).decoratedPlayerBarRenderer;
  if (!inner || typeof inner !== 'object') return [];
  const playerBar = (inner as Record<string, unknown>).playerBar;
  if (!playerBar || typeof playerBar !== 'object') return [];
  const multi = (playerBar as Record<string, unknown>).multiMarkersPlayerBarRenderer;
  if (!multi || typeof multi !== 'object') return [];
  const markersMap = (multi as Record<string, unknown>).markersMap;
  if (!Array.isArray(markersMap)) return [];

  for (const entry of markersMap) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (e.key !== 'DESCRIPTION_CHAPTERS') continue;
    const value = e.value as Record<string, unknown> | undefined;
    if (!value) continue;
    const rawChapters = value.chapters;
    if (!Array.isArray(rawChapters)) continue;

    const chapters: Chapter[] = [];
    for (const raw of rawChapters) {
      if (!raw || typeof raw !== 'object') continue;
      const cr = (raw as Record<string, unknown>).chapterRenderer as
        | Record<string, unknown>
        | undefined;
      if (!cr) continue;
      const titleObj = cr.title as Record<string, unknown> | undefined;
      const title = titleObj ? toString(titleObj.simpleText) : '';
      const millis = toNumber(cr.timeRangeStartMillis);
      chapters.push({ start: Math.floor(millis / 1000), title });
    }
    return chapters;
  }
  return [];
}

function buildMarkdown(meta: YoutubeMeta, title: string, description: string): string {
  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push('');
  if (meta.channel) lines.push(`**Channel:** ${meta.channel}`);
  if (meta.duration_seconds > 0) {
    lines.push(`**Duration:** ${meta.duration} (${meta.duration_seconds}s)`);
  }
  if (meta.view_count > 0) lines.push(`**Views:** ${meta.view_count.toLocaleString('en-US')}`);
  if (meta.posted_at) lines.push(`**Posted:** ${meta.posted_at}`);
  if (meta.video_id) lines.push(`**Video ID:** ${meta.video_id}`);
  lines.push('');

  if (description) {
    lines.push('## Description');
    lines.push('');
    lines.push(description);
    lines.push('');
  }

  if (meta.chapters.length > 0) {
    lines.push('## Chapters');
    lines.push('');
    for (const ch of meta.chapters) {
      lines.push(`- ${formatTimestamp(ch.start)} — ${ch.title}`);
    }
    lines.push('');
  }

  if (meta.caption_tracks.length > 0) {
    lines.push('## Captions');
    lines.push('');
    const langs = meta.caption_tracks.map((t) => t.name || t.language_code).join(', ');
    lines.push(`Available caption tracks: ${langs}`);
    lines.push('');
  }

  return lines.join('\n').trim();
}

function formatTimestamp(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export const youtubeExtractor: Extractor = {
  name: 'youtube',

  canHandle(url: string): boolean {
    try {
      const u = new URL(url);
      if (!isYoutubeHost(u.hostname)) return false;
      return isWatchUrl(u);
    } catch {
      return false;
    }
  },

  extract(html: string, _url: string): ExtractionResult | null {
    if (!html) return null;

    const playerJson = extractJsonBlob(html, 'ytInitialPlayerResponse');
    if (!playerJson || typeof playerJson !== 'object') return null;

    const player = playerJson as Record<string, unknown>;
    const videoDetails = (player.videoDetails as Record<string, unknown> | undefined) ?? {};
    const microformat = player.microformat as Record<string, unknown> | undefined;
    const microRenderer = microformat?.playerMicroformatRenderer as
      | Record<string, unknown>
      | undefined;
    const playabilityStatus = player.playabilityStatus as Record<string, unknown> | undefined;

    const status = toString(playabilityStatus?.status) || 'OK';
    const isUnplayable = status !== 'OK';

    const title = toString(videoDetails.title) || toString(microRenderer?.title);
    const videoId = toString(videoDetails.videoId);

    // If we cannot identify even the video, this is not a usable extraction.
    if (!videoId && !title) return null;

    const durationSeconds = toNumber(
      videoDetails.lengthSeconds ?? microRenderer?.lengthSeconds ?? 0,
    );
    const duration = formatIsoDuration(durationSeconds);

    const channel =
      toString(videoDetails.author) ||
      toString(microRenderer?.ownerChannelName);
    const description =
      toString(videoDetails.shortDescription) ||
      toString(microRenderer?.description);
    const viewCount = toNumber(videoDetails.viewCount ?? microRenderer?.viewCount ?? 0);
    const postedAt =
      toString(microRenderer?.uploadDate) ||
      toString(microRenderer?.publishDate);

    const captionTracks = isUnplayable ? [] : parseCaptionTracks(player);
    const initialData = extractJsonBlob(html, 'ytInitialData');
    const chapters = isUnplayable ? [] : parseChapters(initialData);

    const youtubeMeta: YoutubeMeta = {
      video_id: videoId,
      channel,
      duration,
      duration_seconds: durationSeconds,
      view_count: viewCount,
      posted_at: postedAt,
      chapters,
      caption_tracks: captionTracks,
      // Always empty — see header comment. Populated by an async caller, not here.
      transcript: [],
      playability_status: status,
    };

    const markdown = buildMarkdown(youtubeMeta, title || videoId, description);

    return {
      title: title || videoId,
      markdown,
      metadata: {
        ...({
          video_id: youtubeMeta.video_id,
          channel: youtubeMeta.channel,
          duration: youtubeMeta.duration,
          duration_seconds: youtubeMeta.duration_seconds,
          view_count: youtubeMeta.view_count,
          posted_at: youtubeMeta.posted_at,
          chapters: youtubeMeta.chapters,
          caption_tracks: youtubeMeta.caption_tracks,
          transcript: youtubeMeta.transcript,
          playability_status: youtubeMeta.playability_status,
        } as Record<string, unknown>),
        description,
        author: channel,
        date: postedAt,
      },
      links: [],
      images: [],
      extractor: 'site-specific',
    };
  },
};
