# Get this off Edge and off the owner's Google account

**Owner request, 2026-08-18, in their words: "I really don't want Edge having my
Google account."**

The Chrome rig is built and works. What remains needs the owner's hands: one
sign-in, and then an explicit go-ahead to delete the Edge profile.

## Settled: the local exposure is accepted

**Owner decision, 2026-08-18: accept it and sign the rig in.**

The rig binds a debug port on the profile that holds the Google session, and
anything on this machine able to reach that port can read that session. The
Edge rig had the identical property on 9333, so the move to Chrome neither
introduced nor worsened it - but it is worth saying plainly that moving the
account from Edge to Chrome does not by itself remove this, because the plan
previously implied `-SignIn` handled it. It does not: omitting the port during
sign-in is about Google's automation heuristics, not the profile's lifetime.

Weighed against a rig that never signs in at all (the tests would have to
tolerate ads instead), the owner judged the practical risk small: the port
listens on loopback only, on a single-user machine. Recorded here so it is not
re-opened every time someone notices the port.

**Do not "fix" this by removing the port.** The whole harness drives the browser
through it.

## Why it was on Edge

Chrome 137 dropped `--load-extension` from branded builds, it failed silently,
and Edge kept the flag. So the rig moved to Edge, and the owner's Google account
went with it, because the rig needs a signed-in YouTube session.

That reason has expired. Unpacked extensions load into branded Chrome again over
CDP, via `~/.claude/scripts/browser-extensions.mjs`. Canonical write-up:
`~/.claude/docs/unpacked-extensions.md`.

## Done

- **Headless Chrome accepts an unpacked extension over CDP.** Verified directly
  against `Extensions.loadUnpacked`, because the rig runs headless by default
  and headless was the part that could plausibly have refused. It does not.
- **Ledger entry `youtube-mixer-chrome`**: Chrome, port 9236, profile
  `%USERPROFILE%\.claude\state\browsers\youtube-mixer-chrome`, with an
  `extensions` list so the loader applies the extension on every launch.
- **`scripts/test-rig.ps1` rewritten for Chrome.** The extension goes in over
  CDP after launch rather than by flag. The script now polls for CDP to a
  deadline instead of sleeping a fixed five seconds (a headed launch was
  measured exceeding that), waits for a previous instance to actually exit
  before launching (Chrome's singleton would otherwise hand the launch to the
  old browser and the run would silently drive the wrong one), and **stops the
  browser on any failure** so a rig that is up but empty cannot be mistaken for
  a working one.
- **Port and profile come from the ledger.** `tests/cdp.mjs` keeps a documented
  fallback for a machine without the ledger and now says when it uses it; a
  ledger that exists but has no such reservation throws instead, because
  falling back there would drive whatever else was later given that port.
- **The extension injects on Chrome**: `.ytm-controls` and its buttons appear on
  a YouTube watch page in the Chrome rig.
- **The suite guards against ads.** See below.

## The ad guard, and the failure that produced it

On Chrome the suite failed `slider click sets volume to ~70` with 100,
deterministically. Not the extension and not Chrome's input handling: the same
press and release at the same point sets the volume correctly on its own.
Instrumenting the suite's own path found `document.elementFromPoint` at the
click target returning `ytp-visit-advertiser-link`. **A pre-roll ad was covering
the player**, so the click reached the advertiser overlay instead of the slider.

Edge passed because that profile is signed in to **YouTube Premium** and sees no
ads. The Chrome profile is signed in to nothing.

The suite now detects this and aborts with that explanation, exit 2, rather than
reporting a volume number that reads as an extension bug. Two things that guard
has to get right, both of which it did not at first:

- **It runs before every click, not once up front.** The extension forces the
  video to start paused and a pre-roll begins on PLAY, so a single check at the
  top inspects the one moment an ad cannot be showing.
- **It requires a visibly sized overlay.** YouTube leaves ad containers in the
  DOM at zero size after an ad ends, and a bare `querySelector` would abort a
  perfectly good run with a confidently wrong "not signed in to Premium".

