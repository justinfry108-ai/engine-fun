/* ===========================================
   SIMPLE ENGINE SIMULATOR v3
   Features:
   - Displacement from bore/stroke/cyl
   - VE curve shaped by bore/stroke ratio
   - Compression ratio & knock ceiling (by fuel + boost)
   - RPM + displacement-based friction (fixed low-rpm zero-hp)
   - Piston speed penalty past limit
   - Fuel types: gasoline, diesel, methanol (BSFC, density, knock)
   - Induction: NA, turbo, supercharger (lag vs instant, parasitic)
   - Valvetrain: pushrod / SOHC / DOHC + valves/cyl (breathing shape)
   - Outputs: HP, torque, VE, piston speed, BMEP, CFM, fuel mass & volume
   =========================================== */

let chart;

/**
 * Compute displacement from bore, stroke, and cylinder count.
 * bore/stroke in mm, result in liters.
 */
function computeDisplacementL(cylinders, boreMm, strokeMm) {
  const boreCm = boreMm / 10;
  const strokeCm = strokeMm / 10;
  const singleCc = (Math.PI / 4) * boreCm * boreCm * strokeCm;
  const totalCc = singleCc * cylinders;
  return totalCc / 1000; // cc -> L
}

/**
 * Clamp helper
 */
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Fuel properties and knock limits
 */
function getFuelProps(fuelType, inductionType) {
  let densityLbPerGal;
  let bsfcNa;
  let bsfcBoosted;
  let knockLimit; // limit on CR * PR product
  let baselineCR;

  switch (fuelType) {
    case "diesel":
      densityLbPerGal = 7.1;
      bsfcNa = 0.38;
      bsfcBoosted = 0.45;
      knockLimit = 32; // diesel can tolerate high CR*PR
      baselineCR = 17;
      break;
    case "methanol":
      densityLbPerGal = 6.6;
      bsfcNa = 0.75;
      bsfcBoosted = 0.9;
      knockLimit = 28; // very knock resistant
      baselineCR = 12;
      break;
    case "gasoline":
    default:
      densityLbPerGal = 6.2;
      bsfcNa = 0.45;
      bsfcBoosted = 0.6;
      knockLimit = 18; // pump gas-ish
      baselineCR = 10;
      break;
  }

  const bsfc = inductionType === "na" ? bsfcNa : bsfcBoosted;
  return { densityLbPerGal, bsfc, knockLimit, baselineCR };
}

/**
 * Fuel shape factor vs RPM.
 * Nudges torque behavior differently for each fuel.
 */
function getFuelShapeFactor(fuelType, rpm, redlineRpm) {
  const t = clamp(rpm / redlineRpm, 0, 1);
  if (fuelType === "diesel") {
    // Diesel: strong low-mid, falls off up high
    return clamp(1.15 - 0.3 * t, 0.8, 1.15);
  }
  if (fuelType === "methanol") {
    // Meth: loves high rpm a bit
    return clamp(0.95 + 0.15 * t, 0.95, 1.12);
  }
  // Gasoline baseline
  return 1;
}

/**
 * Induction shape factor vs RPM.
 * Turbo: spool, more top-end.
 * Supercharger: strong low-end, mild fade at high RPM.
 */
function getInductionShapeFactor(inductionType, rpm, redlineRpm) {
  const t = clamp(rpm / redlineRpm, 0, 1);

  if (inductionType === "turbo") {
    const spoolStart = 0.35;
    const spoolFull = 0.7;
    if (t <= spoolStart) return 0.65;
    if (t >= spoolFull) return 1.1;
    const u = (t - spoolStart) / (spoolFull - spoolStart);
    return 0.65 + (1.1 - 0.65) * u;
  }

  if (inductionType === "supercharger") {
    // Pretty flat, but strongest early, slight fade up top
    return clamp(1.12 - 0.1 * t, 1.0, 1.12);
  }

  return 1; // NA
}

/**
 * Valvetrain + valves per cylinder breathing shape.
 * Pushrod: strong low-end, weaker high rpm.
 * SOHC: middle.
 * DOHC: strongest up high, especially with 4 valves.
 */
