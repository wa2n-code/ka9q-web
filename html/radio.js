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
      var noise_density = 0;
      var blocks_since_last_poll = 0;
      var last_poll = -1;
      const webpage_version = "2.37";
      var webserver_version = "";
      var player = new PCMPlayer({
        encoding: '16bitInt',
        channels: 1,
        sampleRate: 12000,
        flushingTime: 250
        });

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
        ws.send("M:am");
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
                spectrum.setCenterHz(centerHz);
                update=1;
              }

              n = view.getUint32(i);
              i=i+4;
              hz = ntohl(n);
              if(frequencyHz!=hz) {
                frequencyHz=hz;
                spectrum.setFrequency(frequencyHz);
                document.getElementById("freq").value = (frequencyHz / 1000.0).toFixed(3);
                update=1;
              }

              n = view.getUint32(i);
              i=i+4;
              hz = ntohl(n);;
              if(binWidthHz != hz) {
                binWidthHz = hz;
                spectrum.setSpanHz(binWidthHz * binCount);
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
            noise_density = view.getFloat32(i,true); i+=4;

            if(update) {
              calcFrequencies();
              spectrum.setLowHz(lowHz);
              spectrum.setHighHz(highHz);
              spectrum.setCenterHz(centerHz);
              spectrum.setFrequency(frequencyHz);
              spectrum.setSpanHz(binWidthHz * binCount);
              spectrum.bins = binCount;
            }
              var dataBuffer = evt.data.slice(i,data.byteLength);
              const arr = new Float32Array(dataBuffer);
              spectrum.addData(arr);
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
                  document.getElementById('heading').innerHTML = enc.decode(d);
                  document.title = enc.decode(d);
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
        document.getElementById('mode').value = "am";
        document.getElementById('colormap').value = spectrum.colorindex.toString();
        document.getElementById('decay_list').value = spectrum.decay.toString();
        document.getElementById('cursor').checked = spectrum.cursor_active;
        document.getElementById('pause').textContent = (spectrum.paused ? "Run" : "Pause");
        document.getElementById('max_hold').textContent = (spectrum.maxHold ? "Norm" : "Max hold");
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
    }

    
    var counter;

    function step_changed(value) {
      increment = parseInt(value);
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
    }
    function startIncrement() {
        incrementFrequency();
        counter=setInterval(incrementFrequency,200);
    }
    function stopIncrement() {
        clearInterval(counter);
    }
    function startDecrement() {
        decrementFrequency();
        counter=setInterval(decrementFrequency,200);
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
    }
    function setMode(selected_mode) {
        document.getElementById('mode').value = selected_mode;
        ws.send("M:"+selected_mode);
    }
    function selectMode(mode) {
        let element = document.getElementById('mode');
        element.value = mode;
        ws.send("M:"+mode);
    }

    function zoomin() {
      ws.send("Z:+:"+document.getElementById('freq').value);
    }
    function zoomout() {
      ws.send("Z:-:"+document.getElementById('freq').value);
    }
    function zoomcenter() {
      ws.send("Z:c");
    }
    function zoomTo(w) {
      ws.send("Z:"+w.toString());
    }
    function audioReporter(stats) {
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
  document.getElementById('adc_samples').innerHTML = "ADC samples: " + (Number(input_samples) / 1e9).toFixed(3) + " M";
  document.getElementById('adc_samp_rate').innerHTML = "Fs in: " + (input_samprate / 1e6).toFixed(3) + " MHz";
  document.getElementById('adc_overs').innerHTML = "Overranges: " + ad_over.toString();
  document.getElementById('adc_last_over').innerHTML = "Last overrange: " + (samples_since_over / BigInt(input_samprate)).toString() + " s";
  document.getElementById('uptime').innerHTML =  "Uptime: " + smp.toFixed(1) + " s";
  document.getElementById('rf_gain').innerHTML = "RF Gain: " + rf_gain.toFixed(1) + " dB";
  document.getElementById('rf_attn').innerHTML = "RF Atten: " + rf_atten.toFixed(1) + " dB";
  document.getElementById('rf_cal').innerHTML = "RF lev cal: " + rf_level_cal.toFixed(1) + " dB";
  document.getElementById('rf_agc').innerHTML = (rf_agc==1 ? "RF AGC: enabled" : "RF AGC: disabled");
  document.getElementById('if_power').innerHTML = "A/D: " + if_power.toFixed(1) + " dBFS";
  document.getElementById('noise_density').innerHTML = "N<sub>0</sub>: " + noise_density.toFixed(2) + " dBmJ";
  document.getElementById('bins').textContent = `Bins: ${binCount}`;
  document.getElementById('hz_per_bin').textContent = `Bin width: ${binWidthHz} Hz`;
  document.getElementById('blocks').innerHTML = "Blocks/poll: " + blocks_since_last_poll.toString();
  document.getElementById('fft_avg').innerHTML = "FFT avg: " + spectrum.averaging.toString();
  document.getElementById('decay').innerHTML = "Decay: " + spectrum.decay.toString();
  document.getElementById('baseband_power').textContent = `Baseband/S-meter: ${power.toFixed(1)} dBm @ ${(spectrum.frequency / 1e3).toFixed(0)} kHz, ${(filter_high - filter_low).toFixed(0)} Hz BW`;
  if (typeof ssrc !== 'undefined') {
    document.getElementById('ssrc').innerHTML = "SSRC: " + ssrc.toString();
  }
  document.getElementById('version').innerHTML = "Web: v" + webpage_version;
  document.getElementById('webserver_version').innerHTML = "Server: v" + webserver_version.toString();
  if (webpage_version != webserver_version)
    document.getElementById('webserver_version').innerHTML += " <b>Warning: version mismatch!</b>";

  document.getElementById("cursor_data").innerHTML = "<br>Tune: " + level_to_string(spectrum.frequency) + "<br>Cursor: " + level_to_string(spectrum.cursor_freq);
  document.getElementById("spare2").textContent = `low: ${lowHz / 1000.0} kHz, high: ${highHz / 1000.0} kHz, center: ${centerHz / 1000.0} kHz, tune: ${frequencyHz / 1000.0} kHz`;
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

function dumpCSV() {
  var t = Number(gps_time) / 1e9;
  t += 315964800;
  t -= 18;
  var smp = Number(input_samples) / Number(input_samprate);
  var data = [
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
    ["noise_density", noise_density.toFixed(2)],
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

  var csvContent = "data:text/csv;charset=utf-8,"
      + data.map(row => row.join(",")).join("\n");

  csvContent += "\n\nBin, Amplitude (dB?), Average (dB?), Max hold (dB?)\n";
  for(let i = 0; i < binCount; i++) {
    let b = (typeof spectrum.bin_copy !== 'undefined') ? spectrum.bin_copy[i].toFixed(3) : "";
    let a = (typeof spectrum.binsAverage !== 'undefined') ? spectrum.binsAverage[i].toFixed(3) : "";
    let m = (typeof spectrum.binsMax !== 'undefined') ? spectrum.binsMax[i].toFixed(3) : "";
    csvContent += `${i}, ${b}, ${a}, ${m}\n`;
  }
  const d = new Date();
  const timestring = d.toISOString();

  var encodedUri = encodeURI(csvContent);
  var link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", `info_${timestring}.csv`);
  document.body.appendChild(link);
  link.click();
}
