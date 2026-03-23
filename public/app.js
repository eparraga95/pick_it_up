/* pick it up — Chart Search
 * Loads ../data/songs.json, applies filters, renders results.
 */

// ── State ───────────────────────────────────────────────────────────────

let allSongs = [];
let lastResults = [];

// ── Init ────────────────────────────────────────────────────────────────

async function init() {
  try {
    const res = await fetch("/data/songs.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const db = await res.json();

    allSongs = db.songs ?? [];

    populateVersionFilter(allSongs);
    updateDbMeta(db);
    bindEvents();
  } catch (err) {
    document.getElementById("results-body").innerHTML =
      `<p class="state-msg">⚠️ Could not load songs.json: ${err.message}<br>
       Make sure you are serving from the project root (e.g. <code>npx serve .</code>).</p>`;
  }
}

// ── Populate version dropdown ────────────────────────────────────────────

const VERSION_LABELS = {
  phoenix: "Phoenix",
  xx: "XX",
  prime2: "Prime 2",
  prime: "Prime",
  fiesta2: "Fiesta 2",
  fiesta: "Fiesta",
  "nx~nx2": "NX to NX2",
  "1st~3rd": "1st to 3rd",
  "s.e.~extra": "S.E. to Extra",
  fiestaex: "Fiesta EX",
  "exceed~zero": "Exceed to Zero",
  "rebirth~prex3": "Rebirth to Prex 3",
  nxabsolute: "NX Absolute",
};

function labelFor(v) {
  return VERSION_LABELS[v?.toLowerCase?.()] ?? v ?? "(unknown)";
}

const VERSION_ORDER = Object.keys(VERSION_LABELS);

function populateVersionFilter(songs) {
  const versions = [...new Set(songs.map((s) => s.version).filter(Boolean))];
  versions.sort((a, b) => {
    const ai = VERSION_ORDER.indexOf(a?.toLowerCase());
    const bi = VERSION_ORDER.indexOf(b?.toLowerCase());
    const av = ai < 0 ? 999 : ai;
    const bv = bi < 0 ? 999 : bi;
    return av - bv;
  });

  const sel = document.getElementById("f-version");
  versions.forEach((v) => {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = labelFor(v);
    sel.appendChild(opt);
  });
}

function updateDbMeta(db) {
  const el = document.getElementById("db-meta");
  const songs = db.totalSongs ?? allSongs.length;
  const charts =
    db.totalCharts ?? allSongs.reduce((s, sg) => s + sg.charts.length, 0);
  const patch = db.lastPatchApplied
    ? ` · last patch: ${db.lastPatchApplied}`
    : "";
  el.textContent = `Database: ${songs} songs · ${charts} charts${patch}`;
}

// ── Events ───────────────────────────────────────────────────────────────

function bindEvents() {
  document.getElementById("btn-search").addEventListener("click", runSearch);
  document.getElementById("btn-reset").addEventListener("click", resetFilters);
  document
    .getElementById("sort-select")
    .addEventListener("change", () => renderResults(lastResults));

  // Overlap tab
  document.getElementById("btn-overlap-search").addEventListener("click", runOverlapSearch);
  document.getElementById("btn-overlap-reset").addEventListener("click", resetOverlap);

  // Tab switching
  document.querySelectorAll(".panel-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".panel-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const target = tab.dataset.tab;
      document.getElementById("panel-filters").style.display = target === "filters" ? "flex" : "none";
      document.getElementById("panel-overlap").style.display = target === "overlap" ? "flex" : "none";
    });
  });

  // Enter key fires search from any filter input
  document
    .querySelectorAll(".filter-panel input, .filter-panel select")
    .forEach((el) => {
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          const inOverlap = el.closest("#panel-overlap");
          if (inOverlap) runOverlapSearch(); else runSearch();
        }
      });
    });

  // Sanitise number inputs: no negatives, integers only
  document.querySelectorAll('.filter-panel input[type="number"]').forEach((el) => {
    el.addEventListener("input", () => {
      if (el.value === "") return;
      const clean = el.value.replace(/[^0-9]/g, "");
      el.value = clean === "" ? "" : String(parseInt(clean, 10));
    });
  });
}

