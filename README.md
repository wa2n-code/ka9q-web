# ka9q-web

A web interface for ka9q-radio by John Melton G0ORX


## How to build ka9q-web

### 1 - Build and install ka9q-radio

- `git clone https://github.com/ka9q/ka9q-radio.git`
- detailed instructions are here: https://github.com/ka9q/ka9q-radio/blob/main/docs/INSTALL.md


### 2 - Install the prerequisites for the Onion framework: GnuTLS and libgcrypto

The Onion framework requires GnuTLS and libgcrypto to compute the SHA1 checksum required by WebSockets.
They can be installed as follows:

- on Ubuntu 22.04 (Jammy Jellyfish) and Ubuntu 24.04 (Noble Numbat):
```
sudo apt install libgnutls28-dev libgcrypt20-dev
```

- on Debian Stable (12, bookworm)  and similar Linux distributions:
```
sudo apt install libgnutls28-dev libgcrypt-dev
```

- on RedHat, CentOS, Fedora and similar Linux distributions:
```
sudo dnf install gnutls-devel libgcrypt-devel
```


### 3 - Build and install the Onion framework

The Orion framework includes a lot of dependencies (like sqlite3, redis, etc) that are not needed just to run ka9q-web. The instructions below build the Onion framework with all the dependencies. See section 3A for instructions to build a lighter version of the Onion framework with only the few necessary dependencies.

```
git clone https://github.com/ka9q/onion
cd onion
mkdir build
cd build
cmake ..
```

Before going ahead with the next steps, do make sure that the output from 'cmake' contains the line:
> -- SSL support is compiled in.

If you don't see it, please review the instructions about the prerequisites for the Onion framework in the previous section.

```
make
sudo make install
sudo ldconfig
```

### 3A - Build and install a light version of the Onion framework

These commands are almost identical to the ones in the section above except that all the unused features of the Onion framework are disabled to limit the number of dependencies and other packages.

```
git clone https://github.com/davidmoreno/onion
cd onion
mkdir build
cd build
cmake -DONION_USE_PAM=false -DONION_USE_PNG=false -DONION_USE_JPEG=false -DONION_USE_XML2=false -DONION_USE_SYSTEMD=false -DONION_USE_SQLITE3=false -DONION_USE_REDIS=false -DONION_USE_GC=false -DONION_USE_TESTS=false -DONION_EXAMPLES=false -DONION_USE_BINDINGS_CPP=false ..
```

Before going ahead with the next steps, do make sure that the output from 'cmake' contains the line:
> -- SSL support is compiled in.

If you don't see it, please review the instructions about the prerequisites for the Onion framework in the previous section.

```
make
sudo make install
sudo ldconfig
```

### 4 - Build and install ka9q-web
```
 - cd ~
- `git clone https://github.com/scottnewell/ka9q-web.git`
- cd ka9q-web
```
- edit the first line of `Makefile` to point to the directory where you built ka9q-radio
- run:
```
make
sudo make install
sudo make install-config    (it will install rx888-web.conf in /etc/radio)
```

## How to run ka9q-web

1. make sure ka9q-radio is running using the configuration rx888-web:
```
sudo systemctl start radiod@rx888-web
systemctl status radiod@rx888-web
```
Address any problem with radiod before going to the next step

2. start ka9q-web
```
ka9q-web
```

Finally open a browser and connect locally to http://localhost:8081 , or from a remote browser to http://<your computer name/IP>:8081

### URL startup arguments

The receiver can be tuned when the page opens by adding query arguments to
either `/` or `/radio.html`:

| Argument | Value | Example | Description |
| --- | --- | --- | --- |
| `freq` | Frequency in **kHz** | `freq=612.000` | Sets the receiver frequency. Decimal values are accepted. |
| `mode` | Preset name | `mode=am` | Sets the mode. The name is case-insensitive and must be available in the mode selector. |
| `audio` | `1`, `true`, `yes`, `on`, or `start` | `audio=1` | Starts the audio stream after the WebSocket session is ready. |

For example, start on 612 kHz in AM mode with audio enabled:

```
http://localhost:8081/?freq=612.000&mode=am&audio=1
```

Or start on 14.2 MHz in USB mode:

```
http://localhost:8081/radio.html?freq=14200.000&mode=usb&audio=1
```

Each argument is optional. URL values override saved browser frequency and mode
settings for that page's active WebSocket session.

#### Allowing automatic audio playback

Browsers commonly block audio until the user interacts with the page. In that
case, `audio=1` starts the server-side audio stream but the browser may leave its
local audio context suspended.

On Firefox, including the Firefox builds commonly supplied with Linux Mint:

1. Enter `about:config` in the Firefox address bar.
2. Accept the warning.
3. Search for `media.autoplay.default`.
4. Change its value to `0` (`0` allows autoplay).
5. Close the ka9q-web tab and open the URL again.

The commonly used values are `0` to allow autoplay, `1` to block audible
autoplay, and `5` to block all autoplay. This preference is global and affects
all websites. To restore Firefox's default later, use the reset button beside
`media.autoplay.default` in `about:config`.

On Chromium/Chrome in a dedicated or kiosk environment, it can be launched with:

```
chromium --autoplay-policy=no-user-gesture-required \
  'http://localhost:8081/?freq=612.000&mode=am&audio=1'
