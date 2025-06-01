//
// G0ORX WebSDR using ka9q-radio uddated March 16, 2025 02:44Z WA2N WA2ZKD
//
//

      var ssrc;

      var band;
    let ws = null; // Declare WebSocket as a global variable
      let zoomTableSize = null; // Global variable to store the zoom table size   
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
      const webpage_version = "2.71";
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
      var target_zoom_level = 14;
      var switchModesByFrequency = false;
      var onlyAutoscaleByButton = false;
      var enableAnalogSMeter = false;

      /** @type {number} */
      window.skipWaterfallLines = 0; // Set to how many lines to skip drawing waterfall (0 = none)

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
        //ws.send("Z:" + (22 - target_zoom_level).toString());
        ws.send("Z:" + (target_zoom_level).toString());
        ws.send("Z:c:" + (target_center / 1000.0).toFixed(3));
        ws.send("F:" + (target_frequency / 1000.0).toFixed(3));
        fetchZoomTableSize(); // Fetch and store the zoom table size
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
          i=i+(cc *4);
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
            const z_level = view.getUint32(i,true); i+=4;
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
              document.getElementById("zoom_level").max = (input_samprate <= 64800000) ? zoomTableSize-1: zoomTableSize-1; // above and below 64.8 Mhz now can do 15 levels of zoom?
              document.getElementById("zoom_level").value = z_level;
              //console.log("Zoom level=",z_level);
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
          console.log("loadSettings() returned false, setting defaults");
          setDefaultSettings(); 
/*          spectrum.setSpectrumPercent(50);
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
          spectrum.colorIndex = 9;  // Default to kiwi color map
          spectrum.decay = 1.0;
          spectrum.cursor_active = false;
          spectrum.bins = binCount;
          document.getElementById('mode').value = "am";
*/
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
        document.getElementById('pause').textContent = (spectrum.paused ? "Spectrum Run" : "Spectrum Pause");
        document.getElementById('max_hold').textContent = (spectrum.maxHold ? "Turn hold off" : "Turn hold on");

        // set zoom, preset, spectrum percentage?
        spectrum.setAveraging(spectrum.averaging);
        spectrum.setColormap(spectrum.colorIndex);
        updateRangeValues();
        player.volume(1.00);
        getVersion();
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

    function setFrequencyW(waitToAutoscale = true)
    {
        var asCount = 0;
        // need to see how far away we'll move in frequency to set the waitToAutoscale value wdr
        let f = parseFloat(document.getElementById("freq").value,10) * 1000.0;
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
        autoAutoscale(asCount,waitToAutoscale);      
        saveSettings();
    }

    function setBand(freq) {
        f=parseInt(freq);
        document.getElementById("freq").value = (freq / 1000.0).toFixed(3);
        spectrum.setFrequency(f);
        if(switchModesByFrequency ) {
          if (f < 10000000) {
            setMode('lsb');
          } else {
            setMode('usb');
          }
      }
      ws.send("F:" + (freq / 1000).toFixed(3));
      autoAutoscale(0,true);  // wait for autoscale
      saveSettings();
    }

    function setMode(selected_mode) {
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
  
      //console.log("setMode() selected_mode=", selected_mode, " newSampleRate=", newSampleRate, " newChannels=", newChannels);
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
      //console.log("zoomed in from",document.getElementById("zoom_level").valueAsNumber);
      //console.log("zoomin(): ",document.getElementById('freq').value);
      //autoAutoscale(15,true);
      autoAutoscale(100,true);
      saveSettings();
    }

    function zoomout() {
      ws.send("Z:-:"+document.getElementById('freq').value);
      console.log("zoomed out from ",document.getElementById("zoom_level").valueAsNumber);
      //console.log("zoomout(): ",document.getElementById('freq').value);
      // autoAutoscale(15,true); // 15 for n0
      autoAutoscale(100,true);
      saveSettings();
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
      ws.send("Z:c");
      //console.log("zoom center at level ",document.getElementById("zoom_level").valueAsNumber);
      autoAutoscale(100,true);
      saveSettings();
    }

    function audioReporter(stats) {
    }

    function setZoom() {
      const v = document.getElementById("zoom_level").valueAsNumber;
      ws.send(`Z:${v}`);
      //console.log("setZoom(): ",v,"zoomControlActive=",zoomControlActive);
      //if(!zoomControlActive)  // Mouse wheel turn on zoom control, autoscale - commented this out just let it autoscale when mouse wheel or drag zoom slider
        autoAutoscale(100,false); 
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
        } else {
          btn.value = "START";
          btn.innerHTML = "Start Audio";
          ws.send("A:STOP:"+ssrc.toString());
        }
    }

function updateRangeValues(){
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
  pending_range_update = true;
}