function getFilters() {
  return {
    title: document.getElementById("f-title").value.trim().toLowerCase(),
    artist: document.getElementById("f-artist").value.trim().toLowerCase(),
    stepArtist: document
      .getElementById("f-step-artist")
      .value.trim()
      .toLowerCase(),
    type: document.querySelector('input[name="type"]:checked')?.value ?? "all",
    levelMin: parseInt(document.getElementById("f-level-min").value) || 1,
    levelMax: parseInt(document.getElementById("f-level-max").value) || 28,
    mode: document.getElementById("f-mode").value,
    version: document.getElementById("f-version").value,
    bpmMin: parseInt(document.getElementById("f-bpm-min").value) || null,
    bpmMax: parseInt(document.getElementById("f-bpm-max").value) || null,
  };
}

function resetFilters() {
  document.getElementById("f-title").value = "";
  document.getElementById("f-artist").value = "";
  document.getElementById("f-step-artist").value = "";
  document.getElementById("f-level-min").value = "";
  document.getElementById("f-level-max").value = "";
  document.getElementById("f-mode").value = "";
  document.getElementById("f-version").value = "";
  document.getElementById("f-bpm-min").value = "";
  document.getElementById("f-bpm-max").value = "";
  document.querySelector('input[name="type"][value="all"]').checked = true;

  lastResults = [];
  document.getElementById("results-count").textContent = "";
  document.getElementById("sort-bar").style.display = "none";
  document.getElementById("results-body").innerHTML =
    '<p class="state-msg">Use the filters on the left and press <strong>Search</strong>.</p>';
}

// ── Overlap Search ────────────────────────────────────────────────────────────

function resetOverlap() {
  document.getElementById("ov-level-a").value = "";
  document.getElementById("ov-level-b").value = "";
  document.querySelector('input[name="ov-type"][value="all"]').checked = true;

  lastResults = [];
  document.getElementById("results-count").textContent = "";
  document.getElementById("sort-bar").style.display = "none";
  document.getElementById("results-body").innerHTML =
    '<p class="state-msg">Enter two levels and press <strong>Search</strong>.</p>';
}

function runOverlapSearch() {
  const levelA = parseInt(document.getElementById("ov-level-a").value);
  const levelB = parseInt(document.getElementById("ov-level-b").value);
  const type   = document.querySelector('input[name="ov-type"]:checked')?.value ?? "all";

  if (isNaN(levelA) || isNaN(levelB)) {
    document.getElementById("results-body").innerHTML =
      '<p class="state-msg">Please enter both levels.</p>';
    document.getElementById("results-count").textContent = "";
    document.getElementById("sort-bar").style.display = "none";
    return;
  }

  const results = [];

  for (const song of allSongs) {
    // Candidate charts that match the type filter
    const candidates = type === "all" ? song.charts : song.charts.filter((c) => c.type === type);

    const hasA = candidates.some((c) => c.level === levelA);
    const hasB = candidates.some((c) => c.level === levelB);

    if (!hasA || !hasB) continue;

    // Show only the two overlapping charts (or all if A === B)
    const matchedCharts = candidates.filter(
      (c) => c.level === levelA || c.level === levelB
    );

    results.push({ song, matchedCharts });
  }

  lastResults = results;
  renderResults(results);
}

// ── Search ───────────────────────────────────────────────────────────────

function runSearch() {
  const f = getFilters();

  const results = [];

  for (const song of allSongs) {
    // Title match
    if (f.title && !song.title.toLowerCase().includes(f.title)) continue;

    // Song artist match
    if (f.artist) {
      const sa = (song.songArtist ?? "").toLowerCase();
      if (!sa.includes(f.artist)) continue;
    }

    // Step artist match
    if (f.stepArtist) {
      const st = (song.stepArtist ?? "").toLowerCase();
      if (!st.includes(f.stepArtist)) continue;
    }

    // Version match (at song level)
    if (f.version && song.version?.toLowerCase() !== f.version.toLowerCase())
      continue;

    // BPM match (skip songs with null bpm when bpm filter is active)
    if (f.bpmMin !== null || f.bpmMax !== null) {
      if (song.bpm == null) continue;
      if (f.bpmMin !== null && song.bpm < f.bpmMin) continue;
      if (f.bpmMax !== null && song.bpm > f.bpmMax) continue;
    }

    // Filter charts
    const matchedCharts = song.charts.filter((c) => {
      if (f.type !== "all" && c.type !== f.type) return false;
      if (c.level < f.levelMin || c.level > f.levelMax) return false;
      if (f.mode && c.mode !== f.mode) return false;
      return true;
    });

    if (matchedCharts.length === 0) continue;

    results.push({ song, matchedCharts });
  }

  lastResults = results;
  renderResults(results);
}

