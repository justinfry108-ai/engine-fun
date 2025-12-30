// script.js – Engine Power Simulator V4 tied to v3 HTML
// ----------------------------------------------------
// Matches IDs in index.html you sent:
// - <form id="engine-form">
// - Canvas: powerChart
// - Summary spans: peakHp, peakHpRpm, peakTq, peakTqRpm, hpPerL,
//                  fuelPeakLb, fuelPeakGal, bmepPeakPsi, cfmPeak
// - Table: id="results-table", tbody (no id)
// - Inputs: cylinders, boreMm, strokeMm, displacementL (readonly),
//           compressionRatio, redlineRpm, rpmStep,
//           vePeak, sizePenalty, pistonSpeedLimit,
//           fuelType, inductionType, boostPsi,
//           valvetrainType, valvesPerCyl
// ----------------------------------------------------

let powerChart = null;

document.addEventListener("DOMContentLoaded", () => {
  console.log("Engine Simulator V4 loaded");

  const form = document.getElementById("engine-form");
  if (form) {
    form.addEventListener("submit", onFormSubmit);
  } else {
    console.error("engine-form not found");
  }

  // Auto-update displacement when bore/stroke/cyl change
  ["boreMm", "strokeMm", "cylinders"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener("input", updateDisplacementFromGeometry);
    }
  });

  // initialize displacement once
  updateDisplacementFromGeometry();

  initChart();
});

// ---------- Helper math ------------------------------------------------

function hpFromTorque(tqLbFt, rpm) {
  return (tqLbFt * rpm) / 5252;
}

function createRpmRange(redline, step, idle = 1000) {
  const maxRpm = Math.max(redline || 6000, idle + step);
  const arr = [];
  for (let r = idle; r <= maxRpm; r += step) arr.push(r);
  return arr;
}

function litersFromBoreStroke(boreMm, strokeMm, cylinders) {
  if (!boreMm || !strokeMm || !cylinders) return 0;
  const boreCm = boreMm / 10;
  const strokeCm = strokeMm / 10;
  const cylVolCc = (Math.PI / 4) * boreCm * boreCm * strokeCm;
  const totalCc = cylVolCc * cylinders;
  return totalCc / 1000;
}

function litersToCID(liters) {
  return liters * 61.023744;
}

// approximate VE from torque
function estimateVE(torqueLbFt, displacementL) {
  const dispCID = litersToCID(displacementL);
  if (dispCID <= 0) return 0.8;
  const k = 1.35; // lb-ft per CID @ ~100% VE (rough)
  const ve = torqueLbFt / (k * dispCID);
  return Math.max(0.3, Math.min(ve, 1.5));
}

// BMEP in psi
function bmepPsi(torqueLbFt, displacementL) {
  if (!displacementL || displacementL <= 0) return 0;
  // 4-stroke BMEP(psi) ≈ 150.8 * T(lb-ft) / Vd(L)
  return (150.8 * torqueLbFt) / displacementL;
}

// Mean piston speed in m/s
function meanPistonSpeed(strokeMm, rpm) {
  if (!strokeMm || strokeMm <= 0) return 0;
  const strokeM = strokeMm / 1000;
  return (2 * strokeM * rpm) / 60; // 2 * stroke * rpm / 60
}

// Theoretical CFM at given rpm & VE
function cfmAtRpm(displacementL, rpm, ve) {
  const dispCID = litersToCID(displacementL);
  const cfm100 = (dispCID * rpm) / 3456;
  return cfm100 * ve;
}

// Simple BSFC model (lb/hp/hr) based on fuel & induction
function getBsfc(fuelType, inductionType) {
  if (fuelType === "diesel") {
    return inductionType === "na" ? 0.40 : 0.38;
  }
  if (fuelType === "methanol") {
    return inductionType === "na" ? 0.70 : 0.75;
  }
  // gasoline
  if (inductionType === "na") return 0.50;
  return 0.60; // boosted gasoline
}

// Fuel density (lb/gal)
function getFuelDensityLbPerGal(fuelType) {
  switch (fuelType) {
    case "diesel":
      return 7.1;
    case "methanol":
      return 6.6;
    default: // gasoline
      return 6.2;
  }
}

// ---------- Base NA Engine models (Gasoline) ---------------------------

