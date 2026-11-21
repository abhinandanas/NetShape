"""
HostelNet QoS — ISP Bandwidth Policing & Traffic Shaping Engine (Leaky Bucket)
DCN (Data Communication & Networking) Mini-Project Backend
FastAPI + Uvicorn + WebSocket Real-Time Telemetry
"""

import asyncio
import time
import uuid
from contextlib import asynccontextmanager
from typing import Dict, List, Optional, Any
from collections import deque
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

@asynccontextmanager
async def lifespan(app: FastAPI):
    worker_task = asyncio.create_task(leaky_bucket_worker())
    yield
    worker_task.cancel()
    try:
        await worker_task
    except asyncio.CancelledError:
        pass

app = FastAPI(title="HostelNet QoS - Leaky Bucket Traffic Shaper", lifespan=lifespan)

# Enable CORS for local testing
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Functional Color Palette mapping
SOURCE_CONFIGS = {
    "zoom": {
        "name": "Placement Zoom Call",
        "color": "#38BDF8",  # Sky Blue
        "default_priority": "High",
    },
    "ipl": {
        "name": "4K IPL Stream",
        "color": "#F59E0B",  # Warm Amber
        "default_priority": "Medium",
    },
    "steam": {
        "name": "50GB Steam Download",
        "color": "#F97316",  # Coral Orange
        "default_priority": "Low",
    },
}

class Packet:
    def __init__(self, source: str, packet_id: Optional[str] = None):
        self.id = packet_id or str(uuid.uuid4())[:8]
        self.source = source if source in SOURCE_CONFIGS else "zoom"
        self.color = SOURCE_CONFIGS[self.source]["color"]
        self.created_at = time.time()
        self.status = "arrived"  # arrived, buffered, transmitted, dropped
        self.drop_reason = None  # buffer_overflow, link_saturation

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "source": self.source,
            "color": self.color,
            "created_at": self.created_at,
            "status": self.status,
            "drop_reason": self.drop_reason,
        }

