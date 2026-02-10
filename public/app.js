import React, { useMemo, useRef, useState } from "https://esm.sh/react@18.3.1";
import { createRoot } from "https://esm.sh/react-dom@18.3.1/client";
import htm from "https://esm.sh/htm@3.1.1";

const html = htm.bind(React.createElement);

const CHUNK_SIZE = 64 * 1024;
const MAX_BUFFERED_AMOUNT = 8 * 1024 * 1024;
const DB_NAME = "p2p-file-transfer-lite";
const DB_STORE = "chunks";
const STUN_CONFIG = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};

let dbPromise = null;

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        const store = db.createObjectStore(DB_STORE, { keyPath: "id" });
        store.createIndex("fileId", "fileId");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function putChunk(fileId, index, data) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).put({ id: `${fileId}:${index}`, fileId, index, data });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getChunk(fileId, index) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readonly");
    const req = tx.objectStore(DB_STORE).get(`${fileId}:${index}`);
    req.onsuccess = () => resolve(req.result ? req.result.data : null);
    req.onerror = () => reject(req.error);
  });
}

async function clearChunks(fileId) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    const idx = tx.objectStore(DB_STORE).index("fileId");
    const cursorReq = idx.openCursor(IDBKeyRange.only(fileId));
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function resumeMetaKey(fileId) {
  return `resume-meta:${fileId}`;
}

function saveResumeMeta(meta) {
  localStorage.setItem(resumeMetaKey(meta.fileId), JSON.stringify(meta));
}

