/**
 * HostelNet QoS — Frontend Controller & Telemetry Client
 * Manages WebSocket synchronization, Chart.js telemetry, and traffic generators.
 */

// Global App State
const state = {
  ws: null,
  wsConnected: false,
  canvas: null,
  chart: null,
  chartHistorySeconds: 30,
  
  // Traffic Generator Intervals
  generators: {
    zoom: { timer: null, active: true, count: 0, rate: 0, lastTickCount: 0 },
    ipl: { timer: null, active: false, count: 0, rate: 0, lastTickCount: 0 },
    steam: { timer: null, active: false, count: 0, rate: 0, lastTickCount: 0 },
  },

  // Rolling Chart Data
  chartData: {
    labels: [],
    inflow: [],
    outflow: [],
    rawLimit: [],
  },

  lastMetricSnapshot: null,
};

// Initialize Application once DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  // 1. Initialize Canvas
  state.canvas = new TrafficCanvas('trafficCanvas');

  // 2. Initialize Chart.js
  initChart();

  // 3. Connect WebSocket / API Poller
  initWebSocket();

  // 4. Setup Event Listeners & UI Controls
  setupUIEventListeners();

  // 5. Start Traffic Generators
  startTrafficGenerator('zoom');

  // 6. Local Generator Rate Calculation Loop (every 1s)
  setInterval(updateLocalTrafficRates, 1000);
});

/* =========================================================================
   1. Real-Time Telemetry Chart (Chart.js)
   ========================================================================= */
function initChart() {
  const ctx = document.getElementById('trafficChart').getContext('2d');

  // Pre-fill last 30s with zeroes
  const now = new Date();
  for (let i = state.chartHistorySeconds; i >= 0; i--) {
    state.chartData.labels.push(`-${i}s`);
    state.chartData.inflow.push(0);
    state.chartData.outflow.push(0);
    state.chartData.rawLimit.push(5.0);
  }

  state.chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: state.chartData.labels,
      datasets: [
        {
          label: 'Bursty Inflow (pkt/s)',
          data: state.chartData.inflow,
          borderColor: '#F59E0B',
          backgroundColor: 'rgba(245, 158, 11, 0.08)',
          borderWidth: 2,
          borderDash: [5, 4],
          pointRadius: 0,
          tension: 0.3,
          fill: true,
        },
        {
          label: 'ISP Shaped Outflow (pkt/s)',
          data: state.chartData.outflow,
          borderColor: '#10B981',
          backgroundColor: 'rgba(16, 185, 129, 0.12)',
          borderWidth: 2.5,
          pointRadius: 0,
          tension: 0.2,
          fill: true,
        },
        {
          label: 'Raw Bottleneck Cap (5 pkt/s)',
          data: state.chartData.rawLimit,
          borderColor: '#EF4444',
          borderWidth: 1.5,
          borderDash: [2, 3],
          pointRadius: 0,
          fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: {
        intersect: false,
        mode: 'index',
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#181B22',
          titleColor: '#F1F5F9',
          bodyColor: '#94A3B8',
          borderColor: '#2A2F3A',
          borderWidth: 1,
          padding: 8,
          bodyFont: { family: 'JetBrains Mono', size: 11 },
          titleFont: { family: 'Inter', size: 11, weight: '600' },
        },
      },
      scales: {
        x: {
          grid: { color: '#1F242D', drawTicks: false },
          ticks: {
            color: '#64748B',
            font: { family: 'JetBrains Mono', size: 9 },
            maxTicksLimit: 8,
          },
        },
        y: {
          min: 0,
          max: 20,
          grid: { color: '#1F242D', drawTicks: false },
          ticks: {
            color: '#64748B',
            font: { family: 'JetBrains Mono', size: 10 },
            stepSize: 5,
          },
        },
      },
    },
  });

  // Chart Update Interval (1Hz)
  setInterval(() => {
    if (!state.lastMetricSnapshot) return;
    const inRate = state.lastMetricSnapshot.incoming_rate || 0;
    const outRate = state.lastMetricSnapshot.outgoing_rate || 0;

    // Shift window
    state.chartData.inflow.shift();
    state.chartData.inflow.push(inRate);

    state.chartData.outflow.shift();
    state.chartData.outflow.push(outRate);

    state.chartData.rawLimit.shift();
    state.chartData.rawLimit.push(5.0);

    state.chart.update('none');
  }, 1000);
}

/* =========================================================================
   2. WebSocket Telemetry Synchronization & API Fallback
   ========================================================================= */
