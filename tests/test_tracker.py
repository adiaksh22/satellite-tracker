from fastapi.testclient import TestClient
from skyfield.api import EarthSatellite

from app import main, tracker
from app.tle import ts

# A fixed ISS TLE, so tests don't depend on the network or today's data
ISS_TLE = (
    "1 25544U 98067A   14020.93268519  .00009878  00000-0  18200-3 0  5082",
    "2 25544  51.6498 109.4756 0003572  55.9686 274.8005 15.49815350868473",
)
iss = EarthSatellite(*ISS_TLE, "ISS (ZARYA)", ts)
client = TestClient(main.app)


def test_orbital_params():
    p = tracker.orbital_params(iss)
    assert p["norad_id"] == 25544
    assert 51 < p["inclination_deg"] < 52
    assert 92 < p["period_min"] < 94
    assert p["perigee_km"] < p["apogee_km"]


def test_groups_endpoint():
    r = client.get("/api/groups")
    assert r.status_code == 200
    assert "stations" in r.json()


def test_unknown_group_returns_400():
    r = client.get("/api/satellites?group=nonsense")
    assert r.status_code == 400


def test_missing_satellite_returns_404(monkeypatch):
    monkeypatch.setattr(main, "load_group", lambda group: {})
    r = client.get("/api/satellites/99999/track?group=stations")
    assert r.status_code == 404


def test_invalid_latitude_rejected(monkeypatch):
    monkeypatch.setattr(main, "load_group", lambda group: {25544: iss})
    r = client.get("/api/satellites/25544/passes?lat=999&lon=0&group=stations")
    assert r.status_code == 422