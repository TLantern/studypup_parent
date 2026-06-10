// Offscreen document — runs in a real browser context so getUserMedia and
// AudioWorklet are available. Handles the full audio → WebSocket pipeline.

const SERVER_URL = 'ws://localhost:3001';
const RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECT_ATTEMPTS = 10;

let ws = null;
let audioContext = null;
let tabStream = null;
let micStream = null;
let mediaStream = null;
let audioWorklet = null;
let sessionCode = null;
let reconnectAttempts = 0;
let isCapturing = false;

// ── Message bus from service worker ──────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'OFFSCREEN_START') {
    console.log('[offscreen] OFFSCREEN_START received — streamId:', msg.streamId, 'sessionCode:', msg.sessionCode);
    startCapture(msg.streamId, msg.sessionCode);
  }
  if (msg.type === 'OFFSCREEN_STOP') {
    console.log('[offscreen] OFFSCREEN_STOP received');
    stopCapture();
  }
});

// ── Capture pipeline ──────────────────────────────────────────────────────────
async function startCapture(streamId, code) {
  if (isCapturing) {
    console.log('[offscreen] Already capturing — stopping previous session first');
    stopCapture();
  }
  sessionCode = code;
  isCapturing = true;
  reconnectAttempts = 0;
  console.log(`🚀 [offscreen] Starting capture — session code: ${code}, server: ${SERVER_URL}`);

  // ── Tab audio (remote participants — what you HEAR) ───────────────────────
  try {
    tabStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    });
    const tracks = tabStream.getAudioTracks();
    console.log(`🔊 [offscreen] Tab audio stream OK — ${tracks.length} track(s)`);
    if (tracks[0]) {
      const s = tracks[0].getSettings();
      console.log(`🔊 [offscreen]   tab track — sampleRate: ${s.sampleRate}, channelCount: ${s.channelCount}, label: "${tracks[0].label}"`);
    }
  } catch (e) {
    console.error('❌ [offscreen] Tab audio capture failed:', e.name, e.message);
    isCapturing = false;
    return;
  }

  // ── Microphone audio (local participant — what YOU SAY) ───────────────────
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });
    const tracks = micStream.getAudioTracks();
    console.log(`🎤 [offscreen] Microphone stream OK — ${tracks.length} track(s)`);
    if (tracks[0]) {
      const s = tracks[0].getSettings();
      console.log(`🎤 [offscreen]   mic track — sampleRate: ${s.sampleRate}, channelCount: ${s.channelCount}, label: "${tracks[0].label}"`);
    }
  } catch (e) {
    // Non-fatal — fall back to tab-only if mic permission is denied
    if (e.name === 'NotAllowedError') {
      console.error(`❌ [offscreen] Mic permission NOT granted to extension — open permission.html in a tab to grant it. Falling back to tab-only (your own voice will NOT be captured).`);
    } else {
      console.warn(`⚠️ [offscreen] Microphone capture failed (${e.name}): ${e.message} — tab-only mode`);
    }
    micStream = null;
  }

  await initAudioPipeline(tabStream, micStream);
  connectWebSocket();
}

