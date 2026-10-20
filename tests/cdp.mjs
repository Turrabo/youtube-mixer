// Minimal Chrome DevTools Protocol client on Node's built-in WebSocket and
// fetch. No dependencies, no build step.
//
// Used by the regression suite to drive a real browser with the extension
// loaded. Start the browser first with scripts/test-rig.ps1.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The rig launches on an OS-picked port (scripts/test-rig.ps1), and Chrome
// publishes it in the profile's DevToolsActivePort. test-rig deletes that file
// before every launch, so the one read here is the running rig's.
//
// The profile has ONE home, the machine-wide devports ledger. The two failure
// modes are deliberately NOT treated alike, because they mean opposite things:
//
//   Ledger unreadable  -> a developer without the machine's ledger. Fall back
//                         to the documented default profile, and SAY SO.
//   Ledger present but -> a real misconfiguration: the entry was renamed or
//   entry missing         removed. Throw rather than guess.
const RIG = 'youtube-mixer-chrome';
const HOME = process.env.USERPROFILE || process.env.HOME || '';
const RIG_PROFILE_FALLBACK = join(HOME, '.claude', 'state', 'browsers', RIG);

function ledgerPath() {
  return process.env.DEVPORTS_LEDGER || join(HOME, '.claude', 'state', 'ports', 'ledger.json');
}

function rigProfile() {
  const path = ledgerPath();
  let ledger;
  try {
    ledger = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    console.warn(`[cdp] no readable devports ledger at ${path}; falling back to profile ${RIG_PROFILE_FALLBACK}.`);
    return RIG_PROFILE_FALLBACK;
  }
  const profile = ledger?.reservations?.[RIG]?.profile;
  if (!profile) {
    throw new Error(
      `devports ledger at ${path} has no profile for reservation '${RIG}'. ` +
        `Recreate it with: devports new ${RIG} -Engine chrome -Owner youtube-mixer -NoPort`,
    );
  }
  return profile.replace(/%([^%]+)%/g, (m, v) => process.env[v] ?? m);
}

function rigPort() {
  const marker = join(rigProfile(), 'DevToolsActivePort');
  let port;
  try {
    port = Number(readFileSync(marker, 'utf8').split(/\r?\n/)[0]);
  } catch {
    /* reported below */
  }
  if (!port) throw new Error(`no rig port at ${marker}. Start the rig first: scripts/test-rig.ps1`);
  return port;
}

const BASE = `http://127.0.0.1:${rigPort()}`;

export async function listTargets() {
  return (await fetch(BASE + '/json')).json();
}

export async function newTab(url) {
  const r = await fetch(BASE + '/json/new?' + encodeURIComponent(url), { method: 'PUT' });
  return r.json();
}

export async function closeTab(id) {
  await fetch(BASE + '/json/close/' + id);
}

export function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();
    ws.onopen = () => resolve({
      send(method, params = {}) {
        const id = nextId++;
        ws.send(JSON.stringify({ id, method, params }));
        return new Promise((res, rej) => pending.set(id, { res, rej }));
      },
      close() { ws.close(); },
    });
    ws.onerror = () => reject(new Error('websocket error connecting to ' + wsUrl));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      }
    };
  });
}

export async function evalIn(session, expr, awaitPromise = false) {
  const r = await session.send('Runtime.evaluate', {
    expression: expr,
    awaitPromise,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error('page exception: ' +
      (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result.value;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(session, expr, timeoutMs = 30000, pollMs = 500) {
  const t0 = Date.now();
  for (;;) {
    let v = false;
    try { v = await evalIn(session, expr); } catch { /* navigation in flight */ }
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error('timeout waiting for: ' + expr);
    await sleep(pollMs);
  }
}

// A fresh profile lands on consent.youtube.com, and watch pages can raise an
// in-page consent lightbox as well. Clicks "Reject all" wherever it appears.
export async function rejectConsent(s) {
  for (let i = 0; i < 30; i++) {
    const state = await evalIn(s, `(() => {
      const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const b = [...document.querySelectorAll('button')]
        .filter(x => visible(x) && /reject all/i.test(x.textContent));
      if (b.length) { b[0].click(); return 'clicked'; }
      const bump = document.querySelector('ytd-consent-bump-v2-lightbox');
      if (bump && visible(bump)) return 'bump';
      return location.host === 'www.youtube.com' ? 'clear' : 'offsite';
    })()`).catch(() => 'nav');
    if (state === 'clear') return;
    await sleep(1500);
  }
  throw new Error('consent wall never cleared');
}
