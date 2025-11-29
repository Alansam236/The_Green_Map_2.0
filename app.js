
// app.js

// --- Leaflet base map ---
const map = L.map('map', { center: [22.9, 78.8], zoom: 5 });
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 18,
  attribution: '&copy; https://www.openstreetmap.org/copyrightOpenStreetMap</a> contributors'
}).addTo(map); // Keep attribution visible. [3](https://www.kaggle.com/datasets/amrit882/india-states-geojson)

const markersLayer = L.layerGroup().addTo(map);
const normalize = s => (s || '').toLowerCase().replace(/\s+/g, '');
const STATUS_COLOR = s => (STATUS_COLORS && STATUS_COLORS[s]) || STATUS_COLORS['Unknown'];

let CITY_INDEX = new Map();
let CITY_INDEX_READY = false;
let ROWS_CACHE = [];

// --- Filters (DOM) ---
const statusFilterEl = document.getElementById('statusFilter');
const categoryFilterEl = document.getElementById('categoryFilter');
const cityFilterEl = document.getElementById('cityFilter');
const stateFilterEl = document.getElementById('stateFilter');
const pocFilterEl = document.getElementById('pocFilter');
const gpFilterEl = document.getElementById('gpFilter');
const yocFilterEl = document.getElementById('yocFilter');
const searchEl = document.getElementById('search');

// --- Load city coordinates index ---
async function loadCityIndex() {
  try {
    const r = await fetch('./assets/in-cities.json');
    if (!r.ok) throw new Error('missing cities file');
    const obj = await r.json();
    const arr = Array.isArray(obj) ? obj : (obj.cities || []);
    arr.forEach(c => {
      CITY_INDEX.set(normalize(c.city), { lat: +c.lat, lon: +c.lng, state: c.admin_name || c.state || null });
    });
    CITY_INDEX_READY = true;
  } catch (e) {
    console.warn('City index not found; using fallback CITY_COORDS.', e);
    const fallback = window.CITY_COORDS || {};
    Object.entries(fallback).forEach(([city, [lat, lon, st]]) => {
      CITY_INDEX.set(normalize(city), { lat: +lat, lon: +lon, state: st || null });
    });
    CITY_INDEX_READY = CITY_INDEX.size > 0;
  }
}

function resolveCity(city) {
  return CITY_INDEX.get(normalize(city));
}

// --- Read Excel in-browser with SheetJS ---
// Pattern: fetch -> arrayBuffer -> XLSX.read -> sheet_to_json. [1](https://github.com/recurze/IndianCities/blob/master/data/latlong_location.csv)
async function loadExcelRows() {
  const resp = await fetch('./dataset.xlsx');
  if (!resp.ok) throw new Error('Failed to fetch dataset.xlsx');
  const buf = await resp.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' }); // SheetJS in-browser import. [2](https://www.worldcitiesdatabase.eu/India.php)
  const sheet = wb.Sheets[wb.SheetNames[0]];
  // Expect headers: City, State, Company Name, Category, Status, Year of Certification, PoC, GP Team
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null, raw: true });
  return rows.map(r => ({
    City: r['City'] ?? null,
    State: r['State'] ?? null,
    Company: r['Company Name'] ?? null,
    Category: r['Category'] ?? null,
    Status: r['Status'] ?? null,
    Year: r['Year of Certification'] ?? null,
    PoC: r['PoC'] ?? null,
    GP: r['GP Team'] ?? null
  }));
}

// --- Build filters from data ---
function populateFilters(rows) {
  const colVals = {
    Status: new Set(), Category: new Set(), City: new Set(),
    State: new Set(), PoC: new Set(), GP: new Set(), Year: new Set()
  };
  rows.forEach(r => {
    if (r.Status) colVals.Status.add(r.Status);
    if (r.Category) colVals.Category.add(r.Category);
    if (r.City) colVals.City.add(r.City);
    if (r.State) colVals.State.add(r.State);
    if (r.PoC) colVals.PoC.add(r.PoC);
    if (r.GP) colVals.GP.add(r.GP);
    if (r.Year !== null && r.Year !== undefined && r.Year !== '') colVals.Year.add(r.Year);
  });

  function fillSelect(el, set) {
    el.innerHTML = '<option value="">All</option>';
    Array.from(set).sort((a,b) => String(a).localeCompare(String(b))).forEach(v => {
      const opt = document.createElement('option'); opt.value = v; opt.textContent = v;
      el.appendChild(opt);
    });
  }

  fillSelect(statusFilterEl, colVals.Status);
  fillSelect(categoryFilterEl, colVals.Category);
  fillSelect(cityFilterEl, colVals.City);
  fillSelect(stateFilterEl, colVals.State);
  fillSelect(pocFilterEl, colVals.PoC);
  fillSelect(gpFilterEl, colVals.GP);
  fillSelect(yocFilterEl, colVals.Year);
}

