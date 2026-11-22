import math
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple
import numpy as np

MU_MOON = 4902.800066  # km^3 / s^2
R_MOON = 1737.4        # km


@dataclass
class OrbitalElements:
    semi_major_axis_km: float      # a (km)
    eccentricity: float            # e (0 <= e < 1)
    inclination_deg: float         # i (deg)
    raan_deg: float                # Omega (deg)
    arg_periapsis_deg: float       # omega (deg)
    mean_anomaly_deg: float        # M0 at epoch (deg)


@dataclass
class Spacecraft:
    id: str
    name: str
    agency: str
    mission_type: str              # Relay, Lander, Science, Debris, Gateway
    elements: OrbitalElements
    mascon_sensitivity: float      # Perturbation factor for low polar orbits
    fuel_budget_ms: float          # Remaining delta-v budget (m/s)
    status: str = "NOMINAL"        # NOMINAL, WATCH, ELEVATED, CLEARED
    delta_v_applied_ms: List[float] = field(default_factory=lambda: [0.0, 0.0, 0.0])

    @property
    def altitude_periapsis_km(self) -> float:
        return self.elements.semi_major_axis_km * (1.0 - self.elements.eccentricity) - R_MOON

    @property
    def altitude_apoapsis_km(self) -> float:
        return self.elements.semi_major_axis_km * (1.0 + self.elements.eccentricity) - R_MOON

    @property
    def orbital_period_min(self) -> float:
        n = math.sqrt(MU_MOON / (self.elements.semi_major_axis_km ** 3))
        return (2.0 * math.pi / n) / 60.0


def _solve_kepler(M: float, e: float, tol: float = 1e-10) -> float:
    """Solve M = E - e*sin(E) for eccentric anomaly E."""
    M = M % (2.0 * math.pi)
    E = M if e < 0.8 else math.pi
    for _ in range(50):
        f = E - e * math.sin(E) - M
        fp = 1.0 - e * math.cos(E)
        dE = -f / fp
        E += dE
        if abs(dE) < tol:
            break
    return E


def elements_to_state(el: OrbitalElements, t_sec: float = 0.0, mascon_factor: float = 0.0) -> Tuple[np.ndarray, np.ndarray]:
    """Convert Keplerian elements + time offset into lunar-centered inertial [r, v]."""
    a = el.semi_major_axis_km
    e = min(max(el.eccentricity, 0.0), 0.95)
    inc = math.radians(el.inclination_deg)
    raan = math.radians(el.raan_deg)
    argp = math.radians(el.arg_periapsis_deg)
    M0 = math.radians(el.mean_anomaly_deg)

    n = math.sqrt(MU_MOON / (a ** 3))
    # Lunar mascon J2/J3-like secular nodal and apsidal drift approximation
    mascon_drift = mascon_factor * 1.4e-6 * ((R_MOON / a) ** 3.5)
    raan_t = raan - mascon_drift * math.cos(inc) * t_sec
    argp_t = argp + 0.5 * mascon_drift * (5.0 * (math.cos(inc) ** 2) - 1.0) * t_sec

    M = M0 + n * t_sec
    E = _solve_kepler(M, e)

    nu = 2.0 * math.atan2(
        math.sqrt(1.0 + e) * math.sin(E / 2.0),
        math.sqrt(1.0 - e) * math.cos(E / 2.0),
    )
    r_norm = a * (1.0 - e * math.cos(E))

    # Perifocal position and velocity
    p = a * (1.0 - e ** 2)
    h = math.sqrt(MU_MOON * p)
    r_pf = np.array([r_norm * math.cos(nu), r_norm * math.sin(nu), 0.0])
    v_pf = np.array([
        -(MU_MOON / h) * math.sin(nu),
        (MU_MOON / h) * (e + math.cos(nu)),
        0.0,
    ])

    # Rotation matrix perifocal -> inertial (3-1-3)
    cO, sO = math.cos(raan_t), math.sin(raan_t)
    ci, si = math.cos(inc), math.sin(inc)
    cw, sw = math.cos(argp_t), math.sin(argp_t)

    R = np.array([
        [cO * cw - sO * sw * ci, -cO * sw - sO * cw * ci, sO * si],
        [sO * cw + cO * sw * ci, -sO * sw + cO * cw * ci, -cO * si],
        [sw * si,                 cw * si,                ci],
    ])

    return R @ r_pf, R @ v_pf