function loadResumeMeta(fileId) {
  const raw = localStorage.getItem(resumeMetaKey(fileId));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function clearResumeMeta(fileId) {
  localStorage.removeItem(resumeMetaKey(fileId));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256HexOfBlob(blob) {
  const buffer = await blob.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  return bytesToHex(new Uint8Array(hashBuffer));
}

function App() {
  const [roomId, setRoomId] = useState("");
  const [roomPassword, setRoomPassword] = useState("");
  const [serverOrigin, setServerOrigin] = useState(window.location.origin);
  const [signalState, setSignalState] = useState("未连接");
  const [peerState, setPeerState] = useState("未连接");
  const [channelState, setChannelState] = useState("未连接");
  const [status, setStatus] = useState("输入房间号后连接");
  const [selectedFile, setSelectedFile] = useState(null);
  const [sendProgress, setSendProgress] = useState(0);
  const [receiveProgress, setReceiveProgress] = useState(0);
  const [receiveInfo, setReceiveInfo] = useState(null);
  const [downloadUrl, setDownloadUrl] = useState("");
  const [downloadName, setDownloadName] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [isHashing, setIsHashing] = useState(false);

  const wsRef = useRef(null);
  const pcRef = useRef(null);
  const dcRef = useRef(null);
  const sendTaskRef = useRef({
    active: false,
    paused: false,
    file: null,
    meta: null,
    nextIndex: 0,
    token: 0,
    pumping: false
  });
  const recvTaskRef = useRef({
    meta: null,
    receivedCount: 0
  });

  const canSend = useMemo(() => {
    return channelState === "已连接" && selectedFile && !isSending && !isHashing;
  }, [channelState, selectedFile, isSending, isHashing]);

  function closeResources() {
    if (dcRef.current) {
      dcRef.current.onopen = null;
      dcRef.current.onclose = null;
      dcRef.current.onmessage = null;
      dcRef.current.close();
      dcRef.current = null;
    }
    if (pcRef.current) {
      pcRef.current.onicecandidate = null;
      pcRef.current.onconnectionstatechange = null;
      pcRef.current.ondatachannel = null;
      pcRef.current.close();
      pcRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.onopen = null;
      wsRef.current.onmessage = null;
      wsRef.current.onclose = null;
      wsRef.current.close();
      wsRef.current = null;
    }
    setSignalState("未连接");
    setPeerState("未连接");
    setChannelState("未连接");
  }

  function setChannel(channel) {
    dcRef.current = channel;
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = 1 * 1024 * 1024;
    channel.onopen = () => {
      setChannelState("已连接");
      setStatus("P2P 通道已建立");
      tryResumeSender();
    };
    channel.onclose = () => {
      setChannelState("已连接断开");
      setStatus("P2P 通道断开，可重连房间后继续");
    };
    channel.onmessage = async (event) => {
      if (typeof event.data === "string") {
        await handleChannelJson(event.data);
      } else {
        await handleIncomingChunk(event.data);
      }
    };
  }

  async function createPeerConnection() {
    const pc = new RTCPeerConnection(STUN_CONFIG);
    pcRef.current = pc;
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal({
          type: "candidate",
          candidate: event.candidate
        });
      }
    };
    pc.onconnectionstatechange = () => {
      setPeerState(pc.connectionState || "未知");
    };
    pc.ondatachannel = (event) => {
      setChannel(event.channel);
    };
    return pc;
  }

  function sendSignal(payload) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "signal", payload }));
  }

  async function createOffer() {
    const pc = pcRef.current || (await createPeerConnection());
    if (!dcRef.current) {
      const channel = pc.createDataChannel("file");
      setChannel(channel);
    }
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignal({ type: "offer", sdp: offer });
    setStatus("已发送 Offer，等待对端应答");
  }

  async function handleSignal(payload) {
    const pc = pcRef.current || (await createPeerConnection());
    if (payload.type === "offer") {
      await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal({ type: "answer", sdp: answer });
      setStatus("收到 Offer 并已回复 Answer");
      return;
    }
    if (payload.type === "answer") {
      await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
      setStatus("收到 Answer，等待 DataChannel 打开");
      return;
    }
    if (payload.type === "candidate" && payload.candidate) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
      } catch {
        // ignore candidate race errors for lightweight flow
      }
    }
  }

  function connectRoom() {
    if (!roomId.trim()) {
      setStatus("请先输入房间号");
      return;
    }
    if (!roomPassword.trim()) {
      setStatus("请先输入房间密码");
      return;
    }
    closeResources();
    const wsUrl = serverOrigin.replace(/^http/, "ws") + "/ws";
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    setSignalState("连接中");
    setStatus("正在连接信令服务器...");

    ws.onopen = async () => {
      setSignalState("已连接");
      await createPeerConnection();
      ws.send(
        JSON.stringify({
          type: "join",
          roomId: roomId.trim(),
          password: roomPassword.trim()
        })
      );
      setStatus(`已加入房间 ${roomId.trim()}，等待对端`);
    };

    ws.onmessage = async (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === "joined") {
        setStatus(`已加入房间 ${msg.roomId}（当前 ${msg.peerCount}/2）`);
        return;
      }
      if (msg.type === "room-full") {
        setStatus("房间已满（最多 2 人）");
        return;
      }
      if (msg.type === "auth-failed") {
        setStatus(`鉴权失败：${msg.message || "密码错误"}`);
        return;
      }
      if (msg.type === "error") {
        setStatus(`信令错误：${msg.message || "未知错误"}`);
        return;
      }
      if (msg.type === "initiate-offer") {
        await createOffer();
        return;
      }
      if (msg.type === "wait-offer") {
        setStatus("等待房主发送 Offer");
        return;
      }
      if (msg.type === "peer-left") {
        setStatus("对端已离开，可等待其重连");
        setChannelState("未连接");
        return;
      }
      if (msg.type === "signal") {
        await handleSignal(msg.payload);
      }
    };

    ws.onclose = () => {
      setSignalState("已断开");
      setStatus("信令连接断开");
    };
  }

  function channelSendJson(data) {
    const channel = dcRef.current;
    if (!channel || channel.readyState !== "open") return false;
    channel.send(JSON.stringify(data));
    return true;
  }

  async function buildFileMeta(file) {
    const fileId = `${file.name}:${file.size}:${file.lastModified}`;
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const sha256 = await sha256HexOfBlob(file);
    return {
      fileId,
      name: file.name,
      size: file.size,
      type: file.type || "application/octet-stream",
      chunkSize: CHUNK_SIZE,
      totalChunks,
      sha256
    };
  }

  async function startSend() {
    const channel = dcRef.current;
    if (!channel || channel.readyState !== "open") {
      setStatus("DataChannel 未连接");
      return;
    }
    if (!selectedFile) {
      setStatus("请先选择文件");
      return;
    }
    setIsHashing(true);
    setStatus("正在计算文件 SHA-256，请稍候...");
    let meta;
    try {
      meta = await buildFileMeta(selectedFile);
    } catch {
      setStatus("SHA-256 计算失败，请重试");
      return;
    } finally {
      setIsHashing(false);
    }
    sendTaskRef.current = {
      active: true,
      paused: false,
      file: selectedFile,
      meta,
      nextIndex: 0,
      token: Date.now(),
      pumping: false
    };
    setIsSending(true);
    setIsPaused(false);
    setSendProgress(0);
    setStatus(`已发送文件元信息：${meta.name}（含 SHA-256）`);
    channelSendJson({ type: "file-meta", meta });
  }

  function pauseSend() {
    sendTaskRef.current.paused = true;
    setIsPaused(true);
    setStatus("发送已暂停");
  }

  function resumeSend() {
    sendTaskRef.current.paused = false;
    setIsPaused(false);
    const task = sendTaskRef.current;
    if (task.active && task.meta) {
      channelSendJson({ type: "file-meta", meta: task.meta });
      setStatus("已尝试续传，等待对端返回断点");
    }
  }

  function cancelSend() {
    const task = sendTaskRef.current;
    task.token += 1;
    task.active = false;
    task.paused = false;
    task.pumping = false;
    setIsSending(false);
    setIsPaused(false);
    setSendProgress(0);
    if (task.meta) {
      channelSendJson({ type: "cancel", fileId: task.meta.fileId });
    }
    setStatus("已取消发送");
  }

  async function tryResumeSender() {
    const task = sendTaskRef.current;
    if (task.active && task.meta) {
      channelSendJson({ type: "file-meta", meta: task.meta });
      setStatus("通道恢复，已重新发送元信息以续传");
    }
  }

  async function handleChannelJson(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === "file-meta") {
      const meta = msg.meta;
      recvTaskRef.current.meta = meta;
      setReceiveInfo(meta);
      setDownloadUrl("");
      setDownloadName("");
      let resumeFrom = 0;
      const saved = loadResumeMeta(meta.fileId);
      if (
        saved &&
        saved.totalChunks === meta.totalChunks &&
        saved.size === meta.size &&
        saved.sha256 === meta.sha256
      ) {
        resumeFrom = Math.min(saved.receivedCount || 0, meta.totalChunks);
      }
      recvTaskRef.current.receivedCount = resumeFrom;
      setReceiveProgress(meta.totalChunks === 0 ? 0 : resumeFrom / meta.totalChunks);
      channelSendJson({ type: "resume-from", fileId: meta.fileId, index: resumeFrom });
      setStatus(`准备接收 ${meta.name}，从分片 #${resumeFrom} 续传`);
      return;
    }

    if (msg.type === "resume-from") {
      const task = sendTaskRef.current;
      if (!task.active || !task.meta) return;
      if (msg.fileId !== task.meta.fileId) return;
      task.nextIndex = Math.max(0, Math.min(msg.index || 0, task.meta.totalChunks));
      setStatus(`对端断点为 #${task.nextIndex}，开始发送`);
      await pumpChunks(task.token);
      return;
    }

    if (msg.type === "transfer-complete") {
      if (sendTaskRef.current.meta && msg.fileId === sendTaskRef.current.meta.fileId) {
        setStatus("发送完成");
        setIsSending(false);
        setIsPaused(false);
      }
      return;
    }

    if (msg.type === "cancel") {
      const recvMeta = recvTaskRef.current.meta;
      if (recvMeta && recvMeta.fileId === msg.fileId) {
        setStatus("对端取消了发送");
      }
    }
  }

  async function waitBufferedLow(channel) {
    if (channel.bufferedAmount <= MAX_BUFFERED_AMOUNT) return;
    await new Promise((resolve) => {
      const done = () => {
        channel.removeEventListener("bufferedamountlow", done);
        resolve();
      };
      channel.addEventListener("bufferedamountlow", done, { once: true });
    });
  }

  async function pumpChunks(token) {
    const task = sendTaskRef.current;
    if (!task.active || !task.meta || !task.file) return;
    if (task.pumping) return;
    task.pumping = true;

    const channel = dcRef.current;
    if (!channel || channel.readyState !== "open") {
      task.pumping = false;
      return;
    }

    const { file, meta } = task;
    while (task.active && !task.paused && token === task.token && task.nextIndex < meta.totalChunks) {
      if (!dcRef.current || dcRef.current.readyState !== "open") break;
      await waitBufferedLow(dcRef.current);

      const index = task.nextIndex;
      const start = index * meta.chunkSize;
      const end = Math.min(start + meta.chunkSize, meta.size);
      const buffer = await file.slice(start, end).arrayBuffer();
      const packet = new Uint8Array(buffer.byteLength + 4);
      const view = new DataView(packet.buffer);
      view.setUint32(0, index, true);
      packet.set(new Uint8Array(buffer), 4);
      dcRef.current.send(packet.buffer);

      task.nextIndex += 1;
      setSendProgress(meta.totalChunks === 0 ? 0 : task.nextIndex / meta.totalChunks);
      if (task.nextIndex % 32 === 0) {
        await sleep(0);
      }
    }

    if (task.active && task.nextIndex >= task.meta.totalChunks) {
      channelSendJson({ type: "transfer-complete", fileId: task.meta.fileId });
      setStatus("发送完成");
      setIsSending(false);
      setIsPaused(false);
      task.active = false;
    }

    task.pumping = false;
  }

  async function finalizeReceive(meta) {
    const chunks = [];
    for (let i = 0; i < meta.totalChunks; i += 1) {
      const chunk = await getChunk(meta.fileId, i);
      if (!chunk) {
        setStatus("分片缺失，无法合并，请重试续传");
        return;
      }
      chunks.push(chunk);
    }
    const blob = new Blob(chunks, { type: meta.type || "application/octet-stream" });
    const receivedSha256 = await sha256HexOfBlob(blob);
    if (meta.sha256 && receivedSha256 !== meta.sha256) {
      setStatus("接收完成但校验失败（SHA-256 不一致），请重试传输");
      return;
    }
    if (downloadUrl) {
      URL.revokeObjectURL(downloadUrl);
    }
    const url = URL.createObjectURL(blob);
    setDownloadUrl(url);
    setDownloadName(meta.name);
    setStatus("接收完成且校验通过，可点击下载");
    await clearChunks(meta.fileId);
    clearResumeMeta(meta.fileId);
  }

  async function handleIncomingChunk(buffer) {
    const meta = recvTaskRef.current.meta;
    if (!meta) return;
    const dv = new DataView(buffer);
    const index = dv.getUint32(0, true);
    const expected = recvTaskRef.current.receivedCount;
    if (index < expected) return;
    if (index > expected) return;

    const data = buffer.slice(4);
    await putChunk(meta.fileId, index, data);
    recvTaskRef.current.receivedCount += 1;
    const receivedCount = recvTaskRef.current.receivedCount;
    setReceiveProgress(meta.totalChunks === 0 ? 0 : receivedCount / meta.totalChunks);

    if (receivedCount % 32 === 0 || receivedCount === meta.totalChunks) {
      saveResumeMeta({
        fileId: meta.fileId,
        totalChunks: meta.totalChunks,
        receivedCount,
        size: meta.size,
        sha256: meta.sha256
      });
    }

    if (receivedCount >= meta.totalChunks) {
      await finalizeReceive(meta);
    }
  }

  return html`
    <div className="app">
      <div className="card">
        <h2>P2P 文件传输 Lite</h2>
        <p className="muted">
          React + WebRTC + WebSocket（2 人房间），支持分片和断点续传。
        </p>
      </div>

      <div className="card">
        <div className="row">
          <input
            type="text"
            placeholder="房间号，例如 1001"
            value=${roomId}
            onInput=${(e) => setRoomId(e.target.value)}
          />
          <input
            type="password"
            placeholder="房间密码"
            value=${roomPassword}
            onInput=${(e) => setRoomPassword(e.target.value)}
          />
          <button onClick=${connectRoom}>连接房间</button>
          <button className="secondary" onClick=${closeResources}>断开</button>
        </div>
        <div className="row" style=${{ marginTop: "10px" }}>
          <input
            type="text"
            style=${{ width: "100%" }}
            placeholder="信令服务器地址，如 http://localhost:8080"
            value=${serverOrigin}
            onInput=${(e) => setServerOrigin(e.target.value)}
          />
        </div>
        <p className="muted">
          信令：<span className="mono">${signalState}</span> | Peer：
          <span className="mono">${peerState}</span> | DataChannel：
          <span className="mono">${channelState}</span>
        </p>
        <p>${status}</p>
      </div>

      <div className="card">
        <h3>发送文件</h3>
        <div className="row">
          <input
            type="file"
            onChange=${(e) => {
              const file = e.target.files && e.target.files[0] ? e.target.files[0] : null;
              setSelectedFile(file);
            }}
          />
          <button disabled=${!canSend} onClick=${startSend}>开始发送</button>
          <button className="secondary" disabled=${!isSending || isPaused} onClick=${pauseSend}>
            暂停
          </button>
          <button className="secondary" disabled=${!isSending || !isPaused} onClick=${resumeSend}>
            继续
          </button>
          <button className="secondary" disabled=${!isSending} onClick=${cancelSend}>
            取消
          </button>
        </div>
        <p className="muted">
          ${selectedFile
            ? `文件：${selectedFile.name} (${formatBytes(selectedFile.size)})`
            : "未选择文件"}
        </p>
        ${isHashing ? html`<p className="muted">正在计算 SHA-256...</p>` : ""}
        <progress value=${sendProgress} max="1"></progress>
        <p className="muted">发送进度：${(sendProgress * 100).toFixed(2)}%</p>
      </div>

      <div className="card">
        <h3>接收文件</h3>
        <p className="muted">
          ${receiveInfo
            ? `文件：${receiveInfo.name} (${formatBytes(receiveInfo.size)})`
            : "等待对端发送文件"}
        </p>
        <p className="muted">
          ${receiveInfo?.sha256 ? `SHA-256：${receiveInfo.sha256}` : "SHA-256：待接收"}
        </p>
        <progress value=${receiveProgress} max="1"></progress>
        <p className="muted">接收进度：${(receiveProgress * 100).toFixed(2)}%</p>
        ${downloadUrl
          ? html`<p>
              <a className="success" href=${downloadUrl} download=${downloadName}>
                下载 ${downloadName}
              </a>
            </p>`
          : ""}
      </div>
    </div>
  `;
}

createRoot(document.getElementById("root")).render(html`<${App} />`);
