// Short-code signaling over free public MQTT brokers.
//
// Two browsers need to swap a ~1–2 KB WebRTC handshake before they can talk
// directly. These brokers pass that handshake along and nothing else; file data
// never touches them. Every message is encrypted with a key derived from the
// share code, so the brokers can't read the handshake or forge one.

const BROKERS = [
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://broker.emqx.io:8084/mqtt',
  'wss://test.mosquitto.org:8081',
];

const enc = new TextEncoder();
const dec = new TextDecoder();

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const mqttString = (s) => {
  const b = enc.encode(s);
  return [b.length >> 8, b.length & 255, ...b];
};
const remainingLength = (n) => {
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return out;
};
const packet = (header, body) => {
  const len = remainingLength(body.length);
  const out = new Uint8Array(1 + len.length + body.length);
  out[0] = header;
  out.set(len, 1);
  out.set(body, 1 + len.length);
  return out;
};

// Just enough MQTT 3.1.1 to subscribe to one topic and publish QoS 0 messages.
class MqttLink {
  constructor(url, topic, onMessage, onChange) {
    this.topic = topic;
    this.onMessage = onMessage;
    this.onChange = onChange;
    this.ready = false;
    this.closed = false;
    this.pending = [];
    this.buf = new Uint8Array(0);
    this.url = url;
    this.open();
  }

  open() {
    const ws = new WebSocket(this.url, ['mqtt']);
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      const clientId = 'bd' + hex(crypto.getRandomValues(new Uint8Array(8)));
      // protocol "MQTT", level 4, clean session, 60s keepalive
      ws.send(packet(0x10, [...mqttString('MQTT'), 4, 0x02, 0, 60, ...mqttString(clientId)]));
    };
    ws.onmessage = (e) => this.receive(new Uint8Array(e.data));
    ws.onclose = () => {
      clearInterval(this.ping);
      if (this.ready) this.onChange();
      this.ready = false;
      if (!this.closed) setTimeout(() => !this.closed && this.open(), 3000);
    };
    ws.onerror = () => {};
  }

  receive(chunk) {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    this.buf = merged;
    for (;;) {
      let len = 0, mult = 1, i = 1, b;
      do {
        if (i >= this.buf.length) return;
        b = this.buf[i++];
        len += (b & 127) * mult;
        mult *= 128;
      } while (b & 128);
      if (this.buf.length < i + len) return;
      const header = this.buf[0];
      const body = this.buf.slice(i, i + len);
      this.buf = this.buf.slice(i + len);
      this.handle(header >> 4, header & 15, body);
    }
  }

  handle(type, flags, body) {
    if (type === 2) { // CONNACK
      if (body[1] !== 0) return this.ws.close();
      this.ws.send(packet(0x82, [0, 1, ...mqttString(this.topic), 0])); // SUBSCRIBE, QoS 0
    } else if (type === 9) { // SUBACK
      this.ready = true;
      this.ping = setInterval(() => this.ws.send(new Uint8Array([0xc0, 0])), 30000);
      for (const p of this.pending.splice(0)) this.ws.send(p);
      this.onChange();
    } else if (type === 3) { // PUBLISH
      const tlen = (body[0] << 8) | body[1];
      const offset = 2 + tlen + (((flags >> 1) & 3) ? 2 : 0);
      this.onMessage(body.slice(offset));
    }
  }

  publish(payload) {
    const p = packet(0x30, [...mqttString(this.topic), ...payload]);
    if (this.ready) this.ws.send(p);
    else this.pending.push(p);
  }

  close() {
    this.closed = true;
    clearInterval(this.ping);
    try { this.ws.close(); } catch {}
  }
}

async function deriveRoom(code) {
  const base = await crypto.subtle.importKey('raw', enc.encode(code), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode('bitedrop/v1'), iterations: 200000, hash: 'SHA-256' },
    base,
    384,
  ));
  const key = await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { key, topic: 'bitedrop/v1/' + hex(bits.slice(32)) };
}

export class Signal {
  // onMessage(obj) gets every decrypted message (including duplicates from
  // different brokers); onStatus(readyCount, total) tracks broker connections.
  constructor(code, onMessage, onStatus = () => {}) {
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.links = [];
    this.ready = deriveRoom(code).then(({ key, topic }) => {
      this.key = key;
      if (this.closed) return;
      const status = () => this.onStatus(this.links.filter((l) => l.ready).length, BROKERS.length);
      this.links = BROKERS.map((url) => new MqttLink(url, topic, (data) => this.receive(data), status));
    });
  }

  async receive(data) {
    try {
      const iv = data.slice(0, 12);
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, this.key, data.slice(12));
      this.onMessage(JSON.parse(dec.decode(plain)));
    } catch {
      // Not encrypted with our code's key: ignore.
    }
  }

  async send(obj) {
    await this.ready;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.key, enc.encode(JSON.stringify(obj))));
    const payload = new Uint8Array(12 + ct.length);
    payload.set(iv);
    payload.set(ct, 12);
    for (const l of this.links) l.publish(payload);
  }

  close() {
    this.closed = true;
    for (const l of this.links) l.close();
  }
}
