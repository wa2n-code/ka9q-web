//
// G0ORX WebSDR using ka9q-radio uddated March 16, 2025 02:44Z WA2N WA2ZKD
//
//
//'use strict'; kills save to local storage with Max Hold among other things
      var ssrc;
      var page_title;
      var band;
      let arr_low;
      let ws = null; // Declare WebSocket as a global variable
      // QuickBW debug overlay state
      let cwDebug = { lastSent: null, lastAck: null, wsState: -1 };
      // Simple in-file flag to enable/disable the on-screen debug overlay (non-persistent)
      const CW_DEBUG_OVERLAY = false; // set to true to enable overlay during debugging
      // pending filter edges to send once websocket opens
      let pendingFilterEdges = null;
      // expected ack tracking for last sent edges
      let expectedFilterAck = null; // { low, high, time, retries }
      const EXPECTED_ACK_MAX_RETRIES = 3;

      function createCWDebugOverlay() {
        try {
          if (!CW_DEBUG_OVERLAY) return; // suppressed by in-file flag
          if (document.getElementById('cw_debug_overlay')) return;
          const d = document.createElement('div');
          d.id = 'cw_debug_overlay';
          d.style.position = 'fixed';
          d.style.right = '8px';
          d.style.bottom = '8px';
          d.style.zIndex = 9999;
          d.style.background = 'rgba(0,0,0,0.7)';
          d.style.color = '#0f0';
          d.style.fontFamily = 'monospace';
          d.style.fontSize = '12px';
          d.style.padding = '6px 8px';
          d.style.borderRadius = '6px';
          d.style.maxWidth = '320px';
          d.style.whiteSpace = 'pre-wrap';
          d.style.pointerEvents = 'none';
          d.textContent = 'CW Debug overlay initializing...';
          document.body.appendChild(d);
        } catch (e) { /* ignore */ }
      }

      function updateCWDebugOverlay() {
        try {
          if (!CW_DEBUG_OVERLAY) return;
          const d = document.getElementById('cw_debug_overlay');
          if (!d) return;
          const s = cwDebug.lastSent ? `${cwDebug.lastSent.low}:${cwDebug.lastSent.high} @ ${new Date(cwDebug.lastSent.time).toLocaleTimeString()}` : 'none';
          const a = cwDebug.lastAck ? `${cwDebug.lastAck.low}:${cwDebug.lastAck.high} @ ${new Date(cwDebug.lastAck.time).toLocaleTimeString()}` : 'none';
          const wsst = (ws && ws.readyState != null) ? ws.readyState : cwDebug.wsState;
          const wait = (expectedFilterAck && expectedFilterAck.retries !== undefined) ? ` waiting(retries=${expectedFilterAck.retries})` : '';
          d.textContent = `ws:${wsst}${wait}\nlastSent: ${s}\nlastAck:  ${a}`;
        } catch (e) {}
      }
      let zoomTableSize = null; // Global variable to store the zoom table size
      var spectrum;
      let binWidthHz = 20001; // Change from 20000 Hz per bin fixes the zoom = 1 issue on load.  Must be different than a table entry!  WDR 7-3-2025
      var centerHz = 10000000; // center frequency
      var frequencyHz = 10000000; // tuned frequency
      var lowHz=0;
      var highHz=32400000;

      // Variable to store the actual backend frequency as reported by the server
      var backendFrequencyHz = 0;

      // Update the CW-mode carrier offset marker based on the tuned frequency.
      function updateCWMarker() {
        try {
          if (typeof spectrum === 'undefined' || !spectrum) return;
          const modeEl = document.getElementById('mode');
          const mode = modeEl ? (modeEl.value || '').toLowerCase() : '';
          if (mode === 'cwu' || mode === 'cwl') {
            const tuned = (frequencyHz && Number.isFinite(frequencyHz) && frequencyHz !== 0) ? frequencyHz : (spectrum.frequency || 0);
            if (tuned && Number.isFinite(tuned) && tuned !== 0) {
              const offset = 500; // Hz
              const markerHz = (mode === 'cwu') ? (tuned - offset) : (tuned + offset);
              spectrum.backendMarkerHz = markerHz;
              spectrum.backendMarkerActive = true;
              return;
            }
          }
          spectrum.backendMarkerActive = false;
          spectrum.backendMarkerHz = null;
        } catch (e) { /* ignore */ }
      }
  let binCount = 1620;
  let spanHz = binCount * binWidthHz;
  // Spectrum poll interval in milliseconds (client-side default)
  var spectrumPoll = 100;
      // Spectrum averaging value (separate from FFT averaging)
      let spectrum_average = 10; // default 10, synced with #spectrum_average_input
      var counter = 0;
      var filter_low = -5000;
      var filter_high = 5000;
      var power = -120;
      var gps_time = 0;
      var input_samples = 0;
      var input_samprate = 0;
      var rf_gain = 0;
      var rf_atten = 0;
      var rf_level_cal = 0;
      var rf_agc = 0;
      var if_power = 0;
      var ad_over = 0;
      var samples_since_over = 0;
      var noise_density_spectrum = 0;
      var noise_density_audio = 0;
      var blocks_since_last_poll = 0;
      var last_poll = -1;
      //const webpage_version = "2.72";
      var webserver_version = "";
      var player = new PCMPlayer({
        encoding: '16bitInt',
        channels: 1,
        sampleRate: 12000,
        flushingTime: 250
        });
      // Ensure player volume matches slider after creation. Defer if DOM not ready.
      const volumeSliderInit = document.getElementById('volume_control');
      if (volumeSliderInit) {
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', function() { setPlayerVolume(volumeSliderInit.value); }, { once: true });
        } else {
          setPlayerVolume(volumeSliderInit.value);
        }
      }

      var pending_range_update = false;
      var target_frequency = frequencyHz;
      var target_center = centerHz;
      var target_preset = "am";
      var target_zoom_level = 14;
      var switchModesByFrequency = false;
      var onlyAutoscaleByButton = false;
      var enableAnalogSMeter = false;
      var enableBandEdges = false;
      // pending spectrum average to send once websocket opens
      var pendingSpectrumAverage = null;

      /** @type {number} */
      window.skipWaterfallLines = 0; // Set to how many lines to skip drawing waterfall (0 = none)

// QuickBW preset storage: holds lower/upper offsets (Hz) from current frequency
let quickBWPreset = { lowerOffset: 300, upperOffset: 700 };
// QuickBW runtime state: whether active and stored previous edges for restore
let quickBWActive = false;
let quickBWPrevEdges = null; // { low: number, high: number }
// Suppress automatic sends when programmatically changing filter edge inputs
let suppressEdgeAutoSend = false;
function loadQuickBWPreset() {
  try {
    const v = (localStorage.getItem && localStorage.getItem('QuickBWPreset'));
    if (v) {
      try {
        quickBWPreset = JSON.parse(v);
      } catch (e) {
        console.warn('Failed to parse QuickBWPreset, using defaults');
      }
    }
  } catch (e) {
    console.warn('Failed to access localStorage for QuickBWPreset, using defaults');
  }
}
function saveQuickBWPreset() {
  try { localStorage.setItem('QuickBWPreset', JSON.stringify(quickBWPreset)); } catch (e) {}
  console.log('Saved QuickBWPreset:', quickBWPreset);
}

// Update QuickBW button enabled/disabled state based on current mode
function updateQuickBWButtonState() {
  try {
    const btn = document.getElementById('cw_instant_button');
    const modeEl = document.getElementById('mode');
    if (!btn || !modeEl) return;
    const m = (modeEl.value || '').toLowerCase();
    if (m === 'usb' || m === 'lsb') {
      btn.removeAttribute('disabled');
      btn.style.opacity = '';
    } else {
      // If mode no longer supports QuickBW but it was active, deactivate and restore edges
      if (quickBWActive) {
        try { applyQuickBW(); } catch (e) {}
      }
      btn.setAttribute('disabled', 'disabled');
      btn.style.opacity = '0.6';
    }
    // Reflect active state visually (bold when active)
    if (quickBWActive) {
      btn.style.fontWeight = 'bold';
      btn.title = 'Restore previous filter bandwidth';
    } else {
      btn.style.fontWeight = '';
      btn.title = 'Apply alternate filter bandwidth';
    }
  } catch (e) {}
}

