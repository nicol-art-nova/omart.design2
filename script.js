/* omart.design — mounts all Rive animations and drives the immersive showcase.
   Plain vanilla JS, no build step. Rive runtime is loaded from CDN in index.html.

   The site degrades gracefully: each .riv may expose optional inputs in
   "State Machine 1" — parallaxX/parallaxY (Number, -1..1), intro (Trigger),
   focus (Number 0..1), hover (Boolean). When an input exists we drive it (true,
   GPU effect); when it doesn't, JS falls back to a CSS-based approximation. */

(function () {
  "use strict";

  var body = document.body;

  if (typeof rive === "undefined") {
    console.error("Rive runtime failed to load.");
    body.classList.remove("is-loading");
    body.classList.add("is-ready");
    return;
  }

  var STATE_MACHINE = "State Machine 1"; // every .riv in /rive/ uses this name
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var instances = []; // { canvas, riv, inputs, loaded }

  // Several files bundle many artboards; pick the right one via data-artboard.
  // Optional data-fit ("cover"|"contain"|"fill") controls how it fills the canvas.
  function layoutFor(canvas) {
    var fitName = (canvas.dataset.fit || "contain").toLowerCase();
    var fit = rive.Fit.Contain;
    if (fitName === "cover") fit = rive.Fit.Cover;
    else if (fitName === "fill") fit = rive.Fit.Fill;
    return new rive.Layout({ fit: fit, alignment: rive.Alignment.Center });
  }

  // Map a State Machine's inputs by name, so callers can feature-detect.
  function indexInputs(r, smName) {
    var map = {};
    try {
      (r.stateMachineInputs(smName || STATE_MACHINE) || []).forEach(function (inp) {
        map[inp.name] = inp;
      });
    } catch (e) {}
    return map;
  }

  // Grab data-bound (ViewModel) Number properties by name — many files expose
  // cursor tracking (parallaxX/parallaxY) as bound properties, not SM inputs.
  function bindVMNumbers(r, names) {
    var out = {};
    var vmi;
    try { vmi = r.viewModelInstance; } catch (e) {}
    if (!vmi) return out;
    names.forEach(function (nm) {
      var p = null;
      try { p = vmi.number(nm); } catch (e) {}
      if (p) out[nm] = p;
    });
    return out;
  }

  // Mount one .riv onto a <canvas>. Returns a record { canvas, riv, inputs, loaded }.
  function mountRive(canvas, opts) {
    opts = opts || {};
    var rec = { canvas: canvas, riv: null, inputs: {}, loaded: false };
    // Which state machine to drive. Files may not use "State Machine 1"; if the
    // chosen one isn't in the loaded artboard we remount on the real one (below).
    var currentSM = canvas.dataset.statemachine || STATE_MACHINE;
    var cfg = {
      src: canvas.dataset.rive,
      canvas: canvas,
      autoplay: opts.autoplay !== false,
      stateMachines: currentSM,
      autoBind: true, // bind default ViewModel instance for data-bound files
      layout: layoutFor(canvas),
      onLoad: function () {
        // Auto-correct the state machine name if "State Machine 1" doesn't exist.
        var names = [];
        try { names = r.stateMachineNames || []; } catch (e) {}
        if (names.length && names.indexOf(currentSM) === -1 && !retriedSM) {
          retriedSM = true;
          console.warn("Rive: state machine '" + currentSM + "' not in " +
            canvas.dataset.rive + " — using '" + names[0] + "'.");
          currentSM = names[0];
          cfg.stateMachines = currentSM;
          try { r.cleanup && r.cleanup(); } catch (e) {}
          r = new rive.Rive(cfg);
          rec.riv = r;
          return; // onLoad fires again on the remounted instance
        }
        rec.sm = currentSM;
        r.resizeDrawingSurfaceToCanvas();
        rec.inputs = indexInputs(r, currentSM);
        rec.vm = bindVMNumbers(r, ["parallaxX", "parallaxY"]);
        rec.loaded = true;
        if (typeof opts.onLoad === "function") opts.onLoad(r, rec);
        notifyLoaded();
      },
      onLoadError: function (err) {
        // Try the next artboard-name candidate. This tolerates stray leading/
        // trailing spaces in the file's artboard names, then the default artboard.
        if (abIdx < abList.length - 1) {
          abIdx++;
          applyArtboard();
          if (abList[abIdx] !== undefined)
            console.warn("Rive: retrying " + canvas.dataset.rive + " with artboard '" + abList[abIdx] + "'.");
          try { r.cleanup && r.cleanup(); } catch (e) {}
          r = new rive.Rive(cfg);
          rec.riv = r;
          return;
        }
        console.error("Rive load error:", canvas.dataset.rive, err);
        // Degrade gracefully: mark the wrapper so CSS can show a placeholder.
        var holder = canvas.closest(".slide") || canvas.parentElement;
        if (holder) holder.classList.add("rive-failed");
        rec.loaded = true; // count as settled so the loader gate can proceed
        if (typeof opts.onLoadError === "function") opts.onLoadError(err);
        notifyLoaded();
      },
    };
    // Artboard candidates: exact name, with a trailing/leading space, trimmed,
    // and finally the file's default artboard (undefined).
    var abList = [];
    if (canvas.dataset.artboard) {
      var a0 = canvas.dataset.artboard;
      [a0, a0 + " ", " " + a0, a0.trim()].forEach(function (n) {
        if (abList.indexOf(n) === -1) abList.push(n);
      });
    }
    abList.push(undefined);
    var abIdx = 0;
    function applyArtboard() {
      if (abList[abIdx] === undefined) delete cfg.artboard;
      else cfg.artboard = abList[abIdx];
    }
    applyArtboard();
    var retriedSM = false;
    var r = new rive.Rive(cfg);
    rec.riv = r;
    instances.push(rec);
    return rec;
  }

  function setInput(rec, name, value) {
    var inp = rec.inputs[name];
    if (!inp) return false;
    try { inp.value = value; } catch (e) {}
    return true;
  }
  function fireInput(rec, name) {
    var inp = rec.inputs[name];
    if (inp && typeof inp.fire === "function") { try { inp.fire(); } catch (e) {} return true; }
    return false;
  }

  // Keep the drawing surface crisp on resize (debounced).
  var resizeTimer;
  var showcaseCalibrate = null; // set by initShowcase; recalibrates 3D slide surfaces
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      instances.forEach(function (it) {
        try { it.riv.resizeDrawingSurfaceToCanvas(); } catch (e) {}
      });
      if (showcaseCalibrate) showcaseCalibrate();
    }, 120);
  });

  /* ---------------- Cinematic loader gate ----------------
     Reveal the site only once BOTH are true:
       • assets loaded  (all .riv settled)
       • loader played  (the alien landing finished, or a min time elapsed)
     The landing fires a Rive event at its end if the file has one; otherwise we
     fall back to MIN_LOADER_MS so it always reveals. */
  var MIN_LOADER_MS = 6000; // no click: reveal after this long
  var LANDING_MS = 3200;    // after a click: time for the landing to play out fully
  var MIN_FLOOR_MS = 1500;  // never reveal before this
  var startTime = Date.now();
  var loaderClicked = false;
  var expectedLoads = 0, settledLoads = 0, gateDone = false;
  var assetsReady = false, loaderReady = false, loaderRec = null;

  function markLoaderEnded() {
    var elapsed = Date.now() - startTime;
    if (elapsed >= MIN_FLOOR_MS) { loaderReady = true; tryReveal(); }
    else setTimeout(function () { loaderReady = true; tryReveal(); }, MIN_FLOOR_MS - elapsed);
  }

  function notifyLoaded() {
    settledLoads++;
    if (expectedLoads > 0 && settledLoads >= expectedLoads) { assetsReady = true; tryReveal(); }
  }
  function tryReveal() {
    if (!gateDone && assetsReady && loaderReady) reveal();
  }

  function reveal() {
    if (gateDone) return;
    gateDone = true;
    body.classList.remove("is-loading");
    body.classList.add("is-ready");
    // Staged intro: fire the `intro` trigger wherever a file exposes one.
    instances.forEach(function (rec) { fireInput(rec, "intro"); });
    // Start depth parallax once the reveal animation has begun.
    startParallax();
    // Set correct (square) drawing buffers now that everything is laid out.
    if (showcaseCalibrate) showcaseCalibrate();
    // Free the loader once it's hidden behind the (now transparent) veil.
    setTimeout(function () { if (loaderRec) { try { loaderRec.riv.pause(); } catch (e) {} } }, 1200);
  }

  /* ---- Mount the loader (alien landing) inside the veil ---- */
  var loaderCanvas = document.querySelector(".loader-rive");
  if (loaderCanvas) {
    loaderRec = mountRive(loaderCanvas, {
      onLoad: function (r, rec) {
        fireInput(rec, "intro"); // auto-play the arrival if the file exposes a trigger
        // Click anywhere on the veil → the FILE plays the landing on its own click.
        // We only schedule the reveal for after the landing has finished (we don't
        // fire a trigger ourselves — that would double-run and desync the animation).
        var veil = document.querySelector(".intro-veil");
        if (veil) veil.addEventListener("click", function () {
          if (loaderClicked) return;
          loaderClicked = true;
          setTimeout(markLoaderEnded, LANDING_MS);
        });
        // Log any Rive events (helps identify a precise "landing complete" signal).
        try {
          r.on(rive.EventType.RiveEvent, function (e) {
            try { console.log("Rive event:", (e && e.data && e.data.name) || e); } catch (er) {}
          });
        } catch (e) {}
      },
    });
  } else {
    loaderReady = true; // no loader → don't block
  }
  // No click within this time → reveal anyway.
  setTimeout(function () { if (!loaderClicked) markLoaderEnded(); }, MIN_LOADER_MS);

  // Count every Rive canvas up front so the gate stays correct even though the
  // heavy ones mount a beat later.
  expectedLoads = document.querySelectorAll("canvas[data-rive]").length;

  var bgRec = null; // resolved once the scene mounts

  // A contact/logo whose .riv exposes a `hover` boolean reacts on pointer enter/leave.
  function wireHover(rec) {
    if (!rec.inputs["hover"]) return;
    var host = rec.canvas.closest(".contact, .logo");
    if (!host) return;
    host.addEventListener("pointerenter", function () { setInput(rec, "hover", true); });
    host.addEventListener("pointerleave", function () { setInput(rec, "hover", false); });
  }

  /* ---- Mount the scene/HUD + works a beat AFTER the loader ----
     This lets the loader animation start instantly and play smoothly instead of
     fighting the heavy project canvases for WebGL initialisation. */
  function mountRest() {
    document
      .querySelectorAll(".rive-bg, .logo canvas, .contact canvas, .slogan canvas, .footer canvas, .mascot canvas")
      .forEach(function (canvas) {
        mountRive(canvas, { onLoad: function (r, rec) { wireHover(rec); } });
      });
    instances.forEach(function (r) {
      if (r.canvas && r.canvas.classList.contains("rive-bg")) bgRec = r;
    });
    var showcase = document.querySelector(".showcase");
    if (showcase) initShowcase(showcase);
  }
  if (window.requestAnimationFrame) requestAnimationFrame(function () { setTimeout(mountRest, 300); });
  else setTimeout(mountRest, 300);

  // Safety net: never trap the user behind the veil if a file stalls.
  setTimeout(reveal, 9000);

  /* ---------------- Parallax (depth from cursor) ---------------- */
  // Normalized cursor position, smoothed toward the target each frame.
  var targetX = 0, targetY = 0, curX = 0, curY = 0;
  var hudLayers = [].slice.call(document.querySelectorAll("[data-parallax]"));
  var slidesEl = document.querySelector(".slides");
  var bgHasParallax = false; // resolved each frame from the bg inputs map

  window.addEventListener("pointermove", function (e) {
    targetX = (e.clientX / window.innerWidth) * 2 - 1;
    targetY = (e.clientY / window.innerHeight) * 2 - 1;
  }, { passive: true });

  function parallaxTick() {
    curX += (targetX - curX) * 0.07;
    curY += (targetY - curY) * 0.07;

    // 1) Drive parallax wherever a file exposes it — as SM inputs and/or as
    //    data-bound ViewModel number properties (the mascot uses the latter).
    instances.forEach(function (rec) {
      setInput(rec, "parallaxX", curX);
      setInput(rec, "parallaxY", curY);
      if (rec.vm) {
        try { if (rec.vm.parallaxX) rec.vm.parallaxX.value = curX; } catch (e) {}
        try { if (rec.vm.parallaxY) rec.vm.parallaxY.value = curY; } catch (e) {}
      }
    });

    // Layered depth: far (bg) moves least, mid (works) more, near (HUD) most —
    // all opposite the cursor. Different magnitudes read as parallax.

    // 1b) Scene fallback: translate the oversized bg canvas (only if the bg .riv
    //     has no parallax inputs of its own, to avoid double movement).
    bgHasParallax = !!(bgRec && (bgRec.inputs["parallaxX"] || bgRec.inputs["parallaxY"]));
    if (bgRec && !bgHasParallax && bgRec.canvas) {
      bgRec.canvas.style.transform =
        "scale(1.14) translate(" + (-curX * 2) + "%, " + (-curY * 2) + "%)";
    }

    // 2) Mid layer: the works drift a touch for depth between scene and HUD.
    if (slidesEl) {
      slidesEl.style.transform = "translate(" + (-curX * 8) + "px, " + (-curY * 8) + "px)";
    }

    // 3) HUD layers parallax in front for the strongest, nearest movement.
    hudLayers.forEach(function (el) {
      var f = parseFloat(el.dataset.parallax) || 0;
      el.style.transform = "translate(" + (-curX * f * 34) + "px, " + (-curY * f * 34) + "px)";
    });

    requestAnimationFrame(parallaxTick);
  }
  var parallaxStarted = false;
  function startParallax() {
    if (parallaxStarted || reduceMotion) return;
    parallaxStarted = true;
    requestAnimationFrame(parallaxTick);
  }

  /* ---- Forward page-wide pointer events onto click-through Rive canvases ----
     The bg and the mascot have pointer-events:none, so they never receive native
     input. Rive attaches its listeners to the canvas, so we mirror page-wide
     pointer moves onto them — this is what lets the mascot's eyes follow the cursor
     and the background react, even though both are click-through. */
  function forwardPointer(targetSelector) {
    var el = document.querySelector(targetSelector);
    if (!el) return;
    ["pointermove", "pointerdown", "pointerup"].forEach(function (type) {
      window.addEventListener(type, function (e) {
        var init = {
          clientX: e.clientX, clientY: e.clientY,
          screenX: e.screenX, screenY: e.screenY,
          bubbles: false, button: e.button || 0, buttons: e.buttons || 0,
          isPrimary: true, pointerId: e.pointerId || 1,
          pointerType: e.pointerType || "mouse",
        };
        try { el.dispatchEvent(new PointerEvent(type, init)); }
        catch (err) { el.dispatchEvent(new MouseEvent(type === "pointermove" ? "mousemove" : type, init)); }
        var mouseType = type === "pointermove" ? "mousemove" : type === "pointerdown" ? "mousedown" : "mouseup";
        try { el.dispatchEvent(new MouseEvent(mouseType, init)); } catch (e2) {}
      }, { passive: true });
    });
  }
  forwardPointer(".rive-bg");
  forwardPointer(".mascot canvas"); // mascot eyes follow the cursor

  /* ---------------- Showcase logic ---------------- */
  function initShowcase(root) {
    var slides = [].slice.call(root.querySelectorAll(".slide"));
    var dotsWrap = document.querySelector(".dots");
    var prevBtn = document.querySelector(".nav-prev");
    var nextBtn = document.querySelector(".nav-next");
    var caption = document.querySelector(".caption");
    var capIndex = caption && caption.querySelector(".caption-index");
    var capTitle = caption && caption.querySelector(".caption-title");
    var capDesc = caption && caption.querySelector(".caption-desc");
    var count = slides.length;
    var index = 0;
    var recs = new Array(count);
    var pauseTimer = null;
    var capTimer = null;

    function pad2(n) { return (n < 10 ? "0" : "") + n; }

    // Cross-fade the caption text to the active work's English copy.
    function updateCaption() {
      if (!caption) return;
      caption.classList.add("is-switching");
      if (capTimer) clearTimeout(capTimer);
      capTimer = setTimeout(function () {
        var s = slides[index];
        if (capIndex) capIndex.textContent = pad2(index + 1) + " / " + pad2(count);
        if (capTitle) capTitle.textContent = s.dataset.title || "";
        if (capDesc) capDesc.textContent = s.dataset.desc || "";
        caption.classList.remove("is-switching");
      }, 220);
    }

    function safePause(r) { try { r.pause(); } catch (e) {} }
    function safePlay(r) { try { r.play(); } catch (e) {} }

    /* Rive sizes its drawing buffer from getBoundingClientRect(), which is skewed
       for slides parked in 3D (rotateY/scale) → squashed art. Calibrate by briefly
       flattening every slide, resizing each surface square, then re-parking. */
    var calibrateTimer = null;
    function calibrateSurfaces() {
      root.classList.add("calibrating"); // suppress transitions during the flatten
      slides.forEach(function (s) { s.style.transform = "none"; });
      void root.offsetWidth; // reflow so rects are the flat, square size
      recs.forEach(function (rec) {
        if (rec) { try { rec.riv.resizeDrawingSurfaceToCanvas(); } catch (e) {} }
      });
      placeAll(); // restore 3D positions
      void root.offsetWidth;
      requestAnimationFrame(function () { root.classList.remove("calibrating"); });
    }
    function calibrateSoon() {
      clearTimeout(calibrateTimer);
      calibrateTimer = setTimeout(calibrateSurfaces, 60);
    }
    showcaseCalibrate = calibrateSurfaces;

    // Mount each work; flag CSS off when Rive can do the rack-focus itself.
    slides.forEach(function (slide, i) {
      var canvas = slide.querySelector("canvas");
      recs[i] = mountRive(canvas, {
        onLoad: function (r, rec) {
          if (rec.inputs["focus"]) body.classList.add("has-rive-focus");
          setInput(rec, "focus", i === index ? 0 : 1);
          if (i !== index) safePause(r);
          calibrateSoon(); // each newly-loaded surface needs a square buffer
        },
      });
    });

    // Build dots
    var dots = [];
    for (var i = 0; i < count; i++) {
      (function (i) {
        var dot = document.createElement("button");
        dot.className = "dot";
        dot.type = "button";
        dot.setAttribute("role", "tab");
        dot.setAttribute("aria-label", "Работа " + (i + 1));
        dot.addEventListener("click", function () { goTo(i); restartAutoplay(); });
        dotsWrap.appendChild(dot);
        dots.push(dot);
      })(i);
    }

    /* ---- 3D cube-face stage: works swing in from depth ---- */
    // A resting "side" pose deep in the stage; `dir` +1 = right side, -1 = left.
    function sideTransform(dir) {
      if (reduceMotion) return "none"; // honour reduced motion: pure cross-fade
      return "translateX(" + (dir * 46) + "%) translateZ(-640px) rotateY(" +
        (dir * -52) + "deg) scale(0.9)";
    }
    // Position a slide either at the front (center) or parked on a side in depth.
    function setSlide(el, dir /* 0 = front */) {
      if (dir === 0) {
        el.style.transform = "none";
        el.style.opacity = "1";
        el.style.filter = "none";
      } else {
        el.style.transform = sideTransform(dir);
        el.style.opacity = "0";
        el.style.filter = reduceMotion ? "none" : "blur(14px) brightness(0.5)";
      }
    }
    // Initial layout: active up front, the rest parked left/right by order.
    function placeAll() {
      slides.forEach(function (s, i) {
        s.classList.toggle("is-active", i === index);
        setSlide(s, i === index ? 0 : (i < index ? -1 : 1));
      });
    }
    // Animate the swap: incoming swings up from one side, outgoing recedes to the other.
    function animate3D(from, to, dir) {
      var incoming = slides[to], outgoing = slides[from];
      // Park the incoming on its entry side with no transition, then release it forward.
      incoming.classList.remove("is-active");
      incoming.style.transition = "none";
      setSlide(incoming, dir);
      void incoming.offsetWidth; // force reflow so the next change animates
      incoming.style.transition = "";
      incoming.classList.add("is-active");
      setSlide(incoming, 0);
      // Send the outgoing back into depth on the opposite side.
      outgoing.classList.remove("is-active");
      setSlide(outgoing, -dir);
    }

    function render() {
      updateCaption();
      dots.forEach(function (d, i) {
        d.classList.toggle("active", i === index);
        d.setAttribute("aria-selected", i === index ? "true" : "false");
      });

      // Play the active work in focus; push the rest into rack-focus (Rive `focus`).
      recs.forEach(function (rec, i) {
        if (!rec) return;
        if (i === index) { safePlay(rec.riv); setInput(rec, "focus", 0); }
        else setInput(rec, "focus", 1);
      });

      // Pause off-screen works once the swap transition has played out.
      if (pauseTimer) clearTimeout(pauseTimer);
      pauseTimer = setTimeout(function () {
        recs.forEach(function (rec, i) { if (rec && i !== index) safePause(rec.riv); });
      }, 950);
    }

    function goTo(i, dir) {
      var target = (i + count) % count;
      if (target === index) return;
      if (dir === undefined) dir = target > index ? 1 : -1;
      var from = index;
      index = target;
      animate3D(from, index, dir);
      render();
    }
    function next() { goTo(index + 1, 1); }
    function prev() { goTo(index - 1, -1); }

    nextBtn.addEventListener("click", function () { next(); restartAutoplay(); });
    prevBtn.addEventListener("click", function () { prev(); restartAutoplay(); });

    // Keyboard (page-wide, since there's no focusable carousel container now)
    window.addEventListener("keydown", function (e) {
      if (e.key === "ArrowRight") { next(); restartAutoplay(); }
      else if (e.key === "ArrowLeft") { prev(); restartAutoplay(); }
    });

    /* ---- Drag / swipe across the full-bleed showcase ----
       Raw mouse + touch (reliable, unaffected by Rive's pointer capture).
       Swipe never starts on a HUD control. Over an interactive work (e.g. the
       wheel) the work keeps its own drag — small moves spin it, and only a long,
       deliberate horizontal fling pages away (we don't preventDefault there, so
       the work still receives the gesture). */
    var dragging = false, startX = 0, startY = 0, deltaX = 0, deltaY = 0, overInteractive = false;

    function isControl(target) {
      return target && target.closest &&
        target.closest(".nav-arrow, .dot, .logo, .contact, .made-badge, .slogan");
    }
    function isInteractiveWork(target) {
      var slide = target && target.closest && target.closest(".slide");
      return !!(slide && slide.classList.contains("is-active") && slide.dataset.interactive === "true");
    }
    function startGesture(x, y, target) {
      if (isControl(target)) { dragging = false; return; }
      dragging = true;
      overInteractive = isInteractiveWork(target);
      startX = x; startY = y; deltaX = 0; deltaY = 0;
      stopAutoplay();
    }
    function moveGesture(x, y) {
      if (!dragging) return;
      deltaX = x - startX; deltaY = y - startY;
    }
    function endGesture() {
      if (!dragging) return;
      dragging = false;
      // Interactive works demand a long fling so spinning them doesn't page away.
      var threshold = overInteractive
        ? Math.max(120, window.innerWidth * 0.22)
        : Math.max(40, window.innerWidth * 0.05);
      if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > threshold) {
        if (deltaX > 0) prev(); else next();
      }
      restartAutoplay();
    }

    // Mouse (desktop)
    root.addEventListener("mousedown", function (e) { startGesture(e.clientX, e.clientY, e.target); });
    window.addEventListener("mousemove", function (e) { moveGesture(e.clientX, e.clientY); });
    window.addEventListener("mouseup", endGesture);

    // Touch (mobile) — touch-action:none on .showcase keeps these flowing
    root.addEventListener("touchstart", function (e) {
      var t = e.changedTouches[0];
      startGesture(t.clientX, t.clientY, e.target);
    }, { passive: true });
    root.addEventListener("touchmove", function (e) {
      var t = e.changedTouches[0];
      moveGesture(t.clientX, t.clientY);
      // For a non-interactive work, claim the horizontal swipe from the browser.
      // Over an interactive work we leave events alone so it keeps responding.
      if (dragging && !overInteractive && Math.abs(deltaX) > Math.abs(deltaY) && e.cancelable) e.preventDefault();
    }, { passive: false });
    root.addEventListener("touchend", endGesture);
    root.addEventListener("touchcancel", endGesture);

    /* ---- Autoplay (pause on hover / hidden tab) ---- */
    var AUTOPLAY_MS = 5000;
    var timer = null;
    function startAutoplay() {
      if (timer || count < 2 || reduceMotion) return;
      timer = setInterval(next, AUTOPLAY_MS);
    }
    function stopAutoplay() { if (timer) { clearInterval(timer); timer = null; } }
    function restartAutoplay() { stopAutoplay(); startAutoplay(); }

    [prevBtn, nextBtn, dotsWrap].forEach(function (el) {
      el.addEventListener("pointerenter", stopAutoplay);
      el.addEventListener("pointerleave", startAutoplay);
    });

    // Don't auto-advance while the user is over / interacting with a work.
    // Hover is bound to the work canvas itself (only the active one is hit-testable),
    // so autoplay pauses on the project — not on the whole full-bleed area.
    slides.forEach(function (s) {
      var c = s.querySelector("canvas");
      if (!c) return;
      c.addEventListener("mouseenter", stopAutoplay);
      c.addEventListener("mouseleave", startAutoplay);
    });
    root.addEventListener("touchstart", stopAutoplay, { passive: true });
    root.addEventListener("touchend", restartAutoplay);
    root.addEventListener("touchcancel", restartAutoplay);

    document.addEventListener("visibilitychange", function () {
      if (document.hidden) stopAutoplay(); else startAutoplay();
    });

    placeAll();
    render();
    startAutoplay();
  }
})();
