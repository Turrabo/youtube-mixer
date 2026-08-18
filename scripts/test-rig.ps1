# YouTube Mixer - test rig launcher (development only; not shipped in the
# store package).
#
# Chrome, on the ledger entry 'youtube-mixer-chrome'.
#
# This rig used to run on Edge, because Chrome 137 removed the --load-extension
# flag and Edge kept it. That reason expired: unpacked extensions load into
# branded Chrome again over CDP, via the machine-wide
# ~/.claude/scripts/browser-extensions.mjs. Headless Chrome was verified to
# accept one that way on 2026-08-18. Canonical write-up of the mechanism:
# ~/.claude/docs/unpacked-extensions.md.
#
# The profile is persistent and lives OUTSIDE the repo, so a signed-in Google
# session can never be committed. Sign in once with -SignIn; every later run
# reuses that session.
#
# Modes:
#   .\test-rig.ps1 -SignIn    visible, vanilla Chrome so a human can sign in.
#                             No debugging port and no extension, so Google
#                             does not flag it as an insecure/automated
#                             browser. This is the ONLY mode that takes
#                             keyboard focus.
#   .\test-rig.ps1            headless + muted + extension + CDP port.
#                             No window exists, so nothing can steal focus.
#   .\test-rig.ps1 -Headed    same, but a real window parked off-screen. The
#                             regression suite needs this: its fade case
#                             disables requestAnimationFrame and it drives real
#                             mouse events. Off-screen is not the same as
#                             focus-safe - the window is real and Chrome may
#                             still activate it briefly on launch.
#   -NoExtension              launch the browser without loading the extension.
#                             For establishing a baseline, or checking whether
#                             a symptom is the extension's at all.
#
# Audio: --mute-audio silences the speakers at the browser output level.
# video.volume, video.muted and all media events stay fully live, so
# measurements are unaffected. A muted tab also counts as non-audible, so
# background timer throttling applies - tests run against the worst case.
#
# The extension does NOT survive a browser restart, because a CDP-loaded
# extension is not re-activated on the next launch. That is why the load step
# below runs unconditionally on every run rather than only on first use.

param(
    [switch]$SignIn,
    [switch]$Headed,
    [switch]$NoExtension
)

$ErrorActionPreference = 'Stop'

$devports = Join-Path $env:USERPROFILE '.claude\scripts\devports.ps1'
$ledgerName = 'youtube-mixer-chrome'

# Port and profile have ONE home, the machine-wide ledger. Reading them here
# rather than repeating them keeps `devports check` able to prove it, and that
# gate fails on a bare port literal at a bind site.
$port = [int](& $devports port $ledgerName)
$profileDir = (& $devports profile $ledgerName)
if (-not $port -or -not $profileDir) {
    throw "Ledger entry '$ledgerName' has no port or profile. Run: devports new $ledgerName -Engine chrome -Owner youtube-mixer"
}

$chrome = "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) { throw "Chrome not found at $chrome" }

New-Item -ItemType Directory -Force $profileDir | Out-Null

# A profile can only be open in one browser instance at a time. If an old
# instance survives, Chrome's singleton hands our URL to IT and exits, so the
# probe below passes against the previous run's browser - a -Headed launch can
# report "headed" while driving the headless one. So confirm the processes are
# actually gone rather than sleeping and hoping.
#
# Matches on the --user-data-dir token, not a bare path substring, so a sibling
# profile whose name merely starts with this one is not killed too.
function Get-RigProcesses {
    Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -match ("--user-data-dir=""?" + [regex]::Escape($profileDir) + '(""|\s|$)') }
}

Get-RigProcesses | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
$deadline = (Get-Date).AddSeconds(15)
while ((Get-RigProcesses | Measure-Object).Count -gt 0 -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 250
}
if ((Get-RigProcesses | Measure-Object).Count -gt 0) {
    throw "A previous rig instance on this profile would not exit. Chrome's singleton would hand this launch to it, so the run would silently drive the old browser. Close it and retry."
}

