from pathlib import Path

import requests
from fastapi import FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles

from . import tracker
from .tle import GROUPS, load_group

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

app = FastAPI(title="Satellite Tracker")



def get_group(group: str) -> dict:
    """Load a satellite group, with clean errors instead of crashes."""
    if group not in GROUPS:
        raise HTTPException(400, f"Unknown group. Choose from: {GROUPS}")
    try:
        return load_group(group)
    except requests.RequestException:
        raise HTTPException(502, "Could not reach CelesTrak and no cached data exists")



def get_sat(norad: int, group: str):
    sat = get_group(group).get(norad)
    if sat is None:
        raise HTTPException(404, "Satellite not found in this group")
    return sat


@app.get("/api/groups")
def list_groups():
    return GROUPS


@app.get("/api/satellites")
def list_satellites(
    group: str = "stations",
    q: str = "",
    min_incl: float = 0,
    max_incl: float = 180,
    max_period: float = 100000,
):
    """Current position and orbital parameters, with filters."""
    out = []
    for sat in get_group(group).values():
        if q.lower() not in sat.name.lower():
            continue
        try:
            params = tracker.orbital_params(sat)
            if not (min_incl <= params["inclination_deg"] <= max_incl):
                continue
            if params["period_min"] > max_period:
                continue
            out.append({**params, **tracker.position(sat)})
        except Exception:
            continue  # skip satellites whose orbit cannot be computed (ex. decayed/bad data)
    return out



@app.get("/api/satellites/{norad}/track")
def ground_track(norad: int, group: str = "stations"):
    return tracker.ground_track(get_sat(norad, group))



@app.get("/api/satellites/{norad}/passes")
def upcoming_passes(
    norad: int,
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=180),
    group: str = "stations",
    days: int = Query(5, ge=1, le=10),
    min_elev: float = Query(10, ge=0, le=90),
):
    return tracker.passes(get_sat(norad, group), lat, lon, days, min_elev)



# Must be last: it catches every path that no API route matched.
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")