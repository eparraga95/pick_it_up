# pick it up

A PIU song database and generic song-list builder for Pump it Up.

## Project context

Pump it Up (PIU) is a Korean arcade rhythm game.

`pick it up` provides:
1. **A reliable song database** scraped from [piucenter.com](https://www.piucenter.com) and supplemented with manual patch data.
2. **A static chart search UI** to filter and explore the song database by title, artist, type, level, mode, version, and BPM.
3. **A song-list builder** (planned) for composing curated round lists for tournaments or events.

---

## Song database

### Data structure

`data/songs.json` — auto-generated, do not edit by hand.

```json
{
  "generatedAt": "2026-03-22T00:00:00.000Z",
  "source": "piucenter.com",
  "totalSongs": 350,
  "totalCharts": 4124,
  "songs": [
    {
      "id": "heliosphere",
      "title": "Heliosphere",
      "artist": "BlackY",
      "bpm": 175,
      "version": "XX",
      "charts": [
        { "type": "S", "level": 14, "mode": "arcade" },
        { "type": "S", "level": 21, "mode": "arcade" },
        { "type": "D", "level": 23, "mode": "arcade" }
      ]
    }
  ]
}
```

**Chart modes:** `arcade` | `remix` | `fullsong` | `shortcut`  
**Chart types:** `S` (Single) | `D` (Double)

### Running the scraper

```bash
npm install

# First run — scrapes all ~42 pages (~4100 charts)
npm run scrape

# Resume an interrupted run
npm run scrape:resume

# Also fetch artist + version from each song's detail page (slow, ~300 extra requests)
npm run scrape:details

# Merge manual-patches.json into songs.json
npm run merge
```

### Manual patches

Songs not yet on piucenter (recent Phoenix patches) go in `data/manual-patches.json`.  
After editing, run `npm run merge` to incorporate them into `songs.json`.

---

## Roadmap

### Phase 1 — Song Database ✅
- [x] Piucenter full scraper (Playwright, paginated, checkpointed)
- [x] Manual patches system (per-patch JSON files, dry-run + apply)
- [x] Validate output against known song counts per Phoenix version

### Phase 2 — Chart Search UI
- [x] Static page (`public/index.html`) served from project root
- [x] Filters: title, song artist, chart type (S/D), level range, mode, version, BPM range
- [x] Results: per-song cards with matching chart badges color-coded by level tier
- [ ] URL-shareable filter state (query params)

### Phase 3 — Song List Builder
- [ ] Slot-based list composer (pick charts into named slots)
- [ ] Rule/constraint config (level ranges, type quotas, mode restrictions)
- [ ] Rule validator with warnings
- [ ] Export to PDF / JSON / shareable link

### Phase 4 — Maintenance
- [ ] CLI diff tool: re-scrape and show new/removed charts vs current songs.json
- [ ] Scraper triggered by Phoenix patch notes detection
