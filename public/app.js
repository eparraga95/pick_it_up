/* pick it up — Chart Search
 * Loads ../data/songs.json, applies filters, renders results.
 */

// ── State ───────────────────────────────────────────────────────────────

let allSongs = [];
let lastResults = [];

// Builder state
let builderDivisions  = [];
let builderModeValue  = 'arcade';
let builderPoolSize   = 3;   // songs per pool slot (min 1)
// builderSelections[`${divIndex}-${type}-${level}`] = { pool: string[], picked: string|null }
// pool: up to 3 song ids selected for the pre-release pool
// picked: the one rolled/chosen as the actual round chart
let builderSelections = {};

function getSlot(key) {
  if (!builderSelections[key]) builderSelections[key] = { pool: [], picked: null };
  return builderSelections[key];
}

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
    initBuilder();
  } catch (err) {
    document.getElementById("results-body").innerHTML =
      `<p class="state-msg">⚠️ Could not load songs.json: ${err.message}<br>
       Make sure you are serving from the project root (e.g. <code>npx serve .</code>).</p>`;
  }
}

// ── Populate version chips ───────────────────────────────────────────────

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

  const container = document.getElementById("f-version-chips");
  versions.forEach((v) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "version-chip";
    chip.dataset.version = v;
    chip.textContent = labelFor(v);
    chip.addEventListener("click", () => {
      chip.classList.toggle("active");
    });
    container.appendChild(chip);
  });
}

