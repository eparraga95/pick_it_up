/**
 * scraper/fill-step-artists.js
 *
 * For each song in songs.json where stepArtist is null, searches the official
 * "펌프잇업공식 PUMP IT UP Official" YouTube channel, fetches the video
 * description, and parses the "Step Artist:" field from it.
 *
 * Prerequisites:
 *   export YOUTUBE_API_KEY=your_key_here
 *   (Get a free key at https://console.cloud.google.com → YouTube Data API v3)
 *
 * Usage:
 *   node scraper/fill-step-artists.js           -- dry run (prints what would change)
 *   node scraper/fill-step-artists.js --apply   -- writes songs.json
 *
 * API cost estimate: ~100 units per search + 1 unit per 50 videos ≈ 3,840 units
 * (Free tier quota: 10,000 units/day)
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// Load .env from project root (Node 18 doesn't have --env-file built in)
const envPath = new URL('../.env', import.meta.url).pathname;
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const APPLY   = process.argv.includes('--apply');
const DB_PATH = new URL('../data/songs.json', import.meta.url).pathname;
const API_KEY = process.env.YOUTUBE_API_KEY;

// Official "펌프잇업공식 PUMP IT UP Official" channel ID.
// (forHandle resolution via channels.list returned a different channel, so hardcoded.)
const PIU_CHANNEL_ID = 'UC1zVbfSZSKz9r2AzF50l9sA';

// ms to wait between search calls to stay polite
const SEARCH_DELAY_MS = 200;

// ── YouTube API helpers ───────────────────────────────────────────────────────

async function ytGet(endpoint, params) {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
  params.key = API_KEY;
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`YouTube API error ${res.status}: ${body}`);
  }
  return res.json();
}

/**
 * Search YouTube for a song title and return the first video ID from the
 * official PIU channel, or null if none found.
 *
 * We search broadly (no channelId param — that filter is unreliable) and
 * match against PIU_CHANNEL_ID in the results.
 * Cost: 100 quota units per call.
 */
async function searchVideo(songTitle) {
  const data = await ytGet('search', {
    part:       'snippet',
    q:          `${songTitle} pump it up`,
    type:       'video',
    maxResults: 10,
  });
  // Prefer gameplay videos over pure BGA/music videos.
  // BGA-only uploads have 『Pump It Up』 or 'BGA' in the title.
  const isBga = item => /BGA|\u300ePump\s*It\s*Up\u300f/i.test(item.snippet.title);
  const piuItems = (data.items ?? []).filter(i => i.snippet.channelId === PIU_CHANNEL_ID);
  const hit = piuItems.find(i => !isBga(i)) ?? piuItems.find(i => isBga(i));
  return hit?.id?.videoId ?? null;
}

/**
 * Fetch full snippet (including full description) for a batch of video IDs.
 * Cost: 1 quota unit per call (up to 50 IDs per call).
 */
async function fetchVideoSnippets(videoIds) {
  if (videoIds.length === 0) return [];
  const data = await ytGet('videos', {
    part: 'snippet',
    id:   videoIds.join(','),
  });
  return data.items ?? [];
}

// ── Parsing ───────────────────────────────────────────────────────────────────

/**
 * Extract Step Artist from a YouTube video description.
 * Matches patterns like:
 *   Step Artist: HANE
 *   Step Artist - HANE
 */
function parseStepArtist(description) {
  if (!description) return null;
  // Match "Step Artist:" or "Step Artist -" — value may be on the same line
  // or on the very next line (some descriptions use a two-line format).
  const m = description.match(/Step\s*Artist\s*[:\-]\s*(.*?)(?:\n|$)/i);
  if (!m) return null;
  let value = m[1].trim();
  // If the value is empty the name is on the next line; grab it.
  if (!value) {
    const afterColon = description.slice(description.indexOf(m[0]) + m[0].length);
    value = (afterColon.match(/^(.+)/) ?? [])[1]?.trim() ?? '';
  }
  return value || null;
}

