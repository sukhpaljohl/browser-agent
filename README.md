# POMDP Browser Agent

A **Hybrid Adaptive Decision System** Chrome extension that enables resilient, intelligent interaction with browser-based LLMs (ChatGPT). Built on a POMDP (Partially Observable Markov Decision Process) architecture with Bayesian bandits, control-system hysteresis, and online learning.

## Architecture

```
browser-agent/
├── extension/                  # Chrome Extension (Manifest V3)
│   ├── manifest.json
│   ├── background/
│   │   └── service-worker.js   # Keep-alive & message routing
│   ├── content/
│   │   └── content.js          # Main orchestrator on ChatGPT pages
│   ├── core/
│   │   ├── belief-state.js     # CV tracking, node confidence
│   │   ├── reward.js           # Per-host utility functions
│   │   ├── exploration.js      # Uncertainty-driven ε with floor
│   │   ├── convergence.js      # Hysteresis & drift detection
│   │   ├── credit-assignment.js# Temporal γ propagation
│   │   ├── path-selector.js    # Correlated Top-K selection
│   │   └── pomdp-engine.js     # Central orchestrator
│   ├── strategies/
│   │   └── chatgpt-strategy.js # ChatGPT DOM interaction
│   ├── popup/
│   │   ├── popup.html
│   │   ├── popup.css
│   │   └── popup.js
│   └── icons/
└── server/
    ├── bridge.js               # HTTP bridge (localhost:3847)
    └── package.json
```

## Key Features

| Feature | Implementation |
|---|---|
| **CV with Clamping** | `cv = std / max(mean, 0.05)` — prevents infinity at low means |
| **Continuous Outcomes** | `outcome ∈ [0,1]` — eliminates binary quantization noise |
| **Context-Sensitive α** | Learning rate scales with uncertainty — fast in unknown territory, stable when confident |
| **Temporal Credit** | `γ = 0.8` backward propagation — prevents unfair early-step penalization |
| **Uncertainty-Driven ε** | `ε = max(base × CV, 0.02)` — exploration driven by actual variance, not success streaks |
| **Hysteresis Convergence** | Enter at >0.90, exit at <0.85 — prevents state-machine flickering |
| **Drift Detection** | `shortTerm < longTerm - δ` triggers re-exploration |
| **Periodic Probing** | Every Nth iteration forces exploration to catch silent UI changes |
| **Correlated Top-K** | Pearson correlation check ensures genuinely diverse fallback paths |

## Quick Start

### 1. Start the Bridge Server

```bash
cd server
node bridge.js
```

### 2. Load the Extension

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select the `extension/` folder
4. Open [ChatGPT](https://chatgpt.com) in a tab

### 3. Send a Prompt

```bash
# Via the bridge server API
curl -X POST http://localhost:3847/api/prompt \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Hello, explain quantum computing in simple terms."}'

# Poll for result
curl http://localhost:3847/api/result?id=1
```

Or use the extension popup to type and send prompts directly.

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/prompt` | Queue a prompt `{ prompt: string }` |
| `GET` | `/api/pending` | Content script polls for next prompt |
| `POST` | `/api/response` | Content script posts ChatGPT response |
| `GET` | `/api/result?id=N` | Retrieve completed response |
| `GET` | `/api/status` | Bridge health check |

## How It Works

1. **Prompt Queued** → External tool POSTs to `/api/prompt`
2. **Content Script Polls** → Picks up the prompt from `/api/pending`
3. **POMDP Engine Decides** → Selects the best DOM interaction strategy (input method, send method, extraction method) based on learned confidence
4. **ChatGPT Interacts** → Types prompt, clicks send, waits for streaming to complete
5. **Response Extracted** → Parsed and POSTed back to `/api/response`
6. **Learning Updates** → Outcomes (continuous 0–1) propagate backwards through temporal credit assignment, updating belief states and convergence metrics

## Dual-Loop Architecture

The agent uses a **dual-loop control system** that separates stealth execution from learning optimization. Anti-detection logic never contaminates the learning signals.

```
┌─────────────────────────────────────────────────────────┐
│                OUTER LOOP (Stealth Execution)            │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │StealthTiming │  │HumanBehavior │  │FailureClassif.│  │
│  │  • jitter    │  │  • mouse     │  │  • CAPTCHA    │  │
│  │  • rate lim  │  │    curves    │  │  • rate limit │  │
│  │  • retries   │  │  • hover     │  │  • true fail  │  │
│  │  • smoothing │  │  • char type │  │               │  │
│  └──────┬───────┘  └──────┬───────┘  └───────┬───────┘  │
│         │                 │                   │          │
│         ▼                 ▼                   ▼          │
│  ┌─────────────────────────────────────────────────┐     │
│  │          ChatGPTStrategy (Orchestrator)          │     │
│  │   executedLatency ←── jitter + human delays      │     │
│  │   trueLatency     ←── actual system performance  │     │
│  │   classification  ←── failure type               │     │
│  └──────────────────────────┬──────────────────────┘     │
│                             │ trueLatency + classification│
│                             │ (clean signal only)         │
└─────────────────────────────┼───────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────┐
│                INNER LOOP (Learning/Optimization)        │
│                                                          │
│  ┌────────┐ ┌──────┐ ┌───────────┐ ┌──────────────┐     │
│  │Belief  │ │Reward│ │Exploration│ │ Convergence  │     │
│  │State   │ │Engine│ │(ε×stealth)│ │ (hysteresis) │     │
│  └────────┘ └──────┘ └───────────┘ └──────────────┘     │
│  ┌─────────────────┐  ┌──────────────┐                   │
│  │CreditAssignment │  │ PathSelector │                   │
│  └─────────────────┘  └──────────────┘                   │
│                                                          │
│  Golden Rule: Only trueLatency and classified outcomes   │
│  enter this loop. Jitter, delays, and stealth behavior   │
│  are invisible to the learning system.                   │
└─────────────────────────────────────────────────────────┘
```

## License

MIT
