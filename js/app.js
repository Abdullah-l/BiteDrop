import { Signal } from './signal.js?v=202611131704';

// Public STUN servers only tell each browser its public IP so the two can find a
// path through home routers. They never see the files.
const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
const ALPHABET = '0123456789';
const CODE_LEN = 4; // short enough to read out loud or type on a phone keypad
const READ_ERROR = "Couldn't read this file. Close it in other apps (e.g. Word) or save it to disk, then try again";
const TEXT_MAX = 5 * 1024 * 1024; // bigger than this, send it as a file

const $ = (id) => document.getElementById(id);
// The page's own folder, so links work at a domain root (bd.almanie.dev/1234) or in a subfolder.
const BASE = location.pathname.replace(/[^/]*$/, '');
const joinUrl = (code) => `${location.host}${BASE}${code}`;
const me = randomId();
let session = null;

// ---------- small helpers ----------

function randomId() {
  return [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function newCode() {
  let code = '';
  while (code.length < CODE_LEN) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      // Rejection sampling keeps every character equally likely.
      if (b < 256 - (256 % ALPHABET.length) && code.length < CODE_LEN) code += ALPHABET[b % ALPHABET.length];
    }
  }
  return code;
}

const normalizeCode = (s) => s.replace(/\D/g, '');
const isCode = (s) => s.length === CODE_LEN && [...s].every((c) => ALPHABET.includes(c));

const fmtSize = (n) => {
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(n < 10 ? 1 : 0) + ' ' + u[i];
};

const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids);
  return n;
};

function deviceName() {
  const ua = navigator.userAgent;
  return /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iPad'
    : /Android/.test(ua) ? 'Android'
    : /Macintosh/.test(ua) ? 'Mac'
    : /Windows/.test(ua) ? 'Windows PC'
    : /Linux/.test(ua) ? 'Linux PC'
    : 'device';
}

function copyText(text, btn) {
  const done = () => {
    const t = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => (btn.textContent = t), 1200);
  };
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text).then(done, () => prompt('Copy this:', text));
  }
  const ta = el('textarea', { value: text });
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.append(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch { prompt('Copy this:', text); }
  ta.remove();
}

// ---------- screens & status ----------

const SCREENS = ['home', 'wait', 'connecting', 'room', 'ended'];
function show(name) {
  for (const s of SCREENS) $(s).hidden = s !== name;
}

function setStatus(text, live = false) {
  $('status').title = '';
  $('status').hidden = !text;
  $('statusText').textContent = text || '';
  $('dot').className = 'dot' + (live ? ' live' : '');
}

function newSession() {
  teardown();
  session = { cleanup: [], connected: false, link: null };
  return session;
}

function teardown() {
  if (!session) return;
  const s = session;
  session = null;
  s.cleanup.forEach((fn) => fn());
  s.signal?.close();
  s.link?.dispose();
  try { s.pc?.close(); } catch {}
}

function goHome() {
  teardown();
  history.replaceState(null, '', BASE);
  $('transfers').replaceChildren($('empty'));
  $('empty').hidden = false;
  $('joinInput').value = '';
  $('textInput').value = '';
  renderSlots();
  $('secure').hidden = true;
  setStatus('');
  show('home');
}

function end(s, message) {
  if (s !== session) return;
  if (s.connected) {
    // Stay on the room screen so files already received can still be saved.
    s.link?.abortAll();
    s.signal?.close();
    $('drop').hidden = true;
    $('textForm').hidden = true;
    $('roomEnded').hidden = false;
    $('roomEndedText').textContent = message;
    setStatus('Disconnected');
    s.ended = true;
  } else {
    teardown();
    $('endedText').textContent = message;
    setStatus('');
    show('ended');
  }
}

// ---------- WebRTC plumbing ----------

function iceGathered(pc, ms = 3000) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); }
    });
  });
}

// Waits for every network path to be found so the whole handshake fits in one
// message: simpler than trickling candidates, and required for copy-paste mode.
async function localSdp(pc) {
  await pc.setLocalDescription();
  await iceGathered(pc);
  return pc.localDescription.sdp;
}