function getValvetrainShapeFactor(valvetrainType, valvesPerCyl, rpm, redlineRpm) {
  const t = clamp(rpm / redlineRpm, 0, 1);

  // base low/high factors for valvetrain
  let lowBase, highBase;
  switch (valvetrainType) {
    case "pushrod":
      lowBase = 1.08;
      highBase = 0.88;
      break;
    case "sohc":
      lowBase = 1.02;
      highBase = 1.0;
      break;
    case "dohc":
    default:
      lowBase = 0.98;
      highBase = 1.10;
      break;
  }

  // valves adjustment: more valves = better high-rpm breathing
  let valveHighBonus = 0;
  if (valvesPerCyl >= 4) valveHighBonus = 0.05;
  else if (valvesPerCyl === 3) valveHighBonus = 0.02;

  const low = lowBase;
  const high = highBase + valveHighBonus;

  return clamp(low + (high - low) * t, 0.8, 1.2);
}

/**
 * Compression ratio factor:
 * Higher CR gives more potential VE/power,
 * but limited by knock factor later.
 */
function getCompressionFactor(compressionRatio, baselineCR) {
  const delta = compressionRatio - baselineCR;
  // ~2% VE change per CR point, clamped
  const factor = 1 + 0.02 * delta;
  return clamp(factor, 0.85, 1.15);
}

/**
 * Knock factor:
 * CRPR = compressionRatio * pressureRatio
 * If CRPR exceeds fuel-specific knockLimit, VE is penalized.
 */
function getKnockFactor(compressionRatio, pressureRatio, knockLimit) {
  const crpr = compressionRatio * pressureRatio;
  if (crpr <= knockLimit) return 1;
  const ratio = knockLimit / crpr;
  // Soften with exponent so it doesn't insta-die
  return clamp(Math.pow(ratio, 0.9), 0.5, 1);
}

/**
 * Piston speed (m/s) for 4-stroke:
 * mps ≈ 2 * stroke * rpm / 60
 */
function meanPistonSpeedMps(strokeM, rpm) {
  return (2 * strokeM * rpm) / 60;
}

/**
 * Piston speed efficiency factor above limit.
 */
function getPistonSpeedFactor(meanPistonSpeed, limit) {
  if (meanPistonSpeed <= limit) return 1;
  const over = meanPistonSpeed - limit;
  // 4% VE loss per 1 m/s over limit, floored at 40%
  return clamp(1 - 0.04 * over, 0.4, 1);
}

/**
 * Size efficiency penalty for large engines.
 */
function getSizeEfficiency(displacementL, sizePenaltyPerL) {
  const extraLiters = Math.max(0, displacementL - 2);
  const factor = 1 - (sizePenaltyPerL / 100) * extraLiters;
  return clamp(factor, 0.65, 1.05);
}

/**
 * Friction & pumping loss model:
 * Scales with displacement and RPM (linear + mild quadratic),
 * and clamped so it never destroys all power at low RPM.
 */
function getFrictionHp(displacementL, rpmK, fuelType) {
  const baseFricPerL = 2.5;    // hp per liter at 0 rpm (conceptually)
  const slopeFricPerL = 1.4;   // hp per liter per 1000 rpm
  const quadFricPerL = 0.25;   // extra term at high rpm

  let frictionHp =
    displacementL *
    (baseFricPerL + slopeFricPerL * rpmK) +
    quadFricPerL * displacementL * rpmK * rpmK;

  // Diesel heavy bottom end = slightly more friction
  if (fuelType === "diesel") {
    frictionHp *= 1.1;
  }

  return frictionHp;
}

/**
 * Supercharger parasitic loss (hp).
 * Roughly scales with boost, rpm, and displacement.
 */
function getSuperchargerParasiticHp(displacementL, rpmK, boostPsi) {
  if (boostPsi <= 0) return 0;
  const boostFactor = boostPsi / 10; // normalized
  return boostFactor * displacementL * rpmK * 2.0;
}

/**
 * Core simulation function.
 */
