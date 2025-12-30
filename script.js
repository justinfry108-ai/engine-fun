// Improved Engine Simulator v2
// - Displacement from bore/stroke/cyl
// - Friction correlated with RPM & displacement
// - Fuel types: gasoline, diesel, methanol (affects shape & BSFC)
// - Induction types: NA, turbo, supercharger (shape & losses)
// Still a toy, not a CFD solver :)

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
 * Fuel properties:
 * - density (lb/gal)
 * - BSFC: NA vs boosted
 */
function getFuelProps(fuelType, inductionType) {
  let densityLbPerGal;
  let bsfcNa;
  let bsfcBoosted;

  switch (fuelType) {
    case "diesel":
      densityLbPerGal = 7.1;
      bsfcNa = 0.38;
      bsfcBoosted = 0.45;
      break;
    case "methanol":
      densityLbPerGal = 6.6;
      bsfcNa = 0.75;
      bsfcBoosted = 0.9;
      break;
    case "gasoline":
    default:
      densityLbPerGal = 6.2;
      bsfcNa = 0.45;
      bsfcBoosted = 0.6;
      break;
  }

  const bsfc = inductionType === "na" ? bsfcNa : bsfcBoosted;
  return { densityLbPerGal, bsfc };
}

/**
 * Fuel shape factor vs RPM.
 * This nudges torque behavior differently for each fuel.
 */
function getFuelShapeFactor(fuelType, rpm, redlineRpm) {
  const t = rpm / redlineRpm;
  if (fuelType === "diesel") {
    // More grunt down low, trails off up high
    return clamp(1.15 - 0.25 * t, 0.85, 1.15);
  }
  if (fuelType === "methanol") {
    // Loves revs: slightly stronger up top
    return clamp(0.95 + 0.15 * t, 0.95, 1.1);
  }
  // Gasoline baseline
  return 1;
}

/**
 * Induction shape factor vs RPM.
 * Turbo: soft low-end, strong top-end.
 * Supercharger: strong low-end, small fade at high RPM.
 */
