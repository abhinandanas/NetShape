/**
 * canvas.js — HostelNet QoS 60fps HiDPI Canvas Animator
 * Draws the packet flow animation synchronized with engine.js state.
 * Two distinct visual modes:
 *   OFF → Single horizontal FIFO queue (bufferbloat)
 *   ON  → Priority Zoom lane (top) + Leaky Bucket tank (bottom)
 */

'use strict';

class TrafficCanvas {
  constructor(canvasEl, engine) {
    this.canvas  = canvasEl;
    this.engine  = engine;
    this.ctx     = canvasEl.getContext('2d');
    this.dpr     = Math.max(window.devicePixelRatio || 1, 1);

    // Particle pools for visual-only animation (independent of engine livePackets)
    this._particles = [];   // { x, y, vx, vy, r, color, alpha, type }
    this._drops     = [];   // parabolic drop arcs
    this._txFlashes = [];   // brief green flash on transmission

    this._lastMode  = null; // detect mode change for redraw
    this._frameId   = null;

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const el = this.canvas;
    const rect = el.getBoundingClientRect();
    el.width  = rect.width  * this.dpr;
    el.height = rect.height * this.dpr;
    this.ctx.scale(this.dpr, this.dpr);
    this.W = rect.width;
    this.H = rect.height;
  }

  // ── Main render entry ───────────────────────────────────────────────────────
  render() {
    const { ctx, W, H, engine } = this;
    ctx.clearRect(0, 0, W, H);

    // White canvas background with hairline border already on the element
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, W, H);