// NA Gasoline – Pushrod 2V
function simulateNaPushrod2v(rpmRange, displacementL, compRatio) {
  const dispCID = litersToCID(displacementL);
  const baseTqPerCID = 1.25;
  const compFactor = 1 + 0.02 * (compRatio - 9.0);
  const peakTorque = baseTqPerCID * compFactor * dispCID;

  const peakTqRpm = 4500;
  const peakHpRpm = 6000;

  const torque = [];
  const hp = [];

  for (const rpm of rpmRange) {
    let tq;
    if (rpm <= peakTqRpm) {
      const ratio = rpm / peakTqRpm;
      tq = peakTorque * Math.pow(ratio, 0.85);
    } else {
      const dropRatio = (rpm - peakTqRpm) / (peakHpRpm - peakTqRpm);
      const drop = 0.12 * Math.pow(Math.max(0, Math.min(dropRatio, 1)), 1.2);
      tq = peakTorque * (1 - drop);
    }
    if (rpm > peakHpRpm) {
      const extra = (rpm - peakHpRpm) / (peakHpRpm * 0.5);
      tq *= Math.max(0, 1 - 0.4 * extra);
    }
    torque.push(tq);
    hp.push(hpFromTorque(tq, rpm));
  }

  return { rpm: rpmRange, torque, hp };
}

// NA Gasoline – DOHC Multi-valve
function simulateNaDohcMultivalve(rpmRange, displacementL, compRatio, numValves = 4) {
  const dispCID = litersToCID(displacementL);
  let baseTqPerCID = 1.20;
  let effFactor = 1.0;
  if (numValves >= 4) effFactor = 1.05;
  const compFactor = 1 + 0.015 * (compRatio - 9.0);

  const peakTorque = baseTqPerCID * effFactor * compFactor * dispCID;
  const peakTqRpm = 6000;
  const peakHpRpm = 7500;

  const torque = [];
  const hp = [];

  for (const rpm of rpmRange) {
    let tq;
    if (rpm <= peakTqRpm) {
      const ratio = rpm / peakTqRpm;
      tq = peakTorque * Math.pow(ratio, 1.05);
    } else {
      const dropRatio = (rpm - peakTqRpm) / (peakHpRpm - peakTqRpm);
      const drop = 0.07 * Math.max(0, Math.min(dropRatio, 1));
      tq = peakTorque * (1 - drop);
    }
    if (rpm > peakHpRpm) {
      const extra = (rpm - peakHpRpm) / (peakHpRpm * 0.5);
      tq *= Math.max(0, 1 - 0.3 * extra);
    }
    torque.push(tq);
    hp.push(hpFromTorque(tq, rpm));
  }

  return { rpm: rpmRange, torque, hp };
}

// ---------- Turbo/Supercharged Gasoline -------------------------------

// Turbo – Pushrod 2V
function simulateTurboPushrod2v(rpmRange, displacementL, compRatio, boostPsi) {
  const na = simulateNaPushrod2v(rpmRange, displacementL, compRatio);
  const boostFactor = 1 + boostPsi / 14.7;

  const spoolRpm = 2500;
  const fullBoostRpm = 3500;
  const falloffRpm = 5500;
  const redline = rpmRange[rpmRange.length - 1];

  const torque = [];
  const hp = [];

  for (let i = 0; i < rpmRange.length; i++) {
    const rpm = rpmRange[i];
    const naTq = na.torque[i];
    let tq;

    if (rpm < spoolRpm) {
      tq = naTq;
    } else if (rpm < fullBoostRpm) {
      const ramp = (rpm - spoolRpm) / (fullBoostRpm - spoolRpm);
      tq = naTq * (1 + ramp * (boostFactor - 1));
    } else if (rpm <= falloffRpm) {
      tq = naTq * boostFactor;
    } else {
      const dropRatio = (rpm - falloffRpm) / (redline - falloffRpm);
      const currentBoostFactor =
        boostFactor * (1 - 0.5 * Math.max(0, Math.min(dropRatio, 1)));
      tq = naTq * currentBoostFactor;
    }

    torque.push(tq);
    hp.push(hpFromTorque(tq, rpm));
  }

  return { rpm: rpmRange, torque, hp };
}