function autoAutoscale(autoScaleCounterStart,waitToAutoscale = false) {     // Autoscale commanded by a change other than autoscale button press
  if (!onlyAutoscaleByButton) {
    spectrum.forceAutoscale(autoScaleCounterStart,waitToAutoscale);           
    pending_range_update = true;
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
  document.getElementById("waterfall_min").value = spectrum.wf_min_db;
  saveSettings();
}

function setWaterfallMax() {
  spectrum.wf_max_db = document.getElementById("waterfall_max_range").value;
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
  } else {
    amp = spectrum.bin_copy[bin];
  }

  f /= 1e6;
  //s = "bin " + bin.toString() + ", " + f.toFixed(3) + " MHz: " + amp.toFixed(1) + " dB";
  s = f.toFixed(3) + " MHz: " + amp.toFixed(1) + " dBm";
  /* deep six the maxhold stuff for now
  var max_amp = -120.0;
  if ((spectrum.maxHold) && (typeof spectrum.binsMax !== 'undefined') && (spectrum.binsMax.length > 0)) {
    max_amp = spectrum.binsMax[bin];
    s += " (" + max_amp.toFixed(1) + " dB max hold)";
  }
    */
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

  // Compute filter bandwidth
  const bw = Math.abs(filter_high - filter_low);
 
  computeSUnits(power,spectrum.maxHold);
  // Update the signal bar meter and get the noise power, since it computes it
  var noisePower = updateSMeter(power,noise_density_audio,bw,spectrum.maxHold);

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
  document.getElementById('noise_density').innerHTML = `N<sub>0</sub>: ${noise_density_audio.toFixed(1)} dBmJ, Noise power at BW ${bw}: ${noisePower.toFixed(1)} dBm`;
  document.getElementById('bins').textContent = `Bins: ${binCount}`;
  document.getElementById('hz_per_bin').textContent = `Bin width: ${binWidthHz} Hz`;
  document.getElementById('blocks').innerHTML = "Blocks/poll: " + blocks_since_last_poll.toString();
  document.getElementById('fft_avg').innerHTML = "FFT avg: " + spectrum.averaging.toString();
  document.getElementById('decay').innerHTML = "Decay: " + spectrum.decay.toString();
  document.getElementById("rx_rate").textContent = `RX rate: ${((rx_rate / 1000.0) * 8.0).toFixed(0)} kbps`;
  if (typeof ssrc !== 'undefined') {
    document.getElementById('ssrc').innerHTML = "SSRC: " + ssrc.toString();
  }
  document.getElementById('version').innerHTML = "Version: v" + webpage_version;
  //document.getElementById('webserver_version').innerHTML = "Server: v" + webserver_version.toString();
  //if (webpage_version != webserver_version)
  //  document.getElementById('webserver_version').innerHTML += " <b>Warning: version mismatch!</b>";
  let bin = spectrum.hz_to_bin(spectrum.frequency);
  document.getElementById("cursor_data").textContent = "Tune: " + level_to_string(spectrum.frequency) + " @bin: " + bin.toString(); 
  document.getElementById("spare2").textContent = `Span (kHz): ${lowHz / 1000.0} to ${highHz / 1000.0}, width: ${(highHz - lowHz)/1000}, center: ${centerHz / 1000.0}`;

  // Show reordered info into ge_data left table column 1

  if(!spectrum.cursor_active)
    document.getElementById("ge_data").textContent = `Channel Frequency: ${(spectrum.frequency / 1e3).toFixed(3)} kHz | BW: ${Math.abs(filter_high - filter_low).toFixed(0)} Hz |`;
  else
  {
    document.getElementById("ge_data").textContent =  "Cursor: " + level_to_string(spectrum.cursor_freq) + " | ";
  }
    // print units in 3rd column
  document.getElementById("pwr_units").textContent = "dBm | Signal:";
  // Show power in 2nd column and S Units in 4th column from computeSUnits function
  return;
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
  localStorage.setItem("meterIndex", document.getElementById("meter").value.toString());
  localStorage.setItem("cursor_freq", spectrum.cursor_freq.toString());
  localStorage.setItem("check_max", document.getElementById("check_max").checked.toString()); 
  localStorage.setItem("check_min", document.getElementById("check_min").checked.toString());
  localStorage.setItem("switchModesByFrequency", document.getElementById("cksbFrequency").checked.toString());
  localStorage.setItem("onlyAutoscaleByButton", document.getElementById("ckonlyAutoscaleButton").checked.toString());
  localStorage.setItem("enableAnalogSMeter",enableAnalogSMeter);
}

function checkMaxMinChanged(){  // Save the check boxes for show max and min
  saveSettings();
}

