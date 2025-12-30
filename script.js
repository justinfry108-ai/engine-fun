// Improved Simple Engine Simulator
// - Uses bore/stroke/cyl to compute displacement
// - Bore/stroke ratio changes curve shape
// - Piston speed & friction penalties for crazy RPM
// - Calibrated for "reasonable" NA and boosted numbers (still a toy!)

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
 * Core simulation function.
 * Returns:
 *  - points: array of { rpm, hp, torque, effectiveVE, meanPistonSpeed }
 *  - displacementL: computed from bore/stroke/cyl
 */
function simulateEngine(params) {
  const {
    cylinders,
    boreMm,
    strokeMm,
    redlineRpm,
    rpmStep,
    boostPsi,
    vePeakPercent,
    sizePenaltyPerL,
    pistonSpeedLimit
  } = params;

  const displacementL = computeDisplacementL(cylinders, boreMm, strokeMm);

  const points = [];

  // Boost pressure ratio
  const pressureRatio = 1 + (boostPsi > 0 ? boostPsi / 14.7 : 0);

  // Size efficiency: bigger engines lose a bit of hp/L beyond 2.0L
  const extraLiters = Math.max(0, displacementL - 2);
  const sizeEffFactor = 1 - (sizePenaltyPerL / 100) * extraLiters;
  const sizeEff = clamp(sizeEffFactor, 0.65, 1.05);

  // Volumetric efficiency baseline (as fraction)
  const veMax = vePeakPercent / 100;

  // Bore/stroke ratio: <1 = long stroke, >1 = big bore
  const bsr = boreMm / strokeMm;
  const bsrClamp = clamp(bsr, 0.7, 1.6);
  const bsrT = (bsrClamp - 0.7) / (1.6 - 0.7); // 0..1

  // Shape the VE curve based on B/S:
  // - undersquare (long stroke): lower peak rpm, wider hump
  // - oversquare (big bore): higher peak rpm, narrower hump
  const vePeakRpm = redlineRpm * (0.5 + 0.4 * bsrT); // 0.5–0.9 of redline
  const veWidth = redlineRpm * (0.35 - 0.17 * bsrT); // 0.35–0.18 of redline

  // Stroke in meters for piston speed
  const strokeM = strokeMm / 1000;

  // Calibration constant:
  // hp ≈ C * displacement[L] * PR * VE * (rpm / 1000)
  // Tuned so a strong 2.0L NA at ~8000–9000 rpm can get near 200 hp with good VE.
  const C = 14;

  // Simple friction / pumping loss model:
  // grows with rpm^2 and displacement
  const frictionK = 0.22 * displacementL;

  const rpmStart = 1000;
  for (let rpm = rpmStart; rpm <= redlineRpm; rpm += rpmStep) {
    // Gaussian VE vs RPM shaped by bore/stroke
    const veRpmRaw =
      veMax *
      Math.exp(-0.5 * Math.pow((rpm - vePeakRpm) / veWidth, 2));

    // Mean piston speed (4-stroke), m/s:
    // mps ≈ 2 * stroke * rpm / 60
    const meanPistonSpeed = (2 * strokeM * rpm) / 60;

    // Piston speed penalty:
    // Above limit, VE gets hammered fairly hard.
    let pistonEff = 1;
    if (meanPistonSpeed > pistonSpeedLimit) {
      const over = meanPistonSpeed - pistonSpeedLimit;
      // 4% VE loss per 1 m/s over limit, down to 35% of original
      pistonEff = clamp(1 - 0.04 * over, 0.35, 1);
    }

    // Add a mild low-rpm bias for long-stroke engines:
    // More grunt down low, less up top.
    const lowRpmFactor = 1 + (1 - bsrT) * (1 - rpm / redlineRpm) * 0.15;

    let effectiveVE =
      veRpmRaw * sizeEff * pistonEff * lowRpmFactor;
    effectiveVE = clamp(effectiveVE, 0, 1.2);

    // Gross indicated hp from air/fuel mass flow
    const grossHp =
      C * displacementL * pressureRatio * effectiveVE * (rpm / 1000);

    // Friction / pumping loss grows with rpm^2
    const frictionLoss = frictionK * Math.pow(rpm / 1000, 2);

    const netHp = Math.max(grossHp - frictionLoss, 0);
    const torque = netHp * 5252 / rpm;

    points.push({
      rpm,
      hp: netHp,
      torque,
      effectiveVE,
      meanPistonSpeed
    });
  }

  return { points, displacementL };
}

/**
 * Wire up UI
 */
document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("engine-form");
  const boostEnabledEl = document.getElementById("boostEnabled");
  const boostPsiEl = document.getElementById("boostPsi");
  const warningsEl = document.getElementById("warnings");

  const displacementInput = document.getElementById("displacementL");

  const peakHpEl = document.getElementById("peakHp");
  const peakHpRpmEl = document.getElementById("peakHpRpm");
  const peakTqEl = document.getElementById("peakTq");
  const peakTqRpmEl = document.getElementById("peakTqRpm");
  const hpPerLEl = document.getElementById("hpPerL");

  const tableBody = document.querySelector("#results-table tbody");
  const chartCanvas = document.getElementById("powerChart");

  // We now treat displacement as "computed" from bore/stroke/cyl.
  // Make it read-only so people don't try to fight the geometry.
  displacementInput.readOnly = true;

  // Disable/enable boost psi input
  function updateBoostState() {
    boostPsiEl.disabled = !boostEnabledEl.checked;
  }
  updateBoostState();
  boostEnabledEl.addEventListener("change", updateBoostState);

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
      document.getElementById("pistonSpeedLimit").value
    );

    let boostPsi = 0;
    if (boostEnabledEl.checked) {
      boostPsi = Math.max(0, parseFloat(boostPsiEl.value) || 0);
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

    // Hard cap stupid-high redlines so the math doesn't go insane.
    if (redlineRpm > 15000) {
      redlineRpm = 15000;
      document.getElementById("redlineRpm").value = 15000;
      warningsEl.textContent =
        "Redline capped at 15,000 rpm for this simple model.";
    }

    const params = {
      cylinders,
      boreMm,
      strokeMm,
      redlineRpm,
      rpmStep,
      boostPsi,
      vePeakPercent,
      sizePenaltyPerL,
      pistonSpeedLimit
    };

    const { points, displacementL } = simulateEngine(params);

    if (!points.length) {
      warningsEl.textContent =
        "No RPM points generated – check your inputs.";
      return;
    }

    // Show computed displacement in the UI
    displacementInput.value = displacementL.toFixed(2);

    // Find peaks
    let peakHp = -Infinity;
    let peakHpRpm = 0;
    let peakTq = -Infinity;
    let peakTqRpm = 0;
    let maxHp = 0;

    points.forEach((pt) => {
      if (pt.hp > peakHp) {
        peakHp = pt.hp;
        peakHpRpm = pt.rpm;
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
