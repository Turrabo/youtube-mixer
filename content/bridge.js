// YouTube Mixer - MAIN-world bridge.
//
// WHY THIS EXISTS (measured, not assumed):
//
// YouTube's player keeps its own user-volume value (0-100) and writes the
// <video> element's volume itself, applying per-video loudness normalisation
// on the way:  video.volume = userVolume/100 * normFactor.  Measured factors
// ranged from 1.0 on quiet tracks to 0.60 on a loud orchestral one.
//
// Two consequences, both confirmed in the browser:
//   1. Writing video.volume directly only holds until the player next
//      rebuilds its state (a quality or format switch mid-playback). It then
//      re-applies its own value and wipes the user's setting - the
//      "snaps back at a random moment" bug.
//   2. video.volume is NOT the user's volume. Reading it back and re-applying
//      it as if it were multiplies by normFactor every cycle, decaying the
//      volume geometrically until integer rounding pins it near 2 - the
//      "slowly drags itself down" bug.
//
// So: the player API is the single source of truth for volume and mute, and
// nothing writes video.volume directly. Content scripts run in an isolated
// world and cannot reach the player object, so this script runs in the MAIN
// world and relays commands and state across the boundary using DOM events
// with JSON string payloads (only primitives cross reliably).
//
// Protocol
//   in :  'ytm-cmd'   detail = {"type":"setVolume","value":0..1}
//                            | {"type":"setMuted","muted":bool}
//                            | {"type":"play"} | {"type":"pause"}
//   out:  'ytm-state' detail = {"volume":0..1,"muted":bool,"paused":bool,
//                               "api":bool}
//         where volume is USER volume, not the normalised element value.

(() => {
  'use strict';

  const player = () => document.getElementById('movie_player');
  const media = () => document.querySelector('#movie_player video');
  const hasApi = (p) =>
    !!p && typeof p.getVolume === 'function' && typeof p.setVolume === 'function';

  function readState() {
    const p = player();
    const v = media();
    if (!v) return null;
    if (hasApi(p)) {
      return {
        volume: Math.min(1, Math.max(0, p.getVolume() / 100)),
        muted: typeof p.isMuted === 'function' ? p.isMuted() : v.muted,
        paused: v.paused,
        api: true,
      };
    }
    // No player API (YouTube markup change): degrade to the raw element
    // rather than breaking outright. The snap-back returns, but controls work.
    return { volume: v.volume, muted: v.muted, paused: v.paused, api: false };
  }

  let lastJson = '';
  function report(force) {
    const state = readState();
    if (!state) return;
    const json = JSON.stringify(state);
    if (!force && json === lastJson) return;
    lastJson = json;
    document.dispatchEvent(new CustomEvent('ytm-state', { detail: json }));
  }

  document.addEventListener('ytm-cmd', (e) => {
    let cmd;
    try {
      cmd = JSON.parse(e.detail);
    } catch {
      return;
    }
    const p = player();
    const v = media();
    if (!v) return;

    switch (cmd.type) {
      case 'setVolume': {
        const pct = Math.round(Math.min(1, Math.max(0, cmd.value)) * 100);
        if (hasApi(p)) {
          p.setVolume(pct);
        } else {
          v.volume = pct / 100;
        }
        break;
      }
      case 'setMuted':
        if (hasApi(p) && typeof p.mute === 'function' && typeof p.unMute === 'function') {
          cmd.muted ? p.mute() : p.unMute();
        } else {
          v.muted = !!cmd.muted;
        }
        break;
      case 'play':
        if (p && typeof p.playVideo === 'function') p.playVideo();
        else v.play().catch(() => {});
        break;
      case 'pause':
        if (p && typeof p.pauseVideo === 'function') p.pauseVideo();
        else v.pause();
        break;
      default:
        return;
    }
    report(true);
  });

  // Poll rather than bind listeners to a <video> that YouTube swaps out: two
  // property reads on a 250 ms tick, deduplicated so only real changes cross
  // the boundary. This is what keeps the UI honest when YouTube changes
  // volume itself (its own slider, keyboard shortcuts, a state rebuild).
  setInterval(() => report(false), 250);
  report(true);
})();
