(function () {
  // Prevent double injection
  if (window.__eyesOnlyInjected) return;
  window.__eyesOnlyInjected = true;

  // ─── State ───

  let isActive = false;
  let cursorEl = null;
  let statusEl = null;
  let cursorX = window.innerWidth / 2;
  let cursorY = window.innerHeight / 2;
  let smoothX = cursorX;
  let smoothY = cursorY;
  let lastBlinkTime = 0;
  let biasX = 0;
  let biasY = 0;
  let lastHorizontal = 0;
  let lastVertical = 0;
  let verticalMin = -0.12;
  let verticalMax = 0.12;
  let filteredHorizontal = 0;
  let filteredVertical = 0;
  let hasFilteredGaze = false;
  let easyClickMode = false;
  let calibrationModel = null;
  let calibrationTargetEl = null;
  let calibrationSession = null;

  // Settings (updated from popup via service worker)
  let sensitivity = 2.0;
  let smoothingFactor = 0.06;
  const BLINK_COOLDOWN_MS = 600;
  const MAX_DYNAMIC_SMOOTHING = 0.16;
  const SPEED_FOR_MAX_SMOOTHING_X = 220;
  const SPEED_FOR_MAX_SMOOTHING_Y = 180;
  const INPUT_GAZE_ALPHA = 0.12;
  const AXIS_X = {
    range: 0.32,
    deadzone: 0.08,
    responseExponent: 1.35,
    gain: 1.0,
    biasLearnRate: 0.015,
    biasLearnThreshold: 0.2,
    biasMax: 0.12
  };
  const AXIS_Y = {
    range: 0.22,
    deadzone: 0.03,
    responseExponent: 1.1,
    gain: 1.35,
    biasLearnRate: 0.006,
    biasLearnThreshold: 0.1,
    biasMax: 0.08,
    minRange: 0.08,
    envelopeReturnRate: 0.0012
  };
  const CALIBRATION_POINTS = [
    { id: "tl", label: "Top Left", x: 0.08, y: 0.1 },
    { id: "tr", label: "Top Right", x: 0.92, y: 0.1 },
    { id: "bl", label: "Bottom Left", x: 0.08, y: 0.9 },
    { id: "br", label: "Bottom Right", x: 0.92, y: 0.9 },
    { id: "c", label: "Center", x: 0.5, y: 0.5 }
  ];
  const CALIBRATION_SETTLE_MS = 700;
  const CALIBRATION_CAPTURE_MS = 1200;
  const CALIBRATION_MIN_SAMPLES = 12;

  // ─── Cursor Overlay ───

  function createCursor() {
    if (cursorEl) return;

    cursorEl = document.createElement("div");
    cursorEl.id = "__eyes_only_cursor__";
    cursorEl.style.cssText = [
      "position: fixed",
      "top: 0",
      "left: 0",
      "width: 30px",
      "height: 30px",
      "border-radius: 50%",
      "background: rgba(59, 130, 246, 0.4)",
      "border: 3px solid rgba(59, 130, 246, 0.9)",
      "pointer-events: none",
      "z-index: 2147483647",
      "transform: translate(-50%, -50%)",
      "box-shadow: 0 0 12px rgba(59, 130, 246, 0.5)",
      "transition: background 0.15s, transform 0.15s"
    ].join(";");
    document.documentElement.appendChild(cursorEl);
    moveCursor(smoothX, smoothY);
  }

  function removeCursor() {
    if (cursorEl) {
      cursorEl.remove();
      cursorEl = null;
    }
  }

  function moveCursor(x, y) {
    if (!cursorEl) return;
    cursorEl.style.left = x + "px";
    cursorEl.style.top = y + "px";
  }

  function setEasyClickMode(enabled) {
    easyClickMode = !!enabled;
    const styleId = "__eyes_only_easy_click_style__";
    let styleEl = document.getElementById(styleId);

    if (!easyClickMode) {
      if (styleEl) styleEl.remove();
      return;
    }

    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = styleId;
      document.documentElement.appendChild(styleEl);
    }

    styleEl.textContent = `
      a, button, input, textarea, select, summary, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"]) {
        min-width: 56px !important;
        min-height: 56px !important;
        padding: 12px 16px !important;
        font-size: max(1.05em, 16px) !important;
        line-height: 1.35 !important;
      }
    `;
  }

  function createCalibrationTarget() {
    if (calibrationTargetEl) return;
    calibrationTargetEl = document.createElement("div");
    calibrationTargetEl.id = "__eyes_only_calibration_target__";
    calibrationTargetEl.style.cssText = [
      "position: fixed",
      "width: 22px",
      "height: 22px",
      "border-radius: 50%",
      "border: 3px solid rgba(255, 255, 255, 0.95)",
      "background: rgba(244, 67, 54, 0.9)",
      "box-shadow: 0 0 0 8px rgba(244, 67, 54, 0.25), 0 0 18px rgba(0, 0, 0, 0.45)",
      "transform: translate(-50%, -50%)",
      "z-index: 2147483647",
      "pointer-events: none"
    ].join(";");
    document.documentElement.appendChild(calibrationTargetEl);
  }

  function removeCalibrationTarget() {
    if (calibrationTargetEl) {
      calibrationTargetEl.remove();
      calibrationTargetEl = null;
    }
  }

  function positionCalibrationTarget(point, step, total) {
    if (!calibrationTargetEl) return;
    calibrationTargetEl.style.left = `${point.x * window.innerWidth}px`;
    calibrationTargetEl.style.top = `${point.y * window.innerHeight}px`;
    setStatusText(`Calibrating ${step}/${total}: ${point.label}`);
  }

  // ─── Status Badge ───

  function createStatusBadge() {
    if (statusEl) return;

    statusEl = document.createElement("div");
    statusEl.id = "__eyes_only_status__";
    statusEl.style.cssText = [
      "position: fixed",
      "bottom: 12px",
      "right: 12px",
      "padding: 6px 14px",
      "background: rgba(0, 0, 0, 0.8)",
      "color: #4fc3f7",
      "font-size: 12px",
      "font-family: system-ui, -apple-system, sans-serif",
      "border-radius: 20px",
      "z-index: 2147483647",
      "pointer-events: none",
      "backdrop-filter: blur(4px)"
    ].join(";");
    statusEl.textContent = "Eyes Only: Starting...";
    document.documentElement.appendChild(statusEl);
  }

  function removeStatusBadge() {
    if (statusEl) {
      statusEl.remove();
      statusEl = null;
    }
  }

  function setStatusText(text) {
    if (statusEl) statusEl.textContent = "Eyes Only: " + text;
  }

  // ─── Gaze to Screen Mapping ───
  // horizontal/vertical from blendshapes are roughly -0.3 to +0.3.
  // Sensitivity scales this range to cover the viewport.

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function applyDeadzone(v, deadzone) {
    const abs = Math.abs(v);
    if (abs <= deadzone) return 0;
    return Math.sign(v) * ((abs - deadzone) / (1 - deadzone));
  }

  function shapeResponse(v, exponent) {
    return Math.sign(v) * Math.pow(Math.abs(v), exponent);
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function inverseLerp(a, b, v) {
    const d = b - a;
    if (Math.abs(d) < 1e-6) return 0.5;
    return (v - a) / d;
  }

  function learnBias(horizontal, vertical) {
    // Learn neutral gaze center only when gaze is near center to avoid drift.
    if (Math.abs(horizontal - biasX) < AXIS_X.biasLearnThreshold) {
      biasX = clamp(
        biasX + (horizontal - biasX) * AXIS_X.biasLearnRate,
        -AXIS_X.biasMax,
        AXIS_X.biasMax
      );
    }
    if (Math.abs(vertical - biasY) < AXIS_Y.biasLearnThreshold) {
      biasY = clamp(
        biasY + (vertical - biasY) * AXIS_Y.biasLearnRate,
        -AXIS_Y.biasMax,
        AXIS_Y.biasMax
      );
    }
  }

  function mapAxis(raw, bias, axisConfig) {
    const corrected = raw - bias;
    let normalized = clamp(corrected / axisConfig.range, -1, 1);
    normalized = applyDeadzone(normalized, axisConfig.deadzone);
    normalized = shapeResponse(normalized, axisConfig.responseExponent);
    normalized *= axisConfig.gain;
    normalized = clamp(normalized, -1, 1);
    return normalized;
  }

  function updateVerticalEnvelope(vertical) {
    // Track personal up/down gaze limits with slow decay so mapping self-tunes.
    verticalMin = Math.min(verticalMin + AXIS_Y.envelopeReturnRate, vertical);
    verticalMax = Math.max(verticalMax - AXIS_Y.envelopeReturnRate, vertical);
  }

  function mapVerticalAxis(raw) {
    const corrected = raw - biasY;
    const upRange = Math.max(AXIS_Y.minRange, biasY - verticalMin);
    const downRange = Math.max(AXIS_Y.minRange, verticalMax - biasY);
    const range = corrected < 0 ? upRange : downRange;

    let normalized = clamp(corrected / range, -1, 1);
    normalized = applyDeadzone(normalized, AXIS_Y.deadzone);
    normalized = shapeResponse(normalized, AXIS_Y.responseExponent);
    normalized *= AXIS_Y.gain;
    normalized = clamp(normalized, -1, 1);
    return normalized;
  }

  function smoothGazeInput(horizontal, vertical) {
    if (!hasFilteredGaze) {
      filteredHorizontal = horizontal;
      filteredVertical = vertical;
      hasFilteredGaze = true;
    } else {
      filteredHorizontal += (horizontal - filteredHorizontal) * INPUT_GAZE_ALPHA;
      filteredVertical += (vertical - filteredVertical) * INPUT_GAZE_ALPHA;
    }
    return { horizontal: filteredHorizontal, vertical: filteredVertical };
  }

  function projectWithModel(horizontal, vertical, model) {
    const { tl, tr, bl, br, offsetX, offsetY } = model;

    const xTop = inverseLerp(tl.h, tr.h, horizontal);
    const xBottom = inverseLerp(bl.h, br.h, horizontal);
    const yLeft = inverseLerp(tl.v, bl.v, vertical);
    const yRight = inverseLerp(tr.v, br.v, vertical);

    const coarseX = clamp((xTop + xBottom) * 0.5, 0, 1);
    const coarseY = clamp((yLeft + yRight) * 0.5, 0, 1);

    const hMinAtY = lerp(tl.h, bl.h, coarseY);
    const hMaxAtY = lerp(tr.h, br.h, coarseY);
    const refinedX = clamp(inverseLerp(hMinAtY, hMaxAtY, horizontal), 0, 1);

    const vTopAtX = lerp(tl.v, tr.v, coarseX);
    const vBottomAtX = lerp(bl.v, br.v, coarseX);
    const refinedY = clamp(inverseLerp(vTopAtX, vBottomAtX, vertical), 0, 1);

    const x = clamp(((coarseX + refinedX) * 0.5) + offsetX, 0, 1);
    const y = clamp(((coarseY + refinedY) * 0.5) + offsetY, 0, 1);

    return {
      mappedX: x * 2 - 1,
      mappedY: y * 2 - 1
    };
  }

  function mapWithCalibration(horizontal, vertical) {
    if (!calibrationModel) return null;
    return projectWithModel(horizontal, vertical, calibrationModel);
  }

  function updateGaze(horizontal, vertical) {
    const calibrated = mapWithCalibration(horizontal, vertical);
    const mappedX = calibrated ? calibrated.mappedX : mapAxis(horizontal, biasX, AXIS_X);
    if (!calibrated) {
      updateVerticalEnvelope(vertical);
    }
    const mappedY = calibrated ? calibrated.mappedY : mapVerticalAxis(vertical);

    const rawX = (0.5 + mappedX * 0.5 * sensitivity) * window.innerWidth;
    const rawY = (0.5 + mappedY * 0.5 * sensitivity) * window.innerHeight;

    // Clamp to viewport
    const clampedX = clamp(rawX, 0, window.innerWidth);
    const clampedY = clamp(rawY, 0, window.innerHeight);

    // Adaptive smoothing: stable when fixating, faster when moving gaze.
    const dx = clampedX - smoothX;
    const dy = clampedY - smoothY;
    const dynamicX = clamp(Math.abs(dx) / SPEED_FOR_MAX_SMOOTHING_X, 0, 1);
    const dynamicY = clamp(Math.abs(dy) / SPEED_FOR_MAX_SMOOTHING_Y, 0, 1);
    const alphaX = clamp(
      smoothingFactor + (MAX_DYNAMIC_SMOOTHING - smoothingFactor) * dynamicX,
      smoothingFactor,
      MAX_DYNAMIC_SMOOTHING
    );
    const alphaY = clamp(
      smoothingFactor + (MAX_DYNAMIC_SMOOTHING - smoothingFactor) * dynamicY,
      smoothingFactor,
      MAX_DYNAMIC_SMOOTHING
    );

    smoothX += dx * alphaX;
    smoothY += dy * alphaY;

    cursorX = smoothX;
    cursorY = smoothY;
    moveCursor(cursorX, cursorY);
  }

  // ─── Click Targeting ───
  // Walk up the DOM tree to find a clickable ancestor if the element
  // directly under the cursor is not interactive.

  const CLICKABLE_TAGS = new Set([
    "A", "BUTTON", "INPUT", "TEXTAREA", "SELECT", "SUMMARY", "DETAILS"
  ]);

  const CLICKABLE_ROLES = new Set([
    "button", "link", "menuitem", "tab", "checkbox", "radio", "option", "switch"
  ]);

  function findClickableElement(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;

    let current = el;
    while (current && current !== document.body && current !== document.documentElement) {
      if (CLICKABLE_TAGS.has(current.tagName)) return current;
      const role = current.getAttribute("role");
      if (role && CLICKABLE_ROLES.has(role)) return current;
      if (current.onclick || current.hasAttribute("onclick")) return current;
      current = current.parentElement;
    }

    // Fallback: return the original element
    return el;
  }

  function findClickableNear(x, y, radius = 60) {
    const points = [
      [0, 0], [radius, 0], [-radius, 0], [0, radius], [0, -radius],
      [radius * 0.7, radius * 0.7], [radius * 0.7, -radius * 0.7],
      [-radius * 0.7, radius * 0.7], [-radius * 0.7, -radius * 0.7]
    ];

    let best = null;
    let bestDist = Infinity;

    for (const [ox, oy] of points) {
      const px = clamp(x + ox, 0, window.innerWidth - 1);
      const py = clamp(y + oy, 0, window.innerHeight - 1);
      const candidate = findClickableElement(px, py);
      if (!candidate) continue;

      const rect = candidate.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dist = Math.hypot(cx - x, cy - y);

      if (dist < bestDist) {
        bestDist = dist;
        best = candidate;
      }
    }

    return bestDist <= radius * 1.4 ? best : null;
  }

  function simulateClick(el) {
    if (!el) return;

    // Focus if applicable
    if (typeof el.focus === "function") {
      try { el.focus(); } catch {}
    }

    // Full mouse event sequence for maximum compatibility
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const eventInit = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: cx,
      clientY: cy
    };

    el.dispatchEvent(new MouseEvent("mousedown", eventInit));
    el.dispatchEvent(new MouseEvent("mouseup", eventInit));
    el.dispatchEvent(new MouseEvent("click", eventInit));
  }

  // ─── Blink Click Handler ───

  function handleBlink() {
    const now = Date.now();
    if (now - lastBlinkTime < BLINK_COOLDOWN_MS) return;
    lastBlinkTime = now;

    // Visual feedback: pulse the cursor green
    if (cursorEl) {
      cursorEl.style.background = "rgba(76, 175, 80, 0.7)";
      cursorEl.style.transform = "translate(-50%, -50%) scale(1.5)";
      setTimeout(() => {
        if (cursorEl) {
          cursorEl.style.background = "rgba(59, 130, 246, 0.4)";
          cursorEl.style.transform = "translate(-50%, -50%) scale(1)";
        }
      }, 200);
    }

    const target = findClickableNear(cursorX, cursorY, 70) || findClickableElement(cursorX, cursorY);
    if (target) {
      simulateClick(target);
      setStatusText("Clicked!");
      setTimeout(() => {
        if (isActive) setStatusText("Tracking");
      }, 800);
    }
  }

  function calibrateCenter() {
    biasX = clamp(lastHorizontal, -AXIS_X.biasMax, AXIS_X.biasMax);
    biasY = clamp(lastVertical, -AXIS_Y.biasMax, AXIS_Y.biasMax);
    verticalMin = biasY - 0.12;
    verticalMax = biasY + 0.12;
    setStatusText("Center calibrated");
    setTimeout(() => {
      if (isActive) setStatusText("Tracking");
    }, 800);
  }

  function robustPointAverage(samples) {
    if (!samples || samples.length === 0) return null;

    const take = (key) => {
      const sorted = samples.map((s) => s[key]).sort((a, b) => a - b);
      const trim = Math.floor(sorted.length * 0.2);
      const kept = sorted.slice(trim, sorted.length - trim);
      const values = kept.length ? kept : sorted;
      const sum = values.reduce((acc, v) => acc + v, 0);
      return sum / values.length;
    };

    return { h: take("h"), v: take("v") };
  }

  function buildCalibrationModel(results) {
    const tl = results.tl;
    const tr = results.tr;
    const bl = results.bl;
    const br = results.br;
    const c = results.c;
    if (!tl || !tr || !bl || !br || !c) return null;

    const cornerOnly = { tl, tr, bl, br, offsetX: 0, offsetY: 0 };
    const centerMapped = projectWithModel(c.h, c.v, cornerOnly);
    const centerX = centerMapped ? (centerMapped.mappedX + 1) * 0.5 : 0.5;
    const centerY = centerMapped ? (centerMapped.mappedY + 1) * 0.5 : 0.5;

    return {
      tl,
      tr,
      bl,
      br,
      offsetX: clamp(0.5 - centerX, -0.2, 0.2),
      offsetY: clamp(0.5 - centerY, -0.2, 0.2)
    };
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function runCalibration() {
    if (!isActive) {
      setStatusText("Start tracking first");
      return;
    }
    if (calibrationSession?.running) return;

    calibrationSession = {
      running: true,
      collecting: false,
      samples: [],
      results: {}
    };

    createCalibrationTarget();
    try {
      for (let i = 0; i < CALIBRATION_POINTS.length; i++) {
        if (!calibrationSession.running) throw new Error("Calibration cancelled");
        const point = CALIBRATION_POINTS[i];
        positionCalibrationTarget(point, i + 1, CALIBRATION_POINTS.length);
        await wait(CALIBRATION_SETTLE_MS);

        calibrationSession.samples = [];
        calibrationSession.collecting = true;
        await wait(CALIBRATION_CAPTURE_MS);
        calibrationSession.collecting = false;

        const avg = robustPointAverage(calibrationSession.samples);
        if (!avg || calibrationSession.samples.length < CALIBRATION_MIN_SAMPLES) {
          throw new Error(`Not enough stable samples at ${point.label}`);
        }
        calibrationSession.results[point.id] = avg;
      }

      const model = buildCalibrationModel(calibrationSession.results);
      if (!model) {
        throw new Error("Calibration model build failed");
      }
      calibrationModel = model;
      setStatusText("5-point calibration complete");
      setTimeout(() => {
        if (isActive && !(calibrationSession && calibrationSession.running)) {
          setStatusText("Tracking");
        }
      }, 1200);
    } catch (err) {
      setStatusText(`Calibration failed: ${err.message}`);
      setTimeout(() => {
        if (isActive) setStatusText("Tracking");
      }, 1500);
    } finally {
      if (calibrationSession) {
        calibrationSession.running = false;
        calibrationSession.collecting = false;
      }
      calibrationSession = null;
      removeCalibrationTarget();
    }
  }

  // ─── Start / Stop ───

  function startOverlay(settings) {
    if (isActive) return;
    isActive = true;

    if (settings) {
      sensitivity = settings.sensitivity || 2.0;
      smoothingFactor = settings.smoothing || 0.06;
      setEasyClickMode(!!settings.easyClickMode);
    } else {
      setEasyClickMode(false);
    }

    // Reset cursor to center
    smoothX = window.innerWidth / 2;
    smoothY = window.innerHeight / 2;
    cursorX = smoothX;
    cursorY = smoothY;
    biasX = 0;
    biasY = 0;
    verticalMin = -0.12;
    verticalMax = 0.12;
    hasFilteredGaze = false;

    createCursor();
    createStatusBadge();
    setStatusText("Starting...");
  }

  function stopOverlay() {
    isActive = false;
    calibrationSession = null;
    removeCursor();
    removeCalibrationTarget();
    removeStatusBadge();
    setEasyClickMode(false);
  }

  // ─── Message Handling ───

  // Ping handler for connectivity check (uses one-shot messages)
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "ping") {
      sendResponse({ ok: true });
    }
  });

  // Port-based streaming from service worker
  chrome.runtime.onConnect.addListener((incomingPort) => {
    if (incomingPort.name !== "gaze-stream") return;

    incomingPort.onMessage.addListener((msg) => {
      if (!msg?.type) return;

      switch (msg.type) {
        case "start-overlay":
          startOverlay(msg.settings);
          break;

        case "stop-overlay":
          stopOverlay();
          break;

        case "update-settings":
          if (msg.settings) {
            if (msg.settings.sensitivity != null) sensitivity = msg.settings.sensitivity;
            if (msg.settings.smoothing != null) smoothingFactor = msg.settings.smoothing;
            if (msg.settings.easyClickMode != null) setEasyClickMode(msg.settings.easyClickMode);
          }
          break;

        case "set-easy-click-mode":
          setEasyClickMode(!!msg.enabled);
          break;

        case "run-calibration":
          runCalibration();
          break;

        case "calibrate-center":
          // Backward-compatible quick center calibration.
          calibrateCenter();
          break;

        case "status-update":
          setStatusText(msg.message || msg.status || "");
          break;

        case "gaze-data":
          if (!isActive) break;

          if (!msg.faceDetected) {
            setStatusText("No face detected");
            break;
          }

          if (!(calibrationSession && calibrationSession.running)) {
            setStatusText("Tracking");
          }
          lastHorizontal = msg.horizontal;
          lastVertical = msg.vertical;

          if (calibrationSession && calibrationSession.collecting && !msg.eyesClosed) {
            calibrationSession.samples.push({ h: msg.horizontal, v: msg.vertical });
          }

          // Keep cursor stable while eyes are closed to avoid blink-induced jumps.
          if (!msg.eyesClosed) {
            const filtered = smoothGazeInput(msg.horizontal, msg.vertical);
            if (!calibrationModel) {
              learnBias(filtered.horizontal, filtered.vertical);
            }
            updateGaze(filtered.horizontal, filtered.vertical);
          }

          if (msg.blink && !(calibrationSession && calibrationSession.running)) {
            handleBlink();
          }
          break;
      }
    });

    incomingPort.onDisconnect.addListener(() => {
      stopOverlay();
    });
  });
})();
