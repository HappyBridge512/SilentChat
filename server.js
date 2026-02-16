const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const express = require('express');
const http = require('http');
const multer = require('multer');
const { Server } = require('socket.io');
const { RoomManager } = require('./room-manager');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ENABLE_TUNNEL = process.env.ENABLE_TUNNEL === 'true';
const MAX_MESSAGE_LENGTH = 2000;
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS || 60 * 60 * 1000);
const ROOM_CLEANUP_INTERVAL_MS = Number(process.env.ROOM_CLEANUP_INTERVAL_MS || 60 * 1000);

const uploadsDir = path.join(__dirname, 'uploads');

const roomManager = new RoomManager({
  uploadsDir,
  maxMessageLength: MAX_MESSAGE_LENGTH,
  roomTtlMs: ROOM_TTL_MS
});

let tunnelPublicUrl = '';
let tunnelInstance = null;
let roomCleanupTimer = null;

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}-${safeName}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_FILE_SIZE
  }
});

app.use(express.json());
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' ws: wss:; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
  );
  next();
});

const staticOptions = {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
};

app.use('/uploads', express.static(uploadsDir, staticOptions));
app.use(express.static(path.join(__dirname, 'public'), staticOptions));

function getLanIpAddress() {
  const interfaces = os.networkInterfaces();
  const fallback = [];

  for (const values of Object.values(interfaces)) {
    if (!values) continue;

    for (const info of values) {
      if (info.family !== 'IPv4' || info.internal) continue;

      const ip = info.address;
      const isPrivate =
        ip.startsWith('10.') ||
        ip.startsWith('192.168.') ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip);

      if (isPrivate) return ip;
      fallback.push(ip);
    }
  }

  return fallback[0] || null;
}

function buildOrigins(req) {
  const reqHost = req.get('host');
  const localOrigin = `${req.protocol}://${reqHost}`;
  const envOrigin = process.env.PUBLIC_BASE_URL;

  if (envOrigin) {
    return { localOrigin, publicOrigin: envOrigin };
  }

  if (tunnelPublicUrl) {
    return { localOrigin, publicOrigin: tunnelPublicUrl };
  }

  const isLocalHost =
    reqHost?.includes('localhost') ||
    reqHost?.startsWith('127.0.0.1') ||
    reqHost?.startsWith('[::1]');

  if (!isLocalHost) {
    return { localOrigin, publicOrigin: localOrigin };
  }

  const lanIp = getLanIpAddress();
  if (!lanIp) {
    return { localOrigin, publicOrigin: localOrigin };
  }

  return {
    localOrigin,
    publicOrigin: `http://${lanIp}:${PORT}`
  };
}

async function setupTunnel() {
  if (!ENABLE_TUNNEL) return;

  try {
    const { Tunnel } = require('cloudflared');
    tunnelInstance = Tunnel.quick(`http://127.0.0.1:${PORT}`);

    tunnelInstance.once('url', (url) => {
      tunnelPublicUrl = url;
      console.log(`Public tunnel URL: ${tunnelPublicUrl}`);
    });

    tunnelInstance.on('error', (error) => {
      console.error('Cloudflare tunnel error:', error.message || error);
    });

    tunnelInstance.on('exit', () => {
      tunnelPublicUrl = '';
      tunnelInstance = null;
      console.log('Tunnel closed');
    });
  } catch (error) {
    console.error('Failed to start tunnel:', error.message);
  }
}

async function cleanupUploadsDir() {
  try {
    const entries = await fs.readdir(uploadsDir, { withFileTypes: true });
    const deletions = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      deletions.push(fs.unlink(path.join(uploadsDir, entry.name)).catch(() => null));
    }
    await Promise.all(deletions);
  } catch (_error) {
    // Ignore upload dir cleanup failures on startup.
  }
}

async function transportRoomDestroyed(destroyResult) {
  if (!destroyResult) return;

  for (const socketId of destroyResult.socketIds) {
    const socket = io.sockets.sockets.get(socketId);
    if (!socket) continue;

    socket.emit('room-ended', {
      reason: destroyResult.reason,
      bySelf: destroyResult.initiatorSocketId === socketId
    });

    socket.leave(destroyResult.roomId);
    socket.disconnect(true);
  }
}

