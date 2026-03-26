#!/usr/bin/env node
/**
 * find-duplicates.js
 * Scans data/songs.json for duplicate songs and duplicate charts within a song.
 *
 * Checks:
 *  1. Duplicate song IDs
 *  2. Duplicate song titles (case-insensitive)
 *  3. Duplicate charts within a song (same type + level + mode)
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = resolve(__dirname, '../data/songs.json');

const db = JSON.parse(readFileSync(dbPath, 'utf8'));
const songs = db.songs ?? [];

let issues = 0;

// ── 1. Duplicate IDs ─────────────────────────────────────────────────────────

const idMap = new Map(); // id → [indices]
songs.forEach((s, i) => {
  if (!idMap.has(s.id)) idMap.set(s.id, []);
  idMap.get(s.id).push(i);
});

const dupIds = [...idMap.entries()].filter(([, idxs]) => idxs.length > 1);
if (dupIds.length > 0) {
  console.log(`\n── Duplicate IDs (${dupIds.length}) ─────────────────────`);
  for (const [id, idxs] of dupIds) {
    console.log(`  [!] id="${id}"  →  indices ${idxs.join(', ')}`);
    idxs.forEach(i => console.log(`       ${i}: "${songs[i].title}"`));
    issues++;
  }
} else {
  console.log('✓ No duplicate IDs');
}

// ── 2. Duplicate titles (case-insensitive) ────────────────────────────────────

const titleMap = new Map(); // normalised title → [song objects]
for (const s of songs) {
  const key = s.title.trim().toLowerCase();
  if (!titleMap.has(key)) titleMap.set(key, []);
  titleMap.get(key).push(s);
}

const dupTitles = [...titleMap.entries()].filter(([, ss]) => ss.length > 1);
if (dupTitles.length > 0) {
  console.log(`\n── Duplicate titles (${dupTitles.length}) ──────────────────`);
  for (const [, ss] of dupTitles) {
    console.log(`  [!] title="${ss[0].title}"`);
    ss.forEach(s => console.log(`       id="${s.id}"  version=${s.version}`));
    issues++;
  }
} else {
  console.log('✓ No duplicate titles');
}

// ── 3. Duplicate charts within each song ─────────────────────────────────────

const chartDups = [];
for (const s of songs) {
  const seen = new Set();
  for (const c of s.charts) {
    const key = `${c.type}-${c.level}-${c.mode ?? ''}`;
    if (seen.has(key)) {
      chartDups.push({ song: s, chart: c, key });
    } else {
      seen.add(key);
    }
  }
}

if (chartDups.length > 0) {
  console.log(`\n── Duplicate charts within songs (${chartDups.length}) ────`);
  for (const { song, chart, key } of chartDups) {
    console.log(`  [!] "${song.title}" (id="${song.id}")  →  ${key}`);
    issues++;
  }
} else {
  console.log('✓ No duplicate charts within songs');
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${issues === 0 ? '✓' : '✗'} ${issues} issue(s) found in ${songs.length} songs.\n`);
process.exit(issues > 0 ? 1 : 0);