function newPeer(s, { timeout = true } = {}) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  s.pc = pc;
  pc.onconnectionstatechange = () => {
    if (s !== session || s.ended) return;
    const state = pc.connectionState;
    if (state === 'failed') {
      end(s, s.connected
        ? 'Connection lost.'
        : "Couldn't connect directly. Some networks (mobile data, office Wi-Fi) block peer-to-peer connections. Try again with both devices on the same Wi-Fi.");
    } else if (state === 'disconnected' && s.connected) {
      setStatus('Connection interrupted, reconnecting…');
    } else if (state === 'connected' && s.connected) {
      showRoute(s);
    }
  };
  if (timeout) {
    const t = setTimeout(() => {
      if (s === session && !s.connected) end(s, "Couldn't connect to the other device. Check that both devices are online and try again.");
    }, 30000);
    s.cleanup.push(() => clearTimeout(t));
  }
  return pc;
}

function attachChannel(s, ch) {
  ch.binaryType = 'arraybuffer';
  const open = () => {
    if (s !== session || s.connected) return;
    s.connected = true;
    s.signal?.close(); // code is single-use; stop listening on the relays
    s.signal = null;
    s.link = new Link(s, ch);
    $('drop').hidden = false;
    $('textForm').hidden = false;
    $('roomEnded').hidden = true;
    show('room');
    showRoute(s);
    checkEncryption(s);
  };
  ch.onopen = open;
  ch.onclose = () => end(s, 'The other device left.');
  if (ch.readyState === 'open') open();
}

async function showRoute(s) {
  let label = 'Direct connection';
  try {
    const stats = await s.pc.getStats();
    let pair;
    stats.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId); });
    if (!pair) stats.forEach((r) => { if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r; });
    if (pair) {
      const types = [stats.get(pair.localCandidateId)?.candidateType, stats.get(pair.remoteCandidateId)?.candidateType];
      label = types.includes('relay') ? 'Relayed connection' : types.every((t) => t === 'host') ? 'Direct, same network' : 'Direct, over the internet';
    }
  } catch {}
  if (s !== session || s.ended) return;
  setStatus(s.link?.peerName || 'Connected', true);
  $('status').title = label;
}

// ---------- transport encryption ----------
//
// WebRTC data channels always run over DTLS, so everything sent (files and
// text) is encrypted between the two browsers. Here we confirm the DTLS
// session is actually up before allowing sends, and derive a security code
// from both sides' DTLS certificate fingerprints. If someone tampered with the
// handshake to sit in the middle, the two devices would show different codes.

const DTLS_VERSIONS = { FEFD: 'DTLS 1.2', FEFC: 'DTLS 1.3' };
const fingerprint = (sdp) => {
  const m = /^a=fingerprint:(\S+) (\S+)/mi.exec(sdp || '');
  return m ? `${m[1].toLowerCase()} ${m[2].toUpperCase()}` : '';
};

const LOCK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
const lockIcon = () => { const t = document.createElement('template'); t.innerHTML = LOCK_SVG; return t.content.firstChild; };

async function checkEncryption(s) {
  const out = $('secure');
  let state = null, version = '';
  try {
    for (let tries = 0; tries < 10; tries++) {
      const stats = await s.pc.getStats();
      stats.forEach((r) => {
        if (r.type === 'transport' && r.dtlsState) {
          state = r.dtlsState;
          version = DTLS_VERSIONS[String(r.tlsVersion || '').toUpperCase()] || '';
        }
      });
      if (state !== 'connecting' && state !== 'new') break;
      await new Promise((r) => setTimeout(r, 300));
    }
  } catch {}
  if (s !== session) return;

  const a = fingerprint(s.pc.localDescription?.sdp);
  const b = fingerprint(s.pc.remoteDescription?.sdp);
  // Browsers that report dtlsState must say 'connected'; the rest (older Safari)
  // can't open a data channel without DTLS anyway, so a fingerprint on both sides is enough.
  s.secure = !!(a && b) && (state === null || state === 'connected');
  out.hidden = false;
  if (!s.secure) {
    out.className = 'secure bad';
    out.replaceChildren(lockIcon(), "Couldn't confirm encryption. Sending is off.");
    return;
  }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode([a, b].sort().join('|'))));
  const num = ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0;
  const code = String(num % 1e6).padStart(6, '0');
  if (s !== session) return;
  out.className = 'secure';
  out.title = `Encrypted end to end${version ? ` with ${version}` : ''}. Both devices should show the same code; if they differ, someone is in the middle, so disconnect.`;
  out.replaceChildren(lockIcon(), el('span', {}, 'Encrypted. Code ', el('strong', { textContent: `${code.slice(0, 3)} ${code.slice(3)}` }), ' should match.'));
}

