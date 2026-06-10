// Service worker — orchestrates the offscreen document which handles all audio/WebSocket work.
// Service workers in MV3 have no DOM, so getUserMedia and AudioWorklet must live in an
// offscreen document instead.

const OFFSCREEN_URL = chrome.runtime.getURL('offscreen.html');

async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument();
  if (!existing) {
    console.log('[background] Creating offscreen document');
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
      justification: 'Capture tab audio and run AudioWorklet for real-time meeting transcription',
    });
    console.log('[background] ✓ Offscreen document created');
  } else {
    console.log('[background] Offscreen document already exists — reusing');
  }
}

async function closeOffscreen() {
  const existing = await chrome.offscreen.hasDocument();
  if (existing) {
    await chrome.offscreen.closeDocument();
    console.log('[background] Offscreen document closed');
  }
}

// Listen for messages from the popup
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'START_CAPTURE') {
    console.log(`[background] START_CAPTURE — sessionCode: ${msg.sessionCode}, streamId: ${msg.streamId?.slice(0, 12)}…`);
    ensureOffscreen()
      .then(() => {
        chrome.runtime.sendMessage({
          type: 'OFFSCREEN_START',
          streamId: msg.streamId,
          sessionCode: msg.sessionCode,
        });
        chrome.action.setBadgeText({ text: '●' });
        chrome.action.setBadgeBackgroundColor({ color: '#EF4444' });
        chrome.storage.session.set({ isRecording: true });
        console.log('[background] ✓ OFFSCREEN_START sent, badge set');
        sendResponse({ success: true });
      })
      .catch((e) => {
        console.error('[background] ❌ ensureOffscreen failed:', e.message);
        sendResponse({ success: false, error: e.message });
      });
    return true;
  }

  if (msg.type === 'STOP_CAPTURE') {
    console.log('[background] STOP_CAPTURE — sending OFFSCREEN_STOP and closing offscreen doc');
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' });
    closeOffscreen();
    chrome.action.setBadgeText({ text: '' });
    chrome.storage.session.remove(['isRecording']);
    sendResponse({ success: true });
  }
});