async function initAudioPipeline(tabAudioStream, micAudioStream) {
  console.log('🎛️ [offscreen] Initialising audio pipeline — target sampleRate: 16000 Hz');
  audioContext = new AudioContext({ sampleRate: 16000 });
  console.log(`🎛️ [offscreen] AudioContext created — state: ${audioContext.state}, actual sampleRate: ${audioContext.sampleRate} Hz`);

  if (audioContext.sampleRate !== 16000) {
    console.warn(`⚠️ [offscreen] AudioContext sampleRate is ${audioContext.sampleRate}, not 16000 — Deepgram may misread audio. Check your system audio device.`);
  }

  // Chrome suspends AudioContexts in offscreen docs that have no audio output.
  // Force it running and keep it alive with a silent oscillator.
  await audioContext.resume();
  console.log(`✅ [offscreen] AudioContext resumed — state: ${audioContext.state}`);

  const silentOsc = audioContext.createOscillator();
  const silentGain = audioContext.createGain();
  silentGain.gain.value = 0;
  silentOsc.connect(silentGain);
  silentGain.connect(audioContext.destination);
  silentOsc.start();

  // ── Audio graph: mix tab + mic into a single mono stream ─────────────────
  const mixer = audioContext.createGain();
  mixer.gain.value = 1.0;

  const tabSource = audioContext.createMediaStreamSource(tabAudioStream);
  tabSource.connect(mixer);
  console.log(`🔊 [offscreen] Tab audio source connected to mixer`);

  if (micAudioStream) {
    const micSource = audioContext.createMediaStreamSource(micAudioStream);
    micSource.connect(mixer);
    console.log(`🎤 [offscreen] Mic audio source connected to mixer`);
    console.log(`✅ [offscreen] BOTH tab + mic streams active — full duplex capture`);
  } else {
    console.warn(`⚠️ [offscreen] Mic unavailable — tab-only mode (remote participants only)`);
  }

  try {
    await audioContext.audioWorklet.addModule(
      chrome.runtime.getURL('audio-worklet-processor.js')
    );
    console.log('✅ [offscreen] AudioWorklet module loaded');
  } catch (e) {
    console.error('❌ [offscreen] AudioWorklet module failed to load:', e.message);
    return;
  }

  audioWorklet = new AudioWorkletNode(audioContext, 'pcm-processor');
  mixer.connect(audioWorklet);
  audioWorklet.connect(audioContext.destination);
  console.log('✅ [offscreen] Audio graph: [tab + mic] → mixer → worklet → destination');

  let chunkCount = 0;
  let totalBytes = 0;
  audioWorklet.port.onmessage = (event) => {
    chunkCount++;
    totalBytes += event.data.buffer.byteLength;
    if (chunkCount === 1) {
      console.log(`🔊 [offscreen] ✅ FIRST PCM chunk from worklet — size: ${event.data.buffer.byteLength} bytes (${event.data.buffer.byteLength / 2} samples)`);
    }
    if (chunkCount % 40 === 0) {
      console.log(`🔊 [offscreen] Audio flowing — ${chunkCount} chunks, ${(totalBytes / 1024).toFixed(1)} KB total, WS state: ${ws ? ['CONNECTING','OPEN','CLOSING','CLOSED'][ws.readyState] : 'null'}`);
    }
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(event.data.buffer);
  };

  audioContext.onstatechange = () => {
    console.warn(`⚠️ [offscreen] AudioContext state changed → ${audioContext?.state}`);
    if (audioContext && audioContext.state === 'suspended') {
      console.warn('⚠️ [offscreen] AudioContext suspended — attempting resume');
      audioContext.resume().then(() => {
        console.log(`✅ [offscreen] AudioContext resume result — state: ${audioContext?.state}`);
      });
    }
  };
}

function connectWebSocket() {
  if (!isCapturing) return;
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error(`❌ [offscreen] Max reconnects (${MAX_RECONNECT_ATTEMPTS}) reached — giving up`);
    stopCapture();
    return;
  }

  console.log(`🔌 [offscreen] Opening WebSocket → ${SERVER_URL} (attempt ${reconnectAttempts + 1}/${MAX_RECONNECT_ATTEMPTS})`);
  ws = new WebSocket(SERVER_URL);
  ws.binaryType = 'arraybuffer';

  ws.addEventListener('open', () => {
    console.log(`✅ [offscreen] WS open — sending init, sessionCode: ${sessionCode}`);
    reconnectAttempts = 0;
    ws.send(JSON.stringify({ type: 'init', sessionCode }));
  });

  ws.addEventListener('close', (e) => {
    console.warn(`⚠️ [offscreen] WS closed — code: ${e.code}, reason: "${e.reason}", wasClean: ${e.wasClean}`);
    ws = null;
    if (isCapturing) {
      reconnectAttempts++;
      console.log(`🔄 [offscreen] Scheduling reconnect in ${RECONNECT_DELAY_MS}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
      setTimeout(connectWebSocket, RECONNECT_DELAY_MS);
    }
  });

  ws.addEventListener('error', () => {
    console.error(`❌ [offscreen] WS error — server: ${SERVER_URL}, readyState: ${ws?.readyState}`);
  });
}

function stopCapture() {
  console.log(`🛑 [offscreen] Stopping capture — isCapturing was: ${isCapturing}`);
  isCapturing = false;
  if (ws) { ws.close(); ws = null; }
  if (audioWorklet) { audioWorklet.port.close(); audioWorklet.disconnect(); audioWorklet = null; }
  if (audioContext) { audioContext.close().then(() => console.log('✅ [offscreen] AudioContext closed')); audioContext = null; }
  if (tabStream) { tabStream.getTracks().forEach((t) => { t.stop(); console.log(`🔊 [offscreen] Tab track stopped: ${t.label}`); }); tabStream = null; }
  if (micStream) { micStream.getTracks().forEach((t) => { t.stop(); console.log(`🎤 [offscreen] Mic track stopped: ${t.label}`); }); micStream = null; }
  mediaStream = null;
  console.log('✅ [offscreen] Capture stopped');
}
