---
name: human-engine
description: Human-Like Interaction Model v4.0 — Data-driven motor control engine that generates mouse movements, keyboard input, and scrolling statistically indistinguishable from real human behavior, trained on the CaptchaSolve30k dataset. Goal is to pass reCAPTCHA v3 behavioral analysis.
---

# Human-Like Interaction Model v4.0

## What This Is

A **data-driven human interaction engine** that replaces bot-like browser automation (teleported clicks, instant typing) with biomechanically-grounded behavior. Every mouse movement, keystroke, and scroll event is generated from statistical models **trained on a representative 1,000-session sample** of the CaptchaSolve30k dataset (at 1000Hz/240Hz).

The engine integrates with the existing POMDP Browser Agent extension and dispatches all events via Chrome DevTools Protocol (CDP) to ensure `isTrusted: true`.

**Primary goal**: Pass reCAPTCHA v3 behavioral analysis with score ≥ 0.7.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     HUMAN ENGINE v4.0                        │
│                                                             │
│  UserProfile (persistent identity, localStorage)            │
│    └─ SessionState (fatigue, confidence, frustration)        │
│        └─ AttentionField (spatial perception, search time)   │
│            └─ MotorModel (dataset-calibrated distributions)  │
│                ├─ TrajectoryGenerator (Bézier + noise)       │
│                ├─ SegmentMatcher (1,923 real templates)      │
│                └─ KeystrokeEngine (keyDown/keyUp cycles)     │
│                                                             │
│  All output → CDP via service-worker.js (cdp_command)       │
└─────────────────────────────────────────────────────────────┘
```

### Layer Details

| Layer | File | Purpose |
|-------|------|---------|
| **Motor Model** | `extension/motor/motor-model.js` | Loads `motor-fingerprint.json` (calibrated from dataset). Provides sampling functions: `samplePeakVelocity()`, `sampleDuration(distance)`, `sampleOvershoot()`, `sampleCurvature()`, `sampleJitter(fatigue)`, `sampleClickHold()`. All use fitted distributions (lognormal, gamma). |
| **Trajectory Generator** | `extension/motor/trajectory-generator.js` | Generates cubic Bézier mouse paths with: asymmetric velocity profile (peak at 38%), overshoot-and-correct (9.4% probability), submovement decomposition, jitter/drift noise layers, polling rate quantization. Output: `[{x, y, t, delay}]` array. |
| **Segment Matcher** | `extension/motor/segment-matcher.js` | 1,923 real trajectory templates extracted from dataset, normalized to unit vectors. Rotates/scales to fit any start→end pair. Categories: short/medium/long × linear/curved/precision/overshoot. |
| **Keystroke Engine** | `extension/motor/keystroke-engine.js` | Full `keyDown→char→keyUp` cycle per character. Bigram-aware inter-key timing (fast: "th"=95ms, slow: "qp"=190ms). 2.5% typo rate with backspace correction. Shift key coordination. |
| **User Profile** | `extension/motor/user-profile.js` | Persistent motor personality stored in localStorage. Traits: `baseMotorSpeed`, `motorPrecision`, `hesitationLevel`, `fatigueRate`, `hardware.dpi/pollingRate`. Drifts ±2% between sessions. |
| **Session State** | `extension/motor/session-state.js` | Dynamic cognitive state: fatigue (increases over time, accelerates after 30min), confidence (builds with success), frustration (builds with errors), arousal, cognitiveLoad. Modulates all motor output. |
| **Attention Field** | `extension/motor/attention-field.js` | Spatial attention model with Gaussian falloff from focus center. Calculates visual search time for elements. Generates idle gaze movements and hover-without-click. |
| **Human Engine** | `extension/motor/human-engine.js` | **Unified orchestrator**. Composes all layers into a single API: `click(selector)`, `hover(selector)`, `type(text)`, `scroll(deltaY)`, `read(durationMs)`. Handles initialization, data loading, and CDP dispatch. |

---

## Dataset Pipeline

Located in `tools/dataset/`. Python scripts that process the CaptchaSolve30k dataset.

| Script | Purpose |
|--------|---------|
| `download_sample.py` | Downloads N sessions via HuggingFace streaming. Default 1000. |
| `decoder.py` | Decodes binary `inputStream` format (float32 x,y + uint8 button per sample). |
| `analyze.py` | **Main pipeline**. Uses `tickInputs` (240Hz). Extracts velocity, acceleration, curvature, submovements, overshoot, jitter, click timing. Fits distributions (lognormal, gamma). Outputs `motor_fingerprint.json`. |
| `extract_segments.py` | Extracts real trajectory segments, normalizes to unit vectors, classifies by distance/type. Outputs `trajectory_segments.json`. |
| `export_fingerprint.py` | Copies analysis outputs to `extension/data/` for runtime loading. |

### Key Dataset Findings (from 874 sessions, 10,505 movements)

| Metric | Value | Significance |
|--------|-------|-------------|
| Peak velocity distribution | **Lognormal** | Not Gaussian — this is what detection systems check |
| Time-to-peak velocity | **0.384** (38% of movement) | Humans accelerate fast, decelerate slowly |
| Velocity asymmetry | **2.54** | Deceleration 2.5× longer than acceleration |
| Path efficiency | **0.843** | Humans take ~84% efficient paths (curved!) |
| Overshoot probability | **9.4%** | ~1 in 10 movements overshoot target |
| Curvature | **0.043** | Measurable deviation from straight lines |
| Fitts' Law R² | **0.29** | Moderate fit (expected for varied task types) |

---

## What reCAPTCHA v3 Analyzes

reCAPTCHA v3 scores user behavior 0.0 (bot) → 1.0 (human) by monitoring:

1. **Mouse**: Trajectory shape, velocity profile, acceleration curves, jitter patterns
2. **Keyboard**: Typing rhythm, inter-keystroke timing, correction patterns
3. **Scrolling**: Speed, cadence, direction changes
4. **Browser fingerprint**: `navigator.webdriver`, GPU, plugins, canvas
5. **Cookies**: Google account trust signals
6. **IP reputation**: Data center vs. residential
7. **Cross-site signals**: Behavior consistency across sites

Our engine addresses signals 1-3 (behavioral) and our existing stealth audit covers signal 4. Signals 5-7 are environmental and outside the engine's scope.

---

## Input Dispatch Strategy

**Current: CDP (Tier 1)** — All events dispatched via `chrome.debugger.sendCommand()`:
- `Input.dispatchMouseEvent` (mouseMoved, mousePressed, mouseReleased, mouseWheel)
- `Input.dispatchKeyEvent` (rawKeyDown, char, keyUp)
- Events are `isTrusted: true`
- Limitation: `screenX/Y` may equal `clientX/Y` (detectable by sophisticated systems)

**Future upgrade path** (not yet built):
- **Tier 2**: Native Messaging Host with Windows `SendInput` (OS-level, but tagged `LLMHF_INJECTED`)
- **Tier 3**: HID emulation via Arduino/Pico (hardware-level, fully undetectable)

The architecture is designed so upgrading tiers only requires swapping the dispatch layer — all trajectory generation remains the same.

---

## Build Status

### ✅ Phase 1: Dataset Pipeline (COMPLETE)
- Downloaded 1,000 sessions (169 MB)
- Extracted 10,505 movements from 874 sessions
- Generated `motor-fingerprint.json` (7.1 KB) with fitted distributions
- Generated `trajectory-segments.json` (2 MB) with 1,923 templates

### ✅ Phase 2: Motor Control Engine (COMPLETE)
- `motor-model.js` — Statistical sampling from fitted distributions
- `trajectory-generator.js` — Bézier + velocity profile + overshoot + submovements + noise
- `segment-matcher.js` — Real trajectory template bank
- `keystroke-engine.js` — Full keyDown/keyUp + bigram timing + typo correction

### ✅ Phase 3: Cognitive Layers (COMPLETE)
- `user-profile.js` — Persistent identity with cross-session drift
- `session-state.js` — Fatigue/confidence/frustration/arousal dynamics
- `attention-field.js` — Spatial attention + idle gaze + reading time
- `human-engine.js` — Unified orchestrator with click/type/scroll/read API

### ✅ Infrastructure (COMPLETE)
- `service-worker.js` — Added `cdp_command` passthrough handler and secure `FETCH_JSON` resource server.
- `manifest.json` — Registered 8 motor scripts. Removed `web_accessible_resources` to close probing vectors.
- **Scope Isolation** — Eliminated all `window.*` state leaks; implemented private `var BrowserAgent` namespace isolated from the target webpage.

### ✅ Phase 4: Integration & Validation (COMPLETE)
- ✅ Wire `HumanEngine` into `apple-strategy.js` — graceful fallback to raw CDP
- ✅ Create `test-strategy.js` for testing raw interactions on validation sites
- ✅ Test on bot.sannysoft.com (baseline) — **100% Passed**
- ✅ Test on reCAPTCHA v3 demo — **Achieved 0.9 Human Score** (Target was ≥ 0.7)
- ✅ Test on behavioral analytics (fingerprint checks pass successfully with CDP blinded)

---

## File Map

```
browser-agent/
├── extension/
│   ├── motor/                              ← MOTOR ENGINE (Phase 2-3)
│   │   ├── motor-model.js                 ← Statistical sampling
│   │   ├── trajectory-generator.js        ← Bézier path generation
│   │   ├── segment-matcher.js             ← Real trajectory templates
│   │   ├── keystroke-engine.js            ← Full keystroke cycles
│   │   ├── user-profile.js               ← Persistent identity
│   │   ├── session-state.js              ← Dynamic cognitive state
│   │   ├── attention-field.js            ← Spatial attention model
│   │   └── human-engine.js               ← Unified orchestrator
│   ├── data/                              ← RUNTIME DATA
│   │   ├── motor-fingerprint.json        ← Calibrated distributions (7.1 KB)
│   │   └── trajectory-segments.json      ← 1,923 real templates (2 MB)
│   ├── strategies/
│   │   ├── apple-strategy.js             ← Integrated with HumanEngine
│   │   └── test-strategy.js              ← Generic test harness
│   ├── background/
│   │   └── service-worker.js             ← CDP passthrough added
│   └── manifest.json                      ← Motor scripts registered
├── tools/
│   └── dataset/                           ← ANALYSIS PIPELINE (Phase 1)
│       ├── download_sample.py            ← Dataset downloader
│       ├── decoder.py                    ← Binary format decoder
│       ├── analyze.py                    ← Feature extraction (v2, uses tickInputs 240Hz)
│       ├── extract_segments.py           ← Trajectory segment extractor
│       ├── export_fingerprint.py         ← JSON export to extension
│       ├── inspect_data.py               ← Data diagnostic tool
│       └── data/
│           ├── sample_1000.json          ← Raw dataset (169 MB)
│           ├── motor_fingerprint.json    ← Analysis output
│           └── trajectory_segments.json  ← Segment output
```

---

## How to Use (for the next session)

### Using in New Strategies

The engine is fully built and wired into `apple-strategy.js` and `test-strategy.js`. To integrate it into a new strategy (e.g., `chatgpt-strategy.js`):

1. **Initialize Engine**:
   ```javascript
   const engine = new HumanEngine();
   await engine.init();
   ```
2. **Replace CDP Calls**:
   ```javascript
   await engine.click('#some-button');
   await engine.type('search text', { selector: '#search-input' });
   await engine.scroll(500);
   ```

### Re-running the dataset pipeline (if needed)

```bash
cd browser-agent/tools/dataset
python download_sample.py --count 1000    # Download dataset
python analyze.py                          # Extract motor features
python extract_segments.py                 # Extract trajectory templates
python export_fingerprint.py               # Copy to extension/data/
```

### Key API (HumanEngine)

```javascript
const engine = new HumanEngine();
await engine.init();                                    // Load data, create profile

