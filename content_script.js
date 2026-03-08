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
  let scrollTimer = null;
  let eyesClosedAt = 0;
  let stillFrames = 0;

  // Settings (updated from popup via service worker)
  let sensitivity = 1.0;
  let smoothingFactor = 0.06;
  const BLINK_COOLDOWN_MS = 600;
  const SCROLL_EDGE_PX = 60;
  const SCROLL_SPEED = 4;
  const LONG_BLINK_MS = 200;
  const MAX_DYNAMIC_SMOOTHING = 0.16;
  const SPEED_FOR_MAX_SMOOTHING_X = 220;
  const SPEED_FOR_MAX_SMOOTHING_Y = 180;
  const INPUT_GAZE_ALPHA = 0.12;
  const STILLNESS_THRESHOLD = 1.5;
  const STILLNESS_FRAMES = 4;
  const AXIS_X = {
    range: 0.32,
    deadzone: 0.15,
    responseExponent: 1.35,
    gain: 1.0,
    biasLearnRate: 0.015,
    biasLearnThreshold: 0.2,
    biasMax: 0.12
  };
  const AXIS_Y = {
    range: 0.22,
    deadzone: 0.07,
    responseExponent: 1.1,
    gain: 1.35,
    biasLearnRate: 0.006,
    biasLearnThreshold: 0.1,
    biasMax: 0.08,
    minRange: 0.08,
    envelopeReturnRate: 0.0012
  };

  // ─── Cursor Overlay ───

  function createCursor() {
    if (cursorEl) return;

    cursorEl = document.createElement("div");
    cursorEl.id = "__eyes_only_cursor__";
    cursorEl.style.cssText = [
      "position: fixed",
      "top: 0",
      "left: 0",
      "width: 50px",
      "height: 50px",
      "border-radius: 50%",
      "background: rgba(150, 150, 150, 0.4)",
      "border: 3px solid rgba(150, 150, 150, 0.9)",
      "pointer-events: none",
      "z-index: 2147483647",
      "transform: translate(-50%, -50%)",
      "box-shadow: 0 0 12px rgba(150, 150, 150, 0.5)",
      "transition: background 0.15s, border-color 0.15s, box-shadow 0.15s, transform 0.15s"
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
      "background: #fff",
      "color: #F65009",
      "border: 2px solid #F65009",
      "font-size: 12px",
      "font-family: system-ui, -apple-system, sans-serif",
      "border-radius: 20px",
      "z-index: 2147483647",
      "pointer-events: none"
    ].join(";");
    statusEl.textContent = "Sightline: Starting...";
    document.documentElement.appendChild(statusEl);
  }

  function removeStatusBadge() {
    if (statusEl) {
      statusEl.remove();
      statusEl = null;
    }
  }

  function setStatusText(text) {
    if (statusEl) statusEl.textContent = "Sightline: " + text;
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

  function updateGaze(horizontal, vertical) {
    const mappedX = mapAxis(horizontal, biasX, AXIS_X);
    updateVerticalEnvelope(vertical);
    const mappedY = mapVerticalAxis(vertical);

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

    // Stillness lock: if cursor barely moves for several frames, freeze it.
    if (Math.abs(dx) < STILLNESS_THRESHOLD && Math.abs(dy) < STILLNESS_THRESHOLD) {
      stillFrames++;
    } else {
      stillFrames = 0;
    }

    if (stillFrames >= STILLNESS_FRAMES) return;

    smoothX += dx * alphaX;
    smoothY += dy * alphaY;

    cursorX = smoothX;
    cursorY = smoothY;
    moveCursor(cursorX, cursorY);
    updateEdgeScroll();
  }

  // ─── Edge Scrolling ───

  let scrollDx = 0;
  let scrollDy = 0;
  let scrollTarget = null;
  let lastScrollTarget = null;

  function findScrollableAncestor(el) {
    let current = el;
    while (current && current !== document.documentElement) {
      const style = window.getComputedStyle(current);
      const overflowY = style.overflowY;
      const overflowX = style.overflowX;
      const canScrollY = (overflowY === "auto" || overflowY === "scroll") &&
        current.scrollHeight > current.clientHeight;
      const canScrollX = (overflowX === "auto" || overflowX === "scroll") &&
        current.scrollWidth > current.clientWidth;
      if (canScrollY || canScrollX) return current;
      current = current.parentElement;
    }
    return null;
  }

  function updateEdgeScroll() {
    const w = window.innerWidth;
    const h = window.innerHeight;

    scrollDx = 0;
    scrollDy = 0;

    if (cursorY < SCROLL_EDGE_PX) {
      scrollDy = -SCROLL_SPEED * (1 - cursorY / SCROLL_EDGE_PX);
    } else if (cursorY > h - SCROLL_EDGE_PX) {
      scrollDy = SCROLL_SPEED * (1 - (h - cursorY) / SCROLL_EDGE_PX);
    }

    if (cursorX < SCROLL_EDGE_PX) {
      scrollDx = -SCROLL_SPEED * (1 - cursorX / SCROLL_EDGE_PX);
    } else if (cursorX > w - SCROLL_EDGE_PX) {
      scrollDx = SCROLL_SPEED * (1 - (w - cursorX) / SCROLL_EDGE_PX);
    }

    if (scrollDx !== 0 || scrollDy !== 0) {
      // Find the scrollable element under the cursor.
      // Cache the last valid target so edge positions that return null
      // (e.g. cursor at very top) still scroll the right container.
      const elUnder = document.elementFromPoint(cursorX, cursorY);
      const found = elUnder ? findScrollableAncestor(elUnder) : null;
      if (found) {
        scrollTarget = found;
        lastScrollTarget = found;
      } else {
        scrollTarget = lastScrollTarget;
      }

      if (!scrollTimer) {
        scrollTimer = setInterval(() => {
          if (scrollTarget) {
            scrollTarget.scrollBy(scrollDx, scrollDy);
          } else {
            window.scrollBy(scrollDx, scrollDy);
          }
        }, 16);
      }
    } else {
      stopEdgeScroll();
    }
  }

  function stopEdgeScroll() {
    if (scrollTimer) {
      clearInterval(scrollTimer);
      scrollTimer = null;
    }
  }

  // ─── Click Targeting ───
  // Walk up the DOM tree to find a clickable ancestor if the element
  // directly under the cursor is not interactive.

  const CLICKABLE_TAGS = new Set([
    "A", "BUTTON", "INPUT", "TEXTAREA", "SELECT", "SUMMARY", "DETAILS", "IFRAME"
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

    // If the element is inside a link, click the link so navigation fires.
    const anchor = el.closest("a[href]");
    const clickTarget = anchor || el;

    if (typeof clickTarget.click === "function") {
      try { clickTarget.click(); } catch {}
    }
  }

  // ─── Blink Click Handler ───

  function handleBlink() {
    const now = Date.now();
    if (now - lastBlinkTime < BLINK_COOLDOWN_MS) return;
    lastBlinkTime = now;

    // Visual feedback: pulse the cursor green
    if (cursorEl) {
      cursorEl.style.background = "rgba(246, 80, 9, 0.7)";
      cursorEl.style.borderColor = "rgba(246, 80, 9, 0.9)";
      cursorEl.style.boxShadow = "0 0 12px rgba(246, 80, 9, 0.5)";
      cursorEl.style.transform = "translate(-50%, -50%) scale(1.5)";
      setTimeout(() => {
        if (cursorEl) {
          cursorEl.style.background = "rgba(150, 150, 150, 0.4)";
          cursorEl.style.borderColor = "rgba(150, 150, 150, 0.9)";
          cursorEl.style.boxShadow = "0 0 12px rgba(150, 150, 150, 0.5)";
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
    stopEdgeScroll();
    removeCursor();
    removeStatusBadge();
    setEasyClickMode(false);
  }

  // ─── Message Handling ───

  // Prevent bfcache from killing the extension port when navigating back.
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) {
      // Page was restored from bfcache — the old port is dead.
      // Clean up so the service worker can reconnect.
      stopOverlay();
    }
  });

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

          setStatusText("Tracking");
          lastHorizontal = msg.horizontal;
          lastVertical = msg.vertical;

          // Track when eyes close to distinguish intentional long blinks from normal ones.
          if (msg.eyesClosed && eyesClosedAt === 0) {
            eyesClosedAt = Date.now();
          }

          // Keep cursor stable while eyes are closed to avoid blink-induced jumps.
          if (!msg.eyesClosed) {
            const filtered = smoothGazeInput(msg.horizontal, msg.vertical);
            learnBias(filtered.horizontal, filtered.vertical);
            updateGaze(filtered.horizontal, filtered.vertical);
          }

          if (msg.blink) {
            const closedDuration = eyesClosedAt > 0 ? Date.now() - eyesClosedAt : 0;
            eyesClosedAt = 0;
            if (closedDuration >= LONG_BLINK_MS) {
              handleBlink();
            }
          }
          if (!msg.eyesClosed) {
            eyesClosedAt = 0;
          }
          break;
      }
    });

    incomingPort.onDisconnect.addListener(() => {
      stopOverlay();
    });
  });
})();