function getInductionShapeFactor(inductionType, rpm, redlineRpm) {
  const t = rpm / redlineRpm;
  if (inductionType === "turbo") {
    const spoolStart = 0.35 * redlineRpm;
    const spoolFull = 0.65 * redlineRpm;
    if (rpm <= spoolStart) return 0.65;
    if (rpm >= spoolFull) return 1.08;
    const u = (rpm - spoolStart) / (spoolFull - spoolStart);
    return 0.65 + (1.08 - 0.65) * u;
  }
  if (inductionType === "supercharger") {
    // Pretty flat but strongest early
    return clamp(1.12 - 0.10 * t, 1.0, 1.12);
  }
  return 1; // NA
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
    boostPsiInput
  } = params;

  const displacementL = computeDisplacementL(cylinders, boreMm, strokeMm);

  const points = [];

  // Boost handling
  const boostPsi =
    inductionType === "na" ? 0 : Math.max(0, boostPsiInput || 0);
  const pressureRatio = 1 + boostPsi / 14.7;

  // Fuel props (BSFC + density)
  const { densityLbPerGal, bsfc } = getFuelProps(
    fuelType,
    inductionType
  );

  // Size efficiency: bigger engines lose a bit of hp/L beyond 2.0L
  const extraLiters = Math.max(0, displacementL - 2);
  const sizeEffFactor =
    1 - (sizePenaltyPerL / 100) * extraLiters;
  const sizeEff = clamp(sizeEffFactor, 0.65, 1.05);

  // Volumetric efficiency baseline (as fraction)
  const veMax = vePeakPercent / 100;

  // Bore/stroke ratio: <1 = long stroke, >1 = big bore
  const bsr = boreMm / strokeMm;
  const bsrClamp = clamp(bsr, 0.7, 1.6);
  const bsrT = (bsrClamp - 0.7) / (1.6 - 0.7); // 0..1

  // VE curve: undersquare = earlier, wider peak; oversquare = later, sharper peak
  const vePeakRpm = redlineRpm * (0.5 + 0.4 * bsrT); // 0.5–0.9 of redline
  const veWidth = redlineRpm * (0.35 - 0.17 * bsrT); // 0.35–0.18 of redline

  // Stroke in meters for piston speed
  const strokeM = strokeMm / 1000;

  // Calibration constant:
  // hp ≈ C * displacement[L] * PR * VE * (rpm / 1000)
  const C = 13.5;

  const rpmStart = 1000;
  for (let rpm = rpmStart; rpm <= redlineRpm; rpm += rpmStep) {
    const rpmK = rpm / 1000;

    // Gaussian VE vs RPM shaped by bore/stroke
    const veRpmRaw =
      veMax *
      Math.exp(-0.5 * Math.pow((rpm - vePeakRpm) / veWidth, 2));

    // Mean piston speed (4-stroke), m/s:
    const meanPistonSpeed = (2 * strokeM * rpm) / 60;

    // Piston speed penalty:
    let pistonEff = 1;
    if (meanPistonSpeed > pistonSpeedLimit) {
      const over = meanPistonSpeed - pistonSpeedLimit;
      // 4% VE loss per 1 m/s over limit, down to 35%
      pistonEff = clamp(1 - 0.04 * over, 0.35, 1);
    }

    // Low-rpm bias for long-stroke engines
    const lowRpmFactor =
      1 + (1 - bsrT) * (1 - rpm / redlineRpm) * 0.15;

    // Fuel behavior
    const fuelShape = getFuelShapeFactor(
      fuelType,
      rpm,
      redlineRpm
    );

    // Induction behavior (turbo lag / supercharger punch)
    const inductionShape = getInductionShapeFactor(
      inductionType,
      rpm,
      redlineRpm
    );

    let effectiveVE =
      veRpmRaw *
      sizeEff *
      pistonEff *
      lowRpmFactor *
      fuelShape *
      inductionShape;
    effectiveVE = clamp(effectiveVE, 0, 1.2);

    // Gross indicated hp from air/fuel mass flow
    const grossHp =
      C *
      displacementL *
      pressureRatio *
      effectiveVE *
      rpmK;

    // Friction / pumping losses:
    // Scales with displacement and RPM (linear + small quadratic)
    const baseFricPerL = 4.0;
    const slopeFricPerL = 1.2;
    const quadFricPerL = 0.2;
    let frictionHp =
      displacementL *
        (baseFricPerL + slopeFricPerL * rpmK) +
      quadFricPerL * displacementL * rpmK * rpmK;

    // Slightly more mechanical loss for heavy diesel guts
    if (fuelType === "diesel") {
      frictionHp *= 1.1;
    }

    // Supercharger parasitic loss: roughly proportional to boost * rpm * size
    let parasiticHp = 0;
    if (inductionType === "supercharger" && boostPsi > 0) {
      const boostFactor = boostPsi / 10; // normalized
      parasiticHp =
        boostFactor * displacementL * rpmK * 2.0;
    }

    const netHp = Math.max(
      grossHp - frictionHp - parasiticHp,
      0
    );
    const torque = rpm > 0 ? (netHp * 5252) / rpm : 0;

    // Fuel consumption
    const fuelLbPerHr = netHp * bsfc;
    const fuelGalPerHr =
      densityLbPerGal > 0
        ? fuelLbPerHr / densityLbPerGal
        : 0;

    points.push({
      rpm,
      hp: netHp,
      torque,
      effectiveVE,
      meanPistonSpeed,
      fuelLbPerHr,
      fuelGalPerHr
    });
  }

  return {
    points,
    displacementL,
    bsfc,
    densityLbPerGal
  };
}

/**
 * Wire up UI
 */
