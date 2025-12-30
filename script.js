// script.js – Engine Power Simulator V4.1
// Reworked:
// - Compression & knock behavior per fuel/induction
// - Valve count & valvetrain influence on NA curves
// - Diesel torque curve (esp. light-duty 6.7 style)
// - VE estimation clamp (no more 50% / 150% extremes)
// Preserves all V3 features: BSFC, fuel, airflow, BMEP, piston speed, table, chart.

let powerChart = null;

document.addEventListener("DOMContentLoaded", () => {
  console.log("Engine Simulator V4.1 loaded");

  const form = document.getElementById("engine-form");
  if (form) {
    form.addEventListener("submit", onFormSubmit);
  }

  ["boreMm", "strokeMm", "cylinders"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", updateDisplacementFromGeometry);
  });

  updateDisplacementFromGeometry();
  initChart();
});

// ---------- Basic helpers --------------------------------------------

function hpFromTorque(tqLbFt, rpm) {
  return (tqLbFt * rpm) / 5252;
}

function createRpmRange(redline, step, idle = 1000) {
  const maxRpm = Math.max(redline || 6000, idle + step);
  const list = [];
  for (let r = idle; r <= maxRpm; r += step) list.push(r);
  return list;
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

// Mean piston speed (m/s)
function meanPistonSpeed(strokeMm, rpm) {
  if (!strokeMm || strokeMm <= 0) return 0;
  const strokeM = strokeMm / 1000;
  return (2 * strokeM * rpm) / 60;
}

// VE estimation from torque (rough)
function estimateVE(torqueLbFt, displacementL) {
  const dispCID = litersToCID(displacementL);
  if (dispCID <= 0) return 0.85;
  // For a typical gas NA ~1.1 lb-ft/CID @ 100% VE
  const k = 1.1;
  let ve = torqueLbFt / (k * dispCID);
  // clamp to realistic range
  ve = Math.max(0.6, Math.min(ve, 1.3));
  return ve;
}

// BMEP in psi (rough)
function bmepPsi(torqueLbFt, displacementL) {
  if (!displacementL || displacementL <= 0) return 0;
  // 4-stroke BMEP(psi) ≈ 150.8 * T(lb-ft) / Vd(L)
  return (150.8 * torqueLbFt) / displacementL;
}

// CFM at RPM for given VE
function cfmAtRpm(displacementL, rpm, ve) {
  const dispCID = litersToCID(displacementL);
  const cfm100 = (dispCID * rpm) / 3456;
  return cfm100 * ve;
}

// BSFC estimate
function getBsfc(fuelType, inductionType) {
  if (fuelType === "diesel") {
    return inductionType === "na" ? 0.40 : 0.38;
  }
  if (fuelType === "methanol") {
    return inductionType === "na" ? 0.70 : 0.75;
  }
  // gasoline
  if (inductionType === "na") return 0.50;
  return 0.60;
}

// Fuel densities
function getFuelDensityLbPerGal(fuelType) {
  switch (fuelType) {
    case "diesel":
      return 7.1;
    case "methanol":
      return 6.6;
    default:
      return 6.2; // gasoline
  }
}

// ---------- Compression & effective boost logic ----------------------

// Central place where compression and fuel/induction interact.
// Returns:
//   compFactor  – multiplier applied to *all* torques
//   effBoostPsi – knock/CR-limited boost to use in models
function getCompressionBoostScaling(fuelType, inductionType, compRatio, boostPsi) {
  let compFactor = 1.0;
  let effBoost = boostPsi;

  if (fuelType === "gasoline") {
    if (inductionType === "na") {
      // NA gas: sweet spot ~10.5–11:1
      const ideal = 10.8;
      const delta = compRatio - ideal;
      // small quadratic: too low or too high = mild penalty
      compFactor = 1 + 0.02 * delta - 0.005 * delta * delta;
    } else {
      // boosted gasoline: sweet spot ~9.5:1
      const ideal = 9.5;
      const delta = compRatio - ideal;

      // base compFactor: slightly punish high CR on boost
      compFactor = 1 - 0.03 * Math.max(delta, 0) + 0.01 * Math.min(delta, 0);

      // simple knock-limited boost reduction above ~10.5:1
      if (compRatio > 10.5 && boostPsi > 0) {
        const extraCr = compRatio - 10.5;
        const reduction = extraCr * 3; // 3 psi per CR point above 10.5
        effBoost = Math.max(0, boostPsi - reduction);
      }
    }
  } else if (fuelType === "diesel") {
    // Diesels like high CR but within a band (say 16–18)
    const ideal = 17;
    const delta = compRatio - ideal;
    compFactor = 1 - 0.01 * Math.abs(delta); // mild penalty away from ideal

    // Too low CR diesel (<15) struggles; too high (>19) also not ideal
    if (compRatio < 15 || compRatio > 19) {
      compFactor *= 0.95;
    }

    // Diesels typically run high boost; leave effBoost as is.
  } else if (fuelType === "methanol") {
    // Methanol: loves high compression. Ideal ~13–14:1
    const ideal = 13.5;
    const delta = compRatio - ideal;
    compFactor = 1 + 0.015 * delta;
    // Slight knock margin: allow a bit more effective boost
    if (inductionType !== "na") {
      effBoost = boostPsi * 1.1;
    }
  }

  // Clamp
  compFactor = Math.max(0.7, Math.min(compFactor, 1.15));
  return { compFactor, effBoostPsi: effBoost };
}

// ---------- NA gasoline models (valvetrain + valves matter) ----------

// 1) NA Gasoline – Pushrod (OHV, usually 2V, torque-biased, early peak)
function simulateNaPushrodBase(rpmRange, displacementL) {
  const dispCID = litersToCID(displacementL);
  const baseTqPerCID = 1.20; // slightly lower specific than modern DOHC
  const peakTorque = baseTqPerCID * dispCID;

  const peakTqRpm = 4300;
  const peakHpRpm = 5800;

  const torque = [];
  const hp = [];

  for (const rpm of rpmRange) {
    let tq;
    if (rpm <= peakTqRpm) {
      const ratio = rpm / peakTqRpm;
      // big low-end, earlier hit
      tq = peakTorque * Math.pow(ratio, 0.75);
    } else {
      const dropRatio = (rpm - peakTqRpm) / (peakHpRpm - peakTqRpm);
      const drop = 0.18 * Math.pow(Math.max(0, Math.min(dropRatio, 1)), 1.2); // ~18% drop
      tq = peakTorque * (1 - drop);
    }
    if (rpm > peakHpRpm) {
      const extra = (rpm - peakHpRpm) / (peakHpRpm * 0.4);
      tq *= Math.max(0, 1 - 0.5 * extra); // strong falloff
    }
    torque.push(tq);
    hp.push(hpFromTorque(tq, rpm));
  }

  return { rpm: rpmRange, torque, hp };
}

// 2) NA Gasoline – OHC/DOHC multi-valve
// This one is “generic head” and we use valves & valvetrain to skew shape.
function simulateNaOHCBase(rpmRange, displacementL, valvetrainType, valvesPerCyl) {
  const dispCID = litersToCID(displacementL);

  // Base specific torque: OHC/DOHC generally a bit better than pushrod
  let baseTqPerCID = 1.18; // base
  if (valvetrainType === "dohc") baseTqPerCID += 0.04;
  if (valvesPerCyl >= 4) baseTqPerCID += 0.03;
  if (valvesPerCyl === 2) baseTqPerCID -= 0.02;

  const peakTorque = baseTqPerCID * dispCID;

  // Peak torque RPM depends on valvetrain & valves:
  // 2V SOHC = more midrange, 4V DOHC = later peak
  let basePeakTqRpm = 5500;
  if (valvetrainType === "sohc") basePeakTqRpm -= 500;
  if (valvetrainType === "dohc") basePeakTqRpm += 250;

  const valveBias = (valvesPerCyl - 2) * 300; // 2V:0, 3V:+300, 4V:+600
  const peakTqRpm = basePeakTqRpm + valveBias;

  const peakHpRpm = peakTqRpm + 1500;

  // Rise & fall exponents and drops based on “sportiness”
  const riseExp = 1.0 + 0.02 * (valvesPerCyl - 2); // more valves = more top-end bias
  let fallDrop = 0.10 - 0.015 * (valvesPerCyl - 2); // more valves = gentler drop
  fallDrop = Math.max(0.05, Math.min(fallDrop, 0.12));

  const torque = [];
  const hp = [];

  for (const rpm of rpmRange) {
    let tq;
    if (rpm <= peakTqRpm) {
      const ratio = rpm / peakTqRpm;
      tq = peakTorque * Math.pow(ratio, riseExp);
    } else {
      const dropRatio = (rpm - peakTqRpm) / (peakHpRpm - peakTqRpm);
      const drop = fallDrop * Math.max(0, Math.min(dropRatio, 1));
      tq = peakTorque * (1 - drop);
    }

    if (rpm > peakHpRpm) {
      const extra = (rpm - peakHpRpm) / (peakHpRpm * 0.5);
      // OHC falls off but not as violently as pushrod
      tq *= Math.max(0, 1 - 0.35 * extra);
    }

    torque.push(tq);
    hp.push(hpFromTorque(tq, rpm));
  }

  return { rpm: rpmRange, torque, hp };
}

// ---------- Forced-induction gasoline models (built from NA) ---------

// Turbo – Pushrod 2V style
function simulateTurboPushrod(rpmRange, displacementL, effBoostPsi) {
  const na = simulateNaPushrodBase(rpmRange, displacementL);
  const boostFactor = 1 + effBoostPsi / 14.7;

  const spoolRpm = 2300;
  const fullBoostRpm = 3200;
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
        boostFactor * (1 - 0.45 * Math.max(0, Math.min(dropRatio, 1)));
      tq = naTq * currentBoostFactor;
    }

    torque.push(tq);
    hp.push(hpFromTorque(tq, rpm));
  }

  return { rpm: rpmRange, torque, hp };
}

