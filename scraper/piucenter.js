/**
 * piucenter.js
 * Core scraping logic for https://www.piucenter.com/search
 *
 * Strategy:
 *  - Paginate through all pages of /search (default: no filters, all charts)
 *  - Parse every chart row from the table: title, type (S/D), level, mode, BPM, URL
 *  - Optionally visit each song's detail page for artist + version info
 */

const SEARCH_BASE = 'https://www.piucenter.com/search';

/**
 * Parses the text content of the first column of a chart row.
 * Input examples:
 *   "SONIC BOOM S7"
 *   "Turkey Virus S15 remix"
 *   "Baroque Virus D23 fullsong"
 *   "Wedding Crashers S4 shortcut"
 *   "With my Lover D14"
 *
 * @param {string} cellText
 * @returns {{ title: string, type: 'S'|'D', level: number, mode: string } | null}
 */
function parseChartCell(cellText) {
  const text = cellText.trim();

  // Match pattern: <title> <S|D><level> [mode]
  const match = text.match(/^(.+?)\s+([SD])(\d+)\s*(remix|fullsong|shortcut|co-op)?\s*$/i);
  if (!match) return null;

  const [, rawTitle, type, rawLevel, rawMode] = match;
  return {
    title: rawTitle.trim(),
    type: type.toUpperCase(),
    level: parseInt(rawLevel, 10),
    mode: rawMode ? rawMode.toLowerCase() : 'arcade',
  };
}

/**
 * Parses BPM from the notes-pattern cell text.
 * Input examples:
 *   ">Quarter notes @ 205 bpm"
 *   "16th notes @ 149 bpm"
 *   "<8th notes @ 170 bpm"
 *
 * @param {string} text
 * @returns {number | null}
 */