Verified in both directions on 2026-08-18: exit 2 on the signed-out Chrome
profile, and 10 of 10 with no false positive on the Premium Edge profile.

## What is left

1. **The owner signs in:**

   ```
   & C:\Source\youtube-mixer\scripts\test-rig.ps1 -SignIn
   ```

   That opens a visible, vanilla Chrome window with no debugging port and no
   extension, and with sync disabled so a YouTube sign-in cannot offer to pull
   bookmarks, passwords and history into the rig profile. Sign in with the
   **YouTube Premium** account, confirm Premium is active, close the window.

   Nothing in this repo types a credential. This step is the owner's.

2. **Verify on Chrome**, in both modes, because the documented default is
   headless and only the suite needs a window - a session that survives one and
   not the other would otherwise be found later:

   ```
   & C:\Source\youtube-mixer\scripts\test-rig.ps1              # headless
   & C:\Source\youtube-mixer\scripts\test-rig.ps1 -Headed
   node C:\Source\youtube-mixer\tests\regression.mjs           # expect 10/10
   ```

3. **Sign the Google account out inside Edge, before anything is deleted.**
   This is the step that actually answers the request, and it is ordered before
   the deletion deliberately: it revokes the session server-side, whereas
   deleting the directory only removes the local copy. **Once the directory is
   gone, this can no longer be done from the profile at all** - the fallback is
   to revoke the device at `myaccount.google.com/device-activity`, which is
   worth knowing but is the worse path.

   Signing out of YouTube is not the same as removing an Edge *sync* identity.
   Check both, since the sync identity is arguably what "Edge having my Google
   account" means.

4. **Close Edge**, and confirm no process still holds the profile. A running
   Edge holds locks, and a delete against a locked profile half-succeeds.

5. **Then delete the profile**, and retire the ledger entry with it:

   ```
   devports remove youtube-mixer-rig -DeleteProfile
   ```

   One command keeps the two halves atomic, so the ledger never describes a
   profile that no longer exists. It also makes the step 3 sign-out ordering
   load-bearing, which is the point.

6. **Update `~/.claude/docs/unpacked-extensions.md`.** It names
   `youtube-mixer-rig` by name as the live instance of its first fallback for if
   the CDP `Extensions` domain breaks - and that domain is marked
   `experimental: true`, so it can be withdrawn without deprecation. Retiring the
   rig removes that escape hatch and leaves the doc stale. Decide whether
   something replaces it, and say so there.

## What the deletion destroys

The plan asks for this rather than assuming, and here it is. Inventoried
2026-08-18 by counting rows only; no stored value was read.

| | |
|---|---|
| Total size | 572 MB, nearly all Edge's own component and cache data |
| Saved passwords | **0** |
| Saved credit cards | **0** |
| Autofill entries | 1 |
| Cookies | 77 |
| Bookmarks | 2 KB, and a history database |

So the profile is a signed-in session and very little else. That makes the
deletion a much smaller loss than 572 MB suggests, and it is still irreversible,
which is why it stays the owner's explicit call.

## Scope worth confirming

This plan treats "Edge having my Google account" as being about the rig profile.
**Edge's own default profile was not checked.** If the account is signed into
that too, this work does not touch it, and the request is probably not satisfied
by finishing here alone.

## Done when

- The rig runs on Chrome with its extension loaded at launch, and the suite
  passes 10 of 10 there. **(Blocked only on the sign-in.)**
- The Edge profile is gone, Edge no longer holds the owner's Google account, the
  `youtube-mixer-rig` entry is retired, and `unpacked-extensions.md` no longer
  points at it.

## Worth knowing regardless

Any future test driving synthesized clicks at the player has the same ad
dependency - an overlay swallows every one of them. The guard is
`abortOnAd` in `tests/regression.mjs`; it is local to that file, so lift it into
`tests/cdp.mjs` if a second suite ever needs it.
