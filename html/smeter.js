const canvas = document.getElementById('smeter');
const ctx = canvas.getContext('2d');
const cWidth = canvas.width;
const cHeight = canvas.height;
ctx.fillStyle = "#000000";
ctx.fillRect(0,0, cWidth, cHeight); 
const updateSMeter = createUpdateSMeter();
const computeSUnits = createComputeSUnits();

    // Create and paint a bargraph which represents the S meter signal level
    // The S meter is a logarithmic scale that is not linear.  The S meter is defined as S0 to S9+60dBm
    // S0 = -127dBm, S9 = -73dBm, S9+60 = -13dBm    

    // Need to normalize the SignalLevel to be between 0 and 1
    // Max bar width is at S9+60 dBm which is -73 + 60 = -13dBm input signal Level
    // Min bar width is at S0 which is -73 - 9*6 = -127dBm input signal Level
    // So the range is 127-13 = 114dBm

    // An S meter is not linear, scaling per "division" is 6db per S unit S9 (-73)
    // Then 10db per division from S9 (-73) to S9+60 (-13)
    // Adjust the scaler differently below and above S9 taking their respective spans into account

    const smallestSignal = -127;
    const biggestSignal = -13;
    const s9SignalLevel = -73;
    const meterSpan = biggestSignal - smallestSignal;   // Span of the signal range (114) in db to map to the width of the s0 to S9+60 bargraph range
    const belowS9Span = s9SignalLevel - smallestSignal  // Span of the signal range in db below S9 (54dB=9x6) to map to the s0-s9 bargraph range
    const aboveS9Span = 60;                             // Span of the signal range in db above S9 (60dB) to map to the S9+60 bargraph range
    const adjustedSignalAtS9 = meterSpan - aboveS9Span; // dB value of the adjusted input signal at an S9 value
    const s9pfs = 0.62;                                 // Set to the percentage of full scale in the bargraph that corresponds to S9 (62% on TenTec Orion)
    const s9Plus60pfs = 1 - s9pfs;                      // Remaining span scaler for drawing bar above S9 (1-62% = 38%)

var meterType = 0;  // 0 = RSSI, 1 = SNR, updated in radio.js when the RSSI/SNR button is clicked or loaded from storage

function dB2power(dB) { 
    return Math.pow(10, dB / 10); 
}

function power2dB(power) {
    return 10 * Math.log10(power);
}   

