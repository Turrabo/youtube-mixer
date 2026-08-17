# Chrome Web Store listing — copy to paste

Everything below is text for the Developer Dashboard fields. Nothing here is
code; it's what you type into the listing and privacy tabs.

## Product name
YouTube Mixer

## Summary (132 chars max)
Turn open YouTube tabs into a live audio mixer: wide eased volume faders, mute, and 5-second fade-out, per tab and from one panel.

## Description
YouTube Mixer turns your open YouTube tabs into a live audio mixing desk. It was
built for tabletop role-playing games, where several ambience and music tracks
play at once and you fade between them by hand, but it suits any layered-audio
setup.

In every YouTube video player it replaces the small hover volume slider with a
wide, always-visible fader that is easy to hit fast. Dragging the fader is
heavily eased, so it feels weighted and smooths out hand jitter during a live
scene; clicking the track jumps straight to that level. Next to it sits a
numeric 0-100 readout, a mute button, and a Fade Out button that ramps the
track down to silence over five seconds (press it again to stop the fade where
it is).

Every video opens paused, muted, and set to loop, so a new tab never blasts
sound before you are ready and ambience tracks repeat on their own.

The toolbar panel lists every open YouTube video tab with a thumbnail and the
same fader, mute, and fade controls, so you can ride every track from one place
without switching tabs.

Controls drive the video directly and stay in sync with it, so YouTube's own
keyboard shortcuts and buttons never fight the extension.

## Category
Entertainment  (alternative: Productivity)

## Language
English (United Kingdom)

---

## Single purpose (required field)
YouTube Mixer provides fast volume, mute, and fade controls for YouTube video
tabs so several tracks can be mixed together for live audio use.

## Permission justification

### host_permission: https://www.youtube.com/*
Required to inject the volume and playback controls into YouTube watch pages,
to read the current title and playback state of each YouTube tab so the toolbar
panel can display and control them, and to send control messages (set volume,
mute, play/pause, fade) to those tabs. The extension only ever touches
www.youtube.com pages.

---

## Data use disclosures (Privacy tab)

The extension collects no user data. Answer the certification checkboxes:

- Personally identifiable information: No
- Health information: No
- Financial and payment information: No
- Authentication information: No
- Personal communications: No
- Location: No
- Web history: No
- User activity: No
- Website content: No

It does read the title and playback state of your open YouTube tabs, but only
in memory to show them in the panel. Nothing is stored, sent off the device, or
shared.

Certifications (tick all three):
- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

Privacy policy URL (published, paste as-is):

    https://gist.github.com/Turrabo/25053c9993e4338ec74ec4f416767d26

That gist is rendered from `store/privacy-policy.md` in this folder, which
remains the source of truth. If the policy changes, edit that file and push the
change to the same gist with `gh gist edit`, so the URL in the listing keeps
working.

---

## Screenshots (you must capture these in your browser)
At least one is required. Accepted size 1280x800 or 640x400 PNG/JPG.

Suggested shots:
1. A YouTube video with the wide fader, readout, mute and fade visible in the
   control bar.
2. The toolbar panel open over a YouTube tab, showing two or three tracks with
   thumbnails and faders.

Capture tip: set the browser window so the player region is about 1280 wide,
use the OS screenshot tool, then crop to exactly 1280x800.
