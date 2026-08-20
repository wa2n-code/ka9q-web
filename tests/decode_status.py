"""Minimal decoder for ka9q-web's binary WebSocket "Channel Data" packets.

Wire format reverse-engineered directly from html/radio.js's own client-side
decode loop (search that file for the same field IDs before changing this):
  - 12+ byte RTP-style header: word0 (version/pad/ext/cc/type/seq), timestamp,
    ssrc, then cc*4 bytes of CSRCs, then an optional extension block.
  - `type` (bits 16-22 of word0) selects the payload kind. 0x7E is "Channel
    Data": a flat sequence of (type: int8, length: int8, value: length bytes)
    TLV fields, big-endian, running to the end of the packet.

Only the handful of fields the VHF/UHF frequency-offset fix depends on are
decoded here - see the frequency-offset commit on this branch for the full
field list.
"""
import struct
from pathlib import Path

CHANNEL_DATA_TYPE = 0x7E

FIELD_INPUT_SAMPRATE = 10
FIELD_FIRST_LO_FREQUENCY = 34
FIELD_FE_LOW_EDGE = 100
FIELD_FE_HIGH_EDGE = 101
FIELD_FE_ISREAL = 102


def read_frames(path):
    frames = []
    with open(path, "rb") as f:
        while True:
            header = f.read(4)
            if len(header) < 4:
                break
            (length,) = struct.unpack(">I", header)
            frames.append(f.read(length))
    return frames


def _decode_uint(buf):
    v = 0
    for b in buf:
        v = (v * 256) + b
    return v


def decode_channel_data_fields(frame):
    """Returns a dict of field_id -> raw bytes for every TLV field found in
    this frame's Channel Data payload, or None if this frame isn't Channel Data."""
    if len(frame) < 12:
        return None
    word0 = struct.unpack(">I", frame[0:4])[0]
    pkt_type = (word0 >> 16) & 0x7F
    if pkt_type != CHANNEL_DATA_TYPE:
        return None
    cc = (word0 >> 24) & 0x0F
    i = 12 + cc * 4
    fields = {}
    while i + 2 <= len(frame):
        field_type = frame[i]
        length = frame[i + 1]
        i += 2
        if i + length > len(frame):
            break
        fields[field_type] = frame[i : i + length]
        i += length
    return fields


def all_channel_data_fields(path):
    """Merges fields from every Channel Data frame in a fixture (later frames
    win), since a single connection's fields can arrive split across packets."""
    merged = {}
    for frame in read_frames(path):
        fields = decode_channel_data_fields(frame)
        if fields:
            merged.update(fields)
    return merged


def as_float64(raw):
    return struct.unpack(">d", raw.rjust(8, b"\x00"))[0] if len(raw) <= 8 else None


def as_float32(raw):
    return struct.unpack(">f", raw.rjust(4, b"\x00"))[0] if len(raw) <= 4 else None


def as_bool(raw):
    return _decode_uint(raw) != 0
