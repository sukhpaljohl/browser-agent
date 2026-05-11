# Label-Related Code Changes Log

All changes made during the Apple Purchase Agent debugging session to fix product configuration option selection (Model, Color, Storage).

---

## Change 1: `dom-recon.js` — Added `label[for]` to interactive selectors

**File:** `extension/content/dom-recon.js`  
**Location:** `INTERACTIVE_SELECTORS` constant (around line 401-411)  
**What:** Added `'label[for]'` to the `INTERACTIVE_SELECTORS` array so DOMRecon scans `<label>` elements linked to inputs.  
**Why:** Labels are the visible, clickable text for radio/checkbox inputs. Without scanning them, the pipeline only sees hidden `<input>` elements with no text.

**To reverse:** Remove `'label[for]'` from the `INTERACTIVE_SELECTORS` array.

---

## Change 2: `dom-recon.js` — First-line extraction for labels (pre-truncate)

**File:** `extension/content/dom-recon.js`  
**Location:** `_scanElement()`, around line 435-447 (the `innerText` extraction section)  
**What:** Changed label text extraction to split `el.innerText` on newlines BEFORE `_truncate()` runs. Takes only the first line of multi-line labels.  
**Why:** `_truncate()` uses `\s+` regex which collapses newlines into spaces, producing one long string like `"iPhone 17 Pro Max 6.9-inch display Footnote 2 From $1199..."`. This scored poorly (20 pts contains match). By extracting the first line ("iPhone 17 Pro Max") before truncation, the text becomes exact-matchable (100 pts).

**Current code:**
```javascript
// ── Label first-line extraction ─────────────────────────────────────
let rawInnerText = el.innerText || '';
if (tag === 'label' && rawInnerText.includes('\n')) {
  rawInnerText = rawInnerText.split('\n')[0];
}
let innerText = _truncate(rawInnerText, MAX_TEXT_LENGTH);
```

**Original code was:**
```javascript
let innerText = _truncate(el.innerText, MAX_TEXT_LENGTH);
```

**To reverse:** Replace the block above with the single original line.

---

## Change 3: `dom-recon.js` — Smart purpose inheritance for labels ✅ CORRECTED

**File:** `extension/content/dom-recon.js`  
**Location:** `_scanElement()`, purpose assignment block (around line 507)  
**Original (wrong):** `else if (tag === 'label') purpose = 'toggle';` — blindly assigned toggle to ALL labels.  
**Corrected:** Labels now inherit `purpose` from their referenced input element via `document.getElementById(for)`. Checks both `type` (native inputs) and `role` (ARIA custom elements):
- Radio/checkbox inputs → `purpose = 'toggle'` (+10 importance) ✅
- Text-type inputs → `purpose = 'text-input'` (+20 importance) ✅
- Unknown/missing targets → `purpose = 'unknown'` (+0 importance) ✅

**Why corrected:** The blind `toggle` assignment inflated importance scores for labels pointing to text inputs, potentially displacing real interactive elements from the 150-cap.

---

## Change 4: `candidate-pruner.js` — Added `label` to affordance allowlist

**File:** `extension/brain/candidate-pruner.js`  
**Location:** `_filterAffordant()` method, `ACTIONABLE_TAGS` array (around line 113-116)  
**What:** Added `'label'` to `ACTIONABLE_TAGS` so labels pass the affordance gate.  
**Why:** Without this, labels were filtered out as non-interactive decorative elements.

**To reverse:** Remove `'label'` from the `ACTIONABLE_TAGS` array.

---

## Change 5: `node-classifier.js` — Labels + toggles → `dynamic_trigger` ✅ CORRECTED

**File:** `extension/brain/node-classifier.js`  
**Location:** Classification logic  
**Original (wrong):** `tag === 'label'` → `clickable_action` at 0.75 confidence.  
**Corrected:** All toggle-type elements reclassified to `dynamic_trigger`:
- `purpose === 'toggle'` → `dynamic_trigger` at 0.80 (catches labels for radio/checkbox AND native radio/checkbox inputs)
- `role === 'radio' || 'checkbox' || 'switch'` → `dynamic_trigger` at 0.85 (ARIA controls)
- `tag === 'label'` fallback → `dynamic_trigger` at 0.65 (labels with unresolved purpose)

**Why corrected:** Toggle elements are "choosers" (they change a selection state), not "action buttons" (like Submit or Buy). Classifying them as `dynamic_trigger` gives them 3 diversity reservation slots in CandidatePruner, preventing displacement by CTAs on button-heavy pages.

---

## Change 6: `brain-executor.js` — ~~Non-breaking space normalization~~ ❌ REMOVED

**File:** `extension/brain/brain-executor.js`  
**Location:** `_findBestMatch()` method, text normalization section  
**What was:** `.replace(/\u00A0/g, ' ')` on `innerText`, `ariaLabel`, and `placeholder` during scoring.  
**Status:** **Removed** — `_truncate()` in dom-recon.js already normalizes `\u00A0` via its `\s+` regex. The `.replace()` calls were redundant, adding 3 unnecessary regex executions per candidate per scoring cycle.

---

## Change 7: `brain-executor.js` — ~~Label fallback in `_handleClick`~~ ❌ REMOVED

**File:** `extension/brain/brain-executor.js`  
**Location:** `_handleClick()` method  
**What was:** A fallback that directly queried `label[for]` elements when the pipeline's top score was below 80, creating synthetic candidates with score 100 that bypassed the ambiguity gate.  
**Status:** **Removed** — This was an architectural bypass that violated 6 pipeline principles:
1. Bypassed ALL pipeline layers (NodeClassifier, CandidatePruner, ContextBuilder, ActionContext)
2. Synthetic candidates had no visibility/safety checks, no spatial context, no page region
3. Hardcoded score 100 overrode the ambiguity gate
4. Threshold `< 80` was arbitrary
5. Created an architectural bypass precedent
6. Did raw DOM access (`querySelectorAll`) inside the Brain module