// ---------- short-code flow ----------

function relayStatus(s, onReady) {
  return (ready, total) => {
    if (s !== session || s.connected) return;
    s.relaysUp = ready > 0;
    if (ready) onReady?.();
    setStatus(ready ? 'Ready' : 'Connecting…', ready > 0);
    $('status').title = `${ready} of ${total} code relays reachable`;
  };
}

function relayWatchdog(s, hintEl) {
  const t = setTimeout(() => {
    if (s === session && !s.relaysUp) {
      hintEl.textContent = "Can't reach the code relays from this network. Try another network, like mobile data or a different Wi-Fi.";
    }
  }, 8000);
  s.cleanup.push(() => clearTimeout(t));
}

function startCreate() {
  const s = newSession();
  const code = newCode();
  const link = `${location.protocol}//${joinUrl(code)}`;
  $('codeText').textContent = code;
  $('waitHint').replaceChildren('Open ', el('strong', { textContent: joinUrl(code) }), ' on the other device, or type the code.');
  $('copyCode').onclick = () => copyText(code, $('copyCode'));
  $('copyLink').onclick = () => copyText(link, $('copyLink'));
  show('wait');
  setStatus('Connecting…');
  relayWatchdog(s, $('waitHint'));

  let offer = null;
  s.signal = new Signal(code, async (msg) => {
    if (s !== session || s.connected || msg.from === me) return;
    if (msg.type === 'hello') {
      if (!s.peer) {
        s.peer = msg.from; // first device to show up wins; the code is single-use
        $('waitHint').textContent = 'Found it. Connecting…';
        const pc = newPeer(s);
        attachChannel(s, pc.createDataChannel('bitedrop', { ordered: true }));
        const sdp = await localSdp(pc);
        if (s !== session) return;
        offer = { type: 'offer', from: me, to: s.peer, sdp };
        s.signal.send(offer);
      } else if (msg.from === s.peer && offer && !s.answered) {
        s.signal.send(offer); // they missed it
      }
    } else if (msg.type === 'answer' && msg.from === s.peer && msg.to === me && !s.answered) {
      s.answered = true;
      await s.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp }).catch(() => end(s, 'Connection setup failed. Try again.'));
    }
  }, relayStatus(s));
}

function startJoin(code) {
  const s = newSession();
  history.replaceState(null, '', BASE);
  $('connectingText').textContent = 'Looking for the other device…';
  show('connecting');
  setStatus('Connecting…');
  relayWatchdog(s, $('connectingText'));

  s.signal = new Signal(code, async (msg) => {
    if (s !== session || s.peer || msg.type !== 'offer' || msg.to !== me) return;
    s.peer = msg.from;
    stopHello();
    $('connectingText').textContent = 'Found it. Connecting…';
    const pc = newPeer(s);
    pc.ondatachannel = (e) => attachChannel(s, e.channel);
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
      const sdp = await localSdp(pc);
      if (s === session) s.signal?.send({ type: 'answer', from: me, to: s.peer, sdp });
    } catch {
      end(s, 'Connection setup failed. Try again.');
    }
  }, relayStatus(s));

  const hello = () => s.signal?.send({ type: 'hello', from: me });
  hello();
  const iv = setInterval(hello, 2000);
  const stopHello = () => clearInterval(iv);
  const slow = setTimeout(() => {
    if (s === session && !s.peer && s.relaysUp) {
      $('connectingText').textContent = 'Still looking… Check the code, and make sure BiteDrop is open on the other device.';
    }
  }, 12000);
  s.cleanup.push(stopHello, () => clearTimeout(slow));
}

// ---------- file transfer ----------
//
// One ordered, reliable data channel. Control messages are JSON strings; file
// contents are binary chunks sent between a {t:'file'} header and {t:'end'}.
// The receiver acks progress so the sender's bar shows delivered bytes.

const SNAPSHOT_MAX = 256 * 1024 * 1024;
const READ_BLOCK = 1024 * 1024;
const HIGH_WATER = 8 * 1024 * 1024;
let snapshotBytes = 0;

// Copy small files into memory right away so later edits or deletion of the
// original (Word autosave, dragged email attachments) can't break the send.
function snapshot(file) {
  if (file.size > SNAPSHOT_MAX || snapshotBytes + file.size > 2 * SNAPSHOT_MAX) return Promise.resolve(file);
  snapshotBytes += file.size;
  const p = file.arrayBuffer().then((buf) => new Blob([buf]));
  p.release = () => p.then((b) => { snapshotBytes -= b.size; }, () => { snapshotBytes -= file.size; });
  return p;
}

