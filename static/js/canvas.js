class TrafficCanvas {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    this.ctx = this.canvas.getContext('2d');
    this.dpr = window.devicePixelRatio || 1;

    // Dimensions
    this.width = 0;
    this.height = 0;

    // Engine state
    this.shaperEnabled = true;
    this.bucketCapacity = 15;
    this.leakRate = 5.0;
    this.bufferedCount = 0;
    this.rawLinkCapacity = 5.0;

    // Active animation collections
    this.flyingPackets = [];   // Inbound packets travelling from host to bucket
    this.bufferedPackets = []; // Packets currently residing in the bucket
    this.outgoingPackets = []; // Packets exiting through the bottom ISP valve
    this.droppedParticles = []; // Deflecting/falling dropped packet particles

    // Color definitions
    this.colors = {
      zoom: '#38BDF8',    // Sky Blue
      ipl: '#F59E0B',     // Warm Amber
      steam: '#F97316',   // Coral Orange
      healthy: '#10B981', // Emerald Green
      drop: '#EF4444',    // Crimson Red
      pipeBg: '#181B22',
      pipeBorder: '#2A2F3A',
      bucketBg: '#11141A',
      bucketBorder: '#3A4252',
    };

    // Setup canvas size & resize listener
    this.resize();
    window.addEventListener('resize', () => this.resize());

    // Start 60fps render loop
    this.lastTime = performance.now();
    this.animate = this.animate.bind(this);
    requestAnimationFrame(this.animate);
  }

  resize() {
    const parent = this.canvas.parentElement;
    const rect = parent.getBoundingClientRect();
    this.width = rect.width;
    this.height = Math.max(380, rect.height);

    this.canvas.width = this.width * this.dpr;
    this.canvas.height = this.height * this.dpr;
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;

    this.ctx.scale(this.dpr, this.dpr);
    this.calculateLayout();
  }

  calculateLayout() {
    const w = this.width;
    const h = this.height;

    // Host nodes positions (Left side)
    const hostX = 60;
    this.hosts = {
      zoom: { x: hostX, y: h * 0.22, label: 'Zoom Call', color: this.colors.zoom },
      ipl: { x: hostX, y: h * 0.50, label: '4K IPL', color: this.colors.ipl },
      steam: { x: hostX, y: h * 0.78, label: 'Steam 50GB', color: this.colors.steam },
    };

    // Leaky Bucket Tank Coordinates (Center)
    this.bucket = {
      x: w * 0.44,
      y: h * 0.16,
      width: Math.min(130, w * 0.18),
      height: h * 0.62,
    };

    // Convergence input funnel right before bucket
    this.funnel = {
      x: this.bucket.x - 45,
      y: this.bucket.y + 20,
    };

    // Outgoing ISP Pipe (Right side)
    this.ispExit = {
      x: this.bucket.x + this.bucket.width,
      y: this.bucket.y + this.bucket.height - 24,
      targetX: Math.max(this.bucket.x + this.bucket.width + 100, w - 85),
    };

    // Bypass Pipe Coordinates (used when Shaper is OFF)
    this.bypassPipe = {
      startX: this.funnel.x,
      startY: h * 0.50,
      endX: this.ispExit.targetX,
      endY: h * 0.50,
    };
  }

  updateState(state) {
    if (!state || !state.metrics) return;
    const m = state.metrics;
    this.shaperEnabled = m.shaper_enabled;
    this.bucketCapacity = m.bucket_capacity;
    this.leakRate = m.leak_rate;
    this.bufferedCount = m.buffered_count;
    this.rawLinkCapacity = m.raw_link_capacity || 5.0;

    // Sync buffered packets with server buffer if provided
    if (Array.isArray(state.buffer)) {
      this.syncBuffer(state.buffer);
    }
  }

  syncBuffer(serverBuffer) {
    // Keep local representation in sync with server FIFO
    const currentIds = new Set(this.bufferedPackets.map(p => p.id));
    serverBuffer.forEach((pkt) => {
      if (!currentIds.has(pkt.id)) {
        this.bufferedPackets.push({
          id: pkt.id,
          source: pkt.source,
          color: this.colors[pkt.source] || this.colors.zoom,
          settleY: 0,
        });
      }
    });

    // Remove any that are no longer in server buffer
    const serverIds = new Set(serverBuffer.map(p => p.id));
    this.bufferedPackets = this.bufferedPackets.filter(p => serverIds.has(p.id));
  }

  // Handle incoming event from WebSocket
  handleEvent(event) {
    if (!event || !event.packet) return;
    const pkt = event.packet;

    if (event.type === 'arrived') {
      // Spawn incoming flying packet from host to bucket/funnel
      const host = this.hosts[pkt.source] || this.hosts.zoom;
      this.flyingPackets.push({
        id: pkt.id,
        source: pkt.source,
        color: this.colors[pkt.source] || '#38BDF8',
        startX: host.x + 40,
        startY: host.y,
        progress: 0,
        speed: 0.022 + Math.random() * 0.008,
      });
    } else if (event.type === 'dropped') {
      // Spawn red deflected drop physics particle
      const isBypass = event.reason === 'link_saturation';
      let spawnX = this.bucket.x + this.bucket.width * 0.5;
      let spawnY = this.bucket.y;

      if (isBypass) {
        spawnX = this.bucket.x + 30;
        spawnY = this.height * 0.50;
      }

      this.droppedParticles.push({
        x: spawnX,
        y: spawnY,
        vx: (Math.random() - 0.5) * 5 + 3,
        vy: -4 - Math.random() * 3,
        gravity: 0.25,
        alpha: 1.0,
        rotation: 0,
        vRot: (Math.random() - 0.5) * 0.2,
        color: this.colors.drop,
        sourceColor: this.colors[pkt.source] || '#EF4444',
        label: isBypass ? 'SATURATED DROP' : 'BUFFER OVERFLOW',
      });
    } else if (event.type === 'transmitted') {
      // Spawn exiting packet moving smoothly to ISP
      this.outgoingPackets.push({
        id: pkt.id,
        source: pkt.source,
        color: this.colors.healthy,
        x: this.ispExit.x + 10,
        y: this.ispExit.y,
        speed: 2.8,
      });
    }
  }

  animate(currentTime) {
    const dt = Math.min(0.1, (currentTime - this.lastTime) / 1000);
    this.lastTime = currentTime;

    // Clear frame
    this.ctx.clearRect(0, 0, this.width, this.height);

    // 1. Draw static grid / conduits / pipework
    this.drawNetworkPipes();

    // 2. Draw Host Devices
    this.drawHostNodes();

    // 3. Draw Leaky Bucket Tank or Bypass Mode
    if (this.shaperEnabled) {
      this.drawLeakyBucketTank();
    } else {
      this.drawBypassConduit();
    }

    // 4. Update & Draw Inbound Flying Packets
    this.updateAndDrawInboundPackets();

    // 5. Update & Draw Outgoing Shaped Packets
    this.updateAndDrawOutgoingPackets();

    // 6. Update & Draw Dropped Overflow Particles
    this.updateAndDrawDroppedParticles();

    // 7. Draw ISP Destination Gateway
    this.drawISPGateway();

    requestAnimationFrame(this.animate);
  }

  drawNetworkPipes() {
    const ctx = this.ctx;
    ctx.lineWidth = 14;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#181B22';

    // Pipes from 3 hosts to funnel
    Object.keys(this.hosts).forEach(key => {
      const h = this.hosts[key];
      ctx.beginPath();
      ctx.moveTo(h.x + 35, h.y);
      ctx.bezierCurveTo(
        h.x + 100, h.y,
        this.funnel.x - 40, this.funnel.y,
        this.funnel.x, this.funnel.y
      );
      ctx.stroke();

      // Outer border trace
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#2A2F3A';
      ctx.stroke();
      ctx.lineWidth = 14;
      ctx.strokeStyle = '#181B22';
    });

    // Funnel to Bucket Entry pipe
    if (this.shaperEnabled) {
      ctx.beginPath();
      ctx.moveTo(this.funnel.x, this.funnel.y);
      ctx.lineTo(this.bucket.x + this.bucket.width * 0.5, this.funnel.y);
      ctx.lineTo(this.bucket.x + this.bucket.width * 0.5, this.bucket.y);
      ctx.stroke();

      // Outgoing pipe from bottom valve to ISP
      ctx.beginPath();
      ctx.moveTo(this.ispExit.x, this.ispExit.y);
      ctx.lineTo(this.ispExit.targetX, this.ispExit.y);
      ctx.stroke();
    }
  }

  drawHostNodes() {
    const ctx = this.ctx;

    Object.keys(this.hosts).forEach(key => {
      const h = this.hosts[key];
      
      // Node Card Background
      ctx.fillStyle = '#181B22';
      ctx.strokeStyle = h.color;
      ctx.lineWidth = 1.5;
      
      const cardW = 90;
      const cardH = 34;
      const cardX = h.x - 45;
      const cardY = h.y - 17;

      ctx.beginPath();
      ctx.roundRect(cardX, cardY, cardW, cardH, 4);
      ctx.fill();
      ctx.stroke();

      // Small color pill dot
      ctx.fillStyle = h.color;
      ctx.beginPath();
      ctx.arc(cardX + 12, h.y, 4, 0, Math.PI * 2);
      ctx.fill();

      // Label text
      ctx.fillStyle = '#FFFFFF';
      ctx.font = '600 11px Inter, sans-serif';
      ctx.fillText(h.label, cardX + 22, h.y + 4);
    });
  }

  drawLeakyBucketTank() {
    const ctx = this.ctx;
    const b = this.bucket;

    // Bucket Tank Background
    ctx.fillStyle = this.colors.bucketBg;
    ctx.strokeStyle = this.colors.bucketBorder;
    ctx.lineWidth = 2;

    ctx.beginPath();
    ctx.roundRect(b.x, b.y, b.width, b.height, [0, 0, 10, 10]);
    ctx.fill();
    ctx.stroke();

    // Top open lip
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(b.x - 6, b.y);
    ctx.lineTo(b.x + b.width + 6, b.y);
    ctx.stroke();

    // Calibration graduation lines (Capacity markers)
    ctx.strokeStyle = '#2A2F3A';
    ctx.fillStyle = '#64748B';
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.lineWidth = 1;

    const steps = 5;
    for (let i = 1; i <= steps; i++) {
      const frac = i / steps;
      const markY = b.y + b.height - (frac * b.height * 0.88);
      const markVal = Math.round(frac * this.bucketCapacity);

      ctx.beginPath();
      ctx.moveTo(b.x + 2, markY);
      ctx.lineTo(b.x + 14, markY);
      ctx.stroke();

      ctx.fillText(`${markVal}`, b.x + 18, markY + 3);
    }

    // Render fluid/queued packets inside the tank
    const maxCapacity = Math.max(1, this.bucketCapacity);
    const count = this.bufferedPackets.length;
    const fillFrac = Math.min(1.0, count / maxCapacity);
    const fillHeight = fillFrac * (b.height - 24);

    if (count > 0) {
      // Fluid base fill
      const fluidY = b.y + b.height - fillHeight;
      const gradient = ctx.createLinearGradient(0, fluidY, 0, b.y + b.height);
      gradient.addColorStop(0, 'rgba(56, 189, 248, 0.22)');
      gradient.addColorStop(1, 'rgba(16, 185, 129, 0.35)');
      
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.roundRect(b.x + 2, fluidY, b.width - 4, fillHeight, [4, 4, 8, 8]);
      ctx.fill();
    }

    // Render queued packet pills stacked neatly
    const pillW = b.width - 24;
    const pillH = Math.min(16, (b.height - 30) / Math.max(10, this.bucketCapacity));
    const startPillY = b.y + b.height - 14;

    this.bufferedPackets.slice(0, 18).forEach((pkt, idx) => {
      const py = startPillY - (idx + 1) * (pillH + 2);
      ctx.fillStyle = pkt.color;
      ctx.strokeStyle = '#0F1115';
      ctx.lineWidth = 1;

      ctx.beginPath();
      ctx.roundRect(b.x + 12, py, pillW, pillH, 3);
      ctx.fill();
      ctx.stroke();

      // Mini text
      ctx.fillStyle = '#0F1115';
      ctx.font = '700 8px "JetBrains Mono"';
      ctx.fillText(pkt.source.toUpperCase(), b.x + 16, py + pillH - 3);
    });

    // Overflow warning barrier on top
    if (count >= this.bucketCapacity) {
      ctx.fillStyle = '#EF4444';
      ctx.font = '700 10px "JetBrains Mono"';
      ctx.fillText('! BUFFER FULL !', b.x + b.width * 0.15, b.y - 6);
    }

    // Bottom Drain Nozzle & Valve
    const nozzleW = 20;
    const nozzleH = 16;
    const nozzleX = b.x + (b.width - nozzleW) * 0.5;
    const nozzleY = b.y + b.height;

    ctx.fillStyle = '#334155';
    ctx.fillRect(nozzleX, nozzleY, nozzleW, nozzleH);

    // Valve Rate Label
    ctx.fillStyle = '#10B981';
    ctx.font = '600 10px "JetBrains Mono"';
    ctx.fillText(`${this.leakRate.toFixed(1)} pkt/s`, b.x + b.width + 8, b.y + b.height - 4);
    ctx.fillStyle = '#94A3B8';
    ctx.font = '9px Inter, sans-serif';
    ctx.fillText('LEAK VALVE', b.x + b.width + 8, b.y + b.height + 8);
  }

  drawBypassConduit() {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;

    // Draw prominent warning line indicating BYPASS / RAW LINK mode
    const startX = this.funnel.x;
    const startY = h * 0.50;
    const endX = this.ispExit.targetX;

    // Dimmed bypassed bucket container in the background
    ctx.save();
    ctx.globalAlpha = 0.2;
    ctx.strokeStyle = '#EF4444';
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(this.bucket.x, this.bucket.y, this.bucket.width, this.bucket.height);
    ctx.restore();

    // Bypass Pipe
    ctx.lineWidth = 18;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#7F1D1D';
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(endX, startY);
    ctx.stroke();

    // Inner pipe line
    ctx.lineWidth = 14;
    ctx.strokeStyle = '#181B22';
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(endX, startY);
    ctx.stroke();

    // Raw Bottleneck Barrier
    const barrierX = this.bucket.x + this.bucket.width * 0.5;
    ctx.fillStyle = '#DC2626';
    ctx.fillRect(barrierX - 4, startY - 26, 8, 52);

    // Warning Badge
    ctx.fillStyle = '#EF4444';
    ctx.font = '700 11px "JetBrains Mono"';
    ctx.fillText('RAW LINK BOTTLENECK (5.0 PKT/S)', barrierX - 95, startY - 34);
    ctx.fillStyle = '#F87171';
    ctx.font = '9px Inter, sans-serif';
    ctx.fillText('NO BUFFERING — BURSTS SUFFER UNCONTROLLED PACKET LOSS', barrierX - 120, startY + 42);
  }

  updateAndDrawInboundPackets() {
    const ctx = this.ctx;
    const targetX = this.shaperEnabled ? (this.bucket.x + this.bucket.width * 0.5) : (this.bucket.x + 20);
    const targetY = this.shaperEnabled ? this.bucket.y : (this.height * 0.50);

    for (let i = this.flyingPackets.length - 1; i >= 0; i--) {
      const pkt = this.flyingPackets[i];
      pkt.progress += pkt.speed;

      // Calculate path (Bezier from host to funnel to target)
      let curX, curY;
      if (pkt.progress < 0.7) {
        const t = pkt.progress / 0.7;
        curX = pkt.startX + (this.funnel.x - pkt.startX) * t;
        curY = pkt.startY + (this.funnel.y - pkt.startY) * (t * t);
      } else {
        const t = (pkt.progress - 0.7) / 0.3;
        curX = this.funnel.x + (targetX - this.funnel.x) * t;
        curY = this.funnel.y + (targetY - this.funnel.y) * t;
      }

      // Draw packet capsule
      ctx.fillStyle = pkt.color;
      ctx.strokeStyle = '#0F1115';
      ctx.lineWidth = 1.5;
      
      ctx.beginPath();
      ctx.roundRect(curX - 10, curY - 6, 20, 12, 6);
      ctx.fill();
      ctx.stroke();

      // Mini identifier
      ctx.fillStyle = '#0F1115';
      ctx.font = '700 7px "JetBrains Mono"';
      ctx.fillText(pkt.source[0].toUpperCase(), curX - 3, curY + 2.5);

      if (pkt.progress >= 1.0) {
        this.flyingPackets.splice(i, 1);
      }
    }
  }

  updateAndDrawOutgoingPackets() {
    const ctx = this.ctx;
    const targetX = this.ispExit.targetX;

    for (let i = this.outgoingPackets.length - 1; i >= 0; i--) {
      const pkt = this.outgoingPackets[i];
      pkt.x += pkt.speed;

      // In Bypass mode, y is at center pipe; in Shaper mode, y is at bottom valve
      const py = this.shaperEnabled ? this.ispExit.y : (this.height * 0.50);

      // Draw shaped emerald packet
      ctx.fillStyle = this.colors.healthy;
      ctx.strokeStyle = '#064E3B';
      ctx.lineWidth = 1.5;

      ctx.beginPath();
      ctx.roundRect(pkt.x - 12, py - 6, 24, 12, 6);
      ctx.fill();
      ctx.stroke();

      // Small checkmark or tick
      ctx.fillStyle = '#064E3B';
      ctx.font = '700 8px "JetBrains Mono"';
      ctx.fillText('QoS', pkt.x - 7, py + 3);

      if (pkt.x >= targetX) {
        this.outgoingPackets.splice(i, 1);
      }
    }
  }

  updateAndDrawDroppedParticles() {
    const ctx = this.ctx;

    for (let i = this.droppedParticles.length - 1; i >= 0; i--) {
      const p = this.droppedParticles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vy += p.gravity;
      p.rotation += p.vRot;
      p.alpha -= 0.016;

      if (p.alpha <= 0 || p.y > this.height) {
        this.droppedParticles.splice(i, 1);
        continue;
      }

      ctx.save();
      ctx.globalAlpha = Math.max(0, p.alpha);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation);

      // Dropped red packet pill
      ctx.fillStyle = this.colors.drop;
      ctx.strokeStyle = '#7F1D1D';
      ctx.lineWidth = 1.5;

      ctx.beginPath();
      ctx.roundRect(-10, -6, 20, 12, 4);
      ctx.fill();
      ctx.stroke();

      // Cross symbol
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(-3, -3);
      ctx.lineTo(3, 3);
      ctx.moveTo(3, -3);
      ctx.lineTo(-3, 3);
      ctx.stroke();

      // Dropped label
      ctx.fillStyle = '#EF4444';
      ctx.font = '700 8px "JetBrains Mono"';
      ctx.fillText('DROP', -12, -10);

      ctx.restore();
    }
  }

  drawISPGateway() {
    const ctx = this.ctx;
    const gx = this.ispExit.targetX;
    const gy = this.shaperEnabled ? this.ispExit.y : (this.height * 0.50);

    // Gateway Card
    ctx.fillStyle = '#181B22';
    ctx.strokeStyle = '#10B981';
    ctx.lineWidth = 1.5;

    ctx.beginPath();
    ctx.roundRect(gx - 5, gy - 24, 75, 48, 4);
    ctx.fill();
    ctx.stroke();

    // Antenna icon / status
    ctx.fillStyle = '#10B981';
    ctx.beginPath();
    ctx.arc(gx + 10, gy - 6, 4, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#FFFFFF';
    ctx.font = '700 10px Inter, sans-serif';
    ctx.fillText('ISP LINK', gx + 20, gy - 3);

    ctx.fillStyle = '#94A3B8';
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.fillText('Campus GW', gx + 10, gy + 14);
  }
}
