// YouTube Mixer - regression suite.
//
// One case per bug that reached the user, exercised in a real browser through
// real synthesized mouse input, because every one of these bugs lived in the
// interaction between the extension and YouTube's live player. Nothing below
// can be caught by a unit test.
//
// Run:
//     pwsh -NoProfile -Command "& scripts/test-rig.ps1 -Headed"
//     node tests/regression.mjs
//
// -Headed is required: the fade case disables requestAnimationFrame, and the
// suite drives real mouse events, so it needs a real (off-screen) window.
// Exits non-zero if any case fails.
//
// Deliberately run against a LOUDNESS-NORMALISED track (loud orchestral), where
// video.volume and the user's volume genuinely differ. On a quiet track the
// normalisation factor is 1.0 and the volume bugs below are invisible.

import { newTab, connect, evalIn, waitFor, sleep, closeTab, rejectConsent } from './cdp.mjs';

const SEARCH = 'epic orchestral battle music';

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? '  -> ' + detail : ''}`);
};

const t = await newTab('https://www.youtube.com/results?search_query=' + encodeURIComponent(SEARCH));
const s = await connect(t.webSocketDebuggerUrl);
await s.send('Emulation.setDeviceMetricsOverride',
  { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

await rejectConsent(s);
await waitFor(s, `!!document.querySelector('a#video-title[href*="/watch"]')`, 45000);
const href = await evalIn(s, `document.querySelector('a#video-title[href*="/watch"]').getAttribute('href')`);
await s.send('Page.navigate', { url: 'https://www.youtube.com' + href.split('&')[0] });
await waitFor(s, `!!document.querySelector('#movie_player .ytm-controls .mixer-slider')`, 45000);
await sleep(4000);
await rejectConsent(s);

// The suite silently depends on an ad-free session. A pre-roll ad draws a
// full-bleed clickable overlay across the player, so every synthesized click
// below lands on ytp-visit-advertiser-link instead of the control it names -
// and the suite then reports "slider click sets volume to ~70 -> got 100",
// which reads as an extension bug and is not one.
//
// That is not hypothetical: it is exactly what a fresh Chrome profile did on
// 2026-08-18, while the Premium-signed-in Edge profile passed 10/10 on the
// same build. Fail loudly and name the cause instead.
//
// Two things this gets wrong if done naively, both found in review:
//
//   Checking once, up front, checks the ONE moment an ad cannot be showing.
//   The extension forces the video to start paused, and a pre-roll begins on
//   PLAY - which this suite does not do until well after such a check. So the
//   guard runs inside click(), immediately before each click it protects.
//
//   Bare querySelector false-positives. YouTube leaves ad containers in the
//   DOM at zero size after an ad ends, and a hidden leftover would abort the
//   run with a confidently wrong "not signed in to Premium". Only a box with
//   real area counts. The ad-showing class is reliable on its own and is
//   checked separately.
async function adState() {
  return evalIn(s, `(() => {
    const p = document.getElementById('movie_player');
    const visible = [...document.querySelectorAll(
      '.ytp-ad-player-overlay, .ytp-ad-player-overlay-layout, .ytp-visit-advertiser-link')]
      .some(el => { const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1; });
    return { showing: !!(p && p.classList.contains('ad-showing')), overlay: visible };
  })()`);
}

async function abortOnAd(where) {
  const ad = await adState();
  if (!ad.showing && !ad.overlay) return;
  console.error(
    `\nABORT: an ad is covering the player (before ${where}), so the click would not reach its target.\n` +
    '  This profile is not signed in to a YouTube Premium account.\n' +
    '  Sign in once:  & scripts\\test-rig.ps1 -SignIn\n' +
    '  then re-run the rig and this suite.',
  );
  await die(2);
}

// process.exit and thrown errors both bypass the teardown at the end of the
// file, which leaves an orphan tab in the persistent rig profile on every
// aborted run. Route both through here.
//
// Closing the socket and calling process.exit in the same tick aborts the
// process inside libuv ("!(handle->flags & UV_HANDLE_CLOSING)"), which turns a
// deliberate exit 2 into a crash exit 127 - so the caller sees a broken suite
// rather than the reason it stopped. Let the close settle before exiting.
let cleanedUp = false;
async function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  // Mute is persisted per profile by YouTube, and nothing forces it on load
  // any more, so a run that dies between the two speaker clicks below would
  // leave the rig profile muted and fail 'starts unmuted' on every later run
  // for a reason that is not the extension's.
  // Raced against a timer because this runs on the abort path too, where the
  // socket may already be dead and a bare await would hang the exit.
  try {
    await Promise.race([
      evalIn(s, `document.getElementById('movie_player').unMute(); 1`),
      sleep(2000),
    ]);
  } catch { /* no player, or the browser is already gone */ }
  try { await closeTab(t.id); } catch { /* browser already gone */ }
  try { s.close(); } catch { /* already closed */ }
  await sleep(250);
}
async function die(code) {
  await cleanup();
  process.exit(code);
}
process.on('uncaughtException', async (e) => { console.error(e); await die(1); });

await abortOnAd('the suite starts');

async function click(selector, fraction) {
  await abortOnAd(selector);
  const box = await evalIn(s, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  })()`);
  if (!box) throw new Error('missing element: ' + selector);
  const x = Math.round(box.x + (fraction === undefined ? box.w / 2 : box.w * fraction));
  const y = Math.round(box.y + box.h / 2);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await s.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  }
  await sleep(500);
}

