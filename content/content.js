// YouTube Mixer — content script.
//
// Controls the underlying HTML5 <video> element directly (volume / muted /
// loop / play / pause) rather than driving YouTube's own UI. Responsibilities:
//   1. Replace the native volume UI (speaker icon + hover slider) with a wide,
//      always-visible cluster: numeric 0-100 readout, eased slider, MUTE, FADE.
//   2. Enforce start state on every video load: paused, muted, loop on —
//      even against autoplay.
//   3. Answer messages from the popup and keep everything in sync with the
//      video's real state via its media events.
//
// Depends on shared/slider.js (loaded first via manifest.json).

(() => {
  'use strict';

  const FADE_SECONDS = 5;

  let video = null; // the main watch-page <video> we control
  let ui = null;    // { root, readout, slider, muteBtn, fadeBtn }
  let lastEnforcedSrc = null;
  let playApproved = false;   // a human (or the popup) asked to play the current source
  let lastPlayerGesture = 0;  // timestamp of the last gesture aimed at the player
  let fadeRaf = null;

  const isWatchPage = () => location.pathname === '/watch';

  // ---------------------------------------------------------------- gestures
  // To enforce "start paused" against autoplay we need to tell a real human
  // play request from YouTube's own autoplay. Heuristic: a 'play' event is
  // human if a pointer gesture landed inside the player (or a play-ish key
  // was pressed) within the last second, or if the popup asked for it.
  document.addEventListener('pointerdown', (e) => {
    if (e.target instanceof Element && e.target.closest('#movie_player')) {
      lastPlayerGesture = performance.now();
    }
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'k' || e.key === 'K') {
      lastPlayerGesture = performance.now();
    }
  }, true);

  // ------------------------------------------------ player-state mirroring
  // We set video.volume directly for smooth eased frames, but YouTube's
  // player object holds its own volume state and re-applies it at
  // unpredictable moments (quality/buffer/ad events), snapping our changes
  // back. After any volume/mute change settles, mirror it into the player
  // API via the MAIN-world bridge (content/bridge.js) so the state YouTube
  // restores from is always the one you chose. Debounced: per-frame slider
  // and fade updates collapse into one sync. The bridge echo (YouTube
  // re-setting the same value) re-triggers this idempotently and converges.
  let syncTimer = null;
  function scheduleStateSync() {
    if (syncTimer !== null) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      syncTimer = null;
      if (!video) return;
      document.dispatchEvent(new CustomEvent('ytm-sync-player-state', {
        detail: JSON.stringify({ volume: video.volume, muted: video.muted }),
      }));
    }, 300);
  }

  function onVolumeChange() {
    syncUi();
    scheduleStateSync();
  }

  // ------------------------------------------------------- video attachment
  function findVideo() {
    return document.querySelector('#movie_player video.html5-main-video')
        || document.querySelector('ytd-player video');
  }

  function attachVideo() {
    const v = findVideo();
    if (!v || v === video) return;
    if (video) {
      video.removeEventListener('loadstart', enforceStartState);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', syncUi);
      video.removeEventListener('volumechange', onVolumeChange);
    }
    video = v;
    video.addEventListener('loadstart', enforceStartState);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', syncUi);
    video.addEventListener('volumechange', onVolumeChange);
    enforceStartState();
    syncUi();
  }

  // ------------------------------------------------------ start-state rules
  // Whenever a new source loads: paused, muted, looping. YouTube's SPA reuses
  // the same <video> element across navigations, so we key off the source URL
  // rather than the element.
  function enforceStartState() {
    if (!video || !isWatchPage()) return;
    const src = video.currentSrc || video.src;
    if (!src || src === lastEnforcedSrc) return;
    lastEnforcedSrc = src;
    playApproved = false;
    cancelFade();
    video.pause();
    video.muted = true;
    video.loop = true;
    syncUi();
  }

  function onPlay() {
    if (!video) return;
    if (!isWatchPage()) return;
    const gestureRecent = performance.now() - lastPlayerGesture < 1000;
    if (playApproved || gestureRecent) {
      playApproved = true;
    } else {
      // Autoplay with no human gesture at the player: shut it down.
      video.pause();
    }
    syncUi();
  }

  // YouTube resets .loop when it rebuilds player state; quietly re-assert it.
  setInterval(() => {
    if (video && isWatchPage() && !video.loop) video.loop = true;
  }, 1000);

  // ----------------------------------------------------------------- fading
  function startFade() {
    // FADE is a toggle: a second press mid-fade stops the ramp, leaving the
    // volume wherever it is at that moment.
    if (fadeRaf !== null) {
      cancelFade();
      syncUi();
      return;
    }
    if (!video || video.volume <= 0) return;
    const from = video.volume;
    const t0 = performance.now();
    const step = (ts) => {
      if (!video) {
        fadeRaf = null;
        return;
      }
      const p = Math.min(1, (ts - t0) / (FADE_SECONDS * 1000));
      video.volume = from * (1 - p);
      if (p < 1) {
        fadeRaf = requestAnimationFrame(step);
      } else {
        video.volume = 0;
        fadeRaf = null;
        syncUi();
      }
    };
    fadeRaf = requestAnimationFrame(step);
  }

  function cancelFade() {
    if (fadeRaf !== null) {
      cancelAnimationFrame(fadeRaf);
      fadeRaf = null;
    }
  }

  // --------------------------------------------------------------------- UI
  function makeButton(cls, label, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ytm-btn ' + cls;
    b.textContent = label;
    // Keep the player from reacting to our button presses.
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  function buildUi() {
    const root = document.createElement('div');
    root.className = 'ytm-controls';

    // Numeric 0-100 readout — replaces the speaker icon.
    const readout = document.createElement('span');
    readout.className = 'ytm-readout';
    readout.textContent = '0';

    // Wide, always-visible eased slider — replaces the native volume slider.
    const slider = createMixerSlider({
      onInput(v) {
        cancelFade(); // hand on the fader overrides an in-flight fade
        if (video) video.volume = v;
      },
    });
    slider.el.classList.add('ytm-slider');

    const muteBtn = makeButton('ytm-mute', 'MUTE', () => {
      if (video) video.muted = !video.muted;
    });
    const fadeBtn = makeButton('ytm-fade', 'FADE', startFade);

    root.append(readout, slider.el, muteBtn, fadeBtn);
    ui = { root, readout, slider, muteBtn, fadeBtn };
  }

  function mountUi() {
    const left = document.querySelector('#movie_player .ytp-left-controls');
    if (!left) return;
    if (ui && left.contains(ui.root)) return;
    if (!ui) buildUi();
    // Sit exactly where the native volume UI (hidden via CSS) used to be.
    const volumeArea = left.querySelector('.ytp-volume-area');
    if (volumeArea) {
      volumeArea.insertAdjacentElement('afterend', ui.root);
    } else {
      left.appendChild(ui.root);
    }
    syncUi();
  }

  // Reflect the video's real state (whoever changed it: us, the popup,
  // YouTube itself, or a keyboard shortcut).
  function syncUi() {
    if (!ui || !video) return;
    ui.readout.textContent = String(Math.round(video.volume * 100));
    ui.slider.setValue(video.volume);
    ui.root.classList.toggle('ytm-muted', video.muted);
  }

  // ---------------------------------------------------------- page watching
  // YouTube is a SPA: the player and video element appear late and get
  // rebuilt on navigation. Watch the DOM (rAF-debounced) and re-scan.
  let scanQueued = false;
  function scheduleScan() {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(() => {
      scanQueued = false;
      scan();
    });
  }

  function scan() {
    if (!isWatchPage()) return;
    attachVideo();
    mountUi();
  }

  new MutationObserver(scheduleScan)
    .observe(document.documentElement, { childList: true, subtree: true });

  window.addEventListener('yt-navigate-finish', () => {
    scan();
    // Part of the layout stabilisation: every watch tab starts from the same
    // scroll position, so the player sits at the same viewport height.
    if (isWatchPage()) window.scrollTo(0, 0);
  });

  scan();

  // -------------------------------------------------------- popup messaging
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!isWatchPage() || !video) {
      sendResponse({ ok: false });
      return;
    }
    switch (msg.type) {
      case 'getState':
        sendResponse({
          ok: true,
          title: document.title.replace(/ - YouTube$/, ''),
          videoId: new URLSearchParams(location.search).get('v'),
          volume: video.volume,
          muted: video.muted,
          paused: video.paused,
          fading: fadeRaf !== null,
        });
        break;
      case 'setVolume':
        cancelFade();
        video.volume = Math.min(1, Math.max(0, msg.value));
        sendResponse({ ok: true });
        break;
      case 'toggleMute':
        video.muted = !video.muted;
        sendResponse({ ok: true });
        break;
      case 'togglePlay':
        if (video.paused) {
          playApproved = true;
          video.play().catch(() => {
            // Chrome's autoplay policy can reject an unmuted play() with no
            // gesture in the tab; one click anywhere in that tab fixes it.
          });
        } else {
          video.pause();
        }
        sendResponse({ ok: true });
        break;
      case 'fadeOut':
        startFade();
        sendResponse({ ok: true });
        break;
      default:
        sendResponse({ ok: false });
    }
  });
})();
