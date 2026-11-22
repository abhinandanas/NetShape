/**
 * engine.js — HostelNet QoS Simulation Engine
 * Pure JavaScript leaky bucket & raw FIFO simulation.
 * No dependencies. Called every frame by app.js.
 */

'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────
const LINK_CAP_PPS   = 5.0;   // ISP link capacity (packets/sec) in raw/bypass mode
const TICK_MS        = 16;    // ~60 fps tick interval
const HISTORY_LEN    = 1800;  // 30 s × 60 fps

// Traffic source descriptors
const SOURCES = {
  zoom:  { label: 'Zoom Call',       rate: 1.5,  size: 200,  color: '#1D4ED8' },
  ipl:   { label: '4K IPL Stream',   rate: 4.0,  size: 800,  color: '#B45309' },
  steam: { label: 'Steam Download',  rate: 10.0, size: 1500, color: '#C2410C' },
};

// ─── Packet class ─────────────────────────────────────────────────────────────
class Packet {
  constructor(source, id) {
    this.id      = id;
    this.source  = source;           // 'zoom' | 'ipl' | 'steam'
    this.color   = SOURCES[source].color;
    this.size    = SOURCES[source].size;
    this.born    = performance.now();
    // Animation state (managed by canvas.js)
    this.x = 0; this.y = 0;
    this.vx = 0; this.vy = 0;
    this.phase   = 'spawn';          // spawn → travel → queued → tx / drop
    this.alpha   = 1;
  }
}

