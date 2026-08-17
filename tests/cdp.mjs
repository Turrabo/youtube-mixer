// Minimal Chrome DevTools Protocol client on Node's built-in WebSocket and
// fetch. No dependencies, no build step.
//
// Used by the regression suite to drive a real browser with the extension
// loaded. Start the browser first with scripts/test-rig.ps1.

const BASE = 'http://127.0.0.1:9333';

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
