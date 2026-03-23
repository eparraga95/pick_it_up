/**
 * scraper/fill-song-artists.js
 *
 * Re-scrapes piucenter search pages to collect chart URLs, then extracts
 * the song (music) artist from each URL's slug. Updates songs.json in place,
 * only filling entries where songArtist is currently null.
 *
 * URL slug format:
 *   /chart/{title_slug}_-_{artist_slug}_{TYPE}{level}_{MODE}
 *
 * Usage:
 *   node scraper/fill-song-artists.js           -- dry run (prints what would change)
 *   node scraper/fill-song-artists.js --apply   -- writes songs.json
 */

import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'fs';
import { initSearchPage, scrapeAllPages } from './piucenter.js';

const APPLY    = process.argv.includes('--apply');
const DB_PATH  = new URL('../data/songs.json', import.meta.url).pathname;

// ── URL slug → artist name ────────────────────────────────────────────────────

/**
 * Parses the song (music) artist out of a piucenter chart URL.
 *
 * URL slug format (examples):
 *   Teddy_Bear_-_STAYC_D15_ARCADE
 *   Prime_Opening_-_SHORT_CUT_-_-_MAX_D15_SHORTCUT
 *   Bee_-_BanYa_D20_INFOBAR_TITLE_ARCADE
 *
 * Strategy: strip the full chart suffix (type+level+mode), then use
 * lastIndexOf("_-_") to find the title/artist separator. This naturally
 * handles SHORT CUT / FULL SONG variants because those insert an extra
 * " - SHORT CUT - " or " - FULL SONG - " between title and artist,
 * and lastIndexOf finds the _last_ separator — which is always immediately
 * before the artist.
 *
 * Returns null if the URL can't be parsed.
 */
function artistFromUrl(url) {
  // e.g. https://www.piucenter.com/chart/Teddy_Bear_-_STAYC_D15_ARCADE
  const m = url.match(/\/chart\/(.+)$/);
  if (!m) return null;

  const slug = m[1];

  // 1. Strip trailing _{TYPE}{level}_{ANY_MODE_WORDS}  e.g. _D15_ARCADE or _D20_INFOBAR_TITLE_ARCADE
  //    Use greedy .+ so multi-word modes like INFOBAR_TITLE_ARCADE are fully removed.
  const body = slug.replace(/_[SD]\d+_.+$/i, '');
  if (!body) return null;

  // 2. Split on the LAST _-_ separator in the body.
  //    The last _-_ is always the title/artist boundary, including in cases like:
  //      Prime_Opening_-_SHORT_CUT_-_-_MAX  →  last _-_  before MAX
  //      Love_is_a_Danger_Zone_2_-_FULL_SONG_-_-_Yahpp  →  before Yahpp
  const lastSepIdx = body.lastIndexOf('_-_');
  if (lastSepIdx < 0) return null;

  const artistSlug = body.slice(lastSepIdx + 3);
  if (!artistSlug) return null;

  // Convert underscores to spaces; collapse multiple consecutive spaces
  // (double underscores appear when special chars like × are stripped from slugs)
  return artistSlug.replace(/_/g, ' ').replace(/ {2,}/g, ' ').trim();
}

// ── Normalise title for fuzzy matching against songs.json ─────────────────────

function normalise(str) {
  return (str ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== fill-song-artists ===');
  console.log(`Mode: ${APPLY ? '✏️  APPLY' : '🔍 DRY RUN'}\n`);

  // Load current DB
  const db = JSON.parse(readFileSync(DB_PATH, 'utf8'));
  const songs = db.songs;

  // Build fast-lookup by normalised title
  const songByNorm = new Map();
  for (const song of songs) {
    songByNorm.set(normalise(song.title), song);
  }

  const nullCount = songs.filter(s => !s.songArtist).length;
  console.log(`Songs missing songArtist: ${nullCount} / ${songs.length}\n`);

  // ── Scrape search pages to collect URLs ──────────────────────────────────
  console.log('Launching browser to collect chart URLs (no detail pages)...\n');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  const totalPages = await initSearchPage(page);

  // songKey → first URL seen  (one URL per song is enough to extract artist)
  const urlBySongKey = new Map();

  await scrapeAllPages(page, {
    startPage: 1,
    totalPages,
    collectUrls: true,
    onPageDone: async (pageNum, charts) => {
      for (const chart of charts) {
        if (!chart.url) continue;
        const key = normalise(chart.title);
        const existing = urlBySongKey.get(key);
        // Prefer ARCADE/REMIX URLs over SHORTCUT/FULLSONG — avoids "SHORT CUT -" being
        // mistaken for part of the artist name when splitting on the last _-_ separator.
        const isArcade = /_(ARCADE|REMIX)\b/i.test(chart.url);
        const existingIsArcade = existing && /_(ARCADE|REMIX)\b/i.test(existing);
        if (!existing || (!existingIsArcade && isArcade)) {
          urlBySongKey.set(key, chart.url);
        }
      }
      process.stdout.write(`  Page ${pageNum}/${totalPages} — ${urlBySongKey.size} unique songs seen so far\r`);
    },
  });

  await browser.close();
  console.log(`\n\n✓ Collected URLs for ${urlBySongKey.size} unique songs\n`);

  // ── Parse artists and build changeset ────────────────────────────────────
  const changes = [];  // { song, newArtist }
  const skipped = [];  // { title, reason }

  for (const [normKey, url] of urlBySongKey.entries()) {
    const song = songByNorm.get(normKey);
    if (!song) {
      skipped.push({ title: normKey, reason: 'not found in songs.json' });
      continue;
    }
    if (song.songArtist) {
      // Already filled — skip silently
      continue;
    }

    const artist = artistFromUrl(url);
    if (!artist) {
      skipped.push({ title: song.title, reason: `could not parse artist from URL: ${url}` });
      continue;
    }

    changes.push({ song, artist, url });
  }

  // ── Report ────────────────────────────────────────────────────────────────
  console.log(`Changes to apply: ${changes.length}`);
  console.log(`Skipped:          ${skipped.length}\n`);

  for (const { song, artist, url } of changes) {
    console.log(`  ✦ "${song.title}"`);
    console.log(`    songArtist → "${artist}"`);
    console.log(`    (from ${url})`);
  }

  if (skipped.length) {
    console.log('\nSkipped:');
    for (const { title, reason } of skipped) {
      console.log(`  ⚠ "${title}" — ${reason}`);
    }
  }

  if (!APPLY) {
    console.log('\nRun with --apply to write changes to songs.json');
    return;
  }

  // ── Apply ─────────────────────────────────────────────────────────────────
  for (const { song, artist } of changes) {
    song.songArtist = artist;
  }

  db.lastUpdated = new Date().toISOString();
  writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
  console.log(`\n✓ songs.json updated — ${changes.length} song artist(s) filled.`);
}

main().catch(err => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