// Turbo – DOHC Multi-valve
function simulateTurboDohcMultivalve(rpmRange, displacementL, compRatio, boostPsi) {
  const na = simulateNaDohcMultivalve(rpmRange, displacementL, compRatio, 4);
  const boostFactor = 1 + boostPsi / 14.7;

  const spoolRpm = 1500;
  const fullBoostRpm = 2000;
  const plateauEndRpm = 5000;
  const redline = rpmRange[rpmRange.length - 1];

  const torque = [];
  const hp = [];

  for (let i = 0; i < rpmRange.length; i++) {
    const rpm = rpmRange[i];
    const naTq = na.torque[i];
    let tq;

    if (rpm < spoolRpm) {
      tq = naTq;
    } else if (rpm < fullBoostRpm) {
      const ramp = (rpm - spoolRpm) / (fullBoostRpm - spoolRpm);
      tq = naTq * (1 + ramp * (boostFactor - 1));
    } else if (rpm <= plateauEndRpm) {
      tq = naTq * boostFactor;
    } else {
      const dropRatio = (rpm - plateauEndRpm) / (redline - plateauEndRpm);
      const drop = 0.2 * Math.max(0, Math.min(dropRatio, 1));
      tq = naTq * boostFactor * (1 - drop);
    }

    torque.push(tq);
    hp.push(hpFromTorque(tq, rpm));
  }

  return { rpm: rpmRange, torque, hp };
}

// Supercharged – gasoline, works with pushrod or DOHC base
function simulateSuperchargedGasoline(
  rpmRange,
  displacementL,
  compRatio,
  boostPsi,
  valvetrain // 'pushrod' | 'sohc' | 'dohc'
) {
  let na;
  if (valvetrain === "pushrod") {
    na = simulateNaPushrod2v(rpmRange, displacementL, compRatio);
  } else {
    na = simulateNaDohcMultivalve(rpmRange, displacementL, compRatio, 4);
  }

  const boostFactor = 1 + boostPsi / 14.7;
  const torque = [];
  const hp = [];
  const maxRpm = rpmRange[rpmRange.length - 1];

  for (let i = 0; i < rpmRange.length; i++) {
    const rpm = rpmRange[i];
    const naTq = na.torque[i];
    let effectiveBoost;

    if (rpm < 1500) {
      effectiveBoost = 1 + (boostFactor - 1) * (rpm / 1500);
    } else {
      effectiveBoost = boostFactor;
    }

    let tq = naTq * effectiveBoost;

    if (rpm > 0.9 * maxRpm) {
      const extra = (rpm - 0.9 * maxRpm) / (0.1 * maxRpm);
      tq *= Math.max(0.8, 1 - 0.2 * extra);
    }

    torque.push(tq);
    hp.push(hpFromTorque(tq, rpm));
  }

  return { rpm: rpmRange, torque, hp };
}

// ---------- Turbo Diesel ----------------------------------------------

function simulateTurboDiesel(rpmRange, displacementL, boostPsi, heavyDuty = true) {
  const dispCID = litersToCID(displacementL);
  const boostFactor = 1 + boostPsi / 14.7;
  const baseTqPerCID = 1.5;
  const peakTorque = baseTqPerCID * boostFactor * dispCID;

  let peakTqRpm, redline;
  if (heavyDuty) {
    peakTqRpm = 1500;
    redline = 2500;
  } else {
    peakTqRpm = 2000;
    redline = 4000;
  }

  const plateauEndRpm = 0.7 * redline;

  const torque = [];
  const hp = [];

  for (const rpm of rpmRange) {
    let tq;
    if (rpm <= peakTqRpm) {
      const ratio = rpm / peakTqRpm;
      tq = peakTorque * Math.pow(ratio, 0.5);
      if (tq > peakTorque) tq = peakTorque;
    } else if (rpm <= plateauEndRpm) {
      tq = peakTorque;
    } else {
      const dropRatio = (rpm - plateauEndRpm) / (redline - plateauEndRpm);
      const drop = 0.8 * Math.pow(Math.max(0, Math.min(dropRatio, 1)), 1.2);
      tq = peakTorque * (1 - drop);
    }

    torque.push(tq);
    hp.push(hpFromTorque(tq, rpm));
  }

  return { rpm: rpmRange, torque, hp };
}

// ---------- Methanol Racing -------------------------------------------

