// script.js – Engine Sim V4
// ------------------------------------------------------
// Assumes your HTML has something like:
// <form id="engine-form">...</form>
// <canvas id="dynoChart"></canvas>
// <tbody id="resultsBody"></tbody>
// <div id="summaryPeak"></div>
// <div id="bmepInfo"></div>
// <div id="cfmInfo"></div>
// Adjust IDs in this file if your HTML uses different ones.
// ------------------------------------------------------

let dynoChart = null;

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("engine-form");
  if (form) {
    form.addEventListener("submit", onFormSubmit);
  }
  initChart();
});

// ---------- Helpers -------------------------------------------------

function hpFromTorque(tqLbFt, rpm) {
  return (tqLbFt * rpm) / 5252;
}

function createRpmRange(redline, step = 250, idle = 1000) {
  const maxRpm = Math.max(redline || 6000, idle + step);
  const arr = [];
  for (let r = idle; r <= maxRpm; r += step) {
    arr.push(r);
  }
  return arr;
}

function litersFromBoreStroke(boreMm, strokeMm, cylinders) {
  if (!boreMm || !strokeMm || !cylinders) return null;
  const boreCm = boreMm / 10;
  const strokeCm = strokeMm / 10;
  const cylVolCc = (Math.PI / 4) * boreCm * boreCm * strokeCm;
  const totalCc = cylVolCc * cylinders;
  return totalCc / 1000; // cc → liters
}

function litersToCID(liters) {
  return liters * 61.023744; // 1L ≈ 61.02 CID
}

// crude VE estimate at a given rpm from torque
// torque ~ k * displacementCID * VE  → VE ≈ T / (k * dispCID)
function estimateVE(torqueLbFt, displacementL) {
  const dispCID = litersToCID(displacementL);
  if (dispCID <= 0) return 0.8;
  const k = 1.35; // lb-ft per CID at ~100% VE (rough)
  const ve = torqueLbFt / (k * dispCID);
  return Math.max(0.3, Math.min(ve, 1.5)); // clamp
}

// BMEP in bar from torque (lb-ft) and displacement (L)
function bmepBar(torqueLbFt, displacementL) {
  if (!displacementL || displacementL <= 0) return 0;
  // Convert torque to Nm and displacement to m^3:
  const torqueNm = torqueLbFt * 1.35581795;
  const dispM3 = displacementL / 1000.0;
  // 4-stroke: BMEP = 4π * T / Vd
  const bmepaPa = (4 * Math.PI * torqueNm) / dispM3;
  const bar = bmepaPa / 1e5;
  return bar;
}

// theoretical CFM at given rpm & VE
function cfmAtRpm(displacementL, rpm, ve) {
  const dispCID = litersToCID(displacementL);
  // 4-stroke theoretical CFM at 100% VE:
  const cfm100 = (dispCID * rpm) / 3456;
  return cfm100 * ve;
}

// ---------- Base NA Models (Gasoline) -------------------------------

// 1) NA Gasoline – Pushrod 2-Valve
function simulateNaPushrod2v(rpmRange, displacementL, compRatio) {
  const dispCID = litersToCID(displacementL);
  let baseTqPerCID = 1.25; // lb-ft per CID baseline
  const compFactor = 1 + 0.02 * (compRatio - 9.0); // ~2% per CR point over 9
  const peakTorque = baseTqPerCID * compFactor * dispCID;

  const peakTqRpm = 4500;
  const peakHpRpm = 6000;

  const torque = [];
  const hp = [];

  for (const rpm of rpmRange) {
    let tq;
    if (rpm <= peakTqRpm) {
      // quick low-end rise, but not crazy
      const ratio = rpm / peakTqRpm;
      tq = peakTorque * Math.pow(ratio, 0.85); // strong low-end
    } else {
      const dropRatio = (rpm - peakTqRpm) / (peakHpRpm - peakTqRpm);
      // about 10–15% drop by peak HP
      const drop = 0.12 * Math.pow(Math.max(0, Math.min(dropRatio, 1)), 1.2);
      tq = peakTorque * (1 - drop);
    }
    // Avoid negative if rpm > peakHpRpm
    if (rpm > peakHpRpm) {
      const extra = (rpm - peakHpRpm) / (peakHpRpm * 0.5);
      tq *= Math.max(0, 1 - 0.4 * extra);
    }
    torque.push(tq);
    hp.push(hpFromTorque(tq, rpm));
  }

  return { rpm: rpmRange, torque, hp };
}

// 2) NA Gasoline – DOHC Multi-Valve
function simulateNaDohcMultivalve(rpmRange, displacementL, compRatio, numValves = 4) {
  const dispCID = litersToCID(displacementL);
  let baseTqPerCID = 1.20;
  let effFactor = 1.0;
  if (numValves >= 4) effFactor = 1.05; // 4V breathes better
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
      tq = peakTorque * Math.pow(ratio, 1.05); // smoother rise
    } else {
      const dropRatio = (rpm - peakTqRpm) / (peakHpRpm - peakTqRpm);
      const drop = 0.07 * Math.max(0, Math.min(dropRatio, 1)); // ~7% drop by peak HP
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

// ---------- Forced Induction Gasoline -------------------------------

// 3) Turbocharged Gasoline – Pushrod 2-Valve
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
      const currentBoostFactor = boostFactor * (1 - 0.5 * Math.max(0, Math.min(dropRatio, 1)));
      tq = naTq * currentBoostFactor;
    }

    torque.push(tq);
    hp.push(hpFromTorque(tq, rpm));
  }

  return { rpm: rpmRange, torque, hp };
}

