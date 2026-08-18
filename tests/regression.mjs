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

const snap = async () => evalIn(s, `(() => {
  const p = document.getElementById('movie_player');
  const v = document.querySelector('#movie_player video');
  return {
    readout: +document.querySelector('.ytm-readout').textContent,
    getVolume: p.getVolume(),
    videoVolume: +v.volume.toFixed(4),
    muted: p.isMuted(),
    paused: v.paused,
    loop: v.loop,
  };
})()`);

// --- start state -----------------------------------------------------------
// Regression: the start mute silently failed when the player was not yet ready
// to accept it, so a track could open audible.
console.log('\n--- start state ---');
const start = await snap();
check('starts paused', start.paused === true);
check('starts muted', start.muted === true);
check('starts looping', start.loop === true);

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

await click('.ytm-controls .ytm-mute');
await click('#movie_player .ytp-play-button');
await sleep(2500);
const playing = await snap();
check('unmutes and plays', playing.muted === false && playing.paused === false,
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
await sleep(7000);
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
