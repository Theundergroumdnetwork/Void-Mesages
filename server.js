const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

const port = Number(process.env.PORT || 8787);
const root = __dirname;
const clients = new Set();
const clientsById = new Map();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const safePath = path.normalize(file).replace(/^(\.\.[/\\])+/, "");
  const fullPath = path.join(root, safePath);

  if (!fullPath.startsWith(root)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    res.writeHead(200, { "Content-Type": contentType(fullPath) });
    res.end(data);
  });
});

server.on("upgrade", (req, socket) => {
  if (req.url !== "/void-socket") {
    socket.destroy();
    return;
  }

  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    ""
  ].join("\r\n"));

  const client = { id: "", name: "", friends: new Set(), socket, buffer: Buffer.alloc(0) };
  clients.add(client);

  socket.on("data", (chunk) => {
    client.buffer = Buffer.concat([client.buffer, chunk]);
    readFrames(client);
  });

  socket.on("close", () => removeClient(client));
  socket.on("error", () => removeClient(client));
});

server.listen(port, "0.0.0.0", () => {
  console.log(`VOID CHAT running at http://localhost:${port}`);
  for (const address of localAddresses()) {
    console.log(`Wi-Fi/LAN URL: http://${address}:${port}`);
  }
  console.log("Everyone should open the same URL, or type the same host:port into the VOID server box.");
});

function readFrames(client) {
  while (client.buffer.length >= 2) {
    const first = client.buffer[0];
    const second = client.buffer[1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (client.buffer.length < offset + 2) return;
      length = client.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (client.buffer.length < offset + 8) return;
      const high = client.buffer.readUInt32BE(offset);
      const low = client.buffer.readUInt32BE(offset + 4);
      length = high * 2 ** 32 + low;
      offset += 8;
    }

    const maskOffset = offset;
    if (masked) offset += 4;
    if (client.buffer.length < offset + length) return;

    let payload = client.buffer.subarray(offset, offset + length);
    if (masked) {
      const mask = client.buffer.subarray(maskOffset, maskOffset + 4);
      payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
    }
    client.buffer = client.buffer.subarray(offset + length);

    if (opcode === 0x8) {
      removeClient(client);
      client.socket.end();
      return;
    }

    if (opcode === 0x1) {
      try {
        handleMessage(client, JSON.parse(payload.toString("utf8")));
      } catch {
        send(client, { type: "error", message: "Bad message" });
      }
    }
  }
}

function handleMessage(client, data) {
  if (data.type === "hello" && data.profile?.id) {
    removeClientId(client);
    client.id = cleanId(data.profile.id);
    client.name = String(data.profile.name || client.id).slice(0, 80);
    client.friends = new Set((data.friends || []).map(cleanId).filter(Boolean));
    addClientId(client);
    broadcastPresence();
  }

  if (data.type === "friends") {
    client.friends = new Set((data.friends || []).map(cleanId).filter(Boolean));
    broadcastPresence();
  }

  if (data.type === "message" && data.to && data.message) {
    const to = cleanId(data.to);
    const targets = clientsById.get(to);
    const message = {
      id: String(data.message.id || crypto.randomUUID()),
      from: client.id,
      text: String(data.message.text || "").slice(0, 8000),
      time: Number(data.message.time || Date.now())
    };

    if (targets?.size && message.text) {
      for (const target of targets) send(target, { type: "message", message });
      send(client, { type: "delivered", to });
    } else {
      send(client, { type: "not-online", to });
    }
  }
}

function broadcastPresence() {
  for (const client of clients) {
    if (!client.id) continue;
    const online = [];
    for (const friendId of client.friends) {
      if (clientsById.has(friendId)) online.push(friendId);
    }
    send(client, { type: "presence", online });
  }
}

function send(client, data) {
  if (client.socket.destroyed) return;
  const payload = Buffer.from(JSON.stringify(data));
  const header = [];
  header.push(0x81);
  if (payload.length < 126) {
    header.push(payload.length);
  } else if (payload.length < 65536) {
    header.push(126, payload.length >> 8, payload.length & 255);
  } else {
    header.push(127, 0, 0, 0, 0);
    header.push((payload.length >> 24) & 255, (payload.length >> 16) & 255, (payload.length >> 8) & 255, payload.length & 255);
  }
  client.socket.write(Buffer.concat([Buffer.from(header), payload]));
}

function removeClient(client) {
  const hadId = Boolean(client.id);
  removeClientId(client);
  clients.delete(client);
  if (hadId) broadcastPresence();
}

function addClientId(client) {
  if (!client.id) return;
  if (!clientsById.has(client.id)) clientsById.set(client.id, new Set());
  clientsById.get(client.id).add(client);
}

function removeClientId(client) {
  if (!client.id) return;
  const matches = clientsById.get(client.id);
  if (matches) {
    matches.delete(client);
    if (!matches.size) clientsById.delete(client.id);
  }
  client.id = "";
}

function cleanId(value) {
  const id = String(value || "").trim().toLowerCase().replace(/\s+/g, "-");
  return /^[a-z0-9_-]{2,40}$/.test(id) ? id : "";
}

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  return "application/octet-stream";
}

function localAddresses() {
  const addresses = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) addresses.push(entry.address);
    }
  }
  return addresses;
}
