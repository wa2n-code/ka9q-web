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

// Set the meter rectangle to a gradient with colors that approach or turn red as the signal level increases beyond S9
var gradient;
gradient = ctx.createLinearGradient(0,0,cWidth,0);
gradient.addColorStop(1, "rgb(255,0,0)");
gradient.addColorStop(s9pfs,"rgb(255,0, 0)");         // Abrupt transition from green to red at S9
gradient.addColorStop(.6,"green");  // S9+30            // stay green to S9 (almost) then turn red
gradient.addColorStop(0,'green');
gradient.addColorStop
ctx.fillStyle = gradient;

var meterType = 0;  // 0 = RSSI, 1 = SNR
function dB2power(dB) { 
    return Math.pow(10, dB / 10); 
}

function power2dB(power) {
    return 10 * Math.log10(power);
}   


function createUpdateSMeter() {
    let lastMax = 0; // Static variable that holds the max value for the max hold bar graph
    let lastSNR =0;
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
        if((spnovernp -1) > 0) 
            SignalToNoiseRatio = power2dB(spnovernp - 1);
        else
            SignalToNoiseRatio = -100;  // Avoid calling power2dB with a negative number

        // clear Canvas 
        ctx.clearRect(0, 0, cWidth, cHeight);
        var adjustedSignal = SignalLevel - smallestSignal;  // Adjust the dB signal to a positive number with smallestSignal as 0, and biggestSignal as -13
        var normSig;

        if(meterType == 0) {  
            //The RSSI Meter: An S9 signal should paint to s9pfs (62%) of full scale.  Signals above S9 are scaled to paint to the upper (right) 38% of the scale.
            if (SignalLevel <= s9SignalLevel) {
                normSig = adjustedSignal / belowS9Span * s9pfs;
            } else {
                normSig = s9pfs + (adjustedSignal - adjustedSignalAtS9) / aboveS9Span * s9Plus60pfs;
            }
        } else 
        {  // SNR meter
            normSig = SignalToNoiseRatio / 50 + 0.1; // 50dB SNR is full scale, -10db is the minimum value 
        }

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
            if(executionCount > executionCountHit) {
                // Done holding the last RSI value, get the latest one
                executionCount = 0;
                lastMax = normSig;
            }
            if(executionCountSNR > executionCountHit) {
                // Done holding the last SNR value, get the latest one
                executionCountSNR = 0;
                lastSNR = SignalToNoiseRatio;
            }
            if (normSig > lastMax) 
            {
                lastMax = normSig;
                executionCount = executionCountHit/2;   // Reset the upper bargraph hold counter so it is held for 15 counts
            }
            if(SignalToNoiseRatio > lastSNR) {
                lastSNR = SignalToNoiseRatio;
                executionCountSNR = executionCountHit/2; // Reset the SNR hold counter so SNR text display is held for 15 counts
            }   
            // fILL the top 1/3 with the max hold bar graph
            ctx.fillRect(0, 0, cWidth * lastMax, cHeight * maxBarHeight);
            // fill bottom 2/3 with the real time bar graph
            ctx.fillRect(0, cHeight * maxBarHeight, cWidth * normSig, cHeight);
            // Display the held SNR value
            document.getElementById('snr').textContent = `SNR: ${lastSNR.toFixed(1)} dB`;
            document.getElementById('snr_data').textContent = ` SNR: ${lastSNR.toFixed(1)} dB`;
        }
        else 
        {
            // Not max hold, fill the entire canvas with the real time bar graph
            ctx.fillRect(0, 0, cWidth * normSig, cHeight);
            // Display the real-time SNR value
            document.getElementById('snr').textContent = `SNR: ${SignalToNoiseRatio.toFixed(1)} dB`;
            document.getElementById('snr_data').textContent = `SNR: ${SignalToNoiseRatio.toFixed(1)} dB`;
        }   
        // Draw the border
        ctx.strokeRect(0, 0, cWidth, cHeight);

        return power2dB(noise_power);
    };
}

function createComputeSUnits() {
    let lastMax1 = 0;
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
            document.getElementById("pwr_data").textContent = ` Power: ${lastMax1.toFixed(0)}`;
        }
        else {
            p = Math.round(SignalLevel);    // Use the real time value
            document.getElementById("pwr_data").textContent = ` Power: ${SignalLevel.toFixed(0)}`;
        }
    
        // Compute the S units based on the power level p from above, being real time or max hold
        var s;
        if (p <= -73) {     
            s = 'S' + Math.floor((p + 127) / 6);    // S0 to S9
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
    }
};


