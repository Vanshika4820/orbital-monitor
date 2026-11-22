export const OrbitalAPI = {
  async getState() {
    const res = await fetch("/api/orbital/state");
    if (!res.ok) throw new Error("Failed to fetch orbital state");
    return res.json();
  },

  async stepSimulation(dtSec = 60) {
    const res = await fetch("/api/orbital/step", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dt_sec: dtSec }),
    });
    if (!res.ok) throw new Error("Failed to step simulation");
    return res.json();
  },

  async runManeuver({ spacecraftId, prograde, normal, radial, apply = false }) {
    const res = await fetch("/api/orbital/maneuver", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        spacecraft_id: spacecraftId,
        dv_prograde_ms: prograde,
        dv_normal_ms: normal,
        dv_radial_ms: radial,
        apply_maneuver: apply,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Maneuver calculation error");
    return data;
  },

  async resetEpoch() {
    const res = await fetch("/api/orbital/reset", { method: "POST" });
    if (!res.ok) throw new Error("Failed to reset simulation");
    return res.json();
  },
};