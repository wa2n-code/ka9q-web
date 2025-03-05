const canvas = document.getElementById('smeter');
const ctx = canvas.getContext('2d');
const cWidth = canvas.width;
const cHeight = canvas.height;
ctx.fillStyle = "#000000";
ctx.fillRect(0,0, cWidth, cHeight); 

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

function updateSMeter(SignalLevel){
    // clear Canvas 
    ctx.clearRect(0,0, cWidth, cHeight);
    
    var adjustedSignal = SignalLevel - smallestSignal;  // Adjust the dB signal to a positive number with smallestSignal as 0, and biggestSignal as -13
    
    // An S9 signal should paint to s9pfs (62%) of full scale.  Signals above S9 are scaled to paint to the upper (right) 38% of the scale.
    var normSig;
    if(SignalLevel <= s9SignalLevel)
    {
        normSig = adjustedSignal / belowS9Span * s9pfs;
    }
    else
    {        
        normSig = s9pfs + (adjustedSignal - adjustedSignalAtS9) /aboveS9Span * s9Plus60pfs;
    }

    // Protect over under range
    if (normSig > 1) {
        normSig = 1;
    }
    if (normSig < 0) {
        normSig = 0;
    }
    ctx.fillRect(0, 0, cWidth*normSig, cHeight);
    ctx.strokeRect(0,0, cWidth, cHeight); 
}