function initWebSocket() {
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${window.location.host}/ws`;

  const wsIndicator = document.getElementById('ws-indicator');
  const wsStatus = document.getElementById('ws-status');

  try {
    state.ws = new WebSocket(wsUrl);

    state.ws.onopen = () => {
      state.wsConnected = true;
      wsIndicator.className = 'w-2 h-2 rounded-full bg-[#10B981]';
      wsStatus.textContent = 'WS SYNC';
      wsStatus.className = 'mono text-[#10B981]';
    };

    state.ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        handleServerPayload(payload);
      } catch (err) {
        console.error('Failed to parse WS payload', err);
      }
    };

    state.ws.onclose = () => {
      state.wsConnected = false;
      wsIndicator.className = 'w-2 h-2 rounded-full bg-[#F59E0B] animate-pulse';
      wsStatus.textContent = 'RETRYING';
      wsStatus.className = 'mono text-[#F59E0B]';
      setTimeout(initWebSocket, 2000);
    };

    state.ws.onerror = () => {
      state.wsConnected = false;
    };
  } catch (err) {
    console.warn('WS Init failed, falling back to HTTP polling', err);
    startHttpPolling();
  }
}

// Fallback HTTP polling in case WebSocket is blocked
let fallbackPoller = null;
function startHttpPolling() {
  if (fallbackPoller) return;
  fallbackPoller = setInterval(async () => {
    if (state.wsConnected) return;
    try {
      const res = await fetch('/api/state');
      if (res.ok) {
        const data = await res.json();
        handleServerPayload(data);
      }
    } catch (e) {}
  }, 100);
}

function handleServerPayload(payload) {
  if (!payload || !payload.metrics) return;
  state.lastMetricSnapshot = payload.metrics;

  // 1. Pass state to Canvas
  state.canvas.updateState(payload);

  // 2. Forward events to Canvas (arrived, buffered, transmitted, dropped)
  if (Array.isArray(payload.events)) {
    payload.events.forEach(evt => {
      state.canvas.handleEvent(evt);
      updateLastEventFeed(evt);
    });
  }

  // 3. Update DOM Metric Cards
  updateMetricCards(payload.metrics);
}

function updateMetricCards(m) {
  // Transmitted
  document.getElementById('metric-transmitted').textContent = m.transmitted_count.toLocaleString();
  document.getElementById('metric-out-rate').textContent = `${m.outgoing_rate.toFixed(1)} /s`;

  // Buffered
  document.getElementById('metric-buffered').textContent = m.buffered_count;
  document.getElementById('metric-capacity').textContent = m.bucket_capacity;

  // Dropped
  document.getElementById('metric-dropped').textContent = m.dropped_count.toLocaleString();
  const total = m.transmitted_count + m.dropped_count;
  const dropLoss = total > 0 ? ((m.dropped_count / total) * 100).toFixed(1) : '0.0';
  document.getElementById('metric-drop-rate').textContent = `${dropLoss}% loss`;

  // Congestion Status Badge
  const congBadge = document.getElementById('metric-congestion');
  const congCard = document.getElementById('card-congestion');
  const congSub = document.getElementById('congestion-sub');

  if (m.congestion_status === 'HEALTHY') {
    congBadge.textContent = 'HEALTHY';
    congBadge.className = 'text-base font-bold mono px-2 py-0.5 rounded bg-[#10B981]/20 text-[#10B981] border border-[#10B981]/40';
    congCard.className = 'noc-card p-3 border-t-2 border-t-[#10B981]';
    congSub.textContent = 'Smooth Link / Minimal Jitter';
  } else if (m.congestion_status === 'MODERATE') {
    congBadge.textContent = 'MODERATE';
    congBadge.className = 'text-base font-bold mono px-2 py-0.5 rounded bg-[#F59E0B]/20 text-[#F59E0B] border border-[#F59E0B]/40';
    congCard.className = 'noc-card p-3 border-t-2 border-t-[#F59E0B]';
    congSub.textContent = 'High Buffer Occupancy';
  } else {
    congBadge.textContent = 'CONGESTED';
    congBadge.className = 'text-base font-bold mono px-2 py-0.5 rounded bg-[#EF4444]/20 text-[#EF4444] border border-[#EF4444]/40 animate-pulse';
    congCard.className = 'noc-card p-3 border-t-2 border-t-[#EF4444]';
    congSub.textContent = m.shaper_enabled ? 'Buffer Overflow Drops' : 'Raw Link Saturated (>5 pkt/s)';
  }

  // Update Controls reflect server state
  document.getElementById('val-capacity').textContent = m.bucket_capacity;
  document.getElementById('val-leak-rate').textContent = m.leak_rate.toFixed(1);

  // Sync Shaper toggle display
  const toggle = document.getElementById('toggle-shaper');
  if (toggle.checked !== m.shaper_enabled) {
    toggle.checked = m.shaper_enabled;
  }

  const badge = document.getElementById('shaper-badge');
  const canvasMode = document.getElementById('canvas-mode-tag');
  const modeDesc = document.getElementById('mode-desc');
  const dropReasonLabel = document.getElementById('drop-reason-label');

  if (m.shaper_enabled) {
    badge.textContent = 'LEAKY BUCKET ON';
    badge.className = 'text-[11px] px-2 py-0.5 rounded mono font-semibold bg-[#10B981]/20 text-[#10B981] border border-[#10B981]/40';
    canvasMode.textContent = 'SHAPED QUEUE';
    canvasMode.className = 'text-[10px] mono px-1.5 py-0.5 rounded bg-[#10B981]/15 text-[#10B981] border border-[#10B981]/30';
    modeDesc.textContent = 'Active: FIFO buffer absorbs bursts & leaks smoothly';
    dropReasonLabel.textContent = 'Buffer Overflow Drops';
  } else {
    badge.textContent = 'BYPASS / RAW LINK';
    badge.className = 'text-[11px] px-2 py-0.5 rounded mono font-semibold bg-[#EF4444]/20 text-[#EF4444] border border-[#EF4444]/40';
    canvasMode.textContent = 'RAW FIFO BYPASS';
    canvasMode.className = 'text-[10px] mono px-1.5 py-0.5 rounded bg-[#EF4444]/15 text-[#EF4444] border border-[#EF4444]/30';
    modeDesc.textContent = 'Bypass: Direct link bottleneck at 5.0 pkt/s';
    dropReasonLabel.textContent = 'Link Saturation Drops';
  }
}

function updateLastEventFeed(evt) {
  const feed = document.getElementById('last-event-status');
  if (!feed) return;
  const pkt = evt.packet;
  const name = pkt.source === 'zoom' ? 'Zoom' : pkt.source === 'ipl' ? 'IPL' : 'Steam';

  if (evt.type === 'dropped') {
    feed.textContent = `[DROP] ${name} (${evt.reason || 'overflow'})`;
    feed.className = 'text-[#EF4444] font-bold';
  } else if (evt.type === 'transmitted') {
    feed.textContent = `[TX] ${name} packet to ISP`;
    feed.className = 'text-[#10B981] font-semibold';
  } else if (evt.type === 'buffered') {
    feed.textContent = `[QUEUE] ${name} buffered (slot #${evt.buffer_len || 1})`;
    feed.className = 'text-[#38BDF8]';
  }
}