function simulateEngine(params) {
  const {
    cylinders,
    boreMm,
    strokeMm,
    redlineRpm,
    rpmStep,
    vePeakPercent,
    sizePenaltyPerL,
    pistonSpeedLimit,
    fuelType,
    inductionType,
    boostPsiInput,
    compressionRatio,
    valvesPerCyl,
    valvetrainType
  } = params;

  const displacementL = computeDisplacementL(cylinders, boreMm, strokeMm);
  const displacementCi = displacementL * 61.024; // cubic inches

  const points = [];

  // Boost & pressure ratio
  const boostPsi = inductionType === "na" ? 0 : Math.max(0, boostPsiInput || 0);
  const pressureRatio = 1 + boostPsi / 14.7;

  // Fuel props (BSFC + density + knock limit)
  const { densityLbPerGal, bsfc, knockLimit, baselineCR } = getFuelProps(
    fuelType,
    inductionType
  );

  const sizeEff = getSizeEfficiency(displacementL, sizePenaltyPerL);
  const veMax = vePeakPercent / 100;

  // Bore/stroke ratio & VE curve shape
  const bsr = boreMm / strokeMm;
  const bsrClamp = clamp(bsr, 0.7, 1.6);
  const bsrT = (bsrClamp - 0.7) / (1.6 - 0.7); // 0..1

  const vePeakRpm = redlineRpm * (0.5 + 0.4 * bsrT); // 0.5–0.9 of redline
  const veWidth = redlineRpm * (0.35 - 0.17 * bsrT); // 0.35–0.18 of redline

  const strokeM = strokeMm / 1000;

  // Base constant: hp ≈ C * displacement[L] * PR * VE * (rpm / 1000)
  const C = 13.5;

  const rpmStart = 1000;

  for (let rpm = rpmStart; rpm <= redlineRpm; rpm += rpmStep) {
    const rpmK = rpm / 1000;

    // Base VE vs RPM (Gaussian)
    const veRpmRaw =
      veMax * Math.exp(-0.5 * Math.pow((rpm - vePeakRpm) / veWidth, 2));

    // Piston speed & penalty
    const mps = meanPistonSpeedMps(strokeM, rpm);
    const pistonFactor = getPistonSpeedFactor(mps, pistonSpeedLimit);

    // Fuel shape (diesel low-end grunt, meth upper revs, etc.)
    const fuelShape = getFuelShapeFactor(fuelType, rpm, redlineRpm);

    // Induction shape (turbo spool, SC punch)
    const inductionShape = getInductionShapeFactor(inductionType, rpm, redlineRpm);

    // Valvetrain + valves shape
    const valvetrainShape = getValvetrainShapeFactor(
      valvetrainType,
      valvesPerCyl,
      rpm,
      redlineRpm
    );

    // Compression potential
    const compressionFactor = getCompressionFactor(compressionRatio, baselineCR);

    // Combine all VE multipliers before knock
    let effectiveVE =
      veRpmRaw *
      sizeEff *
      pistonFactor *
      fuelShape *
      inductionShape *
      valvetrainShape *
      compressionFactor;

    // Knock penalty (CR * PR too high)
    const knockFactor = getKnockFactor(compressionRatio, pressureRatio, knockLimit);
    effectiveVE *= knockFactor;

    // Bound VE
    effectiveVE = clamp(effectiveVE, 0, 1.25);

    // Gross indicated power (before friction & parasitics)
    const grossHp = C * displacementL * pressureRatio * effectiveVE * rpmK;

    // Friction & pumping losses
    let frictionHp = getFrictionHp(displacementL, rpmK, fuelType);

    // Supercharger parasitic loss
    let parasiticHp = 0;
    if (inductionType === "supercharger") {
      parasiticHp = getSuperchargerParasiticHp(displacementL, rpmK, boostPsi);
    }

    // Don't let friction+parasitic completely obliterate low-rpm power
    const maxLoss = grossHp * 0.85;
    const totalLoss = Math.min(frictionHp + parasiticHp, maxLoss);

    let netHp = Math.max(grossHp - totalLoss, 0);

    // Low-rpm floor so big engines don't show zero output
    const lowRpmFloor = displacementL * 1.2 * Math.pow(rpmK, 0.7); // hp
    if (netHp < lowRpmFloor) netHp = lowRpmFloor;

    const torque = rpm > 0 ? (netHp * 5252) / rpm : 0;

    // BMEP (psi): approx 150.8 * torque(lb-ft) / displacement(L)
    const bmepPsi = displacementL > 0 ? (150.8 * torque) / displacementL : 0;

    // Airflow (CFM): 4-stroke approx
    // CFM = (disp_ci * rpm * VE * PR) / 3456
    const cfm = (displacementCi * rpm * effectiveVE * pressureRatio) / 3456;

    // Fuel consumption
    const fuelLbPerHr = netHp * bsfc;
    const fuelGalPerHr =
      densityLbPerGal > 0 ? fuelLbPerHr / densityLbPerGal : 0;

    points.push({
      rpm,
      hp: netHp,
      torque,
      effectiveVE,
      meanPistonSpeed: mps,
      bmepPsi,
      cfm,
      fuelLbPerHr,
      fuelGalPerHr
    });
  }

  return {
    points,
    displacementL,
    densityLbPerGal
  };
}

