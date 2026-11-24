#!/usr/bin/env python3
"""Capture raw WebSocket frames from a live ka9q-web instance for use as
test fixtures. Read-only: opens exactly the same connection a browser tab
opens (ws://host:port/), never sends anything, and only listens.

Usage: python3 capture_ws.py <label> <ws-url> <seconds>
Writes tests/fixtures/<label>.bin: each frame as a 4-byte big-endian
length prefix followed by the raw frame bytes.
"""
import asyncio
import struct
import sys
from pathlib import Path

import websockets


async def capture(label, url, seconds):
    out_path = Path(__file__).parent / "fixtures" / f"{label}.bin"
    frame_count = 0
    async with websockets.connect(url, max_size=None) as ws:
        try:
            async with asyncio.timeout(seconds):
                with open(out_path, "wb") as f:
                    async for msg in ws:
                        if isinstance(msg, str):
                            continue  # text frames (pings etc.) - not needed for this fixture
                        f.write(struct.pack(">I", len(msg)))
                        f.write(msg)
                        frame_count += 1
        except TimeoutError:
            pass
    print(f"{label}: captured {frame_count} binary frames -> {out_path}")


if __name__ == "__main__":
    label, url, seconds = sys.argv[1], sys.argv[2], float(sys.argv[3])
    asyncio.run(capture(label, url, seconds))
