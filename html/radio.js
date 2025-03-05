//
// G0ORX WebSDR using ka9q-radio
//
//
      var ssrc;

      var band;

      var spectrum;
      let binWidthHz = 20000; // 20000 Hz per bin
      var centerHz = 10000000; // center frequency
      var frequencyHz = 10000000; // tuned frequency
      var lowHz=0;
      var highHz=32400000;
      let binCount = 1620;
      let spanHz = binCount * binWidthHz;

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
      const webpage_version = "2.67";
      var webserver_version = "";
      var player = new PCMPlayer({
        encoding: '16bitInt',
        channels: 1,
        sampleRate: 12000,
        flushingTime: 250
        });

      var pending_range_update = false;
      var target_frequency = frequencyHz;
      var target_center = centerHz;
      var target_preset = "am";
      var target_zoom_level = 21;
      function ntohs(value) {
        const buffer = new ArrayBuffer(2);
        const view = new DataView(buffer);
        view.setUint16(0, value);

        const byteArray = new Uint8Array(buffer);
        const result = (byteArray[0] << 8) | byteArray[1];

        return result;
      }

      function ntohf(value) {
        const buffer = new ArrayBuffer(4);
        view = new DataView(buffer);
        view.setFloat32(0, value);

        const byteArray = new Uint8Array(buffer);
        const result = (byteArray[0] << 24) | (byteArray[1] << 16) | (byteArray[2] << 8) | byteArray[3];

        b0=byteArray[0];
        b1=byteArray[1];
        b2=byteArray[2];
        b3=byteArray[3];

        byteArray[0]=b3;
        byteArray[1]=b2;
        byteArray[2]=b1;
        byteArray[3]=b0;

        return view.getFloat32(0);
      }

      function ntohl(value) {
        const buffer = new ArrayBuffer(4);
        const view = new DataView(buffer);
        view.setUint32(0, value);

        const byteArray = new Uint8Array(buffer);
        const result = (byteArray[0] << 24) | (byteArray[1] << 16) | (byteArray[2] << 8) | byteArray[3];

        return result;
      }

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
        // can we load the saved frequency/zoom/preset here?
        ws.send("M:" + target_preset);
        ws.send("Z:" + (22 - target_zoom_level).toString());
        ws.send("Z:c:" + (target_center / 1000.0).toFixed(3));
        ws.send("F:" + (target_frequency / 1000.0).toFixed(3));
      }

      function on_ws_close() {
      }

      async function on_ws_message(evt) {
        if(typeof evt.data === 'string') {
          // text data
          //console.log(evt.data);
          temp=evt.data.toString();
          args=temp.split(":");
          if(args[0]=='S') { // get our ssrc
            ssrc=parseInt(args[1]);
          }
        } else if(evt.data instanceof ArrayBuffer) {
          var data = evt.data;
          rx(data.byteLength);
          //console.log("data.byteLength=",data.byteLength);
          // RTP header
          const view = new DataView(evt.data);
          var i=0;
          var n = view.getUint32(i);
          i=i+4;
          //console.log("n=",n.toString(16));
          var w = ntohl(n);
          //console.log("w=",w.toString(16));
          var version = w>>30;
          var pad = (w>>29)&1;
          var extension = (w>>28)&1;
          var cc = (w>>24)&0x0f;
          var type = (w>>16)&0x7f;
          var seq =  w&0xffff;

          n = view.getUint32(i);
          i=i+4;
          var timestamp=ntohl(n);
          n = view.getUint32(i);
          i=i+4;
          var this_ssrc=ntohl(n);
          i=i+cc;
          if(extension) {
            n = view.getUint32(i);
            var ext_len=ntohl(n);
            i=i+4;
            i=i+ext_len;
          }

          // i now points to the start of the data
          var data_length=data.byteLength-i;
          var update=0;
          switch(type) {
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
            rf_agc = view.getUint32(i,true); i+=4;
            input_samples = view.getBigUint64(i,true); i+=8;
            ad_over = view.getBigUint64(i,true); i+=8;
            samples_since_over = view.getBigUint64(i,true); i+=8;
            gps_time = view.getBigUint64(i,true); i+=8;
            blocks_since_last_poll = view.getBigUint64(i,true); i+=8;
            rf_atten = view.getFloat32(i,true); i+=4;
            rf_gain = view.getFloat32(i,true); i+=4;
            rf_level_cal = view.getFloat32(i,true); i+=4;
            if_power = view.getFloat32(i,true); i+=4;
            noise_density_audio = view.getFloat32(i,true); i+=4;
            const z_level = 22 - view.getUint32(i,true); i+=4;
            const bin_precision_bytes = view.getUint32(i,true); i+=4;
            const bins_autorange_offset =  view.getFloat32(i,true); i+=4;
            const bins_autorange_gain =  view.getFloat32(i,true); i+=4;

            if(update) {
              calcFrequencies();
              spectrum.setLowHz(lowHz);
              spectrum.setHighHz(highHz);
              spectrum.setCenterHz(centerHz);
              spectrum.setFrequency(frequencyHz);
              spectrum.setSpanHz(binWidthHz * binCount);
              spectrum.bins = binCount;
              document.getElementById("zoom_level").max = (input_samprate <= 64800000) ? 21 : 22;
              document.getElementById("zoom_level").value = z_level;
              document.getElementById("freq").value = (frequencyHz / 1000.0).toFixed(3);
              saveSettings();
            }
            var dataBuffer = evt.data.slice(i,data.byteLength);
            if (4 == bin_precision_bytes) {
              const arr = new Float32Array(dataBuffer);
              spectrum.addData(arr);
            }
            else if (2 == bin_precision_bytes) {
              const i16 = new Int16Array(dataBuffer);
              const arr = new Float32Array(binCount);
              for (i = 0; i < binCount; i++) {
                arr[i] = 0.01 * i16[i];
              }
              spectrum.addData(arr);
            }
            else if (1 == bin_precision_bytes) {
              const i8 = new Uint8Array(dataBuffer);
              const arr = new Float32Array(binCount);
              // dynamic autorange of 8 bit bin levels, using offset/gain from webserver
              for (i = 0; i < binCount; i++) {
                arr[i] = bins_autorange_offset + (bins_autorange_gain * i8[i]);
              }
              spectrum.addData(arr);
            }

            if (pending_range_update) {
              pending_range_update = false;
              updateRangeValues();
              saveSettings();
            }

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
                  document.getElementById('heading').textContent = page_title;
                  document.title = page_title;
                  i=i+l;
                  break;
                case 39: // LOW_EDGE
                    dataBuffer = evt.data.slice(i,i+l);
                    arr_low = new Float32Array(dataBuffer);
                    filter_low=ntohf(arr_low[0]);
                    i=i+l;
                    break;
                  case 40: // HIGH_EDGE
                    dataBuffer = evt.data.slice(i,i+l);
                    arr_high = new Float32Array(dataBuffer);
                    filter_high=ntohf(arr_high[0]);
                    i=i+l;
                    break;
                  case 46: // BASEBAND_POWER
                    power=view.getFloat32(i);
                    power = 10.0 * Math.log10(power);
                    i=i+l;
                    break;
                }
              }
              spectrum.setFilter(filter_low,filter_high);
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
              console.log("received unknown type:"+type.toString(16));
              break;
          }
        }
      }
      function on_ws_error() {
      }
      function is_touch_enabled() {
        return ( 'ontouchstart' in window ) ||
               ( navigator.maxTouchPoints > 0 ) ||
               ( navigator.msMaxTouchPoints > 0 );
      }
      init = function(){
        frequencyHz = 10000000;
        centerHz = 10000000;
        binWidthHz = 20000;
        spectrum = new Spectrum("waterfall", {spectrumPercent: 50, bins: binCount});
        if (!loadSettings()) {
          spectrum.setSpectrumPercent(50);
          spectrum.setFrequency(frequencyHz);
          spectrum.setCenterHz(centerHz);
          spectrum.setSpanHz(binWidthHz * binCount);
          lowHz = centerHz - ((binWidthHz * binCount) / 2);
          spectrum.setLowHz(lowHz);
          highHz = centerHz + ((binWidthHz * binCount) / 2);
          spectrum.setHighHz(highHz);
          spectrum.averaging = 0;
          spectrum.maxHold = false;
          spectrum.paused = false;
          spectrum.colorIndex = 0;
          spectrum.decay = 1.0;
          spectrum.cursor_active = false;
          spectrum.bins = binCount;
          document.getElementById('mode').value = "am";
        }
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

//        if(is_touch_enabled()) {
//console.log("touch enabled");
//          document.getElementById('waterfall').addEventListener("touchstart", onMouseDown, false);
//          document.getElementById('waterfall').addEventListener("touchend", onMouseUp, false);
//          document.getElementById('waterfall').addEventListener("touchmove", onMouseMove, false);
//        } else {
//console.log("touch NOT enabled");
          //document.getElementById('waterfall').addEventListener("click", onClick, false);
          document.getElementById('waterfall').addEventListener("mousedown", onClick, false);
          //document.getElementById('waterfall').addEventListener("mousedown", onMouseDown, false);
          //document.getElementById('waterfall').addEventListener("mouseup", onMouseUp, false);
          //document.getElementById('waterfall').addEventListener("mousemove", onMouseMove, false);
          document.getElementById('waterfall').addEventListener("wheel", onWheel, false);
          document.getElementById('waterfall').addEventListener("keydown", (event) => { spectrum.onKeypress(event); }, false);
//        }

        document.getElementById("freq").value = (frequencyHz / 1000.0).toFixed(3);
        document.getElementById('step').value = increment.toString();
        document.getElementById('colormap').value = spectrum.colorIndex;
        document.getElementById('decay_list').value = spectrum.decay.toString();
        document.getElementById('cursor').checked = spectrum.cursor_active;
        document.getElementById('pause').textContent = (spectrum.paused ? "Run" : "Pause");
        document.getElementById('max_hold').textContent = (spectrum.maxHold ? "Norm" : "Max hold");

        // set zoom, preset, spectrum percentage?
        spectrum.setAveraging(spectrum.averaging);
        spectrum.setColormap(spectrum.colorIndex);
        updateRangeValues();
        player.volume(1.00);
        getVersion();
      }

    window.addEventListener('load', init, false);

    var increment=1000;

    function onClick(e) {
      var span = binWidthHz * binCount;
      width=document.getElementById('waterfall').width;
      hzPerPixel=span/width;
      f=Math.round((centerHz-(span/2))+(hzPerPixel*e.pageX));
      f=f-(f%increment);
      if (!spectrum.cursor_active) {
        document.getElementById("freq").value = (f / 1000.0).toFixed(3);
        setFrequency();
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
        setFrequency();
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
      event.preventDefault();
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

    var counter;

    function step_changed(value) {
      increment = parseInt(value);
      saveSettings();
    }

    function incrementFrequency()
    {
        var value = parseFloat(document.getElementById('freq').value,10);
        value = isNaN(value) ? 0 : (value * 1000.0) + increment;
        document.getElementById("freq").value = (value / 1000.0).toFixed(3);
        ws.send("F:" + (value / 1000.0).toFixed(3));
        //document.getElementById("freq").value=value.toString();
        //band.value=document.getElementById('msg').value;
        spectrum.setFrequency(value);
      saveSettings();
    }
    function decrementFrequency()
    {
        var value = parseFloat(document.getElementById('freq').value,10);
        value = isNaN(value) ? 0 : (value * 1000.0) - increment;
        document.getElementById("freq").value = (value / 1000.0).toFixed(3);
        ws.send("F:" + (value / 1000.0).toFixed(3));
        //document.getElementById("freq").value=value.toString();
        //band.value=document.getElementById('msg').value;
        spectrum.setFrequency(value);
      saveSettings();
    }
    function startIncrement() {
        incrementFrequency();
        counter=setInterval(incrementFrequency,200);
      saveSettings();
    }
    function stopIncrement() {
        clearInterval(counter);
    }
    function startDecrement() {
        decrementFrequency();
        counter=setInterval(decrementFrequency,200);
      saveSettings();
    }
    function stopDecrement() {
        clearInterval(counter);
    }
    function setFrequency()
    {
        let f = parseFloat(document.getElementById("freq").value,10) * 1000.0;
        ws.send("F:" + (f / 1000.0).toFixed(3));
        //document.getElementById("freq").value=document.getElementById('msg').value;
        //band.value=document.getElementById('msg').value;
      spectrum.setFrequency(f);
      saveSettings();
    }
    function setBand(freq) {
        f=parseInt(freq);
        document.getElementById("freq").value = (freq / 1000.0).toFixed(3);
        spectrum.setFrequency(f);
        if (f < 10000000) {
          setMode('lsb');
        } else {
          setMode('usb');
        }
        ws.send("F:" + (freq / 1000).toFixed(3));
      saveSettings();
    }
    function setMode(selected_mode) {
        document.getElementById('mode').value = selected_mode;
        ws.send("M:"+selected_mode);
      saveSettings();
    }
    function selectMode(mode) {
        let element = document.getElementById('mode');
        element.value = mode;
        ws.send("M:"+mode);
      saveSettings();
    }

    function zoomin() {
      ws.send("Z:+:"+document.getElementById('freq').value);
      saveSettings();
    }
    function zoomout() {
      ws.send("Z:-:"+document.getElementById('freq').value);
      saveSettings();
    }
    function zoomcenter() {
      ws.send("Z:c");
      saveSettings();
    }
    function audioReporter(stats) {
    }
function setZoom() {
  const v = 22 - document.getElementById("zoom_level").valueAsNumber;
  ws.send(`Z:${v}`);
  saveSettings();
}
    async function audio_start_stop()
    {
        var btn = document.getElementById("audio_button");
        if(btn.value==="START") {
          btn.value = "STOP";
          btn.innerHTML = "Stop Audio";
          ws.send("A:START:"+ssrc.toString());
          player.resume();
        } else {
          btn.value = "START";
          btn.innerHTML = "Start Audio";
          ws.send("A:STOP:"+ssrc.toString());
        }
    }

function updateRangeValues(){
  document.getElementById("waterfall_min").value = spectrum.wf_min_db;
  document.getElementById("waterfall_max").value = spectrum.wf_max_db;
  document.getElementById("spectrum_min").value = spectrum.min_db;
  document.getElementById("spectrum_max").value = spectrum.max_db;
  saveSettings();
}

function autoscale() {
  spectrum.forceAutoscale();
  pending_range_update = true;
}

function positionUp() {
  spectrum.positionUp();
  updateRangeValues();
  saveSettings();
}

function positionDown() {
  spectrum.positionDown();
  updateRangeValues();
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
  spectrum.wf_min_db = parseFloat(document.getElementById("waterfall_min").value);
  saveSettings();
}

function setWaterfallMax() {
  spectrum.wf_max_db = parseFloat(document.getElementById("waterfall_max").value);
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

function level_to_string(f) {
  let bin = spectrum.hz_to_bin(f);
  let s = "";
  if ((bin < 0) || (bin >= binCount)) {
    return;
  }

  let amp = -120.0;
  if ((spectrum.averaging > 0) && (typeof spectrum.binsAverage !== 'undefined') && (spectrum.binsAverage.length > 0)) {
    amp = spectrum.binsAverage[bin];
  } else {
    amp = spectrum.bin_copy[bin];
  }

  f /= 1e6;
  s = "bin " + bin.toString() + ", " + f.toFixed(6) + " MHz: " + amp.toFixed(1) + " dB";
  var max_amp = -120.0;
  if ((spectrum.maxHold) && (typeof spectrum.binsMax !== 'undefined') && (spectrum.binsMax.length > 0)) {
    max_amp = spectrum.binsMax[bin];
    s += " (" + max_amp.toFixed(1) + " dB max hold)";
  }
  return s;
}

function update_stats() {
  if (spectrum.paused)
    return;

  // GPS time isn't UTC
  var t = Number(gps_time) / 1e9;
  t+=315964800;
  t-=18;
  var smp = Number(input_samples) / Number(input_samprate);

  // newell 12/1/2024, 19:16:35
  // ugly hack to get the stats on the webpage. Formatting is terrible, but
  // perfect is the enemy of good, right?
  document.getElementById('gps_time').innerHTML = (new Date(t * 1000)).toTimeString();
  document.getElementById('adc_samples').innerHTML = "ADC samples: " + (Number(input_samples) / 1e9).toFixed(3) + " G";
  document.getElementById('adc_samp_rate').innerHTML = "Fs in: " + (input_samprate / 1e6).toFixed(3) + " MHz";
  document.getElementById('adc_overs').innerHTML = "Overranges: " + ad_over.toString();
  document.getElementById('adc_last_over').innerHTML = "Last overrange: " + (samples_since_over / BigInt(input_samprate)).toString() + " s";
  document.getElementById('uptime').innerHTML =  "Uptime: " + smp.toFixed(1) + " s";
  document.getElementById('rf_gain').innerHTML = "RF Gain: " + rf_gain.toFixed(1) + " dB";
  document.getElementById('rf_attn').innerHTML = "RF Atten: " + rf_atten.toFixed(1) + " dB";
  document.getElementById('rf_cal').innerHTML = "RF lev cal: " + rf_level_cal.toFixed(1) + " dB";
  document.getElementById('rf_agc').innerHTML = (rf_agc==1 ? "RF AGC: enabled" : "RF AGC: disabled");
  document.getElementById('if_power').innerHTML = "A/D: " + if_power.toFixed(1) + " dBFS";
  document.getElementById('noise_density').innerHTML = `N<sub>0</sub>: ${noise_density_audio.toFixed(1)} dBmJ (audio)`;
  document.getElementById('bins').textContent = `Bins: ${binCount}`;
  document.getElementById('hz_per_bin').textContent = `Bin width: ${binWidthHz} Hz`;
  document.getElementById('blocks').innerHTML = "Blocks/poll: " + blocks_since_last_poll.toString();
  document.getElementById('fft_avg').innerHTML = "FFT avg: " + spectrum.averaging.toString();
  document.getElementById('decay').innerHTML = "Decay: " + spectrum.decay.toString();
  document.getElementById('baseband_power').textContent = `Baseband/S-meter: ${power.toFixed(1)} dBm @ ${(spectrum.frequency / 1e3).toFixed(0)} kHz, ${(filter_high - filter_low).toFixed(0)} Hz BW`;
  document.getElementById("rx_rate").textContent = `RX rate: ${((rx_rate / 1000.0) * 8.0).toFixed(0)} kbps`;
  if (typeof ssrc !== 'undefined') {
    document.getElementById('ssrc').innerHTML = "SSRC: " + ssrc.toString();
  }
  document.getElementById('version').innerHTML = "Web: v" + webpage_version;
  document.getElementById('webserver_version').innerHTML = "Server: v" + webserver_version.toString();
  if (webpage_version != webserver_version)
    document.getElementById('webserver_version').innerHTML += " <b>Warning: version mismatch!</b>";

  document.getElementById("cursor_data").innerHTML = "<br>Tune: " + level_to_string(spectrum.frequency) + "<br>Cursor: " + level_to_string(spectrum.cursor_freq);
  document.getElementById("spare2").textContent = `low: ${lowHz / 1000.0} kHz, high: ${highHz / 1000.0} kHz, center: ${centerHz / 1000.0} kHz, tune: ${frequencyHz / 1000.0} kHz`;

  // Show reordered info into ge_data left table column
  document.getElementById("ge_data").textContent = `Channel Frequency: ${(spectrum.frequency / 1e3).toFixed(3)} kHz, BW ${(filter_high - filter_low).toFixed(0)} Hz,`;
  // Show power in 2nd column
  document.getElementById("pwr_data").textContent = ` Power: ${power.toFixed(0)} `;
  // print units in 3rd column
  document.getElementById("pwr_units").textContent = "dBm, Signal:";
  // Show S Units in 4th column
  var ss = computeSUnits(power);

  var len = ss.length;
  if (len > 3)
  {
    document.getElementById("s_data").style.color = "red";
  }
  else 
  {
    document.getElementById("s_data").style.color = "green";
  }
  document.getElementById("s_data").textContent = `${ss}`;
  
  // Update the signal bar meter
  updateSMeter(power);
  
  return;
  /*
  // newell 12/1/2024, 19:10:56
  // hack to change the title when the block since last poll is changing
  // Could this be connected to the vertical 'bouncing' that is sometimes
  // seen on the spectrum? My current theory is that radiod integrates bin
  // energy between the forward fft bins and the decimated spec demod bins,
  // then scales that by number of blocks since the last time the demod was
  // polled. But if the polling rate varies, the scaling changes and the bin
  // amplitudes appear to bounce.
  // Hacking radiod to not integrate and not scale seems to make the display
  // more stable, even when the blocks_since_last_poll value is changing.
  // But I don't know if disabling the integration is sound practice.
  if ((last_poll > 0) && (last_poll != blocks_since_last_poll))
    document.getElementById('heading').innerHTML = 'Bouncing';
  else
    document.getElementById('heading').innerHTML = 'G0ORX Web SDR + ka9q-radio';
  last_poll = blocks_since_last_poll;
  */
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
  const data = [
    ["description", `"${document.title}"`],
    ["gps_time", (new Date(t * 1000)).toTimeString()],
    ["adc_samples", (Number(input_samples)).toFixed(0)],
    ["adc_samp_rate", (input_samprate).toFixed(0)],
    ["adc_overs", ad_over.toString()],
    ["adc_last_over", (samples_since_over / BigInt(input_samprate)).toString()],
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
    ["version", webpage_version],
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
  const timestring = d.toISOString();

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
  const timestring = d.toISOString();
  const encodedUri = encodeURI(htmlFile);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", `info_${timestring}.html`);
  document.body.appendChild(link);
  link.click();
}

async function uploadBug() {
  if (0 == document.getElementById("note_text").value.length) {
    if (false == window.confirm("Are you sure you want to upload without any notes in the text box?")) {
      return;
    }
  }
  // create a json object and push it to my server
  const response = await fetch("https://www.n5tnl.com/ka9q-web/up/bug", {
    method: "POST",
    body: JSON.stringify({csv: buildCSV(), screenshot: buildScreenshot()}),
  });
}

function saveSettings() {
  localStorage.setItem("tune_hz", spectrum.frequency.toString());
  localStorage.setItem("zoom_level", document.getElementById("zoom_level").valueAsNumber);
  localStorage.setItem("min_db", spectrum.min_db.toString())
  localStorage.setItem("max_db", spectrum.max_db.toString())
  localStorage.setItem("wf_min_db", spectrum.wf_min_db.toString())
  localStorage.setItem("wf_max_db", spectrum.wf_max_db.toString())
  localStorage.setItem("spectrum_percent", spectrum.spectrumPercent.toString());
  localStorage.setItem("spectrum_center_hz", spectrum.centerHz.toString());
  localStorage.setItem("averaging", spectrum.averaging.toString());
  localStorage.setItem("maxHold", spectrum.maxHold.toString());
  localStorage.setItem("paused", spectrum.paused.toString());
  localStorage.setItem("decay", spectrum.decay.toString());
  localStorage.setItem("cursor_active", spectrum.cursor_active.toString());
  localStorage.setItem("preset", document.getElementById("mode").value);
  localStorage.setItem("step", document.getElementById("step").value.toString());
  localStorage.setItem("colorIndex", document.getElementById("colormap").value.toString());
  localStorage.setItem("cursor_freq", spectrum.cursor_freq.toString());
}

function loadSettings() {
  console.log(`localStorage.length = ${localStorage.length}`);
  if (localStorage.length == 0) {
    return false;
  }
  spectrum.frequency = parseFloat(localStorage.getItem("tune_hz"));
  frequencyHz = parseFloat(localStorage.getItem("tune_hz"));
  target_frequency = frequencyHz;
  spectrum.min_db = parseFloat(localStorage.getItem("min_db"));
  document.getElementById("spectrum_min").value = spectrum.min_db;
  spectrum.max_db = parseFloat(localStorage.getItem("max_db"));
  document.getElementById("spectrum_max").value = spectrum.max_db;
  spectrum.wf_min_db = parseFloat(localStorage.getItem("wf_min_db"));
  document.getElementById("waterfall_min").value = spectrum.wf_min_db;
  spectrum.wf_max_db = parseFloat(localStorage.getItem("wf_max_db"));
  document.getElementById("waterfall_max").value = spectrum.wf_max_db;
  spectrum.spectrumPercent = parseFloat(localStorage.getItem("spectrum_percent"));
  spectrum.centerHz = parseFloat(localStorage.getItem("spectrum_center_hz"));
  centerHz = spectrum.centerHz;
  target_center = centerHz;
  spectrum.averaging = parseFloat(localStorage.getItem("averaging"));
  spectrum.maxHold = (localStorage.getItem("maxHold") == "true");
  spectrum.paused = (localStorage.getItem("paused") == "true");
  spectrum.decay = parseFloat(localStorage.getItem("decay"));
  spectrum.cursor_active = (localStorage.getItem("cursor_active") == "true");
  document.getElementById("mode").value = localStorage.getItem("preset");
  target_preset = localStorage.getItem("preset");
  increment = parseFloat(localStorage.getItem("step"));
  document.getElementById("colormap").value = parseInt(localStorage.getItem("colorIndex"));
  const c = parseInt(localStorage.getItem("colorIndex"));
  document.getElementById("colormap").value = c;
  spectrum.colorIndex = c;
  document.getElementById("zoom_level").value = parseInt(localStorage.getItem("zoom_level"));
  target_zoom_level = parseInt(localStorage.getItem("zoom_level"));
  spectrum.cursor_freq = parseFloat(localStorage.getItem("cursor_freq"));
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

function computeSUnits(value) {
  let p = Math.round(value);
  var s;
  //if (p < -67) {     
  if (p <= -73) {     
    s = 'S' + Math.floor((p + 127) / 6);
  } 
  else {
    //s = 'S9+' + ((p + 78) / 10) * 10;
    s = 'S9+' + ((p + 73) / 10) * 10;
  }
  return s;
}