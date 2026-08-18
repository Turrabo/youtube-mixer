# Get this off Edge and off the owner's Google account

**Owner request, 2026-08-18, in their words: "I really don't want Edge having my
Google account."** Not yet started - recorded here so it does not depend on one
session's memory.

## Why it is on Edge at all

The port ledger entry for `youtube-mixer-rig` says it plainly:

> Extension test rig. Edge, not Chrome: Chrome 137+ removed --load-extension.

That was a correct workaround at the time. Chrome 137 dropped
`--load-extension` from branded builds, it failed silently, and Edge kept the
flag. So the rig moved to Edge, and the owner's Google account went with it
because the rig needs a signed in YouTube session.

**That reason has expired.** Unpacked extensions load into branded Chrome again,
over CDP, via `~/.claude/scripts/browser-extensions.mjs`. The canonical write up
is `~/.claude/docs/unpacked-extensions.md`. So the rig can come home to Chrome,
which removes the only reason Edge holds the account.

## What the work is

1. **Find out what the rig actually needs from the profile** before destroying
   anything. At minimum: a signed in YouTube session. Establish whether it also
   depends on anything else in that profile - saved state, an extension loaded
   by hand, cookies for a second service.
2. **Create a Chrome profile for it** and give it a ledger entry, with an
   `extensions` list pointing at the rig's build output so the loader applies it
   on every launch. Reuse the `roll20-dev` entry as the shape.
3. **The owner signs in.** With their **YouTube Premium** account, which is the
   one they want the rig running as. Signing in is theirs to do; nothing here
   types a credential.
4. **Verify the rig works on Chrome** before anything is deleted. A rig that is
   broken on Chrome and deleted on Edge leaves nothing working.
5. **Then destroy the Edge profile.** Only then, and only after confirming what
   else may live in it.

## The part to be careful about

Deleting a browser profile removes saved sessions and anything stored under it,
and it is not recoverable. The standing rule is verify before destructive
action, so step 5 wants an explicit look at what the directory holds and an
explicit confirmation from the owner - not just the request above, which was
made before anyone had checked what is in there.

Signing out of the Google account inside Edge before deleting the directory is
worth doing regardless: it revokes the session server side rather than only
removing the local copy of it.

## Done when

- The rig runs on Chrome, with its extension loaded automatically at launch.
- The ledger entry describes it, and the stale `youtube-mixer-rig` Edge entry is
  either updated or retired - it currently states the Chrome 137 reason as live
  fact, which it no longer is.
- The Edge profile is gone, and Edge no longer holds the owner's Google account.
