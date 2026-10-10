# BiteDrop

Send files directly from one browser to another. Open the page on both devices, share a short code, drop files. They travel peer-to-peer and are never uploaded anywhere.

- **No accounts, no install, no backend.** BiteDrop is a single static page. It works in any current Chrome, Safari, Firefox or Edge, on phones and computers.
- **Peer-to-peer and end-to-end encrypted.** Files go over a direct WebRTC connection, encrypted with DTLS.
- **Both directions.** Once connected, either side can send. Every transfer shows live progress and confirms delivery.

## How to use

1. On device A, open BiteDrop and tap **Create code**.
2. On device B, open BiteDrop and enter the code, or open the link from **Copy link** / **Share…**.
3. Drop files on either side.

### Connect without any server

Under **Connect without any server**, the two devices swap a pair of longer codes by copy-paste: one code, then a reply. This works even if the code relays are unreachable, and on the same network nothing outside it is involved.

## What touches a server, exactly

| Step | Who's involved | What they see |
|---|---|---|
| Loading the page | GitHub Pages | That you loaded the page |
| Short-code handshake | Free public MQTT brokers (HiveMQ, EMQX, Mosquitto) | ~2 KB of data encrypted with a key derived from your code. They can't read or forge it. |
| Finding a route | Public STUN servers (Google, Cloudflare) | Your public IP address, nothing else |
| **The files** | **Only the two devices** | — |

Copy-paste mode skips the brokers entirely.

## Limitations

- **Both devices must stay open** until the transfer finishes. On phones, keep BiteDrop in the foreground: backgrounded tabs can be paused.
- **Some networks block direct connections**, mainly mobile carriers (carrier-grade NAT) and some offices. BiteDrop doesn't use relay (TURN) servers, so those connections fail. Devices on the same Wi-Fi almost always connect.
- **Received files are held in memory** until saved. Multi-GB files may fail on phones, especially iPhone.
- **A code is single-use.** It connects the first device that joins, then stops listening.

## Running it yourself

It's plain HTML, CSS and JavaScript with no build step. Serve the folder from any static host. It must be served over HTTPS (or `localhost`), because browsers only allow WebRTC and Web Crypto on secure pages.

```sh
python3 -m http.server 8000   # then open http://localhost:8000
```

| File | What it does |
|---|---|
| `index.html`, `style.css` | The page |
| `js/app.js` | Connection flows (short code and copy-paste) and the file transfer protocol |
| `js/signal.js` | Minimal MQTT-over-WebSocket client and the code-derived encryption for the handshake |
