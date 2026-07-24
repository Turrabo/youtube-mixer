# YouTube Mixer

Chrome extension (Manifest V3) that turns open YouTube tabs into a live audio
mixing desk for tabletop games: a wide, always-visible, eased volume slider in
every player, plus a popup that controls all open tracks at once.

Vanilla JS, no build step, no external dependencies. Store-compatible (MV3, no
remote code).

## Install (load unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder (the one with `manifest.json`).
4. Reload any YouTube tabs that were already open — content scripts only
   inject into pages loaded after install.

## What it does

In every `youtube.com/watch` player:

- The native speaker icon + hover volume slider are removed. In their place,
  inline in the bottom control bar: a **0–100 numeric readout**, a **wide
  slider** that is always expanded, a separate **MUTE** button, and a **FADE**
  button (5-second ramp to zero, driven by `requestAnimationFrame`).
- The control bar auto-hides on idle exactly as normal YouTube does; while
  visible, the mixer slider is always expanded (never hover-to-expand).
- Every video starts **paused and muted** with **looping on**, enforced against
  autoplay and re-applied when the source changes or YouTube resets `loop`.
- Everything drives the HTML5 `<video>` element directly (`volume`, `muted`,
  `loop`, `play`/`pause`) and stays in sync with the real state via the
  video's media events, so YouTube's own keyboard shortcuts etc. don't desync
  the UI. Settled volume/mute changes are also mirrored into YouTube's own
  player state via a MAIN-world bridge (`content/bridge.js`) — otherwise the
  player re-applies its page-load volume at unpredictable moments (quality,
  buffer, and ad events) and undoes your mix.

Slider feel (same in player and popup):

- **Click** anywhere on the track: volume jumps there immediately.
- **Drag** the handle: heavily damped follow — the displayed value eases
  toward the pointer each animation frame (`displayed += (target − displayed)
  × k`, time-constant ≈ 0.45 s), and the real `video.volume` follows the
  eased value. It trails the hand, smooths jitter, and settles within ~1.5 s
  of the hand stopping.

The popup (toolbar icon) lists every live YouTube watch tab — discarded
("sleeping") tabs are filtered out — with thumbnail, title, play/pause, the
same eased slider, readout, MUTE and FADE. Clicking a title/thumbnail focuses
that tab. State polls every 400 ms while the popup is open.

## Layout-shift diagnosis

The jumpiness comes from two separate causes, each fixed separately
(`content/stabilize.css`, injected at `document_start` so it applies before
first paint):

1. **Metadata-driven player resize.** YouTube sizes the player box to the
   video's aspect ratio once metadata arrives. Non-16:9 videos get a taller
   or shorter player, so the control bar (bottom-anchored to the player)
   lands at a different viewport height in every tab, and jumps at metadata
   load. Fix: lock the default-view player container to `aspect-ratio: 16/9
   !important`; the video letterboxes inside the fixed box. Theatre and
   fullscreen already use a uniform fixed-height container and are left
   alone. This is the dominant watch-page shift.
2. **Scroll offset drift.** Tabs restored or navigated in-app can settle at
   different scroll positions. Fix: the content script scrolls to the top on
   `yt-navigate-finish`.

With the player box a constant size and scroll pinned to the top, the control
bar sits at the same viewport position in every tab from load. (Note: the
extension deliberately does not hide or block any YouTube ads or promos —
doing so would breach Chrome Web Store policy.)

## Fragile YouTube selectors

YouTube's markup changes without notice. If something stops working, these
are the assumptions to re-check (all in `content/content.js`,
`content/content.css`, `content/stabilize.css`):

| Selector / hook | Used for |
| --- | --- |
| `#movie_player video.html5-main-video` (fallback `ytd-player video`) | the video element |
| `#movie_player .ytp-left-controls` | where the mixer cluster mounts |
| `.ytp-volume-area`, `.ytp-mute-button`, `.ytp-volume-panel` | native volume UI to hide / insertion point |
| `.ytp-time-display`, `.ytp-chapter-container` | re-centring native controls in the flex row |
| `yt-navigate-finish` event | SPA navigation hook |
| `ytd-watch-flexy`, `#player-container-inner`, `#player-container` | player-box aspect lock |
| `#movie_player` API: `setVolume`, `mute`, `unMute`, `isMuted` | mirroring settled volume into the player's own state (bridge) |

## Other assumptions / limitations

- Desktop `www.youtube.com` only (not `m.youtube.com` or `music.youtube.com`).
- **Autoplay-vs-human heuristic:** a `play` event is treated as human if a
  pointer gesture hit the player (or Space/K was pressed) within the last
  second, or the popup requested it; anything else is autoplay and gets
  paused. Playing via some other page element could be misread as autoplay —
  just click play again.
- **Chrome autoplay policy:** pressing play *from the popup* on a tab you have
  never clicked inside can be rejected by Chrome for unmuted media. YouTube's
  high media-engagement score usually allows it; if a tab refuses, click once
  anywhere in that tab.
- The fade is a linear volume ramp over 5 s. Pressing FADE again mid-fade
  stops the ramp, leaving the volume where it is; touching the slider (or
  setting volume from the popup) also cancels an in-flight fade.
- Loop uses `video.loop`, so tracks repeat seamlessly but playlist auto-advance
  never happens (intended for ambience use).

## Folder structure

```
manifest.json           MV3 manifest
content/
  content.js            in-player controls, enforcement, popup messaging
  bridge.js             MAIN-world bridge: mirrors settled volume/mute into
                        YouTube's player API so it can't snap the mix back
  content.css           control-bar styles + native volume UI removal
  stabilize.css         layout-shift fixes (document_start)
shared/
  slider.js             eased slider used by player and popup
  slider.css
popup/
  popup.html / .css / .js
icons/                  generated by scripts/make-icons.ps1
scripts/make-icons.ps1  icon generator (System.Drawing, run once)
```
