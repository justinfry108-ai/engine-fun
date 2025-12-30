// script.js – Engine Power Simulator V5
// BMEP-based model with separate behaviors for:
// - NA gasoline (pushrod / SOHC / DOHC, valve-count aware)
// - Turbo gasoline
// - Supercharged gasoline
// - Turbo diesel (light-duty vs heavy-duty)
// - Methanol DOHC racing
// Compression/boost interaction + VE derived from BMEP so values are realistic.

let powerChart = null;

document.addEventListener("DOMContentLoaded", () => {
  console.log("Engine Simulator V5 loaded");

  const form = document.getElementById("engine-form");
  if (form) {
    form.addEventListener("submit", onFormSubmit);
  }

  // recalc displacement from geometry
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

// BMEP (psi) from torque & displacement
function bmepPsi(torqueLbFt, displacementL) {
  if (!displacementL || displacementL <= 0) return 0;
  // 4-stroke BMEP(psi) ≈ 150.8 * T(lb-ft) / Vd(L)
  return (150.8 * torqueLbFt) / displacementL;
}

// Torque from BMEP (bar) & displacement (L)
function torqueFromBmepBar(bmepBar, displacementL) {
  if (!displacementL || displacementL <= 0) return 0;
  const Vd_m3 = displacementL / 1000; // L -> m^3
  const bmepPa = bmepBar * 1e5;
  const torqueNm = (bmepPa * Vd_m3) / (4 * Math.PI);
  const torqueLbFt = torqueNm / 1.35581795;
  return torqueLbFt;
}

// CFM from BMEP-based VE estimate
function cfmAtRpm(displacementL, rpm, veFrac) {
  const dispCID = litersToCID(displacementL);
  const cfm100 = (dispCID * rpm) / 3456;
  return cfm100 * veFrac;
}

// Fuel models
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

// Mean piston speed (m/s)
function meanPistonSpeed(strokeMm, rpm) {
  if (!strokeMm || strokeMm <= 0) return 0;
  const strokeM = strokeMm / 1000;
  return (2 * strokeM * rpm) / 60;
}

// ---------- Engine type meta & compression/boost logic ---------------

// Gives us a "kind" name + BMEP reference for VE math
function getEngineKindMeta(fuelType, inductionType) {
  if (fuelType === "diesel") {
    return { kind: "diesel_turbo", bmepRefBar: 24 }; // typical peak boosted diesel
  }
  if (fuelType === "methanol") {
    if (inductionType === "na") return { kind: "methanol_na", bmepRefBar: 15 };
    return { kind: "methanol_boost", bmepRefBar: 22 };
  }
  // gasoline
  if (inductionType === "na") return { kind: "gas_na", bmepRefBar: 13 };
  if (inductionType === "supercharger") return { kind: "gas_sc", bmepRefBar: 19 };
  return { kind: "gas_turbo", bmepRefBar: 20 };
}

// For gasoline, we need to limit effective boost based on CR.
// For diesel & methanol we basically let boost be what user says (mild checks).
function getEffectiveBoostAndCompFactor(fuelType, inductionType, compRatio, boostPsi) {
  let effBoostPsi = boostPsi;
  let compFactor = 1.0;

  if (fuelType === "gasoline") {
    if (inductionType === "na") {
      // NA gasoline: mild bump around 10.5–11:1, penalize extremes a bit
      const ideal = 10.8;
      const delta = compRatio - ideal;
      compFactor = 1 - 0.01 * delta * delta; // parabola
      compFactor = Math.max(0.9, Math.min(compFactor, 1.05));
      effBoostPsi = 0; // NA
    } else {
      // Boosted gasoline: sweet spot CR ~9.5:1
      const idealCr = 9.5;
      const deltaCr = compRatio - idealCr;

      // base comp factor: punish going far from ideal
      compFactor = 1 - 0.015 * Math.abs(deltaCr);
      compFactor = Math.max(0.85, Math.min(compFactor, 1.02));

      // crude knock-safe boost limit
      // around CR 9.5: ~22 psi, CR 10.5: ~16 psi, CR 11.5: ~10 psi, etc.
      const safeBoostPsi = Math.max(0, 22 - 5 * Math.max(0, compRatio - 9.5));
      effBoostPsi = Math.min(boostPsi, safeBoostPsi);
    }
  } else if (fuelType === "diesel") {
    // diesels like high CR. Ideal band ~16–18.
    const ideal = 17;
    const delta = compRatio - ideal;
    compFactor = 1 - 0.01 * Math.abs(delta);
    compFactor = Math.max(0.9, Math.min(compFactor, 1.05));
    effBoostPsi = boostPsi; // basically trust user on diesel boost
  } else if (fuelType === "methanol") {
    // methanol: loves high CR; wide safe band
    const ideal = 13.5;
    const delta = compRatio - ideal;
    compFactor = 1 + 0.01 * delta;
    compFactor = Math.max(0.9, Math.min(compFactor, 1.10));
    effBoostPsi = boostPsi; // methanol has more knock margin
  }

  return { effBoostPsi, compFactor };
}

// ---------- GASOLINE – NA (pushrod / SOHC / DOHC) --------------------

// BMEP-based NA gasoline model
function simulateGasolineNa(rpmRange, cfg, bmepRefBar) {
  const {
    displacementL,
    redline,
    vePeak,
    sizePenalty,
    valvetrainType,
    valvesPerCyl,
    compRatio,
  } = cfg;

  // Base peak BMEP for a "good" NA gas engine at 100% VE
  // We'll scale this with VE, tech, size, and CR.
  let basePeakBmepBar = bmepRefBar; // ~13 bar baseline

  // Tech factor: valvetrain & valves
  let techFactor = 1.0;
  if (valvetrainType === "pushrod") techFactor *= 0.95;
  if (valvetrainType === "sohc") techFactor *= 1.0;
  if (valvetrainType === "dohc") techFactor *= 1.05;

  if (valvesPerCyl === 2) techFactor *= 0.95;
  if (valvesPerCyl === 3) techFactor *= 1.0;
  if (valvesPerCyl === 4) techFactor *= 1.05;

  // Size penalty: bigger engines tend to have lower hp/L
  let sizeFactor = 1.0;
  if (displacementL > 2 && sizePenalty > 0) {
    const penalty = (sizePenalty / 100) * (displacementL - 2);
    sizeFactor = Math.max(0.75, 1 - penalty);
  }

  // VE factor from user input (around 95% = 1.0)
  const veFactor = (vePeak / 100) / 0.95;

  // Compression effect (NA gas – mild)
  const idealCr = 10.8;
  const deltaCr = compRatio - idealCr;
  let crFactor = 1 - 0.01 * deltaCr * deltaCr;
  crFactor = Math.max(0.9, Math.min(crFactor, 1.05));

  const peakBmepBar = basePeakBmepBar * techFactor * sizeFactor * veFactor * crFactor;

  // Shape: pushrod = earlier peak; DOHC 4V = later peak
  let ratioPeakTq;
  if (valvetrainType === "pushrod") ratioPeakTq = 0.6;
  else if (valvetrainType === "sohc") ratioPeakTq = 0.65;
  else ratioPeakTq = 0.7;

  // Valve count nudges it
  if (valvesPerCyl === 2) ratioPeakTq -= 0.05;
  if (valvesPerCyl === 4) ratioPeakTq += 0.03;

  ratioPeakTq = Math.max(0.5, Math.min(ratioPeakTq, 0.8));

  const rpmPeakTq = ratioPeakTq * redline;
  const rpmMin = rpmRange[0];
  const rpmMax = rpmRange[rpmRange.length - 1];

  const bmepBarArr = [];
  const torque = [];
  const hp = [];

  for (const rpm of rpmRange) {
    let frac;

    if (rpm <= rpmPeakTq) {
      // rising side: from ~0.4 at idle to 1 at peak
      const x = (rpm - rpmMin) / (rpmPeakTq - rpmMin);
      const lowBase = 0.4;
      const exp =
        valvetrainType === "pushrod" ? 0.75 : valvetrainType === "sohc" ? 0.9 : 1.1;
      frac = lowBase + (1 - lowBase) * Math.pow(Math.max(0, Math.min(x, 1)), exp);
    } else {
      // falling side: from 1 at peak to ~0.3 at redline
      const x = (rpm - rpmPeakTq) / (rpmMax - rpmPeakTq);
      const exp = valvetrainType === "pushrod" ? 1.3 : 1.1;
      frac = 1 - (1 - 0.3) * Math.pow(Math.max(0, Math.min(x, 1)), exp);
    }

    const bmepBar = peakBmepBar * frac;
    const tq = torqueFromBmepBar(bmepBar, displacementL);
    const h = hpFromTorque(tq, rpm);

    bmepBarArr.push(bmepBar);
    torque.push(tq);
    hp.push(h);
  }

  return { rpm: rpmRange, torque, hp, bmepBarArr, engineKind: "gas_na" };
}

// ---------- GASOLINE – TURBO -----------------------------------------

function simulateGasolineTurbo(rpmRange, cfg, bmepRefBar, effBoostPsi, compFactor) {
  const {
    displacementL,
    redline,
    vePeak,
    sizePenalty,
    valvetrainType,
    valvesPerCyl,
    compRatio,
  } = cfg;

  // Base NA-like BMEP at 0 boost
  let baseNaBmepBar = 12.5; // slightly lower than bmepRefBar (13)

  let techFactor = 1.0;
  if (valvetrainType === "pushrod") techFactor *= 0.95;
  if (valvetrainType === "sohc") techFactor *= 1.0;
  if (valvetrainType === "dohc") techFactor *= 1.05;
  if (valvesPerCyl === 2) techFactor *= 0.95;
  if (valvesPerCyl === 4) techFactor *= 1.05;

  let sizeFactor = 1.0;
  if (displacementL > 2 && sizePenalty > 0) {
    const penalty = (sizePenalty / 100) * (displacementL - 2);
    sizeFactor = Math.max(0.75, 1 - penalty);
  }

  const veFactor = (vePeak / 100) / 0.95;

  // CR factor from comp/boost function
  const crFactor = compFactor;

  // Boost adds BMEP linearly up to ~22 bar max
  const boostGainPerPsi = 0.45; // ~0.45 bar/psi
  let boostedBmepBar = baseNaBmepBar + boostGainPerPsi * effBoostPsi;
  boostedBmepBar = Math.min(boostedBmepBar, 22);

  const peakBmepBar =
    boostedBmepBar * techFactor * sizeFactor * veFactor * crFactor;

  // Shape: turbo DOHC has earlier plateau than NA, then tapers
  const rpmMin = rpmRange[0];
  const rpmMax = rpmRange[rpmRange.length - 1];
  const spoolRpm = Math.max(rpmMin + 300, redline * 0.25);
  const fullBoostRpm = redline * 0.4;
  const plateauEndRpm = redline * 0.75;

  const bmepBarArr = [];
  const torque = [];
  const hp = [];

  for (const rpm of rpmRange) {
    let frac;

    if (rpm < spoolRpm) {
      // off-boost region: use NA-ish torque ramp
      const x = (rpm - rpmMin) / (spoolRpm - rpmMin);
      const lowBase = 0.35;
      frac = lowBase + (0.7 - lowBase) * Math.pow(Math.max(0, Math.min(x, 1)), 0.9);
    } else if (rpm < fullBoostRpm) {
      // boost ramp: go from ~0.7 to 1.0
      const x = (rpm - spoolRpm) / (fullBoostRpm - spoolRpm);
      frac = 0.7 + 0.3 * Math.max(0, Math.min(x, 1));
    } else if (rpm <= plateauEndRpm) {
      // plateau region
      frac = 1.0;
    } else {
      // falloff from plateau to ~0.6 at redline
      const x = (rpm - plateauEndRpm) / (rpmMax - plateauEndRpm);
      frac = 1 - (1 - 0.6) * Math.pow(Math.max(0, Math.min(x, 1)), 1.1);
    }

    const bmepBar = peakBmepBar * frac;
    const tq = torqueFromBmepBar(bmepBar, displacementL);
    const h = hpFromTorque(tq, rpm);

    bmepBarArr.push(bmepBar);
    torque.push(tq);
    hp.push(h);
  }

  return { rpm: rpmRange, torque, hp, bmepBarArr, engineKind: "gas_turbo" };
}

// ---------- GASOLINE – Supercharger ----------------------------------

function simulateGasolineSupercharged(rpmRange, cfg, bmepRefBar, effBoostPsi, compFactor) {
  const {
    displacementL,
    redline,
    vePeak,
    sizePenalty,
    valvetrainType,
    valvesPerCyl,
  } = cfg;

  let baseNaBmepBar = 12.5;

  let techFactor = 1.0;
  if (valvetrainType === "pushrod") techFactor *= 0.95;
  if (valvetrainType === "sohc") techFactor *= 1.0;
  if (valvetrainType === "dohc") techFactor *= 1.05;
  if (valvesPerCyl === 2) techFactor *= 0.95;
  if (valvesPerCyl === 4) techFactor *= 1.05;

  let sizeFactor = 1.0;
  if (displacementL > 2 && sizePenalty > 0) {
    const penalty = (sizePenalty / 100) * (displacementL - 2);
    sizeFactor = Math.max(0.75, 1 - penalty);
  }

  const veFactor = (vePeak / 100) / 0.95;
  const crFactor = compFactor;

  const boostGainPerPsi = 0.40; // a bit less efficient than turbo
  let boostedBmepBar = baseNaBmepBar + boostGainPerPsi * effBoostPsi;
  boostedBmepBar = Math.min(boostedBmepBar, 20);

  const peakBmepBar =
    boostedBmepBar * techFactor * sizeFactor * veFactor * crFactor;

  const rpmMin = rpmRange[0];
  const rpmMax = rpmRange[rpmRange.length - 1];

  // SC: high torque almost immediately, then slowly tilts
  const bmepBarArr = [];
  const torque = [];
  const hp = [];

  for (const rpm of rpmRange) {
    let frac;

    if (rpm < 1500) {
      const x = (rpm - rpmMin) / (1500 - rpmMin);
      const lowBase = 0.5;
      frac = lowBase + (0.95 - lowBase) * Math.max(0, Math.min(x, 1));
    } else {
      const x = (rpm - 1500) / (rpmMax - 1500);
      frac = 0.95 - 0.25 * Math.pow(Math.max(0, Math.min(x, 1)), 1.2); // ~0.7 at redline
    }

    const bmepBar = peakBmepBar * frac;
    const tq = torqueFromBmepBar(bmepBar, displacementL);
    const h = hpFromTorque(tq, rpm);

    bmepBarArr.push(bmepBar);
    torque.push(tq);
    hp.push(h);
  }

  return { rpm: rpmRange, torque, hp, bmepBarArr, engineKind: "gas_sc" };
}

// ---------- DIESEL – Turbo (heavy vs light duty) ---------------------
// This is the part you were most unhappy with; now BMEP-based.

function simulateDieselTurbo(rpmRange, cfg, bmepRefBar, effBoostPsi, compFactor) {
  const { displacementL, redline, vePeak, sizePenalty, compRatio } = cfg;

  // Base NA-ish diesel BMEP ~12 bar, boosted up to ~24–28 bar
  let baseNaBmepBar = 12;

  // treat big displacement as heavy duty, smaller as light duty automotive
  const heavyDuty = displacementL >= 8.0;

  // Boost adds BMEP strongly for diesel
  const boostGainPerPsi = heavyDuty ? 0.45 : 0.50;
  let boostedBmepBar = baseNaBmepBar + boostGainPerPsi * effBoostPsi;
  boostedBmepBar = Math.min(boostedBmepBar, heavyDuty ? 28 : 26);

  // VE factor
  const veFactor = (vePeak / 100) / 0.95;

  // Bigger displacement diesels tend to slightly lower hp/L
  let sizeFactor = 1.0;
  if (displacementL > 6 && sizePenalty > 0) {
    const penalty = (sizePenalty / 100) * (displacementL - 6);
    sizeFactor = Math.max(0.8, 1 - penalty);
  }

  // Compression factor (diesel)
  const idealCr = 17;
  const deltaCr = compRatio - idealCr;
  let crFactor = 1 - 0.01 * Math.abs(deltaCr);
  crFactor = Math.max(0.9, Math.min(crFactor, 1.05));

  const peakBmepBar =
    boostedBmepBar * veFactor * sizeFactor * crFactor * compFactor;

  const rpmMin = rpmRange[0];
  const rpmMax = rpmRange[rpmRange.length - 1];

  // Typical diesel behavior:
  // - big torque by ~1200
  // - peak around ~1600–1800
  // - plateau until ~2600–2800
  // - gradual falloff, still 50–60% at redline
  const rpmPeakTq = heavyDuty ? redline * 0.35 : redline * 0.4;
  const plateauStart = heavyDuty ? redline * 0.3 : redline * 0.35;
  const plateauEnd = heavyDuty ? redline * 0.55 : redline * 0.6;

  const bmepBarArr = [];
  const torque = [];
  const hp = [];

  for (const rpm of rpmRange) {
    let frac;

    if (rpm <= rpmPeakTq) {
      // ramp up from ~0.6 at idle to 1.0 at peak
      const x = (rpm - rpmMin) / (rpmPeakTq - rpmMin);
      const lowBase = 0.6;
      frac = lowBase + (1 - lowBase) * Math.pow(Math.max(0, Math.min(x, 1)), 0.7);
    } else if (rpm <= plateauEnd) {
      // near-flat plateau, slight tilt
      const x = (rpm - rpmPeakTq) / (plateauEnd - rpmPeakTq);
      frac = 1 - 0.07 * Math.max(0, Math.min(x, 1)); // only ~7% drop across plateau
    } else {
      // falloff from plateau to ~0.55 at redline
      const x = (rpm - plateauEnd) / (rpmMax - plateauEnd);
      frac = 0.93 - 0.38 * Math.pow(Math.max(0, Math.min(x, 1)), 1.1); // about 0.55 @ redline
    }

    const bmepBar = peakBmepBar * frac;
    const tq = torqueFromBmepBar(bmepBar, displacementL);
    const h = hpFromTorque(tq, rpm);

    bmepBarArr.push(bmepBar);
    torque.push(tq);
    hp.push(h);
  }

  return { rpm: rpmRange, torque, hp, bmepBarArr, engineKind: "diesel_turbo" };
}

// ---------- METHANOL – DOHC racing -----------------------------------

function simulateMethanol(rpmRange, cfg, bmepRefBar, effBoostPsi, compFactor) {
  const { displacementL, redline, vePeak, sizePenalty, compRatio } = cfg;

  // High specific output
  let baseNaBmepBar = 15; // NA methanol
  const boostGainPerPsi = 0.5;

  let boostedBmepBar = baseNaBmepBar + boostGainPerPsi * effBoostPsi;
  boostedBmepBar = Math.min(boostedBmepBar, 24);

  const veFactor = (vePeak / 100) / 0.95;

  let sizeFactor = 1.0;
  if (displacementL > 3 && sizePenalty > 0) {
    const penalty = (sizePenalty / 100) * (displacementL - 3);
    sizeFactor = Math.max(0.8, 1 - penalty);
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
  const torque = [];
  const hp = [];

  for (const rpm of rpmRange) {
    let frac;

    if (rpm <= rpmPeakTq) {
      const x = (rpm - rpmMin) / (rpmPeakTq - rpmMin);
      const lowBase = 0.3;
      frac = lowBase + (1 - lowBase) * Math.pow(Math.max(0, Math.min(x, 1)), 1.2);
    } else {
      const x = (rpm - rpmPeakTq) / (rpmMax - rpmPeakTq);
      frac = 1 - (1 - 0.7) * Math.pow(Math.max(0, Math.min(x, 1)), 0.8);
    }

    const bmepBar = peakBmepBar * frac;
    const tq = torqueFromBmepBar(bmepBar, displacementL);
    const h = hpFromTorque(tq, rpm);

    bmepBarArr.push(bmepBar);
    torque.push(tq);
    hp.push(h);
  }

  return {
    rpm: rpmRange,
    torque,
    hp,
    bmepBarArr,
    engineKind: effBoostPsi > 0 ? "methanol_boost" : "methanol_na",
  };
}

// ---------- Dispatcher & global penalties ----------------------------

function simulateEngine(cfg) {
  const {
    displacementL,
    compRatio,
    redline,
    rpmStep,
    fuelType,
    inductionType,
    vePeak,
    sizePenalty,
    pistonSpeedLimit,
    strokeMm,
    valvetrainType,
    valvesPerCyl,
    boostPsi,
  } = cfg;

  const rpmRange = createRpmRange(redline, rpmStep, 1000);
  const { kind, bmepRefBar } = getEngineKindMeta(fuelType, inductionType);
  const { effBoostPsi, compFactor } = getEffectiveBoostAndCompFactor(
    fuelType,
    inductionType,
    compRatio,
    boostPsi
  );

  let baseResult;

  if (kind === "diesel_turbo") {
    baseResult = simulateDieselTurbo(
      rpmRange,
      cfg,
      bmepRefBar,
      effBoostPsi,
      compFactor
    );
  } else if (kind === "methanol_na" || kind === "methanol_boost") {
    baseResult = simulateMethanol(rpmRange, cfg, bmepRefBar, effBoostPsi, compFactor);
  } else if (kind === "gas_na") {
    baseResult = simulateGasolineNa(rpmRange, cfg, bmepRefBar);
  } else if (kind === "gas_turbo") {
    baseResult = simulateGasolineTurbo(
      rpmRange,
      cfg,
      bmepRefBar,
      effBoostPsi,
      compFactor
    );
  } else if (kind === "gas_sc") {
    baseResult = simulateGasolineSupercharged(
      rpmRange,
      cfg,
      bmepRefBar,
      effBoostPsi,
      compFactor
    );
  } else {
    // fallback to NA gasoline
    baseResult = simulateGasolineNa(rpmRange, cfg, bmepRefBar);
  }

  // Global penalties: piston speed limit (applies to everything)
  const torque = [];
  const hp = [];
  const bmepBarArr = [];

  for (let i = 0; i < baseResult.rpm.length; i++) {
    const rpm = baseResult.rpm[i];
    const ps = meanPistonSpeed(strokeMm, rpm);

    let psFactor = 1.0;
    if (pistonSpeedLimit > 0 && ps > pistonSpeedLimit) {
      const excess = (ps - pistonSpeedLimit) / pistonSpeedLimit;
      psFactor = Math.max(0.6, 1 - 0.6 * excess);
    }

    const baseTorque = baseResult.torque[i] * psFactor;
    const baseHp = hpFromTorque(baseTorque, rpm);

    torque.push(baseTorque);
    hp.push(baseHp);

    const bmepPsiVal = bmepPsi(baseTorque, displacementL);
    const bmepBar = bmepPsiVal * 0.0689476;
    bmepBarArr.push(bmepBar);
  }

  return {
    rpm: baseResult.rpm,
    torque,
    hp,
    bmepBarArr,
    engineKind: baseResult.engineKind || kind,
    bmepRefBar,
  };
}

// ---------- Form & UI -----------------------------------------------

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
    const dispEl = document.getElementById("displacementL");
    if (dispEl && displacementL) dispEl.value = displacementL.toFixed(2);
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
    result.bmepBarArr,
    result.bmepRefBar,
    cfg.displacementL,
    cfg.strokeMm,
    cfg.fuelType,
    cfg.inductionType
  );
  updateSummary(
    result.rpm,
    result.torque,
    result.hp,
    result.bmepBarArr,
    result.bmepRefBar,
    cfg.displacementL,
    cfg.fuelType,
    cfg.inductionType
  );
}

// ---------- Chart ---------------------------------------------------- 

function initChart() {
  const ctx = document.getElementById("powerChart");
  if (!ctx) {
    console.error("powerChart not found");
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

// ---------- Table + Summary ----------------------------------------- 

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

  const bsfc = getBsfc(fuelType, inductionType);
  const density = getFuelDensityLbPerGal(fuelType);

  for (let i = 0; i < rpmArr.length; i++) {
    const rpm = rpmArr[i];
    const tq = torqueArr[i];
    const hp = hpArr[i];
    const bmepBar = bmepBarArr[i];

    // VE ≈ BMEP / BMEP_ref
    let veFrac = bmepRefBar > 0 ? bmepBar / bmepRefBar : 1.0;
    veFrac = Math.max(0.6, Math.min(veFrac, 1.2));

    const ps = meanPistonSpeed(strokeMm, rpm);
    const bmepPsiVal = bmepPsi(tq, displacementL);
    const cfm = cfmAtRpm(displacementL, rpm, veFrac);

    const fuelLbHr = hp > 0 ? hp * bsfc : 0;
    const fuelGalHr = fuelLbHr / density;

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
  const bmepPeakPsi = bmepPsi(peakTq, displacementL);
  const bmepPeakBar = bmepPeakPsi * 0.0689476;

  // VE at peak torque
  let veFracPeak = bmepRefBar > 0 ? bmepPeakBar / bmepRefBar : 1.0;
  veFracPeak = Math.max(0.6, Math.min(veFracPeak, 1.2));
  const cfmAtPeak = cfmAtRpm(displacementL, peakTqRpm, veFracPeak);

  const bsfc = getBsfc(fuelType, inductionType);
  const density = getFuelDensityLbPerGal(fuelType);
  const fuelLbHr = peakHp > 0 ? peakHp * bsfc : 0;
  const fuelGalHr = fuelLbHr / density;

  if (peakHpSpan) peakHpSpan.textContent = peakHp.toFixed(1);
  if (peakHpRpmSpan) peakHpRpmSpan.textContent = peakHpRpm;
  if (peakTqSpan) peakTqSpan.textContent = peakTq.toFixed(1);
  if (peakTqRpmSpan) peakTqRpmSpan.textContent = peakTqRpm;
  if (hpPerLSpan) hpPerLSpan.textContent = hpPerL.toFixed(1);
  if (bmepPeakPsiSpan) bmepPeakPsiSpan.textContent = bmepPeakPsi.toFixed(1);
  if (cfmPeakSpan) cfmPeakSpan.textContent = cfmAtPeak.toFixed(0);
  if (fuelPeakLbSpan) fuelPeakLbSpan.textContent = fuelLbHr.toFixed(1);
  if (fuelPeakGalSpan) fuelPeakGalSpan.textContent = fuelGalHr.toFixed(2);
}

// ---------- Geometry → displacement ---------------------------------- 

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
