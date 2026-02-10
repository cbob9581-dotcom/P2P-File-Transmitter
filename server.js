const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, "public");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

const rooms = new Map();

function hashPassword(password) {
  return crypto.createHash("sha256").update(password).digest("hex");
}

function sendJson(ws, data) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      clients: new Set(),
      passwordHash: null
    });
  }
  return rooms.get(roomId);
}

function relayToPeer(ws, payload) {
  const roomId = ws.roomId;
  if (!roomId || !rooms.has(roomId)) return;
  const room = rooms.get(roomId);
  for (const client of room.clients) {
    if (client !== ws && client.readyState === client.OPEN) {
      sendJson(client, payload);
    }
  }
}

function cleanupWs(ws) {
  const roomId = ws.roomId;
  if (!roomId || !rooms.has(roomId)) return;
  const room = rooms.get(roomId);
  room.clients.delete(ws);
  relayToPeer(ws, { type: "peer-left" });
  if (room.clients.size === 0) {
    rooms.delete(roomId);
  }
}

const server = http.createServer((req, res) => {
  const urlPath = req.url === "/" ? "/index.html" : req.url;
  const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(content);
  });
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch (e) {
      return;
    }

    if (message.type === "join") {
      const roomId = String(message.roomId || "").trim();
      const password = String(message.password || "").trim();
      if (!roomId) {
        sendJson(ws, { type: "error", message: "roomId required" });
        return;
      }
      if (!password) {
        sendJson(ws, { type: "auth-failed", message: "password required" });
        return;
      }
      if (ws.roomId) {
        sendJson(ws, { type: "error", message: "already in room" });
        return;
      }

      const room = getRoom(roomId);
      const inputPasswordHash = hashPassword(password);
      if (room.passwordHash === null) {
        room.passwordHash = inputPasswordHash;
      } else if (room.passwordHash !== inputPasswordHash) {
        sendJson(ws, { type: "auth-failed", message: "invalid password" });
        return;
      }

      if (room.clients.size >= 2) {
        sendJson(ws, { type: "room-full" });
        return;
      }

      ws.roomId = roomId;
      room.clients.add(ws);
      sendJson(ws, {
        type: "joined",
        roomId,
        peerCount: room.clients.size
      });

      if (room.clients.size === 2) {
        const [first, second] = Array.from(room.clients);
        sendJson(first, { type: "initiate-offer" });
        sendJson(second, { type: "wait-offer" });
        sendJson(first, { type: "peer-joined" });
        sendJson(second, { type: "peer-joined" });
      }
      return;
    }

    if (message.type === "signal") {
      relayToPeer(ws, { type: "signal", payload: message.payload });
      return;
    }
  });

  ws.on("close", () => cleanupWs(ws));
  ws.on("error", () => cleanupWs(ws));
});

server.listen(PORT, () => {
  console.log(`Server running: http://localhost:${PORT}`);
});
