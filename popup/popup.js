// YouTube Mixer - popup panel.
//
// Lists every live (non-discarded) YouTube watch tab whose content script
// answers, with the same eased slider + readout + mute + fade controls as the
// in-player cluster. All control happens via messages to that tab's content
// script; a short poll keeps the panel in sync with each tab's real state.

'use strict';

const POLL_MS = 400;
const VOLUME_SEND_MS = 40; // trailing throttle for drag updates

const list = document.getElementById('list');
const empty = document.getElementById('empty');
const footer = document.getElementById('footer');
const count = document.getElementById('count');

const rows = new Map(); // tabId -> row

function send(tabId, msg) {
  return chrome.tabs.sendMessage(tabId, msg).catch(() => null);
}

function btn(cls, label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn ' + cls;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function focusTab(row) {
  chrome.tabs.update(row.tabId, { active: true });
  chrome.windows.update(row.windowId, { focused: true });
}

// Trailing throttle so a drag doesn't flood the tab with messages.
function queueVolume(row, v) {
  row.pendingVolume = v;
  if (row.volTimer !== null) return;
  row.volTimer = setTimeout(() => {
    row.volTimer = null;
    row.lastVolSent = Date.now();
    send(row.tabId, { type: 'setVolume', value: row.pendingVolume });
  }, VOLUME_SEND_MS);
}

function applyState(row, state) {
  row.titleEl.textContent = state.title || '';
  row.playBtn.textContent = state.paused ? '▶' : '❚❚';
  row.playBtn.classList.toggle('playing', !state.paused);
  row.muteBtn.classList.toggle('active', state.muted);
  row.el.classList.toggle('muted', state.muted);
  // Don't fight the user's hand on the slider, and ignore polls answered
  // just after we sent a volume - they can carry a stale value that would
  // nudge the freshly-settled handle (reads as phantom momentum).
  if (!row.slider.isBusy() && Date.now() - (row.lastVolSent || 0) > 800) {
    row.slider.setValue(state.volume);
    row.readout.textContent = Math.round(state.volume * 100);
  }
}

function addRow(tab, state) {
  const row = {
    tabId: tab.id,
    windowId: tab.windowId,
    volTimer: null,
    pendingVolume: 0,
    lastVolSent: 0,
  };

  const el = document.createElement('section');
  el.className = 'row';

  const head = document.createElement('div');
  head.className = 'row-head';

  const thumb = document.createElement('img');
  thumb.className = 'thumb';
  thumb.alt = '';
  thumb.title = 'Go to tab';
  if (state.videoId) {
    thumb.src = 'https://i.ytimg.com/vi/' + state.videoId + '/mqdefault.jpg';
  }
  thumb.addEventListener('click', () => focusTab(row));

  const title = document.createElement('div');
  title.className = 'title';
  title.title = 'Go to tab';
  title.addEventListener('click', () => focusTab(row));

  head.append(thumb, title);

  const controls = document.createElement('div');
  controls.className = 'row-controls';

  const playBtn = btn('play', '▶', () => send(row.tabId, { type: 'togglePlay' }));
  const readout = document.createElement('span');
  readout.className = 'readout';
  readout.textContent = '0';

  const slider = createMixerSlider({
    onInput(v) {
      readout.textContent = Math.round(v * 100);
      queueVolume(row, v);
    },
  });

  const muteBtn = btn('mute', 'MUTE', () => send(row.tabId, { type: 'toggleMute' }));
  const fadeBtn = btn('fade', 'FADE', () => send(row.tabId, { type: 'fadeOut' }));

  controls.append(playBtn, readout, slider.el, muteBtn, fadeBtn);
  el.append(head, controls);

  row.el = el;
  row.titleEl = title;
  row.playBtn = playBtn;
  row.muteBtn = muteBtn;
  row.readout = readout;
  row.slider = slider;

  applyState(row, state);
  rows.set(tab.id, row);
  list.appendChild(el);
}

function updateChrome() {
  empty.hidden = rows.size > 0;
  count.textContent = rows.size === 1 ? '1 track' : rows.size + ' tracks';
}

async function poll() {
  for (const [tabId, row] of rows) {
    const state = await send(tabId, { type: 'getState' });
    if (!state || !state.ok) {
      // Tab closed, navigated away, or went to sleep - drop the row.
      row.el.remove();
      rows.delete(tabId);
      updateChrome();
      continue;
    }
    applyState(row, state);
  }
}

async function init() {
  const tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/watch*' });
  // Exclude discarded ("sleeping") tabs - they have no live page to control.
  const live = tabs.filter((t) => !t.discarded);
  let skipped = tabs.length - live.length;

  const states = await Promise.all(
    live.map((t) => send(t.id, { type: 'getState' }))
  );
  live.forEach((tab, i) => {
    const state = states[i];
    if (state && state.ok) {
      addRow(tab, state);
    } else {
      skipped++;
    }
  });

  updateChrome();
  if (skipped > 0) {
    footer.hidden = false;
    footer.textContent =
      skipped + ' sleeping or unresponsive YouTube tab' +
      (skipped === 1 ? '' : 's') + ' hidden - reload to control here.';
  }
  setInterval(poll, POLL_MS);
}

init();