// 4) Turbocharged Gasoline – DOHC Multi-Valve
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
      tq = naTq * boostFactor; // flat-ish plateau
    } else {
      const dropRatio = (rpm - plateauEndRpm) / (redline - plateauEndRpm);
      const drop = 0.2 * Math.max(0, Math.min(dropRatio, 1)); // ~20% drop by redline
      tq = naTq * boostFactor * (1 - drop);
    }

    torque.push(tq);
    hp.push(hpFromTorque(tq, rpm));
  }

  return { rpm: rpmRange, torque, hp };
}

// 5) Supercharged Gasoline – Works with pushrod or DOHC base
function simulateSuperchargedGasoline(
  rpmRange,
  displacementL,
  compRatio,
  boostPsi,
  valvetrain // 'pushrod' or 'dohc'
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

    // Simulate Roots/twin-screw style: almost instant boost
    if (rpm < 1500) {
      effectiveBoost = 1 + (boostFactor - 1) * (rpm / 1500);
    } else {
      effectiveBoost = boostFactor;
    }

    // A little efficiency drop at extreme top-end (blower drag/heat)
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

// ---------- Turbo Diesel --------------------------------------------

function simulateTurboDiesel(rpmRange, displacementL, boostPsi, heavyDuty = true) {
  const dispCID = litersToCID(displacementL);
  const boostFactor = 1 + boostPsi / 14.7;

  const baseTqPerCID = 1.5; // NA diesel baseline
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
      tq = peakTorque * Math.pow(ratio, 0.5); // very strong low-end
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

// ---------- Methanol Racing -----------------------------------------

function simulateMethanolRacing(rpmRange, displacementL, compRatio, boostPsi = 0) {
  // High-output base: DOHC NA curve
  const na = simulateNaDohcMultivalve(rpmRange, displacementL, compRatio, 4);

  const fuelFactor = 1.15; // ~15% extra torque vs gasoline
  const boostFactor = 1 + boostPsi / 14.7;

  const torque = [];
  const hp = [];
  const maxRpm = rpmRange[rpmRange.length - 1];

  for (let i = 0; i < rpmRange.length; i++) {
    const rpm = rpmRange[i];
    let tq = na.torque[i] * fuelFactor * boostFactor;

    // Better high-RPM stability: almost no drop at the top, maybe slight bump
    if (rpm > 0.8 * maxRpm) {
      const extra = (rpm - 0.8 * maxRpm) / (0.2 * maxRpm);
      tq *= 1 + 0.05 * Math.max(0, Math.min(extra, 1)); // up to +5% near very top
    }

    torque.push(tq);
    hp.push(hpFromTorque(tq, rpm));
  }

  return { rpm: rpmRange, torque, hp };
}

// ---------- Main Dispatcher -----------------------------------------

function simulateEngine(config) {
  const {
    displacementL,
    compRatio,
    redline,
    induction,
    boostPsi,
    fuel,
    valvetrain,
  } = config;

  const rpmRange = createRpmRange(redline, 250, 1000);

  // Fuel overrides
  if (fuel === "diesel") {
    const heavy = displacementL >= 5.0;
    return simulateTurboDiesel(rpmRange, displacementL, boostPsi || 16, heavy);
  }
  if (fuel === "methanol") {
    return simulateMethanolRacing(rpmRange, displacementL, compRatio || 13, boostPsi || 0);
  }

  // Gasoline paths
  if (induction === "na") {
    if (valvetrain === "pushrod") {
      return simulateNaPushrod2v(rpmRange, displacementL, compRatio);
    }
    // default to DOHC-ish behavior
    return simulateNaDohcMultivalve(rpmRange, displacementL, compRatio, config.valvesPerCyl || 4);
  }

  if (induction === "turbo") {
    if (valvetrain === "pushrod") {
      return simulateTurboPushrod2v(rpmRange, displacementL, compRatio, boostPsi || 7);
    }
    return simulateTurboDohcMultivalve(rpmRange, displacementL, compRatio, boostPsi || 7);
  }

  if (induction === "supercharger") {
    return simulateSuperchargedGasoline(
      rpmRange,
      displacementL,
      compRatio,
      boostPsi || 7,
      valvetrain === "pushrod" ? "pushrod" : "dohc"
    );
  }

  // Fallback: NA DOHC
  return simulateNaDohcMultivalve(rpmRange, displacementL, compRatio, config.valvesPerCyl || 4);
}

// ---------- UI Wiring ------------------------------------------------

function readConfigFromForm() {
  const getVal = (id) => {
    const el = document.getElementById(id);
    return el ? el.value : "";
  };

  const displacementInput = parseFloat(getVal("displacementL")) || 0;
  const boreMm = parseFloat(getVal("boreMm")) || 0;
  const strokeMm = parseFloat(getVal("strokeMm")) || 0;
  const cylinders = parseInt(getVal("cylinders")) || 0;
  const compRatio = parseFloat(getVal("compression")) || 10.0;
  const redline = parseInt(getVal("redline")) || 7000;
  const induction = getVal("induction") || "na"; // "na" | "turbo" | "supercharger"
  const fuel = getVal("fuel") || "gasoline"; // "gasoline" | "diesel" | "methanol"
  const valvetrain = getVal("valvetrain") || "dohc"; // "pushrod" | "sohc" | "dohc"
  const valvesPerCyl = parseInt(getVal("valvesPerCyl")) || 4;
  const boostPsi = parseFloat(getVal("boostPsi")) || 0;

  let displacementL = displacementInput;
  if (!displacementL && boreMm && strokeMm && cylinders) {
    displacementL = litersFromBoreStroke(boreMm, strokeMm, cylinders);
  }

  return {
    displacementL,
    boreMm,
    strokeMm,
    cylinders,
    compRatio,
    redline,
    induction,
    fuel,
    valvetrain,
    valvesPerCyl,
    boostPsi,
  };
}

function onFormSubmit(e) {
  e.preventDefault();

  const config = readConfigFromForm();
  if (!config.displacementL || config.displacementL <= 0 || !config.redline) {
    alert("Please enter a valid displacement and RPM limit.");
    return;
  }

  const result = simulateEngine(config);
  updateChart(result.rpm, result.torque, result.hp);
  updateResultsTable(result.rpm, result.torque, result.hp, config.displacementL);
  updateSummary(result.rpm, result.torque, result.hp, config.displacementL);
}

// ---------- Chart.js -------------------------------------------------

function initChart() {
  const ctx = document.getElementById("dynoChart");
  if (!ctx) return;

  dynoChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: [],
      datasets: [
        {
          label: "Torque (lb-ft)",
          data: [],
          yAxisID: "y1",
          borderWidth: 2,
          tension: 0.2,
        },
        {
          label: "Horsepower",
          data: [],
          yAxisID: "y2",
          borderWidth: 2,
          borderDash: [5, 5],
          tension: 0.2,
        },
      ],
    },
    options: {
      responsive: true,
      scales: {
        y1: {
          type: "linear",
          position: "left",
          title: { display: true, text: "Torque (lb-ft)" },
        },
        y2: {
          type: "linear",
          position: "right",
          title: { display: true, text: "Horsepower" },
          grid: { drawOnChartArea: false },
        },
        x: {
          title: { display: true, text: "Engine Speed (RPM)" },
        },
      },
    },
  });
}

