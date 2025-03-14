/*
 * Copyright (c) 2019 Jeppe Ledet-Pedersen
 * This software is released under the MIT license.
 * See the LICENSE file for further details.
 */

'use strict';

Spectrum.prototype.setFrequency = function(freq) {
    this.frequency=freq;
}

Spectrum.prototype.setFilter = function(low,high) {
    this.filter_low=low;
    this.filter_high=high;
}

Spectrum.prototype.squeeze = function(value, out_min, out_max) {
    if (value <= this.min_db)
        return out_min;
    else if (value >= this.max_db)
        return out_max;
    else
        return Math.round((value - this.min_db) / (this.max_db - this.min_db) * out_max);
}

Spectrum.prototype.rowToImageData = function(bins) {
    for(var i = 0; i < this.imagedata.data.length; i += 4) {
        try {
            //var cindex = this.squeeze(-(bins[i/4]-70), 0, 255);

            // newell 12/1/2024, 11:44:29
            // with this new bin amplitude scaling, the colormap lookup need to change
            // I think the idea is that weak signals use colors from the start
            // of the colormap array, and stronger ones use colors from the end
            // I also noticed the default colormaps are not all the same length!
            // perhaps that's what the catch(err) was all about?
            var scaled=((bins[i / 4] - this.wf_min_db) / (this.wf_max_db - this.wf_min_db));
            if (scaled > 1.0) scaled = 1.0;
            if (scaled < 0) scaled = 0;
            var cindex = Math.round((this.colormap.length - 1) * scaled);
          var color = this.colormap[cindex];
          this.imagedata.data[i+0] = color[0];
          this.imagedata.data[i+1] = color[1];
          this.imagedata.data[i+2] = color[2];
          this.imagedata.data[i+3] = 255;
        } catch(err) {
            console.error("rowToImageData() caught an error: color=", color, " colormap.length=", this.colormap.length);
          var color = this.colormap[this.colormap.length-1];
          this.imagedata.data[i+0] = color[0];
          this.imagedata.data[i+1] = color[1];
          this.imagedata.data[i+2] = color[2];
          this.imagedata.data[i+3] = 255;
        }
    }
}

Spectrum.prototype.addWaterfallRow = function(bins) {
    // Shift waterfall 1 row down
    this.ctx_wf.drawImage(this.ctx_wf.canvas,
        0, 0, this.wf_size, this.wf_rows - 1,
        0, 1, this.wf_size, this.wf_rows - 1);

    // Draw new line on waterfall canvas
    this.rowToImageData(bins);
    this.ctx_wf.putImageData(this.imagedata, 0, 0);

    var width = this.ctx.canvas.width;
    var height = this.ctx.canvas.height;

    // Copy scaled FFT canvas to screen. Only copy the number of rows that will
    // fit in waterfall area to avoid vertical scaling.
    this.ctx.imageSmoothingEnabled = false;
    var rows = Math.min(this.wf_rows, height - this.spectrumHeight);
    this.ctx.drawImage(this.ctx_wf.canvas,
        0, 0, this.wf_size, rows,
        0, this.spectrumHeight, width, height - this.spectrumHeight);
}

Spectrum.prototype.drawFFT = function(bins,color) {
    var hz_per_pixel = this.spanHz/bins.length;
    var dbm_per_line=this.spectrumHeight/(this.max_db-this.min_db);
/*
    // band edges
    var x = (this.lowHz-this.start_freq)/hz_per_pixel;
    this.ctx.fillStyle = "#505050";
    this.ctx.fillRect(0, 0, x, this.spectrumHeight);
    x = (this.highHz-this.start_freq)/hz_per_pixel;
    this.ctx.fillRect(x, 0, this.ctx.canvas.width-x, this.spectrumHeight);
*/
    this.ctx.beginPath();
    this.ctx.moveTo(-1, this.spectrumHeight + 1);
    var max_s=0;
    for(var i=0; i<bins.length; i++) {
        var s = bins[i];
        // newell 12/1/2024, 10:16:13
        // With the spectrum bin amplitude ranging from -120 to 0 dB or so
        // this needs to flip to draw the spectrum correctly
        s = (s-this.min_db)*dbm_per_line;
        s = this.spectrumHeight-s;
        if(i==0) this.ctx.lineTo(-1,s);
        this.ctx.lineTo(i, s);
        if (i==bins.length-1) this.ctx.lineTo(this.wf_size+1,s);
        if(s>max_s) {
          max_s=s;
        }
    }
    this.ctx.lineTo(this.wf_size+1,this.spectrumHeight+1);
    this.ctx.strokeStyle = color;
    this.ctx.stroke();
}