// --- Render markers ---
function companyPopup(r, coord) {
  const st = coord?.state || r.State || '';
  return `
    <div style="min-width:240px">
      <div><strong>${r.Company || '—'}</strong></div>
      <div><span class="pill">${r.Category || '—'}</span>
           <span class="pill" style="background:${STATUS_COLOR(r.Status)};color:white;">${r.Status || 'Unknown'}</span></div>
      <div>${[r.City, st].filter(Boolean).join(', ')}</div>
      ${r.PoC ? `<div>PoC: ${r.PoC}</div>` : '' }
      ${r.GP ? `<div>GP Team: ${r.GP}</div>` : '' }
      ${r.Year ? `<div>Year of Certification: ${r.Year}</div>` : '' }
    </div>
  `;
}

function applyFilters(rows) {
  const s = statusFilterEl.value;
  const c = categoryFilterEl.value;
  const city = cityFilterEl.value;
  const st = stateFilterEl.value;
  const poc = pocFilterEl.value;
  const gp = gpFilterEl.value;
  const y = yocFilterEl.value;
  const q = searchEl.value.trim().toLowerCase();

  return rows.filter(r => {
    if (s && r.Status !== s) return false;
    if (c && r.Category !== c) return false;
    if (city && r.City !== city) return false;
    if (st && (r.State || '') !== st) return false;
    if (poc && (r.PoC || '') !== poc) return false;
    if (gp && (r.GP || '') !== gp) return false;
    if (y && String(r.Year) !== y) return false;
    if (q && !(r.Company || '').toLowerCase().includes(q)) return false;
    return true;
  });
}

function renderMarkers(rows) {
  markersLayer.clearLayers();
  const filtered = applyFilters(rows);

  let missing = 0, plotted = 0;
  filtered.forEach(r => {
    const coord = resolveCity(r.City);
    if (!coord) { missing++; return; }
    const m = L.circleMarker([coord.lat, coord.lon], {
      radius: 6, color: STATUS_COLOR(r.Status),
      fillColor: STATUS_COLOR(r.Status), fillOpacity: 0.9, weight: 1
    }).bindPopup(companyPopup(r, coord));
    markersLayer.addLayer(m);
    plotted++;
  });

  console.info(`Plotted: ${plotted}, missing coords: ${missing}`);
}

// --- Legend ---
const legend = L.control({position: 'bottomright'});
legend.onAdd = function() {
  const div = L.DomUtil.create('div', 'legend');
  div.innerHTML = `<div><strong>Status legend</strong></div>`;
  Object.entries(STATUS_COLORS).forEach(([label, clr]) => {
    const item = document.createElement('div'); item.className = 'item';
    item.innerHTML = `<span class="swatch" style="background:${clr}"></span>${label}`;
    div.appendChild(item);
  });
  div.innerHTML += `<div class="attribution" style="margin-top:.5rem;">Basemap: © OpenStreetMap contributors</div>`;
  return div;
};
legend.addTo(map);

// --- Events ---
[statusFilterEl, categoryFilterEl, cityFilterEl, stateFilterEl, pocFilterEl, gpFilterEl, yocFilterEl]
  .forEach(el => el.addEventListener('change', () => renderMarkers(ROWS_CACHE)));
searchEl.addEventListener('input', () => renderMarkers(ROWS_CACHE));

// --- Init ---
(async function init() {
  await loadCityIndex();
  const rows = await loadExcelRows(); // SheetJS client-side import pattern. [1](https://github.com/recurze/IndianCities/blob/master/data/latlong_location.csv)
  ROWS_CACHE = rows;
  populateFilters(rows);
  renderMarkers(rows);
})();
