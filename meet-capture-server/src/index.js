import 'dotenv/config';
import { WebSocketServer } from 'ws';
import { createClient } from '@deepgram/sdk';
import admin from 'firebase-admin';
import { readFileSync } from 'fs';

// ── Startup config validation ─────────────────────────────────────────────────
console.log('🚀 [startup] meet-capture-server starting');
console.log('🔑 [startup] DEEPGRAM_API_KEY:', process.env.DEEPGRAM_API_KEY ? `✅ set (${process.env.DEEPGRAM_API_KEY.slice(0, 6)}…)` : '❌ MISSING');
console.log('🔑 [startup] FIREBASE_SERVICE_ACCOUNT_PATH:', process.env.FIREBASE_SERVICE_ACCOUNT_PATH ? `✅ ${process.env.FIREBASE_SERVICE_ACCOUNT_PATH}` : '❌ MISSING');
console.log('🔌 [startup] PORT:', process.env.PORT ?? '3001 (default)');

// ── Firebase Admin ────────────────────────────────────────────────────────────
let serviceAccount;
try {
  serviceAccount = JSON.parse(
    readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, 'utf8')
  );
  console.log('🔥 [startup] Firebase service account loaded — project:', serviceAccount.project_id);
} catch (e) {
  console.error('❌ [startup] Failed to load Firebase service account:', e.message);
  process.exit(1);
}
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://studypup-b3973-default-rtdb.firebaseio.com',
});
const rtdb = admin.database();
console.log('✅ [startup] Firebase Admin READY');

// ── Deepgram ──────────────────────────────────────────────────────────────────
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);
console.log('✅ [startup] Deepgram client READY');

// ── WebSocket server ──────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT ?? '3001', 10);
const wss = new WebSocketServer({ port: PORT });
console.log(`✅ [server] WebSocket server LISTENING on ws://0.0.0.0:${PORT}`);
console.log('⏳ [server] Waiting for connections…\n');

// Phone clients indexed by sessionId so writeChunk can push directly to the phone
const phoneClients = new Map(); // sessionId → WebSocket