// ─── LeakyBucketEngine ────────────────────────────────────────────────────────
class LeakyBucketEngine {
  constructor() {
    // Config (user-adjustable)
    this.shaperEnabled   = false;
    this.bucketCapacity  = 15;       // max packets in leaky bucket
    this.leakRate        = 5.0;      // packets/sec leaving bucket

    // Source ON/OFF toggles
    this.sourceActive    = { zoom: false, ipl: false, steam: false };

    // Counters (reset-able)
    this.transmitted     = 0;
    this.dropped         = 0;
    this.totalArrived    = 0;

    // Live state
    this.bucket          = [];       // leaky bucket FIFO queue
    this.rawQueue        = [];       // raw FIFO queue (shaper OFF)
    this.zoomLatencyMs   = 0;        // estimated Zoom latency

    // Rate accumulators (smoothed over ~1s)
    this._inAcc          = 0;        // packets arrived in current window
    this._outAcc         = 0;        // packets transmitted in current window
    this._windowMs       = 0;        // elapsed ms in current 1-s window
    this.incomingRate    = 0;
    this.outgoingRate    = 0;

    // Fractional leak accumulator (sub-tick precision)
    this._leakCarry      = 0;

    // Burst fractional accumulators per source
    this._spawnCarry     = { zoom: 0, ipl: 0, steam: 0 };
    this._burstQueue     = [];       // one-shot burst packets queued

    // History for Chart.js (ring buffers)
    this.inRateHistory   = new Float32Array(HISTORY_LEN);
    this.outRateHistory  = new Float32Array(HISTORY_LEN);
    this._histIdx        = 0;

    // Packet pool for canvas animation
    this.livePackets     = [];       // packets currently animating
    this._nextId         = 0;

    // Congestion
    this.congestion      = 'HEALTHY'; // HEALTHY | MODERATE | CONGESTED

    // IPL burst timer
    this._iplBurstTimer  = 0;
    this._iplBurstActive = false;
    this._iplBurstLeft   = 0;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Update config from UI sliders/toggles. */
  setConfig({ shaperEnabled, bucketCapacity, leakRate }) {
    if (shaperEnabled  !== undefined) this.shaperEnabled  = shaperEnabled;
    if (bucketCapacity !== undefined) this.bucketCapacity = Math.max(5, Math.min(30, bucketCapacity));
    if (leakRate       !== undefined) this.leakRate       = Math.max(1, Math.min(15, leakRate));
  }

  /** Toggle a traffic source ON/OFF. */
  setSource(src, active) {
    if (src in this.sourceActive) this.sourceActive[src] = active;
  }

  /** Inject a manual burst from one source. */
  burst(src) {
    const count = src === 'steam' ? 12 : src === 'ipl' ? 5 : 3;
    for (let i = 0; i < count; i++) this._burstQueue.push(src);
  }

  /** Reset all counters, queues, histories. */
  reset() {
    this.transmitted   = 0;
    this.dropped       = 0;
    this.totalArrived  = 0;
    this.bucket        = [];
    this.rawQueue      = [];
    this.livePackets   = [];
    this._leakCarry    = 0;
    this._spawnCarry   = { zoom: 0, ipl: 0, steam: 0 };
    this._burstQueue   = [];
    this._inAcc        = 0;
    this._outAcc       = 0;
    this._windowMs     = 0;
    this.incomingRate  = 0;
    this.outgoingRate  = 0;
    this.inRateHistory.fill(0);
    this.outRateHistory.fill(0);
    this._histIdx      = 0;
    this.zoomLatencyMs = 0;
    this.congestion    = 'HEALTHY';
    this._iplBurstTimer  = 0;
    this._iplBurstActive = false;
    this._iplBurstLeft   = 0;
  }

  /** Apply a demo preset. */
  applyPreset(id) {
    this.reset();
    if (id === 1) {
      // Zoom Only
      this.sourceActive  = { zoom: true,  ipl: false, steam: false };
      this.shaperEnabled = true;
    } else if (id === 2) {
      // Trigger Bufferbloat
      this.sourceActive  = { zoom: true, ipl: true, steam: true };
      this.shaperEnabled = false;
    } else if (id === 3) {
      // Activate Leaky Bucket
      this.sourceActive  = { zoom: true, ipl: true, steam: true };
      this.shaperEnabled = true;
    }
  }

  /** Main simulation tick — called once per animation frame (~16ms). */
  tick(dt = TICK_MS) {
    // 1. Spawn packets from active sources
    this._spawnPackets(dt);

    // 2. Process depending on mode
    if (this.shaperEnabled) {
      this._tickShaperOn(dt);
    } else {
      this._tickShaperOff(dt);
    }

    // 3. Update rate estimates
    this._updateRates(dt);

    // 4. Prune dead livePackets
    this.livePackets = this.livePackets.filter(p => p.alpha > 0.01 && p.phase !== 'dead');

    // 5. Compute derived metrics
    this._updateCongestion();
    this._updateZoomLatency();
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  _mkPacket(src) {
    const p = new Packet(src, this._nextId++);
    this.totalArrived++;
    this._inAcc++;
    this.livePackets.push(p);
    return p;
  }

  _spawnPackets(dt) {
    const dtSec = dt / 1000;

    // IPL burst logic: every ~3s fire a 5-packet burst
    if (this.sourceActive.ipl) {
      this._iplBurstTimer += dt;
      if (!this._iplBurstActive && this._iplBurstTimer > 3000) {
        this._iplBurstActive = true;
        this._iplBurstLeft   = 5;
        this._iplBurstTimer  = 0;
      }
      if (this._iplBurstActive && this._iplBurstLeft > 0) {
        // Spawn up to 2 burst packets per tick
        const n = Math.min(2, this._iplBurstLeft);
        for (let i = 0; i < n; i++) this._burstQueue.push('ipl');
        this._iplBurstLeft -= n;
        if (this._iplBurstLeft <= 0) this._iplBurstActive = false;
      }
    }

    // Continuous source spawning (fractional accumulator)
    for (const src of ['zoom', 'ipl', 'steam']) {
      if (!this.sourceActive[src]) { this._spawnCarry[src] = 0; continue; }
      this._spawnCarry[src] += SOURCES[src].rate * dtSec;
      while (this._spawnCarry[src] >= 1) {
        this._burstQueue.push(src);
        this._spawnCarry[src] -= 1;
      }
    }

    // Flush burst queue → route packets
    for (const src of this._burstQueue) {
      const p = this._mkPacket(src);
      p.phase = 'spawn';
      if (this.shaperEnabled) {
        this._routeShaper(p);
      } else {
        this._routeRaw(p);
      }
    }
    this._burstQueue = [];
  }

  // ── Shaper ON (Leaky Bucket) ─────────────────────────────────────────────────

  _routeShaper(p) {
    if (p.source === 'zoom') {
      // Zoom gets priority express lane — does not go through the bucket
      p.phase = 'priority';
      // Zoom always transmitted (priority) — counted immediately
      this.transmitted++;
      this._outAcc++;
    } else {
      // Bulk traffic enters leaky bucket
      if (this.bucket.length < this.bucketCapacity) {
        this.bucket.push(p);
        p.phase = 'queued';
      } else {
        // Bucket full — drop
        this.dropped++;
        p.phase = 'dropped';
        p.alpha = 0.8;
      }
    }
  }

  _tickShaperOn(dt) {
    // Drain bucket at leakRate
    this._leakCarry += this.leakRate * (dt / 1000);
    while (this._leakCarry >= 1 && this.bucket.length > 0) {
      const p = this.bucket.shift();
      p.phase = 'tx';
      this.transmitted++;
      this._outAcc++;
      this._leakCarry -= 1;
    }
    if (this._leakCarry > 1) this._leakCarry = 1; // cap carry
  }

  // ── Shaper OFF (Raw FIFO / Bufferbloat) ─────────────────────────────────────

  _routeRaw(p) {
    this.rawQueue.push(p);
    p.phase = 'queued';
  }

  _tickShaperOff(dt) {
    // Link capacity: LINK_CAP_PPS packets/sec
    this._leakCarry += LINK_CAP_PPS * (dt / 1000);
    while (this._leakCarry >= 1 && this.rawQueue.length > 0) {
      const p = this.rawQueue.shift();
      p.phase = 'tx';
      this.transmitted++;
      this._outAcc++;
      this._leakCarry -= 1;
    }
    if (this._leakCarry > 1) this._leakCarry = 1;

    // When rawQueue grows beyond 20 packets, start dropping (router overflow)
    const MAX_RAW = 20;
    while (this.rawQueue.length > MAX_RAW) {
      const p = this.rawQueue.pop();
      this.dropped++;
      p.phase = 'dropped';
      p.alpha = 0.8;
    }
  }

  // ── Rates & Metrics ─────────────────────────────────────────────────────────

  _updateRates(dt) {
    this._windowMs += dt;
    if (this._windowMs >= 1000) {
      const sec = this._windowMs / 1000;
      this.incomingRate = this._inAcc  / sec;
      this.outgoingRate = this._outAcc / sec;
      this._inAcc  = 0;
      this._outAcc = 0;
      this._windowMs = 0;

      // Push to history ring buffer
      this.inRateHistory[this._histIdx]  = this.incomingRate;
      this.outRateHistory[this._histIdx] = this.outgoingRate;
      this._histIdx = (this._histIdx + 1) % HISTORY_LEN;
    }
  }

  _updateCongestion() {
    const qLen = this.shaperEnabled ? this.bucket.length : this.rawQueue.length;
    const cap  = this.shaperEnabled ? this.bucketCapacity : 20;
    const fill = qLen / cap;
    if (fill < 0.4) this.congestion = 'HEALTHY';
    else if (fill < 0.75) this.congestion = 'MODERATE';
    else this.congestion = 'CONGESTED';
  }

  _updateZoomLatency() {
    if (!this.shaperEnabled) {
      // Bufferbloat: Zoom is stuck behind everything in rawQueue
      const queuedBefore = this.rawQueue.filter(p => p.source !== 'zoom').length;
      // Rough queuing delay: each packet adds ~20-40ms at 5pkt/s link
      const baseDelay = queuedBefore * (1000 / LINK_CAP_PPS);
      // Add jitter noise
      this.zoomLatencyMs = Math.round(baseDelay + 15 + Math.random() * 20);
      this.zoomLatencyMs = Math.min(this.zoomLatencyMs, 480);
    } else {
      // Priority lane — Zoom always fast
      this.zoomLatencyMs = Math.round(8 + Math.random() * 10);
    }
  }

  // ── Snapshot for UI ─────────────────────────────────────────────────────────

  get dropRate() {
    if (this.totalArrived === 0) return 0;
    return ((this.dropped / this.totalArrived) * 100).toFixed(1);
  }

  get buffered() {
    return this.shaperEnabled ? this.bucket.length : this.rawQueue.length;
  }

  /** Returns last N seconds of rate history as {in[], out[]} arrays. */
  getRateHistory(seconds = 30) {
    const n = Math.min(seconds, HISTORY_LEN);
    const out = { inRate: [], outRate: [] };
    for (let i = n - 1; i >= 0; i--) {
      const idx = (this._histIdx - 1 - i + HISTORY_LEN) % HISTORY_LEN;
      out.inRate.push(+this.inRateHistory[idx].toFixed(2));
      out.outRate.push(+this.outRateHistory[idx].toFixed(2));
    }
    return out;
  }
}

// Export
window.LeakyBucketEngine = LeakyBucketEngine;
window.SOURCES = SOURCES;