const safeName = (name) => String(name || 'file').replace(/[\/\\\x00-\x1f\x7f]/g, '_').slice(0, 200) || 'file';

function saveBlob(url, name) {
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
}

function transferRow(direction, name, size) {
  $('empty').hidden = true;
  const bar = el('div');
  const meta = el('div', { className: 'meta', textContent: direction === 'out' ? 'Waiting…' : 'Receiving…' });
  const actions = el('div', { className: 'actions' });
  const nameEl = el('div', { className: 'name', textContent: name });
  const bubble = el('div', { className: 'bubble' }, nameEl, actions, meta, el('div', { className: 'bar' }, bar));
  const row = el('div', { className: `item ${direction}` }, bubble);
  $('transfers').prepend(row);
  let start = 0;
  let cancelBtn = null;
  let sizeText = fmtSize(size);
  const api = {
    finished: false,
    progress(bytes) {
      if (!start) start = performance.now();
      const pct = size ? (bytes / size) * 100 : 100;
      const secs = (performance.now() - start) / 1000;
      bar.style.width = pct + '%';
      meta.textContent = `${Math.floor(pct)}% of ${fmtSize(size)}` + (secs > 0.5 ? `, ${fmtSize(bytes / secs)}/s` : '');
    },
    onCancel(fn) {
      cancelBtn = el('button', { className: 'ghost', textContent: 'Cancel' });
      cancelBtn.onclick = fn;
      actions.append(cancelBtn);
    },
    done(text, url) {
      api.finished = true;
      bubble.querySelector('.bar')?.remove();
      meta.textContent = `${sizeText}, ${text}`;
      cancelBtn?.remove();
      if (url) actions.append(el('a', { className: 'btn primary', href: url, download: name, textContent: 'Save' }));
    },
    // Shows a text message inline (always as textContent, never as HTML) with a Copy button.
    showText(body) {
      row.classList.add('text');
      sizeText = `${body.length.toLocaleString()} characters`;
      nameEl.replaceWith(el('div', { className: 'textbox', textContent: body }));
      bubble.querySelector('.bar')?.remove();
      const copy = el('button', { textContent: 'Copy' });
      copy.onclick = () => copyText(body, copy);
      actions.append(copy);
    },
    fail(text) {
      if (api.finished) return;
      api.finished = true;
      bubble.querySelector('.bar')?.remove();
      meta.textContent = text;
      cancelBtn?.remove();
      row.classList.add('error');
    },
  };
  return api;
}

class Link {
  constructor(s, ch) {
    this.s = s;
    this.ch = ch;
    const max = s.pc.sctp?.maxMessageSize;
    this.chunk = max ? Math.min(max, 64 * 1024) : 16 * 1024;
    this.queue = [];
    this.jobs = new Map(); // outgoing, by id
    this.incoming = null;
    this.urls = [];
    this.sending = false;
    this.peerName = '';
    ch.bufferedAmountLowThreshold = 1024 * 1024;
    ch.onmessage = (e) => this.receive(e.data);
    this.send({ t: 'hi', device: deviceName() });
  }

  send(obj) {
    if (this.ch.readyState === 'open') this.ch.send(JSON.stringify(obj));
  }

  get busy() {
    return !!this.incoming || [...this.jobs.values()].some((j) => !j.row.finished);
  }

  // ----- sending -----

  enqueue(files, kind = 'file') {
    const added = [];
    for (const file of files) {
      const id = randomId();
      const row = transferRow('out', file.name || 'file', file.size);
      const body = kind === 'text' ? Promise.resolve(file) : snapshot(file);
      const job = { id, file, kind, row, body, cancelled: false };
      job.body.catch(() => {});
      row.onCancel(() => {
        job.cancelled = true;
        this.send({ t: 'cancel', id });
        row.fail('Cancelled');
      });
      this.jobs.set(id, job);
      this.queue.push(job);
      added.push(job);
    }
    this.pump();
    return added;
  }

  async pump() {
    if (this.sending) return;
    this.sending = true;
    while (this.queue.length) {
      const job = this.queue.shift();
      if (!job.cancelled) {
        try { await this.sendFile(job); } catch { job.row.fail('Connection lost'); }
      }
      job.body.release?.();
    }
    this.sending = false;
  }

