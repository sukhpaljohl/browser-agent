/**
 * Popup Script
 * Displays POMDP engine status and allows manual prompt submission.
 */
const BRIDGE_URL = 'http://localhost:3847';

const $ = (id) => document.getElementById(id);

// --- Status polling ---
async function refreshStatus() {
  // Agent status from content script
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (res) => {
    if (chrome.runtime.lastError || !res || !res.status) {
      $('convergenceState').textContent = 'No tab';
      return;
    }

    const s = res.status;
    const conv = s.convergence;

    // Convergence state
    const stateEl = $('convergenceState');
    if (conv.isConverged) {
      stateEl.textContent = 'CONVERGED';
      stateEl.className = 'value converged';
    } else if (s.epsilon > 0.05) {
      stateEl.textContent = 'EXPLORING';
      stateEl.className = 'value exploring';
    } else {
      stateEl.textContent = 'EXPLOITING';
      stateEl.className = 'value';
    }

    $('epsilon').textContent = s.epsilon.toFixed(4);
    $('shortTermSuccess').textContent = (conv.shortTermSuccess * 100).toFixed(1) + '%';
    $('longTermSuccess').textContent = (conv.longTermSuccess * 100).toFixed(1) + '%';
    $('iterations').textContent = s.iteration;
    $('trackedNodes').textContent = s.trackedNodes;
  });

  // Bridge status
  try {
    const res = await fetch(`${BRIDGE_URL}/api/status`);
    if (res.ok) {
      $('connectionStatus').textContent = 'Bridge online';
      $('connectionStatus').className = 'connection online';
    } else {
      throw new Error();
    }
  } catch {
    $('connectionStatus').textContent = 'Bridge offline';
    $('connectionStatus').className = 'connection offline';
  }
}

// --- Send prompt ---
$('sendBtn').addEventListener('click', async () => {
  const prompt = $('promptInput').value.trim();
  if (!prompt) return;

  $('sendBtn').disabled = true;
  $('sendBtn').textContent = 'Sending…';

  try {
    // Send via bridge server
    const res = await fetch(`${BRIDGE_URL}/api/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt })
    });

    if (res.ok) {
      const data = await res.json();
      $('sendBtn').textContent = `Queued (ID: ${data.id})`;

      // Poll for result
      pollResult(data.id);
    }
  } catch {
    // Fallback: send directly via content script
    chrome.runtime.sendMessage({ type: 'EXECUTE_PROMPT', prompt }, (result) => {
      if (result && result.success && result.response) {
        showResponse(result.response.text);
      } else {
        showResponse('Error: ' + (result?.error || 'No response'));
      }
      $('sendBtn').disabled = false;
      $('sendBtn').textContent = 'Send Prompt';
    });
  }
});

async function pollResult(id) {
  const maxAttempts = 60;
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(2000);

    try {
      const res = await fetch(`${BRIDGE_URL}/api/result?id=${id}`);
      if (res.ok) {
        const data = await res.json();
        if (data.response && data.response.text) {
          showResponse(data.response.text);
        } else if (data.error) {
          showResponse('Error: ' + data.error);
        } else {
          showResponse('Completed but no text extracted.');
        }
        $('sendBtn').disabled = false;
        $('sendBtn').textContent = 'Send Prompt';
        return;
      }
    } catch {
      // keep polling
    }
  }

  showResponse('Timeout — no response received.');
  $('sendBtn').disabled = false;
  $('sendBtn').textContent = 'Send Prompt';
}

function showResponse(text) {
  $('responseSection').style.display = 'block';
  $('responseText').textContent = text;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Boot
refreshStatus();
setInterval(refreshStatus, 5000);
