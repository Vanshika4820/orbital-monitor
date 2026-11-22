from pathlib import Path
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .orbital_engine import CislunarOrbitalMonitor

app = FastAPI(title="SELENESCAPE Orbital Safety Monitor", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

monitor = CislunarOrbitalMonitor()

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"


class ManeuverRequest(BaseModel):
    spacecraft_id: str
    dv_prograde_ms: float = Field(0.0, ge=-50.0, le=50.0)
    dv_normal_ms: float = Field(0.0, ge=-50.0, le=50.0)
    dv_radial_ms: float = Field(0.0, ge=-50.0, le=50.0)
    apply_maneuver: bool = False


class StepRequest(BaseModel):
    dt_sec: float = Field(60.0, gt=0.0, le=3600.0)


@app.get("/api/health")
def health():
    return {"status": "online", "service": "SELENESCAPE Orbital Safety Monitor"}


@app.get("/api/orbital/state")
def get_orbital_state():
    return monitor.get_snapshot()


@app.post("/api/orbital/step")
def step_simulation(req: StepRequest):
    monitor.advance_time(req.dt_sec)
    return monitor.get_snapshot()


@app.post("/api/orbital/maneuver")
def simulate_or_apply_maneuver(req: ManeuverRequest):
    try:
        result = monitor.simulate_maneuver(
            spacecraft_id=req.spacecraft_id,
            dv_prograde_ms=req.dv_prograde_ms,
            dv_normal_ms=req.dv_normal_ms,
            dv_radial_ms=req.dv_radial_ms,
            apply_maneuver=req.apply_maneuver,
        )
        return {
            "maneuver": result,
            "state": monitor.get_snapshot(),
        }
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/orbital/reset")
def reset_simulation():
    monitor.reset_catalog()
    return monitor.get_snapshot()


app.mount("/css", StaticFiles(directory=FRONTEND_DIR / "css"), name="css")
app.mount("/js", StaticFiles(directory=FRONTEND_DIR / "js"), name="js")
app.mount("/assets", StaticFiles(directory=FRONTEND_DIR / "assets"), name="assets")


@app.get("/")
def serve_index():
    return FileResponse(FRONTEND_DIR / "index.html")