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
#   .\test-rig.ps1 -Headed    same, but a real window parked off-screen.
#                             Needed only for tests that depend on genuine
#                             tab visibility (background-tab behaviour).
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

# A profile can only be open in one browser instance at a time; clear any
# instance still holding this one.
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match [regex]::Escape($profileDir) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 800

if ($SignIn) {
    # Deliberately minimal: no CDP port, no extension, no automation flags.
    # Google challenges a sign-in that looks automated, and an open CDP port on
    # a profile holding a Google session is a read primitive over that session.
    Start-Process $chrome -ArgumentList @(
        "--user-data-dir=$profileDir",
        '--no-first-run',
        '--no-default-browser-check',
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
Start-Sleep -Seconds 5

try {
    $v = (Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$port/json/version" -TimeoutSec 10).Content | ConvertFrom-Json
    Write-Host ("CDP up on {0} : {1}" -f $port, $v.Browser)
} catch {
    throw "Chrome did not expose CDP on port $port"
}

$extensionLoaded = 'skipped'
if (-not $NoExtension) {
    # browser-extensions.mjs reads the port and the extension paths off the same
    # ledger entry, so nothing here repeats either. It reports a failure by exit
    # code; a rig with no extension in it looks exactly like a working browser,
    # which is the failure this check exists to catch.
    $loader = Join-Path $env:USERPROFILE '.claude\scripts\browser-extensions.mjs'
    $prevNative = $PSNativeCommandUseErrorActionPreference
    $prevEap = $ErrorActionPreference
    $PSNativeCommandUseErrorActionPreference = $false
    $ErrorActionPreference = 'Continue'
    try {
        $out = & node $loader load $ledgerName 2>&1
        $rc = $LASTEXITCODE
    } finally {
        $PSNativeCommandUseErrorActionPreference = $prevNative
        $ErrorActionPreference = $prevEap
    }
    $out | ForEach-Object { Write-Host "  $_" }
    if ($rc -ne 0) {
        throw "Extension did not load (browser-extensions.mjs exit $rc). The browser is up but EMPTY - do not treat a passing test as meaningful."
    }
    $extensionLoaded = 'yes'
}

Write-Host ("mode: {0}, extension: {1}, audio: muted" -f
    $(if ($Headed) { 'headed (off-screen)' } else { 'headless' }),
    $extensionLoaded)
