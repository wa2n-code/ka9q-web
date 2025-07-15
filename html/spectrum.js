'use strict';

/**
 * Spectrum constructor function.
 *
 * Creates a new Spectrum display instance, initializing all state, canvases, and event handlers for spectrum and waterfall visualization.
 *
 * @constructor
 * @param {string} id - The DOM element ID of the main canvas to use for the spectrum display.
 * @param {Object} [options] - Optional configuration object.
 * @param {number} [options.centerHz=0] - Initial center frequency in Hz.
 * @param {number} [options.spanHz=0] - Initial frequency span in Hz.
 * @param {number} [options.wf_size=0] - Number of FFT bins (width of the waterfall).
 * @param {number} [options.wf_rows=256] - Number of rows in the waterfall display.
 * @param {number} [options.spectrumPercent=50] - Percentage of the canvas height used for the spectrum display.
 * @param {number} [options.spectrumPercentStep=5] - Step size for changing spectrum height percentage.
 * @param {number} [options.averaging=0] - FFT averaging factor.
 * @param {boolean} [options.maxHold=false] - Whether max hold is enabled initially.
 * @param {number} [options.bins=false] - Number of FFT bins.
 *
 * @description
 * Initializes the spectrum and waterfall canvases, sets up default display parameters, and attaches mouse and keyboard event handlers for user interaction.
 * Handles spectrum display, waterfall rendering, autoscaling, color maps, and user controls for tuning and zooming.
 * Also handles overlay trace functionality for importing, exporting, and displaying spectrum data.
 */
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
    this.freezeMinMax = false; // Flag to freeze min/max 
    this.decay = 1.0;
    this.cursor_active = false;
    this.cursor_step = 1000;
    this.cursor_freq = 10000000;

    this.radio_pointer = undefined;

    // Trigger first render
    this.setAveraging(this.averaging);
    this.updateSpectrumRatio();
    this.resize();
    
    // Initialize overlay trace functionality
    this._overlayTrace = null;
    
    // Setup overlay buttons if they exist in the DOM
    var self = this;
    
    // Try to set up buttons immediately if DOM is already loaded
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        setTimeout(function() {
            //console.log('DOM already ready, setting up overlay buttons');
            if (typeof self.setupOverlayButtons === 'function') {
                self.setupOverlayButtons();
            }
        }, 100);
    }
    
    // Also set up on DOMContentLoaded in case we're still loading
    document.addEventListener('DOMContentLoaded', function() {
        setTimeout(function() {
            //console.log('DOMContentLoaded fired, setting up overlay buttons');
            if (typeof self.setupOverlayButtons === 'function') {
                self.setupOverlayButtons();
            }
        }, 100); // Small delay to ensure DOM is fully loaded
    });

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
        if (e.button === 0) { // Left mouse button: tune instantly or set cursor
            const rect = spectrum.canvas.getBoundingClientRect();
            const mouseX = e.offsetX;
            const hzPerPixel = spectrum.spanHz / spectrum.canvas.width;
            let clickedHz = spectrum.centerHz - ((spectrum.canvas.width / 2 - mouseX) * hzPerPixel);
            let freq_khz = clickedHz / 1000;
            let step = increment / 1000; 
            let snapped_khz = Math.round(freq_khz / step) * step;

            if (spectrum.cursor_active) {
                // Set the cursor frequency instead of tuning
                spectrum.cursor_freq = clickedHz;
                if (spectrum.bin_copy) {
                    spectrum.drawSpectrumWaterfall(spectrum.bin_copy, false);
                }
            } else {
                document.getElementById("freq").value = snapped_khz.toFixed(3);
                ws.send("F:" + snapped_khz.toFixed(3));
                spectrum.frequency = snapped_khz * 1000;
                if (spectrum.bin_copy) {
                    spectrum.drawSpectrumWaterfall(spectrum.bin_copy, false);
                }
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
                let step = increment / 1000  
                let snapped_center = Math.round(freq_khz / step) * step * 1000;
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

Spectrum.prototype.setFrequency = function(freq) {
    this.frequency=freq;
}

Spectrum.prototype.setFilter = function(low,high) {
    this.filter_low=low;
    this.filter_high=high;
}


/*The `squeeze` function maps a dB value (signal level) to a vertical pixel position on the spectrum display, based on the current dB range.
- **Inputs:**
  - `value`: The dB value to map (e.g., a signal level).
  - `out_min`: The minimum output (usually the bottom pixel of the axis).
  - `out_max`: The maximum output (usually the top pixel of the axis).
- **Behavior:**
  - If `value` is below the minimum dB (`min_db`), it returns `out_min`.
  - If `value` is above the maximum dB (`max_db`), it returns `out_max`.
  - Otherwise, it linearly maps `value` from the range `[min_db, max_db]` to `[out_min, out_max]`.

- Used to convert a dB value to a y-pixel position for drawing spectrum lines, labels, or other graphics on the canvas.

`squeeze` converts a dB value to a vertical pixel position on the spectrum display, respecting the current dB range.
*/
Spectrum.prototype.squeeze = function(value, out_min, out_max) {
    if (value <= this.min_db)
        return out_min;
    else if (value >= this.max_db)
        return out_max;
    else
        return Math.round((value - this.min_db) / (this.max_db - this.min_db) * out_max);
}

/**
 * Converts an array of FFT bin dB values into color-mapped image data for a single row of the waterfall display.
 *
 * @function
 * @param {Array<number>} bins - Array of dB values for each FFT bin (spectrum data).
 *
 * @description
 * For each FFT bin value in the input array, this function:
 * - Scales the dB value to a normalized range based on the current waterfall min/max dB settings.
 * - Maps the scaled value to a color index in the current colormap.
 * - Sets the corresponding RGBA values in the `imagedata` buffer for the waterfall row.
 * Handles out-of-range and colormap errors gracefully by using the last color in the colormap.
 * The resulting `imagedata` can be rendered onto the waterfall canvas to visualize signal intensity.
 */
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

/**
 * Adds a new row of FFT bin data to the waterfall display and updates the main canvas.
 *
 * @function
 * @param {Array<number>} bins - Array of dB values for each FFT bin (spectrum data).
 *
 * @description
 * This function manages the scrolling waterfall display:
 * - Optionally skips rows for decimation, based on the global `window.skipWaterfallLines` setting.
 * - Shifts the existing waterfall image down by one row.
 * - Converts the new FFT bin data into color-mapped image data and draws it as the top row of the waterfall.
 * - Copies the updated waterfall image to the main spectrum canvas, scaling as needed.
 * - Resets the internal line decimation counter to avoid overflow.
 */
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

/**
 * Draws the FFT (Fast Fourier Transform) trace on the spectrum display canvas.
 *
 * @function
 * @param {Array<number>} bins - Array of dB values for each FFT bin (spectrum data).
 * @param {string} color - The color to use for the FFT trace (CSS color string).
 *
 * @description
 * This function renders the spectrum trace as a polyline on the main canvas:
 * - Converts dB values to vertical pixel positions based on the current dB range and spectrum height.
 * - Draws the trace from left to right, connecting each FFT bin value.
 * - Fills the area under the trace to the bottom of the spectrum display.
 * - Sets the stroke style to the specified color for the trace.
 * The function is used to display the live spectrum, max hold, and min hold traces.
 */
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
    // Check if No Spectrum Fill is enabled
    var noSpectrumFill = document.getElementById("ckNoSpectrumFill") && document.getElementById("ckNoSpectrumFill").checked;
    
    this.ctx.beginPath();
    
    if (!noSpectrumFill) {
        // Original behavior - start at the bottom left for filling
        this.ctx.moveTo(-1, this.spectrumHeight + 1);
    }
    
    var max_s=0;
    for(var i=0; i<bins.length; i++) {
        var s = bins[i];
        // newell 12/1/2024, 10:16:13
        // With the spectrum bin amplitude ranging from -120 to 0 dB or so
        // this needs to flip to draw the spectrum correctly
        s = (s-this.min_db)*dbm_per_line;
        s = this.spectrumHeight-s;
        
        // For the first point
        if(i==0) {
            if (noSpectrumFill) {
                // If no fill, start directly at the first data point
                this.ctx.moveTo(-1, s);
            }
            this.ctx.lineTo(-1, s);
        }
        
        this.ctx.lineTo(i, s);
        
        if (i==bins.length-1) this.ctx.lineTo(this.wf_size+1, s);
        
        if(s>max_s) {
          max_s=s;
        }
    }
    
    // Only close the path to the bottom if we're filling
    if (!noSpectrumFill) {
        this.ctx.lineTo(this.wf_size+1, this.spectrumHeight+1);
    }
    
    this.ctx.strokeStyle = color;
    this.ctx.stroke();
}

/**
 * Draws the filter region on the spectrum display.
 *
 * @function
 * @param {Array<number>} bins - Array of dB values for each FFT bin (spectrum data).
 *
 * @description
 * This function highlights the frequency range between the filter's low and high cutoff values
 * by drawing a filled rectangle on the spectrum display. The filter region is calculated based
 * on the current center frequency, span, and filter settings, and is rendered as a shaded area
 * to visually indicate the active filter bandwidth.
 */
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

/**
 * Draws a vertical cursor line at the specified frequency on the spectrum display.
 *
 * @function
 * @param {number} f - The frequency (in Hz) at which to draw the cursor.
 * @param {Array<number>} bins - Array of dB values for each FFT bin (spectrum data).
 * @param {string} color - The color to use for the cursor line (CSS color string).
 * @param {number} [amp] - Optional. The amplitude (dB) at the cursor frequency. If provided, a horizontal tick mark is drawn at this amplitude.
 *
 * @description
 * This function draws a vertical line at the specified frequency to indicate the current tuning or cursor position.
 * If the amplitude (`amp`) is provided, it also draws a horizontal tick mark at the corresponding dB level.
 * The cursor is rendered using the specified color for clear visual distinction.
 */
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

/**
 * Draws the spectrum display on the main canvas using the provided FFT bin data.
 *
 * @function
 * @param {Array<number>} bins - Array of dB values for each FFT bin (spectrum data).
 *
 * @description
 * This function renders the spectrum trace and overlays on the main canvas:
 * - Fills the background with black.
 * - Applies FFT averaging and max/min hold if enabled.
 * - Draws the filter region, main frequency cursor, and optional user cursor.
 * - Renders the live spectrum trace, max hold, and min hold traces as enabled.
 * - Applies a color gradient fill under the spectrum trace.
 * - Copies the axes from the offscreen axes canvas onto the main canvas.
 */
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
                if(!this.freezeMinMax) {                // Only update max if not frozen
                    if (bins[i] > this.binsMax[i]) {
                        this.binsMax[i] = bins[i];
                    } else {
                        // Decay
                        this.binsMax[i] = this.decay * this.binsMax[i];
                    }
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
                if(!this.freezeMinMax) {                // Only update min if not frozen
                    if (bins[i] < this.binsMin[i]) {
                        this.binsMin[i] = bins[i];
                    } else {
                        // Decay
                        this.binsMin[i] = this.binsMin[i];
                    }
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

    // console.log("drawCursor: frequency=",this.frequency," bin=",this.hz_to_bin(this.frequency)," amp=",bins[this.hz_to_bin(this.frequency)]);
    // draw cursor
    if (this.cursor_active)
        this.drawCursor(this.cursor_freq, bins, "#00ffff", bins[this.hz_to_bin(this.cursor_freq)]);

    if (true == document.getElementById("freeze_min_max").checked){
        this.freezeMinMax = true;
    } else {
        this.freezeMinMax = false;
    }
 
    // Draw maxhold
    if ((this.maxHold) && (true == document.getElementById("check_max").checked)) {
        this.ctx.fillStyle = "none";
        this.drawFFT(this.binsMax,"#ffff00");
    }



    // Draw maxhold
    if ((this.maxHold) && (true == document.getElementById("check_max").checked)) {
        this.ctx.fillStyle = "none";
        this.drawFFT(this.binsMax,"#ffff00");
    }

    if (true == document.getElementById("check_live").checked){
        // Draw FFT bins
        this.drawFFT(bins,"#ffffff");
        
        // Only fill if No Spectrum Fill is not checked
        var noSpectrumFill = document.getElementById("ckNoSpectrumFill") && document.getElementById("ckNoSpectrumFill").checked;
        if (!noSpectrumFill) {
            // Fill scaled path
            this.ctx.fillStyle = this.gradient;
            this.ctx.fill();
        }
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

/**
 * Updates and redraws the axes for the spectrum display.
 *
 * @function
 *
 * @description
 * Clears and redraws the axes canvas, including:
 * - Horizontal dB grid lines and labels, spaced according to the current dB range and graticule increment.
 * - Vertical frequency grid lines and labels, spaced according to the current frequency span and bin width.
 * - Frequency labels are placed at the top; dB labels are placed along the left, avoiding overlap with frequency labels.
 * This function ensures the axes reflect the current frequency span, dB range, and canvas size.
 */
Spectrum.prototype.updateAxes = function() {
    var width = this.ctx_axes.canvas.width;
    var height = this.ctx_axes.canvas.height;

    // Clear axes canvas
    this.ctx_axes.clearRect(0, 0, width, height);

    this.start_freq = this.centerHz - (this.spanHz / 2);
    var hz_per_pixel = this.spanHz / width;

    // Draw axes
    this.ctx_axes.font = "12px sans-serif";
    this.ctx_axes.fillStyle = "white";
    this.ctx_axes.textBaseline = "middle";

    this.ctx_axes.textAlign = "left";
    var step = this.graticuleIncrement;
    var firstLine = Math.ceil(this.min_db / step) * step;

    // --- Calculate frequency label area at the top ---
    // Assume frequency text is drawn at y = 2, height ~ font size (12px)
    const freqLabelY = 2;
    const freqLabelHeight = 12; // px, adjust if your font size changes
    const freqLabelBottom = freqLabelY + freqLabelHeight;

    for (var i = firstLine; i <= this.max_db; i += step) {
        var sqz = this.squeeze(i, 0, height);
        var y = height - sqz;

        // Only draw dB label if it won't overlap the frequency label area at the top
        if (y > freqLabelBottom + 2) { // +2px margin
            this.ctx_axes.fillText(i, 5, y);
        }
        // Always draw the horizontal line
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

    // The variable inc determines the frequency spacing between vertical grid lines and frequency labels on the spectrum display
    var freq=this.start_freq-(this.start_freq%inc); // aligns the first frequency grid line to the nearest lower multiple of inc.
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



/**
 * Adds new FFT bin data to the spectrum display and updates the visualization.
 *
 * @function
 * @param {Array<number>} data - Array of dB values for each FFT bin (spectrum data).
 *
 * @description
 * This function is called whenever new spectrum data is available. It:
 * - Checks if the spectrum display is paused; if so, does nothing.
 * - Stores a copy of the latest bin data and updates the number of bins.
 * - If autoscaling is enabled, may wait a few cycles for the spectrum to settle before applying autoscale.
 * - Calls `drawSpectrumWaterfall()` to update the spectrum and waterfall displays, optionally triggering autoscale.
 */
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
                //console.log("autoscaleWait ", this.autoscaleWait.toString()," this.minimum= ", (typeof this.minimum === "number" ? this.minimum.toFixed(1) : this.minimum),  " this.maximum= ", (typeof this.maximum === "number" ? this.maximum.toFixed(1) : this.maximum));
                this.autoscaleWait++;
                this.drawSpectrumWaterfall(data,false);  //wdr, don't get new min max spectrum may not have stabilized, just draw the spectrum and waterfall
                return;
            }
            //else
            //    console.log("autoscaleWait ",this.autoscaleWait.toString()," zoomControlActive=",zoomControlActive);
            if(this.autoscaleWait >= maxAutoscaleWait)  // Clear the flags for waiting and autoscaling
            {
                this.autoscaleWait = 0; // Reset the flags and counters, we're going to autoscale now!
                this.autoscale = false;
                //console.log("addData: autoscaleWait >= maxAutoscaleWait, now drawSpectrumWaterfall true");
                this.drawSpectrumWaterfall(data,true); // now get new min max, we've waited through 5 spectrum updates
            }
        }
        else {
            //console.log("addData: this.autoscale=false, just drawSpectrumWaterfall");
            this.drawSpectrumWaterfall(data,false);  // Draw the spectrum and waterfall, don't get new min max
        }
    }
}

/**
 * Renders the spectrum and waterfall displays using the provided FFT bin data.
 *
 * @function
 * @param {Array<number>} data - Array of dB values for each FFT bin (spectrum data).
 * @param {boolean} getNewMinMax - If true, measure and update the min/max dB values for autoscaling.
 *
 * @description
 * This function draws both the spectrum and waterfall displays:
 * - If `getNewMinMax` is true, it measures the minimum and maximum dB values in the data and updates the display range for autoscaling.
 * - Calls `drawSpectrum` to render the spectrum trace.
 * - Calls `addWaterfallRow` to add a new row to the waterfall display.
 * - Calls `resize` to ensure the display is properly sized.
 * The function applies optional biases to the spectrum and waterfall ranges for optimal visual presentation.
 */
Spectrum.prototype.drawSpectrumWaterfall = function(data,getNewMinMax) 
{
        const useN0 = false;
        const rangeBias = -5;       // Bias the spectrum and waterfall range by this amount 
        const waterfallBias = 11;    // Further bias the waterfall range by this amount
        if(getNewMinMax){
            if(useN0) { // N0 took too long to settle...
                this.minimum = Math.round(noise_density_audio) + 17;
                this.maximum = this.wholeSpectrumMax = Math.round(Math.max(...this.bin_copy));
                this.setRange(this.minimum,this.maximum + 5, true,12);  // Bias max up so peak isn't touching top of graph,  // Just set the range to what it was???
            }
            else{ 
                this.measureMinMax(data);
                //console.log("drawSpectrumWaterfall: this.minimum=", this.minimum.toFixed(1), " this.maximum=", this.maximum.toFixed(1),"getNewMinMax=", getNewMinMax);
                this.setRange(Math.round(this.minimum) + rangeBias, this.maximum, true, waterfallBias); // Bias max up so peak isn't touching top of graph, bias the wf floor also to darken wf
            }
        }
        this.drawSpectrum(data);
        this.addWaterfallRow(data);
        this.resize();
}

/**
 * Analyze a region of the spectrum data to determine the minimum (noise floor) and maximum (peak) dB values.
 * 
 * - The function examines a window of bins centered around the current tuned frequency.
 * - For each bin in this window, it computes a smoothed minimum using either the mean or median of neighboring bins.
 * - The maximum is taken as the highest value found in the window, but can be overridden by the global spectrum maximum.
 * - The results are used to set the display range for the spectrum and waterfall.
 * 
 * This helps autoscale the display so that the noise floor and peaks are always visible and well-framed.
 *
 * @param {Array<number>} data - Array of dB values for each FFT bin.
 */
Spectrum.prototype.measureMinMax = function(data) {
            var range_scale_increment = 5.0;    // range scaling increment in dB
            var currentFreqBin = this.hz_to_bin(this.frequency);
            var binsToBracket = 1600;  // look at the whole spectrum   // Math.floor(this.bins / this.spanHz * frequencyToBracket);
            var lowBin = Math.max(20, currentFreqBin - binsToBracket); // binsToBracket bins to the left of the current frequency
            var highBin = Math.min(this.nbins-20, currentFreqBin + binsToBracket); // binsToBracket bins to the right of the current frequency
            //console.log("currentFreqBin=",currentFreqBin," binsToBracket=", binsToBracket," lowBin=", lowBin, " highBin=", highBin);

            var computeMean = true; // true = mean, false = median
            var data_min = 0;   // Initialize the min and max to the first bin in the range to avoid a divide by zero
            var data_max = 0;
            var data_peak = 0;
            var data_stat_low = 0;

            // Find the baseline min value in the range of bins we're looking at
            this.std_dev = 0;
            for (var i = lowBin; i < highBin; i++) {
                let values = [
                    data[i - 10], data[i - 9], data[i - 8], data[i - 7], data[i - 6],
                    data[i - 5], data[i - 4], data[i - 3], data[i - 2], data[i - 1],
                    data[i], data[i + 1], data[i + 2], data[i + 3], data[i + 5], data[i + 6], data[i + 7], data[i + 8], data[i + 9], data[i + 10]];
                if(computeMean)
                    data_stat_low = values.reduce((a, b) => a + b, 0) / values.length;   // Average +/- N bins for the mean, output on data_stat_low
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
                if (i == lowBin) {
                    data_max = data_peak;       // First bin in the range gets the max value
                    data_min = 0;               // initialize the min to zero, which is actually very high!
                } else {
                    data_min = Math.min(data_min, data_stat_low);   // Update the minimum value from the smoothed min if lower this time
                    data_max = Math.max(data_max, data_peak);       // Find the maximum value in the range around the bins
                }
            }

            // We now have the smoothed min and max in the range of bins we're looking at across the spectrum (400 bins)

            // Find the max along the WHOLE spectrum, outside the min_bin to max_bin range of data
            this.wholeSpectrumMax = Math.max(...this.bin_copy);      // We need to only do this once
            
            //console.log("data_min=", data_min.toFixed(1), " data_max=", data_max.toFixed(1),"wholeSpectrumMax=", wholeSpectrumMax.toFixed(1));

            // If the whole spectrum is good, then use the wholeSpectrumMax if it's greater than the data_max over the 400 bin range around the tuned frequency
            if (!isNaN(this.wholeSpectrumMax))
            {
                if(this.wholeSpectrumMax > data_max)
                {
                    //console.log("this.wholeSpectrumMax is bigger, use it");
                    data_max = this.wholeSpectrumMax;    
                }
            }

            // Now we have a data_max for the whole spectrum, and a data_min that's the smoothed min over 20 bins around the tuned frequency

            // Update the min / max
            this.minimum = data_min;    // Pick the data_min, which is 20-bin smoothed min over N bin span, don't bias it here, bias in drawSpectrumWaterfall
            this.maximum = range_scale_increment * Math.ceil(data_max / range_scale_increment) + range_scale_increment; // was using the peak inside the bin high low range, now use all visible spectral data
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

/**
 * Sets the dB range for the spectrum and waterfall displays, updates UI controls, and redraws axes.
 *
 * @function
 * @param {number} min_db - The minimum dB value for the spectrum display (baseline).
 * @param {number} max_db - The maximum dB value for the spectrum display (top).
 * @param {boolean} adjust_waterfall - If true, also adjust the waterfall dB range.
 * @param {number} wf_min_adjust - Amount to bias the waterfall minimum dB (darken or lighten the waterfall).
 *
 * @description
 * Updates the minimum and maximum dB values for the spectrum display and, optionally, the waterfall display.
 * Also updates the corresponding input fields in the UI, sets the graticule (grid line) spacing,
 * and redraws the axes. If `adjust_waterfall` is true, the waterfall's dB range is set based on
 * the spectrum range plus the provided adjustment. Finally, saves the new settings to the radio pointer if available.
 */
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
        this.wf_min_db = min_db + wf_min_adjust;    // min_db + some bias to darken the waterfall 
        this.wf_max_db = max_db;
        // Update the waterfall min/max display sliders
        document.getElementById("waterfall_min").value = this.wf_min_db;
        document.getElementById("waterfall_max").value = this.wf_max_db;

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
    //console.log("forceAutoscale(), autoscaleWait set to ", this.autoscaleWait," waitToAutoscale= ", waitToAutoscale);
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

// Note: showOverlayTrace method is now defined directly on the Spectrum prototype
// Patch drawSpectrum to draw overlay trace if active
// Note: drawSpectrum overlay functionality has been moved to drawSpectrumWaterfall

/**
 * Exports the current spectrum data to a CSV file.
 *
 * @function
 * @param {string} filename - The name of the file to save (without extension).
 *
 * @description
 * This function converts the current spectrum data (FFT bin values) into a CSV format and triggers a download.
 * The CSV contains columns for bin number, frequency (in Hz), and amplitude (in dB).
 * The file is named using the provided `filename` parameter, with a `.csv` extension.
 */
Spectrum.prototype.exportCSV = function() {
    if (!this.bin_copy || this.bin_copy.length === 0) {
        alert("No spectrum data to export.");
        return;
    }
    // CSV header
    let csv = "bin,frequency,value\n";
    for (let i = 0; i < this.bin_copy.length; i++) {
        let freq = this.bin_to_hz(i);
        csv += `${i},${freq},${this.bin_copy[i]}\n`;
    }
    // Add min/max/center/zoom to filename
    const suffix = this.getExportSuffix();
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    // Prefix with host:port
    const host = window.location.host.replace(/[:\/\\]/g, '_');
    a.download = `${host}_spectrum${suffix}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 100);
}

// Export the Max Hold data as CSV 
Spectrum.prototype.exportMaxHoldCSV = function() {
    if (!this.binsMax || this.binsMax.length === 0) {
        alert("No Max Hold data to export.");
        return;
    }
    // CSV header
    let csv = "bin,frequency,value\n";
    for (let i = 0; i < this.binsMax.length; i++) {
        let freq = this.bin_to_hz(i);
        csv += `${i},${freq},${this.binsMax[i]}\n`;
    }
    // Add min/max/center/zoom to filename
    const suffix = this.getExportSuffix();
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    // Prefix with host:port
    const host = window.location.host.replace(/[:\/\\]/g, '_');
    a.download = `${host}_max_hold${suffix}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 100);
}

// Export the Min Hold data as CSV
Spectrum.prototype.exportMinHoldCSV = function() {
    if (!this.binsMin || this.binsMin.length === 0) {
        alert("No Min Hold data to export.");
        return;
    }
    // CSV header
    let csv = "bin,frequency,value\n";
    for (let i = 0; i < this.binsMin.length; i++) {
        let freq = this.bin_to_hz(i);
        csv += `${i},${freq},${this.binsMin[i]}\n`;
    }
    // Add min/max/center/zoom to filename
    const suffix = this.getExportSuffix();
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    // Prefix with host:port
    const host = window.location.host.replace(/[:\/\\]/g, '_');
    a.download = `${host}_min_hold${suffix}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 100);
}

/**
 * Loads a CSV file and displays the data as an overlay trace on the spectrum.
 * 
 * @function
 * @description
 * This function is called by the "Load Data" button to load a CSV file containing
 * frequency spectrum data and display it as an overlay on the spectrum graph.
 */
Spectrum.prototype.loadOverlayTrace = function() {
    //console.log('loadOverlayTrace called');
    var self = this;
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv,text/csv';
    input.style.display = 'none';
    document.body.appendChild(input);
    
    input.addEventListener('change', function(e) {
        //console.log('File selected', e.target.files);
        var file = e.target.files[0];
        if (!file) {
            document.body.removeChild(input);
            return;
        }
        
        var reader = new FileReader();
        reader.onload = function(evt) {
            //console.log('File loaded, processing data');
            try {
                var lines = evt.target.result.split(/\r?\n/);
                //console.log('CSV lines:', lines.length);
                var data = [];
                var validEntries = 0;
                
                for (var i = 1; i < lines.length; ++i) { // skip header
                    var line = lines[i].trim();
                    if (line === '') continue;
                    
                    var parts = line.split(',');
                    if (parts.length >= 3) {
                        var bin = parseInt(parts[0], 10);
                        var freq = parseFloat(parts[1]);
                        var value = parseFloat(parts[2]);
                        if (!isNaN(bin) && !isNaN(freq) && !isNaN(value)) {
                            data[bin] = value;
                            validEntries++;
                        }
                    }
                }
                
                //console.log('Valid CSV entries:', validEntries);
                if (validEntries > 0) {
                    //console.log('Calling showOverlayTrace with data');
                    self.showOverlayTrace(data);
                } else {
                    console.error('No valid data found in CSV');
                    alert('No valid data found in CSV file.');
                }
            } catch (e) {
                console.error('Error processing CSV:', e);
                alert('Failed to load CSV: ' + e.message);
            } finally {
                document.body.removeChild(input);
            }
        };
        
        reader.onerror = function(evt) {
            console.error('Error reading file:', evt);
            alert('Error reading file');
            document.body.removeChild(input);
        };
        
        //console.log('Starting file read');
        reader.readAsText(file);
    });
    
    // Add timeout to ensure browser responds to the click
    setTimeout(function() {
        input.click();
    }, 50);
};

/**
 * Displays an overlay trace on the spectrum.
 * 
 * @function
 * @param {Array} trace - An array of amplitude values to overlay on the spectrum.
 * @description
 * This function takes an array of amplitude values and displays them as an overlay
 * on the spectrum graph. The overlay is drawn in green.
 */
Spectrum.prototype.showOverlayTrace = function(trace) {
    //console.log('showOverlayTrace called');
    var self = this;
    
    // Check for valid input
    if (!trace || (Array.isArray(trace) && trace.length === 0)) {
        console.error('Empty or invalid trace data');
        return;
    }
    
    // Accepts either an array of values or an array of objects/arrays with bin/freq/value
    // If input is an array of objects/arrays, extract only the value for each bin
    if (Array.isArray(trace) && trace.length > 0 && typeof trace[0] !== 'number') {
        // Try to extract the value (3rd column) from each row
        var values = [];
        for (var i = 0; i < trace.length; ++i) {
            var row = trace[i];
            if (Array.isArray(row) && row.length >= 3) {
                values[i] = parseFloat(row[2]);
            } else if (typeof row === 'object' && row !== null && 'value' in row) {
                values[i] = parseFloat(row.value);
            }
        }
        trace = values;
    }
    
    // Store the overlay trace data in the array (up to 3)
    if (!this._overlayTraces) this._overlayTraces = [];
    if (this._overlayTraces.length < 3) {
        this._overlayTraces.push(trace);
        this._overlayTraceIndex = this._overlayTraces.length - 1;
    } else {
        this._overlayTraceIndex = (this._overlayTraceIndex + 1) % 3;
        this._overlayTraces[this._overlayTraceIndex] = trace;
    }
    //console.log('Overlay trace length:', trace.length, 'Defined values:', trace.filter(v => v !== undefined).length);
    
    // Compute scaling for overlay trace to match spectrum scaling
    // Use the same scaling as drawFFT: map min_db..max_db to spectrumHeight..0
    var min_db = this.min_db;
    var max_db = this.max_db;
    var spectrumHeight = this.spectrumHeight || this.canvas.height;
    
    // Precompute scaled values for overlay if needed by drawSpectrum
    this._overlayTraceScaled = [];
    if (Array.isArray(trace)) {
        for (var i = 0; i < trace.length; i++) {
            var v = trace[i];
            if (typeof v === 'undefined') {
                this._overlayTraceScaled[i] = undefined;
            } else if (v <= min_db) {
                this._overlayTraceScaled[i] = spectrumHeight;
            } else if (v >= max_db) {
                this._overlayTraceScaled[i] = 0;
            } else {
                this._overlayTraceScaled[i] = spectrumHeight - ((v - min_db) / (max_db - min_db)) * spectrumHeight;
            }
        }
    }
    
    // Trigger a redraw to show overlay immediately
    //console.log('Triggering redraw with overlay');
    if (this.bin_copy) {
        this.drawSpectrumWaterfall(this.bin_copy, false);
    }
};

/**
 * Clears the overlay trace from the spectrum.
 * 
 * @function
 * @description
 * This function removes any overlay trace from the spectrum and redraws the spectrum.
 */
Spectrum.prototype.clearOverlayTrace = function() {
    //console.log('clearOverlayTrace called');
    this._overlayTraces = [];
    // Force redraw
    if (this.bin_copy && this.bin_copy.length) {
        this.drawSpectrumWaterfall(this.bin_copy, false);
    } else if (this.binsAverage && this.binsAverage.length) {
        this.drawSpectrumWaterfall(this.binsAverage, false);
    } else {
        // As a last resort, clear the canvas
        const ctx = this.ctx;
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
};

// Patch the main spectrum drawing function to draw the overlay trace if present
(function() {
    // Store the original drawSpectrumWaterfall function
    const origDrawSpectrumWaterfall = Spectrum.prototype.drawSpectrumWaterfall;
    
    // Replace with our patched version that also draws the overlay
    Spectrum.prototype.drawSpectrumWaterfall = function(bins, updateWaterfall) {
        try {
            // Call the original function first
            origDrawSpectrumWaterfall.call(this, bins, updateWaterfall);
            
            // Then draw all overlay traces if present
            if (this._overlayTraces && Array.isArray(this._overlayTraces)) {
                const colors = ['#FFA500', '#00FF00', '#00BFFF']; // orange, green, blue
                for (let t = 0; t < this._overlayTraces.length; ++t) {
                    const trace = this._overlayTraces[t];
                    if (!trace || !Array.isArray(trace) || trace.length === 0) continue;
                    const ctx = this.ctx;
                    ctx.save();
                    ctx.globalAlpha = 1.0;
                    ctx.strokeStyle = colors[t % colors.length];
                    ctx.lineWidth = 2;
                    const spectrumHeight = Math.round(this.canvas.height * (this.spectrumPercent / 100));
                    ctx.beginPath();
                    let isFirstPoint = true;
                    for (let i = 0; i < trace.length; ++i) {
                        if (typeof trace[i] === 'undefined') continue;
                        const dB = trace[i];
                        const min = this.min_db;
                        const max = this.max_db;
                        const clamped = Math.max(min, Math.min(max, dB));
                        const y = ((max - clamped) / (max - min)) * spectrumHeight;
                        const denominator = bins.length > 1 ? (bins.length - 1) : 1;
                        const x = (i / denominator) * this.canvas.width;
                        if (isFirstPoint) {
                            ctx.moveTo(x, y);
                            isFirstPoint = false;
                        } else {
                            ctx.lineTo(x, y);
                        }
                    }
                    if (!isFirstPoint) {
                        ctx.stroke();
                    }
                    ctx.restore();
                }
            }
        } catch (err) {
            console.error('Error drawing spectrum overlay:', err);
        }
    };
})();

/**
 * Sets up event handlers for spectrum overlay-related buttons.
 * 
 * @function
 * @description
 * This function is called during initialization to set up event handlers for
 * buttons related to spectrum overlay functionality (Load Data and Clear Data).
 */
Spectrum.prototype.setupOverlayButtons = function() {
    var self = this;
    //console.log('Setting up overlay buttons...');
    
    // Set up the Load Data button
    var loadBtn = document.getElementById('load_max');
    if (loadBtn) {
        //console.log('Found Load Data button, attaching handler');
        // Remove any existing click handlers to prevent duplicates
        loadBtn.removeEventListener('click', loadBtn._clickHandler);
        
        // Create and store the handler function
        loadBtn._clickHandler = function(e) {
            //console.log('Load Data button clicked');
            if (e) e.preventDefault();
            if (self && typeof self.loadOverlayTrace === 'function') {
                self.loadOverlayTrace();
            } else {
                console.error('Spectrum.loadOverlayTrace is not available', self);
                alert('Load Data function not available. Please try again later.');
            }
        };
        
        // Attach the handler
        loadBtn.addEventListener('click', loadBtn._clickHandler);
    } else {
        console.warn('Load Data button (#load_max) not found in DOM');
    }
    
    // Set up the Clear Data button
    var clearBtn = document.getElementById('clear_overlay');
    if (clearBtn) {
        //console.log('Found Clear Data button, attaching handler');
        // Remove any existing click handlers to prevent duplicates
        clearBtn.removeEventListener('click', clearBtn._clickHandler);
        
        // Create and store the handler function
        clearBtn._clickHandler = function(e) {
            //console.log('Clear Data button clicked');
            if (e) e.preventDefault();
            if (self && typeof self.clearOverlayTrace === 'function') {
                self.clearOverlayTrace();
            } else {
                console.error('Spectrum.clearOverlayTrace is not available', self);
                alert('Clear Data function not available. Please try again later.');
            }
        };
        
        // Attach the handler
        clearBtn.addEventListener('click', clearBtn._clickHandler);
    } else {
        console.warn('Clear Data button (#clear_overlay) not found in DOM');
    }
};

// Helper to generate a filename suffix with min, max, center frequencies and zoom
Spectrum.prototype.getExportSuffix = function() {
    // Use kHz for readability
    const minHz = (typeof this.lowHz === 'number') ? this.lowHz : (this.centerHz - (this.spanHz/2));
    const maxHz = (typeof this.highHz === 'number') ? this.highHz : (this.centerHz + (this.spanHz/2));
    const centerHz = (typeof this.centerHz === 'number') ? this.centerHz : 0;
    let zoom = 'z';
    // Try to get zoom level from DOM if available
    try {
        const zoomElem = document.getElementById("zoom_level");
        console.log("zoomElem=", zoomElem.value);
        if (zoomElem) {
            // Support both input and text content
            if (typeof zoomElem.value !== 'undefined' && zoomElem.value !== '') {
                zoom = zoomElem.value;
            } else if (zoomElem.textContent && zoomElem.textContent.trim() !== '') {
                zoom = zoomElem.textContent.trim();
            }
        }
    } catch (e) {
        // fallback to default if any error
    }

    console.log("getExportSuffix called with lowHz=", this.lowHz, " highHz=", this.highHz, " centerHz=", this.centerHz, " spanHz=", this.spanHz);


    const min = Math.round(minHz / 1000);
    const max = Math.round(maxHz / 1000);
    const center = Math.round(centerHz / 1000);
    return `_min${min}kHz_max${max}kHz_center${center}kHz_zoom${zoom}`;
};
/*
 * Copyright (c) 2019 Jeppe Ledet-Pedersen
 * This software is released under the MIT license.
 * See the LICENSE file for further details.
 */
