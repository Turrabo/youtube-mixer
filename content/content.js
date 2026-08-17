// YouTube Mixer - content script.
//
// Responsibilities:
//   1. Replace the native volume UI (speaker icon + hover slider) with a wide,
//      always-visible cluster: numeric 0-100 readout, eased slider, MUTE, FADE.
//   2. Enforce start state on every video load: paused, muted, loop on -
//      even against autoplay.
//   3. Answer messages from the popup, and keep the UI in sync with the real
//      player state.
//
// Volume and mute go through YouTube's own player API via the MAIN-world
// bridge (content/bridge.js), NOT by writing video.volume. See the long
// comment at the top of bridge.js for the measurements that force this: the
// player owns video.volume and both overwrites and rescales it, so anything
// that writes or reads it directly either gets wiped or ratchets downward.
//
// Play/pause and loop still use the element directly - the player does not
// fight us on those.
//
// Depends on shared/slider.js (loaded first via manifest.json).

(() => {
  'use strict';

  const FADE_SECONDS = 5;

  let video = null; // the main watch-page <video>
  let ui = null;    // { root, readout, slider, muteBtn, fadeBtn }
  let lastEnforcedVideoId = null;
  let startMuteUntil = 0;     // re-assert the start mute until this timestamp
  let playApproved = false;   // a human (or the popup) asked to play this source
  let lastPlayerGesture = 0;  // timestamp of the last gesture aimed at the player
  let fadeTimer = null;

  // Last state reported by the bridge. This - not video.volume - is what the
  // UI and the popup read.
  let state = { volume: 0, muted: true, paused: true, api: false };

  const isWatchPage = () => location.pathname === '/watch';

  // ------------------------------------------------------------------ bridge
  function sendCmd(cmd) {
    document.dispatchEvent(new CustomEvent('ytm-cmd', {
      detail: JSON.stringify(cmd),
    }));
  }

  document.addEventListener('ytm-state', (e) => {
    try {
      state = JSON.parse(e.detail);
    } catch {
      return;
    }
    // The player is often not ready to accept mute at the instant a video
    // loads, so the start mute can silently fail to take. Keep re-asserting
    // it briefly until the player confirms. Any deliberate action by the user
    // clears the deadline, so this can never fight a real unmute.
    if (startMuteUntil && !state.muted) {
      if (Date.now() < startMuteUntil) sendCmd({ type: 'setMuted', muted: true });
      else startMuteUntil = 0;
    }
    syncUi();
  });

  // Called by anything the user deliberately does, so the start-state mute
  // stops re-asserting itself.
  function userTookControl() {
    startMuteUntil = 0;
  }

  function setVolume(v01) {
    sendCmd({ type: 'setVolume', value: v01 });
    // Optimistic local update so the readout tracks the hand with no
    // round-trip lag; the bridge's report confirms it a moment later.
    state.volume = Math.min(1, Math.max(0, v01));
    if (ui) ui.readout.textContent = String(Math.round(state.volume * 100));
  }

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
    }
    video = v;
    video.addEventListener('loadstart', enforceStartState);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', syncUi);
    enforceStartState();
    syncUi();
  }

  // ------------------------------------------------------ start-state rules
  // Whenever a NEW VIDEO loads: paused, muted, looping.
  //
  // Keyed on the watch URL's video id, deliberately NOT on video.currentSrc.
  // YouTube swaps the element's source mid-playback whenever it changes
  // quality or stream format, which fires 'loadstart' with a new src on the
  // same video - keying off src meant a routine quality switch paused and
  // muted a track that was already playing. The SPA also reuses one <video>
  // element across navigations, so the element identity is no use either.
  const currentVideoId = () => new URLSearchParams(location.search).get('v');

  function enforceStartState() {
    if (!video || !isWatchPage()) return;
    const id = currentVideoId();
    if (!id || id === lastEnforcedVideoId) return;
    lastEnforcedVideoId = id;
    playApproved = false;
    cancelFade();
    video.pause();
    video.loop = true;
    startMuteUntil = Date.now() + 6000;
    sendCmd({ type: 'setMuted', muted: true });
    syncUi();
  }

  function onPlay() {
    if (!video || !isWatchPage()) return;
    const gestureRecent = performance.now() - lastPlayerGesture < 1000;
    if (playApproved || gestureRecent) {
      playApproved = true;
      userTookControl();
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
  // Driven by wall-clock elapsed time on a timer, NOT requestAnimationFrame.
  // Chrome pauses rAF entirely in hidden tabs, which froze the fade the
  // moment you switched away. A timer keeps running in a background tab, and
  // because each tick recomputes from elapsed time rather than accumulating,
  // the ramp still finishes at exactly FADE_SECONDS even if the browser
  // throttles the tick rate while the tab is in the background.
  function startFade() {
    // FADE is a toggle: a second press mid-fade stops the ramp, leaving the
    // volume wherever it is at that moment.
    if (fadeTimer !== null) {
      cancelFade();
      syncUi();
      return;
    }
    const from = state.volume;
    if (from <= 0) return;
    const t0 = Date.now();
    fadeTimer = setInterval(() => {
      const p = Math.min(1, (Date.now() - t0) / (FADE_SECONDS * 1000));
      setVolume(from * (1 - p));
      if (p >= 1) {
        cancelFade();
        setVolume(0);
        syncUi();
      }
    }, 50);
  }

  function cancelFade() {
    if (fadeTimer !== null) {
      clearInterval(fadeTimer);
      fadeTimer = null;
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

    // Numeric 0-100 readout - replaces the speaker icon.
    const readout = document.createElement('span');
    readout.className = 'ytm-readout';
    readout.textContent = '0';

    // Wide, always-visible eased slider - replaces the native volume slider.
    const slider = createMixerSlider({
      onInput(v) {
        cancelFade(); // hand on the fader overrides an in-flight fade
        setVolume(v);
      },
    });
    slider.el.classList.add('ytm-slider');

    const muteBtn = makeButton('ytm-mute', 'MUTE', () => {
      userTookControl();
      sendCmd({ type: 'setMuted', muted: !state.muted });
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

  // Reflect the real player state, whoever changed it: us, the popup,
  // YouTube itself, or a keyboard shortcut.
  function syncUi() {
    if (!ui) return;
    ui.readout.textContent = String(Math.round(state.volume * 100));
    ui.slider.setValue(state.volume);
    ui.root.classList.toggle('ytm-muted', state.muted);
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
          volume: state.volume,
          muted: state.muted,
          paused: video.paused,
          fading: fadeTimer !== null,
        });
        break;
      case 'setVolume':
        cancelFade();
        setVolume(msg.value);
        sendResponse({ ok: true });
        break;
      case 'toggleMute':
        userTookControl();
        sendCmd({ type: 'setMuted', muted: !state.muted });
        sendResponse({ ok: true });
        break;
      case 'togglePlay':
        if (video.paused) {
          playApproved = true;
          userTookControl();
          sendCmd({ type: 'play' });
        } else {
          sendCmd({ type: 'pause' });
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
