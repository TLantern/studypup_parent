// Standalone extension page opened in a REAL TAB so Chrome can show the
// microphone permission prompt. Popups and offscreen documents cannot prompt
// for mic access — the permission is bound to the extension origin, so granting
// it here once unlocks getUserMedia({audio:true}) everywhere (incl. offscreen).

const grantBtn = document.getElementById('grant-btn');
const statusEl = document.getElementById('status');

function setStatus(msg, kind = '') {
  statusEl.textContent = msg;
  statusEl.className = 'status' + (kind ? ' ' + kind : '');
}

async function requestMic() {
  grantBtn.disabled = true;
  setStatus('Requesting access…');
  console.log('🎤 [permission] Requesting microphone access…');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // We only needed the prompt — stop the tracks immediately. The grant
    // persists for the extension origin.
    stream.getTracks().forEach((t) => t.stop());
    console.log('✅ [permission] Microphone access GRANTED');
    chrome.storage.local.set({ micGranted: true });
    setStatus('✓ Microphone enabled! You can close this tab.', 'ok');
    setTimeout(() => { try { window.close(); } catch {} }, 1400);
  } catch (e) {
    console.error('❌ [permission] Microphone access denied:', e.name, e.message);
    chrome.storage.local.set({ micGranted: false });
    setStatus('Access denied. Click to try again, or enable it in Chrome site settings.', 'err');
    grantBtn.disabled = false;
  }
}

grantBtn.addEventListener('click', requestMic);

// Auto-trigger on load so the user sees the prompt right away.
requestMic();
