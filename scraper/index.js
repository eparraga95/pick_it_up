/**
 * scraper/index.js
 * Entry point. Orchestrates the full piucenter scrape.
 *
 * Usage:
 *   node scraper/index.js              -- fresh scrape, no detail pages
 *   node scraper/index.js --resume     -- resume from checkpoint
 *   node scraper/index.js --details    -- also fetch artist/version per song
 */

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';

import { loadCheckpoint, saveCheckpoint, clearCheckpoint } from './checkpoint.js';
import { initSearchPage, scrapeAllPages, scrapeChartDetails } from './piucenter.js';

const args = process.argv.slice(2);
const RESUME = args.includes('--resume');
const FETCH_DETAILS = args.includes('--details');

const OUTPUT_PATH = new URL('../data/songs.json', import.meta.url).pathname;
const DATA_DIR = new URL('../data/', import.meta.url).pathname;

/** Delay helper */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Transforms the flat charts array into the final songs.json structure */
function buildSongsDatabase(charts) {
  const songMap = new Map();

  for (const chart of charts) {
    const key = chart.title.toLowerCase().trim();

    if (!songMap.has(key)) {
      songMap.set(key, {
        id: key.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
        title: chart.title,
        songArtist: null,       // real music artist — populated from patch notes
        stepArtist: chart.stepArtist ?? null, // chart/step author — from piucenter
        bpm: chart.bpm ?? null,
        version: chart.version ?? null,
        charts: [],
      });
    }

    const song = songMap.get(key);

    // Keep BPM if we got one
    if (chart.bpm && !song.bpm) song.bpm = chart.bpm;

    // Keep step artist/version from detail page if available
    if (chart.stepArtist && !song.stepArtist) song.stepArtist = chart.stepArtist;
    if (chart.version && !song.version) song.version = chart.version;

    // Add chart entry (avoid exact duplicates)
    const chartEntry = { type: chart.type, level: chart.level, mode: chart.mode };
    const isDuplicate = song.charts.some(
      c => c.type === chartEntry.type && c.level === chartEntry.level && c.mode === chartEntry.mode
    );
    if (!isDuplicate) {
      song.charts.push(chartEntry);
    }
  }

  // Sort charts within each song
  for (const song of songMap.values()) {
    song.charts.sort((a, b) => {
      if (a.type !== b.type) return a.type.localeCompare(b.type);
      return a.level - b.level;
    });
  }

  return Array.from(songMap.values()).sort((a, b) => a.title.localeCompare(b.title));
}

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });

  console.log('=== pick it up — piucenter scraper ===\n');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  // Detect total pages and load initial search page
  console.log('Loading piucenter search page...');
  const totalPages = await initSearchPage(page);
  console.log(`Total pages to scrape: ${totalPages}\n`);

  // Load checkpoint if resuming
  const state = RESUME ? loadCheckpoint() : { lastPageDone: 0, charts: [] };
  if (!RESUME) clearCheckpoint();

  // --- Phase 1: scrape all pages by clicking ► to paginate ---
  // (piucenter is a React SPA — URL ?page=N doesn't work)
  try {
    await scrapeAllPages(page, {
      startPage: state.lastPageDone + 1,
      totalPages,
      collectUrls: FETCH_DETAILS,
      onPageDone: async (pageNum, charts) => {
        state.charts.push(...charts);
        state.lastPageDone = pageNum;
        process.stdout.write(`  Page ${pageNum}/${totalPages}... ${charts.length} charts (total: ${state.charts.length})\n`);

        // Checkpoint every 5 pages
        if (pageNum % 5 === 0) saveCheckpoint(state);
      },
    });
  } catch (err) {
    console.error(`\n  ✗ Error during scraping: ${err.message}`);
    console.error('  Saving checkpoint. Re-run with --resume to continue.');
    saveCheckpoint(state);
    await browser.close();
    process.exit(1);
  }

  console.log(`\n✓ Phase 1 complete: ${state.charts.length} charts scraped\n`);

  // --- Phase 2 (optional): fetch detail pages for artist + version ---
  if (FETCH_DETAILS) {
    console.log('Phase 2: fetching song detail pages for artist/version...\n');

    // Deduplicate by song title — only visit one chart URL per unique song.
    // Each song may have many charts (~4200 total) but we only need to visit
    // one detail page per song (~350) to get artist + version.
    const songKeyToFirstUrl = new Map(); // songKey → first available chart URL
    const songKeyToIndices = new Map();  // songKey → all chart indices for that song

    for (let i = 0; i < state.charts.length; i++) {
      const chart = state.charts[i];
      const key = chart.title.toLowerCase().trim();

      if (!songKeyToIndices.has(key)) songKeyToIndices.set(key, []);
      songKeyToIndices.get(key).push(i);

      if (chart.url && !songKeyToFirstUrl.has(key)) {
        songKeyToFirstUrl.set(key, chart.url);
      }
    }

    const songsWithUrl = Array.from(songKeyToFirstUrl.entries());
    console.log(`  Unique songs to visit: ${songsWithUrl.length}\n`);

    const detailPage = await context.newPage();
    let done = 0;

    for (const [songKey, url] of songsWithUrl) {
      done++;
      if (done % 50 === 0 || done === 1) {
        console.log(`  Progress: ${done}/${songsWithUrl.length}`);
      }

      const details = await scrapeChartDetails(detailPage, url);

      // Apply stepArtist/version to ALL charts belonging to this song
      for (const idx of songKeyToIndices.get(songKey)) {
        state.charts[idx].stepArtist = details.stepArtist;
        state.charts[idx].version = details.version;
      }

      await sleep(300 + Math.random() * 300);
    }

    await detailPage.close();
    console.log(`\n✓ Phase 2 complete\n`);
  }

  await browser.close();

  // --- Build final output ---
  console.log('Building songs database...');
  const songs = buildSongsDatabase(state.charts);

  const output = {
    generatedAt: new Date().toISOString(),
    source: 'piucenter.com',
    totalSongs: songs.length,
    totalCharts: songs.reduce((acc, s) => acc + s.charts.length, 0),
    songs,
  };

  writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2), 'utf8');

  console.log(`\n✓ Done!`);
  console.log(`  Songs:  ${output.totalSongs}`);
  console.log(`  Charts: ${output.totalCharts}`);
  console.log(`  Output: ${OUTPUT_PATH}\n`);
}

main().catch(err => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