Spectrum.prototype.drawFilter = function(bins) {
    var hz_per_pixel = this.spanHz/bins.length;

    // draw the filter
    // low filter edge
    var x=((this.frequency-this.start_freq)+this.filter_low)/hz_per_pixel;
    // high filter edge
    var x1=((this.frequency-this.start_freq)+this.filter_high)/hz_per_pixel;
    var width=x1-x;
    this.ctx.fillStyle = "#404040";
    this.ctx.fillRect(x,0,width,this.spectrumHeight);
//  this.ctx.fillStyle = "black";
}

Spectrum.prototype.drawCursor = function(f, bins, color, amp) {
    var hz_per_pixel = this.spanHz/bins.length;

    // draw vertical line
    var x = (f - this.start_freq) / hz_per_pixel;
    this.ctx.beginPath();
    this.ctx.moveTo(x,0);
    this.ctx.lineTo(x,this.spectrumHeight);

    if (typeof amp !== "undefined") {
        let dbm_per_line = this.spectrumHeight / (this.max_db - this.min_db);
        let s = this.spectrumHeight - ((amp - this.min_db) * dbm_per_line);
        this.ctx.moveTo(x-10,s);
        this.ctx.lineTo(x+10,s);
    }

    this.ctx.strokeStyle = color;
    this.ctx.stroke();
}

Spectrum.prototype.drawSpectrum = function(bins) {
    var width = this.ctx.canvas.width;
    var height = this.ctx.canvas.height;

    // Fill with black
    this.ctx.fillStyle = "black";
    this.ctx.fillRect(0, 0, width, height);

    // FFT averaging
    if (this.averaging > 0) {
        if (!this.binsAverage || this.binsAverage.length != bins.length) {
            this.binsAverage = Array.from(bins);
        } else {
            for (var i = 0; i < bins.length; i++) {
                this.binsAverage[i] += this.alpha * (bins[i] - this.binsAverage[i]);
            }
        }
        bins = this.binsAverage;
    }

    // Max hold
    if (this.maxHold) {
        if (!this.binsMax || this.binsMax.length != bins.length) {
            this.binsMax = Array.from(bins);
        } else {
            for (var i = 0; i < bins.length; i++) {
                if (bins[i] > this.binsMax[i]) {
                    this.binsMax[i] = bins[i];
                } else {
                    // Decay
                    this.binsMax[i] = this.decay * this.binsMax[i];
                }
            }
        }
    }

    // Min hold
    if (this.maxHold) {
        if (!this.binsMin || this.binsMin.length != bins.length) {
            this.binsMin = Array.from(bins);
        } else {
            for (var i = 0; i < bins.length; i++) {
                if (bins[i] < this.binsMin[i]) {
                    this.binsMin[i] = bins[i];
                } else {
                    // Decay
                    this.binsMin[i] = this.binsMin[i];
                }
            }
        }
    }

    // Do not draw anything if spectrum is not visible
    if (this.ctx_axes.canvas.height < 1) {
        return;
    }
    // Scale for FFT
    this.ctx.save();
    this.ctx.scale(width / this.wf_size, 1);

    // draw filter band
    this.drawFilter(bins);

    // newell 12/1/2024, 16:08:06
    // Something weird here...why does the pointer stroke color affect the already drawn spectrum?
    // draw pointer
    this.drawCursor(this.frequency, bins, "#ff0000", bins[this.hz_to_bin(this.frequency)]);

    // draw cursor
    if (this.cursor_active)
        this.drawCursor(this.cursor_freq, bins, "#00ffff", bins[this.hz_to_bin(this.cursor_freq)]);

    // Draw maxhold
  if ((this.maxHold) && (true == document.getElementById("check_max").checked)) {
    this.ctx.fillStyle = "none";
    this.drawFFT(this.binsMax,"#ffff00");
  }

  if (true == document.getElementById("check_live").checked){
    // Draw FFT bins
    this.drawFFT(bins,"#ffffff");
    // Fill scaled path
    this.ctx.fillStyle = this.gradient;
    this.ctx.fill();
  }


  // Draw minhold
  if ((this.maxHold) && (true == document.getElementById("check_min").checked)) {
    this.ctx.fillStyle = "none";
    this.drawFFT(this.binsMin,"#ff0000");
  }

    // Restore scale
    this.ctx.restore();

    // Copy axes from offscreen canvas
    this.ctx.drawImage(this.ctx_axes.canvas, 0, 0);
}

