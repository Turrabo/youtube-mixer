// YouTube Mixer — MAIN-world bridge.
//
// The content script drives the <video> element directly, but YouTube's
// player keeps its own idea of the volume (captured at page load, persisted
// per session) and re-applies it at unpredictable moments — quality changes,
// buffering, ad transitions — snapping the real volume back. Content scripts
// run in an isolated world and can't touch the page's player object, so this
// tiny script runs in the page's MAIN world and pushes settled state from
// the content script into the player API, keeping the two in agreement.
//
// Contract: the content script dispatches 'ytm-sync-player-state' on
// document with detail = JSON string {volume: 0..1, muted: boolean}.
// (A string, because only primitives cross the isolated/main world boundary.)

(() => {
  'use strict';

  document.addEventListener('ytm-sync-player-state', (e) => {
    let state;
    try {
      state = JSON.parse(e.detail);
    } catch {
      return;
    }
    const player = document.getElementById('movie_player');
    if (!player || typeof player.setVolume !== 'function') return;
    if (typeof state.volume === 'number' && !Number.isNaN(state.volume)) {
      player.setVolume(Math.round(Math.min(1, Math.max(0, state.volume)) * 100));
    }
    if (typeof state.muted === 'boolean' &&
        typeof player.isMuted === 'function' &&
        player.isMuted() !== state.muted) {
      state.muted ? player.mute() : player.unMute();
    }
  });
})();
