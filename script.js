// script.js – Engine Simulator v4
// BMEP → Torque → Horsepower, mode-first design

let powerChart = null;

/* =========================================================================
   BOOTSTRAP
   ========================================================================= */

document.addEventListener("DOMContentLoaded", () => {
  console.log("Engine Simulator v4 loaded");

  const form = document.getElementById("engine-form");
  if (form) {
    form.addEventListener("submit", onFormSubmit);
  }

  // geometry → displacement
  ["boreMm", "strokeMm", "cylinders"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", updateDisplacementFromGeometry);
  });
  updateDisplacementFromGeometry();

  // mode change → sensible defaults
  const modeSelect = document.getElementById("engineMode");
  if (modeSelect) {
    modeSelect.addEventListener("change", () => {
      applyModeDefaults(modeSelect.value);
    });
    applyModeDefaults(modeSelect.value);
  }

  // presets
  const presetSelect = document.getElementById("presetSelect");
  if (presetSelect) {
    presetSelect.addEventListener("change", () => {
      applyPreset(presetSelect.value);
    });
  }

  initChart();
});

/* =========================================================================
   BASIC MATH HELPERS
   ========================================================================= */

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

function bmepPsiFromTorque(torqueLbFt, displacementL) {
  if (!displacementL || displacementL <= 0) return 0;
  // BMEP(psi) ≈ 150.8 * T(lb-ft) / Vd(L)
  return (150.8 * torqueLbFt) / displacementL;
}

function torqueFromBmepBar(bmepBar, displacementL) {
  if (!displacementL || displacementL <= 0) return 0;
  const Vd_m3 = displacementL / 1000;  // L → m^3
  const bmepPa = bmepBar * 1e5;       // bar → Pa
  const torqueNm = (bmepPa * Vd_m3) / (4 * Math.PI);
  const torqueLbFt = torqueNm / 1.35581795;
  return torqueLbFt;
}

function cfmAtRpm(displacementL, rpm, veFrac) {
  const dispCID = litersToCID(displacementL);
  const cfm100 = (dispCID * rpm) / 3456;
  return cfm100 * veFrac;
}

function meanPistonSpeed(strokeMm, rpm) {
  if (!strokeMm || strokeMm <= 0) return 0;
  const strokeM = strokeMm / 1000;
  return (2 * strokeM * rpm) / 60;
}

/* =========================================================================
   FUEL & BSFC
   ========================================================================= */

