// Runs in the audio rendering thread (AudioWorkletGlobalScope).
// Accumulates Float32 audio samples from the tab capture stream,
// converts to signed Int16 (linear16 PCM), and posts 4096-sample
// chunks to the service worker for forwarding to Deepgram.
// At 16 kHz each chunk = 256 ms of audio — optimal Deepgram latency.

class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Int16Array(4096);
    this._pos = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      const s = Math.max(-1, Math.min(1, channel[i]));
      this._buffer[this._pos++] = s < 0 ? s * 0x8000 : s * 0x7fff;

      if (this._pos >= this._buffer.length) {
        // Transfer ownership of the buffer to avoid a copy
        const out = this._buffer.slice(0);
        this.port.postMessage(out, [out.buffer]);
        this._pos = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);