Spectrum.prototype.updateAxes = function() {
    var width = this.ctx_axes.canvas.width;
    var height = this.ctx_axes.canvas.height;

    // Clear axes canvas
    this.ctx_axes.clearRect(0, 0, width, height);

    this.start_freq=this.centerHz-(this.spanHz/2);
    var hz_per_pixel = this.spanHz/width;

    // Draw axes
    this.ctx_axes.font = "12px sans-serif";
    this.ctx_axes.fillStyle = "white";
    this.ctx_axes.textBaseline = "middle";

    this.ctx_axes.textAlign = "left";
    var step = 5; // 5 dB steps, was 10 wdr
    for (var i = this.min_db + 10; i <= this.max_db - 10; i += step) {
        var y = height - this.squeeze(i, 0, height);
        this.ctx_axes.fillText(i, 5, y);

        this.ctx_axes.beginPath();
        this.ctx_axes.moveTo(20, y);
        this.ctx_axes.lineTo(width, y);
        this.ctx_axes.strokeStyle = "rgba(200, 200, 200, 0.30)";
        this.ctx_axes.stroke();
    }

    //this.ctx_axes.textBaseline = "bottom";
    this.ctx_axes.textBaseline = "top";

    let inc;
    switch(this.spanHz/this.nbins) {
        case 40:
          inc=5000;
          break;
        case 80:
          inc=10000;
          break;
        case 200:
          inc=50000;
          break;
        case 400:
          inc=50000;
          break;
        case 800:
          inc=100000;
          break;
        case 1000:
          inc=200000;
          break;
        case 2000:
          inc=500000;
          break;
        case 4000:
          inc=1000000;
          break;
        case 8000:
          inc=1000000;
          break;
        case 16000:
          inc=2000000;
          break;
        case 20000:
          inc=2000000;
          break;
        default:
          inc = (this.spanHz / this.nbins) * 100;
          break;
    }
    inc = isNaN(inc) ? 2000000 : inc;

    var freq=this.start_freq-(this.start_freq%inc);
    var text;
    while(freq<=this.highHz) {
        this.ctx_axes.textAlign = "center";
        var x = (freq-this.start_freq)/hz_per_pixel;
        text = freq / 1e6;
        //this.ctx_axes.fillText(text.toFixed(3), x, height);
        this.ctx_axes.fillText(text.toFixed(3), x, 2);
        this.ctx_axes.beginPath();
        this.ctx_axes.moveTo(x, 0);
        this.ctx_axes.lineTo(x, height);
        this.ctx_axes.strokeStyle = "rgba(200, 200, 200, 0.30)";
        this.ctx_axes.stroke();
        freq=freq+inc;
    }

}

