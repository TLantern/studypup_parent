const codeInput = document.getElementById('code-input');
const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const startSection = document.getElementById('start-section');
const recordingSection = document.getElementById('recording-section');
const statusMsg = document.getElementById('status-msg');

function showStatus(msg, isError = false) {
  statusMsg.textContent = msg;
  statusMsg.className = 'status' + (isError ? ' error' : '');
}

function setRecordingMode(isRecording) {
  if (isRecording) {
    startSection.classList.add('hidden');
    recordingSection.classList.add('visible');
  } else {
    startSection.classList.remove('hidden');
    recordingSection.classList.remove('visible');
  }
}

// Restore state if popup is reopened while recording is active
chrome.storage.session.get(['isRecording'], (result) => {
  if (result.isRecording) {
    setRecordingMode(true);
    showStatus('');
  }
});

// Auto-uppercase input
codeInput.addEventListener('input', () => {
  const pos = codeInput.selectionStart;
  codeInput.value = codeInput.value.toUpperCase();
  codeInput.setSelectionRange(pos, pos);
});

// Mic permission is bound to the extension origin and can only be prompted
// from a real tab (not a popup/offscreen). Ensure it's granted before capture
// so the offscreen document can mix in the user's own microphone.
async function ensureMicPermission() {
  try {
    const status = await navigator.permissions.query({ name: 'microphone' });
    if (status.state === 'granted') return true;
  } catch {
    // permissions.query may not support 'microphone' on some builds — fall back
    // to the stored flag set by permission.js.
    const { micGranted } = await chrome.storage.local.get('micGranted');
    if (micGranted) return true;
  }
  // Not granted yet — open the permission page in a real tab to trigger the prompt.
  chrome.tabs.create({ url: chrome.runtime.getURL('permission.html') });
  return false;
}

startBtn.addEventListener('click', async () => {
  const code = codeInput.value.trim();
  if (code.length < 8) {
    showStatus('Enter the 8-character code from your Notario app.', true);
    return;
  }

  startBtn.disabled = true;

  // Step 1 — make sure mic access is granted (needed to capture your own voice).
  showStatus('Checking microphone access…');
  const micOk = await ensureMicPermission();
  if (!micOk) {
    showStatus('Allow microphone in the new tab, then click Start again.', true);
    startBtn.disabled = false;
    return;
  }

  showStatus('Requesting tab capture permission…');

  try {
    // getMediaStreamId must be called from a user gesture in an extension popup
    const streamId = await new Promise((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId({}, (id) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(id);
        }
      });
    });

    const response = await chrome.runtime.sendMessage({
      type: 'START_CAPTURE',
      streamId,
      sessionCode: code,
    });

    if (response?.success) {
      setRecordingMode(true);
      showStatus('');
    } else {
      showStatus(response?.error ?? 'Failed to start capture.', true);
      startBtn.disabled = false;
    }
  } catch (err) {
    showStatus(err.message ?? 'Error starting capture.', true);
    startBtn.disabled = false;
  }
});

stopBtn.addEventListener('click', async () => {
  stopBtn.disabled = true;
  await chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' });
  setRecordingMode(false);
  showStatus('Session ended.');
  startBtn.disabled = false;
  stopBtn.disabled = false;
});