// Apply QuickBW preset: set filter input boxes and send edges to backend
function applyQuickBW() {
  const lowEl = document.getElementById('filterLowInput');
  const highEl = document.getElementById('filterHighInput');
  const modeEl = document.getElementById('mode');
  if (!lowEl || !highEl || !modeEl) return;
  const m = (modeEl.value || '').toLowerCase();
  if (!(m === 'usb' || m === 'lsb')) return;
  const lowerOffset = Number(quickBWPreset.lowerOffset) || 300;
  const upperOffset = Number(quickBWPreset.upperOffset) || 700;
  // Toggle behavior: if already active, restore previous edges; otherwise save current and apply offsets
  if (quickBWActive) {
    // restore
    if (quickBWPrevEdges) {
      suppressEdgeAutoSend = true;
      lowEl.value = quickBWPrevEdges.low;
      highEl.value = quickBWPrevEdges.high;
      suppressEdgeAutoSend = false;
      quickBWPrevEdges = null;
    }
    quickBWActive = false;
    updateQuickBWButtonState();
    sendFilterEdges();
    return;
  }

  // Save current edges for later restore
  quickBWPrevEdges = { low: lowEl.value, high: highEl.value };

  let lowVal, highVal;
  if (m === 'usb') {
    // USB: add offsets (positive)
    lowVal = Math.min(lowerOffset, upperOffset);
    highVal = Math.max(lowerOffset, upperOffset);
  } else {
    // LSB: subtract offsets (negative)
    lowVal = -Math.max(upperOffset, lowerOffset);
    highVal = -Math.min(upperOffset, lowerOffset);
  }

  // Programmatic change without marking manual-dirty
  suppressEdgeAutoSend = true;
  lowEl.value = lowVal;
  highEl.value = highVal;
  suppressEdgeAutoSend = false;

  quickBWActive = true;
  updateQuickBWButtonState();
  // Send to backend
  sendFilterEdges();
}

      // Network-to-host helpers (explicit, predictable byte swaps)
      // For this codebase DataView reads explicitly specify endianness where needed.
      // Make ntoh helpers no-ops to avoid double-swapping values.
      function ntohs(v) { return v & 0xFFFF; }
      function ntohl(v) { return v >>> 0; }
      function ntohf(v) { return v; }

      function calcFrequencies() {
        lowHz = centerHz - ((binWidthHz * binCount) / 2);
        highHz = centerHz + ((binWidthHz * binCount) / 2);
        spanHz = binCount * binWidthHz;
      }

      function on_ws_open() {
        // get the SSRC
        ws.send("S:");
        // default to 20 Mtr band
        //document.getElementById('20').click()
        spectrum.setFrequency(1000.0 * parseFloat(document.getElementById("freq").value,10));
        updateCWMarker();
        // can we load the saved frequency/zoom/preset here?
        ws.send("M:" + target_preset);
        //ws.send("Z:" + (22 - target_zoom_level).toString());
        ws.send("Z:" + (target_zoom_level).toString());
        ws.send("Z:c:" + (target_center / 1000.0).toFixed(3));
        ws.send("F:" + (target_frequency / 1000.0).toFixed(3));
        fetchZoomTableSize(); // Fetch and store the zoom table size
        // Initialize filter edge inputs based on the target preset
        try {
          setFilterEdgesForMode(target_preset);
        } catch (e) {}
        // Attach listeners so spinner/caret presses auto-send
        try { attachEdgeInputListeners(); } catch (e) {}
        // If a filter-edge update was queued while WS was closed, send it now
        try {
          if (pendingFilterEdges && ws && ws.readyState === WebSocket.OPEN) {
            ws.send('e:' + pendingFilterEdges.low.toString() + ':' + pendingFilterEdges.high.toString());
            cwDebug.lastSent = { low: pendingFilterEdges.low, high: pendingFilterEdges.high, time: Date.now() };
            cwDebug.wsState = ws.readyState;
            updateCWDebugOverlay();
            pendingFilterEdges = null;
          }
        } catch (e) { console.error('Failed to flush pending filter edges', e); }
        // If a spectrum_average update was queued while WS was closed, or send current default
        try {
          if (pendingSpectrumAverage && ws && ws.readyState === WebSocket.OPEN) {
            // console.log('Flushing queued spectrum average to backend:', pendingSpectrumAverage.val);
            ws.send('g:' + pendingSpectrumAverage.val.toString());
            pendingSpectrumAverage = null;
          } else if (ws && ws.readyState === WebSocket.OPEN) {
            // Always send current spectrum_average so backend is in sync
            // console.log('Sending current spectrum_average to backend on WS open:', spectrum_average);
            ws.send('g:' + spectrum_average.toString());
          }
        } catch (e) { console.error('Failed to flush/send spectrum average', e); }
        // create debug overlay when WS opens
        try { createCWDebugOverlay(); updateCWDebugOverlay(); } catch (e) {}
      }

      // Send a request to the server to change the spectrum poll interval (milliseconds).
      function sendSpectrumPoll() {
        const elm = document.getElementById('spectrumPollInput');
        if (!elm) return;
        const v = parseInt(elm.value, 10);
        if (isNaN(v) || v <= 0) {
          console.warn('Invalid spectrum poll value', elm.value);
          return;
        }
        spectrumPoll = v;
        if (ws && ws.readyState === WebSocket.OPEN) {
          try {
            ws.send('r:' + v.toString());
            console.log('Sent spectrum poll request:', v);
          } catch (e) {
            console.error('Failed to send spectrum poll:', e);
          }
        } else {
          console.warn('WebSocket not open, cannot send spectrum poll');
        }
      }

      // Send filter edge settings (low and high) to the server via websocket
      function sendFilterEdges() {
        const lowEl = document.getElementById('filterLowInput');
        const highEl = document.getElementById('filterHighInput');
        if (!lowEl || !highEl) return;
        const low = parseFloat(lowEl.value);
        const high = parseFloat(highEl.value);
        if (isNaN(low) || isNaN(high)) {
          console.warn('Invalid filter edge values', lowEl.value, highEl.value);
          return;
        }
        if (ws && ws.readyState === WebSocket.OPEN) {
          try {
            const payload = 'e:' + low.toString() + ':' + high.toString();
            ws.send(payload);
            // update debug overlay state
            try { cwDebug.lastSent = { low: low, high: high, time: Date.now() }; cwDebug.wsState = ws.readyState; updateCWDebugOverlay(); } catch (e) {}
            //console.log('Sent filter edges:', low, high);
            // expect ack from server; set up one-time retry
            try {
              expectedFilterAck = { low: low, high: high, time: Date.now(), retries: 0 };
              // schedule check
              setTimeout(() => {
                try {
                  // if ack arrived with matching low/high, clear expected
                  if (expectedFilterAck && cwDebug.lastAck && Number(cwDebug.lastAck.low) === Number(expectedFilterAck.low) && Number(cwDebug.lastAck.high) === Number(expectedFilterAck.high)) {
                    expectedFilterAck = null;
                    updateCWDebugOverlay();
                    return;
                  }
                  // otherwise resend once
                  if (expectedFilterAck && expectedFilterAck.retries === 0) {
                    expectedFilterAck.retries = 1;
                    //console.log('[sendFilterEdges] No ack within timeout, retrying send for', expectedFilterAck.low, expectedFilterAck.high);
                    if (ws && ws.readyState === WebSocket.OPEN) {
                      ws.send('e:' + expectedFilterAck.low.toString() + ':' + expectedFilterAck.high.toString());
                      cwDebug.lastSent = { low: expectedFilterAck.low, high: expectedFilterAck.high, time: Date.now() };
                      updateCWDebugOverlay();
                    }
                    // allow more time for ack; clear after another timeout
                    setTimeout(() => { expectedFilterAck = null; updateCWDebugOverlay(); }, 2000);
                  }
                } catch (e) { console.error('expectedFilterAck check failed', e); }
              }, 800);
            } catch (e) {}
            edgeManualDirty = false;
            updateEdgeButtonState();
          } catch (e) {
            console.error('Failed to send filter edges:', e);
          }
        } else {
          console.warn('WebSocket not open, queueing filter edges');
          pendingFilterEdges = { low: low, high: high, time: Date.now() };
          try { cwDebug.lastSent = pendingFilterEdges; cwDebug.wsState = (ws && ws.readyState) || -1; updateCWDebugOverlay(); } catch (e) {}
        }
      }

      function on_ws_close(evt) {
         console.log("WebSocket closed:", evt);
      }

      async function on_ws_message(evt) {
        if(typeof evt.data === 'string') {
          // text data
          //console.log(evt.data);
          let temp=evt.data.toString();
          let args=temp.split(":");
          if(args[0]=='S') { // get our ssrc
            ssrc=parseInt(args[1]);
          }
          // (BFREQ messages ignored for marker placement)
        } else if(evt.data instanceof ArrayBuffer) {
          var data = evt.data;
          rx(data.byteLength);
          // defensive: avoid throws on truncated packets
          const view = new DataView(evt.data);
          var i = 0;
          const ensure = (off, len) => ((off + len) <= view.byteLength);
          // Need at least 12 bytes for basic header
          if (!ensure(0, 12)) {
            console.warn('Short ArrayBuffer received, length=', view.byteLength);
            return;
          }
          var n = view.getUint32(i);
          i += 4;
          var w = ntohl(n);
          var version = w >> 30;
          var pad = (w >> 29) & 1;
          var extension = (w >> 28) & 1;
          var cc = (w >> 24) & 0x0f;
          var type = (w >> 16) & 0x7f;
          var seq = w & 0xffff;

          if (!ensure(i, 8)) {
            console.warn('Truncated header: missing timestamp/ssrc', view.byteLength);
            return;
          }
          n = view.getUint32(i);
          i += 4;
          var timestamp = ntohl(n);
          n = view.getUint32(i);
          i += 4;
          var this_ssrc = ntohl(n);
          // skip CSRCs
          if (!ensure(i, cc * 4)) {
            console.warn('Truncated CSRC list, expected', cc * 4, 'bytes');
            return;
          }
          i = i + (cc * 4);
          if (extension) {
            if (!ensure(i, 4)) { console.warn('Truncated extension header'); return; }
            n = view.getUint32(i);
            var ext_len = ntohl(n);
            i += 4;
            if (!ensure(i, ext_len)) { console.warn('Truncated extension payload'); return; }
            i = i + ext_len;
          }

          // i now points to the start of the data
          var data_length = data.byteLength - i;
          var update = 0;
          switch (type) {
            case 0x7F: // SPECTRUM DATA
            const newBinCount = view.getUint32(i, false); i += 4;
            if (binCount != newBinCount) {
              binCount = newBinCount;
              update = 1;
            }
              n = view.getUint32(i);
              i=i+4;
              var hz = ntohl(n);
              if(centerHz!=hz) {
                centerHz=hz;
                update=1;
              }


              n = view.getUint32(i);
              i=i+4;
              hz = ntohl(n);
              if(frequencyHz!=hz) {
                frequencyHz=hz;
                update=1;
              }
              // Update backendFrequencyHz to reflect the actual backend frequency
              backendFrequencyHz = hz;
              //console.log("Backend frequency updated to: " + backendFrequencyHz + " Hz");
              n = view.getUint32(i);
              i=i+4;
              hz = ntohl(n);;
              if(binWidthHz != hz) {
                binWidthHz = hz;
                update = 1;
              }

            // newell 12/1/2024, 19:18:05
            // Turns out javascript can do big endian!
            // What a pleasant and unexpected surprise!
            // might want to refactor centerHz, frequencyHz, and binWidthHz, too
            input_samprate = view.getUint32(i,true); i+=4;
            spectrum.input_samprate = input_samprate;
            rf_agc = view.getUint32(i,true); i+=4;
            input_samples = view.getBigUint64(i,true); i+=8;
            ad_over = view.getBigUint64(i,true); i+=8;
            samples_since_over = view.getBigUint64(i,true); i+=8;
            gps_time = view.getBigUint64(i,true); i+=8;
            rf_atten = view.getFloat32(i,true); i+=4;
            rf_gain = view.getFloat32(i,true); i+=4;
            rf_level_cal = view.getFloat32(i,true); i+=4;
            if_power = view.getFloat32(i,true); i+=4;
            noise_density_audio = view.getFloat32(i,true); i+=4;
            const z_level = view.getUint32(i,true); i+=4;
            const bins_autorange_offset =  view.getFloat32(i,true); i+=4;
            const bins_autorange_gain =  view.getFloat32(i,true); i+=4;

            if(update) {
              calcFrequencies();
              spectrum.setLowHz(lowHz);
              spectrum.setHighHz(highHz);
              // record the server-provided center so the UI can align incoming waterfall rows
              try {
                spectrum._lastServerCenterHz = centerHz;
              } catch (e) {}
              // If the user is left-dragging (previewing a transient center), avoid stomping the
              // spectrum's transient center with the server center; otherwise apply normally.
              if (!spectrum._leftDragging) {
                spectrum.setCenterHz(centerHz);
              }
              spectrum.setFrequency(frequencyHz);
              updateCWMarker();
              spectrum.setSpanHz(binWidthHz * binCount);
              spectrum.bins = binCount;
              try {
                const zoomEl = document.getElementById("zoom_level");
                if (zoomEl) {
                  const maxVal = (typeof zoomTableSize === 'number' && !isNaN(zoomTableSize)) ? (zoomTableSize - 1) : Number(zoomEl.max) || 0;
                  zoomEl.max = maxVal;
                  // If the frontend sample rate is the lower value (<= 64.8 MHz) disallow zoom level 0
                  const minVal = (typeof input_samprate === 'number' && input_samprate > 0 && input_samprate <= 64800000) ? 1 : 0;
                  zoomEl.min = minVal;
                  // Clamp incoming server-provided zoom level to the allowed range before showing
                  let clamped = z_level;
                  if (clamped < minVal) clamped = minVal;
                  if (clamped > maxVal) clamped = maxVal;
                  zoomEl.value = clamped;
                } else {
                  document.getElementById("zoom_level").value = z_level;
                }
              } catch (e) { console.warn('Failed to update zoom control bounds', e); }
              //console.log("Zoom level=",z_level);
              document.getElementById("freq").value = (frequencyHz / 1000.0).toFixed(3);
              saveSettings();
              // Show bandwidth popup for the newly-applied zoom level (server-driven)
              try {
                if (typeof window.showZoomBandwidthPopupForValue === 'function') {
                  // Use the server-provided z_level to show the accurate post-change bandwidth
                  window.showZoomBandwidthPopupForValue(z_level);
                }
              } catch (e) { /* ignore popup errors */ }
            }
              var dataBuffer = evt.data.slice(i,data.byteLength);
              const i8 = new Uint8Array(dataBuffer);
              const arr = new Float32Array(binCount);
              // dynamic autorange of 8 bit bin levels, using offset/gain from webserver
              for (i = 0; i < binCount; i++) {
                arr[i] = bins_autorange_offset + (bins_autorange_gain * i8[i]);
              }
              spectrum.addData(arr);
            /*
            if (pending_range_update) {
                pending_range_update = false;
                updateRangeValues();
                saveSettings();
            }
            */

            update_stats();
            break;
            case 0x7E: // Channel Data
              while(i<data.byteLength) {
                var v=view.getInt8(i++);
                var l=view.getInt8(i++);
                switch(v) {
                case 4: // DESCRIPTION
                  dataBuffer = evt.data.slice(i,i+l);
                  let d = new Uint8Array(dataBuffer);
                  let enc = new TextDecoder("utf-8");
                  page_title = enc.decode(d);
                  const headingElem = document.getElementById('heading');
                  if (headingElem) {
                      if (/^https?:\/\//i.test(page_title)) {
                          headingElem.innerHTML = `<a href="${page_title}" target="_blank" style="text-decoration: underline; color: inherit;">${page_title}</a>`;
                      } else {
                          headingElem.textContent = page_title;
                      }
                  }
                  document.title = page_title;
                  i=i+l;
                  break;
                case 39: // LOW_EDGE
                    dataBuffer = evt.data.slice(i,i+l);
                    try {
                      const dvLow = new DataView(dataBuffer);
                      // Server sends float32 in network (big-endian) order — read explicitly
                      filter_low = dvLow.getFloat32(0, false);
                    } catch (e) {
                      // fallback: try typed array
                      try { arr_low = new Float32Array(dataBuffer); filter_low = Number(arr_low[0]); } catch (e2) { filter_low = 0; }
                    }
                    try { cwDebug.lastAck = { low: filter_low, high: filter_high, time: Date.now() }; updateCWDebugOverlay(); } catch (e) {}
                    i=i+l;
                    break;
                  case 40: // HIGH_EDGE
                    dataBuffer = evt.data.slice(i,i+l);
                    try {
                      const dvHigh = new DataView(dataBuffer);
                      filter_high = dvHigh.getFloat32(0, false);
                    } catch (e) {
                      try { let arr_high = new Float32Array(dataBuffer); filter_high = Number(arr_high[0]); } catch (e2) { filter_high = 0; }
                    }
                    try { cwDebug.lastAck = { low: filter_low, high: filter_high, time: Date.now() }; updateCWDebugOverlay(); } catch (e) {}
                    i=i+l;
                    break;
                  case 46: // BASEBAND_POWER
                    power=view.getFloat32(i);
                    power = 10.0 * Math.log10(power);
                    i=i+l;
                    break;
                }
              }
              // Ensure filter edges are numeric (avoid strings/BigInt) before applying
              try {
                filter_low = Number(filter_low);
                filter_high = Number(filter_high);
                if (Number.isFinite(filter_low) && Number.isFinite(filter_high)) {
                  spectrum.setFilter(filter_low, filter_high);
                } else {
                  console.warn('Invalid filter edges received:', filter_low, filter_high);
                }
              } catch (e) {
                console.warn('Failed to apply filter edges:', e);
              }
              try {
                // record ack
                try { cwDebug.lastAck = { low: filter_low, high: filter_high, time: Date.now() }; updateCWDebugOverlay(); } catch (e) {}
                // If we expected a different ack, attempt an immediate resend (bounded retries)
                if (expectedFilterAck) {
                  const expLow = Number(expectedFilterAck.low);
                  const expHigh = Number(expectedFilterAck.high);
                  if (expLow !== Number(filter_low) || expHigh !== Number(filter_high)) {
                    if (expectedFilterAck.retries < EXPECTED_ACK_MAX_RETRIES) {
                      expectedFilterAck.retries++;
                      //console.log('[on_ws_message] ACK mismatch; resending expected edges', expectedFilterAck.low, expectedFilterAck.high, 'retry=', expectedFilterAck.retries);
                      if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send('e:' + expectedFilterAck.low.toString() + ':' + expectedFilterAck.high.toString());
                        cwDebug.lastSent = { low: expectedFilterAck.low, high: expectedFilterAck.high, time: Date.now() };
                        updateCWDebugOverlay();
                      }
                    } else {
                      // give up after max retries
                      expectedFilterAck = null;
                      updateCWDebugOverlay();
                    }
                  } else {
                    // ack matches expected, clear
                    expectedFilterAck = null;
                    updateCWDebugOverlay();
                  }
                }
              } catch (e) {}
              break;
            case 0x7A: // 122 - 16bit PCM Audio at 12000 Hz
              // Audio data 1 channel 12000
              var dataBuffer = evt.data.slice(i,data.byteLength);
              var audio_data=new Uint8Array(dataBuffer,0,data_length);
              // byte swap
              for(i=0;i<data_length;i+=2) {
                var tmp=audio_data[i];
                audio_data[i]=audio_data[i+1];
                audio_data[i+1]=tmp;
              }
              // push onto audio queue
              player.feed(audio_data);
              break;
            default:
              try {
                console.warn("received unknown type:", type, `(0x${type.toString(16)})`, "data_len=", data_length);
              } catch (e) {
                console.warn('received unknown type (and failed to format)');
              }
              break;
          }
        }
      }

      function on_ws_error(evt) {
        console.log("WebSocket error:", evt);
      }

      function is_touch_enabled() {
        return ( 'ontouchstart' in window ) ||
               ( navigator.maxTouchPoints > 0 ) ||
               ( navigator.msMaxTouchPoints > 0 );
      }

      var init = function(){
        settingsReady = false; // Block saves during initialization
        frequencyHz = 10000000;
        centerHz = 10000000;
        binWidthHz = 20001; // Change from 20000 Hz per bin fixes the zoom = 1 issue on load.  Must be different than a table entry!  WDR 7-3-2025
        spectrum = new Spectrum("waterfall", {spectrumPercent: 50, bins: binCount});
        setupFftAvgInput();
        setupSpectrumAvgInput();

        // Setup overlay buttons after spectrum is created
        document.addEventListener('DOMContentLoaded', function() {
            if (spectrum && typeof spectrum.setupOverlayButtons === 'function') {
                setTimeout(function() {
                    spectrum.setupOverlayButtons();
                }, 100); // Small delay to ensure DOM is ready
            }
        });
        // Ensure sensible in-memory defaults exist before attempting to load stored settings.
        // Pass `false` to avoid writing defaults to localStorage unless we actually need to create them.
        setDefaultSettings(false);
        if (!loadSettings()) {
          console.log("no saved settings found, committing defaults to localStorage");
          setDefaultSettings(true);
        }
        // Run a diagnostic to surface any missing saved keys (alerts the user)
        try { diagnosticCheckSettings(true); } catch (e) { /* ignore */ }
        // Trigger autoscale on first load so spectrum has sensible range
        //try { autoAutoscale(50, true); } catch (e) { /* ignore */ }
        spectrum.radio_pointer = this;
        page_title = "";

        //msg=document.getElementById('msg');
        //msg.focus();
        ws=new WebSocket(
            (window.location.protocol == 'https:' ? 'wss://' : 'ws://') +
            window.location.host
        );
        ws.onmessage=on_ws_message;
        ws.onopen=on_ws_open;
        ws.onclose=on_ws_close;
        ws.binaryType = "arraybuffer";
        ws.onerror = on_ws_error;
        document.getElementById('waterfall').addEventListener("wheel", onWheel, false);
        document.getElementById('waterfall').addEventListener("keydown", (event) => { spectrum.onKeypress(event); }, false);
        document.getElementById("freq").value = (frequencyHz / 1000.0).toFixed(3);
        document.getElementById('step').value = increment.toString();
        document.getElementById('colormap').value = spectrum.colorIndex;
        document.getElementById('decay_list').value = spectrum.decay.toString();
        document.getElementById('cursor').checked = spectrum.cursor_active;
        document.getElementById('pause').textContent = (spectrum.paused ? "Spectrum Run" : "Spectrum Pause");
        document.getElementById('max_hold').textContent = (spectrum.maxHold ? "Turn hold off" : "Turn hold on");

        // set zoom, preset, spectrum percentage?
        spectrum.setAveraging(spectrum.averaging);
        spectrum.setColormap(spectrum.colorIndex);
        updateRangeValues();
        player.volume(1.00);
        getVersion();
        // Attach a listener to the mode selector so switching to CWU/CWL immediately shows the marker
        try {
          const modeEl = document.getElementById('mode');
          const updateBackendMarkerForMode = function() {
            try { updateCWMarker(); } catch (e) { /* ignore */ }
          };
          if (modeEl) {
            modeEl.addEventListener('change', updateBackendMarkerForMode);
            // initialize marker based on current mode immediately
            updateBackendMarkerForMode();
          }
        } catch (e) { /* ignore */ }
        settingsReady = true; // Allow saves after initialization
      }

    // removed addevent listener for load and call init in the fetch script in radio.html
    // window.addEventListener('load', init, false);

    var increment=1000;
    function onClick(e) {   // click on waterfall or spectrum
      var span = binWidthHz * binCount;
      width=document.getElementById('waterfall').width;
      hzPerPixel=span/width;
      f=Math.round((centerHz-(span/2))+(hzPerPixel*e.pageX));
      f=f-(f%increment);
      if (!spectrum.cursor_active) {
        document.getElementById("freq").value = (f / 1000.0).toFixed(3);
        setFrequencyW(false);
      } else {
        spectrum.cursor_freq = spectrum.limitCursor(Math.round((centerHz - (span / 2)) + (hzPerPixel * e.pageX)));
      }
      saveSettings();
    }

    var pressed=false;
    var moved=false;
    var startX;
    function onMouseDown(e) {
      moved=false;
      pressed=true;
      startX=e.pageX;
    }

    function onMouseUp(e) {
      if(!moved) {
        width=document.getElementById('waterfall').width;
        hzPerPixel = binWidthHz / width;
        f=Math.round((centerHz - (binWidthHz / 2)) + (hzPerPixel * e.pageX));
        f=f-(f%increment);
        document.getElementById("freq").value = (f / 1000.0).toFixed(3);
        setFrequencyW(false);
      }
      saveSettings();
      pressed=false;
    }

    function onMouseMove(e) {
      if(pressed) {
        moved=true;
        if(startX<e.pageX) {
          incrementFrequency();
        } else if(e.pageX<startX) {
          decrementFrequency();
        }
        startX=e.pageX;
      }
      saveSettings();
    }

    function onWheel(e) {
          e.preventDefault();
      if (!spectrum.cursor_active) {
        if(e.deltaY<0) {
          //scroll up
          incrementFrequency();
        } else {
          // scroll down
          decrementFrequency();
        }
      } else {
        if(e.deltaY < 0) {
          spectrum.cursorUp();
        } else {
          spectrum.cursorDown();
        }
      }
      saveSettings();
    }

    function step_changed(value) {
        increment = parseInt(value);
        saveSettings();
    }

    function incrementFrequency(multiplier = 1)
    {
        var value = parseFloat(document.getElementById('freq').value,10);
        value = isNaN(value) ? 0 : (value * 1000.0) + increment * multiplier;
        if (!spectrum.checkFrequencyIsValid(value)) {
            return;
        }
        document.getElementById("freq").value = (value / 1000.0).toFixed(3);
        ws.send("F:" + (value / 1000.0).toFixed(3));
        //document.getElementById("freq").value=value.toString();
        //band.value=document.getElementById('msg').value;
        spectrum.setFrequency(value);
        updateCWMarker();
        spectrum.checkFrequencyAndClearOverlays(value);
        saveSettings();
    }

    function decrementFrequency(multiplier = 1)
    {
        var value = parseFloat(document.getElementById('freq').value,10);
        value = isNaN(value) ? 0 : (value * 1000.0) - increment * multiplier;
        if (!spectrum.checkFrequencyIsValid(value)) {
            console.warn("Requested frequency is out of range: " + value);
            return;
        }
        document.getElementById("freq").value = (value / 1000.0).toFixed(3);
        ws.send("F:" + (value / 1000.0).toFixed(3));
        //document.getElementById("freq").value=value.toString();
        //band.value=document.getElementById('msg').value;
        spectrum.setFrequency(value);
        updateCWMarker();
        spectrum.checkFrequencyAndClearOverlays(value);
        saveSettings();
    }

    function startIncrement(a = 1, b) {
      // a may be an Event (mouse) or a numeric multiplier. b optionally holds a baseMultiplier when a is Event.
      var multiplier;
      if (a && typeof a === 'object' && ('ctrlKey' in a)) {
        // mouse event path
        const evt = a;
        const base = (typeof b === 'number') ? b : 1;
        // only handle left mouse button
        if ('button' in evt && evt.button !== 0) {
          multiplier = base;
        } else if (typeof window.isAlternateFreqActive === 'function' && window.isAlternateFreqActive()) {
          // If Alt-button active: for single-step +/-, use 10 Hz; for < or > (base==10) use 100 Hz
          const targetHz = (base === 10) ? 100 : 10;
          multiplier = targetHz / increment;
        } else {
          multiplier = base;
        }
      } else {
        multiplier = (typeof a === 'number') ? a : 1;
      }
      incrementFrequency(multiplier);
      counter=setInterval(function() { incrementFrequency(multiplier); },200);
      saveSettings();
    }

    function stopIncrement() {
        clearInterval(counter);
    }

    function startDecrement(a = 1, b) {
      // a may be an Event (mouse) or a numeric multiplier. b optionally holds a baseMultiplier when a is Event.
      var multiplier;
      if (a && typeof a === 'object' && ('ctrlKey' in a)) {
        const evt = a;
        const base = (typeof b === 'number') ? b : 1;
        if ('button' in evt && evt.button !== 0) {
          multiplier = base;
        } else if (typeof window.isAlternateFreqActive === 'function' && window.isAlternateFreqActive()) {
          const targetHz = (base === 10) ? 100 : 10;
          multiplier = targetHz / increment;
        } else {
          multiplier = base;
        }
      } else {
        multiplier = (typeof a === 'number') ? a : 1;
      }
      decrementFrequency(multiplier);
      counter=setInterval(function() { decrementFrequency(multiplier); },200);
      saveSettings();
    }

    function stopDecrement() {
        clearInterval(counter);
    }

    // Alternate frequency buttons toggle
    // Controls visual state of the "Alt" button and exposes a getter
    (function(){
      let alternateFreqActive = false;

      function updateAltButton(){
        const btn = document.getElementById('alternate_freq_buttons');
        if(!btn) return;
        btn.classList.toggle('alt-active', alternateFreqActive);
        btn.setAttribute('aria-pressed', alternateFreqActive ? 'true' : 'false');
        btn.title = alternateFreqActive ? 'Alternate frequency buttons: ACTIVE' : 'Alternate frequency buttons: inactive';
      }

      function toggleAlternateFreq(){
        alternateFreqActive = !alternateFreqActive;
        updateAltButton();
        if(window.console) console.log('alternateFreqActive =', alternateFreqActive);
      }

      window.isAlternateFreqActive = function(){ return alternateFreqActive; };
      window.toggleAlternateFreq = toggleAlternateFreq;

      // attach handler when button exists
      function attach(){
        const btn = document.getElementById('alternate_freq_buttons');
        if(!btn) return;
        btn.addEventListener('click', toggleAlternateFreq);
        updateAltButton();
      }

      if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attach);
      else attach();
    })();

    // ...existing code...

    let incrementing = false;
    let decrementing = false;
    let currentMultiplier = 1;

    document.addEventListener('keydown', function(e) {
      // Shift + Right Arrow with Alt-button active -> larger multiplier
      const altActive = (typeof window.isAlternateFreqActive === 'function' && window.isAlternateFreqActive());
      if (e.shiftKey && altActive && e.code === 'ArrowRight') {
        if (!incrementing) {
          currentMultiplier = 10;
          startIncrement(currentMultiplier);
          incrementing = true;
        }
        e.preventDefault();
      }
      // Shift + Left Arrow with Alt-button active -> larger multiplier
      else if (e.shiftKey && altActive && e.code === 'ArrowLeft') {
        if (!decrementing) {
          currentMultiplier = 10;
          startDecrement(currentMultiplier);
          decrementing = true;
        }
        e.preventDefault();
      }
      // Shift + Right Arrow (no Alt-button)
      else if (e.shiftKey && e.code === 'ArrowRight') {
        if (!incrementing) {
          currentMultiplier = 1;
          startIncrement(currentMultiplier);
          incrementing = true;
        }
        e.preventDefault();
      }
      // Shift + Left Arrow (no Alt-button)
      else if (e.shiftKey && e.code === 'ArrowLeft') {
        if (!decrementing) {
          currentMultiplier = 1;
          startDecrement(currentMultiplier);
          decrementing = true;
        }
        e.preventDefault();
      }
    });

    document.addEventListener('keyup', function(e) {
      // Right Arrow
      if (e.code === 'ArrowRight') {
        if (incrementing) {
          stopIncrement();
          incrementing = false;
        }
        e.preventDefault();
      }
      // Left Arrow
      if (e.code === 'ArrowLeft') {
        if (decrementing) {
          stopDecrement();
          decrementing = false;
        }
        e.preventDefault();
      }
    });

    // Allow 'f' to toggle spectrum fullscreen even when the waterfall/canvas does not have focus.
    // If the waterfall canvas already has focus, Spectrum.prototype.onKeypress will handle 'f'.
    document.addEventListener('keydown', function(e) {
      if (e.key === 'f' || e.code === 'KeyF') {
        try {
          const waterfall = document.getElementById('waterfall');
          const active = document.activeElement;
          // If the memory description input has focus, don't treat 'f' as the global fullscreen hotkey
          if (active && active.id === 'memory_desc') {
            return;
          }
          // Only handle here when the waterfall does NOT have focus
          if (!(waterfall && active === waterfall)) {
            if (typeof spectrum !== 'undefined' && spectrum) {
              spectrum.toggleFullscreen();
              e.preventDefault();
            }
          }
        } catch (err) {
          // ignore
        }
      }
    }, false);

    // When an element enters fullscreen, ensure the waterfall canvas receives keyboard focus
    // so subsequent keypresses are handled by Spectrum.prototype.onKeypress.
    document.addEventListener('fullscreenchange', function() {
      try {
        const wf = document.getElementById('waterfall');
        if (document.fullscreenElement === wf) {
          // give it focus so it receives keyboard events
          wf.focus();
        }
      } catch (e) {
        // ignore
      }
    });

    // Space bar toggles audio (calls audio_start_stop defined in radio.html)
    // Placed here next to other keyboard handlers for readability.
    document.addEventListener('keydown', function(e) {
      // Prefer e.code when available; fall back to e.key for older browsers
      if (e.code === 'Space' || e.key === ' ') {
        // If the spectrum is fullscreen, prevent page scrolling but do not toggle audio here.
        // Let Spectrum.prototype.onKeypress handle keys while fullscreen.
        if (typeof spectrum !== 'undefined' && spectrum && spectrum.fullscreen) {
          e.preventDefault();
          return;
        }
        // Prevent default scrolling when Space is pressed and we're handling it
        e.preventDefault();
        try {
          audio_start_stop();
        } catch (err) {
          console.error('audio_start_stop() not available:', err);
        }
      }
    }, false);

    // ...existing code...

    function setFrequencyW(a, b)
    {
        // Normalize arguments so existing callers still work.
        // Possible call patterns:
        //  - setFrequencyW()                      -> no args
        //  - setFrequencyW(false)                 -> waitToAutoscale=false
        //  - setFrequencyW(event)                 -> event from onclick
        //  - setFrequencyW(event, false)          -> event and waitToAutoscale
        var evt = null;
        var waitToAutoscale = true;
        if (a && typeof a === 'object' && ('ctrlKey' in a || 'type' in a)) {
          evt = a;
          waitToAutoscale = (typeof b === 'boolean') ? b : true;
        } else {
          waitToAutoscale = (typeof a === 'boolean') ? a : true;
          evt = (b && typeof b === 'object' && ('ctrlKey' in b)) ? b : null;
        }

        var asCount = 0;
        // need to see how far away we'll move in frequency to set the waitToAutoscale value wdr
        let f = parseFloat(document.getElementById("freq").value,10) * 1000.0;
        if (!spectrum.checkFrequencyIsValid(f)) {
            return;
        }
        // If the Alt-button is active when clicking the Set button, round to nearest 1 kHz
        try {
          if (typeof window.isAlternateFreqActive === 'function' && window.isAlternateFreqActive()) {
            f = Math.round(f / 1000.0) * 1000.0;
            document.getElementById("freq").value = (f / 1000.0).toFixed(3);
          }
        } catch (e) {}
        stopDecrement();  // stop decrementing if runaway
        stopIncrement();  // stop incrementing if runaway
        let frequencyDifference = Math.abs(spectrum.frequency - f)
        if(frequencyDifference < 100000)
        {
          waitToAutoscale = false;  // No autoscale if we are within 100 kHz
        } else {
          waitToAutoscale = true;  // Autoscale if we are more than 100 kHz away
          if(frequencyDifference > 3000000)
            asCount = 0; // set the autoscale counter to 10 for frequencies greater than 3 MHz
          else
            asCount = 3; // set the autoscale counter to 17 between 100 kHz and 3 MHz
        }
        //console.log("setFrequencyW() f= ",f," waitToAutoscale=",waitToAutoscale,"freq diff = ",frequencyDifference, " asCount= ",asCount);
        ws.send("F:" + (f / 1000.0).toFixed(3));
        //document.getElementById("freq").value=document.getElementById('msg').value;
        //band.value=document.getElementById('msg').value;
        spectrum.setFrequency(f);
        updateCWMarker();
        spectrum.checkFrequencyAndClearOverlays(f);
        setModeBasedOnFrequencyIfAllowed(f);
        autoAutoscale(asCount,waitToAutoscale);
        saveSettings();
    }

    function setBand(freq) {
        //console.log("setBand() called with freq=",freq);
        var f = parseInt(freq);
        document.getElementById("freq").value = (freq / 1000.0).toFixed(3);
        if (!spectrum.checkFrequencyIsValid(f)) {
            return;
        }
        spectrum.setFrequency(f);
        updateCWMarker();
        spectrum.checkFrequencyAndClearOverlays(f);
        setModeBasedOnFrequencyIfAllowed(freq);
        ws.send("F:" + (freq / 1000).toFixed(3));
        autoAutoscale(0, true);  // wait for autoscale
        saveSettings();
    }

    function setModeBasedOnFrequencyIfAllowed(f) {
        // Set mode based on frequency
        //console.log("setModeBasedOnFrequencyIfAllowed() called with freq=",f," switchModesByFrequency=",switchModesByFrequency);
        if(switchModesByFrequency ) {
          if (f == 2500000 || f == 5000000 || f == 10000000 || f == 15000000 || f == 20000000 ||f == 25000000) {
              setMode('am');
          } else if (f == 3330000 || f == 7850000) {
              setMode('usb');
	  } else if (f >= 5330500 && f < 5406500) {
              setMode('usb');
	  } else if (f >= 26960000 && f < 27360000){
              setMode('am');
	  } else if (f >= 27360000 && f < 27410000){
              setMode('lsb');
          } else if (f < 10000000) {
              setMode('lsb');
          } else {
              setMode('usb');
          }
      }
    }

    function setMode(selected_mode) {
      // If QuickBW is active and the change is driven by frequency-based switching,
      // deactivate QuickBW and drop any saved edges so they won't be restored later.
      if (quickBWActive && switchModesByFrequency) {
        quickBWActive = false;
        quickBWPrevEdges = null;
        // inhibit any auto-sends while applying mode defaults
        suppressEdgeAutoSend = true;
        try { updateQuickBWButtonState(); } catch (e) {}
      }

      document.getElementById('mode').value = selected_mode;
      ws.send("M:" + selected_mode);

      // Determine the new sample rate and number of channels based on the mode
      let newSampleRate = 12000;
      let newChannels = 1;

      if (selected_mode === "iq") {
          newChannels = 2; // Stereo for IQ mode
      } else {
          newChannels = 1; // Mono for other modes
      }

      if (selected_mode === "fm") {
          newSampleRate = 24000; // Higher sample rate for FM mode
      } else {
          newSampleRate = 12000; // Default sample rate for other modes
      }

      // Reinitialize the PCMPlayer with the new configuration
      player.destroy(); // Destroy the existing player instance
      player = new PCMPlayer({
          encoding: '16bitInt',
          channels: newChannels,
          sampleRate: newSampleRate,
          flushingTime: 250
      });
      // Set the player volume to match the slider after reinitializing
      const volumeSlider = document.getElementById('volume_control');
      if (volumeSlider) {
          setPlayerVolume(volumeSlider.value);
      }
      //console.log("setMode() selected_mode=", selected_mode, " newSampleRate=", newSampleRate, " newChannels=", newChannels);
      saveSettings();
  // Update filter edge inputs to sensible defaults for this mode
  setFilterEdgesForMode(selected_mode);
  // restore auto-send allowance (setFilterEdgesForMode already manages this flag,
  // but ensure it's false here in case we inhibited it above)
  suppressEdgeAutoSend = false;
  // Update QuickBW button state when mode changes programmatically
  try { updateQuickBWButtonState(); } catch (e) {}
  }

    function selectMode(mode) {
        let element = document.getElementById('mode');
        element.value = mode;
        ws.send("M:"+mode);
      setFilterEdgesForMode(mode);
      try { updateQuickBWButtonState(); } catch (e) {}
      saveSettings();
    }

    // Set filter input values according to mode defaults
    function setFilterEdgesForMode(mode) {
      const lowEl = document.getElementById('filterLowInput');
      const highEl = document.getElementById('filterHighInput');
      if (!lowEl || !highEl) return;
  // Prevent auto-send while programmatically setting values
  suppressEdgeAutoSend = true;
      switch((mode||'').toLowerCase()) {
        case 'cwu':
        case 'cwl':
          lowEl.value = -200;
          highEl.value = 200;
          break;
        case 'usb':
          lowEl.value = 50;
          highEl.value = 3000;
          break;
        case 'lsb':
          lowEl.value = -3000;
          highEl.value = -50;
          break;
        case 'am':
        case 'sam':
          lowEl.value = -5000;
          highEl.value = 5000;
          break;
        case 'fm':
          lowEl.value = -6000;
          highEl.value = 6000;
          break;
        case 'iq':
          lowEl.value = -5000;
          highEl.value = 5000;
          break;
        default:
          // leave as-is
          break;
      }
      // re-enable auto-send after programmatic change
      suppressEdgeAutoSend = false;
  // programmatic change isn't manual typing
  edgeManualDirty = false;
  updateEdgeButtonState();
    }

    // When the user changes the filter inputs via the UI (spinner carets or keyboard arrows)
    // immediately send the new values to the backend. Programmatic changes are suppressed
    // by the `suppressEdgeAutoSend` flag declared earlier.
    let edgesListenersAttached = false;
    // Whether the user has manually typed values that require pressing the Edge button
    let edgeManualDirty = false;

    function updateEdgeButtonState() {
      try {
        const btn = document.getElementById('edge_button');
        if (!btn) return;
        if (edgeManualDirty) {
          btn.removeAttribute('disabled');
          btn.style.opacity = '';
        } else {
          btn.setAttribute('disabled','disabled');
          btn.style.opacity = '0.6';
        }
      } catch (e) {}
    }

    function attachEdgeInputListeners() {
      if (edgesListenersAttached) return;
      edgesListenersAttached = true;
      const lowEl = document.getElementById('filterLowInput');
      const highEl = document.getElementById('filterHighInput');
      if (!lowEl || !highEl) return;

      // Track the source of the last interaction so we can distinguish manual typing
      // (keyboard) from pointer-based changes (spinner buttons, mouse wheel).
      let lastEdgeInteraction = null; // 'pointer' | 'keyboard'

      // Pointer interactions (mouse/touch/spinner) — mark and send on input
      const pointerStart = function() {
        lastEdgeInteraction = 'pointer';
      };
      lowEl.addEventListener('pointerdown', pointerStart);
      highEl.addEventListener('pointerdown', pointerStart);
      // Clear pointer state on pointerup/cancel so continuous pointer actions are detected
      const pointerEnd = function() { lastEdgeInteraction = null; };
      lowEl.addEventListener('pointerup', pointerEnd);
      highEl.addEventListener('pointerup', pointerEnd);
      lowEl.addEventListener('pointercancel', pointerEnd);
      highEl.addEventListener('pointercancel', pointerEnd);
      // wheel events are pointer-like; keep pointer state for a short timeout after wheel
      let wheelTimer = null;
      const wheelHandler = function() {
        lastEdgeInteraction = 'pointer';
        if (wheelTimer) clearTimeout(wheelTimer);
        wheelTimer = setTimeout(() => { lastEdgeInteraction = null; wheelTimer = null; }, 200);
      };
      lowEl.addEventListener('wheel', wheelHandler);
      highEl.addEventListener('wheel', wheelHandler);

      // Keyboard interaction — mark as keyboard. Arrow keys still cause a send after update.
      const keyHandler = function(e) {
        lastEdgeInteraction = 'keyboard';
        // If the user presses arrow keys we still want immediate action (handled below).
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          if (suppressEdgeAutoSend) return;
          // allow the value to update then send
          setTimeout(() => {
            sendFilterEdges();
            // after auto-send, ensure manual dirty flag is cleared
            edgeManualDirty = false;
            updateEdgeButtonState();
          }, 0);
        }
      };
      lowEl.addEventListener('keydown', keyHandler);
      highEl.addEventListener('keydown', keyHandler);

      // Input handler: only auto-send when the last interaction was pointer (spinner/click/wheel).
      const inputHandler = function(e) {
        if (suppressEdgeAutoSend) return;
        if (lastEdgeInteraction === 'pointer') {
          sendFilterEdges();
          // pointer-based changes are auto-sent; ensure manual dirty flag is cleared
          edgeManualDirty = false;
          updateEdgeButtonState();
        } else if (lastEdgeInteraction === 'keyboard') {
          // user is typing digits manually -> require explicit press of Edge button
          edgeManualDirty = true;
          updateEdgeButtonState();
        }
        // do not immediately clear lastEdgeInteraction here; pointerEnd or wheel timeout will clear it
      };
      lowEl.addEventListener('input', inputHandler);
      highEl.addEventListener('input', inputHandler);
    }

    // Attach custom step behavior for filter edge inputs so up/down change by 100Hz
    // when magnitude >= 1000, but switch to 10Hz when moving from 1000 toward 0.
    (function attachFilterStepBehavior(){
      function byId(id){ return document.getElementById(id); }
      function parseVal(input){ const v = parseInt(input.value,10); return Number.isNaN(v) ? 0 : v; }
      function computeStep(v, dir){
        const abs = Math.abs(v);
        if(abs > 1000) return 100;
        if(abs < 1000) return 10;
        // abs == 1000 -> if moving toward zero use 10, otherwise 100
        if((v === 1000 && dir === -1) || (v === -1000 && dir === 1)) return 10;
        return 100;
      }
      function attach(id){
        const input = byId(id);
        if(!input) return;
        // Keyboard arrows: adjust value using computed step
        input.addEventListener('keydown', function(e){
          if(e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
          e.preventDefault();
          const dir = e.key === 'ArrowUp' ? 1 : -1;
          const v = parseVal(input);
          const step = computeStep(v, dir);
          input.value = String(v + dir * step);
          input.dispatchEvent(new Event('input', {bubbles:true}));
          input.dispatchEvent(new Event('change', {bubbles:true}));
        });

        // Pointerdown: set `step` appropriately so spinner clicks use the computed step
        input.addEventListener('pointerdown', function(e){
          try{
            const rect = input.getBoundingClientRect();
            const isTop = (e.clientY - rect.top) < (rect.height/2);
            const dir = isTop ? 1 : -1;
            const v = parseVal(input);
            input.step = computeStep(v, dir);
          }catch(err){ }
        }, {passive:true});

        function updateDefaultStep(){
          const v = parseVal(input);
          input.step = Math.abs(v) > 100 ? 100 : 10;
        }
        input.addEventListener('focus', updateDefaultStep);
        input.addEventListener('input', updateDefaultStep);
        updateDefaultStep();
      }

      // Try immediately, and also ensure attachment after DOM load
      attach('filterLowInput');
      attach('filterHighInput');
      if(!document.getElementById('filterLowInput')){
        document.addEventListener('DOMContentLoaded', function(){ attach('filterLowInput'); attach('filterHighInput'); });
      }
    })();

    function zoomin() {
      // Show warning if overlays are loaded
      if (spectrum && spectrum._overlayTraces && spectrum._overlayTraces.length > 0) {
        //alertOverlayMisalignment();
        spectrum.clearOverlayTrace();
      }
      ws.send("Z:+:"+document.getElementById('freq').value);
      //console.log("zoomed in from",document.getElementById("zoom_level").valueAsNumber);
      //console.log("zoomin(): ",document.getElementById('freq').value);
      //autoAutoscale(15,true);
      autoAutoscale(100,true);
      saveSettings();
      try { if (typeof window.showZoomBandwidthPopupForValue === 'function') window.showZoomBandwidthPopupForValue(document.getElementById('zoom_level').valueAsNumber); } catch (e) {}

    }

    function zoomout() {
      // Show warning if overlays are loaded
      if (spectrum && spectrum._overlayTraces && spectrum._overlayTraces.length > 0) {
        //alertOverlayMisalignment();
        spectrum.clearOverlayTrace();
      }
      ws.send("Z:-:"+document.getElementById('freq').value);
      //console.log("zoomed out from ",document.getElementById("zoom_level").valueAsNumber);
      //console.log("zoomout(): ",document.getElementById('freq').value);
      // autoAutoscale(15,true); // 15 for n0
      autoAutoscale(100,true);
      saveSettings();
      try { if (typeof window.showZoomBandwidthPopupForValue === 'function') window.showZoomBandwidthPopupForValue(document.getElementById('zoom_level').valueAsNumber); } catch (e) {}

    }

    function bumpAGCWithFM() {
      const originalMode = document.getElementById('mode').value; // Get the currently selected mode
      ws.send("M:fm"); // Switch to FM mode
      //console.log("Switched to FM mode");

      // Wait for 500 ms before switching back to the original mode
      setTimeout(() => {
        ws.send("M:" + originalMode); // Switch back to the original mode
        //console.log("Switched back to original mode: " + originalMode);
      }, 100); // 100 ms delay
    }

    function zoomcenter() {
      // Show warning if overlays are loaded
      if (spectrum && spectrum._overlayTraces && spectrum._overlayTraces.length > 0) {
        //alertOverlayMisalignment();
        spectrum.clearOverlayTrace();
      }
  // Send explicit center (kHz) so backend will center on the tuned frequency
  ws.send("Z:c:" + document.getElementById('freq').value);
      //console.log("zoom center at level ",document.getElementById("zoom_level").valueAsNumber);
      autoAutoscale(100,true);
      saveSettings();
    }

    function audioReporter(stats) {
    }

    function setZoom() {
      const v = document.getElementById("zoom_level").valueAsNumber;
      // Show warning if overlays are loaded
      if (spectrum && spectrum._overlayTraces && spectrum._overlayTraces.length > 0) {
        //alertOverlayMisalignment();
        spectrum.clearOverlayTrace();
      }
      ws.send(`Z:${v}`);
      //console.log("setZoom(): ",v,"zoomControlActive=",zoomControlActive);
      //if(!zoomControlActive)  // Mouse wheel turn on zoom control, autoscale - commented this out just let it autoscale when mouse wheel or drag zoom slider
      autoAutoscale(100,false);
      saveSettings();
    }

    // Show alert when overlays may be misaligned due to zoom/center changes
    function alertOverlayMisalignment() {
      alert("Warning: The loaded overlay traces may no longer align with the spectrum due to a zoom or center change. Clear traces (Clear Data in Options) to remove this warning.");
    }

    window.setZoomDuringTraceLoad = setZoomDuringTraceLoad;
    function setZoomDuringTraceLoad() {
      const v = document.getElementById("zoom_level").valueAsNumber;
      ws.send(`Z:${v}`);
      // No alert for overlay misalignment here
      autoAutoscale(100, false);
      saveSettings();
    }

    function zoomReleased()
    {
      zoomControlActive = false;
      autoAutoscale(0,true);  // we're letting it autoscale all the time, but run it a few times more
      //console.log("Zoom control is inactive");
    }

    let zoomControlActive = false;
    function zoomMouseDown() {
        zoomControlActive = true;
        //console.log("Zoom control is active");
    }

    function zoomMouseUp() {
        zoomControlActive = false;
        //console.log("Zoom control is inactive");
    }

    async function audio_start_stop()
    {
        var btn = document.getElementById("audio_button");
        if(btn.value==="START") {
          btn.value = "STOP";
          btn.innerHTML = "Stop Audio";
          ws.send("A:START:"+ssrc.toString());
          player.resume();
          // Ensure volume is set after resuming audio context
          const volumeSlider = document.getElementById('volume_control');
          if (volumeSlider) setPlayerVolume(volumeSlider.value);
        } else {
          btn.value = "START";
          btn.innerHTML = "Start Audio";
          ws.send("A:STOP:"+ssrc.toString());
        }
    }

function updateRangeValues(){
  //console.log("updateRangeValues() called", spectrum.wf_min_db, spectrum.wf_max_db, spectrum.min_db, spectrum.max_db);
  document.getElementById("waterfall_min").value = spectrum.wf_min_db;
  document.getElementById("waterfall_max").value = spectrum.wf_max_db;
  document.getElementById("waterfall_min_range").value = spectrum.wf_min_db;
  document.getElementById("waterfall_max_range").value = spectrum.wf_max_db;
  document.getElementById("spectrum_min").value = spectrum.min_db;
  document.getElementById("spectrum_max").value = spectrum.max_db;
  saveSettings();
}

function autoscaleButtonPush() {                      // autoscale button pressed, definitely do autoscale right away
  spectrum.forceAutoscale(100,false);
  //console.log("autoscaleButtonPush() called with start value 100");
  //pending_range_update = true;
}

function autoAutoscale(autoScaleCounterStart,waitToAutoscale = false) {     // Autoscale commanded by a change other than autoscale button press
  if (!onlyAutoscaleByButton) {
    spectrum.forceAutoscale(autoScaleCounterStart,waitToAutoscale);
    //pending_range_update = true;
  }
}

function baselineUp() {
  spectrum.baselineUp();
  document.getElementById("spectrum_min").value = spectrum.min_db;
  saveSettings();
}

function baselineDown() {
  spectrum.baselineDown();
  document.getElementById("spectrum_min").value = spectrum.min_db;
  saveSettings();
}

function rangeIncrease() {
  spectrum.rangeIncrease();
  updateRangeValues();
  saveSettings();
}

function rangeDecrease() {
  spectrum.rangeDecrease();
  updateRangeValues();
  saveSettings();
}

function setWaterfallMin() {
  spectrum.wf_min_db = document.getElementById("waterfall_min_range").value;
  //console.log("setWaterfallMin() called with value=",spectrum.wf_min_db);
  document.getElementById("waterfall_min").value = spectrum.wf_min_db;
  saveSettings();
}

function setWaterfallMax() {
  spectrum.wf_max_db = document.getElementById("waterfall_max_range").value;
  //console.log("setWaterfallMax() called with value=",spectrum.wf_max_db);
  document.getElementById("waterfall_max").value = spectrum.wf_max_db;
  saveSettings();
}

function setSpectrumMin() {
  spectrum.min_db = parseFloat(document.getElementById("spectrum_min").value);
  spectrum.setRange(spectrum.min_db, spectrum.max_db);
  saveSettings();
}

function setSpectrumMax() {
  spectrum.max_db = parseFloat(document.getElementById("spectrum_max").value);
  spectrum.setRange(spectrum.min_db, spectrum.max_db);
  saveSettings();
}

function adjustRange(element, event) {
  event.preventDefault(); // Prevent the default scroll behavior

  // Determine the step size based on the element's ID
  let step = 1; // Default step size
  if ((element.id === 'volume_control') || (element.id === 'panner_control')) {
    step = 0.1; // Step size for volume and panner control
  }

  const currentValue = parseFloat(element.value);
  //console.log(`Current value: ${currentValue}, Step: ${step}`);
  // Adjust the value based on scroll direction
  if (event.deltaY < 0) {
    // Scrolling up
    element.value = Math.min(currentValue + step, parseFloat(element.max));
  } else {
    // Scrolling down
    element.value = Math.max(currentValue - step, parseFloat(element.min));
  }

  // Trigger the input event to update the value
  const inputEvent = new Event('input');
  element.dispatchEvent(inputEvent);
}

function level_to_string(f) {
  let bin = spectrum.hz_to_bin(f);
  let s = "";
  if ((bin < 0) || (bin >= binCount)) {
    return;
  }

  let amp = -120.0;
  if ((spectrum.averaging > 0) && (typeof spectrum.binsAverage !== 'undefined') && (spectrum.binsAverage.length > 0)) {
    amp = spectrum.binsAverage[bin];
  } else if (spectrum.bin_copy && spectrum.bin_copy.length > bin) {
    amp = spectrum.bin_copy[bin];
  }

  f /= 1e6;
  // Only call toFixed if amp is a finite number
  if (typeof amp === 'number' && isFinite(amp)) {
    s = f.toFixed(6) + " MHz: " + amp.toFixed(1) + " dBm";
  } else {
    s = f.toFixed(6) + " MHz: N/A dBm";
  }
  return s;
}

function formatUptimeDHMS(seconds) {
    seconds = Math.floor(seconds);
    const days = Math.floor(seconds / 86400);
    seconds = seconds % 86400;
    const hours = Math.floor(seconds / 3600);
    seconds = seconds % 3600;
    const minutes = Math.floor(seconds / 60);
    seconds = seconds % 60;
    let str = "";
    if (days > 0) {
        str += days + "d ";
    }
    str += String(hours).padStart(2, '0') + ":"
        + String(minutes).padStart(2, '0') + ":"
        + String(seconds).padStart(2, '0');
    return str;
}

function update_stats() {
  if (spectrum.paused)
    return;

    // GPS time isn't UTC; it started at Sunday January 6, 1980 at 00:00:00 UTC and there have been 18 UTC leap seconds since
  var t = Number(gps_time) / 1e9;
  t+=315964800;
  t-=18;
  var smp = Number(input_samples) / Number(input_samprate);

  // Compute filter bandwidth
  const bw = Math.abs(filter_high - filter_low);

  computeSUnits(power,spectrum.maxHold);
  // Update the signal bar meter and get the noise power, since it computes it
  var noisePower = updateSMeter(power,noise_density_audio,bw,spectrum.maxHold);

  document.getElementById('gps_time').innerHTML = (new Date(t * 1000)).toTimeString();
  //document.getElementById('adc_samples').innerHTML = "ADC samples: " + (Number(input_samples) / 1e9).toFixed(3) + " G";
  document.getElementById('adc_samp_rate').innerHTML = "Fs in: " + (input_samprate / 1e6).toFixed(3) + " MHz";
  document.getElementById('adc_overs').innerHTML = "Overranges: " + ad_over.toLocaleString();
  let seconds_since_over = Number(samples_since_over) / Number(input_samprate);
  document.getElementById('adc_last_over').innerHTML = "Last overrange: " + formatUptimeDHMS(Number(seconds_since_over));
  document.getElementById('uptime').innerHTML = "Uptime: " + formatUptimeDHMS(smp);
  document.getElementById('rf_gain').innerHTML = "RF Gain: " + rf_gain.toFixed(1) + " dB";
  document.getElementById('rf_attn').innerHTML = "RF Atten: " + rf_atten.toFixed(1) + " dB";
  document.getElementById('rf_cal').innerHTML = "RF lev cal: " + rf_level_cal.toFixed(1) + " dB";
  document.getElementById('rf_agc').innerHTML = (rf_agc==1 ? "RF AGC: enabled" : "RF AGC: disabled");
  document.getElementById('if_power').innerHTML = "A/D: " + if_power.toFixed(1) + " dBFS";
  document.getElementById('noise_density').innerHTML = `N<sub>0</sub>: ${noise_density_audio.toFixed(1)} dBmJ, Noise power at BW ${bw.toLocaleString()}: ${noisePower.toFixed(1)} dBm`;
  document.getElementById('bins').textContent = `Bins: ${binCount.toLocaleString()}`;
  // Show bin width and zoom level
  let zoomLevel = '';
  try {
    const zoomElem = document.getElementById('zoom_level');
    if (zoomElem) {
      if (typeof zoomElem.value !== 'undefined' && zoomElem.value !== '') {
        zoomLevel = zoomElem.value;
      } else if (zoomElem.textContent && zoomElem.textContent.trim() !== '') {
        zoomLevel = zoomElem.textContent.trim();
      }
    }
  } catch (e) {
    // fallback to empty if any error
  }
  document.getElementById('hz_per_bin').textContent = `Bin width: ${binWidthHz.toLocaleString()} Hz` + (zoomLevel !== '' ? `, Zoom: ${zoomLevel}` : '');
  // Update the fft_avg_input value (number input)
  const fftAvgInput = document.getElementById('fft_avg_input');
  if (fftAvgInput) {
    fftAvgInput.value = spectrum.averaging;
  }
  // Update the spectrum_average_input value (number input)
  const spectrumAvgInputEl = document.getElementById('spectrum_average_input');
  if (spectrumAvgInputEl) {
    spectrumAvgInputEl.value = spectrum_average;
  }
  document.getElementById('decay').innerHTML = "Decay: " + spectrum.decay.toString();
  document.getElementById("rx_rate").textContent = `RX rate: ${((rx_rate / 1000.0) * 8.0).toFixed(0)} kbps`;
  if (typeof ssrc !== 'undefined') {
    document.getElementById('ssrc').innerHTML = "SSRC: " + ssrc.toString();
  }
  document.getElementById('version').innerHTML = "Version: v" + webserver_version;
  let bin = spectrum.hz_to_bin(spectrum.frequency);
  document.getElementById("cursor_data").textContent = "Tune: " + level_to_string(spectrum.frequency) + " @bin: " + bin.toLocaleString();
  // Use Math.round and .toLocaleString for centerHz to avoid floating-point artifacts
  const centerKHz = Math.round(centerHz) / 1000; // rounds , then divides to get kHz
  document.getElementById("span").textContent = `Span (kHz): ${(lowHz / 1000.0).toLocaleString()} to ${(highHz / 1000.0).toLocaleString()} width: ${((highHz - lowHz)/1000).toLocaleString()} center: ${centerKHz.toLocaleString(undefined, {minimumFractionDigits: 3, maximumFractionDigits: 3})}`;

  // Show reordered info into ge_data left table column 1

  if(!spectrum.cursor_active)
    document.getElementById("ge_data").textContent = `Channel Frequency: ${(spectrum.frequency / 1e3).toLocaleString(3)} kHz | BW: ${Math.abs(filter_high - filter_low).toLocaleString(0)} Hz |`;
  else
  {
    document.getElementById("ge_data").textContent =  "Cursor: " + level_to_string(spectrum.cursor_freq) + " | ";
  }
    // print units in 3rd column
  document.getElementById("pwr_units").textContent = "dBm | Signal:";
  // Show power in 2nd column and S Units in 4th column from computeSUnits function
  return;
}
// --- FFT Averaging input box event handler ---
function setupFftAvgInput() {
  const fftAvgInput = document.getElementById('fft_avg_input');
  if (!fftAvgInput) return;
  // Set min/max if not already set
  fftAvgInput.min = 1;
  fftAvgInput.max = 50; // Set max to 50 for more flexibility
  // Set step to 1 for integer input
  fftAvgInput.step = 1;
  // Set initial value
  fftAvgInput.value = spectrum.averaging;
  // Listen for user changes immediately (caret, typing, etc)
  //console.log(setupFftAvgInput, " called with initial value: ", spectrum.averaging);
  fftAvgInput.addEventListener('input', function () {
    let val = parseInt(fftAvgInput.value, 10);
    //console.log("FFT averaging input changed to: ", val);
    if (isNaN(val) || val < 1) val = 1;
    if (val > fftAvgInput.max) val = fftAvgInput.max;
    if (val !== spectrum.averaging) {
      spectrum.averaging = val;
      if (typeof spectrum.setAveraging === 'function') {
        spectrum.setAveraging(val);
      }
      fftAvgInput.value = val; // Clamp value in UI
      //saveSettings();
      //console.log("FFT averaging set to: ", val);
    }
    //update_stats(); // Refresh UI
  });
}

// --- Spectrum Averaging input box event handler ---
function setupSpectrumAvgInput() {
  const el = document.getElementById('spectrum_average_input');
  if (!el) return;
  el.min = 1;
  el.max = 150;
  el.step = 1;
  el.value = spectrum_average;
  // Throttle backend sends only for repeated ArrowUp/ArrowDown interactions
  let lastSendTime = 0;
  let pendingSend = null;
  let sendTimer = null;
  const MIN_INTERVAL_MS = 333; // ~3 sends per second
  let arrowActive = false; // true while ArrowUp/Down are depressed (including autorepeat)

  function doSend(val) {
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send('g:' + val.toString());
      } else {
        pendingSpectrumAverage = { val: val, time: Date.now() };
      }
    } catch (e) { console.error('Failed to send spectrum average:', e); }
  }

  function scheduleSend(val) {
    const now = Date.now();
    const elapsed = now - lastSendTime;
    if (elapsed >= MIN_INTERVAL_MS && !sendTimer) {
      lastSendTime = now;
      doSend(val);
      pendingSend = null;
    } else {
      pendingSend = val;
      if (!sendTimer) {
        sendTimer = setTimeout(function () {
          sendTimer = null;
          if (pendingSend !== null) {
            lastSendTime = Date.now();
            doSend(pendingSend);
            pendingSend = null;
          }
        }, Math.max(0, MIN_INTERVAL_MS - elapsed));
      }
    }
  }

  el.addEventListener('input', function () {
    let val = parseInt(el.value, 10);
    if (isNaN(val) || val < 1) val = 1;
    if (val > el.max) val = el.max;
    if (val !== spectrum_average) {
      spectrum_average = val;
      // persist new setting
      saveSettings();
      // If user is using arrow keys, rate-limit; otherwise send immediately
      if (arrowActive) {
        scheduleSend(spectrum_average);
      } else {
        lastSendTime = Date.now();
        doSend(spectrum_average);
      }
    }
    el.value = val; // clamp in UI
  });

  // Track ArrowUp/ArrowDown key activity so holds are rate-limited
  el.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      arrowActive = true;
    }
  });

  // On keyup (anywhere) clear arrow state and ensure the latest value is sent
  document.addEventListener('keyup', function (e) {
    if (!arrowActive) return;
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    arrowActive = false;
    // flush pending send but still respect MIN_INTERVAL_MS
    if (pendingSend !== null) {
      const now = Date.now();
      const elapsed = now - lastSendTime;
      if (elapsed >= MIN_INTERVAL_MS && !sendTimer) {
        lastSendTime = now;
        doSend(pendingSend);
        pendingSend = null;
      } else if (!sendTimer) {
        sendTimer = setTimeout(function () {
          sendTimer = null;
          if (pendingSend !== null) {
            lastSendTime = Date.now();
            doSend(pendingSend);
            pendingSend = null;
          }
        }, Math.max(0, MIN_INTERVAL_MS - elapsed));
      }
    }
  });
}