// ── Render ───────────────────────────────────────────────────────────────

function renderResults(results) {
  const sortKey = document.getElementById("sort-select").value;
  const sorted = sortResults([...results], sortKey);

  const body = document.getElementById("results-body");
  const count = document.getElementById("results-count");
  const sortBar = document.getElementById("sort-bar");

  const totalCharts = results.reduce((n, r) => n + r.matchedCharts.length, 0);

  if (results.length === 0) {
    sortBar.style.display = "none";
    count.textContent = "";
    body.innerHTML =
      '<p class="state-msg">No songs match the current filters.</p>';
    return;
  }

  sortBar.style.display = "";
  count.innerHTML = `<strong>${results.length}</strong> song${results.length !== 1 ? "s" : ""}, <strong>${totalCharts}</strong> chart${totalCharts !== 1 ? "s" : ""}`;

  body.innerHTML = "";
  const list = document.createElement("div");
  list.className = "song-list";

  for (const { song, matchedCharts } of sorted) {
    list.appendChild(buildCard(song, matchedCharts));
  }

  body.appendChild(list);
}

function sortResults(results, key) {
  switch (key) {
    case "title-asc":
      return results.sort((a, b) => a.song.title.localeCompare(b.song.title));
    case "title-desc":
      return results.sort((a, b) => b.song.title.localeCompare(a.song.title));
    case "bpm-asc":
      return results.sort((a, b) => (a.song.bpm ?? 0) - (b.song.bpm ?? 0));
    case "bpm-desc":
      return results.sort((a, b) => (b.song.bpm ?? 0) - (a.song.bpm ?? 0));
    case "charts-desc":
      return results.sort(
        (a, b) => b.matchedCharts.length - a.matchedCharts.length,
      );
    default:
      return results;
  }
}

// ── Card builder ──────────────────────────────────────────────────────────

function buildCard(song, matchedCharts) {
  const card = document.createElement("div");
  card.className = "song-card";

  // Header row
  const header = document.createElement("div");
  header.className = "song-card-header";

  const titleEl = document.createElement("span");
  titleEl.className = "song-title";
  titleEl.textContent = song.title;
  header.appendChild(titleEl);

  card.appendChild(header);

  // Meta row
  const meta = document.createElement("div");
  meta.className = "song-meta";

  function metaRow(label, value) {
    const row = document.createElement("div");
    row.className = "meta-row";
    const k = document.createElement("span");
    k.className = "meta-key";
    k.textContent = label;
    const v = document.createElement("span");
    v.className = value ? "meta-val" : "meta-val meta-val--missing";
    v.textContent = value ?? "unknown";
    row.appendChild(k);
    row.appendChild(v);
    return row;
  }

  const infoRow = document.createElement("div");
  infoRow.className = "meta-row meta-row--info";
  if (song.bpm) {
    const bpmEl = document.createElement("span");
    bpmEl.className = "meta-bpm";
    bpmEl.textContent = `${song.bpm} BPM`;
    infoRow.appendChild(bpmEl);
  }
  if (song.version) {
    const pill = document.createElement("span");
    pill.className = "version-pill";
    pill.textContent = labelFor(song.version);
    infoRow.appendChild(pill);
  }
  if (infoRow.children.length) meta.appendChild(infoRow);

  meta.appendChild(metaRow("Song", song.songArtist));
  meta.appendChild(metaRow("Steps", song.stepArtist));

  card.appendChild(meta);

  // Charts row — sorted: S before D, then by level asc
  const chartsRow = document.createElement("div");
  chartsRow.className = "charts-row";

  const sorted = [...matchedCharts].sort(
    (a, b) => b.type.localeCompare(a.type) || a.level - b.level,
  );

  for (const chart of sorted) {
    const badge = document.createElement("span");
    badge.className = `chart-badge type-${chart.type}`;

    const typeIndicator = document.createElement("span");
    typeIndicator.className = "type-indicator";
    typeIndicator.textContent = chart.type;

    const levelEl = document.createElement("span");
    levelEl.textContent = chart.level;

    badge.appendChild(typeIndicator);
    badge.appendChild(levelEl);
    chartsRow.appendChild(badge);
  }

  card.appendChild(chartsRow);
  return card;
}

// ── Boot ─────────────────────────────────────────────────────────────────

init();