wss.on('connection', (clientWs, req) => {
  const remoteIp = req.socket.remoteAddress;
  let clientType = null; // 'extension' | 'phone'
  let sessionId = null;
  let deepgramLive = null;
  let rtdbChunkCounter = 0;
  let audioChunkCounter = 0;
  let isDeepgramReady = false;
  const audioBuffer = [];
  let pingInterval = null;

  console.log(`🔗 [server] New client connected — ip: ${remoteIp} | total active: ${wss.clients.size}`);

  function writeChunk(speaker, text) {
    const chunkId = `${Date.now()}_${rtdbChunkCounter++}`;
    const timestamp = Date.now();
    console.log(`💾 [rtdb] Writing chunk #${rtdbChunkCounter} — Speaker ${speaker}: "${text}"`);
    rtdb.ref(`meetings/${sessionId}/chunks/${chunkId}`).set({
      speaker,
      text,
      timestamp,
    }).then(() => {
      console.log(`✅ [rtdb] Chunk #${rtdbChunkCounter} written — id: ${chunkId}`);
    }).catch((e) => console.error('❌ [rtdb] Write error:', e.message));

    // Push chunk directly to the phone client for low-latency delivery
    const phoneWs = phoneClients.get(sessionId);
    if (!phoneWs) {
      const registered = [...phoneClients.keys()].map((k) => k.slice(0, 8)).join(', ') || 'none';
      console.warn(`⚠️ [phone] No phone client for session ${sessionId.slice(0, 8)} — registered: [${registered}]`);
    } else if (phoneWs.readyState !== phoneWs.OPEN) {
      console.warn(`⚠️ [phone] Phone socket not OPEN (readyState=${phoneWs.readyState}) — session: ${sessionId.slice(0, 8)}`);
    } else {
      phoneWs.send(JSON.stringify({ type: 'chunk', id: chunkId, speaker, text, timestamp }));
      console.log(`📲 [phone] Chunk pushed to phone — session: ${sessionId.slice(0, 8)} | Speaker ${speaker}: "${text.slice(0, 40)}${text.length > 40 ? '…' : ''}"`);
    }
  }

  function openDeepgram() {
    console.log(`🎙️ [deepgram] Opening live connection — session: ${sessionId.slice(0, 8)}`);
    deepgramLive = deepgram.listen.live({
      encoding: 'linear16',
      sample_rate: 16000,
      channels: 1,
      diarize: true,
      interim_results: true,
      punctuate: true,
      language: 'en-US',
      endpointing: 300,
    });

    deepgramLive.addListener('open', () => {
      console.log(`✅ [deepgram] Connection OPEN — session: ${sessionId.slice(0, 8)}`);
      isDeepgramReady = true;
      if (audioBuffer.length > 0) {
        console.log(`🔄 [deepgram] Flushing ${audioBuffer.length} buffered audio chunks (${audioBuffer.reduce((n, b) => n + b.length, 0)} bytes)`);
        for (const buf of audioBuffer) deepgramLive.send(buf);
        audioBuffer.length = 0;
        console.log(`✅ [deepgram] Buffer flushed — Deepgram now receiving live audio`);
      } else {
        console.log(`🎙️ [deepgram] READY — waiting for audio from extension`);
      }
    });

    deepgramLive.addListener('Results', (data) => {
      if (!data.is_final) return;

      const alt = data?.channel?.alternatives?.[0];
      if (!alt) {
        console.log('🔇 [deepgram] Results — no alternative in payload');
        return;
      }
      if (!alt.transcript) {
        console.log('🔇 [deepgram] Results — empty transcript (silence)');
        return;
      }

      const wordCount = alt.words?.length ?? 0;
      const speakers = [...new Set((alt.words ?? []).map((w) => w.speaker))];
      console.log(`📝 [deepgram] ✅ Final transcript — ${wordCount} words, speakers: [${speakers.join(',')}]: "${alt.transcript}"`);

      const words = alt.words ?? [];
      if (words.length === 0) {
        writeChunk('0', alt.transcript);
        return;
      }

      const groups = [];
      let current = null;
      for (const w of words) {
        const spk = String(w.speaker ?? '0');
        if (!current || current.speaker !== spk) {
          current = { speaker: spk, words: [] };
          groups.push(current);
        }
        current.words.push(w.punctuated_word ?? w.word);
      }

      console.log(`✂️ [deepgram] ${groups.length} speaker group(s) — writing chunks`);
      for (const group of groups) {
        const text = group.words.join(' ').trim();
        if (text) writeChunk(group.speaker, text);
      }
    });

    deepgramLive.addListener('Metadata', (data) => {
      console.log('ℹ️ [deepgram] Metadata — request_id:', data?.request_id);
    });

    deepgramLive.addListener('error', (err) => {
      console.error('❌ [deepgram] Error:', err?.message ?? err);
    });

    deepgramLive.addListener('close', () => {
      console.log('🔌 [deepgram] Connection closed');
      isDeepgramReady = false;
      deepgramLive = null;
    });
  }

  // ── Incoming messages ─────────────────────────────────────────────────────
  clientWs.on('message', async (data, isBinary) => {
    if (!isBinary) {
      try {
        const msg = JSON.parse(data.toString());
        const HIGH_SENTINEL = String.fromCharCode(0xf8ff);

        if (msg.type === 'init' && msg.sessionCode) {
          // Chrome extension client
          clientType = 'extension';
          console.log(`🖥️ [extension] Chrome extension connected — ip: ${remoteIp}`);
          console.log(`🔍 [extension] Looking up session for code: ${msg.sessionCode}`);
          const codePrefix = msg.sessionCode.toLowerCase();
          const snap = await rtdb.ref('meetings')
            .orderByKey()
            .startAt(codePrefix)
            .endAt(codePrefix + HIGH_SENTINEL)
            .once('value');

          if (!snap.exists()) {
            console.warn(`⚠️ [extension] Session NOT FOUND for code: ${msg.sessionCode}`);
            clientWs.close(4001, 'Session not found');
            return;
          }
          snap.forEach((child) => { sessionId = child.key; });
          console.log(`✅ [extension] Session resolved: ${msg.sessionCode} → ${sessionId.slice(0, 8)}`);
          console.log(`🎙️ [extension] Opening Deepgram for session: ${sessionId.slice(0, 8)}`);
          openDeepgram();
        } else if (msg.type === 'phone' && msg.sessionCode) {
          // Phone app client — registers to receive transcript chunks
          clientType = 'phone';
          console.log(`📱 [phone] Phone app connected — ip: ${remoteIp}, code: ${msg.sessionCode}`);
          const codePrefix = msg.sessionCode.toLowerCase();
          const snap = await rtdb.ref('meetings')
            .orderByKey()
            .startAt(codePrefix)
            .endAt(codePrefix + HIGH_SENTINEL)
            .once('value');

          if (!snap.exists()) {
            console.warn(`⚠️ [phone] Session NOT FOUND for code: ${msg.sessionCode}`);
            clientWs.close(4001, 'Session not found');
            return;
          }
          snap.forEach((child) => { sessionId = child.key; });
          phoneClients.set(sessionId, clientWs);
          console.log(`✅ [phone] Phone REGISTERED — session: ${sessionId.slice(0, 8)} | total phone clients: ${phoneClients.size}`);
          console.log(`🟢 [phone] Pipeline ready — phone is listening for chunks`);
          clientWs.send(JSON.stringify({ type: 'registered', sessionId }));

          // Ping every 25 s to keep the connection alive through NAT/router idle timeouts
          pingInterval = setInterval(() => {
            if (clientWs.readyState === clientWs.OPEN) {
              clientWs.ping();
              console.log(`🏓 [phone] Ping sent — session: ${sessionId.slice(0, 8)}`);
            } else {
              console.warn(`⚠️ [phone] Ping skipped — socket not open (readyState=${clientWs.readyState}), clearing interval`);
              clearInterval(pingInterval);
              pingInterval = null;
            }
          }, 25000);
        }
      } catch (e) {
        console.error('❌ [server] Failed to parse control message:', e);
      }
      return;
    }

    // Binary = raw PCM audio from extension only
    if (clientType !== 'extension' || !sessionId) return;
    audioChunkCounter++;
    if (audioChunkCounter === 1) {
      console.log(`🔊 [audio] ✅ FIRST audio bytes received from extension — session: ${sessionId.slice(0, 8)}`);
      console.log(`🎙️ [audio] Deepgram ready: ${isDeepgramReady} | buffer size: ${audioBuffer.length}`);
    }
    if (audioChunkCounter % 50 === 0) {
      console.log(`🔊 [audio] ${audioChunkCounter} chunks received — deepgram ready: ${isDeepgramReady} | buffered: ${audioBuffer.length} | chunks written: ${rtdbChunkCounter}`);
    }
    if (audioBuffer.length > 200) {
      console.warn(`⚠️ [audio] Buffer has ${audioBuffer.length} chunks — Deepgram may not have opened yet`);
    }

    if (!isDeepgramReady || !deepgramLive) {
      audioBuffer.push(data);
      if (audioBuffer.length === 1) console.log(`⏳ [audio] Deepgram not ready — buffering audio (chunk #${audioChunkCounter})`);
      return;
    }
    try {
      deepgramLive.send(data);
    } catch (e) {
      console.error('❌ [audio] Deepgram send error, buffering:', e.message);
      audioBuffer.push(data);
    }
  });

  clientWs.on('close', (code, reason) => {
    if (clientType === 'phone') {
      if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
      if (sessionId) phoneClients.delete(sessionId);
      console.log(`📱🔌 [phone] Client disconnected — session: ${sessionId?.slice(0, 8)}, code: ${code}, reason: ${reason || 'none'} | remaining phone clients: ${phoneClients.size}`);
      return;
    }
    console.log(`🖥️🔌 [extension] Disconnected — session: ${sessionId?.slice(0, 8)}, code: ${code}, total audio chunks: ${audioChunkCounter}, transcript chunks written: ${rtdbChunkCounter}`);
    if (deepgramLive) {
      console.log('🎙️ [deepgram] Finalizing session…');
      try {
        deepgramLive.finalize();
        setTimeout(() => {
          try { deepgramLive?.requestClose(); } catch (_) {}
          console.log('✅ [deepgram] Session finalized and closed');
        }, 1500);
      } catch (_) {}
    }
  });

  clientWs.on('error', (err) => {
    console.error(`❌ [server] Client WS error (type=${clientType}, session=${sessionId?.slice(0, 8)}):`, err.message);
  });
});