/* =========================================================================
   3. Campus Traffic Generators
   ========================================================================= */
function startTrafficGenerator(source) {
  stopTrafficGenerator(source);
  state.generators[source].active = true;

  if (source === 'zoom') {
    // Placement Zoom Call: Steady stream ~1.5 pkt/s (1 packet every ~660ms)
    state.generators.zoom.timer = setInterval(() => {
      sendTraffic('zoom', 1);
      state.generators.zoom.count += 1;
    }, 660);
  } else if (source === 'ipl') {
    // 4K IPL Stream: Bursty chunks (3 to 5 packets every 1.5 - 2s)
    state.generators.ipl.timer = setInterval(() => {
      const burst = Math.floor(Math.random() * 3) + 3; // 3-5 pkts
      sendTraffic('ipl', burst);
      state.generators.ipl.count += burst;
    }, 1800);
  } else if (source === 'steam') {
    // 50GB Steam Download: Aggressive heavy surges (8-12 pkt/s)
    state.generators.steam.timer = setInterval(() => {
      const surge = Math.floor(Math.random() * 5) + 8; // 8-12 pkts
      sendTraffic('steam', surge);
      state.generators.steam.count += surge;
    }, 1000);
  }
}

function stopTrafficGenerator(source) {
  if (state.generators[source].timer) {
    clearInterval(state.generators[source].timer);
    state.generators[source].timer = null;
  }
  state.generators[source].active = false;
}

