# Get this off Edge and off the owner's Google account

**Owner request, 2026-08-18, in their words: "I really don't want Edge having my
Google account."**

The Chrome rig is built and works. What remains needs the owner's own hands:
one sign-in, and then an explicit go-ahead to delete the Edge profile.

## Why it was on Edge

Chrome 137 dropped `--load-extension` from branded builds, it failed silently,
and Edge kept the flag. So the rig moved to Edge, and the owner's Google account
went with it, because the rig needs a signed-in YouTube session.

That reason has expired. Unpacked extensions load into branded Chrome again over
CDP, via `~/.claude/scripts/browser-extensions.mjs`. Canonical write-up:
`~/.claude/docs/unpacked-extensions.md`.

## Done

- **Headless Chrome accepts an unpacked extension over CDP.** Verified directly
  against `Extensions.loadUnpacked` on a throwaway profile, because the rig runs
  headless by default and headless was the part that could plausibly have
  refused. It does not refuse.
- **Ledger entry `youtube-mixer-chrome`** created with `devports new`: Chrome,
  port 9236, profile `~/.claude/state/browsers/youtube-mixer-chrome`, and an
  `extensions` list so the loader applies the extension on every launch.
- **`scripts/test-rig.ps1` rewritten for Chrome.** Same three modes. The
  extension now goes in over CDP after launch rather than by flag, and the
  script fails loudly if that step does not succeed - a rig with no extension in
  it looks exactly like a working browser, which is the whole trap.
- **Port and profile now come from the ledger** rather than being repeated in
  the script and again in `tests/cdp.mjs`. That hardcode was already failing
  `devports check`; the fix was to stop repeating the number, not to raise the
  baseline. `devports check` is now clean.
- **The extension injects on Chrome**: `.ytm-controls` and its buttons appear on
  a YouTube watch page in the Chrome rig.
- **The regression suite runs**, 9 of 10 on Chrome against 10 of 10 on Edge.

## The one failing case, and why it is not a Chrome problem

`slider click sets volume to ~70` got 100 on Chrome, deterministically, twice.

It is not the extension and not Chrome's input handling: the identical
press/release at the identical point sets the volume correctly when run on its
own. Instrumenting the suite's own path found the cause -
`document.elementFromPoint` at the click target returned
`ytp-visit-advertiser-link`. **A pre-roll ad was covering the player**, so the
click reached the advertiser overlay instead of the slider.

Edge passes because that profile is signed in to the owner's **YouTube Premium**
account and therefore sees no ads. The fresh Chrome profile is not signed in to
anything.

So the failure is a signed-out profile, which step 1 below fixes. The suite now
detects this and aborts with that explanation rather than reporting a volume
number, because "slider click sets volume to ~70 -> got 100" reads as an
extension bug and is not one. Verified both ways: it exits 2 on the signed-out
Chrome profile, and does not fire on the Premium Edge profile, which still
passes 10/10.

## What is left

1. **The owner signs in.** With the **YouTube Premium** account, which is the
   one the rig should run as.

   ```
   pwsh -NoProfile -Command "& C:\Source\youtube-mixer\scripts\test-rig.ps1 -SignIn"
   ```

   That opens a visible, vanilla Chrome window with no debugging port and no
   extension - deliberately, because Google challenges a sign-in that looks
   automated, and an open CDP port on a profile holding a Google session is a
   read primitive over that session. It is the only mode that takes keyboard
   focus. Sign in, confirm Premium is active, close the window.

   Nothing in this repo types a credential. This step is the owner's.

2. **Re-run the suite on Chrome** and confirm 10 of 10:

   ```
   pwsh -NoProfile -Command "& C:\Source\youtube-mixer\scripts\test-rig.ps1 -Headed"
   node C:\Source\youtube-mixer\tests\regression.mjs
   ```

3. **Then destroy the Edge profile**, and only then.

## The part to be careful about

Deleting a browser profile removes saved sessions and anything stored under it,
and it is not recoverable. The standing rule is verify before destructive
action, so this wants an explicit look at what
`~/.claude/state/youtube-mixer/test-profile` holds and an explicit confirmation
from the owner - not just the request above, which was made before anyone had
checked what is in there.

**Sign out of the Google account inside Edge before deleting the directory.**
That revokes the session server-side rather than only removing the local copy of
it, which is the half that actually addresses "I don't want Edge having my
account".

Retire the `youtube-mixer-rig` ledger entry at the same time
(`devports remove youtube-mixer-rig`). It still states the Chrome 137 reason as
live fact and points at the Edge profile. Do it in the same pass as the
deletion, so the ledger never describes a profile that no longer exists.

## Done when

- The rig runs on Chrome with its extension loaded automatically at launch, and
  the suite passes 10 of 10 there. **(Blocked only on the sign-in.)**
- The Edge profile is gone, Edge no longer holds the owner's Google account, and
  the `youtube-mixer-rig` entry is retired.

## Worth knowing regardless

The suite depends on an ad-free session, and now says so. Any future test that
drives synthesized clicks at the player has the same dependency - an ad overlay
swallows every one of them - so run `assertNoAd` before adding more.