function createUpdateSMeter() {
    let lastMax = -200; // Static variable that holds the max value for the max hold bar graph
    let lastSNR = -100;
    let executionCount = 0;     // Static variable that counts the number of times the updateSMeter function is called
    let executionCountSNR = 0;  // Static variable that counts the number of times the updateSMeter function is called

    return function updateSMeter(SignalLevel, noiseDensity, Bandwidth, maxHold) {
        const maxBarHeight = 0.3;  // 30% of the canvas height
        const executionCountHit = 30; // Number of times (seconds*10?) the updateSMeter function is called before the max hold bar graph is updated

        // Experimental SNR calculation and display
        var noise_power = dB2power(noiseDensity) * Bandwidth;
        var signal_plus_noise_power = dB2power(SignalLevel);
        var SignalToNoiseRatio;

        var spnovernp = signal_plus_noise_power / noise_power;
        if ((spnovernp - 1) > 0)
            SignalToNoiseRatio = power2dB(spnovernp - 1);
        else
            SignalToNoiseRatio = -100;  // Avoid calling power2dB with a negative number

        // clear Canvas 
        ctx.clearRect(0, 0, cWidth, cHeight);
        var adjustedSignal = SignalLevel - smallestSignal;  // Adjust the dB signal to a positive number with smallestSignal as 0, and biggestSignal as -13
        var normSig;

        if (meterType == 0) {
            //The RSSI Meter: An S9 signal should paint to s9pfs (62%) of full scale.  Signals above S9 are scaled to paint to the upper (right) 38% of the scale.
            if (SignalLevel <= s9SignalLevel) {
                normSig = adjustedSignal / belowS9Span * s9pfs;
            } else {
                normSig = s9pfs + (adjustedSignal - adjustedSignalAtS9) / aboveS9Span * s9Plus60pfs;
            }
        } else   // SNR meter
        if (meterType == 1)
            normSig = SignalToNoiseRatio / 50 + 0.1; // 50dB SNR is full scale, -10db is the minimum value 
        else
            normSig = Number(input_samprate) / Number(samples_since_over);

        // Protect over under range
        if (normSig > 1) {
            normSig = 1;
        }
        if (normSig < 0) {
            normSig = 0;
        }

        if (maxHold == true) {
            executionCount++;
            executionCountSNR++;
            if (executionCount > executionCountHit) {
                // Done holding the last RSI value, get the latest one
                executionCount = 0;
                lastMax = normSig;
            }
            if (executionCountSNR > executionCountHit) {
                // Done holding the last SNR value, get the latest one
                executionCountSNR = 0;
                lastSNR = SignalToNoiseRatio;
            }
            if (normSig > lastMax) {
                lastMax = normSig;
                executionCount = executionCountHit / 2;   // Reset the upper bargraph hold counter so it is held for 15 counts
            }
            if (SignalToNoiseRatio > lastSNR) {
                lastSNR = SignalToNoiseRatio;
                executionCountSNR = executionCountHit / 2; // Reset the SNR hold counter so SNR text display is held for 15 counts
            }

            // --- SNR meter custom coloring for maxHold ---
            if (meterType == 1) {
                // SNR spans from -10 to +50
                const zeroPoint = cWidth * (10 / 60); // 1/6 of the width

                // Top 1/3: max hold bar (color as before)
                if (lastSNR < 0) {
                    // Red bar: from zeroPoint leftward, proportional to SNR
                    const redFrac = Math.min(1, Math.max(0, -lastSNR / 10)); // 0 to 1 as SNR goes 0 to -10
                    const redWidth = zeroPoint * redFrac;
                    ctx.fillStyle = "red";
                    ctx.fillRect(zeroPoint - redWidth, 0, redWidth, cHeight * maxBarHeight);
                } else if (lastSNR > 0) {
                    // Blue bar: from zeroPoint rightward, proportional to SNR (max at +50)
                    const blueFrac = Math.min(1, lastSNR / 50); // 0 to 1 as SNR goes 0 to +50
                    const blueWidth = (cWidth - zeroPoint) * blueFrac;
                    ctx.fillStyle = "rgb(1, 136, 199)";
                    ctx.fillRect(zeroPoint, 0, blueWidth, cHeight * maxBarHeight);
                }
                // If SNR == 0, nothing is drawn (all blank)

                // Bottom 2/3: real time bar graph, but color and position as SNR logic
                if (SignalToNoiseRatio < 0) {
                    const redFrac = Math.min(1, Math.max(0, -SignalToNoiseRatio / 10));
                    const redWidth = zeroPoint * redFrac;
                    ctx.fillStyle = "red";
                    ctx.fillRect(zeroPoint - redWidth, cHeight * maxBarHeight, redWidth, cHeight - cHeight * maxBarHeight);
                } else if (SignalToNoiseRatio > 0) {
                    const blueFrac = Math.min(1, SignalToNoiseRatio / 50);
                    const blueWidth = (cWidth - zeroPoint) * blueFrac;
                    ctx.fillStyle = "rgb(1, 136, 199)";
                    ctx.fillRect(zeroPoint, cHeight * maxBarHeight, blueWidth, cHeight - cHeight * maxBarHeight);
                }
                // If SNR == 0, nothing is drawn (all blank)
            } else if (meterType == 0) {
                // RSSI meter: fill with gradient
                var gradient;
                gradient = ctx.createLinearGradient(0, 0, cWidth, 0);
                gradient.addColorStop(1, "rgb(128,82,0)");
                gradient.addColorStop(s9pfs, "rgb(255,0, 0)");
                gradient.addColorStop(.6, "green");
                gradient.addColorStop(0, 'green');
                ctx.fillStyle = gradient;
                ctx.fillRect(0, 0, cWidth * lastMax, cHeight * maxBarHeight);
                ctx.fillRect(0, cHeight * maxBarHeight, cWidth * normSig, cHeight - cHeight * maxBarHeight);
            } else {
                // OVF meter
                ctx.fillStyle = "orange";
                ctx.fillRect(0, 0, cWidth * lastMax, cHeight * maxBarHeight);
                ctx.fillRect(0, cHeight * maxBarHeight, cWidth * normSig, cHeight - cHeight * maxBarHeight);
            }

            // Display the held SNR value
            if (lastSNR === -100) {
                document.getElementById('snr').textContent = `SNR: -\u221E dB`;
                document.getElementById('snr_data').textContent = `| SNR: -\u221E`;
            } else {
                document.getElementById('snr').textContent = `SNR: ${lastSNR.toFixed(0)} dB`;
                document.getElementById('snr_data').textContent = `| SNR: ${lastSNR.toFixed(0)}`;
            }
        }
        else // max hold is false
        {
            // --- SNR meter custom coloring ---
            if (meterType == 1) {
                // SNR spans from -10 to +50
                const zeroPoint = cWidth * (10 / 60); // 1/6 of the width

                if (SignalToNoiseRatio < 0) {
                    // Red bar: from zeroPoint leftward, proportional to SNR
                    const redFrac = Math.min(1, Math.max(0, -SignalToNoiseRatio / 10)); // 0 to 1 as SNR goes 0 to -10
                    const redWidth = zeroPoint * redFrac;
                    ctx.fillStyle = "red";
                    ctx.fillRect(zeroPoint - redWidth, 0, redWidth, cHeight);
                } else if (SignalToNoiseRatio > 0) {
                    // Blue bar: from zeroPoint rightward, proportional to SNR (max at +50)
                    const blueFrac = Math.min(1, SignalToNoiseRatio / 50); // 0 to 1 as SNR goes 0 to +50
                    const blueWidth = (cWidth - zeroPoint) * blueFrac;
                    ctx.fillStyle = "rgb(1, 136, 199)";
                    ctx.fillRect(zeroPoint, 0, blueWidth, cHeight);
                }
                // If SNR == 0, nothing is drawn (all blank)
            } else if (meterType == 0) {
                // RSSI meter: fill with gradient (fix for maxHold==false)
                var gradient;
                gradient = ctx.createLinearGradient(0, 0, cWidth, 0);
                gradient.addColorStop(1, "rgb(128,82,0)");
                gradient.addColorStop(s9pfs, "rgb(255,0, 0)");
                gradient.addColorStop(.6, "green");
                gradient.addColorStop(0, 'green');
                ctx.fillStyle = gradient;
                ctx.fillRect(0, 0, cWidth * normSig, cHeight);
            } else {
                ctx.fillStyle = "orange";
                ctx.fillRect(0, 0, cWidth * normSig, cHeight);
            }
            // Display the real-time SNR value
            if (SignalToNoiseRatio === -100) {
                document.getElementById('snr').textContent = `SNR: -\u221E dB`;
                document.getElementById('snr_data').textContent = `| SNR: -\u221E`;
            } else {
                document.getElementById('snr').textContent = `SNR: ${SignalToNoiseRatio.toFixed(0)} dB`;
                document.getElementById('snr_data').textContent = `| SNR: ${SignalToNoiseRatio.toFixed(0)}`;
            }
        }

        if (meterType == 1) { // SNR meter
            document.getElementById('snr_units').textContent = "dB | SNR: ";
        }
        else {
            if (meterType == 0) { // RSSI meter
                document.getElementById('snr_units').textContent = "dB | Signal: ";
            }
            else
                document.getElementById('snr_units').textContent = "dB | OVR:";
        }

        // Draw the border
        ctx.strokeRect(0, 0, cWidth, cHeight);

        return power2dB(noise_power);
    };
}