**Why safe to remove:** With Changes 3 and 5 corrected, labels survive the pipeline naturally:
- Change 3 gives toggle labels proper importance scores (+10 for purpose + +10 for text = 20)
- Change 5 classifies them as `dynamic_trigger` with 3 diversity reservation slots
- Change 1 discovers them via `label[for]` in INTERACTIVE_SELECTORS
- Change 2 gives them clean first-line text for exact matching (100 pts)

---

## Summary

| # | File | Change | Status |
|---|------|--------|--------|
| 1 | dom-recon.js | `label[for]` in INTERACTIVE_SELECTORS | ✅ Kept |
| 2 | dom-recon.js | First-line extraction pre-truncate | ✅ Kept |
| 3 | dom-recon.js | Smart purpose inheritance for labels | ✅ Corrected |
| 4 | candidate-pruner.js | `label` in ACTIONABLE_TAGS | ✅ Kept |
| 5 | node-classifier.js | Labels + toggles → `dynamic_trigger` | ✅ Corrected |
| 6 | brain-executor.js | ~~`\u00A0` normalization~~ | ❌ Removed |
| 7 | brain-executor.js | ~~Label fallback bypass~~ | ❌ Removed |

Changes 1-5 get labels through the DOMRecon pipeline correctly. Changes 6-7 were removed as redundant/harmful. Change 8 adds debug visibility. Changes 9-10 fix HumanEngine's stealth scroll for partially-visible elements.

---

## Change 8: `brain-executor.js` — Click diagnostic logging

**File:** `extension/brain/brain-executor.js`  
**Location:** Inside the `setTimeout` click callback in `_handleClick()` (around line 827-830)  
**What:** Added `console.log` that captures the click target's `tagName`, `isConnected` status, bounding rect (x, y, w, h), and first 40 chars of text at the moment of clicking. Also logs `HumanEngine.click()` return value.  
**Why:** Without this, there was zero visibility into what happened during the delayed click. This diagnostic revealed that elements were connected with valid rects but HumanEngine was clicking below the viewport.

**To reverse:** Remove the `console.log('[Brain] DEBUG click target:...')` and `console.log('[Brain] DEBUG HumanEngine.click result:...')` lines.

---

## Change 9: `human-engine.js` — Stealth scroll viewport check fix ⭐ KEY FIX

**File:** `extension/motor/human-engine.js`  
**Location:** `click()` method, stealth scroll check (line 144)  
**What:** Changed `rect.y > vH` to `rect.y + rect.height > vH`.  
**Why:** The original check only scrolled when the element's TOP was below the viewport. An element at y=653 with height=84 in a viewport of height=730 had its top "in view" (653 < 730) but its bottom at 737 was below. HumanEngine's click coordinates target the element's CENTER (y≈695), which was inside the viewport numerically but `elementFromPoint()` returned null — meaning nothing was visually there. The fix triggers scrolling whenever the element's bottom extends past the viewport edge.

**Original code:**
```javascript
if (rect.y < 0 || rect.y > vH) {
```

**Current code:**
```javascript
if (rect.y < 0 || rect.y + rect.height > vH) {
```

**To reverse:** Change `rect.y + rect.height > vH` back to `rect.y > vH`.

---

## Change 10: `human-engine.js` — Randomized scroll destination

**File:** `extension/motor/human-engine.js`  
**Location:** `click()` method, scroll delta calculation (lines 145-148)  
**What:** Changed the scroll target from the fixed viewport center (`vH / 2`) to a random position in the comfortable viewing zone (`vH * (0.3 + Math.random() * 0.4)`).  
**Why:** A fixed center target is a bot detection signal — humans never scroll elements to exactly the same position. The randomized 30-70% range makes each scroll land at a different spot.

**Original code:**
```javascript
// Calculate delta to center the element in the viewport
const deltaY = rect.y - (vH / 2) + (rect.height / 2);
```

**Current code:**
```javascript
// Calculate delta to a random comfortable viewing position (30-70% of viewport)
// Humans don't scroll to the exact center — they land at slightly different spots each time
const targetY = vH * (0.3 + Math.random() * 0.4);
const deltaY = rect.y - targetY + (rect.height / 2);
```

**To reverse:** Replace the block above with the original two lines.

---

## Summary

| # | File | Change | Status |
|---|------|--------|--------|
| 1 | dom-recon.js | `label[for]` in INTERACTIVE_SELECTORS | ✅ Kept |
| 2 | dom-recon.js | First-line extraction pre-truncate | ✅ Kept |
| 3 | dom-recon.js | Smart purpose inheritance for labels | ✅ Corrected |
| 4 | candidate-pruner.js | `label` in ACTIONABLE_TAGS | ✅ Kept |
| 5 | node-classifier.js | Labels + toggles → `dynamic_trigger` | ✅ Corrected |
| 6 | brain-executor.js | ~~`\u00A0` normalization~~ | ❌ Removed |
| 7 | brain-executor.js | ~~Label fallback bypass~~ | ❌ Removed |
| 8 | brain-executor.js | Click diagnostic logging | ✅ Kept |
| 9 | human-engine.js | Scroll check: `rect.y + rect.height > vH` | ✅ Kept |
| 10 | human-engine.js | Random scroll target (30-70% viewport) | ✅ Kept |

Changes 1-5 get labels through the DOMRecon pipeline correctly. Changes 6-7 were removed as redundant/harmful. Change 8 adds debug visibility. Changes 9-10 fix HumanEngine's stealth scroll for partially-visible elements.