function simulateMethanolRacing(rpmRange, displacementL, compRatio, boostPsi = 0) {
  const na = simulateNaDohcMultivalve(rpmRange, displacementL, compRatio, 4);

  const fuelFactor = 1.15;
  const boostFactor = 1 + boostPsi / 14.7;

  const torque = [];
  const hp = [];
  const maxRpm = rpmRange[rpmRange.length - 1];

  for (let i = 0; i < rpmRange.length; i++) {
    const rpm = rpmRange[i];
    let tq = na.torque[i] * fuelFactor * boostFactor;

    if (rpm > 0.8 * maxRpm) {
      const extra = (rpm - 0.8 * maxRpm) / (0.2 * maxRpm);
      tq *= 1 + 0.05 * Math.max(0, Math.min(extra, 1));
    }

    torque.push(tq);
    hp.push(hpFromTorque(tq, rpm));
  }

  return { rpm: rpmRange, torque, hp };
}

// ---------- Main dispatcher + VE / piston speed penalties ------------- 

function simulateEngine(config) {
  const {
    displacementL,
    compRatio,
    redline,
    rpmStep,
    inductionType,
    boostPsi,
    fuelType,
    valvetrainType,
    valvesPerCyl,
    vePeak,
    sizePenalty,
    pistonSpeedLimit,
    strokeMm,
  } = config;

  const rpmRange = createRpmRange(redline, rpmStep, 1000);

  let base;
  // Fuel-based routing
  if (fuelType === "diesel") {
    const heavy = displacementL >= 5.0;
    base = simulateTurboDiesel(rpmRange, displacementL, boostPsi || 16, heavy);
  } else if (fuelType === "methanol") {
    base = simulateMethanolRacing(
      rpmRange,
      displacementL,
      compRatio || 13,
      boostPsi || 0
    );
  } else {
    // gasoline
    if (inductionType === "na") {
      if (valvetrainType === "pushrod") {
        base = simulateNaPushrod2v(rpmRange, displacementL, compRatio);
      } else {
        base = simulateNaDohcMultivalve(
          rpmRange,
          displacementL,
          compRatio,
          valvesPerCyl
        );
      }
    } else if (inductionType === "turbo") {
      if (valvetrainType === "pushrod") {
        base = simulateTurboPushrod2v(
          rpmRange,
          displacementL,
          compRatio,
          boostPsi || 7
        );
      } else {
        base = simulateTurboDohcMultivalve(
          rpmRange,
          displacementL,
          compRatio,
          boostPsi || 7
        );
      }
    } else if (inductionType === "supercharger") {
      base = simulateSuperchargedGasoline(
        rpmRange,
        displacementL,
        compRatio,
        boostPsi || 7,
        valvetrainType
      );
    } else {
      base = simulateNaDohcMultivalve(
        rpmRange,
        displacementL,
        compRatio,
        valvesPerCyl
      );
    }
  }

  // Apply user VE & size & piston-speed penalties as a global modifier
  const veBase = 0.95; // reference for vePeak
  const veScale = (vePeak / 100) / veBase;

  let sizeScale = 1;
  if (displacementL > 2 && sizePenalty > 0) {
    const penalty = (sizePenalty / 100) * (displacementL - 2);
    sizeScale = Math.max(0.6, 1 - penalty);
  }

  const torque = [];
  const hp = [];

  for (let i = 0; i < base.rpm.length; i++) {
    const rpm = base.rpm[i];
    const ps = meanPistonSpeed(strokeMm, rpm);

    let pistonScale = 1;
    if (pistonSpeedLimit > 0 && ps > pistonSpeedLimit) {
      const excess = (ps - pistonSpeedLimit) / pistonSpeedLimit;
      pistonScale = Math.max(0.6, 1 - 0.5 * excess);
    }

    const scale = veScale * sizeScale * pistonScale;

    const tq = base.torque[i] * scale;
    const h = hpFromTorque(tq, rpm);

    torque.push(tq);
    hp.push(h);
  }

  return { rpm: base.rpm, torque, hp };
}

// ---------- Form + UI wiring ------------------------------------------ 