class LeakyBucketEngine:
    """
    Core Traffic Shaper & Leaky Bucket Engine.
    Simulates:
      1. Leaky Bucket Queuing (Shaper ON):
         - FIFO queue with configurable capacity.
         - Drops packets when queue is full (buffer overflow).
         - Leaks packets out at the exact leak_rate.
      2. Bypass / Raw FIFO Link (Shaper OFF):
         - Packets bypass buffer and hit the raw ISP link directly.
         - Raw link has a hard bottleneck capacity of 5.0 pkt/s.
         - Uncontrolled packet loss when link capacity is exceeded.
    """
    def __init__(self, capacity: int = 15, leak_rate: float = 5.0):
        self.bucket_capacity: int = capacity
        self.leak_rate: float = leak_rate
        self.shaper_enabled: bool = True
        self.raw_link_capacity: float = 5.0  # Fixed raw link bottleneck (pkt/s)

        # Buffers & Queues
        self.buffer: deque[Packet] = deque()

        # Telemetry & Statistics
        self.transmitted_count: int = 0
        self.dropped_count: int = 0
        self.total_arrived: int = 0

        # Rate tracking sliding windows (timestamps of packets in last 1.0s)
        self.incoming_timestamps: deque[float] = deque()
        self.outgoing_timestamps: deque[float] = deque()
        self.dropped_timestamps: deque[float] = deque()

        # Raw link token bucket for Bypass mode (5 tokens max, refills at 5 tokens/s)
        self.bypass_tokens: float = 5.0
        self.bypass_last_refill: float = time.time()

        # Event stream for frontend animation sync
        self.event_sequence: int = 0
        self.recent_events: deque[Dict[str, Any]] = deque(maxlen=200)

        # Background leak tracking
        self.last_leak_time: float = time.time()

    def record_event(self, event_type: str, packet: Packet, details: Optional[Dict[str, Any]] = None):
        self.event_sequence += 1
        event = {
            "seq": self.event_sequence,
            "type": event_type,  # "arrived", "buffered", "transmitted", "dropped"
            "packet": packet.to_dict(),
            "timestamp": time.time(),
        }
        if details:
            event.update(details)
        self.recent_events.append(event)

    def _update_rates(self):
        now = time.time()
        cutoff = now - 1.0
        while self.incoming_timestamps and self.incoming_timestamps[0] < cutoff:
            self.incoming_timestamps.popleft()
        while self.outgoing_timestamps and self.outgoing_timestamps[0] < cutoff:
            self.outgoing_timestamps.popleft()
        while self.dropped_timestamps and self.dropped_timestamps[0] < cutoff:
            self.dropped_timestamps.popleft()

    @property
    def incoming_rate(self) -> float:
        self._update_rates()
        return float(len(self.incoming_timestamps))

    @property
    def outgoing_rate(self) -> float:
        self._update_rates()
        return float(len(self.outgoing_timestamps))

    @property
    def congestion_status(self) -> str:
        self._update_rates()
        if self.shaper_enabled:
            # Buffer fill percentage
            occupancy = len(self.buffer) / max(1, self.bucket_capacity)
            if occupancy < 0.45:
                return "HEALTHY"
            elif occupancy < 0.80:
                return "MODERATE"
            else:
                return "CONGESTED"
        else:
            # In Bypass Mode, link bottlenecks at raw_link_capacity (5 pkts/sec)
            rate = self.incoming_rate
            if rate <= 4.0:
                return "HEALTHY"
            elif rate <= 5.5:
                return "MODERATE"
            else:
                return "CONGESTED"

    async def ingest_packets(self, source: str, count: int = 1) -> List[Dict[str, Any]]:
        results = []
        now = time.time()
        for _ in range(count):
            pkt = Packet(source=source)
            self.total_arrived += 1
            self.incoming_timestamps.append(now)
            self.record_event("arrived", pkt)

            if self.shaper_enabled:
                # Leaky Bucket Mode: Check buffer capacity
                if len(self.buffer) < self.bucket_capacity:
                    pkt.status = "buffered"
                    self.buffer.append(pkt)
                    self.record_event("buffered", pkt, {"buffer_len": len(self.buffer)})
                    results.append({"id": pkt.id, "status": "buffered"})
                else:
                    # Drop packet due to buffer overflow
                    pkt.status = "dropped"
                    pkt.drop_reason = "buffer_overflow"
                    self.dropped_count += 1
                    self.dropped_timestamps.append(now)
                    self.record_event("dropped", pkt, {"reason": "buffer_overflow"})
                    results.append({"id": pkt.id, "status": "dropped", "reason": "buffer_overflow"})
            else:
                # Bypass Mode (Raw Link Pass-Through):
                # Refill bypass tokens based on elapsed time (at 5.0 pkt/s)
                elapsed = now - self.bypass_last_refill
                self.bypass_last_refill = now
                self.bypass_tokens = min(self.raw_link_capacity, self.bypass_tokens + elapsed * self.raw_link_capacity)

                if self.bypass_tokens >= 1.0:
                    # Link has capacity -> Transmit immediately
                    self.bypass_tokens -= 1.0
                    pkt.status = "transmitted"
                    self.transmitted_count += 1
                    self.outgoing_timestamps.append(now)
                    self.record_event("transmitted", pkt, {"mode": "bypass"})
                    results.append({"id": pkt.id, "status": "transmitted"})
                else:
                    # Raw link saturated -> Dropped immediately!
                    pkt.status = "dropped"
                    pkt.drop_reason = "link_saturation"
                    self.dropped_count += 1
                    self.dropped_timestamps.append(now)
                    self.record_event("dropped", pkt, {"reason": "link_saturation"})
                    results.append({"id": pkt.id, "status": "dropped", "reason": "link_saturation"})

        return results

    async def leak_step(self):
        """
        Drains one packet from the leaky bucket buffer at the configured leak_rate.
        """
        if not self.shaper_enabled:
            return

        if self.buffer:
            pkt = self.buffer.popleft()
            now = time.time()
            pkt.status = "transmitted"
            self.transmitted_count += 1
            self.outgoing_timestamps.append(now)
            self.record_event("transmitted", pkt, {"buffer_remaining": len(self.buffer)})

    def get_state(self, since_seq: int = 0) -> Dict[str, Any]:
        self._update_rates()
        events = [e for e in self.recent_events if e["seq"] > since_seq]
        return {
            "metrics": {
                "transmitted_count": self.transmitted_count,
                "buffered_count": len(self.buffer),
                "dropped_count": self.dropped_count,
                "total_arrived": self.total_arrived,
                "incoming_rate": round(self.incoming_rate, 1),
                "outgoing_rate": round(self.outgoing_rate, 1),
                "congestion_status": self.congestion_status,
                "bucket_capacity": self.bucket_capacity,
                "leak_rate": self.leak_rate,
                "shaper_enabled": self.shaper_enabled,
                "raw_link_capacity": self.raw_link_capacity,
            },
            "buffer": [p.to_dict() for p in self.buffer],
            "events": events,
            "latest_seq": self.event_sequence,
            "server_time": time.time(),
        }

    def update_config(self, capacity: Optional[int] = None, leak_rate: Optional[float] = None, shaper_enabled: Optional[bool] = None):
        if capacity is not None:
            self.bucket_capacity = max(5, min(30, int(capacity)))
            # Drop excess packets if capacity reduced below current buffer
            while len(self.buffer) > self.bucket_capacity:
                pkt = self.buffer.pop()
                pkt.status = "dropped"
                pkt.drop_reason = "buffer_overflow"
                self.dropped_count += 1
                self.record_event("dropped", pkt, {"reason": "capacity_reduction"})
        if leak_rate is not None:
            self.leak_rate = max(1.0, min(15.0, float(leak_rate)))
        if shaper_enabled is not None:
            prev_enabled = self.shaper_enabled
            self.shaper_enabled = bool(shaper_enabled)
            # If turning OFF shaper, drain remaining buffer into link (or drop excess)
            if prev_enabled and not self.shaper_enabled:
                while self.buffer:
                    pkt = self.buffer.popleft()
                    pkt.status = "dropped"
                    pkt.drop_reason = "link_saturation"
                    self.dropped_count += 1
                    self.record_event("dropped", pkt, {"reason": "bypass_flush"})

    def reset(self):
        self.buffer.clear()
        self.transmitted_count = 0
        self.dropped_count = 0
        self.total_arrived = 0
        self.incoming_timestamps.clear()
        self.outgoing_timestamps.clear()
        self.dropped_timestamps.clear()
        self.bypass_tokens = 5.0
        self.bypass_last_refill = time.time()
        self.recent_events.clear()
        self.event_sequence = 0


