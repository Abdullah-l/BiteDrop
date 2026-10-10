import { Signal } from './signal.js';

// Public STUN servers only tell each browser its public IP so the two can find a
// path through home routers. They never see the files.
const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // no 0/O, 1/I/L
const CODE_LEN = 8;
const MANUAL_PREFIX = 'BD1.';
const READ_ERROR = "Couldn't read this file. Close it in other apps (e.g. Word) or save it to disk, then try again";

const $ = (id) => document.getElementById(id);
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

const normalizeCode = (s) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
const isCode = (s) => s.length === CODE_LEN && [...s].every((c) => ALPHABET.includes(c));
const formatCode = (c) => `${c.slice(0, 4)}-${c.slice(4)}`;

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

const toB64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function packManual(t, sdp) {
  const stream = new Blob([JSON.stringify({ t, sdp })]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return MANUAL_PREFIX + toB64url(new Uint8Array(await new Response(stream).arrayBuffer()));
}

async function unpackManual(text, expected) {
  const raw = text.replace(/\s+/g, '');
  if (!raw.startsWith(MANUAL_PREFIX)) throw new Error("That doesn't look like a BiteDrop code.");
  let msg;
  try {
    const stream = new Blob([fromB64url(raw.slice(MANUAL_PREFIX.length))]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    msg = JSON.parse(await new Response(stream).text());
  } catch {
    throw new Error('That code is incomplete or damaged. Copy the whole thing and try again.');
  }
  if (msg.t !== expected) {
    throw new Error(expected === 'a' ? "That's a starting code, not a reply. Paste the reply from the other device." : "That's a reply code. Paste the code the other device created first.");
  }
  return msg.sdp;
}

// ---------- screens & status ----------

const SCREENS = ['home', 'wait', 'connecting', 'manual', 'room', 'ended'];
function show(name) {
  for (const s of SCREENS) $(s).hidden = s !== name;
}

function setStatus(text, live = false) {
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
  history.replaceState(null, '', location.pathname + location.search);
  $('transfers').replaceChildren($('empty'));
  $('empty').hidden = false;
  $('joinInput').value = '';
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
    $('roomEnded').hidden = true;
    show('room');
    showRoute(s);
  };
  ch.onopen = open;
  ch.onclose = () => end(s, 'The other device left.');
  if (ch.readyState === 'open') open();
}

async function showRoute(s) {
  let label = 'direct';
  try {
    const stats = await s.pc.getStats();
    let pair;
    stats.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId); });
    if (!pair) stats.forEach((r) => { if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r; });
    if (pair) {
      const types = [stats.get(pair.localCandidateId)?.candidateType, stats.get(pair.remoteCandidateId)?.candidateType];
      label = types.includes('relay') ? 'relayed' : types.every((t) => t === 'host') ? 'direct · same network' : 'direct · over the internet';
    }
  } catch {}
  if (s !== session || s.ended) return;
  const who = s.link?.peerName ? `Connected to ${s.link.peerName}` : 'Connected';
  setStatus(`${who} · ${label}`, true);
}

// ---------- short-code flow ----------

function relayStatus(s, onReady) {
  return (ready, total) => {
    if (s !== session || s.connected) return;
    s.relaysUp = ready > 0;
    if (ready) onReady?.();
    setStatus(ready ? `Ready · ${ready} of ${total} relays` : 'Reaching relays…', ready > 0);
  };
}

function relayWatchdog(s, hintEl) {
  const t = setTimeout(() => {
    if (s === session && !s.relaysUp) {
      hintEl.textContent = "Can't reach the code relays from this network. Use “Connect without any server” on the start screen instead.";
    }
  }, 8000);
  s.cleanup.push(() => clearTimeout(t));
}