function setDefaultSettings() {
  spectrum.averaging = 4;
  spectrum.frequency = 10000000;
  frequencyHz = 10000000;
  target_frequency = 10000000;
  spectrum.min_db = -115;
  document.getElementById("spectrum_min").value = spectrum.min_db;
  spectrum.max_db = -35;
  document.getElementById("spectrum_max").value = spectrum.max_db;
  spectrum.wf_min_db = -115;
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
  spectrum.decay = 1.05;
  spectrum.cursor_active = false;
  document.getElementById("mode").value = "am";
  target_preset = "usb";
  increment = 500;
  document.getElementById("colormap").value = 9;
  spectrum.colorIndex = 9;
  document.getElementById("meter").value = 0;
  meterType = 0;
  document.getElementById("zoom_level").value =6;
  target_zoom_level = 6;
  spectrum.cursor_freq = 10000000;
  spectrum.check_max = false;
  spectrum.check_min = false;
  switchModesByFrequency = true;
  document.getElementById("cksbFrequency").checked = switchModesByFrequency;
  onlyAutoscaleByButton = false;
  document.getElementById("ckonlyAutoscaleButton").checked = false;
  enableAnalogSMeter = false; // Default to digital S-Meter
  document.getElementById("ckAnalogSMeter").checked = false;
}

function loadSettings() {
  console.log(`localStorage.length = ${localStorage.length}`);
  if ((localStorage.length == 0) || localStorage.length != 23) {
    return false;
  }
  spectrum.averaging = parseInt(localStorage.getItem("averaging"));
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
  spectrum.maxHold = (localStorage.getItem("maxHold") == "true");
//  console.log(`loading form storage maxHold = ${spectrum.maxHold}`);
  document.getElementById("max_hold").checked = spectrum.maxHold;
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
  document.getElementById("meter").value = parseInt(localStorage.getItem("meterIndex"));
  const d = parseInt(localStorage.getItem("meterIndex"));
  document.getElementById("meter").value = d;
  meterType = d;
  document.getElementById("zoom_level").value = parseInt(localStorage.getItem("zoom_level"));
  target_zoom_level = parseInt(localStorage.getItem("zoom_level"));
  spectrum.cursor_freq = parseFloat(localStorage.getItem("cursor_freq"));
  spectrum.check_max = check_max.checked = (localStorage.getItem("check_max") == "true");
  spectrum.check_min = check_min.checked = (localStorage.getItem("check_min") == "true");
  switchModesByFrequency = (localStorage.getItem("switchModesByFrequency") == "true");
  document.getElementById("cksbFrequency").checked = switchModesByFrequency;
  onlyAutoscaleByButton = (localStorage.getItem("onlyAutoscaleByButton") == "true");
  document.getElementById("ckonlyAutoscaleButton").checked = onlyAutoscaleByButton;
  enableAnalogSMeter = (localStorage.getItem("enableAnalogSMeter") == "true");
  document.getElementById("ckAnalogSMeter").checked = enableAnalogSMeter;
  setAnalogMeterVisible(enableAnalogSMeter); // Set the visibility of the analog S-Meter based on the saved setting
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

// Event handlers for new Spectrum Options Dialog box

document.addEventListener('DOMContentLoaded', function() {
  document.getElementById('OptionsButton').addEventListener('click', function() {
    const dialog = document.getElementById('optionsDialog');
    dialog.classList.add('open');
    document.getElementById('dialogOverlay').classList.add('open');
  });
});

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
    player.volume(parseFloat(value)); // Set the volume using player.js's volume function
    //console.log(`Volume set to: ${value}`);
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

        // Temporary event listener for the ZSIZE response
        function handleZoomTableSize(event) {
            if (typeof event.data === "string" && event.data.startsWith("ZSIZE:")) {
                const size = parseInt(event.data.split(":")[1], 10);
                ws.removeEventListener("message", handleZoomTableSize); // Remove the listener after handling
                resolve(size);
            }
        }

        // Add the temporary event listener
        ws.addEventListener("message", handleZoomTableSize);

        // Handle errors
        ws.addEventListener("error", function (error) {
            ws.removeEventListener("message", handleZoomTableSize); // Clean up the listener
            reject("WebSocket error: " + error);
        }, { once: true });
    });
}

async function fetchZoomTableSize() {
    try {
        const size = await getZoomTableSize(); // Fetch the zoom table size
        zoomTableSize = size; // Store it in the global variable
        console.log("Zoom table size fetched and stored:", zoomTableSize);

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

function setSkipWaterfallLines(val) {
  val = Math.max(0, Math.min(3, parseInt(val, 10) || 0));
  window.skipWaterfallLines = val;
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
    } else {
        enableBandSelectAlwaysCallsSetBand_Chrome();
    }
}

document.addEventListener('DOMContentLoaded', function() {
    enableBandSelectAlwaysCallsSetBand();
});

function setAnalogMeterVisible(visible) {
    console.log(`Setting analog S-Meter visibility to: ${visible}`);
    const meter = document.getElementById("sMeter");
    if (meter) {
        meter.style.display = visible ? "" : "none";
    }
    // Adjust the top table's margin-left based on S meter visibility
    const topTableDiv = document.querySelector('div[style*="justify-content: center"][style*="margin-top: 10px"]');
    if (topTableDiv) {
        if (visible) {
            topTableDiv.style.marginLeft = "-164px";
        } else {
            topTableDiv.style.marginLeft = "0px";
        }
    }
    enableAnalogSMeter = visible; // Update the global variable
    saveSettings();
}
