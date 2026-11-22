/**
 * app.js — HostelNet QoS UI Controller
 * Wires DOM controls ↔ engine + canvas.
 * Drives the 60fps requestAnimationFrame loop.
 * Manages Chart.js dual-line rate graph.
 */

'use strict';

// ─── Init on DOM ready ────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {

  // ── Engine & Canvas ─────────────────────────────────────────────────────────
  const engine = new LeakyBucketEngine();
  const canvasEl = document.getElementById('mainCanvas');
  const animator = new TrafficCanvas(canvasEl, engine);

  // ── Chart.js Setup ──────────────────────────────────────────────────────────
  const chartCtx = document.getElementById('rateChart').getContext('2d');
  const CHART_POINTS = 30; // 30 seconds

  const rateChart = new Chart(chartCtx, {
    type: 'line',
    data: {
      labels: Array.from({ length: CHART_POINTS }, (_, i) => `${i - CHART_POINTS + 1}s`),
      datasets: [
        {
          label: 'Incoming Rate (pkt/s)',
          data: new Array(CHART_POINTS).fill(0),
          borderColor: '#B45309',
          borderDash: [5, 3],
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.4,
          fill: false,
        },
        {
          label: 'Outgoing Rate (pkt/s)',
          data: new Array(CHART_POINTS).fill(0),
          borderColor: '#15803D',
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.4,
          fill: false,
        },
      ],
    },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: {
            font: { family: 'Inter', size: 11 },
            color: '#52525B',
            boxWidth: 20,
            padding: 12,
          },
        },
        tooltip: { enabled: false },
      },
      scales: {
        x: {
          ticks: { font: { family: 'JetBrains Mono', size: 9 }, color: '#52525B', maxTicksLimit: 6 },
          grid:  { color: '#E4E4DF', lineWidth: 0.5 },
        },
        y: {
          min: 0,
          suggestedMax: 15,
          ticks: { font: { family: 'JetBrains Mono', size: 9 }, color: '#52525B', stepSize: 5 },
          grid:  { color: '#E4E4DF', lineWidth: 0.5 },
        },
      },
    },
  });

  // ── Chart update (called every second) ──────────────────────────────────────
  let _chartLastSec = 0;
  function updateChart(now) {
    if (now - _chartLastSec < 1000) return;
    _chartLastSec = now;
    const history = engine.getRateHistory(CHART_POINTS);
    rateChart.data.datasets[0].data = history.inRate;
    rateChart.data.datasets[1].data = history.outRate;
    rateChart.update('none');
  }

  // ── 60fps RAF loop ──────────────────────────────────────────────────────────
  let _lastTs = 0;
  function loop(ts) {
    const dt = Math.min(ts - _lastTs, 50); // cap at 50ms to avoid spiral on tab-blur
    _lastTs = ts;

    engine.tick(dt);
    animator.render();
    updateMetrics();
    updateChart(ts);

    requestAnimationFrame(loop);
  }
  requestAnimationFrame(ts => { _lastTs = ts; requestAnimationFrame(loop); });

  // ── Live Metric DOM Updates ─────────────────────────────────────────────────
  const elTransmitted = document.getElementById('metTransmitted');
  const elBuffered    = document.getElementById('metBuffered');
  const elDropped     = document.getElementById('metDropped');
  const elDropRate    = document.getElementById('metDropRate');
  const elLatency     = document.getElementById('metLatency');
  const elBadgeStatus = document.getElementById('badgeStatus');
  const elBadgeLatency= document.getElementById('badgeLatency');
  const elCongestion  = document.getElementById('congestionLabel');

  function updateMetrics() {
    elTransmitted.textContent = engine.transmitted;
    elBuffered.textContent    = engine.buffered;
    elDropped.textContent     = engine.dropped;
    elDropRate.textContent    = engine.dropRate + '%';
    elLatency.textContent     = engine.zoomLatencyMs + ' ms';

    // Zoom health badge
    const lat    = engine.zoomLatencyMs;
    const smooth = lat < 30;
    elBadgeStatus.textContent  = smooth ? 'SMOOTH' : 'LAGGING';
    elBadgeLatency.textContent = lat + ' ms';
    const badge = document.getElementById('zoomBadge');
    badge.className = 'zoom-badge ' + (smooth ? 'badge-smooth' : 'badge-lagging');

    // Congestion label
    const cmap = { HEALTHY: '#15803D', MODERATE: '#B45309', CONGESTED: '#B91C1C' };
    elCongestion.textContent  = engine.congestion;
    elCongestion.style.color  = cmap[engine.congestion];

    // Buffered counter color
    const bufFill = engine.shaperEnabled
      ? engine.bucket.length / engine.bucketCapacity
      : engine.rawQueue.length / 20;
    elBuffered.style.color = bufFill > 0.75 ? '#B91C1C' : bufFill > 0.4 ? '#B45309' : '#18181B';
    elDropped.style.color  = engine.dropped > 0 ? '#B91C1C' : '#18181B';
  }

  // ── Preset Buttons ──────────────────────────────────────────────────────────
  document.querySelectorAll('[data-preset]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = parseInt(btn.dataset.preset);
      engine.applyPreset(id);
      syncAllControls();
    });
  });

  // ── Shaper Toggle ───────────────────────────────────────────────────────────
  const shaperToggle = document.getElementById('shaperToggle');
  const shaperLabel  = document.getElementById('shaperLabel');
  shaperToggle.addEventListener('change', () => {
    engine.setConfig({ shaperEnabled: shaperToggle.checked });
    updateShaperLabel();
  });
  function updateShaperLabel() {
    shaperLabel.textContent = shaperToggle.checked ? 'ON' : 'OFF (Bufferbloat)';
    shaperLabel.className   = 'toggle-label ' + (shaperToggle.checked ? 'label-on' : 'label-off');
  }

  // ── Source Toggles ──────────────────────────────────────────────────────────
  ['zoom', 'ipl', 'steam'].forEach(src => {
    const toggle = document.getElementById(`toggle_${src}`);
    if (toggle) {
      toggle.addEventListener('change', () => {
        engine.setSource(src, toggle.checked);
      });
    }
    const burstBtn = document.getElementById(`burst_${src}`);
    if (burstBtn) {
      burstBtn.addEventListener('click', () => engine.burst(src));
    }
  });

  // ── Sliders ─────────────────────────────────────────────────────────────────
  const capacitySlider  = document.getElementById('capacitySlider');
  const leakRateSlider  = document.getElementById('leakRateSlider');
  const capacityDisplay = document.getElementById('capacityDisplay');
  const leakRateDisplay = document.getElementById('leakRateDisplay');

  capacitySlider.addEventListener('input', () => {
    const v = parseInt(capacitySlider.value);
    capacityDisplay.textContent = v;
    engine.setConfig({ bucketCapacity: v });
  });

  leakRateSlider.addEventListener('input', () => {
    const v = parseFloat(leakRateSlider.value);
    leakRateDisplay.textContent = v.toFixed(1);
    engine.setConfig({ leakRate: v });
  });

  // ── Reset Button ────────────────────────────────────────────────────────────
  document.getElementById('resetBtn').addEventListener('click', () => {
    engine.reset();
    // keep source/shaper state but reset toggles to off
    ['zoom', 'ipl', 'steam'].forEach(src => {
      engine.setSource(src, false);
      const t = document.getElementById(`toggle_${src}`);
      if (t) t.checked = false;
    });
    rateChart.data.datasets[0].data = new Array(CHART_POINTS).fill(0);
    rateChart.data.datasets[1].data = new Array(CHART_POINTS).fill(0);
    rateChart.update('none');
  });

  // ── Sync all UI controls from engine state ──────────────────────────────────
  function syncAllControls() {
    shaperToggle.checked = engine.shaperEnabled;
    updateShaperLabel();
    ['zoom', 'ipl', 'steam'].forEach(src => {
      const t = document.getElementById(`toggle_${src}`);
      if (t) t.checked = !!engine.sourceActive[src];
    });
    capacitySlider.value      = engine.bucketCapacity;
    capacityDisplay.textContent = engine.bucketCapacity;
    leakRateSlider.value      = engine.leakRate;
    leakRateDisplay.textContent = engine.leakRate.toFixed(1);
  }

  // Initial sync
  syncAllControls();

});
