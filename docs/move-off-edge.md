# The test rig runs on Chrome, not Edge

**Owner request, 2026-08-18, in their words: "I really don't want Edge having my
Google account."**

The rig is Chrome, on the ledger entry `youtube-mixer-chrome`. The Edge rig's
ledger entry, `youtube-mixer-rig`, is retired.

## Where things stand

- **Ledger entry `youtube-mixer-chrome`**: Chrome, profile
  `%USERPROFILE%\.claude\state\browsers\youtube-mixer-chrome`, no reserved
  port, and an `extensions` list the loader applies on every launch.
- **The CDP port is OS-picked.** `scripts/test-rig.ps1` deletes the profile's
  `DevToolsActivePort`, launches on `--remote-debugging-port=0`, reads the port
  Chrome publishes there, and passes it to `browser-extensions.mjs --port`.
  `tests/cdp.mjs` reads the same file, so the rig and the suite agree without a
  fixed number anywhere.
- **The rig stops the browser on any failure**, so a rig that is up but empty
  cannot be mistaken for a working one. It also waits for a previous instance
  on the profile to exit before launching, because Chrome's singleton would
  otherwise hand the launch to the old browser.
- **The Edge profile is still on disk**, at
  `%USERPROFILE%\.claude\state\youtube-mixer\test-profile`, with its Google
  session. Retiring the ledger entry did not touch it. Signing the account out
  inside Edge and then deleting the directory is the owner's call, in that
  order: a sign-out revokes the session server-side, a delete only removes the
  local copy, and once the directory is gone the fallback is revoking the device
  at `myaccount.google.com/device-activity`. Edge's own default profile was
  never checked.
- **`~/.claude/docs/unpacked-extensions.md`** no longer names this rig as the
  live instance of its Edge fallback.

## Settled: the local exposure is accepted

**Owner decision, 2026-08-18: accept it and sign the rig in.**

The rig opens a debug port on the profile that holds the Google session, and
anything on this machine able to reach that port can read that session. The
Edge rig had the identical property. `-SignIn` launches with no port, but that
is about Google's automation heuristics during sign-in, not the profile's
lifetime.

The owner judged the practical risk small: the port listens on loopback only,
on a single-user machine. Recorded here so it is not re-opened every time
someone notices the port.

**Do not "fix" this by removing the port.** The whole harness drives the browser
through it.

## Why it was ever on Edge

Chrome 137 dropped `--load-extension` from branded builds, it failed silently,
and Edge kept the flag. That reason has expired: unpacked extensions load into
branded Chrome over CDP, via `~/.claude/scripts/browser-extensions.mjs`,
headless included. Canonical write-up: `~/.claude/docs/unpacked-extensions.md`.

## The ad guard

A pre-roll ad covers the player and swallows synthesized clicks, which once
showed up as `slider click sets volume to ~70` failing with 100. The suite
detects an ad overlay before every click and aborts with exit 2 rather than
report a number that reads as an extension bug. It requires a visibly sized
overlay, because YouTube leaves zero-size ad containers in the DOM after an ad
ends.

**The Chrome profile currently trips it**: on 2026-10-20 the rig launched,
loaded the extension and answered CDP, and the suite aborted on an ad. The
profile needs signing in to the YouTube Premium account again:

```
& scripts/test-rig.ps1 -SignIn    # visible window, no port, no extension
& scripts/test-rig.ps1 -Headed    # the suite needs a real window
node tests/regression.mjs         # expect 10/10
```

Any future test driving synthesized clicks at the player has the same ad
dependency. The guard is `abortOnAd` in `tests/regression.mjs`; lift it into
`tests/cdp.mjs` if a second suite ever needs it.