function createComputeSUnits() {
    let lastMax1 = -200;
    let executionCount1 = 0; 

    return function computeSUnits(SignalLevel, maxHold) {
        const executionCountHit1 = 20; // Number of times (seconds*10?) the updateSMeter function is called before the max hold bar graph is updated
        var p;

        // Display the power level (dBm) realtime, or max hold level
        if (maxHold == true) {
            executionCount1++;
            if(executionCount1 > executionCountHit1) {
                executionCount1 = 0;
                lastMax1 = SignalLevel;
            }
            if (SignalLevel > lastMax1) {
                lastMax1 = SignalLevel;
            }
            p = Math.round(lastMax1);       // Use the max hold value
            document.getElementById("pwr_data").textContent = ` Power: ${lastMax1.toFixed()}`;
        }
        else {
            p = Math.round(SignalLevel);    // Use the real time value
            document.getElementById("pwr_data").textContent = ` Power: ${SignalLevel.toFixed(0)}`;
        }
    
        // Compute the S units based on the power level p from above, being real time or max hold
        var s;
        var sm1;
        if (p <= -73) {     
            sm1 = Math.round((p + 127) / 6);       // S0 to S9
            if (sm1 < 0) sm1 = 0;                // S0 is the lowest value
            s = 'S' +  sm1;    // S0 to S9
        } 
        else {
            s = 'S9+' + ((p + 73) / 10) * 10;       // S9+1 to S9+60
        }

        // Set the color to red if over S9, green if S9 or below
        var len = s.length;
        if (len > 2) {
            document.getElementById("s_data").style.color = "red";
        }
        else {
            document.getElementById("s_data").style.color = "green";
        }
        // Display the S units
        document.getElementById("s_data").textContent = s; 

        // Call analog S-meter draw function with the current signal level (p) if enabled
        if (typeof drawAnalogSMeter === "function" && typeof enableAnalogSMeter !== "undefined" && enableAnalogSMeter) {
            drawAnalogSMeter(p);
        }
    }
};