function parseBpm(text) {
  const match = text.match(/(\d+)\s*bpm/i);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Extracts all chart rows from the currently loaded search page.
 *
 * @param {import('playwright').Page} page
 * @param {boolean} collectUrls - whether to capture detail page links
 * @returns {Promise<{ title: string, type: string, level: number, mode: string, bpm: number|null, url: string|null }[]>}
 */
async function extractChartsFromCurrentPage(page, collectUrls = false) {
  // Wait for at least one row to appear
  await page.waitForSelector('table tbody tr', { timeout: 15_000 }).catch(() => {});
  // Give React time to finish rendering
  await page.waitForTimeout(1200);

  const rows = await page.$$eval('table tbody tr', (trs, shouldCollectUrls) => {
    return trs.map(tr => {
      const cells = Array.from(tr.querySelectorAll('td'));
      if (cells.length < 2) return null;

      const chartCell = cells[0]?.innerText?.trim() ?? '';
      const anchor = cells[0]?.querySelector('a');
      const href = shouldCollectUrls && anchor ? anchor.getAttribute('href') : null;
      // Third cell (index 2) has notes pattern + BPM
      const bpmCell = cells[2]?.innerText?.trim() ?? '';

      return { chartCell, href, bpmCell };
    }).filter(Boolean);
  }, collectUrls);

  const charts = [];
  for (const { chartCell, href, bpmCell } of rows) {
    const parsed = parseChartCell(chartCell);
    if (!parsed) continue;
    charts.push({
      ...parsed,
      bpm: parseBpm(bpmCell),
      url: href ? `https://www.piucenter.com${href}` : null,
    });
  }
  return charts;
}

/**
 * Reads the current page number and total pages from the paginator text.
 * e.g. "Page 3 of 42 (4124 stepcharts)"
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<{ current: number, total: number }>}
 */
async function getPaginatorInfo(page) {
  const bodyText = await page.evaluate(() => document.body.innerText);
  const match = bodyText.match(/Page\s+(\d+)\s+of\s+(\d+)/i);
  if (match) return { current: parseInt(match[1], 10), total: parseInt(match[2], 10) };
  return { current: 1, total: 42 };
}

/**
 * Clicks the ► (next page) button and waits for new content to load.
 * Returns true if clicked, false if the button wasn't found (last page).
 *
 * @param {import('playwright').Page} page
 * @param {number} currentPageNum
 * @returns {Promise<boolean>}
 */
async function clickNextPage(page, currentPageNum) {
  // Find the ► button — it's typically a <button> or <span> containing the ► character
  const nextBtn = await page.evaluateHandle((currentPage) => {
    // Look for a clickable element containing ► that is enabled
    const candidates = Array.from(document.querySelectorAll('button, span, a, div'));
    return candidates.find(el => {
      const text = el.textContent?.trim();
      return text === '►' || text === '▶' || text === '>' || text === 'Next';
    }) ?? null;
  }, currentPageNum);

  const element = nextBtn.asElement();
  if (!element) return false;

  // Click and wait for the page number to increment (table content changes)
  await element.click();

  // Wait for the paginator to show the next page number
  try {
    await page.waitForFunction(
      (expected) => {
        const text = document.body.innerText;
        const match = text.match(/Page\s+(\d+)\s+of\s+\d+/i);
        return match && parseInt(match[1], 10) === expected;
      },
      currentPageNum + 1,
      { timeout: 10_000 }
    );
  } catch {
    // Fallback: just wait a bit
    await page.waitForTimeout(2000);
  }

  return true;
}

/**
 * Navigates to the search page and returns total page count.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<number>}
 */
export async function initSearchPage(page) {
  await page.goto(SEARCH_BASE, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(1500);
  const { total } = await getPaginatorInfo(page);
  console.log(`[piucenter] Total pages detected: ${total}`);
  return total;
}

/**
 * Scrapes all pages by clicking ► to paginate (piucenter is a React SPA;
 * URL ?page=N does not work — navigation must be done via button clicks).
 *
 * Calls `onPageDone(pageNum, charts)` after each page so the caller can
 * checkpoint progress.
 *
 * @param {import('playwright').Page} page - already on the search page
 * @param {object} opts
 * @param {number} opts.startPage - 1-based page to start from (for resume)
 * @param {number} opts.totalPages
 * @param {boolean} opts.collectUrls
 * @param {(pageNum: number, charts: object[]) => Promise<void>} opts.onPageDone
 */
export async function scrapeAllPages(page, { startPage = 1, totalPages, collectUrls = false, onPageDone }) {
  // If resuming, we need to click forward to startPage
  if (startPage > 1) {
    console.log(`[piucenter] Fast-forwarding to page ${startPage}...`);
    for (let p = 1; p < startPage; p++) {
      const clicked = await clickNextPage(page, p);
      if (!clicked) {
        console.warn(`[piucenter] Could not fast-forward past page ${p}`);
        break;
      }
    }
  }

  for (let p = startPage; p <= totalPages; p++) {
    const charts = await extractChartsFromCurrentPage(page, collectUrls);
    await onPageDone(p, charts);

    if (p < totalPages) {
      const clicked = await clickNextPage(page, p);
      if (!clicked) {
        console.warn(`[piucenter] ► button not found after page ${p} — stopping early.`);
        break;
      }
    }
  }
}

/**
 * Visits a chart detail page and extracts step artist and game version.
 * Note: on piucenter, "artist" refers to the step/chart author, not the song artist.
 *
 * @param {import('playwright').Page} page
 * @param {string} detailUrl
 * @returns {Promise<{ stepArtist: string|null, version: string|null }>}
 */
export async function scrapeChartDetails(page, detailUrl) {
  try {
    await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await page.waitForTimeout(800);

    const result = await page.evaluate(() => {
      const bodyText = document.body.innerText;

      // On piucenter, "Artist" = the step/chart author
      let stepArtist = null;
      const artistMatch = bodyText.match(/Artist\s*[:\-]\s*(.+)/i);
      if (artistMatch) stepArtist = artistMatch[1].split('\n')[0].trim();

      // Try to find version — look for patterns like "XX", "Phoenix", "PRIME2", etc.
      let version = null;
      const versionMatch = bodyText.match(/(?:Version|Added in|Debut)\s*[:\-]?\s*([A-Za-z0-9\s]+)/i);
      if (versionMatch) version = versionMatch[1].split('\n')[0].trim();

      // Fallback: try the specific selector the old scraper used
      const versionEl = document.querySelector('div.font-small > div:nth-of-type(2) > span:nth-child(1)');
      if (versionEl && !version) {
        version = versionEl.textContent.trim().replace(/\s|&emsp;|[\u00a0]/g, '') || null;
      }

      return { stepArtist, version };
    });

    return result;
  } catch {
    return { stepArtist: null, version: null };
  }
}
