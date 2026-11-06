const viewer = new Cesium.Viewer("globe", {
  baseLayer: new Cesium.ImageryLayer(
    new Cesium.OpenStreetMapImageryProvider({ url: "https://tile.openstreetmap.org/" })
  ),
  baseLayerPicker: false,   // the picker would try to load Ion layers
  geocoder: false,
  homeButton: false,
  sceneModePicker: false,
  navigationHelpButton: false,
  animation: false,
  timeline: false,
  fullscreenButton: false,
  infoBox: false,           // we use our own sidebar
});

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const debounce = (fn, ms = 300) => {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};

const MAX_SHOWN = 200;
const byId = new Map();     // norad_id -> latest satellite data
let trackEntities = [];
let selectedId = null;
let reqCounter = 0;

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

const toPos = (s) => Cesium.Cartesian3.fromDegrees(s.lon, s.lat, s.alt_km * 1000);

async function init() {
  const groups = await getJSON("/api/groups");
  $("group").innerHTML = groups.map((g) => `<option>${esc(g)}</option>`).join("");

  const onFilter = debounce(() => load(true));
  ["q", "minIncl"].forEach((id) => $(id).addEventListener("input", onFilter));
  $("group").addEventListener("change", () => { clearSelection(); load(true); });

  // clicking a point on the globe selects that satellite
  viewer.selectedEntityChanged.addEventListener((entity) => {
    if (entity && byId.has(Number(entity.id))) select(Number(entity.id), false);
  });

  await load(true);
  if (byId.has(25544)) select(25544, true);
  setInterval(() => load(false), 5000);
}

async function load(rebuildList) {
  const id = ++reqCounter;
  const params = new URLSearchParams({
    group: $("group").value,
    q: $("q").value,
    min_incl: $("minIncl").value || 0,
  });

  let data;
  try {
    data = await getJSON(`/api/satellites?${params}`);
  } catch (e) {
    $("status").textContent = "Error: " + e.message;
    return;
  }
  if (id !== reqCounter) return;   // a newer request already won

  const shown = data.slice(0, MAX_SHOWN);
  const keep = new Set(shown.map((s) => s.norad_id));

  // remove satellites that no longer match the filters
  for (const nid of [...byId.keys()]) {
    if (!keep.has(nid)) {
      viewer.entities.removeById(String(nid));
      byId.delete(nid);
    }
  }
  // add new satellites, move existing ones
  for (const s of shown) {
    byId.set(s.norad_id, s);
    const existing = viewer.entities.getById(String(s.norad_id));
    if (existing) {
      existing.position = toPos(s);
    } else {
      viewer.entities.add({
        id: String(s.norad_id),
        name: s.name,
        position: toPos(s),
        point: {
          pixelSize: 6,
          color: Cesium.Color.CYAN,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 1,
        },
        label: {
          text: s.name,
          font: "13px sans-serif",
          pixelOffset: new Cesium.Cartesian2(0, -16),
          show: false,                 // only shown for the selected satellite
        },
      });
    }
  }

  if (rebuildList) renderList(shown);
  if (selectedId && byId.has(selectedId)) showInfo(byId.get(selectedId));
  $("status").textContent =
    `${data.length} satellites` + (data.length > MAX_SHOWN ? ` (showing ${MAX_SHOWN})` : "");
}

function renderList(shown) {
  $("list").innerHTML = "";
  shown.forEach((s) => {
    const li = document.createElement("li");
    li.textContent = s.name;
    li.dataset.id = s.norad_id;
    if (s.norad_id === selectedId) li.className = "active";
    li.onclick = () => select(s.norad_id, true);
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

function clearTrack() {
  trackEntities.forEach((e) => viewer.entities.remove(e));
  trackEntities = [];
}

function clearSelection() {
  selectedId = null;
  clearTrack();
  viewer.selectedEntity = undefined;
  $("info").textContent = "Click a satellite.";
}

async function select(id, flyTo) {
  const s = byId.get(id);
  if (!s) return;
  selectedId = id;
  showInfo(s);

  // highlight: label on for the selected one, off for the rest
  viewer.entities.values.forEach((e) => { if (e.label) e.label.show = (e.id === String(id)); });
  document.querySelectorAll("#list li").forEach((li) =>
    li.classList.toggle("active", Number(li.dataset.id) === id));

  const entity = viewer.entities.getById(String(id));
  if (flyTo && entity) {
    viewer.selectedEntity = entity;
    viewer.flyTo(entity, {
      duration: 1.5,
      offset: new Cesium.HeadingPitchRange(0, -Cesium.Math.PI_OVER_TWO, 9000000),
    });
  }

  clearTrack();
  try {
    const segs = await getJSON(`/api/satellites/${id}/track?group=${$("group").value}`);
    if (selectedId !== id) return;
    // API gives [lat, lon]; Cesium wants lon, lat, height (meters).
    // Drawn at the satellite's altitude so the line connects to the marker.
    segs.forEach((seg) => {
      if (seg.length < 2) return;
      const flat = seg.flatMap(([lat, lon]) => [lon, lat, s.alt_km * 1000]);
      trackEntities.push(viewer.entities.add({
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArrayHeights(flat),
          width: 2,
          material: Cesium.Color.ORANGE,
        },
      }));
    });
  } catch (e) {
    console.error(e);
  }
}

init();