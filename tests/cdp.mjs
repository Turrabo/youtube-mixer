// Minimal Chrome DevTools Protocol client on Node's built-in WebSocket and
// fetch. No dependencies, no build step.
//
// Used by the regression suite to drive a real browser with the extension
// loaded. Start the browser first with scripts/test-rig.ps1.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The rig's port has ONE home, the machine-wide devports ledger. This file
// used to repeat it, which is how it ended up pointing at the retired Edge
// rig's 9333 after the rig moved to Chrome.
//
// The two failure modes are deliberately NOT treated alike, because they mean
// opposite things:
//
//   Ledger unreadable  -> a developer without the machine's ledger. Fall back
//                         to the documented default, and SAY SO, because a
//                         silent fallback that happens to work is how the
//                         duplicate survived the last cleanup.
//   Ledger present but -> a real misconfiguration: the entry was renamed or
//   entry missing         removed. Throw. Falling back here would silently
//                         drive whatever else has since been allocated that
//                         port, which is worse than not running at all.
const RIG = 'youtube-mixer-chrome';
const RIG_PORT_FALLBACK = 9236;

function ledgerPath() {
  return (
    process.env.DEVPORTS_LEDGER ||
    join(process.env.USERPROFILE || process.env.HOME || '', '.claude', 'state', 'ports', 'ledger.json')
  );
}

function rigPort() {
  const path = ledgerPath();
  let ledger;
  try {
    ledger = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    console.warn(
      `[cdp] no readable devports ledger at ${path}; falling back to port ${RIG_PORT_FALLBACK}. ` +
        `If the rig is on a different port this run will drive the wrong browser or nothing at all.`,
    );
    return RIG_PORT_FALLBACK;
  }
  const port = Number(ledger?.reservations?.[RIG]?.ports?.[0]);
  if (!port) {
    throw new Error(
      `devports ledger at ${path} has no port for reservation '${RIG}'. ` +
        `Recreate it with: devports new ${RIG} -Engine chrome -Owner youtube-mixer`,
    );
  }
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
