function PCMPlayer(option) {
    this.init(option);
}

PCMPlayer.prototype.init = function(option) {
    var defaults = {
        encoding: '16bitInt',
        channels: 1,
        sampleRate: 48000,
        flushingTime: 500
    };
    this.option = Object.assign({}, defaults, option);
    this.samples = new Float32Array();
    this.flush = this.flush.bind(this);
    this.interval = setInterval(this.flush, this.option.flushingTime);
    this.maxValue = this.getMaxValue();
    this.typedArray = this.getTypedArray();
    this.createContext();
};

PCMPlayer.prototype.getMaxValue = function () {
    var encodings = {
        '8bitInt': 128,
        '16bitInt': 32768,
        '32bitInt': 2147483648,
        '32bitFloat': 1
    }

    return encodings[this.option.encoding] ? encodings[this.option.encoding] : encodings['16bitInt'];
};

PCMPlayer.prototype.getTypedArray = function () {
    var typedArrays = {
        '8bitInt': Int8Array,
        '16bitInt': Int16Array,
        '32bitInt': Int32Array,
        '32bitFloat': Float32Array
    }

    return typedArrays[this.option.encoding] ? typedArrays[this.option.encoding] : typedArrays['16bitInt'];
};

PCMPlayer.prototype.createContext = function() {
    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    // Resume the context for iOS and Safari
    this.audioCtx.resume();

    // Create a gain node for volume control
    this.gainNode = this.audioCtx.createGain();
    this.gainNode.gain.value = 1;

    // Create a stereo panner node for panning control
    this.pannerNode = this.audioCtx.createStereoPanner();
    this.pannerNode.pan.value = 0; // Default to center (0)

    // Connect the nodes: panner -> gain -> destination
    this.pannerNode.connect(this.gainNode);
    this.gainNode.connect(this.audioCtx.destination);

    this.startTime = this.audioCtx.currentTime;
};

PCMPlayer.prototype.pan = function(value) { // Method to set the pan value
    if (this.pannerNode) {
        this.pannerNode.pan.value = value;
    }
};

PCMPlayer.prototype.resume = function() {
    this.audioCtx.resume();
}

PCMPlayer.prototype.isTypedArray = function(data) {
    return (data.byteLength && data.buffer && data.buffer.constructor == ArrayBuffer);
};

PCMPlayer.prototype.feed = function(data) {
    if (!this.isTypedArray(data)) {
        console.log("feed: not typed array");
        return;
    }
    var fdata = this.getFormatedValue(data);
    var tmp = new Float32Array(this.samples.length + fdata.length);
    tmp.set(this.samples, 0);
    tmp.set(fdata, this.samples.length);
    this.samples = tmp;
    this.audioCtx.resume();
};

PCMPlayer.prototype.getFormatedValue = function(data) {
    var ndata = new this.typedArray(data.buffer),
        float32 = new Float32Array(ndata.length),
        i;
    for (i = 0; i < ndata.length; i++) {
        float32[i] = ndata[i] / this.maxValue;
    }
    return float32;
};

PCMPlayer.prototype.volume = function(volume) {
    this.gainNode.gain.value = volume;
};

PCMPlayer.prototype.destroy = function() {
    if (this.interval) {
        clearInterval(this.interval);
    }
    this.samples = null;
    this.audioCtx.close();
    this.audioCtx = null;
};

PCMPlayer.prototype.flush = function() {
    if (!this.samples.length) return;
    var bufferSource = this.audioCtx.createBufferSource(),
        length = this.samples.length / this.option.channels,
        audioBuffer = this.audioCtx.createBuffer(this.option.channels, length, this.option.sampleRate),
        audioData,
        channel,
        offset,
        i;

    for (channel = 0; channel < this.option.channels; channel++) {
        audioData = audioBuffer.getChannelData(channel);
        offset = channel;
        for (i = 0; i < length; i++) {
            audioData[i] = this.samples[offset];
            offset += this.option.channels;
        }
    }

    if (this.startTime < this.audioCtx.currentTime) {
        this.startTime = this.audioCtx.currentTime;
    }

    bufferSource.buffer = audioBuffer;
    bufferSource.connect(this.pannerNode); // Connect to the panner node
    bufferSource.start(this.startTime);
    this.startTime += audioBuffer.duration;
    this.samples = new Float32Array();
};

PCMPlayer.prototype.destroy = function() {
    console.log("destroy PCMPlayer");
    if (this.audioCtx && this.scriptNode) {
        this.scriptNode.disconnect();
        this.scriptNode = null;
    }
    if (this.audioCtx) {
        this.audioCtx.close();
        this.audioCtx = null;
    }
    this.samples = [];
};

PCMPlayer.prototype.startRecording = function() {
    if (!this.audioCtx) {
        console.error("AudioContext is not initialized.");
        return;
    }

    // Create a MediaStreamDestination to capture the audio output
    this.mediaStreamDestination = this.audioCtx.createMediaStreamDestination();
    this.gainNode.connect(this.mediaStreamDestination); // Connect the gain node to the destination

    // Initialize MediaRecorder
    this.mediaRecorder = new MediaRecorder(this.mediaStreamDestination.stream);
    this.recordedChunks = [];

    // Collect audio data chunks
    this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
            this.recordedChunks.push(event.data);
        }
    };

    // Start recording
    this.mediaRecorder.start();
    console.log("Recording started...");
};

PCMPlayer.prototype.stopRecording = function(frequency, mode) {
    if (!this.mediaRecorder) {
        console.error("MediaRecorder is not initialized.");
        return;
    }

    // Stop the MediaRecorder
    this.mediaRecorder.stop();
    console.log("Recording stopped...");

    // Save the recorded audio when recording stops
    this.mediaRecorder.onstop = () => {
        const blob = new Blob(this.recordedChunks, { type: 'audio/wav' });
        const url = URL.createObjectURL(blob);

        // Generate the filename in 24-hour Zulu format with underscores
        const now = new Date();
        const zuluTime = now.toISOString()
            //.replace(/-/g, '_') // Replace dashes with underscores
            .replace(/:/g, '_') // Replace colons with underscores
            .split('.')[0] + 'Z'; // Remove milliseconds and append 'Z'

        // Append frequency and mode to the filename
        const formattedFrequency = parseFloat(frequency).toFixed(2); // Format frequency to 2 decimal places
        const filename = `${zuluTime}_${formattedFrequency}_${mode}.wav`;

        // Create a download link
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = filename; // Use the generated filename
        document.body.appendChild(a);
        a.click();

        // Clean up
        URL.revokeObjectURL(url);
        document.body.removeChild(a);
        console.log(`Audio file saved as '${filename}'.`);
    };
};