async function getVersion() {
  const url = "version.json";
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Response status: ${response.status}`);
    }

    const json = await response.json();
    console.log("Webserver version reply: ", json);
    webserver_version = json.Version;
  } catch (error) {
    console.error(error.message);
  }
}

function buildCSV() {
   var t = Number(gps_time) / 1e9;
  t += 315964800;
  t -= 18;
  const smp = Number(input_samples) / Number(input_samprate);
  // Guard against BigInt/Number mixing for samples_since_over
  const lastOverSec = (Number(input_samprate) > 0) ? (Number(samples_since_over) / Number(input_samprate)).toFixed(3) : "0";
  const data = [
    ["description", `"${document.title}"`],
    ["gps_time", (new Date(t * 1000)).toTimeString()],
    ["adc_samples", (Number(input_samples)).toFixed(0)],
    ["adc_samp_rate", (input_samprate).toFixed(0)],
    ["adc_overs", ad_over.toString()],
    ["adc_last_over", lastOverSec],
    ["uptime", smp.toFixed(1)],
    ["rf_gain", rf_gain.toFixed(1)],
    ["rf_attn", rf_atten.toFixed(1)],
    ["rf_cal", rf_level_cal.toFixed(1)],
    ["rf_agc", rf_agc==1],
    ["if_power", if_power.toFixed(1)],
    ["noise_density audio", noise_density_audio.toFixed(1)],
    ["bins", binCount],
    ["bin_width", binWidthHz],
    ["blocks", blocks_since_last_poll.toString()],
    ["fft_avg", spectrum.averaging.toString()],
    ["decay", spectrum.decay.toString()],
    ["baseband_power", power.toFixed(1)],
    ["ssrc", ssrc.toString()],
    ["webserver_version", webserver_version.toString()],
    ["tune_hz", spectrum.frequency],
    ["tune_level", `"${level_to_string(spectrum.frequency)}"`],
    ["cursor_hz", spectrum.cursor_freq],
    ["cursor_level", `"${level_to_string(spectrum.cursor_freq)}"`],
    ["start_hz", lowHz],
    ["stop_hz", highHz],
    ["span_hz", spanHz],
    ["center_hz", centerHz],
    ["waterfall_width", document.getElementById('waterfall').width],
    ["filter_low", filter_low],
    ["filter_high", filter_high],
    ["notes", `"${document.getElementById('note_text').value}"`],
  ];

  var csvContent = data.map(row => row.join(",")).join("\n");

  csvContent += "\n\nBin, Amplitude (dB?), Average (dB?), Max hold (dB?), Min hold (dB?)\n";
  for(let i = 0; i < binCount; i++) {
    let b = (typeof spectrum.bin_copy !== 'undefined') ? spectrum.bin_copy[i].toFixed(3) : "";
    let a = (typeof spectrum.binsAverage !== 'undefined') ? spectrum.binsAverage[i].toFixed(3) : "";
    let m = (typeof spectrum.binsMax !== 'undefined') ? spectrum.binsMax[i].toFixed(3) : "";
    let n = (typeof spectrum.binsMin !== 'undefined') ? spectrum.binsMin[i].toFixed(3) : "";
    csvContent += `${i}, ${b}, ${a}, ${m}, ${n}\n`;
  }
  return csvContent
}

function dumpCSV() {
  var csvFile = "data:text/csv;charset=utf-8," + buildCSV();

  const d = new Date();
  // Format as HH_MM_SS (no fractional seconds)
  const pad = n => String(n).padStart(2, '0');
  const timestring = `${pad(d.getHours())}_${pad(d.getMinutes())}_${pad(d.getSeconds())}`;

  var encodedUri = encodeURI(csvFile);
  var link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", `info_${timestring}.csv`);
  document.body.appendChild(link);
  link.click();
  dumpHTML();
}

function buildScreenshot() {
  const c = document.getElementById("waterfall");
  const i = c.toDataURL();
  const stat = document.getElementById("stat_div").innerHTML.replace(/(\r\n|\n|\r)/gm, "");
  const note = `${document.getElementById('note_text').value}`;
  var htmlContent =
    `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${document.title}</title>
</head>
<body>
  <h1 id="heading">${document.title}</h1>
  <canvas id="waterfall" tabindex="1"></canvas>
  <div id="stat_div"></div>
  <div id="note_div"><textarea id="note_text" class="no-scrollbars"></textarea></div>
  <script>
  window.addEventListener("load", function(){
  const screenshot = "${i.toString()}";
  const canvas = document.getElementById('waterfall');
  canvas.width = ${c.width};
  canvas.height = ${c.height};
  const ctx = canvas.getContext('2d');
  const myImage = new Image();
  myImage.src = screenshot;

  document.getElementById("stat_div").innerHTML = '${stat.toString()}';
  document.getElementById("note_text").value = \`${note}\`;

  myImage.onload = function() {
    ctx.drawImage(myImage, 0, 0);
    }
});

  </script>
  </body>
</html>
`;
  return htmlContent;
}

function dumpHTML() {
  const htmlFile = "data:text/html;charset=utf-8," + buildScreenshot();
  const d = new Date();
  // Format as HH_MM_SS (no fractional seconds)
  const pad = n => String(n).padStart(2, '0');
  const timestring = `${pad(d.getHours())}_${pad(d.getMinutes())}_${pad(d.getSeconds())}`;
  const encodedUri = encodeURI(htmlFile);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", `info_${timestring}.html`);
  document.body.appendChild(link);
  link.click();
}

let settingsReady = false; // Block saves until after settings are loaded and UI is initialized
let frequencyMemoriesInitialized = false;
function saveSettings() {
  if (!settingsReady) return; // Prevent saves during initialization
  localStorage.setItem("tune_hz", spectrum.frequency.toString());
  localStorage.setItem("zoom_level", document.getElementById("zoom_level").valueAsNumber);
  localStorage.setItem("min_db", spectrum.min_db.toString())
  localStorage.setItem("max_db", spectrum.max_db.toString())
  localStorage.setItem("graticuleIncrement", spectrum.graticuleIncrement.toString())
  localStorage.setItem("wf_min_db", spectrum.wf_min_db.toString())
  localStorage.setItem("wf_max_db", spectrum.wf_max_db.toString())
  localStorage.setItem("spectrum_percent", spectrum.spectrumPercent.toString());
  localStorage.setItem("spectrum_center_hz", spectrum.centerHz.toString());
  localStorage.setItem("averaging", spectrum.averaging.toString());
  localStorage.setItem("spectrum_average", spectrum_average.toString());
  localStorage.setItem("maxHold", spectrum.maxHold.toString());
  localStorage.setItem("paused", spectrum.paused.toString());
  localStorage.setItem("decay", spectrum.decay.toString());
  localStorage.setItem("cursor_active", spectrum.cursor_active.toString());
  localStorage.setItem("preset", document.getElementById("mode").value);
  localStorage.setItem("step", document.getElementById("step").value.toString());
  localStorage.setItem("colorIndex", document.getElementById("colormap").value.toString());
  localStorage.setItem("meterIndex", document.getElementById("meter").value.toString());
  localStorage.setItem("cursor_freq", spectrum.cursor_freq.toString());
  localStorage.setItem("check_max", document.getElementById("check_max").checked.toString());
  localStorage.setItem("check_min", document.getElementById("check_min").checked.toString());
  localStorage.setItem("switchModesByFrequency", document.getElementById("cksbFrequency").checked.toString());
  localStorage.setItem("onlyAutoscaleByButton", document.getElementById("ckonlyAutoscaleButton").checked.toString());
  localStorage.setItem("enableAnalogSMeter",enableAnalogSMeter);
  localStorage.setItem("enableBandEdges", enableBandEdges);
  var volumeControlNumber = document.getElementById("volume_control").valueAsNumber;
  //console.log("Saving volume control: ", volumeControl);
  localStorage.setItem("volume_control", volumeControlNumber);
}

function checkMaxMinChanged(){  // Save the check boxes for show max and min
  saveSettings();
}

function setDefaultSettings(writeToStorage = true) {
  if (writeToStorage) console.log("Setting default settings");
  spectrum.averaging = 10;
  spectrum.frequency = 10000000;
  frequencyHz = 10000000;
  target_frequency = 10000000;
  spectrum.min_db = -115;
  document.getElementById("spectrum_min").value = spectrum.min_db;
  spectrum.max_db = -35;
  document.getElementById("spectrum_max").value = spectrum.max_db;
  spectrum.wf_min_db = -115;
  spectrum.graticuleIncrement = 10;
  document.getElementById("waterfall_min").value = spectrum.wf_min_db;
  spectrum.wf_max_db = -35;
  document.getElementById("waterfall_max").value = spectrum.wf_max_db;
  spectrum.spectrumPercent = 65;
  spectrum.centerHz = 10000000;
  centerHz = spectrum.centerHz;
  target_center = centerHz;
  spectrum.maxHold = true;
  document.getElementById("max_hold").checked = spectrum.maxHold;
  spectrum.paused = false;
  spectrum.decay = 1;
  spectrum.cursor_active = false;
  document.getElementById("mode").value = "am";
  // Keep target_preset in sync with the UI default mode
  target_preset = document.getElementById("mode").value;
  increment = 1000;
  document.getElementById("colormap").value = 9;
  spectrum.colorIndex = 9;
  document.getElementById("meter").value = 0;
  meterType = 0;
  document.getElementById("zoom_level").value =6;
  target_zoom_level = 6;
  spectrum.cursor_freq = 10000000;
  spectrum.check_max = false;
  spectrum.check_min = false;
  // Ensure the DOM checkboxes match the spectrum defaults
  try {
    const elCheckMax = document.getElementById("check_max");
    if (elCheckMax) elCheckMax.checked = false;
  } catch (e) {}
  try {
    const elCheckMin = document.getElementById("check_min");
    if (elCheckMin) elCheckMin.checked = false;
  } catch (e) {}
  switchModesByFrequency = true;
  document.getElementById("cksbFrequency").checked = switchModesByFrequency;
  onlyAutoscaleByButton = false;
  document.getElementById("ckonlyAutoscaleButton").checked = false;
  enableAnalogSMeter = true; // Default to analog S-Meter on
  document.getElementById("ckAnalogSMeter").checked = enableAnalogSMeter;
  setAnalogMeterVisible(enableAnalogSMeter); // Set the visibility of the analog S-Meter based on the default setting
  enableBandEdges = false; // Default to not show band edges
  var beEl = document.getElementById('ckShowBandEdges');
  if (beEl) beEl.checked = enableBandEdges;
  const MEMORY_KEY = 'frequency_memories';
  // Use 50 entries to match the memories subsystem expectations
  // Each memory is an object: { freq: string, desc: string, mode: string }
  let memories = Array.from({ length: 50 }, (_, i) => ({ freq: "", desc: "", mode: "" }));
  // Initialize memory 0 to WWV10 @ 10,000 kHz AM (10000000 Hz) when creating defaults
  memories[0] = { freq: "10000000", desc: "WWV 10MHz", mode: "am" };
  if (writeToStorage) {
    try { localStorage.setItem(MEMORY_KEY, JSON.stringify(memories)); } catch (e) {}
    try { localStorage.setItem("volume_control", 1.0); } catch (e) {}
    try { setPlayerVolume(1.0); } catch (e) {}
    try { document.getElementById("volume_control").value = 1.0; } catch (e) {}
    try { saveQuickBWPreset(); } catch (e) {}
  } else {
    // still set in-memory default for player volume and DOM
    try { setPlayerVolume(1.0); } catch (e) {}
    try { document.getElementById("volume_control").value = 1.0; } catch (e) {}
  }
  // If requested, also persist all the other UI/spectrum defaults so localStorage
  // contains the full set that `saveSettings()` expects.
  if (writeToStorage) {
    try { localStorage.setItem("tune_hz", spectrum.frequency.toString()); } catch (e) {}
    try { localStorage.setItem("zoom_level", document.getElementById("zoom_level").value.toString()); } catch (e) {}
    try { localStorage.setItem("min_db", spectrum.min_db.toString()); } catch (e) {}
    try { localStorage.setItem("max_db", spectrum.max_db.toString()); } catch (e) {}
    try { localStorage.setItem("graticuleIncrement", spectrum.graticuleIncrement.toString()); } catch (e) {}
    try { localStorage.setItem("wf_min_db", spectrum.wf_min_db.toString()); } catch (e) {}
    try { localStorage.setItem("wf_max_db", spectrum.wf_max_db.toString()); } catch (e) {}
    try { localStorage.setItem("spectrum_percent", spectrum.spectrumPercent.toString()); } catch (e) {}
    try { localStorage.setItem("spectrum_center_hz", spectrum.centerHz.toString()); } catch (e) {}
    try { localStorage.setItem("averaging", spectrum.averaging.toString()); } catch (e) {}
    try { localStorage.setItem("maxHold", spectrum.maxHold.toString()); } catch (e) {}
    try { localStorage.setItem("paused", spectrum.paused.toString()); } catch (e) {}
    try { localStorage.setItem("decay", spectrum.decay.toString()); } catch (e) {}
    try { localStorage.setItem("cursor_active", spectrum.cursor_active.toString()); } catch (e) {}
    try { localStorage.setItem("preset", document.getElementById("mode").value); } catch (e) {}
    try { localStorage.setItem("step", document.getElementById("step").value.toString()); } catch (e) {}
    try { localStorage.setItem("colorIndex", document.getElementById("colormap").value.toString()); } catch (e) {}
    try { localStorage.setItem("meterIndex", document.getElementById("meter").value.toString()); } catch (e) {}
    try { localStorage.setItem("cursor_freq", spectrum.cursor_freq.toString()); } catch (e) {}
    try { localStorage.setItem("check_max", (document.getElementById("check_max") && document.getElementById("check_max").checked) ? "true" : "false"); } catch (e) {}
    try { localStorage.setItem("check_min", (document.getElementById("check_min") && document.getElementById("check_min").checked) ? "true" : "false"); } catch (e) {}
    try { localStorage.setItem("switchModesByFrequency", (document.getElementById("cksbFrequency") && document.getElementById("cksbFrequency").checked) ? "true" : "false"); } catch (e) {}
    try { localStorage.setItem("onlyAutoscaleByButton", (document.getElementById("ckonlyAutoscaleButton") && document.getElementById("ckonlyAutoscaleButton").checked) ? "true" : "false"); } catch (e) {}
    try { localStorage.setItem("enableAnalogSMeter", enableAnalogSMeter ? "true" : "false"); } catch (e) {}
    try { localStorage.setItem("enableBandEdges", enableBandEdges ? "true" : "false"); } catch (e) {}
  }
}

function loadSettings() {
  try { console.log(`localStorage.length = ${localStorage.length}`); } catch (e) {}
  if (typeof localStorage === 'undefined') return false;
  try { if (localStorage.length === 0) return false; } catch (e) {}

  const getLS = (k, parser, fallback) => {
    try {
      const v = localStorage.getItem(k);
      if (v === null || v === undefined) return fallback;
      return parser ? parser(v) : v;
    } catch (e) {
      return fallback;
    }
  };

  spectrum.averaging = getLS("averaging", v => parseInt(v, 10), spectrum.averaging);
  spectrum_average = getLS("spectrum_average", v => parseInt(v, 10), spectrum_average);
  const tune = getLS("tune_hz", v => parseFloat(v), spectrum.frequency);
  spectrum.frequency = tune;
  frequencyHz = tune;
  target_frequency = frequencyHz;

  spectrum.min_db = getLS("min_db", v => parseFloat(v), spectrum.min_db);
  try { document.getElementById("spectrum_min").value = spectrum.min_db; } catch (e) {}

  spectrum.max_db = getLS("max_db", v => parseFloat(v), spectrum.max_db);
  try { document.getElementById("spectrum_max").value = spectrum.max_db; } catch (e) {}

  spectrum.wf_min_db = getLS("wf_min_db", v => parseFloat(v), spectrum.wf_min_db);
  spectrum.graticuleIncrement = getLS("graticuleIncrement", v => parseFloat(v), spectrum.graticuleIncrement);
  try { document.getElementById("waterfall_min").value = spectrum.wf_min_db; } catch (e) {}

  spectrum.wf_max_db = getLS("wf_max_db", v => parseFloat(v), spectrum.wf_max_db);
  try { document.getElementById("waterfall_max").value = spectrum.wf_max_db; } catch (e) {}

  // waterfall bias: how much to bias waterfall autoscale floor/ceiling (persisted)
  spectrum.waterfallBias = getLS("waterfallBias", v => parseFloat(v), (typeof spectrum.waterfallBias !== 'undefined' ? spectrum.waterfallBias : 5));
  try { document.getElementById("waterfallBiasInput").value = spectrum.waterfallBias; } catch (e) {}

  spectrum.spectrumPercent = getLS("spectrum_percent", v => parseFloat(v), spectrum.spectrumPercent);
  spectrum.centerHz = getLS("spectrum_center_hz", v => parseFloat(v), spectrum.centerHz);
  centerHz = spectrum.centerHz;
  target_center = centerHz;

  spectrum.maxHold = getLS("maxHold", v => (v === "true"), spectrum.maxHold);
  try { document.getElementById("max_hold").checked = spectrum.maxHold; } catch (e) {}

  spectrum.paused = getLS("paused", v => (v === "true"), spectrum.paused);
  spectrum.decay = getLS("decay", v => parseFloat(v), spectrum.decay);
  spectrum.cursor_active = getLS("cursor_active", v => (v === "true"), spectrum.cursor_active);

  const preset = getLS("preset", v => v, null);
  if (preset !== null) {
    try { document.getElementById("mode").value = preset; } catch (e) {}
    target_preset = preset;
  }

  increment = getLS("step", v => parseFloat(v), increment);

  const colorIndex = getLS("colorIndex", v => parseInt(v, 10), spectrum.colorIndex);
  try { document.getElementById("colormap").value = colorIndex; } catch (e) {}
  spectrum.colorIndex = colorIndex;

  const meterIndex = getLS("meterIndex", v => parseInt(v, 10), meterType);
  try { document.getElementById("meter").value = meterIndex; } catch (e) {}
  meterType = meterIndex;

  const zoomLv = getLS("zoom_level", v => parseInt(v, 10), target_zoom_level);
  try { document.getElementById("zoom_level").value = zoomLv; } catch (e) {}
  target_zoom_level = zoomLv;

  spectrum.cursor_freq = getLS("cursor_freq", v => parseFloat(v), spectrum.cursor_freq);

  const elCheckMax = document.getElementById("check_max");
  const ckMaxVal = getLS("check_max", v => (v === "true"), spectrum.check_max);
  spectrum.check_max = ckMaxVal;
  if (elCheckMax) elCheckMax.checked = ckMaxVal;

  const elCheckMin = document.getElementById("check_min");
  const ckMinVal = getLS("check_min", v => (v === "true"), spectrum.check_min);
  spectrum.check_min = ckMinVal;
  if (elCheckMin) elCheckMin.checked = ckMinVal;

  switchModesByFrequency = getLS("switchModesByFrequency", v => (v === "true"), switchModesByFrequency);
  try { document.getElementById("cksbFrequency").checked = switchModesByFrequency; } catch (e) {}

  onlyAutoscaleByButton = getLS("onlyAutoscaleByButton", v => (v === "true"), onlyAutoscaleByButton);
  try { document.getElementById("ckonlyAutoscaleButton").checked = onlyAutoscaleByButton; } catch (e) {}

  enableAnalogSMeter = getLS("enableAnalogSMeter", v => (v === "true"), enableAnalogSMeter);
  try { document.getElementById("ckAnalogSMeter").checked = enableAnalogSMeter; } catch (e) {}
  setAnalogMeterVisible(enableAnalogSMeter);

  enableBandEdges = getLS("enableBandEdges", v => (v === "true"), enableBandEdges);
  try { const beEl = document.getElementById('ckShowBandEdges'); if (beEl) beEl.checked = enableBandEdges; } catch (e) {}
  if (typeof spectrum !== 'undefined' && spectrum) {
    spectrum.showBandEdges = enableBandEdges;
    spectrum.updateAxes();
    // ensure UI reflects loaded spectrum average
    try { const sa = document.getElementById('spectrum_average_input'); if (sa) sa.value = spectrum_average; } catch (e) {}
  }

  const vc = getLS("volume_control", v => parseFloat(v), null);
  if (vc !== null && !isNaN(vc)) {
    try { document.getElementById("volume_control").value = vc; } catch (e) {}
    setPlayerVolume(vc);
  }

  // Ensure frequency memories exist in localStorage; create defaults if missing
  try {
    const MEMORY_KEY = 'frequency_memories';
    let mem = null;
    try { mem = localStorage.getItem(MEMORY_KEY); } catch (e) { mem = null; }
    if (mem === null) {
      const defaultMemories = Array.from({ length: 50 }, (_, i) => ({ freq: "", desc: "", mode: "" }));
      defaultMemories[0] = { freq: "10000000", desc: "WWV 10MHz", mode: "am" };
      try { localStorage.setItem(MEMORY_KEY, JSON.stringify(defaultMemories)); frequencyMemoriesInitialized = true; } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }

  return true;
}

// Diagnostic: check for expected localStorage keys and optionally alert the user
function diagnosticCheckSettings(showAlert = true) {
  if (typeof localStorage === 'undefined') return;
  const expected = [
    "tune_hz","zoom_level","min_db","max_db","graticuleIncrement",
    "wf_min_db","wf_max_db","spectrum_percent","spectrum_center_hz",
    "averaging","maxHold","paused","decay","cursor_active",
    "preset","step","colorIndex","meterIndex","cursor_freq",
    "check_max","check_min","switchModesByFrequency","onlyAutoscaleByButton",
    "enableAnalogSMeter","enableBandEdges","volume_control","frequency_memories"
  ];
  const missing = expected.filter(k => {
    try { return localStorage.getItem(k) === null; } catch (e) { return true; }
  });
  // Special validation for frequency_memories: ensure it's a JSON array of length >=50
  try {
    const memRaw = localStorage.getItem('frequency_memories');
    let memInvalid = false;
    if (memRaw === null) {
      memInvalid = true;
    } else {
      try {
        const memParsed = JSON.parse(memRaw);
        if (!Array.isArray(memParsed) || memParsed.length < 50) memInvalid = true;
        else {
          // Check memory 0 has expected default values (or at least populated)
          const m0 = memParsed[0];
          if (!m0 || typeof m0.freq !== 'string' || m0.freq.trim() === '') memInvalid = true;
        }
      } catch (e) { memInvalid = true; }
    }
    if (memInvalid) missing.push('frequency_memories (invalid)');
    // If loadSettings created the memories this run, report that as well
    try { if (frequencyMemoriesInitialized) missing.push('frequency_memories (created)'); } catch (e) {}
  } catch (e) { /* ignore */ }
  if (missing.length > 0) {
    const msg = `Missing settings keys: ${missing.join(', ')}. Defaults initialized and will be used for this session.`;
    console.warn(msg);
    if (showAlert) {
      const toast = document.createElement('div');
      toast.id = 'settings_diag_toast';
      toast.textContent = msg;
      Object.assign(toast.style, {
        position: 'fixed',
        right: '12px',
        bottom: '12px',
        background: 'rgba(0,0,0,0.8)',
        color: '#fff',
        padding: '10px 14px',
        borderRadius: '6px',
        zIndex: 99999,
        fontSize: '13px',
        maxWidth: '420px',
        boxShadow: '0 2px 8px rgba(0,0,0,0.5)'
      });
      document.body.appendChild(toast);
      setTimeout(() => {
        try { document.body.removeChild(toast); } catch (e) {}
      }, 5000);
    }
    return false;
  }
  // No missing keys — be quiet (no toast).
  return true;
}

var rx_bytes = 0;
var last_rx_interval = Date.now();
var rx_rate = 0;
function rx(x) {
  rx_bytes += x;
  const t = Date.now();
  if ((t - last_rx_interval) > (2 * 1000)) {
    rx_rate = (rx_bytes / (t - last_rx_interval)) * 1000.0;
    rx_bytes = 0;
    last_rx_interval = t;
  }
}

// --- Band Options: must be defined before use ---
const bandOptions = {
    amateur: [
	{ label: "2200M", freq: 136750 },
	{ label: "630M", freq: 475500 },
        { label: "160M", freq: 1900000 },
        { label: "80M", freq: 3715000 },
        { label: "60Mch1", freq: 5330500 },
        { label: "60Mch2", freq: 5346500 },
        { label: "60M", freq: 5357000 },
        { label: "60Mch4", freq: 5371500 },
        { label: "60Mch5", freq: 5403500 },
        { label: "40M", freq: 7150000 },
        { label: "30M", freq: 10125000 },
        { label: "20M", freq: 14185000 },
        { label: "17M", freq: 18110000 },
        { label: "15M", freq: 21300000 },
        { label: "12M", freq: 24930000 },
        { label: "10M", freq: 28500000 },
	{ label: "6M",  freq: 50100000 }
    ],
    broadcast: [
        { label: "120M", freq:2397500 },
        { label: "90M", freq: 3300000 },
        { label: "75M", freq: 3950000 },
        { label: "60M", freq: 4905000 },
        { label: "49M", freq: 6050000 },
        { label: "41M", freq: 7375000 },
        { label: "31M", freq: 9650000 },
        { label: "25M", freq: 11850000 },
        { label: "22M", freq: 13720000 },
        { label: "19M", freq: 15450000 },
        { label: "16M", freq: 17690000 },
        { label: "15M", freq: 18960000 },
        { label: "13M", freq: 21650000 },
        { label: "11M", freq: 25850000 }
    ],
    utility: [
        { label: "CHU3330", freq: 3330000 },
        { label: "CHU7850", freq: 7850000 },
        { label: "CHU14.6", freq: 14670000 },
        { label: "WWV2.5", freq: 2500000 },
        { label: "WWV5", freq: 5000000 },
        { label: "WWV10", freq: 10000000 },
        { label: "WWV15", freq: 15000000 },
        { label: "WWV20", freq: 20000000 },
        { label: "WWV25", freq: 25000000 }
    ],
    cb: [
	{ label: "CB 1", freq: 26965000 },
	{ label: "CB 2", freq: 26975000 },
	{ label: "CB 3", freq: 26985000 },
	{ label: "CB 3A", freq: 26995000 },
	{ label: "CB 4", freq: 27005000 },
	{ label: "CB 5", freq: 27015000 },
	{ label: "CB 6", freq: 27025000 },
	{ label: "CB 7", freq: 27035000 },
	{ label: "CB 7A", freq: 27045000 },
	{ label: "CB 8", freq: 27055000 },
	{ label: "CB 9", freq: 27065000 },
	{ label: "CB 10", freq: 27075000 },
	{ label: "CB 11", freq: 27085000 },
	{ label: "CB 11A", freq: 27095000 },
	{ label: "CB 12", freq: 27105000 },
	{ label: "CB 13", freq: 27115000 },
	{ label: "CB 14", freq: 27125000 },
	{ label: "CB 15", freq: 27135000 },
	{ label: "CB 15A", freq: 27145000 },
	{ label: "CB 16", freq: 27155000 },
	{ label: "CB 17", freq: 27165000 },
	{ label: "CB 18", freq: 27175000 },
	{ label: "CB 19", freq: 27185000 },
	{ label: "CB 19A", freq: 27195000 },
	{ label: "CB 20", freq: 27205000 },
	{ label: "CB 21", freq: 27215000 },
	{ label: "CB 22", freq: 27225000 },
	{ label: "CB 23", freq: 27255000 },
	{ label: "CB 24", freq: 27235000 },
	{ label: "CB 25", freq: 27245000 },
	{ label: "CB 26", freq: 27265000 },
	{ label: "CB 27", freq: 27275000 },
	{ label: "CB 28", freq: 27285000 },
	{ label: "CB 29", freq: 27295000 },
	{ label: "CB 30", freq: 27305000 },
	{ label: "CB 31", freq: 27315000 },
	{ label: "CB 32", freq: 27325000 },
	{ label: "CB 33", freq: 27335000 },
	{ label: "CB 34", freq: 27345000 },
	{ label: "CB 35", freq: 27355000 },
	{ label: "CB 36", freq: 27365000 },
	{ label: "CB 37", freq: 27375000 },
	{ label: "CB 38", freq: 27385000 },
	{ label: "CB 39", freq: 27395000 },
	{ label: "CB 40", freq: 27405000 }
	]

};

// --- Ensure setAnalogMeterVisible is defined before use ---
function setAnalogMeterVisible(visible) {
    //console.log(`Setting analog S-Meter visibility to: ${visible}`);
    const analogBox = document.getElementById("analog_smeter_box");
    if (analogBox) {
        analogBox.style.display = visible ? "block" : "none";
    }
    // Also hide the canvas directly for safety (legacy)
    const meter = document.getElementById("sMeter");
    if (meter) {
        meter.style.display = visible ? "" : "none";
    }
    // Adjust the top table's margin-left based on S meter visibility
    const topTableDiv = document.querySelector('div[style*="justify-content: center"][style*="margin-top: 10px"]');
    if (topTableDiv) {
        if (visible) {
            topTableDiv.style.marginLeft = "0px"; //"-164px";
        } else {
            topTableDiv.style.marginLeft = "0px";
        }
    }
    enableAnalogSMeter = visible; // Update the global variable
    saveSettings();
}

// Ensure a global setShowBandEdges exists so inline onchange handlers won't fail
function setShowBandEdges(checked) {
  try {
    window.enableBandEdges = !!checked;
  } catch (e) {}
  try {
    enableBandEdges = !!checked;
  } catch (e) {}
  try {
    if (typeof spectrum !== 'undefined' && spectrum) {
      spectrum.showBandEdges = !!checked;
      spectrum.updateAxes();
      if (spectrum.bin_copy) spectrum.drawSpectrumWaterfall(spectrum.bin_copy, false);
    }
  } catch (e) {}
  try { localStorage.setItem('enableBandEdges', checked ? 'true' : 'false'); } catch (e) {}
  try { if (typeof saveSettings === 'function') saveSettings(); } catch (e) {}
}

// --- Frequency Memories logic: must be defined before use ---
(function() {
    const MEMORY_KEY = 'frequency_memories';
    // Each memory is now an object: { freq: string, desc: string, mode: string }
    let memories = Array(50).fill(null).map(() => ({ freq: '', desc: '', mode: '' }));

    function loadMemories() {
        const saved = localStorage.getItem(MEMORY_KEY);
        if (saved) {
            try {
                const arr = JSON.parse(saved);
                // Backward compatibility: upgrade from string array to object array
                if (Array.isArray(arr) && arr.length === 50) {
                    if (typeof arr[0] === 'string') {
                        memories = arr.map(f => ({ freq: f, desc: '', mode: '' }));
                    } else {
                        memories = arr.map(m => ({
                            freq: m.freq || '',
                            desc: m.desc || '',
                            mode: m.mode || ''
                        }));
                    }
                }
            } catch (e) {
                memories = Array(50).fill(null).map(() => ({ freq: '', desc: '', mode: '' }));
            }
        } else {
            memories = Array(50).fill(null).map(() => ({ freq: '', desc: '', mode: '' }));
        }
        window.memories = memories;
    }

    function saveMemories() {
        localStorage.setItem(MEMORY_KEY, JSON.stringify(memories));
        window.memories = memories;
    }

    function updateDropdownLabels() {
        const sel = document.getElementById('memory_select');
        if (!sel) return;
        if (sel.options.length !== 50) {
            sel.innerHTML = '';
            for (let i = 0; i < 50; i++) {
                const opt = document.createElement('option');
                opt.value = i;
                opt.textContent = `${i+1}: ---`;
                sel.appendChild(opt);
            }
        }
        // Determine the max width for frequency (e.g., 13 chars for extra padding)
        const PAD_WIDTH = 28;
        for (let i = 0; i < 50; i++) {
            const m = memories[i];
            let freqStr = m.freq ? m.freq : '---';
            // Pad freqStr with non-breaking spaces to PAD_WIDTH
            let padLen = Math.max(0, PAD_WIDTH - freqStr.length);
            let paddedFreq = freqStr + '\u00A0'.repeat(padLen);
            let label = m.freq ? `${i+1}: ${paddedFreq}` : `${i+1}: ---`;
            if (m.desc) label += ` (${m.desc})`;
            sel.options[i].text = label;
            sel.options[i].value = i; // Ensure value is always the index
        }
    }

    // Expose for import/export and UI
    window.memories = memories;
    window.loadMemories = loadMemories;
    window.saveMemories = saveMemories;
    window.updateDropdownLabels = updateDropdownLabels;
})();


// Event handlers for new Spectrum Options Dialog box



function initializeDialogEventListeners() {
  const optionsButton = document.getElementById('OptionsButton'); // The launch button
  const optionsDialog = document.getElementById('optionsDialog'); // The dialog box
  const dialogOverlay = document.getElementById('dialogOverlay'); // The overlay
  const closeButton = document.getElementById('closeXButton'); // The X close button

  // Ensure the elements exist before attaching event listeners
  if (!optionsButton || !optionsDialog || !dialogOverlay || !closeButton) {
    console.error('One or more elements are missing. Ensure optionsDialog.html is loaded correctly.');
    return;
  }

  // Open the options dialog
  optionsButton.addEventListener('click', function () {
    // Get the position of the launch button
    const buttonRect = optionsButton.getBoundingClientRect();

    // Position the dialog just below the launch button
    optionsDialog.style.position = 'absolute'; // Use absolute positioning
    optionsDialog.style.left = `${buttonRect.left + window.scrollX}px`; // Adjust for horizontal scrolling
    optionsDialog.style.top = `${buttonRect.bottom + window.scrollY + 10}px`; // Adjust for vertical scrolling and add 10px spacing below button
    optionsDialog.style.transform = 'none'; // Reset any transform applied by CSS

    // Show the dialog
    optionsDialog.classList.add('open');
    dialogOverlay.classList.add('open');

    // Setup the overlay buttons when the dialog is opened
    if (typeof spectrum !== 'undefined' && spectrum && typeof spectrum.setupOverlayButtons === 'function') {
      //console.log('Dialog opened, setting up overlay buttons');
      setTimeout(function() {
        spectrum.setupOverlayButtons();
      }, 50); // Small delay to ensure dialog is fully visible
    } else {
      console.warn('Spectrum not available when opening dialog');
    }
  });

  // Attach the event handler to the close button
  closeButton.addEventListener('click', function () {
    optionsDialog.classList.remove('open');
    dialogOverlay.classList.remove('open');
  });

  // Add event listeners to the checkboxes
  document.getElementById('cksbFrequency').addEventListener('change', function () {
    switchModesByFrequency = this.checked;
    saveSettings();
  });

  document.getElementById('ckonlyAutoscaleButton').addEventListener('change', function () {
    onlyAutoscaleByButton = this.checked;
    saveSettings();
  });

  // Make the dialog box draggable
  makeDialogDraggable(optionsDialog);
}

function makeDialogDraggable(dialog) {
  let isDragging = false;
  let offsetX, offsetY;

  dialog.addEventListener('mousedown', function (e) {
    // Prevent dragging if the target is the slider or any other interactive element
    if (e.target.id === 'panner_control') {
      return;
    }

    isDragging = true;
    offsetX = e.pageX - dialog.getBoundingClientRect().left - window.scrollX;
    offsetY = e.pageY - dialog.getBoundingClientRect().top - window.scrollY;
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });

  function onMouseMove(e) {
    if (isDragging) {
      dialog.style.left = `${e.pageX - offsetX}px`;
      dialog.style.top = `${e.pageY - offsetY}px`;
    }
  }

  function onMouseUp() {
    isDragging = false;
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  }
}

function setPlayerVolume(value) {
    // Map slider value [0,1] to gain [0,3] using a perceptual (log-like) curve
    // Use exponent for perceptual mapping (2.5 is a good start)
    const minGain = 0;
    const maxGain = 4;  // 4 is about the maximum gain that prevents clipping during recording on an SSB signal
    const exponent = 2.5;
    const slider = parseFloat(value);
    const gain = minGain + (maxGain - minGain) * Math.pow(slider, exponent);
    player.volume(gain);
    //console.log(`Volume set to: ${gain} (slider: ${slider})`);
  }

  function setPanner(value) {
    if (typeof player !== 'undefined' && typeof player.pan === 'function') {
        player.pan(parseFloat(value)); // Update the panner value
    } else {
        console.error('Player or pan function is not defined.');
    }
}

let isRecording = false;
function toggleAudioRecording() {
    if (!player) {
        console.error("Player object is not initialized.");
        return;
    }

    // Check if the audio is currently stopped
    const audioButton = document.getElementById("audio_button");
    if (audioButton && audioButton.value === "START") {
      console.error("Cannot start recording because audio is not running.");
      alert("Please start the audio before recording.");
      return;
    }

    if (isRecording) {
      const currentFrequency = frequencyHz / 1000.0; // Convert frequency to kHz
      const currentMode = document.getElementById('mode').value; // Get the current mode
      player.stopRecording(currentFrequency, currentMode); // Pass frequency and mode
      document.getElementById('toggleRecording').innerText = 'Record';
  } else {
      player.startRecording();
      document.getElementById('toggleRecording').innerText = 'Stop Recording';
  }

    isRecording = !isRecording;
}

function getZoomTableSize() {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject("WebSocket is not open");
      return;
    }

    // Send the command to get the zoom table size
    ws.send("Z:SIZE");

    let timeoutId = null;

    // Temporary event listener for the ZSIZE response
    function handleZoomTableSize(event) {
      try {
        if (typeof event.data === "string" && event.data.startsWith("ZSIZE:")) {
          const size = parseInt(event.data.split(":")[1], 10);
          ws.removeEventListener("message", handleZoomTableSize);
          if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
          resolve(size);
        }
      } catch (e) {
        // ignore parse errors and keep waiting until timeout
      }
    }

    // Add the temporary event listener
    ws.addEventListener("message", handleZoomTableSize);

    // Handle errors — remove listener and reject once
    const errorHandler = function (error) {
      ws.removeEventListener("message", handleZoomTableSize);
      if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
      reject("WebSocket error: " + error);
    };
    ws.addEventListener("error", errorHandler, { once: true });

    // Timeout: clean up if server doesn't reply in reasonable time
    timeoutId = setTimeout(() => {
      try { ws.removeEventListener("message", handleZoomTableSize); } catch (e) {}
      try { ws.removeEventListener("error", errorHandler); } catch (e) {}
      reject("getZoomTableSize: timeout waiting for ZSIZE response");
    }, 3000);
  });
}