def state_to_elements(r: np.ndarray, v: np.ndarray) -> OrbitalElements:
    """Convert inertial state vectors [r, v] back into Keplerian elements."""
    r_norm = np.linalg.norm(r)
    v_norm = np.linalg.norm(v)
    h_vec = np.cross(r, v)
    h = np.linalg.norm(h_vec)

    inc = math.degrees(math.acos(np.clip(h_vec[2] / h, -1.0, 1.0)))
    k_vec = np.array([0.0, 0.0, 1.0])
    n_vec = np.cross(k_vec, h_vec)
    n_norm = np.linalg.norm(n_vec)

    e_vec = ((v_norm ** 2 - MU_MOON / r_norm) * r - np.dot(r, v) * v) / MU_MOON
    e = float(np.linalg.norm(e_vec))

    energy = (v_norm ** 2) / 2.0 - MU_MOON / r_norm
    a = -MU_MOON / (2.0 * energy) if abs(energy) > 1e-9 else R_MOON + 500.0
    a = max(a, R_MOON + 35.0)

    if n_norm > 1e-8:
        raan = math.degrees(math.acos(np.clip(n_vec[0] / n_norm, -1.0, 1.0)))
        if n_vec[1] < 0:
            raan = 360.0 - raan
    else:
        raan = 0.0

    if n_norm > 1e-8 and e > 1e-8:
        argp = math.degrees(math.acos(np.clip(np.dot(n_vec, e_vec) / (n_norm * e), -1.0, 1.0)))
        if e_vec[2] < 0:
            argp = 360.0 - argp
    else:
        argp = 0.0

    if e > 1e-8:
        nu = math.acos(np.clip(np.dot(e_vec, r) / (e * r_norm), -1.0, 1.0))
        if np.dot(r, v) < 0:
            nu = 2.0 * math.pi - nu
        E = 2.0 * math.atan2(math.sqrt(1.0 - e) * math.sin(nu / 2.0), math.sqrt(1.0 + e) * math.cos(nu / 2.0))
        M = math.degrees((E - e * math.sin(E)) % (2.0 * math.pi))
    else:
        M = 0.0

    return OrbitalElements(
        semi_major_axis_km=round(float(a), 3),
        eccentricity=round(min(e, 0.92), 5),
        inclination_deg=round(inc, 3),
        raan_deg=round(raan, 3),
        arg_periapsis_deg=round(argp, 3),
        mean_anomaly_deg=round(M, 3),
    )