# Global engine instance
engine = LeakyBucketEngine(capacity=15, leak_rate=5.0)

# Request Models
class TrafficRequest(BaseModel):
    source: str
    count: int = 1

class ConfigRequest(BaseModel):
    bucket_capacity: Optional[int] = None
    leak_rate: Optional[float] = None
    shaper_enabled: Optional[bool] = None


# Background Leaker Task
async def leaky_bucket_worker():
    """Continuously leaks packets at the exact configured rate."""
    while True:
        try:
            if engine.shaper_enabled and engine.leak_rate > 0:
                interval = 1.0 / engine.leak_rate
                await asyncio.sleep(interval)
                await engine.leak_step()
            else:
                await asyncio.sleep(0.05)
        except asyncio.CancelledError:
            break
        except Exception as e:
            await asyncio.sleep(0.05)

# API Endpoints
@app.post("/api/traffic")
async def post_traffic(req: TrafficRequest):
    """Inject traffic from campus sources: zoom, ipl, or steam."""
    res = await engine.ingest_packets(req.source, max(1, min(50, req.count)))
    return {"status": "ok", "ingested": len(res), "details": res}

@app.post("/api/config")
async def post_config(req: ConfigRequest):
    """Update bucket capacity, leak rate, or shaper toggle."""
    engine.update_config(req.bucket_capacity, req.leak_rate, req.shaper_enabled)
    return {"status": "ok", "config": {
        "bucket_capacity": engine.bucket_capacity,
        "leak_rate": engine.leak_rate,
        "shaper_enabled": engine.shaper_enabled,
    }}

@app.post("/api/reset")
async def post_reset():
    """Reset counters, telemetry, and buffer."""
    engine.reset()
    return {"status": "ok", "message": "Telemetry & buffer reset successfully"}

@app.get("/api/state")
async def get_state(since_seq: int = 0):
    """Fetch current snapshot of metrics and recent events."""
    return engine.get_state(since_seq=since_seq)

# WebSocket Real-Time Stream
@app.websocket("/ws")
async def websocket_telemetry(websocket: WebSocket):
    await websocket.accept()
    last_seq = 0
    try:
        while True:
            # Push live state at ~20 FPS (every 50ms)
            state = engine.get_state(since_seq=last_seq)
            last_seq = state["latest_seq"]
            await websocket.send_json(state)
            await asyncio.sleep(0.05)
    except WebSocketDisconnect:
        pass
    except Exception:
        pass

# Mount static files (HTML, CSS, JS)
app.mount("/", StaticFiles(directory="static", html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
