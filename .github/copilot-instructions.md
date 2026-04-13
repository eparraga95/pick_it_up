# pick it up — Copilot Instructions

## What this project is

**pick it up** is a PIU (Pump it Up) song database and chart search tool. Pump it Up is a Korean arcade rhythm game.

The project has two main parts:
1. A **scraper pipeline** (Node.js, Playwright) that builds `data/songs.json` from piucenter.com + manual patch files.
2. A **static frontend** (`public/`) that loads `songs.json` and lets users filter/explore charts.

Deployment is on **Vercel**: build step copies `data/songs.json` into `public/data/` and serves `public/` as the output directory.

---

## Project structure

```
data/
  songs.json                  — generated database; do NOT edit by hand
  checkpoint.json             — scraper resume state
  patches/
    manual-patch-v2_XX_X.json — one file per Phoenix patch; merged via npm run merge

public/
  index.html                  — single-page app shell
  app.js                      — all frontend logic (filters, builder, overlap)
  style.css                   — styles

scraper/
  index.js                    — entry point; orchestrates full piucenter scrape
  piucenter.js                — core Playwright scraping logic (pagination, parsing)
  checkpoint.js               — save/load/clear scrape resume state
  merge.js                    — merges a manual patch file into songs.json
  fill-song-artists.js        — backfills songArtist fields from piucenter URL slugs
  fill-step-artists.js        — backfills stepArtist fields
  find-duplicates.js          — detects duplicate entries in songs.json
  split-mixed-modes.js        — splits "mixed mode" chart entries into proper records
```

---

## Data model

### `data/songs.json`
```jsonc
{
  "generatedAt": "...",
  "source": "piucenter.com",
  "lastPatchApplied": "2.12.0",   // set by merge.js
  "totalSongs": 350,
  "totalCharts": 4124,
  "songs": [
    {
      "id": "heliosphere",          // slug: lowercase, hyphens
      "title": "Heliosphere",
      "songArtist": "BlackY",       // music artist; null until filled
      "stepArtist": "EUNHU",        // chart author; null until filled
      "bpm": 182,
      "version": "phoenix",         // lowercase
      "charts": [
        { "type": "S", "level": 21, "mode": "arcade" }
      ]
    }
  ]
}
```

**Chart types:** `S` (Single) | `D` (Double)  
**Chart modes:** `arcade` | `remix` | `fullsong` | `shortcut`

### `data/patches/manual-patch-vX_XX_X.json`
```jsonc
{
  "version": "phoenix",
  "version_tag": "2.12.0",
  "releaseDate": "2025-12-23",
  "sourceUrl": "...",
  "_notes": "any caveats about this patch",
  "songs": [
    {
      "title": "Song Title",
      "songArtist": "Artist Name",
      "bpm": 170,
      "charts": [
        { "type": "S", "level": 15, "mode": "arcade" }
      ]
    }
  ]
}
```

---

## npm scripts

| Script | Purpose |
|---|---|
| `npm run scrape` | Fresh scrape from piucenter (~42 pages) |
| `npm run scrape:resume` | Resume interrupted scrape from checkpoint |
| `npm run scrape:details` | Also fetch artist/version from detail pages (slow) |
| `npm run merge` | Dry-run: show what a patch file would change |
| `npm run merge:apply` | Apply the patch to `songs.json` |
| `npm run fill-artists` | Dry-run: backfill `songArtist` from URL slugs |
| `npm run fill-artists:apply` | Apply artist backfill |
| `npm run fill-step-artists:apply` | Apply step artist backfill |
| `npm run split-modes:apply` | Fix mixed-mode chart entries |
| `npm run find-duplicates` | Report duplicate songs |
| `npm run serve` | Serve project locally at port 3000 (`npx serve . -l 3000`) |

---

## Frontend (`public/app.js`)

Single-file vanilla JS. No bundler, no framework.

The UI has three tabs in the left panel:
- **Filters** — search by title, song artist, step artist, chart type, level range, mode, version, BPM range.
- **Overlap** — find songs that match two different sets of constraints at once (useful for bracket/round planning).
- **Builder** — generate a round list by specifying divisions (each with a level range) and rolling from per-slot song pools.

Key globals:
- `allSongs` — loaded from `/data/songs.json` at init.
- `lastResults` — last filter search result set.
- `builderSelections` — keyed by `${divIndex}-${type}-${level}`, stores the pre-release pool and the rolled pick for each slot.
- `builderDivisions` — active division configs for the builder.

---

## Conventions

- **ES modules** throughout (`"type": "module"` in package.json). Use `import`/`export`, not `require`.
- **No TypeScript**, no build step for the scraper.
- `data/songs.json` is the single source of truth for the frontend. Never modify it manually; always go through the scraper or a patch file.
- Patch files follow the naming convention `manual-patch-v{major}_{minor}_{patch}.json`.
- Merge rules: new charts are addded to existing songs; `songArtist` and `bpm` are only set if currently `null`; new songs are created with `version` from the patch header.
- CO-OP charts are intentionally excluded from the database.
