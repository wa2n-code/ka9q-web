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

let lineDecimation = 0;
Spectrum.prototype.addWaterfallRow = function(bins) {
    // window.skipWaterfallLines should be 0 (no skip), 1 (skip 1), 2 (skip 2), or 3 (skip 3)
    // Only draw a new row if lineDecimation is 0
    let skip = (window.skipWaterfallLines > 0) && (lineDecimation++ % (window.skipWaterfallLines + 1) !== 0);
    if (!skip) {
        //console.log("Drawing row at lineDecimation =", lineDecimation, "skipWaterfallLines =", window.skipWaterfallLines);
        // Shift waterfall 1 row down
        this.ctx_wf.drawImage(this.ctx_wf.canvas,
            0, 0, this.wf_size, this.wf_rows - 1,
            0, 1, this.wf_size, this.wf_rows - 1);

        // Draw new line on waterfall canvas
        this.rowToImageData(bins);
        this.ctx_wf.putImageData(this.imagedata, 0, 0);
    }

    // Always copy the waterfall to the main canvas
    var width = this.ctx.canvas.width;
    var height = this.ctx.canvas.height;
    this.ctx.imageSmoothingEnabled = false;
    var rows = Math.min(this.wf_rows, height - this.spectrumHeight);
    this.ctx.drawImage(this.ctx_wf.canvas,
        0, 0, this.wf_size, rows,
        0, this.spectrumHeight, width, height - this.spectrumHeight);

    // Reset lineDecimation to avoid overflow
    if (lineDecimation > 1000000) lineDecimation = 0;
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

//    console.log("drawCursor: frequency=",this.frequency," bin=",this.hz_to_bin(this.frequency)," amp=",bins[this.hz_to_bin(this.frequency)]);
    

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
    //console.log("Min hold bin ", this.binsMin.length/2, "= ", this.binsMin[this.binsMin.length/2]);
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
    var step = this.graticuleIncrement; // 5 or 10 dB depending on range of the spectrum
    // Start at the nearest lower multiple of step (e.g., -120, -110, etc.)
    var firstLine = Math.ceil(this.min_db / step) * step;
    for (var i = firstLine; i <= this.max_db - step; i += step) {
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
          inc=25000;
          break;
        case 400:
          inc=50000;
          break;
        case 800:
          inc=100000;
          break;
        case 1000:
          inc=100000;
          break;
        case 2000:
          inc=250000;
          break;
        case 4000:
          inc=500000;
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

    //console.log("inc=",inc,"spanHz=",this.spanHz,"nbins=",this.nbins,"this.spanHz/this.nbins=",this.spanHz/this.nbins);
    var precision = 3;
    if((this.highHz - this.lowHz) < 10000)  // 10kHz
        precision = 4;
    else
        precision = 3;
    var freq=this.start_freq-(this.start_freq%inc);
    var text;
    while(freq<=this.highHz) {
        this.ctx_axes.textAlign = "center";
        var x = (freq-this.start_freq)/hz_per_pixel;
        text = freq / 1e6;
        //this.ctx_axes.fillText(text.toFixed(3), x, height);
        this.ctx_axes.fillText(text.toFixed(precision), x, 2);
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

        // attempt to autoscale based on the min/max of the current spectrum
        // should pick reasonable scale in 5 dB increments
        const maxAutoscaleWait = 5; // Do autoscale for maxAutoscaleWait iterations of data before settling on one value for min max

        // this.autoscale = true; this.autoscaleWait = 100; // for testing, run it all the time with N0 as the min

        if (this.autoscale) {
            //if((this.autoscaleWait < maxAutoscaleWait) && !zoomControlActive) {  // Wait a maxAutoscaleWait cycles before you do the autoscale to allow spectrum to settle (agc?)
            //console.log("addData - this.autoscaleWait= ",this.autoscaleWait.toString());
            if(this.autoscaleWait < maxAutoscaleWait) {
                this.autoscaleWait++;
                //console.log("autoscaleWait ", this.autoscaleWait.toString()," zoomControlActive=", zoomControlActive," this.minimum= ", (typeof this.minimum === "number" ? this.minimum.toFixed(1) : this.minimum),  " this.maximum= ", (typeof this.maximum === "number" ? this.maximum.toFixed(1) : this.maximum));
                this.drawSpectrumWaterfall(data,true);
                return;
            }
            else
                //console.log("autoscaleWait ",this.autoscaleWait.toString()," zoomControlActive=",zoomControlActive);
            if(this.autoscaleWait >= maxAutoscaleWait)  // Clear the flags for waiting and autoscaling
            {
                this.autoscaleWait = 0; // Reset the flags and counters, we're going to autoscale now!
                this.autoscale = false;
                this.drawSpectrumWaterfall(data,true);
            }
        }
        this.drawSpectrumWaterfall(data,false);  // true means get new min max
    }
}

Spectrum.prototype.drawSpectrumWaterfall = function(data,getNewMinMax) 
{
        const useN0 = false;
        if(getNewMinMax){
            if(useN0) {
                this.minimum = Math.round(noise_density_audio) + 17;
                this.maximum = this.wholeSpectrumMax = Math.round(Math.max(...this.bin_copy));
                this.setRange(this.minimum,this.maximum + 5, true,12);  // Bias max up so peak isn't touching top of graph,  // Just set the range to what it was???
            }
            else{ 
                this.measureMinMaxSdev(data);
                this.setRange(Math.round(this.minimum) -7, this.maximum, true, 13); // Bias max up so peak isn't touching top of graph, bias the wf floor also to darken wf
            }
        }
        this.drawSpectrum(data);
        this.addWaterfallRow(data);
        this.resize();
}
Spectrum.prototype.measureMinMaxSdev = function(data) {
            var increment = 5.0;    // range scaling increment in dB
            var currentFreqBin = this.hz_to_bin(this.frequency);
            var binsToBracket = 200;  // Math.floor(this.bins / this.spanHz * frequencyToBracket);
            var lowBin = Math.max(20, currentFreqBin - binsToBracket); // binsToBracket bins to the left of the current frequency
            var highBin = Math.min(this.nbins-20, currentFreqBin + binsToBracket); // binsToBracket bins to the right of the current frequency
            //console.log("currentFreqBin=",currentFreqBin," binsToBracket=", binsToBracket," lowBin=", lowBin, " highBin=", highBin);

            var computeMean = true; // true = mean, false = median
            var data_min = 0;   // Initialize the min and max to the first bin in the range to avoid a divide by zero
            var data_max = 0;
            var data_peak = 0;
            var data_stat_low = 0;

            // Find the baseline and it's standard deviation
            var min_baseline = Infinity;
            var min_mean_index = -1;
            this.std_dev = 0;
            for (var i = lowBin; i < highBin; i++) {
                let values = [
                    data[i - 10], data[i - 9], data[i - 8], data[i - 7], data[i - 6],
                    data[i - 5], data[i - 4], data[i - 3], data[i - 2], data[i - 1],
                    data[i], data[i + 1], data[i + 2], data[i + 3], data[i + 5], data[i + 6], data[i + 7], data[i + 8], data[i + 9], data[i + 10]];
                
                if(computeMean)
                    data_stat_low = values.reduce((a, b) => a + b, 0) / values.length;   // Average +/- N bins for the mean
                else {
                    let sorted = values.slice().sort((a, b) => a - b);  // Compute the median instead of the average
                    let mid = Math.floor(sorted.length / 2);
                    let median;
                     if (sorted.length % 2 === 0) {
                        median = (sorted[mid - 1] + sorted[mid]) / 2;
                    } else {
                        median = sorted[mid];
                    }
                    data_stat_low = median;
                }   
                data_peak = data[i];            // keep the peaks
                if (data_stat_low < min_baseline) { // find the minimum baseline value for this series of bins (20 bins) 
                    min_baseline = data_stat_low;   // If lower than the previous min, set it
                    min_mean_index = i;         // Save the index of the bin with the minimum value
                }
                if (i == lowBin) {
                    data_max = data_peak;       // First bin in the range gets the max value
                    data_min = 0; //data_stat_low;;
                } else {
                    data_min = Math.min(data_min, data_stat_low);   // Find the minimum value in the range around the bins
                    data_max = Math.max(data_max, data_peak);       // Find the maximum value in the range around the bins
                }
            }

            // We now have the min, max and statistic representing baseline in the range of bins we're looking at across the spectrum (400 bins)

            // Find the standard deviation at 20 bins around the minimum baseline bin that we've identified above
            if (min_mean_index !== -1) {
                let values = [
                    data[min_mean_index - 10], data[min_mean_index - 9], data[min_mean_index - 8], data[min_mean_index - 7], data[min_mean_index - 6],
                    data[min_mean_index - 5], data[min_mean_index - 4], data[min_mean_index - 3], data[min_mean_index - 2], data[min_mean_index - 1],
                    data[min_mean_index], data[min_mean_index + 1], data[min_mean_index + 2], data[min_mean_index + 3], data[min_mean_index + 5],
                    data[min_mean_index+6], data[min_mean_index + 7], data[min_mean_index + 8], data[min_mean_index + 9], data[min_mean_index + 10]];
                let mean = min_baseline;
                let variance = values.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / values.length;
                this.std_dev = Math.sqrt(variance);

                //console.log("Standard Deviation: ", std_dev.toFixed(2)," at min bin: ",min_mean_index);
            }

            // data_stat_low is a statistically computed level for the baseline over 400 bins, the smoothed baseline for this instant in time
            // data_min is the minimum value in the range of bins we're looking at (400 bins), not smoothed, just the minimum value for this instant in time

            // Find the max along the whole spectrum, outside the min_bin to max_bin range of data
            this.wholeSpectrumMax = Math.max(...this.bin_copy);      // We need to only do this once at the start or end
            
            //console.log("data_min=", data_min.toFixed(1), " data_max=", data_max.toFixed(1),"wholeSpectrumMax=", wholeSpectrumMax.toFixed(1));

            if (!isNaN(this.wholeSpectrumMax))
            {
                //console.log("this.wholeSpectrumMax is good");
                if(this.wholeSpectrumMax > data_max)
                {
                    //console.log("this.wholeSpectrumMax is bigger, use it");
                    data_max = this.wholeSpectrumMax;    
                }
            }

            // Now we have a data_max for the whole spectrum, a data_min, and a data_stat_low (median baselne) for the range of bins we're looking at around the tuned frequency

            // Update the min / max

            //var minimum = Math.floor(data_min / increment) * increment - increment + (Math.abs(std_dev - 5) < Math.abs(std_dev - 10) ? 5 : 10); //If std_dev is closer to 5, add 5; if closer to 10, add 10.
            //var minimum = Math.floor(data_min / increment) * increment - increment + Math.round(std_dev/2.0);

            // With a disconnected antenna on 10m with just "radio noise", the data_min varies less than data_stat_low, so use that for the min and bias it with the sdev
            //this.minimum = Math.round(data_min) - Math.round(this.std_dev/3.0) - 3; // local bias here wdr
            this.minimum = data_min;    // Pick the data_min, which is raw min over 400 bins, don't bias it here, bias in drawSpectrumWaterfall
            this.maximum = increment * Math.ceil(data_max / increment) + increment; // was using the peak inside the bin high low range, now use all visible spectral data
            // this.maximum = -80;  // just for by eye testing, need to remove this wdr
            const minimum_spectral_gain = -80;
            if(this.maximum < minimum_spectral_gain)  // Don't range too far into the weeds.
                this.maximum = minimum_spectral_gain;
            //console.log("data_min =",data_min.toFixed(1),"data_stat_low = ",data_stat_low.toFixed(1)," minimum=", this.minimum.toFixed(1), " maximum=", this.maximum," sdev=", this.std_dev.toFixed(2));
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

Spectrum.prototype.setRange = function(min_db, max_db, adjust_waterfall,wf_min_adjust) {
    //console.log("spectum.setRange min_db: ",min_db," max_db",max_db);
    this.min_db = min_db;
    this.max_db = max_db;
    document.getElementById("spectrum_min").value = min_db;
    document.getElementById("spectrum_max").value = max_db;
    
    if(this.max_db > (this.min_db) + 50) // set the number of graticule lines based on the range
        this.graticuleIncrement = 10;
    else
        this.graticuleIncrement = 5;

    // console.log("spectrum.setRange min_db: ",this.min_db," max_db: ",this.max_db," wf min adjust: ",wf_min_adjust," graticuleIncrement: ",this.graticuleIncrement);   

    if (adjust_waterfall) {
        this.wf_min_db = min_db + wf_min_adjust;    // min_db + stdev of the min? 
        this.wf_max_db = max_db;
        //console.log("adjust_waterfall true, min_adjust = ",wf_min_adjust," min to: ",this.wf_min_db,"Max to: ",this.wf_max_db);
    }
    this.updateAxes();
    this.saveSettings();
}

Spectrum.prototype.baselineUp = function() {
    this.min_db -=5;
    this.updateAxes();
    document.getElementById("spectrum_min").value = this.min_db;
    //this.setRange(this.min_db - 5, this.max_db - 5, false,0);
    this.saveSettings();
}

Spectrum.prototype.baselineDown = function() {
    this.min_db +=5;
    this.updateAxes();
    document.getElementById("spectrum_min").value = this.min_db;
    //this.setRange(this.min_db + 5, this.max_db + 5, false,0);
    this.saveSettings();
}

Spectrum.prototype.rangeIncrease = function() {
    this.setRange(this.min_db, this.max_db + 5, false,0);  // was true wdr
    this.saveSettings();
}

Spectrum.prototype.rangeDecrease = function() {
    if (this.max_db - this.min_db > 10)
        this.setRange(this.min_db, this.max_db - 5, false,0); // was true wdr
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
    //console.log("setAveraging: ", this.averaging + " calling this.saveSettings()");
    this.saveSettings();
}

Spectrum.prototype.setDecay = function(num) {
    this.decay = num;
    this.saveSettings();
}

Spectrum.prototype.incrementAveraging = function() {
    this.setAveraging(this.averaging + 1);
}

Spectrum.prototype.decrementAveraging = function() {
    if (this.averaging > 0) {
        this.setAveraging(this.averaging - 1);
    }
}

Spectrum.prototype.togglePaused = function() {
    this.paused = !this.paused;
    document.getElementById("pause").textContent = (this.paused ? "Spectrum Run" : "Spectrum Pause");
    this.saveSettings();
}

Spectrum.prototype.setMaxHold = function(maxhold) {
    this.maxHold = maxhold;
    //console.log(`spectrum.setmaxhold: Max Hold set to ${this.maxHold}`);

    this.binsMax = undefined;   // Clear the max hold bins when toggling max hold (for Glenn wdr)
    this.binsMin = undefined;
    this.saveSettings();
}

// Need to get rid of this togglemaxhold function and make it work like the show max show min checkboxes / saving to settings
/*
Spectrum.prototype.toggleMaxHold = function() {
    const maxHoldCheckbox = document.getElementById("max_hold");
    if (maxHoldCheckbox) {
        this.maxHold = maxHoldCheckbox.checked; // Update the Spectrum object's maxHold property
        console.log(`Max Hold checkbox is ${this.maxHold ? "checked" : "unchecked"}`);
    }
    this.saveSettings();
}
*/

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

Spectrum.prototype.forceAutoscale = function(autoScaleCounterStart,waitToAutoscale = true) {
    this.autoscale = true;
    if(waitToAutoscale)
        this.autoscaleWait = autoScaleCounterStart; // We're gonna run live up to maxAutoscaleWait
    else
        this.autoscaleWait = 100;  // not gonna wait
    // console.log("forceAutoscale(), autoscaleWait set to ", this.autoscaleWait," waitToAutoscale= ", waitToAutoscale);
}

Spectrum.prototype.onKeypress = function(e) {
    if (e.key == " ") {
        this.togglePaused();
    } else if (e.key == "f") {
        this.toggleFullscreen();
    } else if (e.key == "c") {
        this.toggleColor();
    } else if (e.key == "ArrowUp") {
        this.baselineUp();
    } else if (e.key == "ArrowDown") {
        this.baselineDown();
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
    this.graticuleIncrement = 5;  // Default value for graticule spacing

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
    this.colorindex = 9;                // Default colormap index to Kiwi
    this.colormap = colormaps[9];

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

    // Drag spectrum with right mouse button

    let isDragging = false;
    let dragStarted = false;
    let dragThreshold = 4; // pixels
    let startX = 0;
    let startY = 0;
    let startCenterHz = 0;
    let pendingCenterHz = null;
    const spectrum = this;

    this.canvas.addEventListener('mousedown', function(e) {
        if (e.button === 0) { // Left mouse button: tune instantly
            const rect = spectrum.canvas.getBoundingClientRect();
            const mouseX = e.offsetX;
            const hzPerPixel = spectrum.spanHz / spectrum.canvas.width;
            let clickedHz = spectrum.centerHz - ((spectrum.canvas.width / 2 - mouseX) * hzPerPixel);
            let freq_khz = clickedHz / 1000;
            let step = 0.5;
            let snapped_khz = Math.ceil(freq_khz / step) * step;
            document.getElementById("freq").value = snapped_khz.toFixed(3);
            ws.send("F:" + snapped_khz.toFixed(3));
            spectrum.frequency = snapped_khz * 1000;
            if (spectrum.bin_copy) {
                spectrum.drawSpectrumWaterfall(spectrum.bin_copy, false);
            }
        } else if (e.button === 2) { // Right mouse button: start drag, move cursor to center
            isDragging = true;
            dragStarted = false;
            startX = e.offsetX;
            startY = e.offsetY;
            startCenterHz = spectrum.centerHz;
            pendingCenterHz = null;
            // Move cursor to center immediately
            spectrum.frequency = spectrum.centerHz;
            document.getElementById("freq").value = (spectrum.centerHz / 1000).toFixed(3);
            ws.send("F:" + (spectrum.centerHz / 1000).toFixed(3));
            ws.send("Z:c");
            spectrum.canvas.style.cursor = "grabbing";
            e.preventDefault(); // Prevent context menu
        }
    });

    // Prevent context menu on right click
    this.canvas.addEventListener('contextmenu', function(e) {
        e.preventDefault();
    });

    window.addEventListener('mousemove', function(e) {
        // Only process if right mouse button is being dragged
        if (!isDragging || (e.buttons & 2) === 0) return;
        const rect = spectrum.canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const dx = mouseX - startX;
        if (!dragStarted && Math.abs(dx) > dragThreshold) {
            dragStarted = true;
        }
        if (!dragStarted) return; // Don't start drag logic until threshold passed

        const hzPerPixel = spectrum.spanHz / spectrum.canvas.width;
        pendingCenterHz = startCenterHz - dx * hzPerPixel;
        spectrum.setCenterHz(pendingCenterHz);

        // Keep cursor at center
        spectrum.frequency = pendingCenterHz;
        document.getElementById("freq").value = (pendingCenterHz / 1000).toFixed(3);
        ws.send("F:" + (pendingCenterHz / 1000).toFixed(3));
        ws.send("Z:c");

        if (spectrum.bin_copy) {
            spectrum.drawSpectrumWaterfall(spectrum.bin_copy, false);
        }
    });

    window.addEventListener('mouseup', function(e) {
        if (isDragging && e.button === 2) {
            spectrum.canvas.style.cursor = "";
            if (pendingCenterHz !== null && dragStarted) {
                // Snap centerHz to next 0.500 kHz step
                let freq_khz = pendingCenterHz / 1000;
                let step = 0.5;
                let snapped_center = Math.ceil(freq_khz / step) * step * 1000;
                spectrum.setCenterHz(snapped_center);

                // Keep cursor at center
                spectrum.frequency = snapped_center;
                document.getElementById("freq").value = (snapped_center / 1000).toFixed(3);
                ws.send("F:" + (snapped_center / 1000).toFixed(3));
                ws.send("Z:c");
            }
            isDragging = false;
            dragStarted = false;
            pendingCenterHz = null;
        }
    });

}