function readConfigFromForm() {
  const getVal = (id) => {
    const el = document.getElementById(id);
    return el ? el.value : "";
  };

  const cylinders = parseInt(getVal("cylinders")) || 4;
  const boreMm = parseFloat(getVal("boreMm")) || 0;
  const strokeMm = parseFloat(getVal("strokeMm")) || 0;

  let displacementL = parseFloat(getVal("displacementL")) || 0;
  if (!displacementL) {
    displacementL = litersFromBoreStroke(boreMm, strokeMm, cylinders);
    const dispInput = document.getElementById("displacementL");
    if (dispInput && displacementL) {
      dispInput.value = displacementL.toFixed(2);
    }
  }

  const compRatio = parseFloat(getVal("compressionRatio")) || 10.0;
  const redline = parseInt(getVal("redlineRpm")) || 7000;
  const rpmStep = parseInt(getVal("rpmStep")) || 250;

  const vePeak = parseFloat(getVal("vePeak")) || 95;
  const sizePenalty = parseFloat(getVal("sizePenalty")) || 0;
  const pistonSpeedLimit = parseFloat(getVal("pistonSpeedLimit")) || 0;

  const fuelType = getVal("fuelType") || "gasoline";
  const inductionType = getVal("inductionType") || "na";
  const boostPsi = parseFloat(getVal("boostPsi")) || 0;

  const valvetrainType = getVal("valvetrainType") || "dohc";
  const valvesPerCyl = parseInt(getVal("valvesPerCyl")) || 4;

  return {
    cylinders,
    boreMm,
    strokeMm,
    displacementL,
    compRatio,
    redline,
    rpmStep,
    vePeak,
    sizePenalty,
    pistonSpeedLimit,
    fuelType,
    inductionType,
    boostPsi,
    valvetrainType,
    valvesPerCyl,
  };
}

function onFormSubmit(e) {
  e.preventDefault();

  const warningsEl = document.getElementById("warnings");
  if (warningsEl) warningsEl.textContent = "";

  const cfg = readConfigFromForm();

  if (!cfg.displacementL || cfg.displacementL <= 0) {
    alert("Please enter valid bore, stroke, and cylinder count so displacement can be calculated.");
    return;
  }

  const result = simulateEngine(cfg);

  updateChart(result.rpm, result.torque, result.hp);
  updateResultsTable(
    result.rpm,
    result.torque,
    result.hp,
    cfg.displacementL,
    cfg.strokeMm,
    cfg.fuelType,
    cfg.inductionType
  );
  updateSummary(
    result.rpm,
    result.torque,
    result.hp,
    cfg.displacementL,
    cfg.fuelType,
    cfg.inductionType
  );
}

// ---------- Chart.js setup --------------------------------------------

function initChart() {
  const ctx = document.getElementById("powerChart");
  if (!ctx) {
    console.error("powerChart canvas not found");
    return;
  }

  powerChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: [],
      datasets: [
        {
          label: "Horsepower",
          data: [],
          borderWidth: 2,
          tension: 0.2,
          yAxisID: "yHp",
        },
        {
          label: "Torque (lb-ft)",
          data: [],
          borderWidth: 2,
          tension: 0.2,
          yAxisID: "yTq",
        },
      ],
    },
    options: {
      responsive: true,
      scales: {
        x: {
          title: { display: true, text: "RPM" },
        },
        yHp: {
          type: "linear",
          position: "left",
          title: { display: true, text: "Horsepower" },
        },
        yTq: {
          type: "linear",
          position: "right",
          title: { display: true, text: "Torque (lb-ft)" },
          grid: { drawOnChartArea: false },
        },
      },
    },
  });
}

function updateChart(rpmArr, torqueArr, hpArr) {
  if (!powerChart) return;

  powerChart.data.labels = rpmArr;
  powerChart.data.datasets[0].data = hpArr;
  powerChart.data.datasets[1].data = torqueArr;
  powerChart.update();
}

// ---------- Table + Summary -------------------------------------------

