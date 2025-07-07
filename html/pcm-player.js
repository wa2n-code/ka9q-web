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
    //this.audioCtx.resume();  Could be causing a problem and losing server connection to websocket wdr 7-6-2025

    // Create a gain node for volume control
    this.gainNode = this.audioCtx.createGain();
    // Do NOT set gainNode.gain.value here; let UI logic set it after creation

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
    //console.log("destroy PCMPlayer");
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
    //console.log("Recording started...");
};

PCMPlayer.prototype.stopRecording = function(frequency, mode) {
    if (!this.mediaRecorder) {
        console.error("MediaRecorder is not initialized.");
        return;
    }

    // Stop the MediaRecorder
    this.mediaRecorder.stop();
    //console.log("Recording stopped...");

    // Save the recorded audio when recording stops
    this.mediaRecorder.onstop = () => {
        //console.log("MediaRecorder onstop event triggered.");

        const audioBlob = new Blob(this.recordedChunks, { type: 'audio/webm' });
        //console.log("Audio Blob created:", audioBlob);

        // Decode the audio Blob into raw PCM data
        const reader = new FileReader();
        reader.onload = () => {
            //console.log("FileReader onload event triggered.");

            const arrayBuffer = reader.result;

            // Use AudioContext to decode the audio data
            const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            audioCtx.decodeAudioData(arrayBuffer, (audioBuffer) => {
                //console.log("Audio data decoded successfully.");

                // Resample the audio to the desired sample rate
                const targetSampleRate = this.option.sampleRate; // Use the player's sample rate (e.g., 12 kHz or 24 kHz)
                const offlineCtx = new OfflineAudioContext(
                    audioBuffer.numberOfChannels,
                    audioBuffer.duration * targetSampleRate,
                    targetSampleRate
                );

                const source = offlineCtx.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(offlineCtx.destination);
                source.start(0);

                offlineCtx.startRendering().then((resampledBuffer) => {
                    //console.log("Audio resampled to:", targetSampleRate);

                    // Extract PCM data from the resampled audio buffer
                    const numOfChannels = resampledBuffer.numberOfChannels;
                    const pcmData = [];

                    for (let channel = 0; channel < numOfChannels; channel++) {
                        pcmData.push(resampledBuffer.getChannelData(channel));
                    }

                    // Encode the PCM data into a valid .wav file
                    const wavBuffer = this.encodeWAV(pcmData, targetSampleRate, numOfChannels);
                    //console.log("WAV buffer created at sample rate:", targetSampleRate, "channels:", numOfChannels);

                    // Create a Blob for the .wav file
                    const wavBlob = new Blob([wavBuffer], { type: 'audio/wav' });
                    //console.log("WAV Blob created:", wavBlob);

                    // Generate the filename in 24-hour Zulu format with underscores
                    const now = new Date();
                    const zuluTime = now.toISOString()
                        .replace(/:/g, '_') // Replace colons with underscores
                        .split('.')[0] + 'Z'; // Remove milliseconds and append 'Z'

                    // Append frequency and mode to the filename
                    const formattedFrequency = parseFloat(frequency).toFixed(2); // Format frequency to 2 decimal places
                    const filename = `${zuluTime}_${formattedFrequency}_${mode}.wav`;

                    // Create a download link
                    const url = URL.createObjectURL(wavBlob);
                    const a = document.createElement('a');
                    a.style.display = 'none';
                    a.href = url;
                    a.download = filename; // Use the generated filename
                    document.body.appendChild(a);
                    a.click();
                    //console.log(`Download link triggered for file: ${filename}`);

                    // Clean up
                    URL.revokeObjectURL(url);
                    document.body.removeChild(a);
                    //console.log("Temporary download link removed.");
                });
            }, (error) => {
                console.error("Error decoding audio data:", error);
            });
        };

        reader.readAsArrayBuffer(audioBlob);
    };
};

// Helper function to encode PCM data into a valid .wav file
PCMPlayer.prototype.encodeWAV = function(pcmData, sampleRate, numOfChannels) {
    const bitsPerSample = 16; // Assuming 16-bit PCM
    const byteRate = (sampleRate * numOfChannels * bitsPerSample) / 8;
    const blockAlign = (numOfChannels * bitsPerSample) / 8;

    // Calculate the total data size
    const dataSize = pcmData[0].length * numOfChannels * (bitsPerSample / 8);

    const buffer = new ArrayBuffer(44 + dataSize); // 44 bytes for WAV header
    const view = new DataView(buffer);

    // Write WAV header
    let offset = 0;

    // "RIFF" chunk descriptor
    this.writeString(view, offset, 'RIFF'); offset += 4;
    view.setUint32(offset, 36 + dataSize, true); offset += 4; // File size - 8 bytes
    this.writeString(view, offset, 'WAVE'); offset += 4;

    // "fmt " sub-chunk
    this.writeString(view, offset, 'fmt '); offset += 4;
    view.setUint32(offset, 16, true); offset += 4; // Sub-chunk size (16 for PCM)
    view.setUint16(offset, 1, true); offset += 2; // Audio format (1 for PCM)
    view.setUint16(offset, numOfChannels, true); offset += 2; // Number of channels
    view.setUint32(offset, sampleRate, true); offset += 4; // Sample rate
    view.setUint32(offset, byteRate, true); offset += 4; // Byte rate
    view.setUint16(offset, blockAlign, true); offset += 2; // Block align
    view.setUint16(offset, bitsPerSample, true); offset += 2; // Bits per sample

    // "data" sub-chunk
    this.writeString(view, offset, 'data'); offset += 4;
    view.setUint32(offset, dataSize, true); offset += 4; // Data size

    // Write PCM data
    for (let i = 0; i < pcmData[0].length; i++) {
        for (let channel = 0; channel < numOfChannels; channel++) {
            const sample = Math.max(-1, Math.min(1, pcmData[channel][i])); // Clamp sample to [-1, 1]
            const intSample = sample < 0
                ? sample * 0x8000
                : sample * 0x7FFF; // Convert to 16-bit PCM
            view.setInt16(offset, intSample, true);
            offset += 2;
        }
    }

    return buffer;
};

// Helper function to write strings to DataView
PCMPlayer.prototype.writeString = function(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
    }
};