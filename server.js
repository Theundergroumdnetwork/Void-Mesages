const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const port = Number(process.env.PORT || 8787);
const root = __dirname;
const clients = new Map();

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

  socket.on("data", (chunk) => {
    client.buffer = Buffer.concat([client.buffer, chunk]);
    readFrames(client);
  });

  socket.on("close", () => removeClient(client));
  socket.on("error", () => removeClient(client));
});

server.listen(port, "0.0.0.0", () => {
  console.log(`VOID CHAT running at http://localhost:${port}`);
  console.log("Open that address on this computer, or use this computer's Wi-Fi IP from another device.");
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
    if (client.id) clients.delete(client.id);
    client.id = cleanId(data.profile.id);
    client.name = String(data.profile.name || client.id).slice(0, 80);
    client.friends = new Set((data.friends || []).map(cleanId).filter(Boolean));
    clients.set(client.id, client);
    broadcastPresence();
  }

  if (data.type === "friends") {
    client.friends = new Set((data.friends || []).map(cleanId).filter(Boolean));
    broadcastPresence();
  }

  if (data.type === "message" && data.to && data.message) {
    const to = cleanId(data.to);
    const target = clients.get(to);
    const message = {
      id: String(data.message.id || crypto.randomUUID()),
      from: client.id,
      text: String(data.message.text || "").slice(0, 8000),
      time: Number(data.message.time || Date.now())
    };

    if (target && message.text) {
      send(target, { type: "message", message });
      send(client, { type: "delivered", to });
    } else {
      send(client, { type: "not-online", to });
    }
  }
}

function broadcastPresence() {
  for (const client of clients.values()) {
    const online = [];
    for (const friendId of client.friends) {
      if (clients.has(friendId)) online.push(friendId);
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
  if (client.id && clients.get(client.id) === client) {
    clients.delete(client.id);
    broadcastPresence();
  }
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
