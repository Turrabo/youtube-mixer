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
4. Reload any YouTube tabs that were already open - content scripts only
   inject into pages loaded after install.

## What it does

In every `youtube.com/watch` player:

- The native speaker icon + hover volume slider are removed. In their place,
  inline in the bottom control bar: a **0–100 numeric readout**, a **wide
  slider** that is always expanded, a separate **MUTE** button, and a **FADE**
  button (5-second ramp to zero).
- The control bar auto-hides on idle exactly as normal YouTube does; while
  visible, the mixer slider is always expanded (never hover-to-expand).
- Every video starts **paused and muted** with **looping on**, enforced against
  autoplay. Keyed on the watch URL's video id, so a routine quality switch
  mid-playback is not mistaken for a new video.
- **Volume and mute go through YouTube's own player API** (`setVolume`,
  `mute`/`unMute`), never by writing `video.volume`. This is load-bearing, and
  the reasons are measured rather than assumed - see "Volume architecture"
  below. Play/pause and loop use the element directly, which YouTube does not
  fight. Because content scripts run in an isolated world and cannot reach the
  player object, all of this crosses into the page through a MAIN-world bridge
  (`content/bridge.js`), which also reports state back so the UI tracks changes
  YouTube makes itself.

Slider feel (same in player and popup):

- **Click** anywhere on the track: volume jumps there immediately.
- **Drag** the handle: heavily damped follow - the displayed value eases
  toward the pointer each animation frame (`displayed += (target − displayed)
  × k`, time-constant ≈ 0.45 s), and the real volume follows the eased value.
  It trails the hand, smooths jitter, and settles within ~1.5 s of the hand
  stopping. The easing never travels past the point where you released.

The popup (toolbar icon) lists every live YouTube watch tab - discarded
("sleeping") tabs are filtered out - with thumbnail, title, play/pause, the
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
extension deliberately does not hide or block any YouTube ads or promos -
doing so would breach Chrome Web Store policy.)

## Checking it still works

```
.\scripts\test-rig.ps1 -Headed
node tests/regression.mjs
```

That is the gate for this extension. It carries one case per bug that ever
reached a user, drives a real browser with real mouse input, and exits non-zero
on failure. `-Headed` is required (the fade case disables
`requestAnimationFrame`, and the suite needs real mouse events); the window is
parked off-screen and the audio is muted, so it neither appears nor makes a
sound.

It runs against a deliberately loud, loudness-normalised track. On a quiet track
YouTube's normalisation factor is 1.0 and the volume bugs below are invisible,
so a suite that used one would pass while broken.

Sign in once first, so tests are not disrupted by preroll ads:
`scripts/test-rig.ps1 -SignIn`.

## Releasing to the store

**Bump `version` in `manifest.json` before packaging.** The Chrome Web Store
refuses any upload whose version is not strictly greater than the published
one. This has already cost a release: the store served 1.0.2 from 31 July 2026,
and the volume-ratchet and fade fixes were built on 17 August under that *same*
version number, so the fixed build could not be uploaded at all - the store had
1.0.2 already. The fixes sat unshippable until the bump to 1.0.3. Check the
live version before assuming an upload will be accepted.

Then:

```
.\scripts\package.ps1
```

It reads the version from `manifest.json`, so the filename can never disagree
with the contents, and writes `youtube-mixer-v<version>.zip` in the repo root.
It refuses to overwrite an existing zip of the same version unless you pass
`-Force`, because silently replacing one is how an uploaded artifact stops
matching the one that was tested.

What ships is an **allowlist** - `manifest.json` plus `content/`, `icons/`,
`popup/`, `shared/` - not an exclusion list, so a new file added to the repo
later stays out of the package by default rather than shipping because nobody
remembered to exclude it. `README.md`, `store/`, `tests/` and `scripts/` are
therefore never in the zip.

The item id, publisher id and dashboard URL are recorded in this machine's
store-publisher config (`~/.claude/state/store-publisher/config.json`), which is
their canonical home; they are deliberately not restated here. Visibility is
Private (named trusted testers), set on the dashboard and inherited by every
update - an update cannot widen the audience.

## Volume architecture (why it does not touch `video.volume`)

The obvious implementation - set `video.volume` on the HTML5 element - is
wrong, in two ways that only show up minutes into real use. Both were measured
in a scripted browser, not guessed:

YouTube's player holds its own user-volume value (0–100) and writes the
element's volume itself, applying **per-video loudness normalisation** as it
goes:

