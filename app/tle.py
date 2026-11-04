import time
from pathlib import Path

import requests
from skyfield.api import EarthSatellite, load

ts = load.timescale()

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DATA_DIR.mkdir(exist_ok=True)

URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP={group}&FORMAT=tle"
MAX_AGE_S = 2 * 3600  # CelesTrak asks you not to fetch more than every ~2 hours
GROUPS = ["stations", "visual", "weather", "gps-ops", "science"]

# In-memory cache: group name -> {NORAD id: EarthSatellite}
_sats: dict[str, dict[int, EarthSatellite]] = {}

def _download(group: str, path: Path) -> None:
    resp = requests.get(URL.format(group=group), timeout=20)
    resp.raise_for_status()
    path.write_text(resp.text)

def _parse(path: Path) -> dict[int, EarthSatellite]:
    # reads file, split into lines, skip blank lines, remove right whitespace
    lines = [ln.rstrip() for ln in path.read_text().splitlines() if ln.strip()]
    sats = {}
    # TLE files come in groups of 3 lines (-2 ensures there are 2 more lines after i)
    for i in range(0, len(lines) - 2, 3):
        sat = EarthSatellite(lines[i + 1], lines[i + 2], lines[i].strip(), ts)
        sats[sat.model.satnum] = sat
    return sats

def load_group(group: str) -> dict[int, EarthSatellite]:
    path = DATA_DIR / f"{group}.tle"
    stale = not path.exists() or time.time() - path.stat().st_mtime > MAX_AGE_S

    if stale:
        try:
            _download(group, path)
            _sats.pop(group, None)  # force re-parse of the fresh file
        except requests.RequestException:
            if not path.exists():
                raise  # nothing cached to fall back on

    if group not in _sats:
        _sats[group] = _parse(path)
    return _sats[group]

# load_group("stations")
#   ├─ file missing or >2h old? → try download → clear memory cache
#   │      └─ download failed? → use old file, or error if none
#   └─ not in memory? → parse file into EarthSatellite objects
#   → return {NORAD id: satellite}