async function fetchZoomTableSize() {
    try {
        const size = await getZoomTableSize(); // Fetch the zoom table size
        zoomTableSize = size; // Store it in the global variable
        //console.log("Zoom table size fetched and stored:", zoomTableSize);

        // Update the max attribute of the zoom_level range control
        const zoomLevelControl = document.getElementById("zoom_level");
        if (zoomLevelControl) {
            zoomLevelControl.max = zoomTableSize - 1; // Set max to table size - 1
        }

        return size; // Return the size for further use if needed
    } catch (error) {
        console.error("Error fetching zoom table size:", error);
        return null; // Return null if there was an error
    }
}

// --- Zoom Table: Expose to global scope ---
// Example: window.zoomTable = [ { index: 0, value: 0, label: 'Zoom 0' }, ... ]
// If already present, skip this block. Otherwise, define it here or fetch from DOM/JS.
// --- Hardcoded zoom table to match ka9q-web.c ---
// This must be available before overlays or zoom logic is used
window.zoomTable = [
  { bin_width: 100000, bin_count: 1620 },
  { bin_width: 80000, bin_count: 1620 },
  { bin_width: 50000, bin_count: 1620 },
  { bin_width: 40000, bin_count: 1620 },
  { bin_width: 20000, bin_count: 1620 },
  { bin_width: 10000, bin_count: 1620 },
  { bin_width: 8000, bin_count: 1620 },
  { bin_width: 5000, bin_count: 1620 },
  { bin_width: 4000, bin_count: 1620 },
  { bin_width: 2000, bin_count: 1620 },
  { bin_width: 1000, bin_count: 1620 },
  { bin_width: 800, bin_count: 1620 },
  { bin_width: 500, bin_count: 1620 },
  { bin_width: 400, bin_count: 1620 },
  { bin_width: 200, bin_count: 1620 },
  { bin_width: 100, bin_count: 1620 },
  { bin_width: 80, bin_count: 1620 },
  { bin_width: 50, bin_count: 1620 },
  { bin_width: 40, bin_count: 1620 },
  { bin_width: 20, bin_count: 1620 },
  { bin_width: 10, bin_count: 1620 },
  { bin_width: 8, bin_count: 1620 },
  { bin_width: 5, bin_count: 1620 },
  { bin_width: 4, bin_count: 1620 },
  { bin_width: 2, bin_count: 1620 },
  { bin_width: 1, bin_count: 1620 }
];