function startCreate() {
  const s = newSession();
  const code = newCode();
  const link = `${location.origin}${location.pathname}#${code}`;
  $('codeText').textContent = formatCode(code);
  $('waitHint').textContent = 'On the other device, open this page and enter the code.';
  $('copyCode').onclick = () => copyText(formatCode(code), $('copyCode'));
  $('copyLink').onclick = () => copyText(link, $('copyLink'));
  $('shareLink').hidden = !navigator.share;
  $('shareLink').onclick = () => navigator.share({ title: 'BiteDrop', text: `BiteDrop code: ${formatCode(code)}`, url: link }).catch(() => {});
  show('wait');
  setStatus('Reaching relays…');
  relayWatchdog(s, $('waitHint'));

  let offer = null;
  s.signal = new Signal(code, async (msg) => {
    if (s !== session || s.connected || msg.from === me) return;
    if (msg.type === 'hello') {
      if (!s.peer) {
        s.peer = msg.from; // first device to show up wins; the code is single-use
        $('waitHint').textContent = 'Found the other device. Connecting…';
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
  history.replaceState(null, '', location.pathname + location.search);
  $('connectingText').textContent = 'Looking for the other device…';
  show('connecting');
  setStatus('Reaching relays…');
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

// ---------- copy-paste (serverless) flow ----------

function manualView(part) {
  for (const id of ['manualOffer', 'manualJoin', 'manualAnswer']) $(id).hidden = id !== part;
  $('manualSwitch').hidden = part !== 'manualOffer';
  $('manualError').hidden = true;
  show('manual');
}

function manualError(err) {
  $('manualError').textContent = err.message || String(err);
  $('manualError').hidden = false;
}

async function startManualOffer() {
  const s = newSession();
  manualView('manualOffer');
  setStatus('');
  $('offerOut').value = 'Preparing…';
  $('answerIn').value = '';
  $('useAnswer').disabled = false;
  $('useAnswer').textContent = 'Connect';
  const pc = newPeer(s, { timeout: false });
  attachChannel(s, pc.createDataChannel('bitedrop', { ordered: true }));
  const code = await packManual('o', await localSdp(pc));
  if (s === session) $('offerOut').value = code;
}

async function useAnswer() {
  const s = session;
  if (!s?.pc) return;
  try {
    const sdp = await unpackManual($('answerIn').value, 'a');
    $('manualError').hidden = true;
    $('useAnswer').disabled = true;
    $('useAnswer').textContent = 'Connecting…';
    await s.pc.setRemoteDescription({ type: 'answer', sdp });
  } catch (err) {
    $('useAnswer').disabled = false;
    $('useAnswer').textContent = 'Connect';
    manualError(err);
  }
}

function startManualJoin(prefill = '') {
  newSession();
  manualView('manualJoin');
  setStatus('');
  $('offerIn').value = prefill;
  $('useOffer').disabled = false;
  if (prefill) useOffer();
}

async function useOffer() {
  const s = session;
  if (!s) return;
  try {
    const offer = await unpackManual($('offerIn').value, 'o');
    $('useOffer').disabled = true;
    const pc = newPeer(s, { timeout: false });
    pc.ondatachannel = (e) => attachChannel(s, e.channel);
    await pc.setRemoteDescription({ type: 'offer', sdp: offer });
    const code = await packManual('a', await localSdp(pc));
    if (s !== session) return;
    $('answerOut').value = code;
    manualView('manualAnswer');
  } catch (err) {
    $('useOffer').disabled = false;
    manualError(err);
  }
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
  const row = el('div', { className: 'item' },
    el('div', { className: 'name' }, el('span', { className: 'dir', textContent: direction === 'out' ? '↑' : '↓' }), name),
    actions, meta, el('div', { className: 'bar' }, bar));
  $('transfers').prepend(row);
  let start = 0;
  let cancelBtn = null;
  const api = {
    finished: false,
    progress(bytes) {
      if (!start) start = performance.now();
      const pct = size ? (bytes / size) * 100 : 100;
      const secs = (performance.now() - start) / 1000;
      bar.style.width = pct + '%';
      meta.textContent = `${fmtSize(bytes)} of ${fmtSize(size)} · ${Math.floor(pct)}%` + (secs > 0.5 ? ` · ${fmtSize(bytes / secs)}/s` : '');
    },
    onCancel(fn) {
      cancelBtn = el('button', { className: 'ghost', textContent: 'Cancel' });
      cancelBtn.onclick = fn;
      actions.append(cancelBtn);
    },
    done(text, url) {
      api.finished = true;
      bar.style.width = '100%';
      meta.textContent = text;
      cancelBtn?.remove();
      if (url) actions.append(el('a', { className: 'btn primary', href: url, download: name, textContent: 'Save' }));
    },
    fail(text) {
      if (api.finished) return;
      api.finished = true;
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

  enqueue(files) {
    for (const file of files) {
      const id = randomId();
      const row = transferRow('out', file.name || 'file', file.size);
      const job = { id, file, row, body: snapshot(file), cancelled: false };
      job.body.catch(() => {});
      row.onCancel(() => {
        job.cancelled = true;
        this.send({ t: 'cancel', id });
        row.fail('Cancelled');
      });
      this.jobs.set(id, job);
      this.queue.push(job);
    }
    this.pump();
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
    this.send({ t: 'file', id: job.id, name: job.file.name || 'file', size });
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
        const name = safeName(m.name);
        const size = Math.max(0, Number(m.size) || 0);
        const inc = { id: String(m.id), name, size, chunks: [], got: 0, acked: 0, row: transferRow('in', name, size) };
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
        // Always octet-stream: a peer-supplied type like text/html must never be
        // rendered inside this page's origin.
        const url = URL.createObjectURL(new Blob(inc.chunks, { type: 'application/octet-stream' }));
        this.urls.push(url);
        inc.row.done(`${fmtSize(inc.size)} · received`, url);
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
        if (job) job.row.done(`${fmtSize(job.file.size)} · delivered`);
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

function sendFiles(list) {
  const files = [...(list || [])];
  const link = session?.link;
  if (!files.length || !link || session.ended) return;
  link.enqueue(files);
}

$('createBtn').onclick = startCreate;
$('manualBtn').onclick = startManualOffer;
$('manualJoinBtn').onclick = () => startManualJoin();
$('useAnswer').onclick = useAnswer;
$('useOffer').onclick = useOffer;
$('copyOffer').onclick = () => copyText($('offerOut').value, $('copyOffer'));
$('copyAnswer').onclick = () => copyText($('answerOut').value, $('copyAnswer'));
document.querySelectorAll('[data-action="home"]').forEach((b) => (b.onclick = goHome));

$('joinForm').onsubmit = (e) => {
  e.preventDefault();
  const raw = $('joinInput').value.trim();
  if (raw.startsWith(MANUAL_PREFIX)) return startManualJoin(raw);
  const code = normalizeCode(raw);
  if (!isCode(code)) {
    $('joinInput').setCustomValidity('Codes are 8 letters and numbers, like K7QM-X3PD');
    $('joinInput').reportValidity();
    return;
  }
  startJoin(code);
};
$('joinInput').oninput = () => $('joinInput').setCustomValidity('');

try { $('autoDl').checked = localStorage.getItem('bd-auto') !== '0'; } catch {}
$('autoDl').onchange = () => { try { localStorage.setItem('bd-auto', $('autoDl').checked ? '1' : '0'); } catch {} };

$('picker').onchange = (e) => { sendFiles(e.target.files); e.target.value = ''; };
const drop = $('drop');
['dragenter', 'dragover'].forEach((t) => document.addEventListener(t, (e) => {
  e.preventDefault();
  if (session?.link) drop.classList.add('over');
}));
['dragleave', 'drop'].forEach((t) => document.addEventListener(t, (e) => {
  e.preventDefault();
  if (t === 'drop' || !e.relatedTarget) drop.classList.remove('over');
}));
document.addEventListener('drop', (e) => sendFiles(e.dataTransfer?.files));
document.addEventListener('paste', (e) => {
  if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
  sendFiles(e.clipboardData?.files);
});
window.addEventListener('beforeunload', (e) => {
  if (session?.link?.busy) e.preventDefault();
});

if (!window.RTCPeerConnection || !window.isSecureContext) {
  $('home').querySelector('.lede').textContent = window.isSecureContext
    ? "This browser doesn't support direct connections. Try a current Chrome, Safari, Firefox, or Edge."
    : 'BiteDrop needs a secure (https://) page to work.';
  $('home').querySelector('.cards').hidden = true;
  $('home').querySelector('.aside').hidden = true;
} else {
  const fromLink = normalizeCode(decodeURIComponent(location.hash.slice(1)));
  if (isCode(fromLink)) startJoin(fromLink);
  else show('home');
}