Spectrum.prototype.addData = function(data) {
    if (!this.paused) {
        if ((data.length) != this.wf_size) {
            this.wf_size = (data.length);
            this.ctx_wf.canvas.width = (data.length);
            this.ctx_wf.fillStyle = "black";
            this.ctx_wf.fillRect(0, 0, this.wf.width, this.wf.height);
            this.imagedata = this.ctx_wf.createImageData((data.length), 1);
        }
        this.bin_copy=data;
        this.nbins=data.length;

        // autoscale?
        // newell 12/1/2024, 13:47:12
        // attempt to autoscale based on the min/max of the current spectrum
        // or the current max hold (if it's turned on)
        // should pick reasonable scale in 5 dB increments
        const maxAutoscaleWait = 2;
        if (this.autoscale) {
            if(this.autoscaleWait < maxAutoscaleWait) {  // Wait a maxAutoscaleWait cycles before you do the autoscale to allow spectrum to settle (agc?)
                this.autoscaleWait++;
                console.log("autoscaleWait ",this.autoscaleWait.toString());
                return;
            }
            this.autoscaleWait = 0; // Reset the flags and counters
            this.autoscale = false;

            var increment = 5.0;    // RSSI graticule increament in dB
            var data_max = Math.max(...data);
            var data_min = Math.min(...data);
            if (this.maxHold) {
                // autoscale off peak bins in max hold mode
                data_max = Math.max(...this.binsMax, data_max);
                data_min = Math.min(...this.binsMax, data_min);
            }
            console.log("data_min=", data_min, " data_max=", data_max);
            var minimum = Math.floor(data_min / increment) * increment;
            var maximum = increment * Math.ceil(data_max / increment);
            if(maximum < -80)  // Don't range too far into the weeds.
                maximum = -80;
            console.log("minimum=", minimum, " maximum=", maximum);
            this.setRange(minimum,maximum, true);
        }
        this.drawSpectrum(data);
        this.addWaterfallRow(data);
        this.resize();
    }
}

Spectrum.prototype.updateSpectrumRatio = function() {
    this.spectrumHeight = Math.round(this.canvas.height * this.spectrumPercent / 100.0);

    this.gradient = this.ctx.createLinearGradient(0, 0, 0, this.spectrumHeight);
    for (var i = 0; i < this.colormap.length; i++) {
        var c = this.colormap[this.colormap.length - 1 - i];
        this.gradient.addColorStop(i / this.colormap.length,
            "rgba(" + c[0] + "," + c[1] + "," + c[2] + ", 1.0)");
    }
    this.saveSettings();
}

Spectrum.prototype.resize = function() {
    var width = this.canvas.clientWidth;
    var height = this.canvas.clientHeight;

    if (this.canvas.width != width ||
        this.canvas.height != height) {
        this.canvas.width = width;
        this.canvas.height = height;
        this.updateSpectrumRatio();
    }

    if (this.axes.width != width ||
        this.axes.height != this.spectrumHeight) {
        this.axes.width = width;
        this.axes.height = this.spectrumHeight;
        this.updateAxes();
    }
    this.saveSettings();
}

Spectrum.prototype.setSpectrumPercent = function(percent) {
    if (percent >= 0 && percent <= 100) {
        this.spectrumPercent = percent;
        this.updateSpectrumRatio();
    }
    this.saveSettings();
}

Spectrum.prototype.incrementSpectrumPercent = function() {
    if (this.spectrumPercent + this.spectrumPercentStep <= 100) {
        this.setSpectrumPercent(this.spectrumPercent + this.spectrumPercentStep);
    }
    this.saveSettings();
}

Spectrum.prototype.decrementSpectrumPercent = function() {
    if (this.spectrumPercent - this.spectrumPercentStep >= 0) {
        this.setSpectrumPercent(this.spectrumPercent - this.spectrumPercentStep);
    }
    this.saveSettings();
}

Spectrum.prototype.setColormap = function(value) {
    this.colorindex = value;
    if (this.colorindex >= colormaps.length)
        this.colorindex = 0;
    this.colormap = colormaps[this.colorindex];
    this.updateSpectrumRatio();
    //console.info("New colormap index=", this.colorindex, ", map has ", this.colormap.length, " entries");
    this.saveSettings();
}

Spectrum.prototype.toggleColor = function() {
    this.colorindex++;
    if (this.colorindex >= colormaps.length)
        this.colorindex = 0;
    this.colormap = colormaps[this.colorindex];
    this.updateSpectrumRatio();
    document.getElementById("colormap").value = this.colorindex;
    this.saveSettings();
}

Spectrum.prototype.setRange = function(min_db, max_db, adjust_waterfall) {
    this.min_db = min_db;
    this.max_db = max_db;
    if (adjust_waterfall) {
        this.wf_min_db = min_db;
        this.wf_max_db = max_db;
    }
    this.updateAxes();
    this.saveSettings();
}

Spectrum.prototype.positionUp = function() {
    this.setRange(this.min_db - 5, this.max_db - 5, false);
    this.saveSettings();
}

Spectrum.prototype.positionDown = function() {
    this.setRange(this.min_db + 5, this.max_db + 5, false);
    this.saveSettings();
}

