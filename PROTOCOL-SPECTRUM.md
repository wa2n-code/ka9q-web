# Spectrum Data (0x7F) binary packet

The Spectrum Data packet carries one frame of spectrum bins to the browser.
It shares the RTP-style `12 + cc*4` byte header used by Channel Data (0x7E),
but the payload is not TLV-encoded: it is a fixed 92-byte record followed by
exactly `binCount` bytes of bin data, one byte per bin.

This document was derived from `html/radio.js`'s decode loop and checked
against captured frames from three front ends (a direct-sampling HF receiver,
a complex/IQ VHF tuner and a real-sampling UHF one).

## Fixed record (92 bytes, immediately after the RTP header)

**The first 16 bytes are big-endian; every field after them is
little-endian.** This is not a stylistic guess — `radio.js` reads the first
three fields with `getUint32(i)` and no second argument (defaulting to
big-endian), then passes `true` for every subsequent field. The `ntohl()`
calls around the first three are no-ops (`v >>> 0`).

| Offset | Size | Endian | Field | Notes |
|---|---|---|---|---|
| 0 | 4 | BE | `binCount` | Number of bins that follow. 1620 for every entry in `zoom_table[]` in `ka9q-web.c`. |
| 4 | 4 | BE | `centerHz` | Centre of the displayed span, in **absolute RF Hz**. See below. |
| 8 | 4 | BE | `frequencyHz` | The channel's tuned frequency — the same value and semantics as `BFREQ` in `PROTOCOL-TEXT.md`, delivered over the binary packet as well. |
| 12 | 4 | BE | `binWidthHz` | Hz per bin. `binWidthHz * binCount` is the displayed span width. |
| 16 | 4 | LE | `input_samprate` | The front end's sample rate. |
| 20 | 4 | LE | `rf_agc` | |
| 24 | 8 | LE | `input_samples` | uint64 |
| 32 | 8 | LE | `ad_over` | uint64 |
| 40 | 8 | LE | `samples_since_over` | uint64 |
| 48 | 8 | LE | `gps_time` | uint64 |
| 56 | 4 | LE | `noise_bw` | float32 |
| 60 | 4 | LE | `rf_atten` | float32 |
| 64 | 4 | LE | `rf_gain` | float32 |
| 68 | 4 | LE | `rf_level_cal` | float32 |
| 72 | 4 | LE | `if_power` | float32, dB. Carries the same measurement as Channel Data's `IF_POWER` TLV — verified identical for the same moment on one connection. |
| 76 | 4 | LE | `noise_density_audio` | float32 |
| 80 | 4 | LE | `z_level` | uint32, current index into `zoom_table[]` |
| 84 | 4 | LE | `bins_autorange_offset` | float32, dB. See bin decoding. |
| 88 | 4 | LE | `bins_autorange_gain` | float32, dB per step. See bin decoding. |

## Bin data

Exactly `binCount` bytes follow the fixed record — a 1620-bin frame is
`104 + 1620 = 1724` bytes in total, including the RTP header. Each byte is one
bin, in ascending frequency order, and decodes as:

```
effective_gain = (bins_autorange_gain !== 0) ? bins_autorange_gain : 0.5
dB             = bins_autorange_offset + effective_gain * byteValue
```

A `bins_autorange_gain` of `0` means no autorange data has arrived yet.
`radio.js` substitutes `0.5`, matching radiod's own `init_chan` default.

## `centerHz` is absolute, not baseband-relative

`centerHz` is `sp->center_frequency` in `ka9q-web.c`, and it is in absolute RF
Hz — the same convention as every other frequency field in this protocol. Use
it exactly as received; no `FIRST_LO_FREQUENCY` correction is needed or
wanted. `radio.js` does exactly this (`spectrum.setCenterHz(centerHz)`, with
the value unmodified), and every server-side function that touches
`sp->center_frequency` compares it directly against absolute,
`Frontend.frequency`-derived bounds.

This distinction is invisible on a direct-sampling HF receiver, where
`Frontend.frequency` is ~0 Hz and "absolute" and "centred on a 0 Hz baseband
window" are numerically identical. It matters on a tuner-based front end,
where treating the field as baseband-relative — or adding the first LO
frequency to it — puts the displayed centre out by the full LO frequency.

If a genuinely baseband-relative value is ever needed, derive it explicitly as
`centerHz - Frontend.frequency` rather than assuming the wire field is already
relative. Note that `FIRST_LO_FREQUENCY` is decoded server-side but is not
currently forwarded to the browser, so a client has no way to obtain
`Frontend.frequency` on its own today.
