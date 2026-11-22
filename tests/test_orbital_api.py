from fastapi.testclient import TestClient
from backend.main import app

client = TestClient(app)


def test_health_and_state():
    res = client.get("/api/orbital/state")
    assert res.status_code == 200
    data = res.json()
    assert "objects" in data
    assert "conjunctions" in data
    assert len(data["objects"]) >= 4


def test_step_simulation():
    res = client.post("/api/orbital/step", json={"dt_sec": 120})
    assert res.status_code == 200
    data = res.json()
    assert data["sim_time_sec"] >= 120


def test_maneuver_preview_and_apply():
    preview = client.post(
        "/api/orbital/maneuver",
        json={
            "spacecraft_id": "SLN-01",
            "dv_prograde_ms": 4.0,
            "dv_normal_ms": 1.5,
            "dv_radial_ms": 0.0,
            "apply_maneuver": False,
        },
    )
    assert preview.status_code == 200
    pdata = preview.json()
    assert "maneuver" in pdata
    assert pdata["maneuver"]["total_dv_ms"] > 0

    applied = client.post(
        "/api/orbital/maneuver",
        json={
            "spacecraft_id": "SLN-01",
            "dv_prograde_ms": 4.0,
            "dv_normal_ms": 1.5,
            "dv_radial_ms": 0.0,
            "apply_maneuver": True,
        },
    )
    assert applied.status_code == 200


def test_reset_epoch():
    res = client.post("/api/orbital/reset")
    assert res.status_code == 200
    assert res.json()["sim_time_sec"] == 0.0