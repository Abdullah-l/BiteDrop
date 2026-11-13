# BiteDrop

Send files and text directly from one browser to another. Open [bd.almanie.dev](https://bd.almanie.dev) on both devices, share a 4-digit code, then drop files or type text. Everything travels peer-to-peer and is never uploaded anywhere.

- **No accounts, no install, no backend.** BiteDrop is a single static page. It works in any current Chrome, Safari, Firefox or Edge, on phones and computers.
- **Peer-to-peer and end-to-end encrypted.** Files and text go over a direct WebRTC connection, encrypted with DTLS. BiteDrop checks the DTLS session is up before it lets anything send, and shows a security code built from both devices' DTLS fingerprints. If the codes match on both screens, nobody is in the middle.
- **Both directions.** Once connected, either side can send. Every transfer shows live progress and confirms delivery.

## How to use

1. On device A, open BiteDrop and tap **Create code**.
2. On device B, open the link it shows (like `bd.almanie.dev/4829`), or open BiteDrop and type the code. It connects as soon as the fourth digit is in.
3. Drop files or type text on either side. Received text shows inline with a **Copy** button.
4. Optionally, check that the security code under the text box is the same on both devices.

## What touches a server, exactly

| Step | Who's involved | What they see |
|---|---|---|
| Loading the page | GitHub Pages | That you loaded the page |
| Short-code handshake | Free public MQTT brokers (HiveMQ, EMQX, Mosquitto) | ~2 KB of data encrypted with a key derived from your code. They can't read or forge it. |
| Finding a route | Public STUN servers (Google, Cloudflare) | Your public IP address, nothing else |
| **The files and text** | **Only the two devices** | — |


## Limitations

- **Both devices must stay open** until the transfer finishes. On phones, keep BiteDrop in the foreground: backgrounded tabs can be paused.
- **Some networks block direct connections**, mainly mobile carriers (carrier-grade NAT) and some offices. BiteDrop doesn't use relay (TURN) servers, so those connections fail. Devices on the same Wi-Fi almost always connect.
- **Received files are held in memory** until saved. Multi-GB files may fail on phones, especially iPhone.
- **A code is single-use.** It connects the first device that joins, then stops listening.
- **Codes are short on purpose.** Four digits are easy to share but only 10,000 combinations, so the code protects the handshake from casual snooping, not from someone actively trying to guess it while you wait. Comparing the security code on both devices closes that gap: an attacker in the middle can't make the two codes match.

## Running it yourself

It's plain HTML, CSS and JavaScript with no build step. Serve the folder from any static host. It must be served over HTTPS (or `localhost`), because browsers only allow WebRTC and Web Crypto on secure pages.

```sh
python3 -m http.server 8000   # then open http://localhost:8000
```

Links like `/4829` need the host to serve `index.html` for paths it doesn't know. Cloudflare Pages does this by default (as long as there's no `404.html`); elsewhere, typing the code on the start screen always works.

| File | What it does |
|---|---|
| `index.html`, `style.css` | The page |
| `js/app.js` | The short-code connection flow and the file transfer protocol |
| `js/signal.js` | Minimal MQTT-over-WebSocket client and the code-derived encryption for the handshake |