function updateDbMeta(db) {
  const el = document.getElementById("db-meta");
  const songs = db.totalSongs ?? allSongs.length;
  const charts =
    db.totalCharts ?? allSongs.reduce((s, sg) => s + sg.charts.length, 0);
  const patch = db.lastPatchApplied
    ? ` · v${db.lastPatchApplied}`
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

  // Builder tab
  document.getElementById("btn-build").addEventListener("click", buildRound);
  document.getElementById("btn-build-reset").addEventListener("click", resetBuilder);
  document.getElementById("bl-pool-dec").addEventListener("click", () => {
    if (builderPoolSize <= 1) return;
    builderPoolSize--;
    document.getElementById("bl-pool-size-display").textContent = builderPoolSize;
    // Trim any pools that now exceed the new size
    for (const slot of Object.values(builderSelections)) {
      if (slot.pool.length > builderPoolSize) {
        slot.pool = slot.pool.slice(0, builderPoolSize);
        if (slot.picked && !slot.pool.includes(slot.picked)) slot.picked = null;
      }
    }
  });
  document.getElementById("bl-pool-inc").addEventListener("click", () => {
    builderPoolSize++;
    document.getElementById("bl-pool-size-display").textContent = builderPoolSize;
  });
  document.getElementById("bl-add-div").addEventListener("click", () => {
    const confs = getDivisionConfigs();
    // Div 1 = highest; new division goes at the bottom (lowest levels)
    const last = confs[confs.length - 1];
    const next = last
      ? last.levels.map(l => Math.max(1, l - 3))
      : [3, 4];
    renderBuilderDivRows([...confs.map(d => d.levels), next]);
  });
  document.getElementById("bl-remove-div").addEventListener("click", () => {
    const confs = getDivisionConfigs();
    if (confs.length > 1) renderBuilderDivRows(confs.slice(0, -1).map(d => d.levels));
  });
  // Delegated events for dynamically-added builder division inputs
  const builderPanel = document.getElementById("panel-builder");
  builderPanel.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.matches("input")) buildRound();
  });
  builderPanel.addEventListener("input", (e) => {
    const el = e.target;
    if (el.type !== "number" || el.value === "") return;
    const clean = el.value.replace(/[^0-9]/g, "");
    el.value = clean === "" ? "" : String(parseInt(clean, 10));
  });

  // Tab switching
  document.querySelectorAll(".panel-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".panel-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const target = tab.dataset.tab;
      document.getElementById("panel-filters").style.display = target === "filters" ? "flex" : "none";
      document.getElementById("panel-overlap").style.display = target === "overlap" ? "flex" : "none";
      document.getElementById("panel-builder").style.display = target === "builder" ? "flex" : "none";
      if (target === "builder" && builderDivisions.length === 0) showBuilderPlaceholder();
    });
  });

  // Enter key fires search from any filter input
  document
    .querySelectorAll(".filter-panel input, .filter-panel select")
    .forEach((el) => {
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          if (el.closest("#panel-overlap")) { runOverlapSearch(); return; }
          if (el.closest("#panel-builder")) { buildRound(); return; }
          runSearch();
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
    levelMax: parseInt(document.getElementById("f-level-max").value) || 29,
    mode: document.getElementById("f-mode").value,
    version: new Set(
      [...document.querySelectorAll("#f-version-chips .version-chip.active")]
        .map(c => c.dataset.version.toLowerCase())
    ),
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
  document.querySelectorAll("#f-version-chips .version-chip").forEach(c => c.classList.remove("active"));
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
    if (f.version.size > 0 && !f.version.has(song.version?.toLowerCase()))
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

// ── Builder ───────────────────────────────────────────────────────────────────

// CBPIU 2025 defaults: Div 1 is the highest division (21&22), descending
const BUILDER_DEFAULTS = [
  [21, 22],
  [18, 19],
  [15, 16],
  [12, 13],
  [9,  10],
  [6,  7],
];

function initBuilder() {
  renderBuilderDivRows(BUILDER_DEFAULTS);
}

function renderBuilderDivRows(pairs) {
  const container = document.getElementById('bl-divisions');
  container.innerHTML = '';
  pairs.forEach((levels, i) => {
    const row = document.createElement('div');
    row.className = 'bl-div-row';

    const label = document.createElement('span');
    label.className = 'bl-div-label';
    label.textContent = `Div ${i + 1}`;
    row.appendChild(label);

    levels.forEach((val, j) => {
      if (j > 0) {
        const sep = document.createElement('span');
        sep.className = 'range-sep'; sep.textContent = '&';
        row.appendChild(sep);
      }
      const inp = document.createElement('input');
      inp.type = 'number'; inp.className = 'bl-level';
      inp.min = 1; inp.max = 29; inp.value = val;
      row.appendChild(inp);
    });

    const addBtn = document.createElement('button');
    addBtn.className = 'btn-ghost btn-sm';
    addBtn.textContent = '+';
    addBtn.title = 'Add a chart level to this division';
    addBtn.addEventListener('click', () => {
      const confs = getDivisionConfigs();
      const last = confs[i].levels[confs[i].levels.length - 1];
      confs[i].levels.push(Math.min(29, last + 1));
      renderBuilderDivRows(confs.map(d => d.levels));
    });

    const remBtn = document.createElement('button');
    remBtn.className = 'btn-ghost btn-sm';
    remBtn.textContent = '−';
    remBtn.title = 'Remove last chart level from this division';
    remBtn.disabled = levels.length <= 1;
    remBtn.addEventListener('click', () => {
      const confs = getDivisionConfigs();
      if (confs[i].levels.length > 1) {
        confs[i].levels.pop();
        renderBuilderDivRows(confs.map(d => d.levels));
      }
    });

    row.append(addBtn, remBtn);
    container.appendChild(row);
  });
}

function getDivisionConfigs() {
  return [...document.querySelectorAll('.bl-div-row')].map((row, i) => ({
    index:  i,
    label:  `Division ${i + 1}`,
    levels: [...row.querySelectorAll('.bl-level')].map((inp, j) => parseInt(inp.value) || (j + 1)),
  }));
}

function getCandidates(level, type, mode) {
  return allSongs.filter(song =>
    song.charts.some(c =>
      c.type === type &&
      c.level === level &&
      (!mode || c.mode === mode)
    )
  );
}

function rollSlot(key) {
  const slot = builderSelections[key];
  if (!slot || slot.pool.length === 0) return;
  slot.picked = slot.pool[Math.floor(Math.random() * slot.pool.length)];
}

function buildRound() {
  builderDivisions  = getDivisionConfigs();
  builderModeValue  = document.getElementById('bl-mode').value;
  builderSelections = {};
  renderBuilderOutput();
}

function resetBuilder() {
  renderBuilderDivRows(BUILDER_DEFAULTS);
  document.getElementById('bl-mode').value = 'arcade';
  builderPoolSize = 3;
  document.getElementById('bl-pool-size-display').textContent = '3';
  builderDivisions  = [];
  builderModeValue  = 'arcade';
  builderSelections = {};
  showBuilderPlaceholder();
}

function showBuilderPlaceholder() {
  document.getElementById('results-count').textContent = '';
  document.getElementById('sort-bar').style.display = 'none';
  document.getElementById('results-body').innerHTML =
    '<p class="state-msg">Configure divisions above and press <strong>Build Round</strong>.<br><small style="color:#555">Use <em>Random Pool</em> to auto-pick 3 songs per slot, or click songs to build the pool manually, then press <em>Roll</em>.</small></p>';
}

function renderBuilderOutput() {
  const body    = document.getElementById('results-body');
  const count   = document.getElementById('results-count');
  const sortBar = document.getElementById('sort-bar');
  count.textContent     = '';
  sortBar.style.display = 'none';

  if (builderDivisions.length === 0) {
    body.innerHTML = '<p class="state-msg">Add at least one division.</p>';
    return;
  }

  body.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'builder-grid';

  for (const div of builderDivisions) {
    grid.appendChild(buildBuilderDivCard(div));
  }
  grid.appendChild(buildRoundSummary());
  body.appendChild(grid);

  // ── Bottom action bar ────────────────────────────────
  const actionBar = document.createElement('div');
  actionBar.className = 'builder-action-bar';

  const randAllBtn = document.createElement('button');
  randAllBtn.className = 'btn-ghost';
  randAllBtn.textContent = 'Randomize All Pools';
  randAllBtn.addEventListener('click', () => {
    for (const div of builderDivisions) {
      for (const type of ['S', 'D']) {
        for (const level of div.levels) {
          const key  = `${div.index}-${type}-${level}`;
          const slot = getSlot(key);
          const candidates = getCandidates(level, type, builderModeValue);
          if (candidates.length === 0) continue;
          const shuffled = [...candidates];
          for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
          }
          slot.pool   = shuffled.slice(0, builderPoolSize).map(s => s.id);
          slot.picked = null;
        }
      }
    }
    renderBuilderOutput();
  });

  const rollAllBtn = document.createElement('button');
  rollAllBtn.className = 'btn-ghost builder-roll-btn';
  rollAllBtn.textContent = 'Roll All';
  rollAllBtn.addEventListener('click', () => {
    for (const div of builderDivisions) {
      for (const type of ['S', 'D']) {
        for (const level of div.levels) {
          rollSlot(`${div.index}-${type}-${level}`);
        }
      }
    }
    renderBuilderOutput();
  });

  actionBar.append(randAllBtn, rollAllBtn);
  body.appendChild(actionBar);
}

function buildBuilderDivCard(div) {
  const card = document.createElement('div');
  card.className = 'builder-div-card';

  const header = document.createElement('div');
  header.className = 'builder-div-header';

  const nameEl = document.createElement('span');
  nameEl.className = 'builder-div-name';
  nameEl.textContent = div.label;

  const levelsEl = document.createElement('span');
  levelsEl.className = 'builder-div-levels';
  levelsEl.textContent =
    div.levels.map(l => `S${l}`).join(' & ') + '  ·  ' + div.levels.map(l => `D${l}`).join(' & ');

  header.append(nameEl, levelsEl);
  card.appendChild(header);

  for (const type of ['S', 'D']) {
    for (const level of div.levels) {
      const candidates = getCandidates(level, type, builderModeValue);
      card.appendChild(buildBuilderTypeSection(div.index, type, level, candidates));
    }
  }

  return card;
}

function buildBuilderTypeSection(divIndex, type, level, candidates) {
  const key  = `${divIndex}-${type}-${level}`;
  const slot = getSlot(key);

  const section = document.createElement('div');
  section.className = 'builder-type-section';

  function rerender() {
    section.replaceWith(buildBuilderTypeSection(divIndex, type, level, candidates));
    const summaryEl = document.querySelector('.round-summary');
    if (summaryEl) summaryEl.replaceWith(buildRoundSummary());
  }

  // ── Section header ───────────────────────────────────
  const secHeader = document.createElement('div');
  secHeader.className = 'builder-type-header';

  const typeLabel = document.createElement('span');
  typeLabel.className = `builder-type-label type-${type}`;
  typeLabel.textContent = type === 'S' ? 'Single' : 'Double';

  const levelLabel = document.createElement('span');
  levelLabel.className = 'builder-type-levels';
  levelLabel.textContent = `${type}${level}`;

  const countLabel = document.createElement('span');
  countLabel.className = 'builder-candidate-count';
  countLabel.textContent = `${candidates.length} eligible`;

  const poolStatus = document.createElement('span');
  poolStatus.className = 'builder-pool-status' + (slot.pool.length === builderPoolSize ? ' full' : '');
  poolStatus.textContent = `Pool ${slot.pool.length}/${builderPoolSize}`;

  // Randomly fills the pool with up to 3 songs from eligible candidates
  const randomPoolBtn = document.createElement('button');
  randomPoolBtn.className = 'btn-ghost btn-sm';
  randomPoolBtn.textContent = 'Random Pool';
  randomPoolBtn.disabled = candidates.length === 0;
  randomPoolBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    // Fisher-Yates shuffle on a copy, take first 3
    const shuffled = [...candidates];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    slot.pool   = shuffled.slice(0, builderPoolSize).map(s => s.id);
    slot.picked = null;
    rerender();
  });

  const rollBtn = document.createElement('button');
  rollBtn.className = 'btn-ghost btn-sm builder-roll-btn';
  rollBtn.textContent = slot.picked ? 'Re-roll' : 'Roll';
  rollBtn.disabled = slot.pool.length === 0;
  rollBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    rollSlot(key);
    rerender();
  });

  secHeader.append(typeLabel, levelLabel, countLabel, poolStatus, randomPoolBtn, rollBtn);
  section.appendChild(secHeader);

  // ── Empty state ──────────────────────────────────────
  if (candidates.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'builder-no-candidates';
    empty.textContent = 'No songs match this level.';
    section.appendChild(empty);
    return section;
  }

  // ── Candidate list ───────────────────────────────────
  const list = document.createElement('div');
  list.className = 'builder-candidate-list';

  for (const song of candidates) {
    const poolIdx  = slot.pool.indexOf(song.id);
    const inPool   = poolIdx >= 0;
    const isPicked = slot.picked === song.id;
    const isFull   = slot.pool.length >= builderPoolSize && !inPool;

    const row = document.createElement('div');
    row.className = 'builder-candidate'
      + (isPicked ? ' picked' : inPool ? ' in-pool' : '')
      + (isFull ? ' pool-full' : '');

    const check = document.createElement('span');
    check.className = 'builder-candidate-check';
    check.textContent = isPicked ? '★' : inPool ? String(poolIdx + 1) : '○';

    const title = document.createElement('span');
    title.className = 'builder-candidate-title';
    title.textContent = song.title;

    const chartsWrap = document.createElement('span');
    chartsWrap.className = 'builder-candidate-charts';
    song.charts
      .filter(c => c.type === type && c.level === level)
      .forEach(c => {
        const badge   = document.createElement('span');
        badge.className = `chart-badge type-${c.type}`;
        const typeInd = document.createElement('span');
        typeInd.className = 'type-indicator';
        typeInd.textContent = c.type;
        const lvlEl = document.createElement('span');
        lvlEl.textContent = c.level;
        badge.append(typeInd, lvlEl);
        chartsWrap.appendChild(badge);
      });

    row.append(check, title, chartsWrap);
    row.addEventListener('click', () => {
      if (inPool) {
        slot.pool.splice(poolIdx, 1);
        if (slot.picked === song.id) slot.picked = null;
      } else if (!isFull) {
        slot.pool.push(song.id);
      }
      rerender();
    });

    list.appendChild(row);
  }

  section.appendChild(list);
  return section;
}

