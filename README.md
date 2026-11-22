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

*Built for DCN Mini-Project AY 2026–27. Sahyadri College of Engineering & Management, Mangaluru.*