await engine.click('#button');                          // Move + click with full trajectory
await engine.hover('#menu-item');                       // Move without clicking
await engine.type('hello world', {selector: '#input'}); // Realistic typing
await engine.scroll(500);                               // Scroll down 500px
await engine.read(3000);                                // Idle cursor + micro-movements for 3s
engine.getDebugState();                                 // Inspect internal state
engine.destroy();                                       // Clean up
```

---

## Design Decisions

1. **Data-driven, not heuristic**: All motor parameters come from real human data (CaptchaSolve30k), not guessed constants. This is what makes the output statistically indistinguishable.

2. **State-driven, not random**: Behavior variations come from internal state (fatigue, confidence) not random noise. This creates coherent "personality" that detection systems expect.

3. **Hybrid trajectory generation**: Real trajectory shapes from templates + per-instance noise from statistical model = unique outputs that follow real human patterns.

4. **CDP dispatch (Tier 1)**: Chosen for fastest iteration. Upgrade path to Native Host and HID is designed in but not built.

5. **tickInputs over inputStream**: The dataset's `inputStream` (1000Hz binary) had NaN issues. `tickInputs` (240Hz JSON) provides clean, reliable data. The 240Hz rate is more than sufficient for motor feature extraction.

6. **Perception/intention layers simplified**: Instead of separate perception-engine and intention-engine modules, their functionality was folded into `attention-field.js` and `human-engine.js` for simpler architecture with the same behavioral effect.

7. **Zero-leak architecture**: All data loading happens over IPC to the background worker (`FETCH_JSON`), meaning `web_accessible_resources` is completely empty. The target website cannot probe for extension files. All state is held in a private `var` namespace inaccessible to the Main World.