/**
 * Wire up UI
 */
document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("engine-form");
  const warningsEl = document.getElementById("warnings");

  const cylindersEl = document.getElementById("cylinders");
  const boreEl = document.getElementById("boreMm");
  const strokeEl = document.getElementById("strokeMm");
  const displacementEl = document.getElementById("displacementL");
  const compressionEl = document.getElementById("compressionRatio");
  const redlineEl = document.getElementById("redlineRpm");
  const rpmStepEl = document.getElementById("rpmStep");
  const vePeakEl = document.getElementById("vePeak");
  const sizePenaltyEl = document.getElementById("sizePenalty");
  const pistonLimitEl = document.getElementById("pistonSpeedLimit");
  const fuelTypeEl = document.getElementById("fuelType");
  const inductionTypeEl = document.getElementById("inductionType");
  const boostPsiEl = document.getElementById("boostPsi");
  const valvetrainTypeEl = document.getElementById("valvetrainType");
  const valvesPerCylEl = document.getElementById("valvesPerCyl");

  const peakHpEl = document.getElementById("peakHp");
  const peakHpRpmEl = document.getElementById("peakHpRpm");
  const peakTqEl = document.getElementById("peakTq");
  const peakTqRpmEl = document.getElementById("peakTqRpm");
  const hpPerLEl = document.getElementById("hpPerL");
  const fuelPeakLbEl = document.getElementById("fuelPeakLb");
  const fuelPeakGalEl = document.getElementById("fuelPeakGal");
  const bmepPeakPsiEl = document.getElementById("bmepPeakPsi");
  const cfmPeakEl = document.getElementById("cfmPeak");

  const tableBody = document.querySelector("#results-table tbody");
  const chartCanvas = document.getElementById("powerChart");

  // Displacement is computed from geometry
  displacementEl.readOnly = true;

  // Enable/disable boost psi based on induction type
  function updateBoostState() {
    const type = inductionTypeEl.value;
    boostPsiEl.disabled = type === "na";
  }
  updateBoostState();
  inductionTypeEl.addEventListener("change", updateBoostState);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    warningsEl.textContent = "";

    const cylinders = parseInt(cylindersEl.value, 10);
    const boreMm = parseFloat(boreEl.value);
    const strokeMm = parseFloat(strokeEl.value);
    let redlineRpm = parseInt(redlineEl.value, 10);
    const rpmStep = parseInt(rpmStepEl.value, 10);
    const vePeakPercent = parseFloat(vePeakEl.value);
    const sizePenaltyPerL = parseFloat(sizePenaltyEl.value);
    const pistonSpeedLimit = parseFloat(pistonLimitEl.value);
    const fuelType = fuelTypeEl.value;
    const inductionType = inductionTypeEl.value;
    const compressionRatio = parseFloat(compressionEl.value);
    const valvesPerCyl = parseInt(valvesPerCylEl.value, 10);
    const valvetrainType = valvetrainTypeEl.value;

    let boostPsi = 0;
    if (inductionType !== "na") {
      boostPsi = Math.max(0, parseFloat(boostPsiEl.value) || 0);
    }

    // Basic validation
    if (
      !cylinders ||
      !boreMm ||
      !strokeMm ||
      !redlineRpm ||
      !rpmStep ||
      !compressionRatio
    ) {
      warningsEl.textContent = "Please fill in all required numeric fields.";
      return;
    }

    if (redlineRpm < 3000) {
      warningsEl.textContent = "Redline must be at least 3000 rpm.";
      return;
    }

    if (rpmStep >= redlineRpm) {
      warningsEl.textContent = "RPM step is too large relative to redline.";
      return;
    }

    if (redlineRpm > 15000) {
      redlineRpm = 15000;
      redlineEl.value = 15000;
      warningsEl.textContent = "Redline capped at 15,000 rpm for this simple model.";
    }

    const params = {
      cylinders,
      boreMm,
      strokeMm,
      redlineRpm,
      rpmStep,
      vePeakPercent,
      sizePenaltyPerL,
      pistonSpeedLimit,
      fuelType,
      inductionType,
      boostPsiInput: boostPsi,
      compressionRatio,
      valvesPerCyl,
      valvetrainType
    };

    const { points, displacementL } = simulateEngine(params);

    if (!points.length) {
      warningsEl.textContent = "No RPM points generated – check your inputs.";
      return;
    }

    // Show computed displacement:
    displacementEl.value = displacementL.toFixed(2);

    // Find peaks & additional info
    let peakHp = -Infinity;
    let peakHpRpm = 0;
    let peakTq = -Infinity;
    let peakTqRpm = 0;
    let maxHp = 0;
    let pointAtPeakHp = null;

    points.forEach((pt) => {
      if (pt.hp > peakHp) {
        peakHp = pt.hp;
        peakHpRpm = pt.rpm;
        pointAtPeakHp = pt;
      }
      if (pt.torque > peakTq) {
        peakTq = pt.torque;
        peakTqRpm = pt.rpm;
      }
      if (pt.hp > maxHp) maxHp = pt.hp;
    });

    const hpPerL = displacementL > 0 ? maxHp / displacementL : 0;

    // Update summary
    peakHpEl.textContent = peakHp.toFixed(1);
    peakHpRpmEl.textContent = peakHpRpm.toLocaleString();
    peakTqEl.textContent = peakTq.toFixed(1);
    peakTqRpmEl.textContent = peakTqRpm.toLocaleString();
    hpPerLEl.textContent = hpPerL.toFixed(1);

    if (pointAtPeakHp) {
      fuelPeakLbEl.textContent = pointAtPeakHp.fuelLbPerHr.toFixed(1);
      fuelPeakGalEl.textContent = pointAtPeakHp.fuelGalPerHr.toFixed(2);
      bmepPeakPsiEl.textContent = pointAtPeakHp.bmepPsi.toFixed(1);
      cfmPeakEl.textContent = pointAtPeakHp.cfm.toFixed(0);
    } else {
      fuelPeakLbEl.textContent = "–";
      fuelPeakGalEl.textContent = "–";
      bmepPeakPsiEl.textContent = "–";
      cfmPeakEl.textContent = "–";
    }

    // Update table
    tableBody.innerHTML = "";
    points.forEach((pt) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${pt.rpm.toLocaleString()}</td>
        <td>${pt.hp.toFixed(1)}</td>
        <td>${pt.torque.toFixed(1)}</td>
        <td>${(pt.effectiveVE * 100).toFixed(1)}%</td>
        <td>${pt.meanPistonSpeed.toFixed(1)}</td>
        <td>${pt.bmepPsi.toFixed(1)}</td>
        <td>${pt.cfm.toFixed(0)}</td>
        <td>${pt.fuelLbPerHr.toFixed(1)}</td>
        <td>${pt.fuelGalPerHr.toFixed(2)}</td>
      `;
      tableBody.appendChild(tr);
    });

    // Update chart
    const labels = points.map((pt) => pt.rpm);
    const hpData = points.map((pt) => pt.hp);
    const tqData = points.map((pt) => pt.torque);

    if (chart) {
      chart.data.labels = labels;
      chart.data.datasets[0].data = hpData;
      chart.data.datasets[1].data = tqData;
      chart.update();
    } else {
      chart = new Chart(chartCanvas, {
        type: "line",
        data: {
          labels,
          datasets: [
            {
              label: "Horsepower",
              data: hpData,
              yAxisID: "y1",
              borderWidth: 2,
              tension: 0.25
            },
            {
              label: "Torque (lb-ft)",
              data: tqData,
              yAxisID: "y2",
              borderWidth: 2,
              borderDash: [4, 4],
              tension: 0.25
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: {
            mode: "index",
            intersect: false
          },
          scales: {
            x: {
              title: {
                display: true,
                text: "Engine Speed (RPM)"
              }
            },
            y1: {
              position: "left",
              title: {
                display: true,
                text: "Horsepower"
              }
            },
            y2: {
              position: "right",
              grid: {
                drawOnChartArea: false
              },
              title: {
                display: true,
                text: "Torque (lb-ft)"
              }
            }
          },
          plugins: {
            legend: {
              display: true
            },
            tooltip: {
              callbacks: {
                label: (ctx) => {
                  const label = ctx.dataset.label || "";
                  return `${label}: ${ctx.parsed.y.toFixed(1)}`;
                }
              }
            }
          }
        }
      });
    }
  });
});
