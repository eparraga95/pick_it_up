/**
 * scraper/merge.js
 * Merges a per-patch file into data/songs.json.
 *
 * Usage:
 *   node scraper/merge.js data/patches/manual-patch-v2_08.json          (dry run)
 *   node scraper/merge.js data/patches/manual-patch-v2_08.json --apply  (write changes)
 *
 * Patch file schema: see data/patches/manual-patch-v2_08.json
 *
 * Merge rules:
 *  - Existing song + new charts  → add only charts not already present
 *  - Existing song + songArtist  → set only if currently null
 *  - Existing song + bpm         → set only if currently null
 *  - New song                    → create full entry; version set to patch version
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const patchArg = args.find(a => !a.startsWith('--'));

if (!patchArg) {
  console.error('Usage: node scraper/merge.js <patch-file> [--apply]');
  console.error('  e.g: node scraper/merge.js data/patches/manual-patch-v2_08.json');
  process.exit(1);
}

const SONGS_PATH = new URL('../data/songs.json', import.meta.url).pathname;
const PATCH_PATH = resolve(patchArg);

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Normalise a title for matching: lowercase, collapse spaces, strip punctuation */
function normalise(str) {
  return str
    .toLowerCase()
    .replace(/[''`´]/g, "'")
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function chartKey(c) {
  return `${c.type}${c.level}${c.mode}`;
}

// ─── Load files ───────────────────────────────────────────────────────────────

let db;
try {
  db = JSON.parse(readFileSync(SONGS_PATH, 'utf8'));
} catch {
  console.error(`Could not read ${SONGS_PATH}. Run 'npm run scrape' first.`);
  process.exit(1);
}

let patch;
try {
  patch = JSON.parse(readFileSync(PATCH_PATH, 'utf8'));
} catch {
  console.error(`Could not read patch file: ${PATCH_PATH}`);
  process.exit(1);
}

// Build lookup map: normalised title → index in db.songs
const titleIndex = new Map();
for (let i = 0; i < db.songs.length; i++) {
  titleIndex.set(normalise(db.songs[i].title), i);
}

// ─── Plan changes ─────────────────────────────────────────────────────────────

console.log(`\nPatch: ${patch.version}`);
if (patch.releaseDate) console.log(`Date:  ${patch.releaseDate}`);
if (patch.sourceUrl)   console.log(`URL:   ${patch.sourceUrl}`);
console.log(`Mode:  ${APPLY ? '✏️  APPLY' : '🔍 DRY RUN (pass --apply to write)'}`);
console.log('─'.repeat(56));

const songsToUpdate = []; // { index, fields, chartsToAdd }
const songsToCreate = []; // full new song objects

for (const patchSong of patch.songs) {
  const key = normalise(patchSong.title);
  const existingIdx = titleIndex.get(key);

  if (existingIdx !== undefined) {
    // ── Existing song ─────────────────────────────────────────
    const existing = db.songs[existingIdx];
    const existingKeys = new Set(existing.charts.map(chartKey));

    const chartsToAdd = (patchSong.charts ?? []).filter(c => !existingKeys.has(chartKey(c)));
    const fieldsToUpdate = {};

    if (patchSong.songArtist && !existing.songArtist) {
      fieldsToUpdate.songArtist = patchSong.songArtist;
    }
    if (patchSong.bpm && !existing.bpm) {
      fieldsToUpdate.bpm = patchSong.bpm;
    }

    const hasChanges = chartsToAdd.length > 0 || Object.keys(fieldsToUpdate).length > 0;

    console.log(`\n  ✦ (existing) ${existing.title}`);
    if (!hasChanges) {
      console.log(`    → no changes (all charts already present)`);
    } else {
      for (const [k, v] of Object.entries(fieldsToUpdate)) {
        console.log(`    → set ${k}: "${v}"`);
      }
      for (const c of chartsToAdd) {
        console.log(`    → + ${c.type}${c.level} ${c.mode}`);
      }
      songsToUpdate.push({ index: existingIdx, fields: fieldsToUpdate, chartsToAdd });
    }

    // Warn about charts already present
    for (const c of (patchSong.charts ?? []).filter(c => existingKeys.has(chartKey(c)))) {
      console.log(`    ⚠ skipped ${c.type}${c.level} ${c.mode} (already exists)`);
    }

  } else {
    // ── New song ──────────────────────────────────────────────
    const charts = (patchSong.charts ?? []).slice().sort((a, b) => {
      if (a.type !== b.type) return a.type.localeCompare(b.type);
      return a.level - b.level;
    });

    const newSong = {
      id: key.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      title: patchSong.title,
      songArtist: patchSong.songArtist ?? null,
      stepArtist: null,
      bpm: patchSong.bpm ?? null,
      version: patch.version,
      charts,
    };

    console.log(`\n  ✦ (new song) ${patchSong.title}`);
    if (newSong.songArtist) console.log(`    songArtist: "${newSong.songArtist}"`);
    if (newSong.bpm)        console.log(`    bpm: ${newSong.bpm}`);
    console.log(`    version: "${newSong.version}"`);
    for (const c of charts) console.log(`    → + ${c.type}${c.level} ${c.mode}`);

    songsToCreate.push(newSong);
  }
}

// ─── Summary ──────────────────────────────────────────────────────────────────

const totalChartsAdded  = songsToUpdate.reduce((s, u) => s + u.chartsToAdd.length, 0);
const totalSongsUpdated = songsToUpdate.length;
const totalNewCharts    = songsToCreate.reduce((s, ns) => s + ns.charts.length, 0);

console.log('\n' + '─'.repeat(56));
console.log('Summary:');
console.log(`  ${totalSongsUpdated} existing song(s) updated  (+${totalChartsAdded} chart(s))`);
console.log(`  ${songsToCreate.length} new song(s) added        (+${totalNewCharts} chart(s))`);

if (!APPLY) {
  console.log('\nRun with --apply to write changes to songs.json\n');
  process.exit(0);
}

// ─── Apply ────────────────────────────────────────────────────────────────────

for (const { index, fields, chartsToAdd } of songsToUpdate) {
  const song = db.songs[index];
  Object.assign(song, fields);
  song.charts.push(...chartsToAdd);
  song.charts.sort((a, b) => {
    if (a.type !== b.type) return a.type.localeCompare(b.type);
    return a.level - b.level;
  });
}

db.songs.push(...songsToCreate);
db.songs.sort((a, b) => a.title.localeCompare(b.title));

db.totalSongs   = db.songs.length;
db.totalCharts  = db.songs.reduce((acc, s) => acc + s.charts.length, 0);
db.lastPatchApplied = patch.version_tag;
db.lastUpdated  = new Date().toISOString();

writeFileSync(SONGS_PATH, JSON.stringify(db, null, 2), 'utf8');

console.log(`\n✓ songs.json updated`);
console.log(`  Songs:  ${db.totalSongs}`);
console.log(`  Charts: ${db.totalCharts}\n`);