function updateLocalTrafficRates() {
  ['zoom', 'ipl', 'steam'].forEach(key => {
    const gen = state.generators[key];
    const diff = gen.count - gen.lastTickCount;
    gen.lastTickCount = gen.count;
    gen.rate = diff;
    const el = document.getElementById(`rate-${key}`);
    if (el) {
      el.textContent = `${diff.toFixed(1)} pkt/s`;
    }
  });
}

async function sendTraffic(source, count) {
  try {
    await fetch('/api/traffic', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, count }),
    });
  } catch (err) {
    console.error('Failed to send traffic', err);
  }
}

/* =========================================================================
   4. Shaper & Presets Controls Listeners
   ========================================================================= */
function setupUIEventListeners() {
  // Traffic Generator Toggles
  ['zoom', 'ipl', 'steam'].forEach(src => {
    const toggle = document.getElementById(`toggle-${src}`);
    toggle.addEventListener('change', (e) => {
      if (e.target.checked) {
        startTrafficGenerator(src);
      } else {
        stopTrafficGenerator(src);
      }
    });
  });

  // Traffic Manual Burst Buttons
  document.getElementById('btn-burst-zoom').addEventListener('click', () => {
    sendTraffic('zoom', 3);
    state.generators.zoom.count += 3;
  });
  document.getElementById('btn-burst-ipl').addEventListener('click', () => {
    sendTraffic('ipl', 5);
    state.generators.ipl.count += 5;
  });
  document.getElementById('btn-burst-steam').addEventListener('click', () => {
    sendTraffic('steam', 10);
    state.generators.steam.count += 10;
  });

  // Master Shaper Toggle
  const toggleShaper = document.getElementById('toggle-shaper');
  toggleShaper.addEventListener('change', async (e) => {
    const enabled = e.target.checked;
    await updateConfig({ shaper_enabled: enabled });
  });

  // Bucket Capacity Slider
  const sliderCap = document.getElementById('slider-capacity');
  sliderCap.addEventListener('input', (e) => {
    document.getElementById('val-capacity').textContent = e.target.value;
  });
  sliderCap.addEventListener('change', async (e) => {
    await updateConfig({ bucket_capacity: parseInt(e.target.value) });
  });

  // Leak Rate Slider
  const sliderRate = document.getElementById('slider-leak-rate');
  sliderRate.addEventListener('input', (e) => {
    document.getElementById('val-leak-rate').textContent = parseFloat(e.target.value).toFixed(1);
  });
  sliderRate.addEventListener('change', async (e) => {
    await updateConfig({ leak_rate: parseFloat(e.target.value) });
  });

  // Reset Button
  document.getElementById('btn-reset').addEventListener('click', async () => {
    try {
      await fetch('/api/reset', { method: 'POST' });
      ['zoom', 'ipl', 'steam'].forEach(k => {
        state.generators[k].count = 0;
        state.generators[k].lastTickCount = 0;
      });
      // Clear chart history
      state.chartData.inflow.fill(0);
      state.chartData.outflow.fill(0);
      state.chart.update('none');
    } catch (err) {
      console.error('Failed to reset', err);
    }
  });

  // Presets
  document.getElementById('preset-bypass').addEventListener('click', async () => {
    // 1. Shaper OFF
    await updateConfig({ shaper_enabled: false });
    // 2. Turn ON all 3 traffic generators
    document.getElementById('toggle-zoom').checked = true;
    document.getElementById('toggle-ipl').checked = true;
    document.getElementById('toggle-steam').checked = true;
    startTrafficGenerator('zoom');
    startTrafficGenerator('ipl');
    startTrafficGenerator('steam');
  });

  document.getElementById('preset-shaper').addEventListener('click', async () => {
    // 1. Shaper ON, Capacity 15, Leak Rate 5.0
    await updateConfig({ shaper_enabled: true, bucket_capacity: 15, leak_rate: 5.0 });
    document.getElementById('slider-capacity').value = 15;
    document.getElementById('slider-leak-rate').value = 5.0;
    // 2. Turn ON all 3 traffic generators
    document.getElementById('toggle-zoom').checked = true;
    document.getElementById('toggle-ipl').checked = true;
    document.getElementById('toggle-steam').checked = true;
    startTrafficGenerator('zoom');
    startTrafficGenerator('ipl');
    startTrafficGenerator('steam');
  });

  document.getElementById('preset-surge').addEventListener('click', async () => {
    // Inject massive burst from Steam
    sendTraffic('steam', 15);
    state.generators.steam.count += 15;
  });
}

async function updateConfig(config) {
  try {
    await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
  } catch (err) {
    console.error('Failed to update config', err);
  }
}