```


NOTE: to start ka9q-web on a different ka9q-radio control address, the command line option is '-m', for instance:
```
ka9q-web -m hf.local
```

3. Optional feature - new Modes

ka9q-web now includes the ability to change parameters for a demodulation mode including different high and low filter settings, among several others. New "modes" can be created via editble text in the file presets.conf located in the /usr/local/share/ka9q-radio directory. This presets.conf file is originally created when installing ka9q-radio and it includes several predefined presets that are identified by a heading tag in square brackets such as [usb], [lsb], [am], [fm] etc. 

ka9q-web has five additional modes that can be employed via the drop-down mode selector. Each mode must have a matching tag in the presets.conf file. The new modes are [wusb], [wlsb], [user1], [user2], and [user3]. None of these modes will work if the matching preset tag is not defined in presets.conf, but no harm will come if you select them.

The easiest way to create a new mode configuration is to edit the presets.conf file and copy / paste an existing mode, then change the ID tag and whatever parameter you want changed below the new ID tag. As an example, here is a preset that matches the "WUSB" mode that widens the high-side filter edge to 3,500 Hz:
```
[wusb]
demod = linear
samprate = 12k
low =  +50.0
high = +3.5k
pll = no
square = no
mono = yes
shift = 0
envelope = no
conj = no
hang-time = 1.1
recovery-rate = 20
```
The line above that is different from the original [usb] mode is high = +3.5k, which has been changed from high = +3k.  Note that the new mode's ID tag in presets.conf must be written in lower case but match the upper case characters shown in the ka9q-web mode drop down selector button list. Also be aware that while the sample rate can be changed in presets.conf, which may modify ka9q-radio's behavior, the sample rate in ka9q-web is either 24k for fm or 12k for all other modes including I/Q. I/Q is a special case where the number of channels that will be saved to disk when using the record function is upped from 1 to 2 to write both I and Q audio streams to disk.

## References

- [John Melton G0ORX fork of ka9q-radio](https://github.com/g0orx/ka9q-radio)
- [Phil Karn KA9Q ka9q-radio](https://github.com/ka9q/ka9q-radio)

## Copyright

(C) 2023-2025 John Melton G0ORX - Licensed under the GNU GPL V3 (see [LICENSE](LICENSE))

### FM squelch controls (development branch)

FM and WFM sessions expose **Open**, **Close** and **Hysteresis** in the mode
controls, but only when an FM demodulator is active. Values are in **dB SNR**.
Hysteresis is calculated as Open minus Close: editing Open preserves the current
hysteresis and adjusts Close; editing Close recomputes hysteresis; editing
Hysteresis adjusts Close. The receiver supports the two threshold fields, not
an independent third hysteresis field.

Press **Apply** to send both thresholds to this session's audio SSRC. The UI
reports success only after the backend confirms the values in a subsequent
status packet. Settings are never automatically replayed on reconnect and do
not change the RX888's RF gains or other sessions (including AIS). Other
modes retain existing squelch/PLL behaviour and do not expose these controls.

### Frontend-aware startup frequency

The browser waits for receiver RF coverage metadata (first LO and usable IF
edges) before sending initial frequency or zoom-centre commands. A supplied
`?freq=` parameter or saved browser frequency is restored when it falls
inside the current receiver's coverage; otherwise a valid backend frequency
wins, falling back to the RF coverage midpoint if necessary. This prevents the
legacy 10 MHz HF default from overriding a live VHF/UHF receiver. On
HF-capable receivers 10 MHz is still a valid default. Nothing is retuned
until complete frontend metadata arrives.

### FM Monitor / unsquelched receive audio

FM and WFM mode now offer a separate **Monitor (squelch OFF)** checkbox.
This is different from an *Open threshold of 0 dB SNR*, which is a
**linear power ratio of 1**, not an always-open squelch. The server sends
finite -500 dB thresholds in Monitor mode. Radiod converts these into
zero-valued float SNR thresholds, which opens FM squelch even at its
zero-clamped noise SNR floor. The server sends a finite -500 dB readback
marker for internal zero thresholds; the browser recognizes it as Monitor.
When Monitor is disabled, the last received normal Open/Close values are
restored. The UI times out after 8 seconds if there is no matching receiver
status, instead of waiting indefinitely. The server logs per-session squelch
commands for diagnostics. No RX888 RF gains or AIS session settings change.

**Normal FM squelch range:** Open and Close each support **−30.0 to +40.0 dB SNR**,
with Close no higher than Open, and with hysteresis (Open − Close) in
**0.0–30.0 dB**. Negative dB is a valid positive SNR power ratio below 1,
not a negative linear power or an indication that squelch is disabled.
For example, Open −3.0 / Close −7.0 / Hysteresis 4.0 is a normal
threshold pair; Open −30.0 / Close −30.0 / Hysteresis 0.0 is the lower
supported boundary. Open 0.0 dB is a ratio of 1 and is also normal squelch.

The browser correctly decodes KA9Q compressed floating-point readbacks for
**both** Open and Close, including a zero-length TLV for exactly 0.0 dB.
The earlier minimum-Open restrictions were web-client/backend validation
choices, not restrictions in radiod's dB conversion. The separate
**Monitor (SQ OFF)** checkbox sends a much lower finite −500 dB threshold
which underflows to an internal zero power ratio and is reported back as
the special −500 dB marker; this is not confused with ordinary negative
thresholds. Using the Monitor checkbox is preferred to passing −999 dB,
which is intentionally outside the normal input range.

After updating, rebuild and restart **only ka9q-web** for the C server-side
validation change; do not rebuild or restart radiod. Live-check
Open=−3.0 / Close=−7.0 / Hysteresis=4.0 and verify receiver readback.