```
video.volume = userVolume / 100 × normFactor
```

Measured `normFactor`: 1.0 on two quiet tracks, 0.60 on a loud orchestral one.
So `video.volume` is not the user's volume, and the player considers itself the
owner of that property. Hence:

1. **Writes get wiped.** Setting `video.volume` directly holds only until the
   player next rebuilds its state - a quality or stream-format switch during
   playback. It then re-applies its own value, undoing your setting at a moment
   that feels random. Confirmed: a directly-written `0.64` survived 8 s of
   playback, then snapped to `0.3` the instant a quality change landed.
2. **Reads ratchet.** Reading `video.volume` back and re-applying it as if it
   were user volume multiplies by `normFactor` every cycle. With a 0.8166
   factor: `0.64 → 0.52 → 0.42 → 0.34 …`, decaying geometrically and settling
   at **2**, where integer rounding becomes a fixed point (push 2 → 0.0163 →
   rounds back to 2).

The fix is to make the player API the single source of truth: `setVolume` and
`getVolume` for volume, `mute`/`unMute`/`isMuted` for mute, and nothing writing
`video.volume` at all. The stored state then always agrees with what you chose,
so a state rebuild re-applies *your* value, and no read-back loop exists.

The 0–100 readout shows the **user volume** (what `getVolume` returns), not
`video.volume × 100`. On a loudness-normalised track those differ: 70 on the
readout is `0.42` on the element, and 70 is the honest number.

Loudness normalisation is left switched on deliberately, since it is what
YouTube users expect and it keeps layered tracks roughly balanced.

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
| `#movie_player` API: `getVolume`, `setVolume`, `mute`, `unMute`, `isMuted`, `playVideo`, `pauseVideo` | all volume/mute control and state, via the bridge. If these disappear the bridge falls back to the raw element, which works but brings the snap-back back |

## Other assumptions / limitations

- Desktop `www.youtube.com` only (not `m.youtube.com` or `music.youtube.com`).
- **Autoplay-vs-human heuristic:** a `play` event is treated as human if a
  pointer gesture hit the player (or Space/K was pressed) within the last
  second, or the popup requested it; anything else is autoplay and gets
  paused. Playing via some other page element could be misread as autoplay -
  just click play again.
- **Chrome autoplay policy:** pressing play *from the popup* on a tab you have
  never clicked inside can be rejected by Chrome for unmuted media. YouTube's
  high media-engagement score usually allows it; if a tab refuses, click once
  anywhere in that tab.
- The fade is a linear volume ramp over 5 s. Pressing FADE again mid-fade
  stops the ramp, leaving the volume where it is; touching the slider (or
  setting volume from the popup) also cancels an in-flight fade.
- The fade is driven by a **wall-clock timer, not `requestAnimationFrame`**.
  Chrome pauses rAF completely in hidden tabs, which froze a fade the moment
  you switched tabs. Each tick recomputes from elapsed time rather than
  accumulating, so the ramp still ends at exactly 5 s even if the browser
  throttles the tick rate in the background; worst case it steps slightly
  instead of stopping dead. The slider easing still uses rAF, which is correct
  - you can only drag a slider you can see.
- Loop uses `video.loop`, so tracks repeat seamlessly but playlist auto-advance
  never happens (intended for ambience use).

## Folder structure

```
manifest.json           MV3 manifest
content/
  content.js            in-player controls, enforcement, popup messaging
  bridge.js             MAIN-world bridge: owns all volume/mute via YouTube's
                        player API, and reports state back to content.js
  content.css           control-bar styles + native volume UI removal
  stabilize.css         layout-shift fixes (document_start)
shared/
  slider.js             eased slider used by player and popup
  slider.css
popup/
  popup.html / .css / .js
icons/                  generated by scripts/make-icons.ps1
tests/
  regression.mjs        one case per bug that reached a user; drives a real
                        browser with real mouse input
  cdp.mjs               dependency-free DevTools Protocol client
scripts/
  package.ps1           builds the store zip from an allowlist; version comes
                        from manifest.json
  make-icons.ps1        icon generator (System.Drawing, run once)
  test-rig.ps1          dev-only: launches Chrome headless + muted with the
                        extension loaded and a CDP port, on a persistent
                        signed-in profile. `-SignIn` once to authenticate,
                        `-Headed` for tests needing a real window. Port and
                        profile come from the machine-wide devports ledger
                        entry `youtube-mixer-chrome`.
```