  async sendFile(job) {
    let body;
    try { body = await job.body; } catch { return job.row.fail(READ_ERROR); }
    const { ch } = this;
    const size = body.size;
    this.send({ t: 'file', id: job.id, kind: job.kind, name: job.file.name || 'file', size });
    job.row.progress(0);
    for (let off = 0; off < size;) {
      if (job.cancelled) return;
      let block;
      try {
        block = await body.slice(off, off + READ_BLOCK).arrayBuffer();
      } catch {
        this.send({ t: 'cancel', id: job.id });
        return job.row.fail(READ_ERROR);
      }
      for (let i = 0; i < block.byteLength; i += this.chunk) {
        if (ch.bufferedAmount > HIGH_WATER) await this.drained();
        if (ch.readyState !== 'open') throw new Error('closed');
        if (job.cancelled) return;
        ch.send(block.slice(i, i + this.chunk));
      }
      off += block.byteLength;
    }
    this.send({ t: 'end', id: job.id });
  }

  drained() {
    return new Promise((resolve) => {
      const done = () => {
        this.ch.removeEventListener('bufferedamountlow', done);
        this.ch.removeEventListener('close', done);
        resolve();
      };
      this.ch.addEventListener('bufferedamountlow', done);
      this.ch.addEventListener('close', done);
    });
  }

  // ----- receiving -----

  receive(data) {
    if (typeof data !== 'string') {
      const inc = this.incoming;
      if (!inc) return; // leftovers of a cancelled file
      inc.chunks.push(data);
      inc.got += data.byteLength;
      if (inc.got - inc.acked >= 512 * 1024 || inc.got === inc.size) {
        inc.acked = inc.got;
        inc.row.progress(inc.got);
        this.send({ t: 'ack', id: inc.id, got: inc.got });
      }
      return;
    }

    let m;
    try { m = JSON.parse(data); } catch { return; }
    const job = this.jobs.get(m.id);
    switch (m.t) {
      case 'hi':
        this.peerName = String(m.device || '').slice(0, 40);
        showRoute(this.s);
        break;
      case 'file': {
        const size = Math.max(0, Number(m.size) || 0);
        const isText = m.kind === 'text' && size <= TEXT_MAX;
        const name = isText ? 'Text' : safeName(m.name);
        const inc = { id: String(m.id), name, size, isText, chunks: [], got: 0, acked: 0, row: transferRow('in', name, size) };
        inc.row.onCancel(() => {
          this.send({ t: 'cancel', id: inc.id });
          inc.row.fail('Cancelled');
          if (this.incoming === inc) this.incoming = null;
        });
        inc.row.progress(0);
        this.incoming = inc;
        break;
      }
      case 'end': {
        const inc = this.incoming;
        if (!inc || inc.id !== m.id) break;
        this.incoming = null;
        if (inc.got !== inc.size) { inc.row.fail('Transfer incomplete'); break; }
        if (inc.isText) {
          new Blob(inc.chunks).text().then((body) => {
            inc.row.showText(body);
            inc.row.done('received');
          });
          this.send({ t: 'done', id: inc.id });
          break;
        }
        // Always octet-stream: a peer-supplied type like text/html must never be
        // rendered inside this page's origin.
        const url = URL.createObjectURL(new Blob(inc.chunks, { type: 'application/octet-stream' }));
        this.urls.push(url);
        inc.row.done('received', url);
        this.send({ t: 'done', id: inc.id });
        if ($('autoDl').checked) saveBlob(url, inc.name);
        break;
      }
      case 'cancel':
        if (this.incoming?.id === m.id) {
          this.incoming.row.fail('Cancelled by sender');
          this.incoming = null;
        } else if (job && !job.row.finished) {
          job.cancelled = true;
          job.row.fail('Cancelled by receiver');
        }
        break;
      case 'ack':
        if (job && !job.row.finished) job.row.progress(Math.min(Number(m.got) || 0, job.file.size));
        break;
      case 'done':
        if (job) job.row.done('delivered');
        break;
    }
  }

  abortAll() {
    this.incoming?.row.fail('Connection lost');
    this.incoming = null;
    for (const job of this.jobs.values()) {
      job.cancelled = true;
      if (!job.row.finished) job.row.fail('Connection lost');
    }
    this.queue = [];
  }

  dispose() {
    this.abortAll();
    this.urls.forEach((u) => URL.revokeObjectURL(u));
    try { this.ch.close(); } catch {}
  }
}