function buildRoundSummary() {
  const summary = document.createElement('div');
  summary.className = 'round-summary';

  const titleEl = document.createElement('h3');
  titleEl.className = 'round-summary-title';
  titleEl.textContent = 'Round Summary';
  summary.appendChild(titleEl);

  let hasAny = false;

  for (const div of builderDivisions) {
    // Check if this division has any pool entries at all
    const divHasAny = ['S', 'D'].some(type =>
      div.levels.some(level => {
        const slot = builderSelections[`${div.index}-${type}-${level}`];
        return slot && slot.pool.length > 0;
      })
    );
    if (!divHasAny) continue;
    hasAny = true;

    const divRow = document.createElement('div');
    divRow.className = 'summary-div-row';

    const divLabel = document.createElement('div');
    divLabel.className = 'summary-div-label';
    divLabel.textContent = div.label;
    divRow.appendChild(divLabel);

    const divSlots = document.createElement('div');
    divSlots.className = 'summary-div-slots';

    for (const type of ['S', 'D']) {
      for (const level of div.levels) {
        const slot  = builderSelections[`${div.index}-${type}-${level}`];
        const slotEl = document.createElement('div');
        slotEl.className = 'summary-slot';

        const typeEl = document.createElement('span');
        typeEl.className = `summary-slot-type type-${type}`;
        typeEl.textContent = `${type}${level}`;
        slotEl.appendChild(typeEl);

        if (!slot || slot.pool.length === 0) {
          const emptyEl = document.createElement('span');
          emptyEl.className = 'summary-slot-song empty';
          emptyEl.textContent = '—';
          slotEl.appendChild(emptyEl);
        } else {
          const poolEl = document.createElement('div');
          poolEl.className = 'summary-pool';
          for (const songId of slot.pool) {
            const song = allSongs.find(s => s.id === songId);
            const item = document.createElement('div');
            item.className = 'summary-pool-item' + (slot.picked === songId ? ' picked' : '');
            const mark = document.createElement('span');
            mark.className = 'summary-pick-mark';
            mark.textContent = slot.picked === songId ? '★' : '·';
            const nameEl = document.createElement('span');
            nameEl.textContent = song?.title ?? songId;
            item.append(mark, nameEl);
            poolEl.appendChild(item);
          }
          slotEl.appendChild(poolEl);

          const slotBtnRow = document.createElement('div');
          slotBtnRow.className = 'summary-slot-btn-row';

          const slotRandBtn = document.createElement('button');
          slotRandBtn.className = 'btn-ghost btn-sm';
          slotRandBtn.textContent = 'Random Pool';
          slotRandBtn.addEventListener('click', () => {
            const candidates = getCandidates(level, type, builderModeValue);
            if (candidates.length === 0) return;
            const shuffled = [...candidates];
            for (let i = shuffled.length - 1; i > 0; i--) {
              const j = Math.floor(Math.random() * (i + 1));
              [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
            }
            slot.pool   = shuffled.slice(0, builderPoolSize).map(s => s.id);
            slot.picked = null;
            const summaryEl = document.querySelector('.round-summary');
            if (summaryEl) summaryEl.replaceWith(buildRoundSummary());
          });

          const slotRollBtn = document.createElement('button');
          slotRollBtn.className = 'btn-ghost btn-sm summary-slot-roll-btn';
          slotRollBtn.textContent = slot.picked ? 'Re-roll' : 'Roll';
          slotRollBtn.addEventListener('click', () => {
            rollSlot(`${div.index}-${type}-${level}`);
            const summaryEl = document.querySelector('.round-summary');
            if (summaryEl) summaryEl.replaceWith(buildRoundSummary());
          });

          slotBtnRow.append(slotRandBtn, slotRollBtn);
          slotEl.appendChild(slotBtnRow);

          if (!slot.picked) {
            const hint = document.createElement('span');
            hint.className = 'summary-roll-hint';
            hint.textContent = 'Not rolled yet';
            slotEl.appendChild(hint);
          }
        }

        divSlots.appendChild(slotEl);
      }
    }

    divRow.appendChild(divSlots);
    summary.appendChild(divRow);
  }

  if (!hasAny) {
    const empty = document.createElement('p');
    empty.className = 'state-msg';
    empty.style.padding = '16px 0 4px';
    empty.textContent = 'Add up to 3 songs per type to build each pool, then roll.';
    summary.appendChild(empty);
  }

  return summary;
}

// ── Boot ─────────────────────────────────────────────────────────────────

init();