function updateResultsTable(
  rpmArr,
  torqueArr,
  hpArr,
  displacementL,
  strokeMm,
  fuelType,
  inductionType
) {
  const table = document.getElementById("results-table");
  if (!table) return;
  const tbody = table.querySelector("tbody");
  if (!tbody) return;

  tbody.innerHTML = "";

  const bsfc = getBsfc(fuelType, inductionType);
  const density = getFuelDensityLbPerGal(fuelType);

  for (let i = 0; i < rpmArr.length; i++) {
    const rpm = rpmArr[i];
    const tq = torqueArr[i];
    const hp = hpArr[i];

    const ve = estimateVE(tq, displacementL);
    const ps = meanPistonSpeed(strokeMm, rpm);
    const bmep = bmepPsi(tq, displacementL);
    const cfm = cfmAtRpm(displacementL, rpm, ve);

    const fuelLbHr = hp > 0 ? hp * bsfc : 0;
    const fuelGalHr = fuelLbHr / density;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${rpm}</td>
      <td>${hp.toFixed(1)}</td>
      <td>${tq.toFixed(1)}</td>
      <td>${(ve * 100).toFixed(0)}</td>
      <td>${ps.toFixed(2)}</td>
      <td>${bmep.toFixed(1)}</td>
      <td>${cfm.toFixed(0)}</td>
      <td>${fuelLbHr.toFixed(1)}</td>
      <td>${fuelGalHr.toFixed(2)}</td>
    `;
    tbody.appendChild(tr);
  }
}

function updateSummary(rpmArr, torqueArr, hpArr, displacementL, fuelType, inductionType) {
  const peakHpSpan = document.getElementById("peakHp");
  const peakHpRpmSpan = document.getElementById("peakHpRpm");
  const peakTqSpan = document.getElementById("peakTq");
  const peakTqRpmSpan = document.getElementById("peakTqRpm");
  const hpPerLSpan = document.getElementById("hpPerL");
  const fuelPeakLbSpan = document.getElementById("fuelPeakLb");
  const fuelPeakGalSpan = document.getElementById("fuelPeakGal");
  const bmepPeakPsiSpan = document.getElementById("bmepPeakPsi");
  const cfmPeakSpan = document.getElementById("cfmPeak");

  let peakHp = -Infinity;
  let peakHpRpm = 0;
  let peakTq = -Infinity;
  let peakTqRpm = 0;

  for (let i = 0; i < rpmArr.length; i++) {
    if (hpArr[i] > peakHp) {
      peakHp = hpArr[i];
      peakHpRpm = rpmArr[i];
    }
    if (torqueArr[i] > peakTq) {
      peakTq = torqueArr[i];
      peakTqRpm = rpmArr[i];
    }
  }

  const hpPerL = displacementL > 0 ? peakHp / displacementL : 0;
  const bmepPeak = bmepPsi(peakTq, displacementL);
  const veAtPeakTq = estimateVE(peakTq, displacementL);
  const cfmAtPeak = cfmAtRpm(displacementL, peakTqRpm, veAtPeakTq);

  const bsfc = getBsfc(fuelType, inductionType);
  const density = getFuelDensityLbPerGal(fuelType);
  const fuelLbHr = peakHp > 0 ? peakHp * bsfc : 0;
  const fuelGalHr = fuelLbHr / density;

  if (peakHpSpan) peakHpSpan.textContent = peakHp.toFixed(1);
  if (peakHpRpmSpan) peakHpRpmSpan.textContent = peakHpRpm;
  if (peakTqSpan) peakTqSpan.textContent = peakTq.toFixed(1);
  if (peakTqRpmSpan) peakTqRpmSpan.textContent = peakTqRpm;
  if (hpPerLSpan) hpPerLSpan.textContent = hpPerL.toFixed(1);
  if (bmepPeakPsiSpan) bmepPeakPsiSpan.textContent = bmepPeak.toFixed(1);
  if (cfmPeakSpan) cfmPeakSpan.textContent = cfmAtPeak.toFixed(0);
  if (fuelPeakLbSpan) fuelPeakLbSpan.textContent = fuelLbHr.toFixed(1);
  if (fuelPeakGalSpan) fuelPeakGalSpan.textContent = fuelGalHr.toFixed(2);
}

// ---------- Geometry → displacement helper ----------------------------

function updateDisplacementFromGeometry() {
  const cylEl = document.getElementById("cylinders");
  const boreEl = document.getElementById("boreMm");
  const strokeEl = document.getElementById("strokeMm");
  const dispEl = document.getElementById("displacementL");

  if (!cylEl || !boreEl || !strokeEl || !dispEl) return;

  const cyl = parseInt(cylEl.value) || 0;
  const bore = parseFloat(boreEl.value) || 0;
  const stroke = parseFloat(strokeEl.value) || 0;

  if (!cyl || !bore || !stroke) return;

  const dispL = litersFromBoreStroke(bore, stroke, cyl);
  if (dispL > 0) dispEl.value = dispL.toFixed(2);
}
