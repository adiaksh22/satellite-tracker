from math import degrees, pi

import numpy as np
from skyfield.api import wgs84
from .tle import ts

R_EARTH_KM = 6378.135



def position(sat) -> dict:
    """Where the satellite is right now."""
    # current geo centric position for a sat
    geo = sat.at(ts.now())
    # converts 3d position to lat, lon, alt
    pos = wgs84.geographic_position_of(geo)
    # geo.velocity.km_per_s is a 3d vector of velocity in km/s [vx, vy, vz]
    # np.linalg.norm computes the magnitude (length) of that vector, which is the speed in km/s
    speed = float(np.linalg.norm(geo.velocity.km_per_s))
    return {
        "lat": float(pos.latitude.degrees),
        "lon": float(pos.longitude.degrees),
        "alt_km": float(pos.elevation.km),
        "speed_kms": speed,
    }



# look 95 min ahead (one LEO lap) with a point every 30s
def ground_track(sat, minutes: int = 95, step_s: int = 30) -> list:
    """Path over the Earth's surface as a list of line segments."""
    t0 = ts.now()
    # 95 x 60 = 5700 / 30 = 190 points for one LEO lap
    n = minutes * 60 // step_s
    times = ts.tt_jd(t0.tt + np.arange(n) * step_s / 86400)
    sub = wgs84.subpoint_of(sat.at(times))
    lats, lons = sub.latitude.degrees, sub.longitude.degrees

    # Split the line wherever it wraps across the ±180° meridian,
    # otherwise the map draws a line straight across the whole world.
    segments, current = [], [[float(lats[0]), float(lons[0])]]
    for i in range(1, n):
        if abs(lons[i] - lons[i - 1]) > 180:
            segments.append(current)
            current = []
        current.append([float(lats[i]), float(lons[i])])
    segments.append(current)
    return segments



def orbital_params(sat) -> dict:
    """Orbital elements, converted from the TLE into friendly units."""
    m = sat.model
    a_km = m.a * R_EARTH_KM  # semi-major axis
    return {
        "name": sat.name,
        "norad_id": int(m.satnum),
        "inclination_deg": degrees(m.inclo),
        "eccentricity": m.ecco,
        "period_min": 2 * pi / m.no_kozai,  # no_kozai is radians per minute
        # closest point to Earth minus Earth's radius to get the surface
        "perigee_km": a_km * (1 - m.ecco) - R_EARTH_KM,
        # farthest point to Earth
        "apogee_km": a_km * (1 + m.ecco) - R_EARTH_KM,
        "tle_epoch": sat.epoch.utc_iso(),
    }



def passes(sat, lat: float, lon: float, days: int = 5, min_elev: float = 10) -> list:
    """Upcoming passes above `min_elev` degrees for an observer at lat/lon."""
    observer = wgs84.latlon(lat, lon)
    t0 = ts.now()
    t1 = ts.tt_jd(t0.tt + days)
    times, events = sat.find_events(observer, t0, t1, altitude_degrees=min_elev)

    out, current = [], {}

    for t, event in zip(times, events):
        if event == 0:  # rise
            current = {"rise": t.utc_iso(), "_rise_tt": t.tt}
        elif event == 1 and current:  # highest point
            alt, _, _ = (sat - observer).at(t).altaz()
            current["max_elev_deg"] = round(float(alt.degrees), 1)
            current["peak"] = t.utc_iso()
        elif event == 2 and "peak" in current:  # set
            current["set"] = t.utc_iso()
            current["duration_min"] = round(float((t.tt - current.pop("_rise_tt")) * 1440), 1)           
            out.append(current)
            current = {}
    return out