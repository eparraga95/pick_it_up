/**
 * scraper/fill-step-artists.js
 *
 * For each song in songs.json where stepArtist is null, searches the official
 * "펌프잇업공식 PUMP IT UP Official" YouTube channel, fetches the video
 * description, and parses the "Step Artist:" field from it.
 *
 * For songs with mode suffixes (" - SHORT CUT -", " - FULL SONG -", " - REMIX -"),
 * the suffix is stripped from the search query and replaced with a cleaner keyword
 * (e.g. "Death Moon - SHORT CUT -" → query "Death Moon short cut pump it up").
 * The returned video is then validated to confirm it matches the expected mode before
 * any value is applied — preventing arcade videos from silently polluting shortcut entries.
 *
 * Prerequisites:
 *   export YOUTUBE_API_KEY=your_key_here
 *   (Get a free key at https://console.cloud.google.com → YouTube Data API v3)
 *
 * Usage:
 *   node scraper/fill-step-artists.js                      -- dry run (all null)
 *   node scraper/fill-step-artists.js --apply              -- fill all null
 *   node scraper/fill-step-artists.js --apply --limit 90   -- fill first 90 (safe for quota)
 *   node scraper/fill-step-artists.js --verify             -- compare existing vs YouTube (dry run)
 *   node scraper/fill-step-artists.js --verify --apply     -- write conflicts to data/review/
 *
 * API cost: 100 units/search. Free tier = 10,000 units/day → max 99 songs/day.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';

// Load .env from project root (Node 18 doesn't have --env-file built in)
const envPath = new URL('../.env', import.meta.url).pathname;
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const APPLY   = process.argv.includes('--apply');
const VERIFY  = process.argv.includes('--verify');
const DB_PATH = new URL('../data/songs.json', import.meta.url).pathname;
const API_KEY = process.env.YOUTUBE_API_KEY;

// Optional --limit N: process at most N songs (to stay within daily quota)
const limitArg = process.argv.indexOf('--limit');
const LIMIT    = limitArg >= 0 ? parseInt(process.argv[limitArg + 1], 10) : Infinity;

// Official "펌프잇업공식 PUMP IT UP Official" channel ID.
// (forHandle resolution via channels.list returned a different channel, so hardcoded.)
const PIU_CHANNEL_ID = 'UC1zVbfSZSKz9r2AzF50l9sA';

// ms to wait between search calls to stay polite
const SEARCH_DELAY_MS = 200;

// ── Mode helpers ──────────────────────────────────────────────────────────────

// Known non-arcade mode suffixes added by split-mixed-modes.js
const MODE_SUFFIXES = [
  { suffix: ' - SHORT CUT -', keyword: 'short cut', rx: /short\s*cut/i },
  { suffix: ' - FULL SONG -', keyword: 'full song',  rx: /full\s*song/i },
  { suffix: ' - REMIX -',     keyword: 'remix',      rx: /remix/i },
];

/**
 * Detect mode suffix in a song title.
 * Returns { baseTitle, keyword, rx } where rx is the validation regex (null for arcade).
 */
function parseTitleMode(title) {
  for (const { suffix, keyword, rx } of MODE_SUFFIXES) {
    if (title.includes(suffix)) {
      return { baseTitle: title.slice(0, title.indexOf(suffix)).trim(), keyword, rx };
    }
  }
  return { baseTitle: title, keyword: null, rx: null };
}

/**
 * Build a clean YouTube search query.
 * For mode-specific songs, strips the raw suffix and injects a cleaner keyword so
 * YouTube understands the intent (e.g. "short cut" instead of "- SHORT CUT -").
 */
function buildSearchQuery(title) {
  const { baseTitle, keyword } = parseTitleMode(title);
  return keyword ? `${baseTitle} ${keyword} pump it up` : `${baseTitle} pump it up`;
}

/**
 * Return true if the video snippet's title+description appear to belong to the
 * expected mode. Arcade songs (rx === null) always pass — any PIU video is fine.
 */
function videoMatchesMode(snippet, rx) {
  if (!rx) return true;
  return rx.test(`${snippet.title} ${snippet.description}`);
}

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
 * Search YouTube for a song and return the first matching video ID from the
 * official PIU channel, or null if none found.
 * Cost: 100 quota units per call.
 */