class CislunarOrbitalMonitor:
    """Manages cislunar spacecraft catalog, propagation, conjunction screening, and delta-v maneuvers."""

    def __init__(self):
        self.sim_time_sec: float = 0.0
        self.spacecraft: Dict[str, Spacecraft] = {}
        self.reset_catalog()

    def reset_catalog(self) -> None:
        self.sim_time_sec = 0.0
        # Seeded catalog engineered to produce realistic Nominal, Moderate Watch, and Elevated Conjunction events
        catalog = [
            Spacecraft(
                id="SLN-01",
                name="SELENESCAPE RELAY-1",
                agency="SELENESCAPE",
                mission_type="Comms Relay",
                elements=OrbitalElements(2180.0, 0.025, 86.4, 42.0, 15.0, 10.0),
                mascon_sensitivity=1.35,
                fuel_budget_ms=145.0,
            ),
            Spacecraft(
                id="ART-04",
                name="ARTEMIS PATHFINDER",
                agency="NASA / Intl",
                mission_type="Lunar Gateway",
                elements=OrbitalElements(2182.0, 0.028, 86.9, 42.3, 16.0, 10.6),
                mascon_sensitivity=1.40,
                fuel_budget_ms=110.0,
            ),
            Spacecraft(
                id="LRO-02",
                name="LRO RECON-B",
                agency="NASA",
                mission_type="Orbiter",
                elements=OrbitalElements(1890.0, 0.015, 89.2, 130.0, 75.0, 140.0),
                mascon_sensitivity=1.85,
                fuel_budget_ms=64.0,
            ),
            Spacecraft(
                id="CHY-03",
                name="CHANDRAYAAN-ORBITER",
                agency="ISRO",
                mission_type="Science",
                elements=OrbitalElements(1894.0, 0.018, 88.5, 131.2, 74.0, 141.5),
                mascon_sensitivity=1.75,
                fuel_budget_ms=82.0,
            ),
            Spacecraft(
                id="KPL-05",
                name="KPLO DANURI-2",
                agency="KARI",
                mission_type="Mapper",
                elements=OrbitalElements(2450.0, 0.14, 54.0, 215.0, 110.0, 260.0),
                mascon_sensitivity=0.80,
                fuel_budget_ms=95.0,
            ),
            Spacecraft(
                id="DEB-88",
                name=" spent-stage 2024-09B",
                agency="Uncontrolled",
                mission_type="Debris",
                elements=OrbitalElements(2050.0, 0.09, 63.5, 300.0, 200.0, 45.0),
                mascon_sensitivity=1.55,
                fuel_budget_ms=0.0,
            ),
        ]
        self.spacecraft = {sc.id: sc for sc in catalog}
        self._refresh_statuses()

    def advance_time(self, dt_sec: float) -> None:
        self.sim_time_sec += dt_sec
        self._refresh_statuses()

    def get_trajectory(self, sc: Spacecraft, steps: int = 120) -> List[List[float]]:
        period_sec = sc.orbital_period_min * 60.0
        pts = []
        for idx in range(steps + 1):
            t = self.sim_time_sec + (idx / steps) * period_sec
            r, _ = elements_to_state(sc.elements, t, sc.mascon_sensitivity)
            pts.append([round(float(r[0]), 2), round(float(r[1]), 2), round(float(r[2]), 2)])
        return pts

    def detect_conjunctions(self, horizon_sec: float = 14400.0, step_sec: float = 60.0) -> List[dict]:
        """Screen all spacecraft pairs over horizon_sec (default 4 hours) for closest approach."""
        ids = list(self.spacecraft.keys())
        alerts = []
        times = np.arange(self.sim_time_sec, self.sim_time_sec + horizon_sec + step_sec, step_sec)

        # Precompute trajectories
        positions: Dict[str, np.ndarray] = {}
        velocities: Dict[str, np.ndarray] = {}
        for sc_id, sc in self.spacecraft.items():
            pos_list = []
            vel_list = []
            for t in times:
                r, v = elements_to_state(sc.elements, float(t), sc.mascon_sensitivity)
                pos_list.append(r)
                vel_list.append(v)
            positions[sc_id] = np.array(pos_list)
            velocities[sc_id] = np.array(vel_list)

        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                id_a, id_b = ids[i], ids[j]
                sc_a, sc_b = self.spacecraft[id_a], self.spacecraft[id_b]
                diff = positions[id_a] - positions[id_b]
                dists = np.linalg.norm(diff, axis=1)
                min_idx = int(np.argmin(dists))
                min_dist_km = float(dists[min_idx])

                if min_dist_km < 45.0:
                    rel_vel = float(np.linalg.norm(velocities[id_a][min_idx] - velocities[id_b][min_idx]))
                    tca_sec = float(times[min_idx] - self.sim_time_sec)
                    severity = "ELEVATED" if min_dist_km < 12.0 else "WATCH"
                    # Collision probability heuristic (Pc) based on miss distance & covariance radius
                    cov_km = 2.2
                    pc = math.exp(-0.5 * ((min_dist_km / cov_km) ** 2)) * 0.042
                    cpa_point = ((positions[id_a][min_idx] + positions[id_b][min_idx]) * 0.5).tolist()

                    alerts.append({
                        "conjunction_id": f"CNJ-{id_a}-{id_b}",
                        "primary_id": id_a,
                        "primary_name": sc_a.name,
                        "secondary_id": id_b,
                        "secondary_name": sc_b.name,
                        "severity": severity,
                        "miss_distance_km": round(min_dist_km, 3),
                        "relative_velocity_kms": round(rel_vel, 3),
                        "tca_minutes": round(tca_sec / 60.0, 1),
                        "collision_probability": round(pc, 6),
                        "cpa_position_km": [round(float(x), 2) for x in cpa_point],
                    })

        alerts.sort(key=lambda x: x["miss_distance_km"])
        return alerts

    def _refresh_statuses(self) -> List[dict]:
        alerts = self.detect_conjunctions()
        for sc in self.spacecraft.values():
            if sc.status != "CLEARED":
                sc.status = "NOMINAL"

        for alert in alerts:
            for sc_id in (alert["primary_id"], alert["secondary_id"]):
                sc = self.spacecraft[sc_id]
                if alert["severity"] == "ELEVATED":
                    sc.status = "ELEVATED"
                elif alert["severity"] == "WATCH" and sc.status != "ELEVATED":
                    sc.status = "WATCH"
        return alerts

    def simulate_maneuver(
        self,
        spacecraft_id: str,
        dv_prograde_ms: float,
        dv_normal_ms: float,
        dv_radial_ms: float,
        apply_maneuver: bool = False,
    ) -> dict:
        if spacecraft_id not in self.spacecraft:
            raise KeyError(f"Unknown spacecraft: {spacecraft_id}")

        sc = self.spacecraft[spacecraft_id]
        dv_mag_ms = math.sqrt(dv_prograde_ms ** 2 + dv_normal_ms ** 2 + dv_radial_ms ** 2)
        if dv_mag_ms > sc.fuel_budget_ms:
            raise ValueError(f"Requested delta-v ({dv_mag_ms:.2f} m/s) exceeds remaining fuel budget ({sc.fuel_budget_ms:.2f} m/s).")

        # Current state at sim_time_sec
        r, v = elements_to_state(sc.elements, self.sim_time_sec, sc.mascon_sensitivity)
        v_hat = v / np.linalg.norm(v)
        h_vec = np.cross(r, v)
        n_hat = h_vec / np.linalg.norm(h_vec)
        r_hat = np.cross(v_hat, n_hat)

        # Convert m/s to km/s
        dv_vec_kms = (
            (dv_prograde_ms / 1000.0) * v_hat
            + (dv_normal_ms / 1000.0) * n_hat
            + (dv_radial_ms / 1000.0) * r_hat
        )
        new_v = v + dv_vec_kms
        new_elements = state_to_elements(r, new_v)

        # Temporarily evaluate new conjunctions
        old_elements = sc.elements
        sc.elements = new_elements
        new_alerts = self.detect_conjunctions()
        involved = [a for a in new_alerts if spacecraft_id in (a["primary_id"], a["secondary_id"])]
        min_miss = min([a["miss_distance_km"] for a in involved], default=125.0)
        cleared = len(involved) == 0 or min_miss >= 25.0

        preview_sc = Spacecraft(
            id=sc.id,
            name=sc.name,
            agency=sc.agency,
            mission_type=sc.mission_type,
            elements=new_elements,
            mascon_sensitivity=sc.mascon_sensitivity,
            fuel_budget_ms=sc.fuel_budget_ms - dv_mag_ms,
        )
        preview_trajectory = self.get_trajectory(preview_sc)

        if apply_maneuver:
            sc.fuel_budget_ms = round(sc.fuel_budget_ms - dv_mag_ms, 2)
            sc.delta_v_applied_ms = [
                round(sc.delta_v_applied_ms[0] + dv_prograde_ms, 2),
                round(sc.delta_v_applied_ms[1] + dv_normal_ms, 2),
                round(sc.delta_v_applied_ms[2] + dv_radial_ms, 2),
            ]
            if cleared and dv_mag_ms > 0.05:
                sc.status = "CLEARED"
            self._refresh_statuses()
            if cleared and dv_mag_ms > 0.05:
                sc.status = "CLEARED"
        else:
            sc.elements = old_elements

        return {
            "spacecraft_id": spacecraft_id,
            "applied": apply_maneuver,
            "total_dv_ms": round(dv_mag_ms, 3),
            "remaining_fuel_ms": round(sc.fuel_budget_ms if apply_maneuver else sc.fuel_budget_ms - dv_mag_ms, 2),
            "predicted_min_miss_km": round(min_miss, 3),
            "conjunction_cleared": cleared,
            "new_periapsis_km": round(preview_sc.altitude_periapsis_km, 2),
            "new_apoapsis_km": round(preview_sc.altitude_apoapsis_km, 2),
            "new_inclination_deg": new_elements.inclination_deg,
            "preview_trajectory_km": preview_trajectory,
        }

    def get_snapshot(self) -> dict:
        alerts = self._refresh_statuses()
        objects = []
        for sc in self.spacecraft.values():
            r, v = elements_to_state(sc.elements, self.sim_time_sec, sc.mascon_sensitivity)
            objects.append({
                "id": sc.id,
                "name": sc.name,
                "agency": sc.agency,
                "mission_type": sc.mission_type,
                "status": sc.status,
                "position_km": [round(float(x), 2) for x in r],
                "velocity_kms": round(float(np.linalg.norm(v)), 3),
                "altitude_km": round(float(np.linalg.norm(r)) - R_MOON, 2),
                "periapsis_km": round(sc.altitude_periapsis_km, 2),
                "apoapsis_km": round(sc.altitude_apoapsis_km, 2),
                "inclination_deg": sc.elements.inclination_deg,
                "eccentricity": sc.elements.eccentricity,
                "period_min": round(sc.orbital_period_min, 1),
                "mascon_sensitivity": sc.mascon_sensitivity,
                "fuel_budget_ms": sc.fuel_budget_ms,
                "delta_v_applied_ms": sc.delta_v_applied_ms,
                "trajectory_km": self.get_trajectory(sc),
            })

        return {
            "sim_time_sec": round(self.sim_time_sec, 1),
            "moon_radius_km": R_MOON,
            "objects": objects,
            "conjunctions": alerts,
        }