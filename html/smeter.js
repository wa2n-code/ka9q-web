const canvas = document.getElementById('smeter');
const ctx = canvas.getContext('2d');
const cWidth = canvas.width;
const cHeight = canvas.height;
ctx.fillStyle = "#000000";
ctx.fillRect(0,0, cWidth, cHeight); 

// meter
var gradient;
gradient = ctx.createLinearGradient(0,0,cWidth,0);
gradient.addColorStop(1, 'red');
gradient.addColorStop(0.62,'yellow');
gradient.addColorStop(0,'green');
gradient.addColorStop
ctx.fillStyle = gradient;

function updateSMeter(SignalLevel){
    // clear Canvas 
    ctx.clearRect(0,0, cWidth, cHeight);
    // Need to normalize the SignalLevel to be between 0 and 1
    // Max meter is at S9+60 dBm which is -73 + 60 = -13dBm
    // Min meter is at S0 which is -73 - 9*6 = -127dBm

    // But this does not take into account that an S meter is not linear. 6db per S unit / division to S9 (-73)
    // then 10db per division to S9+60 (-13)
    // So must adjust the scaler differently below and above S9.

    const smallestSignal = -127;
    const biggestSignal = -13;
    const s9SignalLevel = -73;
    const span = biggestSignal - smallestSignal;        // Span of the signal range
    const belowS9Span = s9SignalLevel - smallestSignal  // Span of the signal range below S9
    const s9pfs = 0.62;                                 // Set what position in the bargraph S9 corresponds to (62% on TenTec Orion)
    const adjustedSignalAtS9 = span - 60;               // The bargraph above S9 needs to go full scale at 60 db above S9
    const s9Plus60pfs = 1 - s9pfs;
   
    var adjustedSignal = SignalLevel - smallestSignal;  // Make positive number with smallestSignal as 0, and biggestSignal as 114
    
    // An S9 signal should show up at s9pfs (62%) of full scale, and those less than that are scaled appropriately.
    var normSig;
    if(SignalLevel <= s9SignalLevel)
    {
        normSig = adjustedSignal / belowS9Span * s9pfs;
    }
    else
    {        
        normSig = s9pfs + (adjustedSignal - adjustedSignalAtS9) /belowS9Span * s9Plus60pfs;
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


