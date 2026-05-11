# POMDP Scoring & Debugging Guide

This document explains how the agent tracks, scores, and reports candidates during execution, specifically focusing on how to extract and view the `scoredCandidates` matrix.

## 1. How the `scoredCandidates` Matrix is Generated

During every `click` or `navigate` intent, the `brain-executor.js` pipeline executes the following sequence:

1. **DOM Recon:** Scans the active page for interactive elements.
2. **Text matching & Penalties:** Compares target intent ("macbook air") against element properties (`innerText`, `ariaLabel`). Iteratively applies heuristic penalties and bonuses (e.g., Target Pruner, Expected Outcome multiplier).
3. **URL Alignment (Phase 1B.2.4):** Evaluates exact URL path arrays to extract semantic alignment points. (e.g., `macbook`, `air` against `/macbook-air/`).
4. **Final Sort:** Sorts all candidates and binds the top 5 to the `this._lastScoredMatches` state payload.

## 2. Where the Matrix Lives

The data is attached directly to the network payload returning to the Bridge server upon a successful match:

```javascript
// brain-executor.js -> _handleClick / _handleNavigate
return {
  success: true,
  response: {
    text: `Clicked "Learn more"...`,
    data: { 
      action: 'click', 
      scoredCandidates: [ 
        { score: 60.78, text: "Learn more", href: "/macbook-neo/" },
        ...
      ]
    }
  }
};
```

## 3. The "Page Navigation" Race Condition (Dead Man's Switch)

By default, Chrome rigorously isolates and destroys active scripts the moment a root page navigation begins. 

When the agent executes a successful click that initiates a page reload, the browser historically destroyed the `brain-executor.js` script **before** it could finish dispatching the HTTP JSON payload to the Bridge.

To prevent silent failures, our background `service-worker.js` constantly watches for orphaned tabs. If it detects a violent tab disconnect immediately following a click command, it forces an emergency override bridge response:
> `"Action executed. Page navigated to a new URL."`

**This security override purposefully obliterates the `scoredCandidates` matrix to guarantee the pipeline loop isn't stalled by a dead tab.**

## 4. How to View the Math & Matrix data

If you need to strictly verify score weights, URL Alignment bonuses, or see why the agent is prioritizing certain buttons over others, you have two native debugging methods:

### Method A: The 3-Second Timeout Injection
If you need to fetch the JSON from the Node Bridge Server, you must inject a synthetic delay directly into the physical click execution. This allows the Bridge exactly enough time to receive the massive JSON dump before Chrome destroys the tab.
1. Open `brain-executor.js`
2. Find the primary physical click invocations inside `_handleClick` and `_handleNavigate`.
3. Wrap them in a 3-second timeout:
```javascript
// Schedule click after response is posted to ensure telemetry is safely delivered (test mode)
setTimeout(async () => {
  await engine.click(el);
}, 3000);
```

### Method B: Chrome DevTools Persistent Logging
If you don't want to manipulate internal agent execution speeds, you can catch the agent's calculations seamlessly as they output directly within the browser runtime.
1. Open the target webpage on Chrome.
2. Open **Inspect Element** -> **Console** Tab.
3. Top right gear icon ⚙️ -> Check the **"Preserve log"** parameter.
4. Send your agent command. 

The console will dump the fully calculated array output, run the click, navigate away, and naturally preserve the output regardless of the new page load.