function getBsfc(fuelType, inductionType) {
  // Crude but “reasonable” BSFC bands
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

/* =========================================================================
   MODE CONFIG (FUEL TYPE, REFERENCE BMEP)
   ========================================================================= */

function getModeConfig(engineMode) {
  switch (engineMode) {
    case "gas_na":
      return {
        fuelType: "gasoline",
        bmepRefBar: 13,   // decent NA gas
      };
    case "gas_turbo":
      return {
        fuelType: "gasoline",
        bmepRefBar: 20,   // good turbo gas
      };
    case "gas_sc":
      return {
        fuelType: "gasoline",
        bmepRefBar: 19,   // SC gas
      };
    case "diesel_turbo":
      return {
        fuelType: "diesel",
        bmepRefBar: 24,   // boosted diesel
      };
    case "methanol_race":
      return {
        fuelType: "methanol",
        bmepRefBar: 18,   // hot NA/turbo methanol
      };
    default:
      return {
        fuelType: "gasoline",
        bmepRefBar: 13,
      };
  }
}

/* =========================================================================
   MODE-BASED DEFAULTS (UX)
   ========================================================================= */

function applyModeDefaults(mode) {
  const compEl   = document.getElementById("compressionRatio");
  const redEl    = document.getElementById("redlineRpm");
  const veEl     = document.getElementById("vePeak");
  const sizePenEl= document.getElementById("sizePenalty");
  const pistEl   = document.getElementById("pistonSpeedLimit");
  const boostEl  = document.getElementById("boostPsi");
  const vtEl     = document.getElementById("valvetrainType");
  const valvesEl = document.getElementById("valvesPerCyl");
  const methIndEl= document.getElementById("methanolInduction");

  if (!compEl || !redEl || !veEl || !sizePenEl || !pistEl || !boostEl) return;

  if (mode === "gas_na") {
    compEl.value = 10.5;
    redEl.value = 7000;
    veEl.value = 95;
    sizePenEl.value = 3;
    pistEl.value = 25;
    boostEl.value = 0;
    if (vtEl) vtEl.value = "dohc";
    if (valvesEl) valvesEl.value = "4";
  } else if (mode === "gas_turbo") {
    compEl.value = 9.5;
    redEl.value = 7000;
    veEl.value = 100;
    sizePenEl.value = 3;
    pistEl.value = 25;
    boostEl.value = 18;
    if (vtEl) vtEl.value = "dohc";
    if (valvesEl) valvesEl.value = "4";
  } else if (mode === "gas_sc") {
    compEl.value = 10.0;
    redEl.value = 6800;
    veEl.value = 100;
    sizePenEl.value = 3;
    pistEl.value = 24;
    boostEl.value = 10;
    if (vtEl) vtEl.value = "sohc";
    if (valvesEl) valvesEl.value = "4";
  } else if (mode === "diesel_turbo") {
    compEl.value = 17.0;
    redEl.value = 3800;
    veEl.value = 95;
    sizePenEl.value = 2;
    pistEl.value = 20;
    boostEl.value = 25;
    if (vtEl) vtEl.value = "sohc";
    if (valvesEl) valvesEl.value = "4";
  } else if (mode === "methanol_race") {
    compEl.value = 13.5;
    redEl.value = 8500;
    veEl.value = 105;
    sizePenEl.value = 1;
    pistEl.value = 28;
    boostEl.value = 20;
    if (vtEl) vtEl.value = "dohc";
    if (valvesEl) valvesEl.value = "4";
    if (methIndEl) methIndEl.value = "na";
  }
}

/* =========================================================================
   COMPRESSION / BOOST INTERACTION
   ========================================================================= */

function getEffectiveBoostAndCompFactor(fuelType, inductionType, compRatio, boostPsi) {
  let effBoostPsi = boostPsi;
  let compFactor  = 1.0;

  if (fuelType === "gasoline") {
    if (inductionType === "na") {
      const ideal = 10.8;
      const delta = compRatio - ideal;
      compFactor = 1 - 0.01 * delta * delta;
      compFactor = Math.max(0.9, Math.min(compFactor, 1.05));
      effBoostPsi = 0;
    } else {
      // Turbo / SC gas – crude knock-limited behavior
      const idealCr  = 9.5;
      const deltaCr  = compRatio - idealCr;
      compFactor     = 1 - 0.015 * Math.abs(deltaCr);
      compFactor     = Math.max(0.85, Math.min(compFactor, 1.02));

      const baseSafe = inductionType === "turbo" ? 22 : 18;
      const safeBoostPsi = Math.max(0, baseSafe - 5 * Math.max(0, compRatio - idealCr));
      effBoostPsi = Math.min(boostPsi, safeBoostPsi);
    }
  } else if (fuelType === "diesel") {
    const ideal = 17;
    const delta = compRatio - ideal;
    compFactor = 1 - 0.01 * Math.abs(delta);
    compFactor = Math.max(0.9, Math.min(compFactor, 1.05));
    effBoostPsi = boostPsi;
  } else if (fuelType === "methanol") {
    const ideal = 13.5;
    const delta = compRatio - ideal;
    compFactor = 1 + 0.01 * delta;
    compFactor = Math.max(0.9, Math.min(compFactor, 1.1));
    effBoostPsi = boostPsi;
  }

  return { effBoostPsi, compFactor };
}

/* =========================================================================
   GASOLINE – NA
   ========================================================================= */

function simulateGasolineNa(rpmRange, cfg, bmepRefBar) {
  const {
    displacementL,
    redline,
    vePeak,
    sizePenalty,
    valvetrainType,
    valvesPerCyl,
    compRatio,
    boreMm,
    strokeMm,
  } = cfg;

  let basePeakBmepBar = bmepRefBar; // ~13 bar baseline

  // Tech factor – valvetrain & valves
  let techFactor = 1.0;
  if (valvetrainType === "pushrod") techFactor *= 0.95;
  if (valvetrainType === "sohc")    techFactor *= 1.00;
  if (valvetrainType === "dohc")    techFactor *= 1.05;
  if (valvesPerCyl === 2)           techFactor *= 0.95;
  if (valvesPerCyl === 4)           techFactor *= 1.05;

  // Size factor – bigger NA engines usually lower hp/L
  let sizeFactor = 1.0;
  if (displacementL > 2 && sizePenalty > 0) {
    const penalty = (sizePenalty / 100) * (displacementL - 2);
    sizeFactor = Math.max(0.75, 1 - penalty);
  }

  // VE factor around NA baseline
  const veFactor = (vePeak / 100) / 0.95;

  // Compression factor
  const idealCr = 10.8;
  const deltaCr = compRatio - idealCr;
  let crFactor = 1 - 0.01 * deltaCr * deltaCr;
  crFactor = Math.max(0.9, Math.min(crFactor, 1.05));

  // Stroke bias – long stroke = more low, less high
  const boreStrokeRatio = boreMm > 0 && strokeMm > 0 ? boreMm / strokeMm : 1.0;
  let lowRpmBias = 1.0;
  let highRpmBias = 1.0;
  if (boreStrokeRatio < 0.95) {
    // long stroke
    lowRpmBias  = 1.05;
    highRpmBias = 0.95;
  } else if (boreStrokeRatio > 1.05) {
    // oversquare
    lowRpmBias  = 0.95;
    highRpmBias = 1.05;
  }

  const peakBmepBar =
    basePeakBmepBar * techFactor * sizeFactor * veFactor * crFactor;

  // Position of peak torque
  let ratioPeakTq;
  if (valvetrainType === "pushrod") ratioPeakTq = 0.55;
  else if (valvetrainType === "sohc") ratioPeakTq = 0.65;
  else ratioPeakTq = 0.70;

  if (valvesPerCyl === 2) ratioPeakTq -= 0.05;
  if (valvesPerCyl === 4) ratioPeakTq += 0.03;

  // apply bore/stroke bias
  ratioPeakTq *= boreStrokeRatio < 1 ? 0.95 : 1.05;
  ratioPeakTq = Math.max(0.45, Math.min(ratioPeakTq, 0.8));

  const rpmPeakTq = ratioPeakTq * redline;
  const rpmMin    = rpmRange[0];
  const rpmMax    = rpmRange[rpmRange.length - 1];

  const bmepBarArr = [];
  const torqueArr  = [];
  const hpArr      = [];

  for (const rpm of rpmRange) {
    let frac;

    if (rpm <= rpmPeakTq) {
      const x = (rpm - rpmMin) / (rpmPeakTq - rpmMin);
      const lowBase = 0.40 * lowRpmBias;
      const exp =
        valvetrainType === "pushrod" ? 0.75 :
        valvetrainType === "sohc"    ? 0.90 : 1.05;
      frac = lowBase + (1 - lowBase) * Math.pow(Math.max(0, Math.min(x, 1)), exp);
    } else {
      const x = (rpm - rpmPeakTq) / (rpmMax - rpmPeakTq);
      const exp =
        valvetrainType === "pushrod" ? 1.35 :
        valvetrainType === "sohc"    ? 1.15 : 1.05;
      const highFloor = 0.30 * highRpmBias;
      frac = 1 - (1 - highFloor) * Math.pow(Math.max(0, Math.min(x, 1)), exp);
    }

    const bmepBar = peakBmepBar * frac;
    const tq      = torqueFromBmepBar(bmepBar, displacementL);
    const hp      = hpFromTorque(tq, rpm);

    bmepBarArr.push(bmepBar);
    torqueArr.push(tq);
    hpArr.push(hp);
  }

  return { rpm: rpmRange, torque: torqueArr, hp: hpArr, bmepBarArr };
}

/* =========================================================================
   GASOLINE – TURBO
   ========================================================================= */

function simulateGasolineTurbo(rpmRange, cfg, bmepRefBar, effBoostPsi, compFactor) {
  const {
    displacementL,
    redline,
    vePeak,
    sizePenalty,
    valvetrainType,
    valvesPerCyl,
    boreMm,
    strokeMm,
  } = cfg;

  // NA baseline
  const baseNaBmepBar = 12.5;

  // Valvetrain / valves tech factor
  let techFactor = 1.0;
  if (valvetrainType === "pushrod") techFactor *= 0.93;
  if (valvetrainType === "sohc")    techFactor *= 1.00;
  if (valvetrainType === "dohc")    techFactor *= 1.05;
  if (valvesPerCyl === 2)           techFactor *= 0.95;
  if (valvesPerCyl === 4)           techFactor *= 1.05;

  // Size factor (big turbo engines still lower hp/L usually)
  let sizeFactor = 1.0;
  if (displacementL > 2 && sizePenalty > 0) {
    const penalty = (sizePenalty / 100) * (displacementL - 2);
    sizeFactor = Math.max(0.75, 1 - penalty);
  }

  // VE factor
  const veFactor = (vePeak / 100) / 1.0; // allow >100% for turbo

  // Boost → BMEP gain
  const boostGainPerPsi = 0.45;  // ~0.45 bar BMEP per psi is high but in “fun” territory
  let boostedBmepBar = baseNaBmepBar + boostGainPerPsi * effBoostPsi;
  boostedBmepBar = Math.min(boostedBmepBar, 22); // upper cap for typical street turbo gas

  const peakBmepBar =
    boostedBmepBar * techFactor * sizeFactor * veFactor * compFactor;

  const rpmMin = rpmRange[0];
  const rpmMax = rpmRange[rpmRange.length - 1];

  // Spool & plateau
  const spoolStart   = Math.max(rpmMin + 300, redline * 0.25);
  const fullBoostRpm = redline * 0.45;
  const plateauEnd   = redline * 0.75;

  const boreStrokeRatio = boreMm > 0 && strokeMm > 0 ? boreMm / strokeMm : 1.0;

  const bmepBarArr = [];
  const torqueArr  = [];
  const hpArr      = [];

  for (const rpm of rpmRange) {
    let frac;

    if (rpm < spoolStart) {
      // off-boost
      const x = (rpm - rpmMin) / (spoolStart - rpmMin);
      const lowBase = 0.35;
      const exp = 0.9;
      frac = lowBase + (0.7 - lowBase) * Math.pow(Math.max(0, Math.min(x, 1)), exp);
    } else if (rpm < fullBoostRpm) {
      // building boost
      const x = (rpm - spoolStart) / (fullBoostRpm - spoolStart);
      frac = 0.7 + 0.3 * Math.max(0, Math.min(x, 1));
    } else if (rpm <= plateauEnd) {
      // full boost plateau – oversquare engines hold slightly better
      let plateau = 1.0;
      if (boreStrokeRatio > 1.05) plateau = 1.02;
      if (boreStrokeRatio < 0.95) plateau = 0.98;
      frac = plateau;
    } else {
      // high rpm fall-off
      const x = (rpm - plateauEnd) / (rpmMax - plateauEnd);
      const exp = 1.15;
      const highFloor = 0.55;
      frac = 1 - (1 - highFloor) * Math.pow(Math.max(0, Math.min(x, 1)), exp);
    }

    const bmepBar = peakBmepBar * frac;
    const tq      = torqueFromBmepBar(bmepBar, displacementL);
    const hp      = hpFromTorque(tq, rpm);

    bmepBarArr.push(bmepBar);
    torqueArr.push(tq);
    hpArr.push(hp);
  }

  return { rpm: rpmRange, torque: torqueArr, hp: hpArr, bmepBarArr };
}

/* =========================================================================
   GASOLINE – SUPERCHARGED
   ========================================================================= */

function simulateGasolineSupercharged(rpmRange, cfg, bmepRefBar, effBoostPsi, compFactor) {
  const {
    displacementL,
    redline,
    vePeak,
    sizePenalty,
    valvetrainType,
    valvesPerCyl,
  } = cfg;

  const baseNaBmepBar = 12.5;

  let techFactor = 1.0;
  if (valvetrainType === "pushrod") techFactor *= 0.97;
  if (valvetrainType === "dohc")    techFactor *= 1.03;
  if (valvesPerCyl === 2)           techFactor *= 0.97;
  if (valvesPerCyl === 4)           techFactor *= 1.03;

  let sizeFactor = 1.0;
  if (displacementL > 2 && sizePenalty > 0) {
    const penalty = (sizePenalty / 100) * (displacementL - 2);
    sizeFactor = Math.max(0.75, 1 - penalty);
  }

  const veFactor = (vePeak / 100) / 1.0;

  const boostGainPerPsi = 0.40;
  let boostedBmepBar = baseNaBmepBar + boostGainPerPsi * effBoostPsi;
  boostedBmepBar = Math.min(boostedBmepBar, 20);

  const peakBmepBar =
    boostedBmepBar * techFactor * sizeFactor * veFactor * compFactor;

  const rpmMin = rpmRange[0];
  const rpmMax = rpmRange[rpmRange.length - 1];

  const bmepBarArr = [];
  const torqueArr  = [];
  const hpArr      = [];

  for (const rpm of rpmRange) {
    let frac;
    if (rpm < 1500) {
      const x = (rpm - rpmMin) / (1500 - rpmMin);
      const lowBase = 0.6;
      frac = lowBase + (0.98 - lowBase) * Math.max(0, Math.min(x, 1));
    } else {
      const x = (rpm - 1500) / (rpmMax - 1500);
      const highFloor = 0.65;
      const exp = 1.2;
      frac = 0.98 - (0.98 - highFloor) * Math.pow(Math.max(0, Math.min(x, 1)), exp);
    }

    const bmepBar = peakBmepBar * frac;
    const tq      = torqueFromBmepBar(bmepBar, displacementL);
    const hp      = hpFromTorque(tq, rpm);

    bmepBarArr.push(bmepBar);
    torqueArr.push(tq);
    hpArr.push(hp);
  }

  return { rpm: rpmRange, torque: torqueArr, hp: hpArr, bmepBarArr };
}

/* =========================================================================
   DIESEL – TURBO
   ========================================================================= */

function simulateDieselTurbo(rpmRange, cfg, bmepRefBar, effBoostPsi, compFactor) {
  const {
    displacementL,
    redline,
    vePeak,
    sizePenalty,
    compRatio,
  } = cfg;

  const baseNaBmepBar = 12;  // “NA” diesel effective baseline

  const heavyDuty = displacementL >= 8.0;
  const boostGainPerPsi = heavyDuty ? 0.45 : 0.50;

  let boostedBmepBar = baseNaBmepBar + boostGainPerPsi * effBoostPsi;
  boostedBmepBar = Math.min(boostedBmepBar, heavyDuty ? 28 : 26);

  const veFactor = (vePeak / 100) / 0.95;

  let sizeFactor = 1.0;
  if (displacementL > 6 && sizePenalty > 0) {
    const penalty = (sizePenalty / 100) * (displacementL - 6);
    sizeFactor = Math.max(0.80, 1 - penalty);
  }

  const idealCr = 17;
  const deltaCr = compRatio - idealCr;
  let crFactor = 1 - 0.01 * Math.abs(deltaCr);
  crFactor = Math.max(0.9, Math.min(crFactor, 1.05));

  const peakBmepBar =
    boostedBmepBar * veFactor * sizeFactor * crFactor * compFactor;

  const rpmMin = rpmRange[0];
  const rpmMax = rpmRange[rpmRange.length - 1];
  const rpmPeakTq  = heavyDuty ? redline * 0.35 : redline * 0.4;
  const plateauEnd = heavyDuty ? redline * 0.55 : redline * 0.6;

  const bmepBarArr = [];
  const torqueArr  = [];
  const hpArr      = [];

  for (const rpm of rpmRange) {
    let frac;
    if (rpm <= rpmPeakTq) {
      const x = (rpm - rpmMin) / (rpmPeakTq - rpmMin);
      const lowBase = 0.6;
      frac = lowBase + (1 - lowBase) * Math.pow(Math.max(0, Math.min(x, 1)), 0.7);
    } else if (rpm <= plateauEnd) {
      const x = (rpm - rpmPeakTq) / (plateauEnd - rpmPeakTq);
      frac = 1 - 0.05 * Math.max(0, Math.min(x, 1));  // gentle sag
    } else {
      const x = (rpm - plateauEnd) / (rpmMax - plateauEnd);
      const highFloor = 0.55;
      frac = 0.95 - (0.95 - highFloor) * Math.pow(Math.max(0, Math.min(x, 1)), 1.1);
    }

    const bmepBar = peakBmepBar * frac;
    const tq      = torqueFromBmepBar(bmepBar, displacementL);
    const hp      = hpFromTorque(tq, rpm);

    bmepBarArr.push(bmepBar);
    torqueArr.push(tq);
    hpArr.push(hp);
  }

  return { rpm: rpmRange, torque: torqueArr, hp: hpArr, bmepBarArr };
}

/* =========================================================================
   METHANOL – RACE (NA / TURBO)
   ========================================================================= */

function simulateMethanol(rpmRange, cfg, bmepRefBar, effBoostPsi, compFactor, inductionType) {
  const {
    displacementL,
    redline,
    vePeak,
    sizePenalty,
    compRatio,
  } = cfg;

  let baseNaBmepBar = 15;        // strong NA baseline
  const boostGainPerPsi = 0.50;  // meth can go hard

  let boostedBmepBar = baseNaBmepBar;
  if (inductionType === "turbo") {
    boostedBmepBar += boostGainPerPsi * effBoostPsi;
  }
  boostedBmepBar = Math.min(boostedBmepBar, inductionType === "turbo" ? 24 : 18);

  const veFactor = (vePeak / 100) / 1.0;

  let sizeFactor = 1.0;
  if (displacementL > 3 && sizePenalty > 0) {
    const penalty = (sizePenalty / 100) * (displacementL - 3);
    sizeFactor = Math.max(0.80, 1 - penalty);
  }

  const idealCr = 13.5;
  const deltaCr = compRatio - idealCr;
  let crFactor = 1 + 0.01 * deltaCr;
  crFactor = Math.max(0.9, Math.min(crFactor, 1.1));

  const peakBmepBar =
    boostedBmepBar * veFactor * sizeFactor * crFactor * compFactor;

  const rpmMin = rpmRange[0];
  const rpmMax = rpmRange[rpmRange.length - 1];
  const rpmPeakTq = redline * 0.7;

  const bmepBarArr = [];
  const torqueArr  = [];
  const hpArr      = [];

  for (const rpm of rpmRange) {
    let frac;
    if (rpm <= rpmPeakTq) {
      const x = (rpm - rpmMin) / (rpmPeakTq - rpmMin);
      const lowBase = 0.3;
      frac = lowBase + (1 - lowBase) * Math.pow(Math.max(0, Math.min(x, 1)), 1.2);
    } else {
      const x = (rpm - rpmPeakTq) / (rpmMax - rpmPeakTq);
      const highFloor = 0.7;
      frac = 1 - (1 - highFloor) * Math.pow(Math.max(0, Math.min(x, 1)), 0.8);
    }

    const bmepBar = peakBmepBar * frac;
    const tq      = torqueFromBmepBar(bmepBar, displacementL);
    const hp      = hpFromTorque(tq, rpm);

    bmepBarArr.push(bmepBar);
    torqueArr.push(tq);
    hpArr.push(hp);
  }

  return { rpm: rpmRange, torque: torqueArr, hp: hpArr, bmepBarArr };
}

/* =========================================================================
   MASTER SIM DRIVER
   ========================================================================= */

function simulateEngine(cfg) {
  const {
    engineMode,
    displacementL,
    compRatio,
    redline,
    rpmStep,
    vePeak,
    sizePenalty,
    pistonSpeedLimit,
    strokeMm,
    valvetrainType,
    valvesPerCyl,
    boostPsi,
    methanolInduction,
    boreMm,
  } = cfg;

  const modeMeta  = getModeConfig(engineMode);
  const fuelType  = modeMeta.fuelType;
  const bmepRefBar= modeMeta.bmepRefBar;

  const rpmRange = createRpmRange(redline, rpmStep, 1000);

  let inductionType = "na";
  if (engineMode === "gas_na")       inductionType = "na";
  else if (engineMode === "gas_turbo")   inductionType = "turbo";
  else if (engineMode === "gas_sc")      inductionType = "supercharger";
  else if (engineMode === "diesel_turbo")inductionType = "turbo";
  else if (engineMode === "methanol_race")
    inductionType = methanolInduction || "na";

  const { effBoostPsi, compFactor } = getEffectiveBoostAndCompFactor(
    fuelType,
    inductionType,
    compRatio,
    boostPsi
  );

  const simCfg = {
    displacementL,
    redline,
    vePeak,
    sizePenalty,
    valvetrainType,
    valvesPerCyl,
    compRatio,
    boreMm,
    strokeMm,
  };

  let baseResult;
  if (fuelType === "diesel") {
    baseResult = simulateDieselTurbo(rpmRange, simCfg, bmepRefBar, effBoostPsi, compFactor);
  } else if (fuelType === "methanol") {
    baseResult = simulateMethanol(
      rpmRange,
      simCfg,
      bmepRefBar,
      effBoostPsi,
      compFactor,
      inductionType
    );
  } else {
    // gasoline paths
    if (engineMode === "gas_na") {
      baseResult = simulateGasolineNa(rpmRange, simCfg, bmepRefBar);
    } else if (engineMode === "gas_turbo") {
      baseResult = simulateGasolineTurbo(
        rpmRange,
        simCfg,
        bmepRefBar,
        effBoostPsi,
        compFactor
      );
    } else if (engineMode === "gas_sc") {
      baseResult = simulateGasolineSupercharged(
        rpmRange,
        simCfg,
        bmepRefBar,
        effBoostPsi,
        compFactor
      );
    } else {
      baseResult = simulateGasolineNa(rpmRange, simCfg, bmepRefBar);
    }
  }

  // Piston-speed penalty (applied after base mode curves)
  const torqueArr   = [];
  const hpArr       = [];
  const bmepBarArr2 = [];

  for (let i = 0; i < baseResult.rpm.length; i++) {
    const rpm = baseResult.rpm[i];
    const ps  = meanPistonSpeed(strokeMm, rpm);

    let psFactor = 1.0;
    if (pistonSpeedLimit > 0 && ps > pistonSpeedLimit) {
      const excess = (ps - pistonSpeedLimit) / pistonSpeedLimit;
      psFactor = Math.max(0.6, 1 - 0.6 * excess);
    }

    const adjustedTorque = baseResult.torque[i] * psFactor;
    const adjustedHp     = hpFromTorque(adjustedTorque, rpm);

    torqueArr.push(adjustedTorque);
    hpArr.push(adjustedHp);

    const bmepPsiVal = bmepPsiFromTorque(adjustedTorque, displacementL);
    const bmepBar    = bmepPsiVal * 0.0689476;
    bmepBarArr2.push(bmepBar);
  }

  return {
    rpm: baseResult.rpm,
    torque: torqueArr,
    hp: hpArr,
    bmepBarArr: bmepBarArr2,
    bmepRefBar,
    fuelType,
    inductionType,
  };
}

/* =========================================================================
   FORM → CONFIG
   ========================================================================= */

function readConfigFromForm() {
  const getVal = (id) => {
    const el = document.getElementById(id);
    return el ? el.value : "";
  };

  const engineMode = getVal("engineMode") || "gas_na";

  const cylinders = parseInt(getVal("cylinders")) || 4;
  const boreMm    = parseFloat(getVal("boreMm")) || 0;
  const strokeMm  = parseFloat(getVal("strokeMm")) || 0;

  let displacementL = parseFloat(getVal("displacementL")) || 0;
  if (!displacementL) {
    displacementL = litersFromBoreStroke(boreMm, strokeMm, cylinders);
    const dispEl = document.getElementById("displacementL");
    if (dispEl && displacementL) dispEl.value = displacementL.toFixed(2);
  }

  const compRatio        = parseFloat(getVal("compressionRatio")) || 10.5;
  const redline          = parseInt(getVal("redlineRpm")) || 7000;
  const rpmStep          = parseInt(getVal("rpmStep")) || 250;
  const vePeak           = parseFloat(getVal("vePeak")) || 95;
  const sizePenalty      = parseFloat(getVal("sizePenalty")) || 0;
  const pistonSpeedLimit = parseFloat(getVal("pistonSpeedLimit")) || 0;
  const boostPsi         = parseFloat(getVal("boostPsi")) || 0;
  const methanolInduction= getVal("methanolInduction") || "na";
  const valvetrainType   = getVal("valvetrainType") || "dohc";
  const valvesPerCyl     = parseInt(getVal("valvesPerCyl")) || 4;

  return {
    engineMode,
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
    boostPsi,
    methanolInduction,
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
    result.bmepBarArr,
    result.bmepRefBar,
    cfg.displacementL,
    cfg.strokeMm,
    result.fuelType,
    result.inductionType
  );
  updateSummary(
    result.rpm,
    result.torque,
    result.hp,
    result.bmepBarArr,
    result.bmepRefBar,
    cfg.displacementL,
    result.fuelType,
    result.inductionType
  );
}

/* =========================================================================
   CHART
   ========================================================================= */

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

/* =========================================================================
   TABLE & SUMMARY
   ========================================================================= */

function updateResultsTable(
  rpmArr,
  torqueArr,
  hpArr,
  bmepBarArr,
  bmepRefBar,
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

  const bsfc    = getBsfc(fuelType, inductionType);
  const density = getFuelDensityLbPerGal(fuelType);

  for (let i = 0; i < rpmArr.length; i++) {
    const rpm      = rpmArr[i];
    const tq       = torqueArr[i];
    const hp       = hpArr[i];
    const bmepBar  = bmepBarArr[i];

    let veFrac = bmepRefBar > 0 ? bmepBar / bmepRefBar : 1.0;
    veFrac = Math.max(0.6, Math.min(veFrac, 1.2));

    const ps          = meanPistonSpeed(strokeMm, rpm);
    const bmepPsiVal  = bmepPsiFromTorque(tq, displacementL);
    const cfm         = cfmAtRpm(displacementL, rpm, veFrac);
    const fuelLbHr    = hp > 0 ? hp * bsfc : 0;
    const fuelGalHr   = fuelLbHr / density;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${rpm}</td>
      <td>${hp.toFixed(1)}</td>
      <td>${tq.toFixed(1)}</td>
      <td>${(veFrac * 100).toFixed(0)}</td>
      <td>${ps.toFixed(2)}</td>
      <td>${bmepPsiVal.toFixed(1)}</td>
      <td>${cfm.toFixed(0)}</td>
      <td>${fuelLbHr.toFixed(1)}</td>
      <td>${fuelGalHr.toFixed(2)}</td>
    `;
    tbody.appendChild(tr);
  }
}

function updateSummary(
  rpmArr,
  torqueArr,
  hpArr,
  bmepBarArr,
  bmepRefBar,
  displacementL,
  fuelType,
  inductionType
) {
  const peakHpSpan      = document.getElementById("peakHp");
  const peakHpRpmSpan   = document.getElementById("peakHpRpm");
  const peakTqSpan      = document.getElementById("peakTq");
  const peakTqRpmSpan   = document.getElementById("peakTqRpm");
  const hpPerLSpan      = document.getElementById("hpPerL");
  const fuelPeakLbSpan  = document.getElementById("fuelPeakLb");
  const fuelPeakGalSpan = document.getElementById("fuelPeakGal");
  const bmepPeakPsiSpan = document.getElementById("bmepPeakPsi");
  const cfmPeakSpan     = document.getElementById("cfmPeak");

  let peakHp = -Infinity;
  let peakHpRpm = 0;
  let peakTq = -Infinity;
  let peakTqRpm = 0;

  for (let i = 0; i < rpmArr.length; i++) {
    if (hpArr[i] > peakHp) {
      peakHp    = hpArr[i];
      peakHpRpm = rpmArr[i];
    }
    if (torqueArr[i] > peakTq) {
      peakTq    = torqueArr[i];
      peakTqRpm = rpmArr[i];
    }
  }

  const hpPerL      = displacementL > 0 ? peakHp / displacementL : 0;
  const bmepPeakPsi = bmepPsiFromTorque(peakTq, displacementL);
  const bmepPeakBar = bmepPeakPsi * 0.0689476;

  let veFracPeak = bmepRefBar > 0 ? bmepPeakBar / bmepRefBar : 1.0;
  veFracPeak = Math.max(0.6, Math.min(veFracPeak, 1.2));
  const cfmAtPeak = cfmAtRpm(displacementL, peakTqRpm, veFracPeak);

  const bsfc    = getBsfc(fuelType, inductionType);
  const density = getFuelDensityLbPerGal(fuelType);
  const fuelLbHr  = peakHp > 0 ? peakHp * bsfc : 0;
  const fuelGalHr = fuelLbHr / density;

  if (peakHpSpan)      peakHpSpan.textContent      = peakHp.toFixed(1);
  if (peakHpRpmSpan)   peakHpRpmSpan.textContent   = peakHpRpm;
  if (peakTqSpan)      peakTqSpan.textContent      = peakTq.toFixed(1);
  if (peakTqRpmSpan)   peakTqRpmSpan.textContent   = peakTqRpm;
  if (hpPerLSpan)      hpPerLSpan.textContent      = hpPerL.toFixed(1);
  if (bmepPeakPsiSpan) bmepPeakPsiSpan.textContent = bmepPeakPsi.toFixed(1);
  if (cfmPeakSpan)     cfmPeakSpan.textContent     = cfmAtPeak.toFixed(0);
  if (fuelPeakLbSpan)  fuelPeakLbSpan.textContent  = fuelLbHr.toFixed(1);
  if (fuelPeakGalSpan) fuelPeakGalSpan.textContent = fuelGalHr.toFixed(2);
}

/* =========================================================================
   GEOMETRY → DISPLACEMENT
   ========================================================================= */

function updateDisplacementFromGeometry() {
  const cylEl   = document.getElementById("cylinders");
  const boreEl  = document.getElementById("boreMm");
  const strokeEl= document.getElementById("strokeMm");
  const dispEl  = document.getElementById("displacementL");

  if (!cylEl || !boreEl || !strokeEl || !dispEl) return;

  const cyl   = parseInt(cylEl.value) || 0;
  const bore  = parseFloat(boreEl.value) || 0;
  const stroke= parseFloat(strokeEl.value) || 0;

  if (!cyl || !bore || !stroke) return;

  const dispL = litersFromBoreStroke(bore, stroke, cyl);
  if (dispL > 0) dispEl.value = dispL.toFixed(2);
}

/* =========================================================================
   PRESETS
   ========================================================================= */

const PRESETS = {
  k20c1: {
    engineMode: "gas_turbo",
    cylinders: 4,
    boreMm: 86.0,
    strokeMm: 85.9,
    compRatio: 9.8,
    redline: 7000,
    vePeak: 105,
    sizePenalty: 3,
    pistonSpeedLimit: 26,
    boostPsi: 21,
    valvetrainType: "dohc",
    valvesPerCyl: 4,
  },
  k24z7: {
    engineMode: "gas_na",
    cylinders: 4,
    boreMm: 87.0,
    strokeMm: 99.0,
    compRatio: 11.0,
    redline: 7500,
    vePeak: 100,
    sizePenalty: 3,
    pistonSpeedLimit: 25,
    boostPsi: 0,
    valvetrainType: "dohc",
    valvesPerCyl: 4,
  },
  coyote50: {
    engineMode: "gas_na",
    cylinders: 8,
    boreMm: 92.2,
    strokeMm: 92.7,
    compRatio: 11.0,
    redline: 7000,
    vePeak: 100,
    sizePenalty: 3,
    pistonSpeedLimit: 25,
    boostPsi: 0,
    valvetrainType: "dohc",
    valvesPerCyl: 4,
  },
  ls3: {
    engineMode: "gas_na",
    cylinders: 8,
    boreMm: 103.25,
    strokeMm: 92.0,
    compRatio: 10.7,
    redline: 6600,
    vePeak: 95,
    sizePenalty: 4,
    pistonSpeedLimit: 24,
    boostPsi: 0,
    valvetrainType: "pushrod",
    valvesPerCyl: 2,
  },
  l15b7: {
    engineMode: "gas_turbo",
    cylinders: 4,
    boreMm: 73.0,
    strokeMm: 89.5,
    compRatio: 10.6,
    redline: 6500,
    vePeak: 100,
    sizePenalty: 3,
    pistonSpeedLimit: 25,
    boostPsi: 16,
    valvetrainType: "dohc",
    valvesPerCyl: 4,
  },
  cummins67: {
    engineMode: "diesel_turbo",
    cylinders: 6,
    boreMm: 107.0,
    strokeMm: 124.0,
    compRatio: 16.5,
    redline: 3600,
    vePeak: 95,
    sizePenalty: 2,
    pistonSpeedLimit: 20,
    boostPsi: 26,
    valvetrainType: "sohc",
    valvesPerCyl: 4,
  },
};

function applyPreset(key) {
  if (key === "custom") return;

  const preset = PRESETS[key];
  if (!preset) return;

  const modeEl   = document.getElementById("engineMode");
  const cylEl    = document.getElementById("cylinders");
  const boreEl   = document.getElementById("boreMm");
  const strokeEl = document.getElementById("strokeMm");
  const compEl   = document.getElementById("compressionRatio");
  const redEl    = document.getElementById("redlineRpm");
  const veEl     = document.getElementById("vePeak");
  const sizePenEl= document.getElementById("sizePenalty");
  const pistEl   = document.getElementById("pistonSpeedLimit");
  const boostEl  = document.getElementById("boostPsi");
  const vtEl     = document.getElementById("valvetrainType");
  const valvesEl = document.getElementById("valvesPerCyl");

  if (modeEl)   modeEl.value   = preset.engineMode;
  if (cylEl)    cylEl.value    = preset.cylinders;
  if (boreEl)   boreEl.value   = preset.boreMm;
  if (strokeEl) strokeEl.value = preset.strokeMm;
  if (compEl)   compEl.value   = preset.compRatio;
  if (redEl)    redEl.value    = preset.redline;
  if (veEl)     veEl.value     = preset.vePeak;
  if (sizePenEl)sizePenEl.value= preset.sizePenalty;
  if (pistEl)   pistEl.value   = preset.pistonSpeedLimit;
  if (boostEl)  boostEl.value  = preset.boostPsi;
  if (vtEl)     vtEl.value     = preset.valvetrainType;
  if (valvesEl) valvesEl.value = String(preset.valvesPerCyl);

  // Now update displacement from geometry with preset values
  updateDisplacementFromGeometry();
}
