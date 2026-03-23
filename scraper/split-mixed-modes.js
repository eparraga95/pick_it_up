/**
 * scraper/split-mixed-modes.js
 *
 * Finds songs that have charts spanning multiple modes (e.g. arcade + shortcut)
 * in a single song entry — a bug from the original scraper run — and splits
 * them into one entry per mode.
 *
 * Split rules:
 *   Primary mode (keeps original id/title):  arcade > remix > fullsong > shortcut
 *   Secondary mode title suffix:
 *     shortcut  → " - SHORT CUT -"
 *     fullsong  → " - FULL SONG -"
 *     remix     → " - REMIX -"        (only when remix is secondary)
 *
 * stepArtist is cleared to null on ALL resulting entries because the original
 * scraped value came from a single chart URL that could belong to either mode.
 * Run fill-step-artists.js afterwards to re-populate them from YouTube.
 *
 * Usage:
 *   node scraper/split-mixed-modes.js           -- dry run
 *   node scraper/split-mixed-modes.js --apply   -- writes songs.json
 */

import { readFileSync, writeFileSync } from 'fs';

const APPLY   = process.argv.includes('--apply');
const DB_PATH = new URL('../data/songs.json', import.meta.url).pathname;

// Mode priority: lower index = more "primary"
const MODE_PRIORITY   = ['arcade', 'remix', 'fullsong', 'shortcut'];
const MODE_SUFFIX     = {
  shortcut: ' - SHORT CUT -',
  fullsong: ' - FULL SONG -',
  remix:    ' - REMIX -',
};

function modeRank(m) {
  const i = MODE_PRIORITY.indexOf(m);
  return i < 0 ? 99 : i;
}

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');   // trim leading/trailing dashes
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== split-mixed-modes ===');
  console.log(`Mode: ${APPLY ? '✏️  APPLY' : '🔍 DRY RUN'}\n`);

  const db    = JSON.parse(readFileSync(DB_PATH, 'utf8'));
  const songs = db.songs;

  // Collect existing IDs to avoid collisions in slugification
  const existingIds = new Set(songs.map(s => s.id));

  const toRemove  = new Set();   // original song ids to remove
  const toInsert  = [];          // replacement song objects (one per mode)
  let totalSplit  = 0;

  for (const song of songs) {
    const modes = [...new Set(song.charts.map(c => c.mode))];
    if (modes.length <= 1) continue;

    // Sort modes by priority
    modes.sort((a, b) => modeRank(a) - modeRank(b));
    const primaryMode = modes[0];

    console.log(`\n── "${song.title}" [${song.id}]`);
    console.log(`   modes: ${modes.join(' + ')}  →  splitting into ${modes.length} entries\n`);

    toRemove.add(song.id);
    totalSplit++;

    for (const mode of modes) {
      const modeCharts = song.charts.filter(c => c.mode === mode);
      const isPrimary  = mode === primaryMode;

      let newTitle, newId;
      if (isPrimary) {
        newTitle = song.title;
        newId    = song.id;
      } else {
        const suffix = MODE_SUFFIX[mode] ?? ` - ${mode.toUpperCase()} -`;
        newTitle     = song.title + suffix;
        let candidate = slugify(newTitle);
        // Ensure uniqueness
        if (existingIds.has(candidate) && !toRemove.has(candidate)) {
          candidate = `${candidate}-${mode}`;
        }
        newId = candidate;
        existingIds.add(newId);
      }

      const entry = {
        id:         newId,
        title:      newTitle,
        bpm:        song.bpm   ?? null,
        version:    song.version ?? null,
        charts:     modeCharts,
        songArtist: song.songArtist ?? null,
        stepArtist: null,   // cleared — needs re-lookup per variant
      };

      console.log(`   [${isPrimary ? 'PRIMARY' : 'SPLIT  '}] "${newTitle}" (${newId})`);
      console.log(`            charts: ${modeCharts.map(c => `${c.type}${c.level}`).join(', ')}`);
      console.log(`            stepArtist: null (was: ${JSON.stringify(song.stepArtist)})`);

      toInsert.push({ afterId: song.id, isPrimary, entry });
    }
  }

  console.log(`\n────────────────────────────────────────────────`);
  console.log(`Songs to split:      ${totalSplit}`);
  console.log(`Entries to remove:   ${toRemove.size}`);
  console.log(`Entries to insert:   ${toInsert.length}`);
  console.log(`Net change:          +${toInsert.length - toRemove.size} songs`);

  if (!APPLY) {
    console.log('\nRun with --apply to write changes to songs.json');
    return;
  }

  // ── Apply ─────────────────────────────────────────────────────────────────
  // Build new songs array: for each original song, replace the mixed-mode
  // entry with the split entries (in mode-priority order), preserving position.
  const newSongs = [];
  for (const song of songs) {
    if (!toRemove.has(song.id)) {
      newSongs.push(song);
      continue;
    }
    // Insert all split entries for this original song at this position
    const splits = toInsert
      .filter(x => x.afterId === song.id)
      .sort((a, b) => (a.isPrimary ? -1 : 1) - (b.isPrimary ? -1 : 1)); // primary first
    for (const { entry } of splits) newSongs.push(entry);
  }

  db.songs       = newSongs;
  db.totalSongs  = newSongs.length;
  db.totalCharts = newSongs.reduce((n, s) => n + s.charts.length, 0);
  db.lastUpdated = new Date().toISOString();

  writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
  console.log(`\n✓ songs.json updated.`);
  console.log(`  Songs: ${songs.length} → ${newSongs.length} (+${newSongs.length - songs.length})`);
  console.log(`  stepArtist cleared on all ${toInsert.length} split entries.`);
  console.log(`\nNext step: run fill-step-artists.js --apply to re-populate stepArtist for the new entries.`);
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
