// YouTube Mixer - content script.
//
// Responsibilities:
//   1. Replace the native volume UI (speaker icon + hover slider) with a wide,
//      always-visible cluster: numeric 0-100 readout, a speaker icon that
//      toggles mute and shows the level, eased slider, FADE.
//   2. Enforce start state on every video load: paused and loop on - even
//      against autoplay. Mute is deliberately NOT part of that; see the
//      start-state rules below.
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

  const FADE_SECONDS = 7.5;

  let video = null; // the main watch-page <video>
  let ui = null;    // { root, readout, slider, muteBtn, fadeBtn }
  let lastEnforcedVideoId = null;
  let playApproved = false;   // a human (or the popup) asked to play this source
  let lastPlayerGesture = 0;  // timestamp of the last gesture aimed at the player
  let fadeTimer = null;

  // Last state reported by the bridge. This - not video.volume - is what the
  // UI and the popup read.
  //
  // Nothing forces mute any more, so this initial `muted` is a placeholder
  // rather than something the extension guarantees: YouTube persists mute
  // per profile, so a tab can legitimately open muted. attachVideo() seeds it
  // from the real element, and the bridge's 250 ms report corrects it either
  // way. Left as a guess it would make the first press of the speaker a
  // no-op on a player that was already muted.
  let state = { volume: 0, muted: false, paused: true, api: false };

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
    syncUi();
  });

  function setVolume(v01) {
    sendCmd({ type: 'setVolume', value: v01 });
    // Optimistic local update so the readout tracks the hand with no
    // round-trip lag; the bridge's report confirms it a moment later.
    state.volume = Math.min(1, Math.max(0, v01));
    renderVolume();
  }

  // Everything that shows the volume, in one place, so a drag updates the
  // waves as promptly as it updates the number rather than waiting for the
  // bridge's next report.
  function renderVolume() {
    if (!ui) return;
    ui.readout.textContent = String(Math.round(state.volume * 100));
    // Only on a real change. A drag calls this every animation frame, and an
    // attribute write inside the player's subtree invalidates style each
    // time; the count only moves three times across the whole range.
    const waves = String(waveCount(state.volume));
    if (ui.muteBtn.dataset.waves !== waves) ui.muteBtn.dataset.waves = waves;
  }

  // ---------------------------------------------------------------- gestures
  // To enforce "start paused" against autoplay we need to tell a real human
  // play request from YouTube's own autoplay. Heuristic: a 'play' event is
  // human if a pointer gesture landed inside the player (or a play-ish key
  // was pressed) within the last second, or if the popup asked for it.
  //
  // Our own cluster mounts INSIDE #movie_player and this listener is
  // capture-phase, so it sees a press on the fader, speaker or FADE before the
  // button's own stopPropagation can hide it. None of those is a request to
  // play, and treating one as a human play latches playApproved for the rest
  // of the video - so setting the volume before pressing play could sanction
  // an autoplay that arrived a moment later. Exclude them explicitly.
  document.addEventListener('pointerdown', (e) => {
    if (!(e.target instanceof Element)) return;
    if (e.target.closest('.ytm-controls')) return;
    if (e.target.closest('#movie_player')) {
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
    state.muted = video.muted;
    video.addEventListener('loadstart', enforceStartState);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', syncUi);
    enforceStartState();
    syncUi();
  }

  // ------------------------------------------------------ start-state rules
  // Whenever a NEW VIDEO loads: paused and looping.
  //
  // Mute is deliberately not enforced. A tab that opens muted has to be
  // unmuted by hand before it can be used, which is one action per tab in a
  // session that opens many of them, and "start paused" already guarantees
  // nothing makes a sound until it is played.
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
    syncUi();
  }

  function onPlay() {
    if (!video || !isWatchPage()) return;
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

  // ------------------------------------------------- keeping the bar awake
  // The control bar hides on idle, and YouTube's idle timer is fed by
  // mousemove. The mixer slider takes pointer capture and calls
  // preventDefault() on pointerdown, which by spec suppresses the
  // compatibility mouse events for that pointer - so during a slow, careful
  // drag YouTube sees no activity at all and fades the bar out from under the
  // hand that is using it.
  //
  // Rather than fight the fade in CSS (which would leave YouTube's own state
  // machine believing it had hidden the bar, and the cursor hidden with it),
  // keep resetting the timer for as long as the hand is down. The player's
  // own wakeUpControls() does it, through the bridge, since only the MAIN
  // world can reach the player object.
  //
  // On release the timer is left to run out normally, so the bar goes back to
  // behaving exactly as YouTube's does. Nothing is pinned open.
  let awakeTimer = null;

  function holdBarOpen(held) {
    if (held) {
      if (awakeTimer !== null) return;
      sendCmd({ type: 'wakeControls' });
      // The slider answers every hold with a release, including when it is
      // torn out of the document mid-drag. This tick checks a DIFFERENT
      // thing: that the cluster is still on the page at all. A timer that
      // pins the control bar open for the life of the tab is the one failure
      // here with no way back for the user, so it is bounded by something
      // this side of the callback rather than only by the callback arriving.
      awakeTimer = setInterval(() => {
        if (!ui || !ui.root.isConnected) {
          holdBarOpen(false);
          return;
        }
        sendCmd({ type: 'wakeControls' });
      }, 500);
    } else if (awakeTimer !== null) {
      clearInterval(awakeTimer);
      awakeTimer = null;
      // One last wake on release, so the countdown restarts from the moment
      // the hand came off rather than from the last interval tick.
      sendCmd({ type: 'wakeControls' });
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

  // The speaker: a mute toggle whose three waves also read out roughly how
  // loud the track is. Volume and mute stay independent - the waves show the
  // volume the track will return to, so muting does not pretend the volume
  // moved.
  const SPEAKER_SVG =
    '<svg class="ytm-speaker-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    '<path class="ytm-speaker-cone" d="M3.5 9h3.6L12 4.8v14.4L7.1 15H3.5z"/>' +
    '<path class="ytm-wave ytm-wave-1" d="M14.4 9.6a3.4 3.4 0 0 1 0 4.8"/>' +
    '<path class="ytm-wave ytm-wave-2" d="M16.8 7.2a6.8 6.8 0 0 1 0 9.6"/>' +
    '<path class="ytm-wave ytm-wave-3" d="M19.2 4.8a10.2 10.2 0 0 1 0 14.4"/>' +
    // The cut is drawn first, in the pill's own colour and wider than the
    // slash, so the white slash reads across the white cone instead of
    // vanishing into it for its middle third.
    '<path class="ytm-speaker-slash-cut" d="M4.5 19.5 19.5 4.5"/>' +
    '<path class="ytm-speaker-slash" d="M4.5 19.5 19.5 4.5"/>' +
    '</svg>';

  function makeSpeakerButton(onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ytm-btn ytm-speaker';
    b.setAttribute('aria-label', 'Mute');
    // Static markup we author here, with no interpolation of anything from
    // the page - so there is nothing for a page value to inject into.
    b.innerHTML = SPEAKER_SVG;
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  // How many waves are lit. Thirds of the range, so the icon reads at a
  // glance rather than needing the number next to it.
  function waveCount(volume01) {
    if (volume01 <= 0) return 0;
    if (volume01 < 1 / 3) return 1;
    if (volume01 < 2 / 3) return 2;
    return 3;
  }

  function buildUi() {
    const root = document.createElement('div');
    root.className = 'ytm-controls';

    // Numeric 0-100 readout - the exact level the icon only approximates.
    const readout = document.createElement('span');
    readout.className = 'ytm-readout';
    readout.textContent = '0';

    // Wide, always-visible eased slider - replaces the native volume slider.
    const slider = createMixerSlider({
      onInput(v) {
        cancelFade(); // hand on the fader overrides an in-flight fade
        setVolume(v);
      },
      onHold: holdBarOpen,
    });
    slider.el.classList.add('ytm-slider');

    // The speaker is the mute toggle. It sits immediately left of the fader,
    // where a speaker belongs, and its waves track the volume.
    const muteBtn = makeSpeakerButton(() => {
      sendCmd({ type: 'setMuted', muted: !state.muted });
    });
    const fadeBtn = makeButton('ytm-fade', 'FADE', startFade);

    root.append(readout, muteBtn, slider.el, fadeBtn);
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
    renderVolume();
    ui.slider.setValue(state.volume);
    // The waves carry the volume and .ytm-muted does the hiding, in CSS.
    // Mute therefore never overwrites the volume the icon is showing, so
    // unmuting cannot forget to put the right number of waves back.
    ui.root.classList.toggle('ytm-muted', state.muted);
    // aria-pressed carries the state, so the label stays fixed: a label that
    // changed as well would have a screen reader announce the state twice,
    // and in words that contradict the pressed flag. title is for the mouse,
    // which lost the affordance the literal word MUTE used to give it.
    ui.muteBtn.setAttribute('aria-pressed', state.muted ? 'true' : 'false');
    ui.muteBtn.title = state.muted ? 'Unmute' : 'Mute';
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
        sendCmd({ type: 'setMuted', muted: !state.muted });
        sendResponse({ ok: true });
        break;
      case 'togglePlay':
        if (video.paused) {
          playApproved = true;
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