// ---------- wiring ----------

function canSend() {
  // session.secure is set once DTLS is confirmed; never send before that.
  return !!(session?.link && !session.ended && session.secure);
}

function sendFiles(list) {
  const files = [...(list || [])];
  if (!files.length || !canSend()) return;
  session.link.enqueue(files);
}

function sendText() {
  const input = $('textInput');
  const body = input.value;
  if (!body.trim() || !canSend()) return;
  const file = new File([body], 'Text', { type: 'text/plain' });
  if (file.size > TEXT_MAX) {
    input.setCustomValidity('That text is too long to send as a message. Save it as a file and drop it instead.');
    input.reportValidity();
    return;
  }
  const [job] = session.link.enqueue([file], 'text');
  job.row.showText(body);
  input.value = '';
}

$('createBtn').onclick = startCreate;
document.querySelectorAll('[data-action="home"]').forEach((b) => (b.onclick = goHome));

$('joinForm').onsubmit = (e) => {
  e.preventDefault();
  const code = normalizeCode($('joinInput').value);
  if (!isCode(code)) {
    $('joinInput').setCustomValidity('Codes are 4 digits, like 4829');
    $('joinInput').reportValidity();
    return;
  }
  startJoin(code);
};
function renderSlots() {
  const input = $('joinInput');
  const digits = normalizeCode(input.value).slice(0, CODE_LEN);
  if (input.value !== digits) input.value = digits;
  const focused = document.activeElement === input;
  $('slots').querySelectorAll('.slot').forEach((slot, i) => {
    slot.textContent = digits[i] || '';
    slot.classList.toggle('active', focused && (i === digits.length || (digits.length === CODE_LEN && i === CODE_LEN - 1)));
  });
}
$('joinInput').onfocus = $('joinInput').onblur = renderSlots;
$('joinInput').oninput = () => {
  $('joinInput').setCustomValidity('');
  renderSlots();
  // Join as soon as all four digits are in; no need to press the button.
  if (isCode(normalizeCode($('joinInput').value))) $('joinForm').requestSubmit();
};

try { $('autoDl').checked = localStorage.getItem('bd-auto') !== '0'; } catch {}
$('autoDl').onchange = () => { try { localStorage.setItem('bd-auto', $('autoDl').checked ? '1' : '0'); } catch {} };

$('picker').onchange = (e) => { sendFiles(e.target.files); e.target.value = ''; };
const overlay = $('dropOverlay');
['dragenter', 'dragover'].forEach((t) => document.addEventListener(t, (e) => {
  e.preventDefault();
  if (canSend() && e.dataTransfer?.types.includes('Files')) overlay.hidden = false;
}));
['dragleave', 'drop'].forEach((t) => document.addEventListener(t, (e) => {
  e.preventDefault();
  if (t === 'drop' || !e.relatedTarget) overlay.hidden = true;
}));
document.addEventListener('drop', (e) => sendFiles(e.dataTransfer?.files));
$('textForm').onsubmit = (e) => { e.preventDefault(); sendText(); };
$('textInput').oninput = () => $('textInput').setCustomValidity('');
$('textInput').onkeydown = (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendText(); }
};

document.addEventListener('paste', (e) => {
  const cd = e.clipboardData;
  if (e.target instanceof HTMLInputElement) return;
  // In the text box, plain text pastes as text; a pasted file (e.g. a screenshot) is sent as a file.
  if (e.target instanceof HTMLTextAreaElement && cd?.types.includes('text/plain')) return;
  if (cd?.files.length) { e.preventDefault(); sendFiles(cd.files); }
});
window.addEventListener('beforeunload', (e) => {
  if (session?.link?.busy) e.preventDefault();
});

if (!window.RTCPeerConnection || !window.isSecureContext) {
  $('home').querySelector('.lede').textContent = window.isSecureContext
    ? "This browser doesn't support direct connections. Try a current Chrome, Safari, Firefox, or Edge."
    : 'BiteDrop needs a secure (https://) page to work.';
  $('home').querySelector('.cards').hidden = true;
} else {
  // A link like bd.almanie.dev/1234 (or the older #1234 form) joins straight away.
  const fromPath = location.pathname.slice(location.pathname.lastIndexOf('/') + 1);
  const fromLink = normalizeCode(decodeURIComponent(fromPath || location.hash.slice(1)));
  if (isCode(fromLink)) startJoin(fromLink);
  else show('home');
}