// Utility: Find closest zoom level index for a given value
window.findClosestZoomIndex = function(requestedZoom) {
  if (!window.zoomTable || window.zoomTable.length === 0) return null;
  let closestIndex = 0;
  // Treat requestedZoom as a bandwidth (Hz) and compare against entry span (bin_width * bin_count)
  const req = Number(requestedZoom) || 0;
  let minDiff = Math.abs(req - ((window.zoomTable[0].bin_width || 0) * (window.zoomTable[0].bin_count || 1)));
  for (let i = 1; i < window.zoomTable.length; ++i) {
    const entry = window.zoomTable[i];
    const span = (entry.bin_width || 0) * (entry.bin_count || 1);
    const diff = Math.abs(req - span);
    if (diff < minDiff) {
      closestIndex = i;
      minDiff = diff;
    }
  }
  return closestIndex;
};

function setSkipWaterfallLines(val) {
  val = Math.max(0, Math.min(3, parseInt(val, 10) || 0));
  window.skipWaterfallLines = val;
}

function setWaterfallBias(val) {
  var v = parseFloat(val);
  if (isNaN(v)) return;
  try { localStorage.setItem('waterfallBias', String(v)); } catch (e) {}
  try { document.getElementById('waterfallBiasInput').value = v; } catch (e) {}
  if (typeof spectrum !== 'undefined' && spectrum) {
    spectrum.waterfallBias = v;
    try { if (spectrum.bin_copy) spectrum.drawSpectrumWaterfall(spectrum.bin_copy, false); } catch (e) {}
  }
}