document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("engine-form");
  const warningsEl = document.getElementById("warnings");

  const displacementInput =
    document.getElementById("displacementL");

  const fuelTypeEl = document.getElementById("fuelType");
  const inductionTypeEl =
    document.getElementById("inductionType");
  const boostPsiEl = document.getElementById("boostPsi");

  const peakHpEl = document.getElementById("peakHp");
  const peakHpRpmEl =
    document.getElementById("peakHpRpm");
  const peakTqEl = document.getElementById("peakTq");
  const peakTqRpmEl =
    document.getElementById("peakTqRpm");
  const hpPerLEl = document.getElementById("hpPerL");
  const fuelAtPeakLbEl =
    document.getElementById("fuelAtPeakLb");
  const fuelAtPeakGalEl =
    document.getElementById("fuelAtPeakGal");

  const tableBody = document.querySelector(
    "#results-table tbody"
  );
  const chartCanvas =
    document.getElementById("powerChart");

  // Displacement is computed from geometry
  displacementInput.readOnly = true;

  // Enable/disable boost psi based on induction type
  function updateBoostState() {
    const type = inductionTypeEl.value;
    boostPsiEl.disabled = type === "na";
  }
  updateBoostState();
  inductionTypeEl.addEventListener(
    "change",
    updateBoostState
  );

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    warningsEl.textContent = "";

    const cylinders = parseInt(
      document.getElementById("cylinders").value,
      10
    );
    const boreMm = parseFloat(
      document.getElementById("boreMm").value
    );
    const strokeMm = parseFloat(
      document.getElementById("strokeMm").value
    );
    let redlineRpm = parseInt(
      document.getElementById("redlineRpm").value,
      10
    );
    const rpmStep = parseInt(
      document.getElementById("rpmStep").value,
      10
    );
    const vePeakPercent = parseFloat(
      document.getElementById("vePeak").value
    );
    const sizePenaltyPerL = parseFloat(
      document.getElementById("sizePenalty").value
    );
    const pistonSpeedLimit = parseFloat(
      document.getElementById(
        "pistonSpeedLimit"
      ).value
    );
    const fuelType = fuelTypeEl.value;
    const inductionType = inductionTypeEl.value;

    let boostPsi = 0;
    if (inductionType !== "na") {
      boostPsi = Math.max(
        0,
        parseFloat(boostPsiEl.value) || 0
      );
    }

    // Basic validation
    if (
      !cylinders ||
      !boreMm ||
      !strokeMm ||
      !redlineRpm ||
      !rpmStep ||
      rpmStep <= 0
    ) {
      warningsEl.textContent =
        "Please fill in all required numeric fields.";
      return;
    }

    if (redlineRpm < 3000) {
      warningsEl.textContent =
        "Redline must be at least 3000 rpm.";
      return;
    }

    if (rpmStep >= redlineRpm) {
      warningsEl.textContent =
        "RPM step is too large relative to redline.";
      return;
    }

    if (redlineRpm > 15000) {
      redlineRpm = 15000;
      document.getElementById(
        "redlineRpm"
      ).value = 15000;
      warningsEl.textContent =
        "Redline capped at 15,000 rpm for this simple model.";
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
      boostPsiInput: boostPsi
    };

    const {
      points,
      displacementL
    } = simulateEngine(params);

    if (!points.length) {
      warningsEl.textContent =
        "No RPM points generated – check your inputs.";
      return;
    }

    // Show computed displacement:
    displacementInput.value =
      displacementL.toFixed(2);

    // Find peaks + fuel at peak power
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

    const hpPerL =
      displacementL > 0 ? maxHp / displacementL : 0;

    // Update summary
    peakHpEl.textContent = peakHp.toFixed(1);
    peakHpRpmEl.textContent =
      peakHpRpm.toLocaleString();
    peakTqEl.textContent = peakTq.toFixed(1);
    peakTqRpmEl.textContent =
      peakTqRpm.toLocaleString();
    hpPerLEl.textContent = hpPerL.toFixed(1);

    if (pointAtPeakHp) {
      fuelAtPeakLbEl.textContent =
        pointAtPeakHp.fuelLbPerHr.toFixed(1);
      fuelAtPeakGalEl.textContent =
        pointAtPeakHp.fuelGalPerHr.toFixed(2);
    } else {
      fuelAtPeakLbEl.textContent = "–";
      fuelAtPeakGalEl.textContent = "–";
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
                  const label =
                    ctx.dataset.label || "";
                  return `${label}: ${ctx.parsed.y.toFixed(
                    1
                  )}`;
                }
              }
            }
          }
        }
      });
    }
  });
});
