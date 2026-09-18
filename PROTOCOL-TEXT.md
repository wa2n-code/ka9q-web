# Text WebSocket protocol

The binary RTP+TLV Channel Data (0x7E) and Spectrum Data (0x7F) stream carries
front end telemetry — coverage, signal power, sample rates. It does not carry
the tuned frequency or the mode. Those travel over a second, informal
text protocol layered on the same WebSocket connection.

This document was derived from `html/radio.js` and checked against live
traffic from three running instances.

## Inbound (server to client)

Colon-delimited text frames:

| Prefix | Example | Meaning |
|---|---|---|
| `S:<ssrc>` | `S:1234567890` | Assigns this connection's SSRC. |
| `BFREQ:<val>` | `BFREQ:10000000.000` | Current backend (tuned) frequency. **The unit is ambiguous by magnitude**: `radio.js` treats a value above 1000000 as Hz, and anything else as kHz. Not reliably sent on connect — see below. |
| `BFREQ_FORCE:<val>` | as `BFREQ` | Same meaning, but the client must apply it unconditionally. Used after reconnect or session recovery to override a locally adopted value. |
| `SHIFT:<hz>` | `SHIFT:0.000` | BFO/shift frequency in Hz. Sent whenever the backend's shift differs from what this session was last told, so a freshly attached session always receives one. |
| `M:<mode>` | `M:usb` | Demod mode/preset, lowercase. Not sent by the current server — see "Mode confirmation" below. `radio.js` still handles it. |
| `M_FORCE:<mode>` | as `M` | The only mode notification the server actually sends, and only when adopting a backend-changed preset with no recent local command. |
| `ACK:<clientId>:<seq>` | `ACK:ab12cd34:7` | Acknowledges a command carrying that `clientId`/`seq`. |
| `BUSY:<reason>` | `BUSY:session limit reached` | Session rejected. `radio.js` shows a popup and stops reconnecting. |
| `ZSIZE:<n>` | `ZSIZE:16` | Number of valid `zoom_table[]` indices, in reply to `Z:SIZE`. |
| `PING` | `PING` | Keepalive, roughly every 2s from a dedicated thread. No reply expected. |

## Outbound (client to server)

Every command is wrapped as `C:<clientId>:<seq>:<rawCommand>` by
`wrapControlMessage()` in `html/radio.js`. The server ACKs each one by echoing
the `clientId` and `seq` back.

| Raw command | Example | Meaning |
|---|---|---|
| `F:<khz>` | `F:14250.000` | Set frequency, in **kHz** to three decimals. Unlike the inbound `BFREQ` echo, this direction is unambiguous — it is always kHz. |
| `M:<mode>` | `M:usb` | Set mode/preset, lowercase. |
| `Z:<n>` | `Z:4` | Select a zoom level by **index into the server's `zoom_table[]`**. The client's own table must therefore stay in the same order as the server's; an entry present on one side only shifts every wider selection silently. |
| `Z:+` / `Z:-` | `Z:+` | Step one zoom level in or out. |
| `Z:c:<khz>` | `Z:c:145500.000` | Re-centre the spectrum view, in kHz. |
| `Z:SIZE` | `Z:SIZE` | Query the zoom table size; answered with `ZSIZE:<n>`. |

Commands for memories, spectrum display settings and the rest of the control
surface exist but are not catalogued here.

## Mode confirmation is asymmetric with frequency

Sending `M:<mode>` produces only an `ACK`. No `M:` or `M_FORCE:` follows, even
once the mode takes effect. This is the server's actual logic in
`process_status_packet()`, not a timing artifact:

- Handling your `M:<mode>` command makes `control_set_mode()` set
  `sp->requested_preset` synchronously, so the session already knows what it
  asked for.
- On each subsequent status poll the server compares `Channel.preset` against
  `sp->requested_preset`. **If they match, nothing is sent.** There is no
  confirmation for a command that succeeded exactly as requested.
- `M_FORCE:<preset>` is sent only when they do *not* match **and** no local
  command was issued recently (a 5 second window) — that is, only to report
  drift caused by something else, never to confirm your own request. If a
  mismatch persists with a recent local command, the server re-sends the
  requested preset internally after 5 failed polls, still without notifying
  the browser.

Frequency has no equivalent gap: `BFREQ`'s `backend_changed` check fires on any
real change, whoever caused it. The practical consequence is that a
mode-setting UI cannot wait for a state echo the way a frequency-tuning one
can. Receipt of the `ACK` is the only signal that a mode command reached the
server; whether it was applied has to be inferred some other way, and
`Channel.preset` is not exposed to the browser today.

## Sessions are reattached by client address, not created per connection

`home()` looks up a session by `client_desc`, derived from the connection's
source address by `client_desc_from_request()`, and reattaches the existing
`struct session` if one is found, rather than allocating a fresh one per
WebSocket connection.

This has consequences a client has to account for:

- **`BFREQ` may never arrive.** Its send is gated on
  `last_sent_backend_frequency`, which is a single `static` in `ctrl_thread()`
  shared by every session rather than per-session state. Whether a freshly
  attached session receives a `BFREQ` therefore depends on what other sessions
  have already caused to be recorded there, and tuning one session suppresses
  or triggers notifications for others. Treat "no `BFREQ` yet" as "not yet
  reported", not as a state in itself. `SHIFT` is the only message a freshly
  attached session reliably receives.
- **Clients sharing a source address share a session.** The code's own comment
  anticipates "clients all sharing client_desc=127.0.0.1". The same applies to
  any set of clients behind one NAT or reverse proxy that presents a single
  source address: they can reattach to the same session and change each
  other's tuning. Worth knowing when deploying behind a proxy.