function isFirefox() {
    return navigator.userAgent.toLowerCase().indexOf('firefox') > -1;
}

function isChrome() {
    // Exclude Edge and Opera, which also use Chromium
    return /chrome/i.test(navigator.userAgent) && !/edg/i.test(navigator.userAgent) && !/opr/i.test(navigator.userAgent);
}

// Firefox method: works as you described
function enableBandSelectAlwaysCallsSetBand_Firefox() {
    const bandSelect = document.getElementById('band');
    if (!bandSelect) return;

    bandSelect.addEventListener('mousedown', function (e) {
        if (e.target.tagName === 'OPTION' && e.target.value === bandSelect.value) {
            setTimeout(() => setBand(bandSelect.value), 0);
        }
    });
}

// Chrome/Chromium method: best possible workaround
function enableBandSelectAlwaysCallsSetBand_Chrome() {
    const bandSelect = document.getElementById('band');
    if (!bandSelect) return;

    let lastValue = bandSelect.value;

    // Record the value when the dropdown is opened
    bandSelect.addEventListener('mousedown', function () {
        lastValue = bandSelect.value;
    });

    // On change, update lastValue (normal selection)
    bandSelect.addEventListener('change', function () {
        lastValue = bandSelect.value;
        // setBand is already called by the onchange attribute in HTML
    });

    // When dropdown closes, if value didn't change, call setBand
    bandSelect.addEventListener('blur', function () {
        if (bandSelect.value === lastValue) {
            setBand(bandSelect.value);
        }
    });
}