// Turbo – OHC/DOHC multi-valve
function simulateTurboOHC(rpmRange, displacementL, effBoostPsi, valvetrainType, valvesPerCyl) {
  const na = simulateNaOHCBase(rpmRange, displacementL, valvetrainType, valvesPerCyl);
  const boostFactor = 1 + effBoostPsi / 14.7;

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
      const drop = 0.18 * Math.max(0, Math.min(dropRatio, 1));
      tq = naTq * boostFactor * (1 - drop);
    }

    torque.push(tq);
    hp.push(hpFromTorque(tq, rpm));
  }

  return { rpm: rpmRange, torque, hp };
}

// Supercharged gasoline (Roots/Twin-screw style)
function simulateSuperchargedGasoline(
  rpmRange,
  displacementL,
  effBoostPsi,
  valvetrainType,
  valvesPerCyl
) {
  let na;
  if (valvetrainType === "pushrod") {
    na = simulateNaPushrodBase(rpmRange, displacementL);
  } else {
    na = simulateNaOHCBase(rpmRange, displacementL, valvetrainType, valvesPerCyl);
  }

  const boostFactor = 1 + effBoostPsi / 14.7;
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

// ---------- Turbo Diesel (reworked) ----------------------------------

// This is meant to model automotive / pickup truck diesels (6.7 Cummins / Powerstroke)
// or heavy-duty I6 with huge low-end plateau.
function simulateTurboDiesel(rpmRange, displacementL, effBoostPsi, compRatio, heavyDuty = true) {
  const dispCID = litersToCID(displacementL);

  // Higher base torque per CID than gas, scaled by boost
  let baseTqPerCID = heavyDuty ? 1.8 : 1.6;
  const boostFactor = 1 + effBoostPsi / 14.7;

  const peakTorque = baseTqPerCID * boostFactor * dispCID;

  let peakTqRpm, redline;
  if (heavyDuty) {
    // e.g. big commercial I6: 1200–2100 usable band
    peakTqRpm = 1500;
    redline = 2500;
  } else {
    // pickup diesel: 6.7L style
    peakTqRpm = 1800; // peak around 1.6–1.8k
    redline = 3800;   // many shift ~3400–3600
  }

  const plateauStart = heavyDuty ? peakTqRpm : 1600;
  const plateauEnd = heavyDuty ? 2100 : 2800;

  const torque = [];
  const hp = [];

  for (const rpm of rpmRange) {
    let tq;

    if (rpm <= peakTqRpm) {
      // Very strong early rise, but not from zero
      const minFrac = 0.5; // 50% of peak by ~idle–1000
      const ratio = rpm / peakTqRpm;
      tq = peakTorque * (minFrac + (1 - minFrac) * Math.pow(ratio, 0.7));
    } else if (rpm <= plateauEnd) {
      // Flat-ish plateau
      tq = peakTorque * (1 - 0.05 * ((rpm - plateauStart) / (plateauEnd - plateauStart))); // tiny slope
    } else {
      // After usable band, falloff but not insta-dead
      const fallRange = redline - plateauEnd;
      const fallRatio = Math.max(0, Math.min((rpm - plateauEnd) / fallRange, 1));
      // keep ~60% of peak by redline
      const frac = 1 - 0.4 * Math.pow(fallRatio, 1.2);
      tq = peakTorque * frac;
    }

    torque.push(tq);
    hp.push(hpFromTorque(tq, rpm));
  }

  return { rpm: rpmRange, torque, hp };
}

// ---------- Methanol racing ------------------------------------------

// High-output DOHC-style base with methanol’s octane & cooling
function simulateMethanolRacing(rpmRange, displacementL, compRatio, effBoostPsi) {
  const na = simulateNaOHCBase(rpmRange, displacementL, "dohc", 4);

  // Fuel factor: +15% torque vs similar gasoline
  const fuelFactor = 1.15;
  const boostFactor = 1 + effBoostPsi / 14.7;

  const torque = [];
  const hp = [];
  const maxRpm = rpmRange[rpmRange.length - 1];

  for (let i = 0; i < rpmRange.length; i++) {
    const rpm = rpmRange[i];
    let tq = na.torque[i] * fuelFactor * boostFactor;

    // Methanol holds torque at high rpm; small bump towards the top
    if (rpm > 0.8 * maxRpm) {
      const extra = (rpm - 0.8 * maxRpm) / (0.2 * maxRpm);
      tq *= 1 + 0.05 * Math.max(0, Math.min(extra, 1));
    }

    torque.push(tq);
    hp.push(hpFromTorque(tq, rpm));
  }

  return { rpm: rpmRange, torque, hp };
}

// ---------- Main dispatcher + penalties ------------------------------ 

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

  // Get compression & effective boost scaling
  const { compFactor, effBoostPsi } = getCompressionBoostScaling(
    fuelType,
    inductionType,
    compRatio,
    boostPsi
  );

  // Base model (without VE/size/piston penalties, but WITH boost shape)
  let base;

  if (fuelType === "diesel") {
    const heavy = displacementL >= 8.0; // treat 6.7 as light-duty
    base = simulateTurboDiesel(rpmRange, displacementL, effBoostPsi || 18, compRatio, heavy);
  } else if (fuelType === "methanol") {
    base = simulateMethanolRacing(rpmRange, displacementL, compRatio || 13, effBoostPsi || 0);
  } else {
    // gasoline
    if (inductionType === "na") {
      if (valvetrainType === "pushrod") {
        base = simulateNaPushrodBase(rpmRange, displacementL);
      } else {
        base = simulateNaOHCBase(rpmRange, displacementL, valvetrainType, valvesPerCyl);
      }
    } else if (inductionType === "turbo") {
      if (valvetrainType === "pushrod") {
        base = simulateTurboPushrod(rpmRange, displacementL, effBoostPsi || 7);
      } else {
        base = simulateTurboOHC(
          rpmRange,
          displacementL,
          effBoostPsi || 7,
          valvetrainType,
          valvesPerCyl
        );
      }
    } else if (inductionType === "supercharger") {
      base = simulateSuperchargedGasoline(
        rpmRange,
        displacementL,
        effBoostPsi || 7,
        valvetrainType,
        valvesPerCyl
      );
    } else {
      base = simulateNaOHCBase(rpmRange, displacementL, valvetrainType, valvesPerCyl);
    }
  }

  // Global VE & size & piston-speed penalties
  const veRef = 0.95; // reference
  const veScale = (vePeak / 100) / veRef;

  let sizeScale = 1;
  if (displacementL > 2 && sizePenalty > 0) {
    const penalty = (sizePenalty / 100) * (displacementL - 2);
    sizeScale = Math.max(0.65, 1 - penalty);
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

    const globalScale = compFactor * veScale * sizeScale * pistonScale;

    const tq = base.torque[i] * globalScale;
    const h = hpFromTorque(tq, rpm);

    torque.push(tq);
    hp.push(h);
  }

  return { rpm: base.rpm, torque, hp };
}

// ---------- Form + UI wiring ----------------------------------------- 

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

  const compRatio = parseFloat(getVal("compressionRatio")) || 10.5;
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

// ---------- Chart.js -------------------------------------------------- 

function initChart() {
  const ctx = document.getElementById("powerChart");
  if (!ctx) return;

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

// ---------- Table + Summary ------------------------------------------ 

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

// ---------- Geometry → displacement helper --------------------------- 

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
