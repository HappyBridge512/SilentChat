const { spawn } = require('child_process');
const { io } = require('socket.io-client');

const PORT = 3210;
const BASE_URL = `http://127.0.0.1:${PORT}`;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServerReady() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`${BASE_URL}/`);
      if (res.ok) return;
    } catch (_error) {
      // keep waiting
    }
    await delay(150);
  }
  throw new Error('Server did not start in time');
}

function parseRoomUrl(relativeUrl) {
  const url = new URL(relativeUrl, BASE_URL);
  const parts = url.pathname.split('/');
  return {
    roomId: parts[2],
    token: url.searchParams.get('t')
  };
}

function waitSocketEvent(socket, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);

    function handler(payload) {
      cleanup();
      resolve(payload);
    }

    function cleanup() {
      clearTimeout(timeout);
      socket.off(event, handler);
    }

    socket.on(event, handler);
  });
}

async function run() {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT), ENABLE_TUNNEL: 'false' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await waitForServerReady();

    const createRes = await fetch(`${BASE_URL}/api/rooms`, { method: 'POST' });
    const createData = await createRes.json();
    if (!createRes.ok) throw new Error('Failed to create room');

    const hostData = parseRoomUrl(createData.hostUrl);
    const guestData = parseRoomUrl(createData.inviteUrl);

    const hostSocket = io(BASE_URL, { transports: ['websocket'] });
    const guestSocket = io(BASE_URL, { transports: ['websocket'] });
    const thirdSocket = io(BASE_URL, { transports: ['websocket'] });

    const hostJoinPromise = waitSocketEvent(hostSocket, 'join-success');
    const guestJoinPromise = waitSocketEvent(guestSocket, 'join-success');
    hostSocket.emit('join-room', { roomId: hostData.roomId, token: hostData.token });
    guestSocket.emit('join-room', { roomId: guestData.roomId, token: guestData.token });

    const hostJoin = await hostJoinPromise;
    const guestJoin = await guestJoinPromise;
    if (hostJoin.participants < 1 || guestJoin.participants < 1) {
      throw new Error('Participants were not joined correctly');
    }

    const thirdErrorPromise = waitSocketEvent(thirdSocket, 'join-error');
    thirdSocket.emit('join-room', { roomId: guestData.roomId, token: guestData.token });
    const thirdError = await thirdErrorPromise;
    if (!thirdError) throw new Error('Third participant should be blocked');

    const roomEndedPromise = waitSocketEvent(guestSocket, 'room-ended');
    hostSocket.emit('leave-room');
    await roomEndedPromise;

    const afterEndSocket = io(BASE_URL, { transports: ['websocket'] });
    const afterEndErrorPromise = waitSocketEvent(afterEndSocket, 'join-error');
    afterEndSocket.emit('join-room', { roomId: hostData.roomId, token: hostData.token });
    const afterEndError = await afterEndErrorPromise;
    if (!afterEndError) throw new Error('Room should be destroyed after leave');

    afterEndSocket.close();
    hostSocket.close();
    guestSocket.close();
    thirdSocket.close();
    console.log('Smoke test passed');
  } finally {
    server.kill('SIGTERM');
  }
}

run().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