// Press on the fader and creep across it, the way a hand does when it is
// setting a level carefully, holding the button down throughout.
async function slowDrag(fromFraction, toFraction, seconds, onEachStep) {
  await abortOnAd('slow drag');
  const box = await evalIn(s, `(() => {
    const r = document.querySelector('.ytm-controls .mixer-slider').getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  })()`);
  const y = Math.round(box.y + box.h / 2);
  const at = (f) => Math.round(box.x + box.w * f);
  const steps = seconds * 2; // one small move every 500 ms
  await s.send('Input.dispatchMouseEvent',
    { type: 'mousePressed', x: at(fromFraction), y, button: 'left', clickCount: 1 });
  for (let i = 1; i <= steps; i++) {
    await sleep(500);
    const f = fromFraction + (toFraction - fromFraction) * (i / steps);
    await s.send('Input.dispatchMouseEvent',
      { type: 'mouseMoved', x: at(f), y, button: 'left', buttons: 1 });
    if (onEachStep) await onEachStep(i);
  }
  await s.send('Input.dispatchMouseEvent',
    { type: 'mouseReleased', x: at(toFraction), y, button: 'left', clickCount: 1 });
  await sleep(500);
}

const snap = async () => evalIn(s, `(() => {
  const p = document.getElementById('movie_player');
  const v = document.querySelector('#movie_player video');
  const spk = document.querySelector('.ytm-controls .ytm-speaker');
  const lit = (sel) => +getComputedStyle(spk.querySelector(sel)).opacity > 0.01;
  return {
    waves: +spk.dataset.waves,
    // Read what is actually PAINTED, not the class: the count and the muted
    // state are decided in two different places and CSS resolves them, so a
    // check on the count alone would not notice mute failing to hide them.
    litWaves: [lit('.ytm-wave-1'), lit('.ytm-wave-2'), lit('.ytm-wave-3')]
      .filter(Boolean).length,
    slash: lit('.ytm-speaker-slash'),
    autohide: p.classList.contains('ytp-autohide'),
    readout: +document.querySelector('.ytm-readout').textContent,
    getVolume: p.getVolume(),
    videoVolume: +v.volume.toFixed(4),
    muted: p.isMuted(),
    paused: v.paused,
    loop: v.loop,
  };
})()`);

// --- start state -----------------------------------------------------------
// A new video opens paused and looping, and NOT muted: the extension used to
// force mute on load and re-assert it for six seconds, which cost one unmute
// per tab in a session that opens many. "Starts paused" is what guarantees
// silence, so the mute added nothing but work.
console.log('\n--- start state ---');
const start = await snap();
check('starts paused', start.paused === true);
check('starts unmuted', start.muted === false, `muted=${start.muted}`);
check('starts looping', start.loop === true);

// Regression: our own cluster mounts inside #movie_player and the gesture
// listener is capture-phase, so a press on the fader used to register as a
// human play request and sanction any autoplay that followed within a second.
// That was inaudible while the extension force-muted on load; without the
// mute it is a tab that starts playing out loud on its own. The rig runs with
// --autoplay-policy=no-user-gesture-required, so an unsanctioned play here
// really would start.
await click('.ytm-controls .mixer-slider', 0.40);
await evalIn(s, `document.querySelector('#movie_player video').play().catch(() => {}); 1`);
await sleep(1500);
const afterFaderTouch = await snap();
check('touching the fader does not sanction an autoplay',
  afterFaderTouch.paused === true, `paused=${afterFaderTouch.paused}`);