Spectrum.prototype.rangeIncrease = function() {
    this.setRange(this.min_db, this.max_db + 5, true);
    this.saveSettings();
}

Spectrum.prototype.rangeDecrease = function() {
    if (this.max_db - this.min_db > 10)
        this.setRange(this.min_db, this.max_db - 5, true);
    this.saveSettings();
}

Spectrum.prototype.setCenterHz = function(hz) {
    this.centerHz = hz;
    this.updateAxes();
    this.saveSettings();
}

Spectrum.prototype.setSpanHz = function(hz) {
    this.spanHz = hz;
    this.updateAxes();
    this.saveSettings();
}

Spectrum.prototype.setLowHz = function(hz) {
    this.lowHz = hz;
    this.updateAxes();
    this.saveSettings();
}

Spectrum.prototype.setHighHz = function(hz) {
    this.highHz = hz;
    this.updateAxes();
    this.saveSettings();
}

Spectrum.prototype.setAveraging = function(num) {
    if (num >= 0) {
        this.averaging = num;
        this.alpha = 2 / (this.averaging + 1)
    }
    this.saveSettings();
}

Spectrum.prototype.setDecay = function(num) {
    this.decay = num;
    this.saveSettings();
}

Spectrum.prototype.incrementAveraging = function() {
    this.setAveraging(this.averaging + 1);
    this.saveSettings();
}

Spectrum.prototype.decrementAveraging = function() {
    if (this.averaging > 0) {
        this.setAveraging(this.averaging - 1);
    }
    this.saveSettings();
}

Spectrum.prototype.togglePaused = function() {
    this.paused = !this.paused;
    document.getElementById("pause").textContent = (this.paused ? "Spectrum Run" : "Spectrum Pause");
    this.saveSettings();
}

Spectrum.prototype.setMaxHold = function(maxhold) {
    this.maxHold = maxhold;
    this.binsMax = undefined;
    this.binsMin = undefined;
    this.saveSettings();
}

Spectrum.prototype.toggleMaxHold = function() {
    this.setMaxHold(!this.maxHold);
    document.getElementById("max_hold").textContent = (this.maxHold ? "Norm" : "Max hold");
    this.saveSettings();
}

Spectrum.prototype.saveSettings = function() {
    if (typeof this.radio_pointer !== "undefined") {
        this.radio_pointer.saveSettings();
    }
}

Spectrum.prototype.toggleFullscreen = function() {
    if (!this.fullscreen) {
        if (this.canvas.requestFullscreen) {
            this.canvas.requestFullscreen();
        } else if (this.canvas.mozRequestFullScreen) {
            this.canvas.mozRequestFullScreen();
        } else if (this.canvas.webkitRequestFullscreen) {
            this.canvas.webkitRequestFullscreen();
        } else if (this.canvas.msRequestFullscreen) {
            this.canvas.msRequestFullscreen();
        }
        this.fullscreen = true;
    } else {
        if (document.exitFullscreen) {
            document.exitFullscreen();
        } else if (document.mozCancelFullScreen) {
            document.mozCancelFullScreen();
        } else if (document.webkitExitFullscreen) {
            document.webkitExitFullscreen();
        } else if (document.msExitFullscreen) {
            document.msExitFullscreen();
        }
        this.fullscreen = false;
    }
}

Spectrum.prototype.forceAutoscale = function() {
    this.autoscale = true;
}

Spectrum.prototype.onKeypress = function(e) {
    if (e.key == " ") {
        this.togglePaused();
    } else if (e.key == "f") {
        this.toggleFullscreen();
    } else if (e.key == "c") {
        this.toggleColor();
    } else if (e.key == "ArrowUp") {
        this.positionUp();
    } else if (e.key == "ArrowDown") {
        this.positionDown();
    } else if (e.key == "ArrowLeft") {
        this.rangeDecrease();
    } else if (e.key == "ArrowRight") {
        this.rangeIncrease();
    } else if (e.key == "s") {
        this.incrementSpectrumPercent();
    } else if (e.key == "w") {
        this.decrementSpectrumPercent();
    } else if (e.key == "+") {
        this.incrementAveraging();
    } else if (e.key == "-") {
        this.decrementAveraging();
    } else if (e.key == "m") {
        this.toggleMaxHold();
    } else if (e.key == "z") {
        ws.send("Z:c");
        saveSettings();
    } else if (e.key == "i") {
      	ws.send("Z:+:"+document.getElementById('freq').value);
	saveSettings();
    } else if (e.key == "o") {
        ws.send("Z:-:"+document.getElementById('freq').value);
        saveSettings();
    }
}

