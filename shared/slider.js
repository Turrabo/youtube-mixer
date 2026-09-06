// YouTube Mixer - shared eased slider.
// Used by both the in-player controls (content script) and the popup, so the
// two surfaces feel identical. Vanilla JS, no dependencies.
//
// Interaction model:
//   - CLICK anywhere on the track: the value jumps to that position
//     immediately (no easing).
//   - DRAG the handle: the displayed value is a damped follow of the pointer.
//     Each animation frame it moves a fraction of the remaining distance
//     toward the pointer's "target" value, so the handle feels heavy and
//     smooths out hand jitter, then settles on the target within ~1-2 s of
//     the hand stopping.
//
// createMixerSlider({ onInput(value), onHold(held) }) -> {
//   el         the root element to insert
//   setValue(v)  external update (e.g. real video volume changed); ignored
//                while the user is interacting so it can't fight a drag
//   isBusy()   true while dragging or while the easing loop is settling
// }
//
// onInput fires with the *displayed* (eased) value, 0..1 - drive the real
// video.volume from it.
//
// onHold is optional and fires true while the pointer is actually held down
// on the slider, false on release. It exists because this slider swallows the
// pointer stream: pointerdown calls preventDefault(), which by spec cancels
// the compatibility mouse events (mousedown/mousemove/mouseup) for that
// pointer, and it takes pointer capture. A host that needs to know somebody
// is mid-drag - the player's control bar, whose idle timer feeds on exactly
// those mousemove events - cannot find out any other way.

function createMixerSlider(opts) {
  // Damping time constant in seconds. The displayed value closes
  // 1 - e^(-dt/TAU) of the gap per frame, so ~63% of the way in TAU seconds
  // and ~95% in 3*TAU. 0.45 makes the handle clearly heavy but settled well
  // inside two seconds.
  const TAU = 0.45;

  const el = document.createElement('div');
  el.className = 'mixer-slider';
  const fill = document.createElement('div');
  fill.className = 'mixer-slider-fill';
  const handle = document.createElement('div');
  handle.className = 'mixer-slider-handle';
  el.append(fill, handle);

  let displayed = 0; // eased value the video actually follows
  let target = 0;    // raw value under the pointer
  let dragging = false;
  let rafId = null;
  let lastTs = 0;

  const notifyHold = (held) => {
    if (typeof opts.onHold === 'function') opts.onHold(held);
  };

  function render() {
    const pct = displayed * 100 + '%';
    fill.style.width = pct;
    handle.style.left = pct;
  }

  function valueFromEvent(e) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0) return displayed;
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  }

  function step(ts) {
    const dt = Math.min((ts - lastTs) / 1000, 0.1) || 0.016;
    lastTs = ts;
    const gapBefore = target - displayed;
    displayed += gapBefore * (1 - Math.exp(-dt / TAU));
    // Never travel past the target: if this frame reached or crossed it,
    // pin to it exactly. The handle rests AT the release point, no drift-by.
    if ((target - displayed) * gapBefore <= 0) displayed = target;
    if (!dragging && Math.abs(target - displayed) < 0.001) {
      // Settled after release: snap the last fraction and stop the loop.
      displayed = target;
      rafId = null;
    } else {
      rafId = requestAnimationFrame(step);
    }
    render();
    opts.onInput(displayed);
  }

  function ensureLoop() {
    if (rafId === null) {
      lastTs = performance.now();
      rafId = requestAnimationFrame(step);
    }
  }

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    el.setPointerCapture(e.pointerId);
    dragging = true;
    el.classList.add('dragging');
    notifyHold(true);
    target = valueFromEvent(e);
    if (e.target === handle) {
      // Grabbed the handle: eased follow from the current position.
      ensureLoop();
    } else {
      // Clicked the track: jump immediately, bypassing the easing.
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      displayed = target;
      render();
      opts.onInput(displayed);
    }
  });

  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    target = valueFromEvent(e);
    ensureLoop();
  });

  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    el.classList.remove('dragging');
    notifyHold(false);
    // The release position is authoritative: ease the remaining distance to
    // exactly where the button came up, never beyond it. (pointercancel has
    // no trustworthy coordinates, so it keeps the last-move target.)
    if (e) target = valueFromEvent(e);
    ensureLoop(); // keep easing until displayed catches up with target
  }
  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', () => endDrag(null));
  // Removing a capturing element from the document releases capture
  // IMPLICITLY, and that fires lostpointercapture - not pointercancel. The
  // host rebuilds the control bar and re-appends this slider, so a drag
  // overlapping that would otherwise end with no release at all: `dragging`
  // would stay true for the life of the page, setValue() would be ignored
  // for ever, and onHold(true) would never be answered. The endDrag guard
  // makes this idempotent on the ordinary path, where it fires after
  // pointerup has already finished the job.
  el.addEventListener('lostpointercapture', () => endDrag(null));

  // Swallow clicks so the page underneath (e.g. the YouTube player) never
  // reacts to slider interaction.
  el.addEventListener('click', (e) => e.stopPropagation());

  render();

  return {
    el,
    setValue(v) {
      if (dragging || rafId !== null) return;
      displayed = target = Math.min(1, Math.max(0, v));
      render();
    },
    isBusy() {
      return dragging || rafId !== null;
    },
  };
}