    if (engine.shaperEnabled) {
      this._drawShaperOn();
    } else {
      this._drawShaperOff();
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // MODE OFF — Raw FIFO / Bufferbloat
  // ══════════════════════════════════════════════════════════════════════════════
  _drawShaperOff() {
    const { ctx, W, H, engine } = this;

    // ── Layout constants ──
    const queueY   = H * 0.52;        // vertical center of queue pipe
    const pipeH    = 36;              // pipe height
    const pipeX    = W * 0.08;        // queue left edge
    const pipeW    = W * 0.60;        // queue width
    const linkX    = pipeX + pipeW;   // ISP link starts here
    const linkEndX = W * 0.92;
    const pktR     = 10;              // packet capsule radius

    // ── Labels ──
    this._label('INCOMING TRAFFIC', pipeX, queueY - pipeH / 2 - 22, '#52525B', 11, 'left');
    this._label('SHARED FIFO QUEUE  (Raw / Bufferbloat OFF)', pipeX + pipeW * 0.08, queueY - pipeH / 2 - 8, '#B91C1C', 10, 'left');
    this._label('ISP LINK  5 pkt/s', linkX + 8, queueY - pipeH / 2 - 8, '#52525B', 10, 'left');

    // ── Draw queue pipe ──
    ctx.save();
    ctx.strokeStyle = '#E4E4DF';
    ctx.lineWidth   = 1;
    ctx.fillStyle   = '#FAFAF8';
    this._roundRect(pipeX, queueY - pipeH / 2, pipeW, pipeH, 6);
    ctx.fill();
    ctx.stroke();

    // Fill level indicator
    const qLen  = engine.rawQueue.length;
    const fill  = Math.min(qLen / 20, 1);
    const fillW = pipeW * fill;
    ctx.fillStyle = fill > 0.75 ? '#B91C1C22' : fill > 0.4 ? '#B4530922' : '#15803D11';
    this._roundRect(pipeX, queueY - pipeH / 2, fillW, pipeH, 6);
    ctx.fill();
    ctx.restore();

    // ── Draw ISP link arrow ──
    ctx.save();
    ctx.strokeStyle = '#15803D';
    ctx.lineWidth   = 2;
    ctx.beginPath();
    ctx.moveTo(linkX, queueY);
    ctx.lineTo(linkEndX - 8, queueY);
    ctx.stroke();
    this._arrowHead(linkEndX - 8, queueY, '#15803D');
    ctx.restore();

    // ── Draw packets in queue (show up to 15 for perf) ──
    const visible = engine.rawQueue.slice(-15);
    visible.forEach((p, i) => {
      const x = pipeX + pipeW - 24 - i * (pktR * 2 + 4);
      const y = queueY;
      if (x < pipeX + pktR + 4) return; // clip
      this._drawPacketCapsule(x, y, pktR, p.source);
    });

    // ── Spawn lane arrows (source → queue) ──
    this._drawSourceArrows(pipeX, queueY, false);

    // ── Dropped packet bursts ──
    this._spawnDrops(engine);
    this._drawDrops();

    // ── Congestion overlay flash ──
    if (engine.congestion === 'CONGESTED') {
      ctx.save();
      ctx.fillStyle = `rgba(185,28,28,${0.04 + 0.03 * Math.sin(Date.now() / 200)})`;
      ctx.fillRect(pipeX, queueY - pipeH / 2, pipeW, pipeH);
      ctx.restore();
    }

    // ── Queue size label ──
    this._label(`Queue: ${qLen} / 20 pkts`, pipeX + 8, queueY + pipeH / 2 + 16, '#52525B', 10, 'left');
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // MODE ON — Leaky Bucket Shaper
  // ══════════════════════════════════════════════════════════════════════════════
  _drawShaperOn() {
    const { ctx, W, H, engine } = this;

    // ── Layout ──
    const zoomY    = H * 0.28;    // Zoom priority lane Y
    const tankCX   = W * 0.52;   // Leaky bucket tank center X
    const tankY    = H * 0.52;   // tank top Y
    const tankW    = 72;
    const tankH    = H * 0.38;
    const tankX    = tankCX - tankW / 2;
    const pipeH    = 28;

    // ── Zoom Priority Lane ──
    this._drawZoomLane(zoomY, tankX);

    // ── Leaky Bucket Tank ──
    this._drawBucketTank(tankX, tankY, tankW, tankH, engine);

    // ── Incoming bulk arrows → tank ──
    this._drawBulkArrows(tankX, tankY, tankW);

    // ── ISP outflow pipe from tank bottom ──
    const drainX = tankCX;
    const drainY = tankY + tankH;
    const outEndY = H * 0.95;
    ctx.save();
    ctx.strokeStyle = '#15803D';
    ctx.lineWidth   = 2.5;
    ctx.setLineDash([6, 3]);
    ctx.beginPath();
    ctx.moveTo(drainX, drainY + 4);
    ctx.lineTo(drainX, outEndY - 8);
    ctx.stroke();
    ctx.setLineDash([]);
    this._arrowHeadDown(drainX, outEndY - 8, '#15803D');
    ctx.restore();
    this._label(`Leak Rate: ${engine.leakRate.toFixed(1)} pkt/s`, drainX + 10, (drainY + outEndY) / 2, '#15803D', 10, 'left');
    this._label('→ ISP / Router', drainX + 10, (drainY + outEndY) / 2 + 14, '#52525B', 10, 'left');

    // ── Drop arcs ──
    this._spawnDrops(engine);
    this._drawDrops();
  }

  _drawZoomLane(laneY, tankX) {
    const { ctx, W } = this;
    const laneX   = W * 0.06;
    const laneW   = tankX - laneX - 20;
    const pipeH   = 28;

    // Lane pipe
    ctx.save();
    ctx.strokeStyle = '#1D4ED820';
    ctx.lineWidth   = 1;
    ctx.fillStyle   = '#EFF6FF';
    this._roundRect(laneX, laneY - pipeH / 2, laneW, pipeH, 6);
    ctx.fill();
    ctx.stroke();

    // Arrow
    ctx.strokeStyle = '#1D4ED8';
    ctx.lineWidth   = 2;
    ctx.beginPath();
    ctx.moveTo(laneX + laneW, laneY);
    ctx.lineTo(W * 0.90 - 8, laneY);
    ctx.stroke();
    this._arrowHead(W * 0.90 - 8, laneY, '#1D4ED8');
    ctx.restore();

    // Labels
    this._label('ZOOM PRIORITY LANE  (Express — no queuing)', laneX + 8, laneY - pipeH / 2 - 8, '#1D4ED8', 10, 'left');
    this._label('→ Direct to ISP  < 20 ms', W * 0.70, laneY - pipeH / 2 - 8, '#15803D', 10, 'left');

    // Animated Zoom packet travelling across lane
    const t   = (Date.now() % 1800) / 1800;
    const px  = laneX + t * (laneW + 60);
    if (px < laneX + laneW + 20) {
      this._drawPacketCapsule(px, laneY, 9, 'zoom');
    }
  }

  _drawBucketTank(tx, ty, tw, th, engine) {
    const { ctx } = this;
    const fill = Math.min(engine.bucket.length / engine.bucketCapacity, 1);

    // Tank outline
    ctx.save();
    ctx.strokeStyle = '#E4E4DF';
    ctx.lineWidth   = 1.5;
    ctx.fillStyle   = '#FAFAF8';
    this._roundRect(tx, ty, tw, th, 8);
    ctx.fill();
    ctx.stroke();

    // Water fill
    const fillH = th * fill;
    const fillColor = fill > 0.8 ? '#B91C1C' : fill > 0.5 ? '#B45309' : '#15803D';
    ctx.fillStyle = fillColor + '30';
    ctx.beginPath();
    ctx.rect(tx + 1, ty + th - fillH, tw - 2, fillH);
    ctx.clip();
    ctx.fillRect(tx + 1, ty + th - fillH, tw - 2, fillH);
    ctx.restore();

    // Bucket border re-draw over fill
    ctx.save();
    ctx.strokeStyle = '#E4E4DF';
    ctx.lineWidth   = 1.5;
    this._roundRect(tx, ty, tw, th, 8);
    ctx.stroke();
    ctx.restore();

    // Drip hole at bottom
    ctx.save();
    ctx.fillStyle = '#15803D';
    ctx.beginPath();
    ctx.arc(tx + tw / 2, ty + th, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Animated drip droplet
    const dropT = (Date.now() % 600) / 600;
    if (engine.bucket.length > 0) {
      const dy = ty + th + 10 + dropT * 24;
      ctx.save();
      ctx.fillStyle = '#15803D';
      ctx.beginPath();
      ctx.ellipse(tx + tw / 2, dy, 4, 6, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Tank labels
    this._label('LEAKY BUCKET', tx + tw / 2, ty - 20, '#18181B', 11, 'center');
    this._label(`${engine.bucket.length} / ${engine.bucketCapacity}`, tx + tw / 2, ty - 8, '#52525B', 10, 'center');

    // Packet dots inside tank (up to 10)
    const visible = engine.bucket.slice(-10);
    visible.forEach((p, i) => {
      const row = Math.floor(i / 3);
      const col = i % 3;
      const px = tx + 14 + col * 22;
      const py = ty + th - 20 - row * 22;
      this._drawPacketCapsule(px, py, 7, p.source);
    });
  }

  _drawBulkArrows(tankX, tankY, tankW) {
    const { ctx, W } = this;
    const mx = tankX + tankW / 2;
    // IPL arrow (from left)
    ctx.save();
    ctx.strokeStyle = '#B45309';
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.moveTo(W * 0.06, tankY + tankW * 0.3);
    ctx.quadraticCurveTo(W * 0.25, tankY - 20, mx - 4, tankY + 2);
    ctx.stroke();
    this._arrowHeadDown(mx - 4, tankY + 2, '#B45309');
    ctx.restore();
    this._label('4K IPL', W * 0.06, tankY + tankW * 0.3 - 10, '#B45309', 10, 'left');

    // Steam arrow (from right)
    ctx.save();
    ctx.strokeStyle = '#C2410C';
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.moveTo(W * 0.88, tankY + tankW * 0.5);
    ctx.quadraticCurveTo(W * 0.72, tankY - 20, mx + 4, tankY + 2);
    ctx.stroke();
    this._arrowHeadDown(mx + 4, tankY + 2, '#C2410C');
    ctx.restore();
    this._label('Steam', W * 0.80, tankY + tankW * 0.5 - 10, '#C2410C', 10, 'left');
  }

  _drawSourceArrows(queueX, queueY, shaperOn) {
    const { ctx, W } = this;
    const sources = [
      { label: 'Zoom', color: '#1D4ED8', fromY: queueY - 60 },
      { label: 'IPL',  color: '#B45309', fromY: queueY },
      { label: 'Steam',color: '#C2410C', fromY: queueY + 55 },
    ];
    sources.forEach(s => {
      ctx.save();
      ctx.strokeStyle = s.color;
      ctx.lineWidth   = 1.5;
      ctx.beginPath();
      ctx.moveTo(W * 0.03, s.fromY);
      ctx.lineTo(queueX - 4, queueY);
      ctx.stroke();
      this._arrowHead(queueX - 4, queueY, s.color);
      this._label(s.label, W * 0.01, s.fromY - 6, s.color, 9, 'left');
      ctx.restore();
    });
  }

  // ── Drop particles ──────────────────────────────────────────────────────────
  _spawnDrops(engine) {
    // Spawn red drop particle when drops increase
    if (!this._lastDropCount) this._lastDropCount = 0;
    if (engine.dropped > this._lastDropCount) {
      const diff = engine.dropped - this._lastDropCount;
      for (let i = 0; i < Math.min(diff, 3); i++) {
        this._drops.push({
          x:     engine.shaperEnabled ? (this.W * 0.52) : (this.W * 0.68),
          y:     engine.shaperEnabled ? (this.H * 0.52) : (this.H * 0.52),
          vx:    (Math.random() - 0.5) * 3,
          vy:    -2 - Math.random() * 2,
          r:     7,
          alpha: 1,
          color: '#B91C1C',
        });
      }
      this._lastDropCount = engine.dropped;
    }
  }

  _drawDrops() {
    const { ctx } = this;
    this._drops = this._drops.filter(d => d.alpha > 0.02);
    this._drops.forEach(d => {
      d.x  += d.vx;
      d.y  += d.vy;
      d.vy += 0.18;        // gravity
      d.alpha -= 0.025;
      ctx.save();
      ctx.globalAlpha = d.alpha;
      ctx.fillStyle   = d.color;
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.fill();
      // 'X' label
      ctx.fillStyle   = '#fff';
      ctx.font        = `bold 9px Inter, sans-serif`;
      ctx.textAlign   = 'center';
      ctx.textBaseline= 'middle';
      ctx.fillText('✕', d.x, d.y);
      ctx.restore();
    });
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  _drawPacketCapsule(x, y, r, source) {
    const { ctx } = this;
    const colors = {
      zoom:  '#1D4ED8',
      ipl:   '#B45309',
      steam: '#C2410C',
    };
    const labels = { zoom: 'Z', ipl: 'I', steam: 'S' };
    const col = colors[source] || '#52525B';

    ctx.save();
    ctx.fillStyle   = col;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * 0.7, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle   = '#fff';
    ctx.font        = `bold ${Math.max(8, r - 2)}px Inter, sans-serif`;
    ctx.textAlign   = 'center';
    ctx.textBaseline= 'middle';
    ctx.fillText(labels[source] || '?', x, y);
    ctx.restore();
  }

  _label(text, x, y, color, size, align) {
    const { ctx } = this;
    ctx.save();
    ctx.fillStyle    = color;
    ctx.font         = `${size}px Inter, sans-serif`;
    ctx.textAlign    = align;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  _arrowHead(x, y, color) {
    const { ctx } = this;
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x + 7, y);
    ctx.lineTo(x - 1, y - 4);
    ctx.lineTo(x - 1, y + 4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  _arrowHeadDown(x, y, color) {
    const { ctx } = this;
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, y + 7);
    ctx.lineTo(x - 4, y - 1);
    ctx.lineTo(x + 4, y - 1);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  _roundRect(x, y, w, h, r) {
    const { ctx } = this;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }
}

window.TrafficCanvas = TrafficCanvas;