// ── Delay helper ──────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== fill-step-artists ===');
  console.log(`Mode: ${APPLY ? '✏️  APPLY' : '🔍 DRY RUN'}\n`);

  if (!API_KEY) {
    console.error('Error: YOUTUBE_API_KEY environment variable is not set.');
    console.error('  export YOUTUBE_API_KEY=your_key_here');
    process.exit(1);
  }

  // ── Load DB ──────────────────────────────────────────────────────────────
  const db    = JSON.parse(readFileSync(DB_PATH, 'utf8'));
  const songs = db.songs;

  const targets = songs.filter(s => !s.stepArtist);
  console.log(`Songs missing stepArtist: ${targets.length} / ${songs.length}\n`);

  if (targets.length === 0) {
    console.log('Nothing to do!');
    return;
  }

  console.log(`Targeting channel: ${PIU_CHANNEL_ID} (펌프잇업공식 PUMP IT UP Official)\n`);

  // ── Phase 1: search for each song ────────────────────────────────────────
  // songTitle → videoId  (null if not found)
  const videoIdBySong = new Map();

  for (let i = 0; i < targets.length; i++) {
    const song = targets[i];
    process.stdout.write(`  [${String(i + 1).padStart(2)}/${targets.length}] Searching: "${song.title}"... `);

    try {
      const videoId = await searchVideo(song.title);
      videoIdBySong.set(song.title, videoId);
      console.log(videoId ? `→ ${videoId}` : '→ ⚠ not found');
    } catch (err) {
      console.log(`→ ✗ ERROR: ${err.message}`);
      videoIdBySong.set(song.title, null);
    }

    if (i < targets.length - 1) await sleep(SEARCH_DELAY_MS);
  }

  // ── Phase 2: batch-fetch full descriptions ───────────────────────────────
  const foundIds = [...videoIdBySong.values()].filter(Boolean);

  console.log(`\nFetching descriptions for ${foundIds.length} video(s)...`);

  // Batch into groups of 50 (API max)
  const snippetByVideoId = new Map();
  for (let i = 0; i < foundIds.length; i += 50) {
    const batch = foundIds.slice(i, i + 50);
    const items = await fetchVideoSnippets(batch);
    for (const item of items) {
      snippetByVideoId.set(item.id, item.snippet);
    }
    if (i + 50 < foundIds.length) await sleep(SEARCH_DELAY_MS);
  }

  // ── Phase 3: parse step artists & build changeset ────────────────────────
  const changes = [];  // { song, stepArtist, videoId, videoTitle }
  const skipped = [];  // { song, reason }

  for (const song of targets) {
    const videoId = videoIdBySong.get(song.title);

    if (!videoId) {
      skipped.push({ song, reason: 'no video found on channel' });
      continue;
    }

    const snippet = snippetByVideoId.get(videoId);
    if (!snippet) {
      skipped.push({ song, reason: `video ${videoId} not returned by videos.list` });
      continue;
    }

    const stepArtist = parseStepArtist(snippet.description);
    if (!stepArtist) {
      skipped.push({
        song,
        reason: `"Step Artist:" not found in description of "${snippet.title}" (${videoId})`,
      });
      continue;
    }

    changes.push({ song, stepArtist, videoId, videoTitle: snippet.title });
  }

  // ── Report ────────────────────────────────────────────────────────────────
  console.log(`\n── Results ────────────────────────────────────────────────`);
  console.log(`Changes: ${changes.length}  |  Skipped: ${skipped.length}\n`);

  for (const { song, stepArtist, videoId, videoTitle } of changes) {
    console.log(`  ✦ "${song.title}"`);
    console.log(`    stepArtist → "${stepArtist}"`);
    console.log(`    video: "${videoTitle}" (${videoId})`);
  }

  if (skipped.length) {
    console.log('\nSkipped:');
    for (const { song, reason } of skipped) {
      console.log(`  ⚠ "${song.title}" — ${reason}`);
    }
  }

  if (!APPLY) {
    console.log('\nRun with --apply to write changes to songs.json');
    return;
  }

  // ── Apply ─────────────────────────────────────────────────────────────────
  for (const { song, stepArtist } of changes) {
    song.stepArtist = stepArtist;
  }

  db.lastUpdated = new Date().toISOString();
  writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
  console.log(`\n✓ songs.json updated — ${changes.length} step artist(s) filled.`);
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