// Main selector
function enableBandSelectAlwaysCallsSetBand() {
    if (isFirefox()) {
        enableBandSelectAlwaysCallsSetBand_Firefox();
    }
    /* else {
        enableBandSelectAlwaysCallsSetBand_Chrome();
    }
*/
}

// --- Unified Initialization ---
window.addEventListener('DOMContentLoaded', function() {
    // Move the original OptionsButton DOMContentLoaded handler here, before dialogPlaceholder fetch for order preservation
    var optionsButton = document.getElementById('OptionsButton');
    if (optionsButton) {
        optionsButton.addEventListener('click', function() {
            var dialog = document.getElementById('optionsDialog');
            if (dialog) dialog.classList.add('open');
            var overlay = document.getElementById('dialogOverlay');
            if (overlay) overlay.classList.add('open');
        });
    }

    // Defensive: check for dialogPlaceholder
    var dialogPlaceholder = document.getElementById('dialogPlaceholder');
    if (!dialogPlaceholder) {
        console.error('dialogPlaceholder element missing in HTML.');
        return;
    }
    // Load the dialog box content from optionsDialog.html
    fetch('optionsDialog.html')
        .then(response => response.text())
        .then(data => {
            dialogPlaceholder.innerHTML = data;

            // Setup the overlay buttons if spectrum exists
            if (spectrum && typeof spectrum.setupOverlayButtons === 'function') {
                spectrum.setupOverlayButtons();
            }

            // Defensive: check for required dialog elements
            var closeXButton = document.getElementById('closeXButton');
            var optionsDialog = document.getElementById('optionsDialog');
            var dialogOverlay = document.getElementById('dialogOverlay');
            if (closeXButton && optionsDialog && dialogOverlay) {
                closeXButton.onclick = function() {
                    optionsDialog.classList.remove('open');
                    dialogOverlay.classList.remove('open');
                };
            } else {
                console.error('Dialog elements missing after loading optionsDialog.html');
            }

            // Initialize dialog event listeners
            if (typeof initializeDialogEventListeners === "function") {
                initializeDialogEventListeners();
            }
            // Now that all DOM is loaded, call init()
            if (typeof init === "function") {
                init();
            }
            // --- Memories UI Setup ---
            // Defensive: check for required memory elements
            var sel = document.getElementById('memory_select');
            var descBox = document.getElementById('memory_desc');
            var saveBtn = document.getElementById('save_memory');
            var recallBtn = document.getElementById('recall_memory');
            var deleteBtn = document.getElementById('delete_memory');
            var exportBtn = document.getElementById('export_memories');
            var importBtn = document.getElementById('import_memories_btn');
            var importInput = document.getElementById('import_memories');
            if (!sel || !descBox || !saveBtn || !recallBtn || !deleteBtn || !exportBtn || !importBtn || !importInput) {
                console.error('One or more memory UI elements are missing in HTML.');
                return;
            }
            window.loadMemories();
            window.updateDropdownLabels();
            sel.onchange = function() { window.loadMemories(); window.updateDropdownLabels(); descBox.value = window.memories[parseInt(sel.value, 10)].desc || ''; };
            descBox.oninput = function() {
                window.loadMemories();
                var idx = parseInt(sel.value, 10);
                if (!window.memories[idx]) window.memories[idx] = { freq: '', desc: '', mode: '' };
                window.memories[idx].desc = descBox.value.slice(0, 20);
                window.saveMemories();
                // Do NOT updateDropdownLabels here; only update on save
            };
            saveBtn.onclick = function() {
                window.loadMemories();
                var idx = parseInt(sel.value, 10);
                var freq = document.getElementById('freq').value.trim();
                var desc = descBox.value.trim().slice(0, 20);
                var mode = document.getElementById('mode').value;
                if (freq) {
                    window.memories[idx] = { freq, desc, mode };
                    window.saveMemories();
                    window.updateDropdownLabels();
                }
            };
            recallBtn.onclick = function() {
                window.loadMemories();
                var idx = parseInt(sel.value, 10);
                var m = window.memories[idx];
                if (m && m.freq) {
                    document.getElementById('freq').value = m.freq;
                    descBox.value = m.desc || '';
                    setFrequencyW(false);
                    if (m.mode) {
                        document.getElementById('mode').value = m.mode;
                        setMode(m.mode);
                    }
                } else {
                    descBox.value = '';
                }
            };
            deleteBtn.onclick = function() {
                window.loadMemories();
                var idx = parseInt(sel.value, 10);
                window.memories[idx] = { freq: '', desc: '', mode: '' };
                window.saveMemories();
                window.updateDropdownLabels();
                descBox.value = '';
            };
            exportBtn.onclick = function() {
                window.loadMemories();
                var data = JSON.stringify(window.memories, null, 2);
                var blob = new Blob([data], { type: 'application/json' });
                var url = URL.createObjectURL(blob);

                // Use only the IP address (no port) in the filename
                var serverIP = window.location.hostname.replace(/:/g, '_');
                               var filename = `channel_memories_${serverIP}.json`;

                var a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                setTimeout(() => {
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                }, 100);
            };
            importBtn.onclick = function() { importInput.click(); };
            importInput.onchange = function(e) {
                var file = e.target.files[0];
                if (!file) return;
                var reader = new FileReader();
                reader.onload = function(evt) {

                    try {
                        var arr = JSON.parse(evt.target.result);
                        if (Array.isArray(arr) && arr.length === 50) {
                            var newMemories;
                            if (typeof arr[0] === 'string') {
                                newMemories = arr.map(f => ({ freq: f, desc: '', mode: '' }));
                            } else {
                                newMemories = arr.map(m => ({ freq: m.freq || '', desc: m.desc || '', mode: m.mode || '' }));
                            }
                            for (let i = 0; i < 50; i++) {
                                window.memories[i] = newMemories[i];
                            }
                            window.saveMemories();
                            window.updateDropdownLabels();
                            var idx = parseInt(sel.value, 10);
                            var m = window.memories[idx];
                            descBox.value = m && m.desc ? m.desc : '';
                        } else {
                            alert('Invalid channel memories file.');
                        }
                    } catch (e) {
                        alert('Failed to import channel memories: ' + e.message);
                    }
                };
                reader.readAsText(file);
            };
            // Initialize desc box for first memory
            descBox.value = window.memories[parseInt(sel.value, 10)].desc || '';

            // Initialize QuickBW preset and button
            try {
              loadQuickBWPreset();
              const cwBtn = document.getElementById('cw_instant_button');
              if (cwBtn) {
                cwBtn.onclick = function() { applyQuickBW(); };
              }
              const modeEl = document.getElementById('mode');
              if (modeEl) {
                modeEl.addEventListener('change', updateQuickBWButtonState);
              }
              // ensure initial button state
              updateQuickBWButtonState();
              // Initialize QuickBW inputs and Save button (in options dialog)
              try {
                const cwLower = document.getElementById('cw_lower_input');
                const cwUpper = document.getElementById('cw_upper_input');
                const cwSave = document.getElementById('cw_save_button');
                if (cwLower) cwLower.value = quickBWPreset.lowerOffset;
                if (cwUpper) cwUpper.value = quickBWPreset.upperOffset;
                if (cwSave) {
                  cwSave.onclick = function() {
                    try {
                      const lo = Number(document.getElementById('cw_lower_input').value);
                      const hi = Number(document.getElementById('cw_upper_input').value);
                      if (Number.isFinite(lo) && Number.isFinite(hi)) {
                        quickBWPreset.lowerOffset = lo;
                        quickBWPreset.upperOffset = hi;
                        saveQuickBWPreset();
                        // If QuickBW currently active, reapply offsets for current mode
                        if (quickBWActive) {
                          const modeEl = document.getElementById('mode');
                          const lowEl = document.getElementById('filterLowInput');
                          const highEl = document.getElementById('filterHighInput');
                          const m = (modeEl && modeEl.value) ? modeEl.value.toLowerCase() : '';
                          if (lowEl && highEl && (m === 'usb' || m === 'lsb')) {
                            if (m === 'usb') {
                              lowEl.value = Math.min(lo, hi);
                              highEl.value = Math.max(lo, hi);
                            } else {
                              lowEl.value = -Math.max(lo, hi);
                              highEl.value = -Math.min(lo, hi);
                            }
                            sendFilterEdges();
                          }
                        }
                      } else {
                        alert('Please enter valid numeric offsets');
                      }
                    } catch (e) { console.error('Failed to save QuickBW offsets', e); }
                  };
                }
              } catch (e) { /* ignore */ }
            } catch (e) { console.error('QuickBW init failed', e); }

            // --- END OF ALL INITIALIZATION ---
            settingsReady = true; // Allow saveSettings() from now on
        })
        .catch(error => {
            console.error('Error loading optionsDialog.html:', error);
        });

    // --- Band Selectors ---
    const bandCategory = document.getElementById('band_category');
    const band = document.getElementById('band');
    if (bandCategory && band) {
        bandCategory.addEventListener('change', function() {
            band.innerHTML = '';
            const dummy = document.createElement('option');
            dummy.value = '';
            dummy.textContent = 'Select:';
            dummy.disabled = true;
            dummy.selected = true;
            band.appendChild(dummy);
            const opts = bandOptions[this.value] || [];
            opts.forEach(opt => {
                const o = document.createElement('option');
                o.value = opt.freq;
                o.textContent = opt.label;
                band.appendChild(o);
            });
        });
        band.addEventListener('change', function() {
            if (this.value) setBand(this.value);
        });
        bandCategory.dispatchEvent(new Event('change'));
    }
});