if ($SignIn) {
    # Deliberately minimal: no CDP port, no extension, no automation flags.
    # Google challenges a sign-in that looks automated, and an open CDP port on
    # a profile holding a Google session is a read primitive over that session.
    # --disable-sync matters MORE here than in the automated modes, not less:
    # this is the one mode where a Google account is entered, so it is the one
    # mode where Chrome can offer to turn Sync on and pull the owner's
    # bookmarks, passwords and history into the rig profile. Adding the flag
    # later does not remove what already synced.
    Start-Process $chrome -ArgumentList @(
        "--user-data-dir=$profileDir",
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-sync',
        'https://www.youtube.com'
    )
    Write-Host "Sign-in window opened (this one DOES take focus)."
    Write-Host "Profile: $profileDir"
    Write-Host "Sign in with the YouTube Premium account, confirm Premium, then close the window."
    exit 0
}

$chromeArgs = @(
    "--user-data-dir=$profileDir",
    "--remote-debugging-port=$port",
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--autoplay-policy=no-user-gesture-required',
    '--lang=en-GB'
)

if ($Headed) {
    # Off-screen so it cannot be seen or clicked, while keeping real window
    # and tab-visibility semantics.
    $chromeArgs += @('--window-position=-32000,-32000', '--window-size=1300,900')
} else {
    $chromeArgs += '--headless=new'
    $chromeArgs += '--window-size=1300,900'
}

$chromeArgs += 'about:blank'

Start-Process $chrome -ArgumentList $chromeArgs -WindowStyle Hidden

# Poll to a deadline rather than sleeping a fixed guess. -TimeoutSec does not
# help before the browser is listening: the TCP connect is REFUSED immediately,
# so Invoke-WebRequest throws at once and a fixed sleep is the entire wait. A
# headed launch on this machine was measured taking longer than 5 seconds, so
# the old 5-second sleep was a flake waiting to happen.
$v = $null
$deadline = (Get-Date).AddSeconds(45)
while ((Get-Date) -lt $deadline) {
    try {
        $v = (Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$port/json/version" -TimeoutSec 5).Content | ConvertFrom-Json
        break
    } catch {
        Start-Sleep -Milliseconds 500
    }
}
if (-not $v) {
    Get-RigProcesses | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    throw "Chrome did not expose CDP on port $port within 45s. Browser stopped so it cannot be mistaken for a working rig."
}
Write-Host ("CDP up on {0} : {1}" -f $port, $v.Browser)

$extensionLoaded = 'skipped'
if (-not $NoExtension) {
    # browser-extensions.mjs reads the port and the extension paths off the same
    # ledger entry, so nothing here repeats either. It reports a failure by exit
    # code; a rig with no extension in it looks exactly like a working browser,
    # which is the failure this check exists to catch.
    $loader = Join-Path $env:USERPROFILE '.claude\scripts\browser-extensions.mjs'
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Get-RigProcesses | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        throw "node is not on PATH, so the extension cannot be loaded. Browser stopped rather than left running and empty."
    }
    if (-not (Test-Path $loader)) {
        Get-RigProcesses | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        throw "Loader not found at $loader. See ~/.claude/docs/unpacked-extensions.md."
    }

    # --wait exists for exactly this caller: the browser was launched moments
    # ago and its Extensions domain may not be answering yet.
    $prevNative = $PSNativeCommandUseErrorActionPreference
    $prevEap = $ErrorActionPreference
    $PSNativeCommandUseErrorActionPreference = $false
    $ErrorActionPreference = 'Continue'
    $rc = $null
    try {
        $out = & node $loader load $ledgerName --wait 20 2>&1
        $rc = $LASTEXITCODE
    } finally {
        $PSNativeCommandUseErrorActionPreference = $prevNative
        $ErrorActionPreference = $prevEap
    }
    $out | ForEach-Object { Write-Host "  $_" }

    # A null $rc means the call never ran, in which case $LASTEXITCODE would
    # still hold 0 from the devports calls above and an empty browser would
    # report as a working rig.
    if ($null -eq $rc -or $rc -ne 0) {
        Get-RigProcesses | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        throw "Extension did not load (browser-extensions.mjs exit $rc). Browser stopped: a rig that is up but EMPTY looks exactly like a working one, and a passing test against it would mean nothing."
    }
    $extensionLoaded = 'yes'
}

Write-Host ("mode: {0}, extension: {1}, audio: muted" -f
    $(if ($Headed) { 'headed (off-screen)' } else { 'headless' }),
    $extensionLoaded)