Spectrum.prototype.pixel_to_bin = function(pixel) {
    return Math.floor((pixel / this.canvas.width) * this.bins);
}

Spectrum.prototype.bin_to_hz = function(bin) {
    var start_freq = this.centerHz - (this.spanHz / 2.0);
    return start_freq + ((this.spanHz / this.bins) * bin);
}

Spectrum.prototype.hz_to_bin = function(hz) {
    var start_freq = this.centerHz - (this.spanHz / 2.0);
    return Math.floor(((hz - start_freq) / (this.spanHz)) * this.bins);
}

Spectrum.prototype.cursorCheck = function() {
    this.cursor_active=document.getElementById("cursor").checked;
}

Spectrum.prototype.limitCursor = function(freq) {
    var start_freq = this.centerHz-(this.spanHz / 2.0);
    var end_freq = this.centerHz+(this.spanHz / 2.0);
    return Math.min(Math.max(start_freq,freq),end_freq);
}

Spectrum.prototype.cursorUpdate = function(freq) {
    return;
}

Spectrum.prototype.cursorUp = function() {
    this.cursor_freq = this.limitCursor(this.cursor_freq + parseInt(document.getElementById("step").value));
    this.cursorUpdate(this.cursor_freq);
}

Spectrum.prototype.cursorDown = function() {
    this.cursor_freq = this.limitCursor(this.cursor_freq - parseInt(document.getElementById("step").value));
    this.cursorUpdate(this.cursor_freq);
}

function Spectrum(id, options) {
    // Handle options
    this.centerHz = (options && options.centerHz) ? options.centerHz : 0;
    this.spanHz = (options && options.spanHz) ? options.spanHz : 0;
    this.wf_size = (options && options.wf_size) ? options.wf_size : 0;
    this.wf_rows = (options && options.wf_rows) ? options.wf_rows : 256;
    this.spectrumPercent = (options && options.spectrumPercent) ? options.spectrumPercent : 50;
    this.spectrumPercentStep = (options && options.spectrumPercentStep) ? options.spectrumPercentStep : 5;
    this.averaging = (options && options.averaging) ? options.averaging : 0;
    this.maxHold = (options && options.maxHold) ? options.maxHold : false;
    this.bins = (options && options.bins) ? options.bins : false;

    // Setup state
    this.paused = false;
    this.fullscreen = false;
    // newell 12/1/2024, 10:16:50
    // set default spectrum ranges to match the scaled bin amplitudes
    this.min_db = -120;
    this.max_db = 0;
    this.wf_min_db = -120;
    this.wf_max_db = 0;
    this.spectrumHeight = 0;

    // Colors
    this.colorindex = 0;
    this.colormap = colormaps[0];

    // Create main canvas and adjust dimensions to match actual
    this.canvas = document.getElementById(id);
    this.canvas.height = this.canvas.clientHeight;
    this.canvas.width = this.canvas.clientWidth;
    this.ctx = this.canvas.getContext("2d");
    this.ctx.fillStyle = "black";
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // Create offscreen canvas for axes
    this.axes = document.createElement("canvas");
    this.axes.height = 1; // Updated later
    this.axes.width = this.canvas.width;
    this.ctx_axes = this.axes.getContext("2d");

    // Create offscreen canvas for waterfall
    this.wf = document.createElement("canvas");
    this.wf.height = this.wf_rows;
    this.wf.width = this.wf_size;
    this.ctx_wf = this.wf.getContext("2d");

    this.autoscale = false;
    this.autoscaleWait = 0;
    this.decay = 1.0;
    this.cursor_active = false;
    this.cursor_step = 1000;
    this.cursor_freq = 10000000;

    this.radio_pointer = undefined;

    // Trigger first render
    this.setAveraging(this.averaging);
    this.updateSpectrumRatio();
    this.resize();
}
