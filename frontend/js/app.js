import { OrbitalAPI } from "./api.js";
import { CislunarScene, initLidarHeroBanner } from "./moon_scene.js";

class OrbitalSafetyApp {
  constructor() {
    this.state = null;
    this.selectedId = "SLN-01";
    this.isPlaying = true;
    this.timer = null;

    this.scene = new CislunarScene(
      document.getElementById("canvas-container"),
      (scId) => this.selectSpacecraft(scId)
    );
    initLidarHeroBanner(document.getElementById("lidar-hero-canvas"));

    this.bindUI();
    this.init();
  }

  async init() {
    this.state = await OrbitalAPI.getState();
    this.renderAll();
    this.startLoop();
  }

  startLoop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(async () => {
      if (!this.isPlaying) return;
      this.state = await OrbitalAPI.stepSimulation(30);
      this.renderAll();
    }, 1500);
  }

  bindUI() {
    const legendBtn = document.getElementById("btn-toggle-legend");
    const legendPanel = document.getElementById("legend-panel");
    legendBtn.addEventListener("click", () => {
      const hidden = legendPanel.classList.toggle("hidden");
      legendBtn.textContent = hidden ? "SHOW LEGEND" : "HIDE LEGEND";
    });

    const playBtn = document.getElementById("btn-play-pause");
    playBtn.addEventListener("click", () => {
      this.isPlaying = !this.isPlaying;
      playBtn.textContent = this.isPlaying ? "PREVIEW · LIVE" : "PREVIEW · PAUSED";
    });

    const disciplineCard = document.getElementById("discipline-card");
    const safetyConsole = document.getElementById("safety-console");

    const openConsole = () => {
      disciplineCard.classList.add("hidden");
      safetyConsole.classList.remove("hidden");
    };

    document.getElementById("btn-toggle-console").addEventListener("click", openConsole);
    document.getElementById("btn-open-explorer").addEventListener("click", openConsole);
    document.getElementById("btn-close-console").addEventListener("click", () => {
      safetyConsole.classList.add("hidden");
      disciplineCard.classList.remove("hidden");
    });

    document.getElementById("btn-step").addEventListener("click", async () => {
      this.state = await OrbitalAPI.stepSimulation(600);
      this.renderAll();
    });

    document.getElementById("btn-reset").addEventListener("click", async () => {
      this.state = await OrbitalAPI.resetEpoch();
      this.resetSliders();
      this.scene.renderPreviewTrajectory(null);
      this.renderAll();
    });

    document.getElementById("spacecraft-select").addEventListener("change", (e) => {
      this.selectSpacecraft(e.target.value);
    });

    ["prograde", "normal", "radial"].forEach((axis) => {
      const slider = document.getElementById(`slider-${axis}`);
      slider.addEventListener("input", () => {
        document.getElementById(`val-${axis}`).textContent = `${parseFloat(slider.value).toFixed(1)} m/s`;
        this.previewManeuver();
      });
    });

    document.getElementById("btn-auto-solve").addEventListener("click", async () => {
      const candidates = [
        [2.5, 0.0, 0.0],
        [-2.5, 0.0, 0.0],
        [4.0, 1.5, 0.0],
        [0.0, 4.5, 1.0],
        [6.5, -2.0, 0.5],
      ];
      for (const [p, n, r] of candidates) {
        const res = await OrbitalAPI.runManeuver({
          spacecraftId: this.selectedId,
          prograde: p,
          normal: n,
          radial: r,
          apply: false,
        });
        if (res.maneuver.conjunction_cleared) {
          document.getElementById("slider-prograde").value = p;
          document.getElementById("slider-normal").value = n;
          document.getElementById("slider-radial").value = r;
          document.getElementById("val-prograde").textContent = `${p.toFixed(1)} m/s`;
          document.getElementById("val-normal").textContent = `${n.toFixed(1)} m/s`;
          document.getElementById("val-radial").textContent = `${r.toFixed(1)} m/s`;
          this.applyPreviewUI(res.maneuver);
          break;
        }
      }
    });

    document.getElementById("btn-execute-burn").addEventListener("click", async () => {
      const { prograde, normal, radial } = this.getSliderValues();
      try {
        const res = await OrbitalAPI.runManeuver({
          spacecraftId: this.selectedId,
          prograde,
          normal,
          radial,
          apply: true,
        });
        this.state = res.state;
        this.resetSliders();
        this.scene.renderPreviewTrajectory(null);
        this.renderAll();
      } catch (err) {
        alert(err.message);
      }
    });
  }

  getSliderValues() {
    return {
      prograde: parseFloat(document.getElementById("slider-prograde").value),
      normal: parseFloat(document.getElementById("slider-normal").value),
      radial: parseFloat(document.getElementById("slider-radial").value),
    };
  }

  resetSliders() {
    ["prograde", "normal", "radial"].forEach((axis) => {
      document.getElementById(`slider-${axis}`).value = 0;
      document.getElementById(`val-${axis}`).textContent = "0.0 m/s";
    });
    document.getElementById("preview-miss").textContent = "-- km";
    document.getElementById("preview-dv").textContent = "0.00 m/s";
    document.getElementById("preview-status").textContent = "NOMINAL";
  }

  selectSpacecraft(scId) {
    this.selectedId = scId;
    this.resetSliders();
    this.scene.renderPreviewTrajectory(null);
    this.renderAll();
  }

  async previewManeuver() {
    const { prograde, normal, radial } = this.getSliderValues();
    if (prograde === 0 && normal === 0 && radial === 0) {
      this.scene.renderPreviewTrajectory(null);
      this.resetSliders();
      return;
    }
    try {
      const res = await OrbitalAPI.runManeuver({
        spacecraftId: this.selectedId,
        prograde,
        normal,
        radial,
        apply: false,
      });
      this.applyPreviewUI(res.maneuver);
    } catch {
      document.getElementById("preview-status").textContent = "BUDGET EXCEEDED";
    }
  }

  applyPreviewUI(maneuver) {
    document.getElementById("preview-miss").textContent = `${maneuver.predicted_min_miss_km.toFixed(2)} km`;
    document.getElementById("preview-dv").textContent = `${maneuver.total_dv_ms.toFixed(2)} m/s`;
    const statusEl = document.getElementById("preview-status");
    statusEl.textContent = maneuver.conjunction_cleared ? "CLEARED" : "AT RISK";
    statusEl.style.color = maneuver.conjunction_cleared ? "#67e8f9" : "#fb7185";
    this.scene.renderPreviewTrajectory(maneuver.preview_trajectory_km);
  }

  formatMET(totalSec) {
    const hrs = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = Math.floor(totalSec % 60);
    return `T+${String(hrs).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  renderAll() {
    if (!this.state) return;

    document.getElementById("sim-clock-value").textContent = this.formatMET(this.state.sim_time_sec);
    document.getElementById("alert-count-badge").textContent = `${this.state.conjunctions.length} ALERTS`;

    const select = document.getElementById("spacecraft-select");
    if (select.options.length !== this.state.objects.length) {
      select.innerHTML = this.state.objects
        .map((sc) => `<option value="${sc.id}">${sc.id} · ${sc.name}</option>`)
        .join("");
    }
    select.value = this.selectedId;

    const alertsContainer = document.getElementById("alerts-list");
    if (this.state.conjunctions.length === 0) {
      alertsContainer.innerHTML = `<div class="telem-cell"><div class="telem-val" style="color:#67e8f9">ALL CISLUNAR CORRIDORS CLEAR</div></div>`;
    } else {
      alertsContainer.innerHTML = this.state.conjunctions
        .map(
          (cnj) => `
          <div class="alert-card ${cnj.severity === "ELEVATED" ? "elevated" : ""}" data-primary="${cnj.primary_id}">
            <div class="alert-top">
              <span>${cnj.primary_name} × ${cnj.secondary_name}</span>
              <span style="color:${cnj.severity === "ELEVATED" ? "#fb7185" : "#f59e0b"}">${cnj.severity}</span>
            </div>
            <div class="alert-meta">
              <span>MISS: <strong>${cnj.miss_distance_km} km</strong> · TCA: T+${cnj.tca_minutes}m</span>
              <span>Pc: ${cnj.collision_probability.toExponential(2)}</span>
            </div>
          </div>
        `
        )
        .join("");

      alertsContainer.querySelectorAll(".alert-card").forEach((el) => {
        el.addEventListener("click", () => {
          this.selectSpacecraft(el.dataset.primary);
        });
      });
    }

    const selected = this.state.objects.find((o) => o.id === this.selectedId) || this.state.objects[0];
    document.getElementById("fuel-remaining-label").textContent = `FUEL: ${selected.fuel_budget_ms} m/s`;

    const cells = [
      ["STATUS", selected.status],
      ["ALTITUDE", `${selected.altitude_km} km`],
      ["VELOCITY", `${selected.velocity_kms} km/s`],
      ["PERI × APO", `${selected.periapsis_km} × ${selected.apoapsis_km} km`],
      ["INCLINATION", `${selected.inclination_deg}°`],
      ["MASCON DRIFT", `${selected.mascon_sensitivity}x`],
    ];
    document.getElementById("telemetry-grid").innerHTML = cells
      .map(
        ([label, val]) => `
        <div class="telem-cell">
          <div class="telem-label">${label}</div>
          <div class="telem-val">${val}</div>
        </div>
      `
      )
      .join("");

    this.scene.updateState(this.state, this.selectedId);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  new OrbitalSafetyApp();
});