async function searchVideo(songTitle) {
  const data = await ytGet('search', {
    part:       'snippet',
    q:          buildSearchQuery(songTitle),
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
  const modeLabel = VERIFY ? '🔎 VERIFY' : (APPLY ? '✏️  APPLY' : '🔍 DRY RUN');
  console.log('=== fill-step-artists ===');
  console.log(`Mode: ${modeLabel}\n`);

  if (!API_KEY) {
    console.error('Error: YOUTUBE_API_KEY environment variable is not set.');
    console.error('  export YOUTUBE_API_KEY=your_key_here');
    process.exit(1);
  }

  // ── Load DB ──────────────────────────────────────────────────────────────
  const db    = JSON.parse(readFileSync(DB_PATH, 'utf8'));
  const songs = db.songs;

  // --verify: check songs that already have a value; else: fill songs that don't
  const allTargets = VERIFY ? songs.filter(s => s.stepArtist) : songs.filter(s => !s.stepArtist);
  const targets    = allTargets.slice(0, LIMIT);

  const banner = VERIFY
    ? `Songs with stepArtist to verify: ${allTargets.length} / ${songs.length}`
    : `Songs missing stepArtist: ${allTargets.length} / ${songs.length}`;
  console.log(banner);
  if (LIMIT < Infinity) console.log(`Processing: first ${targets.length} (--limit ${LIMIT})`);
  console.log();

  if (targets.length === 0) {
    console.log('Nothing to do!');
    return;
  }

  console.log(`Targeting channel: ${PIU_CHANNEL_ID} (펌프잇업공식 PUMP IT UP Official)\n`);

  // ── Phase 1: search for each song ────────────────────────────────────────
  // song.id → videoId | null
  const videoIdBySong = new Map();

  for (let i = 0; i < targets.length; i++) {
    const song = targets[i];
    process.stdout.write(`  [${String(i + 1).padStart(3)}/${targets.length}] Searching: "${song.title}"... `);

    try {
      const videoId = await searchVideo(song.title);
      videoIdBySong.set(song.id, videoId);
      console.log(videoId ? `→ ${videoId}` : '→ ⚠ not found');
    } catch (err) {
      console.log(`→ ✗ ERROR: ${err.message}`);
      videoIdBySong.set(song.id, null);
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
  const changes   = [];  // (fill)   { song, stepArtist, videoId, videoTitle }
  const conflicts = [];  // (verify) { song, stored, fromYoutube, videoId, videoTitle }
  const skipped   = [];  // { song, reason }

  for (const song of targets) {
    const videoId = videoIdBySong.get(song.id);

    if (!videoId) {
      skipped.push({ song, reason: 'no video found on channel' });
      continue;
    }

    const snippet = snippetByVideoId.get(videoId);
    if (!snippet) {
      skipped.push({ song, reason: `video ${videoId} not returned by videos.list` });
      continue;
    }

    // Validate that the video belongs to the expected mode (shortcut/fullsong/remix/arcade).
    // This prevents, e.g., an arcade gameplay video supplying the stepArtist of a shortcut entry.
    const { rx } = parseTitleMode(song.title);
    if (!videoMatchesMode(snippet, rx)) {
      skipped.push({
        song,
        reason: `video "${snippet.title}" (${videoId}) does not match expected mode — needs manual lookup`,
      });
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

    if (VERIFY) {
      if (song.stepArtist !== stepArtist) {
        conflicts.push({ song, stored: song.stepArtist, fromYoutube: stepArtist, videoId, videoTitle: snippet.title });
      }
      // no conflict: silently ok
    } else {
      changes.push({ song, stepArtist, videoId, videoTitle: snippet.title });
    }
  }

  // ── Report ────────────────────────────────────────────────────────────────
  console.log(`\n── Results ─────────────────────────────────────────────────`);

  if (VERIFY) {
    const verified = targets.length - skipped.length - conflicts.length;
    console.log(`Verified OK: ${verified}  |  Conflicts: ${conflicts.length}  |  Skipped: ${skipped.length}\n`);

    if (conflicts.length) {
      console.log('Conflicts (stored → YouTube):');
      for (const { song, stored, fromYoutube, videoId, videoTitle } of conflicts) {
        console.log(`  ⚡ "${song.title}"`);
        console.log(`     stored  : "${stored}"`);
        console.log(`     youtube : "${fromYoutube}"`);
        console.log(`     video   : "${videoTitle}" (${videoId})`);
      }
    }
  } else {
    console.log(`Changes: ${changes.length}  |  Skipped: ${skipped.length}\n`);

    for (const { song, stepArtist, videoId, videoTitle } of changes) {
      console.log(`  ✦ "${song.title}"`);
      console.log(`    stepArtist → "${stepArtist}"`);
      console.log(`    video: "${videoTitle}" (${videoId})`);
    }
  }

  if (skipped.length) {
    console.log('\nSkipped:');
    for (const { song, reason } of skipped) {
      console.log(`  ⚠ "${song.title}" — ${reason}`);
    }
  }

  if (!APPLY) {
    const hint = VERIFY
      ? '\nRun with --verify --apply to write conflicts to data/review/step-artist-conflicts.json'
      : '\nRun with --apply to write changes to songs.json';
    console.log(hint);
    return;
  }

  // ── Apply ─────────────────────────────────────────────────────────────────
  if (VERIFY) {
    if (conflicts.length === 0) {
      console.log('\n✓ No conflicts — nothing to write.');
      return;
    }

    const reviewDir  = new URL('../data/review', import.meta.url).pathname;
    const reviewPath = `${reviewDir}/step-artist-conflicts.json`;
    if (!existsSync(reviewDir)) mkdirSync(reviewDir, { recursive: true });

    const output = {
      generatedAt: new Date().toISOString(),
      source:      'fill-step-artists.js --verify',
      conflicts: conflicts.map(({ song, stored, fromYoutube, videoId, videoTitle }) => ({
        id:         song.id,
        title:      song.title,
        stored,
        fromYoutube,
        videoId,
        videoTitle,
        // Fill in "keep", "youtube", or a custom artist name, then apply via merge.js
        resolution: null,
      })),
    };

    writeFileSync(reviewPath, JSON.stringify(output, null, 2), 'utf8');
    console.log(`\n✓ ${conflicts.length} conflict(s) written to data/review/step-artist-conflicts.json`);
    console.log('  Set "resolution" for each entry (keep | youtube | <custom>), then correct via merge.js.');
  } else {
    for (const { song, stepArtist } of changes) {
      song.stepArtist       = stepArtist;
      song.stepArtistSource = 'youtube';
    }

    db.lastUpdated = new Date().toISOString();
    writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
    console.log(`\n✓ songs.json updated — ${changes.length} step artist(s) filled.`);
  }
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