// Overlay trace functionality has been moved to spectrum.js
function resetSettings() {
  // Clear all local storage for this origin
  localStorage.clear();
  // Ensure waterfallBias has a sensible default after reset so Options dialog shows it
  try { localStorage.setItem('waterfallBias', '5'); } catch (e) {}
  // Reload the current page (preserves URL, reloads from server)
  window.location.reload();
}

let csvMinuteTimer = null;

function handleWriteInfoClickMinimal() {
    const minuteInput = document.getElementById('csvMinuteInput');
    const writeInfoBtn = document.getElementById('csv_out');
    let minutes = parseInt(minuteInput.value, 10) || 0;
    if (minutes > 0) {
        if (csvMinuteTimer) clearInterval(csvMinuteTimer);
        dumpCSV();
        csvMinuteTimer = setInterval(dumpCSV, minutes * 60 * 1000);
        if (writeInfoBtn) {
            writeInfoBtn.textContent = 'Write Info!';
            writeInfoBtn.title = 'Write Info is periodically being written, enter 0 and press again to stop';
        }
        alert(`Write Info timer started: exporting every ${minutes} minute(s).`);
    } else {
        if (csvMinuteTimer) {
            clearInterval(csvMinuteTimer);
            csvMinuteTimer = null;
            dumpCSV();
            if (writeInfoBtn) {
                writeInfoBtn.textContent = 'Write Info';
                writeInfoBtn.title = 'Write Info and/or start/stop periodic info export';
            }
            alert('Write Info timer stopped. One last export completed.');
        } else {
            dumpCSV();
            if (writeInfoBtn) {
                writeInfoBtn.textContent = 'Write Info';
                writeInfoBtn.title = 'Write Info and/or start/stop periodic info export';
            }
            alert('Exporting info file one time.');
        }
    }
}

// Patch event handler setup after dialog load
const origInitDialogEvents = window.initializeDialogEventListeners;
window.initializeDialogEventListeners = function() {
    if (typeof origInitDialogEvents === 'function') origInitDialogEvents();
    const btn = document.getElementById('csv_out');
    if (btn) btn.onclick = handleWriteInfoClickMinimal;
};

// --- Periodic WWV Solar Data Fetch ---
function fetchAndDisplayWWVSolarData() {
    fetch('https://services.swpc.noaa.gov/text/wwv.txt')
        .then(response => response.text())
        .then(text => {
            // Parse Solar Flux
            const fluxMatch = text.match(/Solar flux (\d+)/);
            const aMatch = text.match(/A-index (\d+)/);
            // K-index can be a float, e.g. "K-index at 1200 UTC on 11 July was 4.33"
            const kMatch = text.match(/K-index.*?was ([\d.]+)/);
            // Issued time
            const issuedMatch = text.match(/:Issued:\s*([^\n]+)/);
            let flux = fluxMatch ? fluxMatch[1] : 'N/A';
            let a = aMatch ? aMatch[1] : 'N/A';
            let k = kMatch ? kMatch[1] : 'N/A';
            let issued = issuedMatch ? issuedMatch[1].trim() : '';
            const result = `WWV Flux=${flux}, A=${a}, K=${k}${issued ? " (" + issued + ")" : ""}`;
            const wwvElem = document.getElementById('wwv_solar');
            if (wwvElem) wwvElem.textContent = result;
        })
        .catch(() => {
            const wwvElem = document.getElementById('wwv_solar');
            if (wwvElem) wwvElem.textContent = 'WWV Flux=N/A, A=N/A, K=N/A';
        });
}

// --- Zoom bandwidth popup (shows transient kHz label while interacting with zoom slider) ---
(function(){
  let zoomBandwidthPopup = null;
  let zoomPopupHideTimer = null;
  let lastShownZoomIndex = null;

  function ensureZoomPopup() {
    if (zoomBandwidthPopup) return zoomBandwidthPopup;
    zoomBandwidthPopup = document.createElement('div');
    zoomBandwidthPopup.id = 'zoom_bw_popup';
    zoomBandwidthPopup.style.position = 'absolute';
    zoomBandwidthPopup.style.zIndex = 2000;
    zoomBandwidthPopup.style.padding = '6px 8px';
    zoomBandwidthPopup.style.borderRadius = '6px';
    zoomBandwidthPopup.style.background = 'rgba(0,0,0,0.85)';
    zoomBandwidthPopup.style.color = '#fff';
    zoomBandwidthPopup.style.fontSize = '13px';
    zoomBandwidthPopup.style.fontFamily = 'sans-serif';
    zoomBandwidthPopup.style.pointerEvents = 'none';
    zoomBandwidthPopup.style.transition = 'opacity 0.12s ease';
    zoomBandwidthPopup.style.opacity = '0';
    zoomBandwidthPopup.style.whiteSpace = 'nowrap';
    document.body.appendChild(zoomBandwidthPopup);
    return zoomBandwidthPopup;
  }

  function hideZoomBandwidthPopupNow() {
    if (zoomPopupHideTimer) { clearTimeout(zoomPopupHideTimer); zoomPopupHideTimer = null; }
    if (zoomBandwidthPopup) zoomBandwidthPopup.style.opacity = '0';
  }

  function showZoomBandwidthPopupForValue(value, evt) {
    try {
      const zoomEl = document.getElementById('zoom_level');
      if (!zoomEl) return;
      const min = Number(zoomEl.min) || 0;
      const max = Number(zoomEl.max) || (window.zoomTable ? window.zoomTable.length - 1 : 10);
      let v = Number(value);
      if (isNaN(v)) v = zoomEl.valueAsNumber || parseInt(zoomEl.value, 10) || 0;
      v = Math.max(min, Math.min(max, v));

      // determine zoomTable entry
      const idx = Math.round(v);
      // Determine if this call originated from a user pointer down (click/touch) event.
      const isUserDown = evt && (evt.type === 'pointerdown' || evt.type === 'mousedown' || evt.type === 'touchstart');
      // If we've already shown the popup for this zoom index, just extend the hide timer and don't re-show,
      // unless this invocation was a direct user selection (pointer/mouse down) in which case we want to
      // present the bandwidth even if the zoom index hasn't changed.
      if (idx === lastShownZoomIndex && !isUserDown) {
        if (zoomPopupHideTimer) {
          clearTimeout(zoomPopupHideTimer);
          zoomPopupHideTimer = setTimeout(() => { hideZoomBandwidthPopupNow(); }, 900);
        }
        return; // no change in zoom level and not a user-down event, don't display again
      }
      const table = window.zoomTable || [];
      const entry = table[idx] || table[Math.min(idx, table.length-1)] || null;
      let bwHz = 0;
      // Prefer runtime `binWidthHz * binCount` which is provided by the server
      // and represents the actual per-bin width and FFT size. If not available,
      // fall back to the zoom table's nominal entry span.
      if (typeof binWidthHz === 'number' && binWidthHz > 0 && typeof binCount === 'number' && binCount > 0) {
        bwHz = binWidthHz * binCount;
      } else if (entry && typeof entry.bin_width === 'number' && typeof entry.bin_count === 'number') {
        bwHz = (entry.bin_width * entry.bin_count);
      } else {
        bwHz = (typeof binWidthHz === 'number' ? binWidthHz : 1) * (typeof binCount === 'number' ? binCount : 1);
      }

      // If the calculated bandwidth exceeds the system Nyquist (fs/2), clamp to fs/2.
      // This commonly happens when the slider reaches zoom level 0; the proper displayed
      // value should not exceed input_samprate/2 and is effectively zoom level 1's fs/2.
      if (typeof input_samprate === 'number' && input_samprate > 0 && bwHz > (input_samprate / 2)) {
        bwHz = input_samprate / 2;
      }

      // Always format bandwidth in kHz with one decimal digit (e.g. "2.5 kHz")
      const kHzFloat = bwHz / 1000.0;
      const kHzNum = Number(kHzFloat.toFixed(1));
      const kHzLabel = kHzNum.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
      const label = `${kHzLabel} kHz`;

  const popup = ensureZoomPopup();
  lastShownZoomIndex = idx;
      popup.textContent = label;

      // position above thumb: approximate using percentage of value across control
      const rect = zoomEl.getBoundingClientRect();
      const pct = (v - min) / Math.max(1, (max - min));
      const pageLeft = rect.left + window.scrollX + pct * rect.width;
      // center popup horizontally on the thumb
      const popupWidth = popup.offsetWidth || 60;
      const left = Math.round(pageLeft - (popupWidth / 2));
      const top = Math.round(rect.top + window.scrollY - popup.offsetHeight - 10);
      popup.style.left = `${left}px`;
      popup.style.top = `${top}px`;
      popup.style.opacity = '1';

      // reset hide timer
      if (zoomPopupHideTimer) clearTimeout(zoomPopupHideTimer);
      zoomPopupHideTimer = setTimeout(() => { hideZoomBandwidthPopupNow(); }, 900);
    } catch (e) {
      // ignore errors in optional UI
      console.debug('zoom popup error', e);
    }
  }

  // Attach listeners after DOM ready
  window.addEventListener('DOMContentLoaded', function() {
    const zoomEl = document.getElementById('zoom_level');
    if (!zoomEl) return;

    // Do NOT show bandwidth popup while the user is dragging the slider.
    // We'll show the popup explicitly when the In/Out buttons are used.
    const onInput = function(e) { /* suppressed during drag */ };
    // Pointer down/mouse down handlers do nothing for popup
    const onPointerDown = function(e) { /* suppressed */ };
    const onMouseDown = function(e) { /* suppressed */ };
    const onPointerMove = function(e) { /* suppressed during drag */ };
    const onPointerUp = function(e) { if (zoomPopupHideTimer) clearTimeout(zoomPopupHideTimer); zoomPopupHideTimer = setTimeout(hideZoomBandwidthPopupNow, 600); };

    zoomEl.addEventListener('input', onInput, { passive: true });
  zoomEl.addEventListener('pointerdown', onPointerDown);
  zoomEl.addEventListener('mousedown', onMouseDown);
    zoomEl.addEventListener('pointermove', onPointerMove);
    // pointerup and mouseup/touchend
    zoomEl.addEventListener('pointerup', onPointerUp);
    zoomEl.addEventListener('mouseup', onPointerUp);
    zoomEl.addEventListener('touchend', onPointerUp);
    // Do not show popup on slider change events (we show it only on button presses)
    zoomEl.addEventListener('change', function(e){ if (zoomPopupHideTimer) clearTimeout(zoomPopupHideTimer); zoomPopupHideTimer = setTimeout(hideZoomBandwidthPopupNow, 600); });

    // hide on window resize or scroll
    window.addEventListener('resize', hideZoomBandwidthPopupNow);
    window.addEventListener('scroll', hideZoomBandwidthPopupNow);
  });

  // Expose popup helpers so other code (buttons) can trigger the same transient display
  window.showZoomBandwidthPopupForValue = showZoomBandwidthPopupForValue;
  window.hideZoomBandwidthPopupNow = hideZoomBandwidthPopupNow;

})();

// Initial fetch and then every hour, after DOM is ready
window.addEventListener('DOMContentLoaded', function() {
    fetchAndDisplayWWVSolarData();
    setInterval(fetchAndDisplayWWVSolarData, 60 * 60 * 1000);
});
