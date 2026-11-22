# HostelNet QoS — Leaky Bucket Traffic Shaping Simulator

**DCN Mini-Project | Information Science & Engineering | Sahyadri College**

A 100% client-side HTML5 + Vanilla JS + Chart.js web application that visually demonstrates how the **Leaky Bucket algorithm** solves **Wi-Fi Bufferbloat** in a college hostel environment — protecting a Placement Zoom Call from a 4K IPL Stream and a 50GB Steam Game Download.

---

## How to Run

No build step, no installation required.

```
# Option 1 — Open directly
Double-click index.html in File Explorer

# Option 2 — Serve with Python (avoids CORS quirks on some browsers)
cd NET
python -m http.server 5500
# Open http://localhost:5500 in your browser
```

---

## Project Structure

```
NET/
├── index.html   — 3-band semantic layout (Header / Stage / Telemetry)
├── style.css    — Swiss Editorial Light Theme (Inter + JetBrains Mono)
├── engine.js    — Pure JS simulation: LeakyBucketEngine class
├── canvas.js    — HiDPI 60fps HTML5 Canvas animator: TrafficCanvas class
├── app.js       — UI controller: wires DOM ↔ engine + Chart.js loop
└── README.md    — This file
```

---

## Leaky Bucket — The Core Idea

| Concept | Analogy |
|---|---|
| **Bucket** | FIFO buffer that holds incoming traffic bursts |
| **Bucket capacity** | How many packets the buffer can hold |
| **Leak rate** | Fixed rate at which packets drip out to the ISP link |
| **Overflow** | Packets that arrive when bucket is full — they are dropped |
| **Conforming output** | The smooth, constant-rate stream that exits the bucket |

**Without Leaky Bucket (Bufferbloat):** All traffic shares one FIFO queue at the ISP link. When Steam/IPL bursts arrive, the queue fills. Zoom packets are stuck behind huge download packets. Latency spikes to 180–480 ms. Voice breaks up.

**With Leaky Bucket ON:** Zoom gets a priority express lane (bypasses the bucket entirely). Bulk traffic (IPL + Steam) enters the bucket. If it fills, excess is dropped rather than queued. The drip valve emits at exactly `Leak Rate` pkt/s — smooth, predictable, CBR-like. Zoom latency stays below 20 ms.

---

## Demo Presets

| Preset | What it shows |
|---|---|
| **1 · Zoom Only** | Single low-rate stream, shaper ON. Smooth, low latency. |
| **2 · Trigger Bufferbloat** | All 3 sources ON, shaper OFF. Queue fills, Zoom badge turns red, latency spikes. |
| **3 · Activate Leaky Bucket** | All 3 sources ON, shaper ON. Zoom protected, Steam/IPL rate-limited, bucket fills then drips. |

---

## Controls Reference

| Control | Description |
|---|---|
| Source toggles | Enable continuous packet generation from each source |
| ⚡ Burst | Fire a one-shot packet burst (Zoom: 3, IPL: 5, Steam: 12 packets) |
| Leaky Bucket Shaper | Master ON/OFF toggle |
| Bucket Capacity | Max packets the leaky bucket can buffer (5–30) |
| Leak Rate | Packets/sec dripping from bucket to ISP link (1–15) |
| ↺ Reset | Clear all counters, queues, and graph history |

---

## 3-Minute Viva Script

**Q: What problem does this project solve?**
A: College hostel Wi-Fi bufferbloat — a single heavy Steam download or IPL stream can fill the router's queue, causing Zoom call latency to spike from 15 ms to over 300 ms, breaking voice and video.

**Q: How does the Leaky Bucket algorithm fix this?**
A: It places a fixed-size FIFO buffer (the "bucket") between incoming traffic and the ISP link. Packets enter the bucket at any rate but leave at a fixed, controlled leak rate. If the bucket overflows, excess packets are dropped early at the edge rather than congesting the shared router queue.

**Q: What is the difference between Leaky Bucket and Token Bucket?**
A: Leaky Bucket enforces a strictly constant output rate (CBR). Token Bucket allows short bursts up to a token accumulation limit — output rate can momentarily exceed the average. Leaky Bucket is better for real-time traffic shaping where jitter must be minimised.

**Q: How does this simulation differ from a real router implementation?**
A: A real router runs the leaky bucket in hardware using a timer interrupt and a circular packet buffer in memory. This simulation uses a JavaScript `requestAnimationFrame` loop (60fps, ~16ms tick) with a fractional accumulator for sub-tick precision. The core algorithm is identical.

**Q: What metrics prove Leaky Bucket works?**
A: Drop Rate drops from ~58% (Bypass mode) to 0% (Leaky Bucket, Capacity 15, Leak Rate 5). Zoom latency drops from 180–480 ms to 8–18 ms. Outgoing rate becomes flat (CBR) instead of bursty.

---

## Color Legend

| Color | Meaning |
|---|---|
| Deep Royal Blue `#1D4ED8` | Zoom Call packets |
| Matte Amber `#B45309` | 4K IPL Stream packets |
| Terracotta `#C2410C` | 50GB Steam Download packets |
| Forest Green `#15803D` | Healthy / transmitted output |
| Deep Crimson `#B91C1C` | Dropped / bufferbloat / congestion |

---

*Built for DCN Mini-Project AY 2025–26. Sahyadri College of Engineering & Management, Mangaluru.*
