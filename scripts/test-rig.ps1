# YouTube Mixer - test rig launcher (development only; not shipped in the
# store package).
#
# Uses Edge, not Chrome: Chrome 137+ removed the --load-extension flag, so
# unpacked extensions cannot be loaded there from the command line.
#
# The profile is persistent and lives OUTSIDE the repo, at
#   ~/.claude/state/youtube-mixer/test-profile
# so a signed-in Google session can never be committed. Sign in once with
# -SignIn; every later run reuses that session.
#
# Modes:
#   .\test-rig.ps1 -SignIn    visible, vanilla Edge so a human can sign in.
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

param(
    [switch]$SignIn,
    [switch]$Headed,
    [switch]$NoExtension,
    [int]$Port = 9333
)

$ErrorActionPreference = 'Stop'

$edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path $edge)) { $edge = "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe" }
if (-not (Test-Path $edge)) { throw "Edge not found" }

$profileDir = Join-Path $env:USERPROFILE '.claude\state\youtube-mixer\test-profile'
New-Item -ItemType Directory -Force $profileDir | Out-Null

$repo = Split-Path -Parent $PSScriptRoot

# A profile can only be open in one browser instance at a time; clear any
# instance still holding this one.
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match [regex]::Escape($profileDir) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 800

if ($SignIn) {
    # Deliberately minimal: no CDP port, no extension, no automation flags.
    Start-Process $edge -ArgumentList @(
        "--user-data-dir=$profileDir",
        '--no-first-run',
        '--no-default-browser-check',
        'https://www.youtube.com'
    )
    Write-Host "Sign-in window opened (this one DOES take focus)."
    Write-Host "Profile: $profileDir"
    Write-Host "Sign in, confirm Premium, then close the window."
    exit 0
}

$edgeArgs = @(
    "--user-data-dir=$profileDir",
    "--remote-debugging-port=$Port",
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--autoplay-policy=no-user-gesture-required',
    '--lang=en-GB'
)

if (-not $NoExtension) { $edgeArgs += "--load-extension=$repo" }

if ($Headed) {
    # Off-screen so it cannot be seen or clicked, while keeping real window
    # and tab-visibility semantics.
    $edgeArgs += @('--window-position=-32000,-32000', '--window-size=1300,900')
} else {
    $edgeArgs += '--headless=new'
    $edgeArgs += '--window-size=1300,900'
}

$edgeArgs += 'about:blank'

Start-Process $edge -ArgumentList $edgeArgs
Start-Sleep -Seconds 5

try {
    $v = (Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port/json/version" -TimeoutSec 10).Content | ConvertFrom-Json
    Write-Host ("CDP up on {0} : {1}" -f $Port, $v.Browser)
    Write-Host ("mode: {0}, extension: {1}, audio: muted" -f
        $(if ($Headed) { 'headed (off-screen)' } else { 'headless' }),
        $(if ($NoExtension) { 'no' } else { 'yes' }))
} catch {
    throw "Browser did not expose CDP on port $Port"
}