app.post('/api/rooms', (req, res) => {
  const room = roomManager.createRoom();
  const { localOrigin, publicOrigin } = buildOrigins(req);

  const hostPath = `/room/${room.id}?t=${room.hostToken}`;
  const invitePath = `/room/${room.id}?t=${room.guestToken}`;

  res.json({
    roomId: room.id,
    hostUrl: hostPath,
    inviteUrl: invitePath,
    hostUrlLocal: `${localOrigin}${hostPath}`,
    inviteUrlLocal: `${localOrigin}${invitePath}`,
    hostUrlPublic: `${publicOrigin}${hostPath}`,
    inviteUrlPublic: `${publicOrigin}${invitePath}`
  });
});

app.post('/api/rooms/:roomId/upload', upload.single('file'), (req, res) => {
  const result = roomManager.createUploadMessage({
    roomId: req.params.roomId,
    token: typeof req.query.t === 'string' ? req.query.t : '',
    file: req.file
  });

  if (result.error) {
    if (req.file) fs.unlink(req.file.path).catch(() => null);
    return res.status(result.status || 400).json({ error: result.error });
  }

  io.to(result.roomId).emit('chat-message', result.message);
  return res.json({ ok: true });
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      error: `Файл завеликий. Максимальний розмір: ${Math.floor(MAX_FILE_SIZE / (1024 * 1024))}MB.`
    });
  }

  if (error instanceof multer.MulterError) {
    return res.status(400).json({ error: 'Помилка завантаження файлу.' });
  }

  return res.status(500).json({ error: 'Внутрішня помилка сервера.' });
});

app.get(['/room/:roomId', '/'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

io.on('connection', (socket) => {
  socket.on('join-room', (payload = {}) => {
    const roomId = typeof payload.roomId === 'string' ? payload.roomId : '';
    const token = typeof payload.token === 'string' ? payload.token : '';

    const result = roomManager.joinRoom({ roomId, token, socketId: socket.id });

    if (result.error) {
      socket.emit('join-error', result.error);
      return;
    }

    socket.data.roomId = result.room.id;
    socket.data.role = result.role;
    socket.join(result.room.id);

    socket.emit('join-success', {
      role: result.role,
      roleLabel: result.roleLabel,
      roomId: result.room.id,
      participants: result.participantsCount,
      history: result.history
    });

    if (result.systemToSelf) {
      socket.emit('system-message', { text: result.systemToSelf });
    }

    if (result.systemToRoom) {
      io.to(result.room.id).emit('system-message', { text: result.systemToRoom });
    }
  });

  socket.on('chat-message', (payload = {}) => {
    const result = roomManager.createTextMessage(socket.id, payload);
    if (result.error) return;

    io.to(result.roomId).emit('chat-message', result.message);
  });

  socket.on('typing-start', () => {
    const typing = roomManager.setTyping(socket.id, true);
    if (!typing) return;

    socket.to(typing.roomId).emit('peer-typing', {
      isTyping: true,
      senderRole: typing.senderRole,
      senderLabel: typing.senderLabel
    });
  });

  socket.on('typing-stop', () => {
    const typing = roomManager.setTyping(socket.id, false);
    if (!typing) return;

    socket.to(typing.roomId).emit('peer-typing', {
      isTyping: false,
      senderRole: typing.senderRole,
      senderLabel: typing.senderLabel
    });
  });

  socket.on('leave-room', async () => {
    const destroyed = await roomManager.leaveBySocket(
      socket.id,
      'Один з учасників покинув кімнату. Чат завершено.'
    );

    await transportRoomDestroyed(destroyed);
  });

  socket.on('disconnect', async () => {
    const destroyed = await roomManager.disconnectBySocket(
      socket.id,
      'Один з учасників вийшов або втратив з\'єднання. Чат завершено.'
    );

    await transportRoomDestroyed(destroyed);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Server started on http://${HOST}:${PORT}`);
  setupTunnel();
  cleanupUploadsDir().catch(() => null);
  roomCleanupTimer = setInterval(async () => {
    const destroyedRooms = await roomManager.expireInactiveRooms('Час життя кімнати вичерпано. Чат завершено.');
    for (const destroyed of destroyedRooms) {
      await transportRoomDestroyed(destroyed);
    }
  }, ROOM_CLEANUP_INTERVAL_MS);
});

async function shutdown() {
  if (tunnelInstance) {
    try {
      if (typeof tunnelInstance.stop === 'function') {
        tunnelInstance.stop();
      } else if (typeof tunnelInstance.close === 'function') {
        tunnelInstance.close();
      }
    } catch (_error) {
      // Ignore tunnel close failures during shutdown.
    }
  }

  if (roomCleanupTimer) {
    clearInterval(roomCleanupTimer);
    roomCleanupTimer = null;
  }

  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