// --- volume is the user's volume, not the element's ------------------------
// Regression: the readout showed video.volume * 100, which on a normalised
// track is not the number the user set.
console.log('\n--- volume control ---');
await click('.ytm-controls .mixer-slider', 0.70);
const afterSlide = await snap();
check('slider click sets volume to ~70', Math.abs(afterSlide.getVolume - 70) <= 2,
  'got ' + afterSlide.getVolume);
check('readout shows user volume, not the normalised element value',
  afterSlide.readout === afterSlide.getVolume && afterSlide.videoVolume !== afterSlide.getVolume / 100,
  `readout=${afterSlide.readout} getVolume=${afterSlide.getVolume} video.volume=${afterSlide.videoVolume}`);

// --- the speaker icon ------------------------------------------------------
// Three waves, lit a third of the range at a time, so the icon reads the
// volume at a glance. Volume is ~70 here, which is the top third.
console.log('\n--- speaker icon ---');
check('all three waves lit at volume 70', afterSlide.waves === 3 && afterSlide.litWaves === 3,
  `waves=${afterSlide.waves} lit=${afterSlide.litWaves}`);
check('no slash while unmuted', afterSlide.slash === false);

await click('.ytm-controls .mixer-slider', 0.15);
const quiet = await snap();
check('one wave lit at a low volume',
  quiet.litWaves === 1, `volume=${quiet.getVolume} lit=${quiet.litWaves}`);

await click('.ytm-controls .mixer-slider', 0.50);
const half = await snap();
check('two waves lit at half volume',
  half.litWaves === 2, `volume=${half.getVolume} lit=${half.litWaves}`);

// The speaker is the mute toggle, and with nothing forcing mute on load the
// only way it can be on is because it was pressed.
await click('.ytm-controls .ytm-speaker');
const muted = await snap();
check('the speaker mutes', muted.muted === true, `muted=${muted.muted}`);
check('muting hides every wave and shows the slash',
  muted.litWaves === 0 && muted.slash === true,
  `lit=${muted.litWaves} slash=${muted.slash}`);
// Mute must not have moved the volume: the waves the icon goes back to are
// the ones it had, which is only true if mute never touched the count.
check('mute leaves the volume, and the wave count, alone',
  muted.getVolume === half.getVolume && muted.waves === half.waves,
  `volume=${muted.getVolume} waves=${muted.waves}`);

await click('.ytm-controls .ytm-speaker');
const unmuted = await snap();
check('unmuting restores exactly the waves it hid',
  unmuted.litWaves === half.litWaves && unmuted.slash === false,
  `lit=${unmuted.litWaves} slash=${unmuted.slash}`);

await click('.ytm-controls .mixer-slider', 0.70);
await click('#movie_player .ytp-play-button');
await sleep(2500);
const playing = await snap();
check('plays, unmuted', playing.muted === false && playing.paused === false,
  `muted=${playing.muted} paused=${playing.paused}`);

// --- the two bugs that reached the user ------------------------------------
// Regression 1: writing video.volume directly was wiped by the player on a
//   quality switch (volume "reset at a random moment").
// Regression 2: reading video.volume back and re-applying it multiplied by the
//   normalisation factor each cycle, decaying to 2 ("volume drags itself down").
// Regression 3: start state was keyed on video.currentSrc, which YouTube
//   changes on a quality switch, so a playing track was paused and muted.
console.log('\n--- quality switches and seek must disturb nothing ---');
await evalIn(s, `document.getElementById('movie_player').setPlaybackQualityRange('tiny')`);
await sleep(5000);
const q1 = await snap();
await evalIn(s, `document.getElementById('movie_player').setPlaybackQualityRange('hd1080')`);
await sleep(5000);
const q2 = await snap();
await evalIn(s, `document.getElementById('movie_player').seekTo(90, true)`);
await sleep(5000);
const q3 = await snap();
await sleep(12000);
const idle = await snap();

const seq = [playing, q1, q2, q3, idle];
check('volume never drifts', seq.every(r => r.getVolume === playing.getVolume),
  seq.map(r => r.getVolume).join(' -> '));
check('quality switch does not re-mute', seq.every(r => r.muted === false),
  seq.map(r => r.muted).join(' -> '));
