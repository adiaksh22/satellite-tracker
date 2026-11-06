const map = L.map("map", { worldCopyJump: true }).setView([20, 0], 2);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "© OpenStreetMap contributors",
  maxZoom: 18,
}).addTo(map);

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const debounce = (fn, ms = 300) => {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};

const MAX_SHOWN = 200;           // cap markers so big groups stay fast
const trackLayer = L.layerGroup().addTo(map);
let sats = [];                   // satellites matching the current filters
let markers = {};                // norad_id -> Leaflet marker
let selectedId = null;
let reqCounter = 0;              // used to ignore out-of-date responses

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

async function init() {
  const groups = await getJSON("/api/groups");
  $("group").innerHTML = groups.map((g) => `<option>${esc(g)}</option>`).join("");

  const onFilter = debounce(() => load(true));
  ["q", "minIncl", "maxPeriod"].forEach((id) => $(id).addEventListener("input", onFilter));
  $("group").addEventListener("change", () => { clearSelection(); load(true); });
  $("loc").addEventListener("change", () => { if (selectedId) loadPasses(); });

  await load(true);
  const iss = sats.find((s) => s.norad_id === 25544);
  if (iss) select(iss);
  setInterval(() => load(false), 5000);   // refresh positions only
}

async function load(rebuildList) {
  const id = ++reqCounter;
  const params = new URLSearchParams({
    group: $("group").value,
    q: $("q").value,
    min_incl: $("minIncl").value || 0,
  });
  if ($("maxPeriod").value) params.set("max_period", $("maxPeriod").value);

  let data;
  try {
    data = await getJSON(`/api/satellites?${params}`);
  } catch (e) {
    $("status").textContent = "Error: " + e.message;
    return;
  }
  if (id !== reqCounter) return;          // a newer request already won

  sats = data;
  syncMarkers();
  if (rebuildList) renderList();
  const cur = sats.find((s) => s.norad_id === selectedId);
  if (cur) showInfo(cur);
  $("status").textContent =
    `${sats.length} satellites` + (sats.length > MAX_SHOWN ? ` (showing ${MAX_SHOWN})` : "");
}

function syncMarkers() {
  const shown = sats.slice(0, MAX_SHOWN);
  const keep = new Set(shown.map((s) => s.norad_id));

  for (const id of Object.keys(markers)) {
    if (!keep.has(Number(id))) { map.removeLayer(markers[id]); delete markers[id]; }
  }
  for (const s of shown) {
    let m = markers[s.norad_id];
    if (m) {
      m.setLatLng([s.lat, s.lon]);
    } else {
      m = L.circleMarker([s.lat, s.lon], { radius: 4, weight: 1, fillOpacity: 0.8 }).addTo(map);
      m.bindTooltip(esc(s.name));
      m.on("click", () => select(sats.find((x) => x.norad_id === s.norad_id)));
      markers[s.norad_id] = m;
    }
  }
  styleMarkers();
}

function styleMarkers() {
  for (const [id, m] of Object.entries(markers)) {
    const sel = Number(id) === selectedId;
    m.setStyle({ color: sel ? "#f80" : "#08f", fillColor: sel ? "#f80" : "#4af" });
    m.setRadius(sel ? 7 : 4);
    if (sel) m.bringToFront();
  }
}

function renderList() {
  $("list").innerHTML = "";
  sats.slice(0, MAX_SHOWN).forEach((s) => {
    const li = document.createElement("li");
    li.textContent = s.name;
    li.dataset.id = s.norad_id;
    if (s.norad_id === selectedId) li.className = "active";
    li.onclick = () => { select(s); map.panTo([s.lat, s.lon]); };
    $("list").appendChild(li);
  });
}

function showInfo(s) {
  $("info").innerHTML = `<b>${esc(s.name)}</b> (#${s.norad_id})<br>
    Inclination: ${s.inclination_deg.toFixed(2)}°<br>
    Eccentricity: ${s.eccentricity.toFixed(5)}<br>
    Period: ${s.period_min.toFixed(1)} min<br>
    Perigee / apogee: ${s.perigee_km.toFixed(0)} / ${s.apogee_km.toFixed(0)} km<br>
    Now: ${s.alt_km.toFixed(0)} km up, ${s.speed_kms.toFixed(2)} km/s<br>
    TLE epoch: ${esc(s.tle_epoch)}`;
}

function clearSelection() {
  selectedId = null;
  trackLayer.clearLayers();
  $("info").textContent = "Click a satellite.";
  $("passes").innerHTML = "";
}

async function select(s) {
  if (!s) return;
  selectedId = s.norad_id;
  styleMarkers();
  showInfo(s);
  document.querySelectorAll("#list li").forEach((li) =>
    li.classList.toggle("active", Number(li.dataset.id) === selectedId));

  trackLayer.clearLayers();
  try {
    const segs = await getJSON(`/api/satellites/${s.norad_id}/track?group=${$("group").value}`);
    if (selectedId !== s.norad_id) return;
    segs.forEach((seg) => L.polyline(seg, { color: "orange", weight: 2 }).addTo(trackLayer));
  } catch (e) {
    console.error(e);
  }
  loadPasses();
}

async function loadPasses() {
  const parts = $("loc").value.split(",").map((x) => parseFloat(x.trim()));
  if (parts.length !== 2 || parts.some(isNaN)) {
    $("passes").innerHTML = "<li>Enter location as lat,lon</li>";
    return;
  }
  const [lat, lon] = parts;
  const id = selectedId;
  $("passes").innerHTML = "<li>Calculating…</li>";
  try {
    const ps = await getJSON(
      `/api/satellites/${id}/passes?group=${$("group").value}&lat=${lat}&lon=${lon}`);
    if (id !== selectedId) return;
    $("passes").innerHTML =
      ps.map((p) =>
        `<li>${new Date(p.rise).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}
         · max ${p.max_elev_deg}° · ${p.duration_min} min</li>`).join("")
      || "<li>None in the next 5 days</li>";
  } catch (e) {
    $("passes").innerHTML = "<li>Couldn't load passes</li>";
    console.error(e);
  }
}

init();