function updateChart(rpm, torque, hp) {
  if (!dynoChart) return;
  dynoChart.data.labels = rpm;
  dynoChart.data.datasets[0].data = torque;
  dynoChart.data.datasets[1].data = hp;
  dynoChart.update();
}

// ---------- Results Table & Summary ---------------------------------

function updateResultsTable(rpmArr, torqueArr, hpArr, displacementL) {
  const tbody = document.getElementById("resultsBody");
  if (!tbody) return;
  tbody.innerHTML = "";

  for (let i = 0; i < rpmArr.length; i++) {
    const rpm = rpmArr[i];
    const tq = torqueArr[i];
    const hp = hpArr[i];

    const ve = estimateVE(tq, displacementL);
    const cfm = cfmAtRpm(displacementL, rpm, ve);

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${rpm}</td>
      <td>${tq.toFixed(1)}</td>
      <td>${hp.toFixed(1)}</td>
      <td>${(ve * 100).toFixed(0)}%</td>
      <td>${cfm.toFixed(0)}</td>
    `;
    tbody.appendChild(tr);
  }
}

function updateSummary(rpmArr, torqueArr, hpArr, displacementL) {
  const summaryDiv = document.getElementById("summaryPeak");
  const bmepDiv = document.getElementById("bmepInfo");
  const cfmDiv = document.getElementById("cfmInfo");

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

  if (summaryDiv) {
    summaryDiv.textContent = `Peak torque: ${peakTq.toFixed(
      1
    )} lb-ft @ ${peakTqRpm} RPM | Peak power: ${peakHp.toFixed(
      1
    )} hp @ ${peakHpRpm} RPM`;
  }

  const peakBmep = bmepBar(peakTq, displacementL);
  if (bmepDiv) {
    bmepDiv.textContent = `Approx. peak BMEP: ${peakBmep.toFixed(
      1
    )} bar (very rough estimate)`;
  }

  const veAtPeakTq = estimateVE(peakTq, displacementL);
  const cfmAtPeakTq = cfmAtRpm(displacementL, peakTqRpm, veAtPeakTq);
  if (cfmDiv) {
    cfmDiv.textContent = `Approx. airflow at peak torque: ${cfmAtPeakTq.toFixed(
      0
    )} CFM @ ${peakTqRpm} RPM`;
  }
}