check('quality switch does not pause playback', seq.every(r => r.paused === false),
  seq.map(r => r.paused).join(' -> '));

// --- the bar must not fade out under a slow drag ---------------------------
// Regression: setting a level slowly by hand meant holding the fader for
// several seconds, and the control bar faded out from under the hand using
// it. The slider takes pointer capture and calls preventDefault() on
// pointerdown, which suppresses the compatibility mouse events for that
// pointer - so YouTube's idle timer saw no activity at all for the whole
// drag. This must run BEFORE the fade case, which disables rAF and would
// stop the slider easing.
console.log('\n--- the control bar must survive a slow drag ---');

// The 12 s idle above will have hidden the bar. Wake it with a real move.
const playerBox = await evalIn(s, `(() => {
  const r = document.getElementById('movie_player').getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`);
// Two moves, a few pixels apart: the idle timer resets on movement, so a
// single event landing where the pointer already was counts for nothing.
await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...playerBox });
await s.send('Input.dispatchMouseEvent',
  { type: 'mouseMoved', x: playerBox.x + 12, y: playerBox.y + 8 });
await sleep(600);
const woken = await snap();
check('the bar is up before the drag starts', woken.autohide === false,
  `autohide=${woken.autohide}`);

// Pin the assumption directly, so a rename by YouTube fails here with the
// cause rather than only downstream with the symptom. The bridge does have a
// synthetic-mousemove fallback, but nothing else would say the primary path
// had gone.
check('the player still exposes wakeUpControls', await evalIn(s,
  `typeof document.getElementById('movie_player').wakeUpControls === 'function'`));

const hiddenDuringDrag = [];
// Press ON the handle (volume is 70 here, so it sits at 0.70) rather than
// near it: that is the eased-follow path the report described, and pressing
// a handle-width away would take the jump path instead, nondeterministically.
await slowDrag(0.70, 0.55, 8, async () => {
  hiddenDuringDrag.push(await evalIn(s,
    `document.getElementById('movie_player').classList.contains('ytp-autohide')`));
});
check('the bar stays up for a whole 8 s drag',
  hiddenDuringDrag.every((hidden) => hidden === false),
  `autohide by 500 ms step: ${hiddenDuringDrag.map((h) => (h ? 'H' : '.')).join('')}`);

// And releasing must hand the bar back to YouTube rather than pinning it
// open for ever: it hides again once the hand is off.
await sleep(6000);
const afterRelease = await snap();
check('the bar hides again once the drag ends', afterRelease.autohide === true,
  `autohide=${afterRelease.autohide}`);

// --- fade must not depend on requestAnimationFrame -------------------------
// Regression: the fade ran on rAF, which Chrome pauses entirely in hidden
// tabs, so it froze the moment the user switched tabs. Disabling rAF is a
// direct test of that mechanism and is deterministic, unlike trying to
// genuinely background a tab from CDP.
console.log('\n--- fade with requestAnimationFrame disabled ---');
await click('.ytm-controls .mixer-slider', 0.80);
await evalIn(s, `window.requestAnimationFrame = function(){ return 0; }; 1`);
const beforeFade = await snap();
await evalIn(s, `document.querySelector('.ytm-controls .ytm-fade').click()`);

// The ramp is 7.5 s, so five seconds in it must still be running. This is the
// guard on the duration itself: under the old 5 s ramp the volume is already 0
// here, and both that and a fade that never starts fail the same check.
await sleep(5000);
const midFade = await snap();
const ramped = midFade.getVolume / beforeFade.getVolume;
check('fade is a third of the way from the end at 5 s, so the ramp is 7.5 s',
  Math.abs(ramped - 1 / 3) < 0.12,
  `${beforeFade.getVolume} -> ${midFade.getVolume} at 5 s (${ramped.toFixed(2)} left)`);

await sleep(5000);
const afterFade = await snap();
check('fade completes to 0 without rAF', afterFade.getVolume === 0,
  `${beforeFade.getVolume} -> ${afterFade.getVolume}`);

// --- summary ---------------------------------------------------------------
const passed = results.filter(r => r.ok).length;
console.log(`\n===== ${passed}/${results.length} passed =====`);

s.close();
await closeTab(t.id);

if (passed !== results.length) {
  console.error('FAILED: ' + results.filter(r => !r.ok).map(r => r.name).join('; '));
  process.exit(1);
}
