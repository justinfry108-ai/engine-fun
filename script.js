// Simple engine model & UI wiring

let chart;

/**
 * Core simulation function.
 * Extremely simplified, just for fun / educational use.
 */
function simulateEngine(params) {
  const {
    displacementL,
    boreMm,
    strokeMm,
    redlineRpm,
    rpmStep,
    boostPsi,
    vePeakPercent,
    sizePenaltyPerL,
    pistonSpeedLimit
  } = params;

  const results = [];

  const pressureRatio = 1 + (boostPsi > 0 ? boostPsi / 14.7 : 0);

  // Size efficiency: engines bigger than 2.0L get a hp/L penalty.
  // Example: sizePenaltyPerL = 3 (%), displacement 3.0L -> 3% * (3 - 2) = 3% less hp/L.
  const extraLiters = Math.max(0, displacementL - 2);
  const sizeEffFactor = 1 - (sizePenaltyPerL / 100) * extraLiters;
  const sizeEff = clamp(sizeEffFactor, 0.7, 1.05);

  // Volumetric efficiency curve parameters
  const veMax = vePeakPercent / 100;
  const vePeakRpm = redlineRpm * 0.65; // torque peak ~65% of redline
  const veWidth = redlineRpm * 0.22;   // how wide the VE hump is

  // Piston speed
  const strokeM = strokeMm / 1000;

  // Cal constant:
  // hp = C * displacement[L] * PR * VE * (rpm / 1000)
  // We pick C so a 2.0L NA @ 7000 rpm ~ 150-170 hp.
  const C = 10;

  const rpmStart = 1000;
  for (let rpm = rpmStart; rpm <= redlineRpm; rpm += rpmStep) {
    // Gaussian VE vs RPM
    const veRpmRaw = veMax * Math.exp(
      -0.5 * Math.pow((rpm - vePeakRpm) / veWidth, 2)
    );

    // Mean piston speed (4-stroke), approx: 2 * stroke * rpm / 60 (m/s)
    const meanPistonSpeed = (2 * strokeM * rpm) / 60;

    // Piston speed penalty: above the soft limit, VE slowly drops
    let pistonEff = 1;
    if (meanPistonSpeed > pistonSpeedLimit) {
      const over = meanPistonSpeed - pistonSpeedLimit;
      // 1% loss per 1 m/s over limit, down to 70%
      pistonEff = clamp(1 - 0.01 * over, 0.7, 1);
    }

    const effectiveVE = clamp(veRpmRaw * sizeEff * pistonEff, 0, 1.2);

    const hp = C * displacementL * pressureRatio * effectiveVE * (rpm / 1000);
    const torque = hp * 5252 / rpm;

    results.push({
      rpm,
      hp,
      torque,
      effectiveVE,
      meanPistonSpeed
    });
  }

  return results;
}

/**
 * Clamp helper
 */
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Hook up UI
 */
document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("engine-form");
  const boostEnabledEl = document.getElementById("boostEnabled");
  const boostPsiEl = document.getElementById("boostPsi");
  const warningsEl = document.getElementById("warnings");

  const peakHpEl = document.getElementById("peakHp");
  const peakHpRpmEl = document.getElementById("peakHpRpm");
  const peakTqEl = document.getElementById("peakTq");
  const peakTqRpmEl = document.getElementById("peakTqRpm");
  const hpPerLEl = document.getElementById("hpPerL");

  const tableBody = document.querySelector("#results-table tbody");
  const chartCanvas = document.getElementById("powerChart");

  // Disable/enable boost psi
  function updateBoostState() {
    boostPsiEl.disabled = !boostEnabledEl.checked;
  }
  updateBoostState();
  boostEnabledEl.addEventListener("change", updateBoostState);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    warningsEl.textContent = "";

    const displacementL = parseFloat(
      document.getElementById("displacementL").value
    );
    const cylinders = parseInt(document.getElementById("cylinders").value, 10);
    const boreMm = parseFloat(document.getElementById("boreMm").value);
    const strokeMm = parseFloat(document.getElementById("strokeMm").value);
    const redlineRpm = parseInt(
      document.getElementById("redlineRpm").value,
      10
    );
    const rpmStep = parseInt(document.getElementById("rpmStep").value, 10);
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
      !displacementL ||
      !boreMm ||
      !strokeMm ||
      !redlineRpm ||
      !rpmStep ||
      rpmStep <= 0
    ) {
      warningsEl.textContent = "Please fill in all required numeric fields.";
      return;
    }

    if (redlineRpm <= 2000) {
      warningsEl.textContent = "Redline must be higher than 2000 rpm.";
      return;
    }

    if (rpmStep >= redlineRpm) {
      warningsEl.textContent = "RPM step is too large.";
      return;
    }

    if (displacementL > 8) {
      warningsEl.textContent =
        "Warning: This model is tuned mostly for small automotive engines (< 8L).";
    }

    const params = {
      displacementL,
      boreMm,
      strokeMm,
      redlineRpm,
      rpmStep,
      boostPsi,
      vePeakPercent,
      sizePenaltyPerL,
      pistonSpeedLimit
    };

    const results = simulateEngine(params);

    if (!results.length) {
      warningsEl.textContent = "No RPM points generated – check your inputs.";
      return;
    }

    // Find peaks
    let peakHp = -Infinity;
    let peakHpRpm = 0;
    let peakTq = -Infinity;
    let peakTqRpm = 0;
    let maxHp = 0;

    results.forEach((pt) => {
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

    const hpPerL = displacementL > 0 ? maxHp / displacementL : 0;

    // Update summary
    peakHpEl.textContent = peakHp.toFixed(1);
    peakHpRpmEl.textContent = peakHpRpm.toLocaleString();
    peakTqEl.textContent = peakTq.toFixed(1);
    peakTqRpmEl.textContent = peakTqRpm.toLocaleString();
    hpPerLEl.textContent = hpPerL.toFixed(1);

    // Update table
    tableBody.innerHTML = "";
    results.forEach((pt) => {
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
    const labels = results.map((pt) => pt.rpm);
    const hpData = results.map((pt) => pt.hp);
    const tqData = results.map((pt) => pt.torque);

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
