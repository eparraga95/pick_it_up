import { readFileSync, writeFileSync, existsSync } from 'fs';

const CHECKPOINT_PATH = new URL('../data/checkpoint.json', import.meta.url).pathname;

/**
 * Loads an existing checkpoint from disk, or returns a fresh state.
 * @returns {{ lastPageDone: number, charts: object[] }}
 */
export function loadCheckpoint() {
  if (existsSync(CHECKPOINT_PATH)) {
    try {
      const raw = readFileSync(CHECKPOINT_PATH, 'utf8');
      const checkpoint = JSON.parse(raw);
      console.log(
        `[checkpoint] Resuming from page ${checkpoint.lastPageDone + 1}` +
        ` (${checkpoint.charts.length} charts already collected)`
      );
      return checkpoint;
    } catch {
      console.warn('[checkpoint] Could not parse checkpoint file, starting fresh.');
    }
  }
  return { lastPageDone: 0, charts: [] };
}

/**
 * Saves the current scraping state to disk.
 * @param {{ lastPageDone: number, charts: object[] }} state
 */
export function saveCheckpoint(state) {
  writeFileSync(CHECKPOINT_PATH, JSON.stringify(state, null, 2), 'utf8');
}

/**
 * Clears any saved checkpoint.
 */
export function clearCheckpoint() {
  if (existsSync(CHECKPOINT_PATH)) {
    writeFileSync(CHECKPOINT_PATH, JSON.stringify({ lastPageDone: 0, charts: [] }, null, 2), 'utf8');
  }
}