function drawAnalogSMeter(signalStrength) {
    const canvas = document.getElementById("sMeter");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    // For a 220px wide canvas, center at 110
    const centerX = 110;
    const centerY = 110;
    const radius = 100;

    // Fill the entire background with #ddd first
    //ctx.fillStyle = "#ddd";
    ctx.fillStyle = getComputedStyle(document.body).backgroundColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Meter background (draw arc over the rectangle)
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, Math.PI, 2 * Math.PI);
    ctx.fill();

    // Outer arc in
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, Math.PI, 2 * Math.PI);
    ctx.stroke();

    // Scale markings with correct calibration
    ctx.fillStyle = "#000000"
    ctx.font = "14px Arial";
    const scale = [
    { label: "S1",   fraction: 0.0 },
    { label: "S3",   fraction: 0.125 },
    { label: "S5",   fraction: 0.25 },
    { label: "S7",   fraction: 0.375 },
    { label: "S9",   fraction: 0.5 },
    // ...right side unchanged...
    { label: "+20",  fraction: 0.5 + (20/60)*0.5 },
    { label: "+40",  fraction: 0.5 + (40/60)*0.5 },
    { label: "+60",  fraction: 1.0 }
    ];  
    for (let i = 0; i < scale.length; i++) {
        let angle = Math.PI + (Math.PI * scale[i].fraction);
        let x = centerX + 85 * Math.cos(angle);
        let y = centerY + 85 * Math.sin(angle);
        ctx.fillText(scale[i].label, x - 12, y + 5);
    }

    // --- Corrected scaling for the needle ---
    // S1 (-127 dBm) to S9 (-73 dBm): 54 dB span, 6 dB per S-unit
    // S9 (-73 dBm) to +60 (-13 dBm): 60 dB span, 1 dB per fraction of arc
    let fraction;
    if (signalStrength <= -73) {
        // S1 to S9: left half of arc, 8 steps (S1=0, S9=8)
        let s_unit = (signalStrength + 127) / 6 - 1;
        if (s_unit < 0) s_unit = 0;
        if (s_unit > 8) s_unit = 8;
        fraction = (s_unit / 8) * 0.5;
    } else if (signalStrength >= -13) {
        // At or above +60: rightmost
        fraction = 1;
    } else {
        // Above S9: right half of arc, linear in dB
        fraction = 0.5 + ((signalStrength + 73) / 60) * 0.5; // 0.5 to 1, linear in dB
    }
    if (fraction < 0) fraction = 0;
    if (fraction > 1) fraction = 1;

    const minAngle = Math.PI;
    const maxAngle = 2 * Math.PI;
    const angle = minAngle + (maxAngle - minAngle) * fraction;

    // Draw needle
    ctx.strokeStyle = "red";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(centerX, centerY);
    ctx.lineTo(centerX + 70 * Math.cos(angle), centerY + 70 * Math.sin(angle));
    ctx.stroke();

    // Draw arrowhead at the tip of the needle
    const tipX = centerX + 70 * Math.cos(angle);
    const tipY = centerY + 70 * Math.sin(angle);
    const arrowLength = 12; // length of the arrowhead sides
    const arrowAngle = Math.PI / 12; // angle between needle and arrowhead sides

    // Left side of arrowhead
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(
        tipX - arrowLength * Math.cos(angle - arrowAngle),
        tipY - arrowLength * Math.sin(angle - arrowAngle)
    );
    ctx.stroke();

    // Right side of arrowhead
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(
        tipX - arrowLength * Math.cos(angle + arrowAngle),
        tipY - arrowLength * Math.sin(angle + arrowAngle)
    );
    ctx.stroke();

    // Value text
    ctx.fillStyle = "#000000"
    ctx.font = "16px Arial";
    ctx.fillText(`Signal Power: ${signalStrength} dBm`, 25, 135);
}