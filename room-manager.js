const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const ROOM_STATES = Object.freeze({
  CREATED: 'CREATED',
  WAITING_SECOND: 'WAITING_SECOND',
  ACTIVE: 'ACTIVE',
  DESTROYED: 'DESTROYED'
});

const ALLOWED_TRANSITIONS = Object.freeze({
  [ROOM_STATES.CREATED]: new Set([ROOM_STATES.WAITING_SECOND]),
  [ROOM_STATES.WAITING_SECOND]: new Set([ROOM_STATES.ACTIVE, ROOM_STATES.DESTROYED]),
  [ROOM_STATES.ACTIVE]: new Set([ROOM_STATES.DESTROYED]),
  [ROOM_STATES.DESTROYED]: new Set()
});

class RoomManager {
  constructor({ uploadsDir, maxMessageLength, roomTtlMs }) {
    this.uploadsDir = uploadsDir;
    this.maxMessageLength = maxMessageLength;
    this.roomTtlMs = roomTtlMs;

    this.rooms = new Map();
    this.socketToRoom = new Map();
  }

  static roleTitle(role) {
    return role === 'host' ? 'Учасник A' : 'Учасник B';
  }

  createRoom() {
    const id = crypto.randomUUID();
    const hostToken = crypto.randomBytes(24).toString('hex');
    const guestToken = crypto.randomBytes(24).toString('hex');

    const now = Date.now();
    const room = {
      id,
      hostToken,
      guestToken,
      guestTokenUsed: false,
      state: ROOM_STATES.CREATED,
      participants: new Map(),
      history: [],
      uploadedFiles: new Set(),
      createdAt: now,
      lastActivityAt: now,
      typingByRole: new Set()
    };

    this.transitionState(room, ROOM_STATES.WAITING_SECOND);
    this.rooms.set(id, room);
    return room;
  }

  joinRoom({ roomId, token, socketId }) {
    const room = this.rooms.get(roomId);
    if (!room || room.state === ROOM_STATES.DESTROYED) {
      return { error: 'Кімната не існує або вже завершена.' };
    }

    const role = this.getRoleFromToken(room, token);
    if (!role) {
      return { error: 'Недійсний токен доступу до кімнати.' };
    }

    if (role === 'guest' && room.guestTokenUsed) {
      return { error: 'Посилання-запрошення вже було використане.' };
    }

    const roleAlreadyConnected = [...room.participants.values()].some((participant) => participant.role === role);
    if (roleAlreadyConnected) {
      return { error: 'Цей учасник уже приєднаний.' };
    }

    if (room.participants.size >= 2) {
      return { error: 'Кімната заповнена.' };
    }

    if (role === 'guest') {
      room.guestTokenUsed = true;
    }

    room.participants.set(socketId, { role, token });
    this.socketToRoom.set(socketId, room.id);
    this.touchRoom(room);

    if (room.participants.size === 2 && room.state === ROOM_STATES.WAITING_SECOND) {
      this.transitionState(room, ROOM_STATES.ACTIVE);
    }

    const participantsCount = room.participants.size;
    const systemToSelf = participantsCount === 1 ? 'Очікування другого учасника...' : null;
    const systemToRoom = participantsCount === 2 ? 'Обидва учасники у кімнаті. Можна спілкуватися.' : null;

    return {
      room,
      role,
      roleLabel: RoomManager.roleTitle(role),
      participantsCount,
      history: room.history,
      systemToSelf,
      systemToRoom
    };
  }

  createTextMessage(socketId, payload = {}) {
    const room = this.getRoomBySocket(socketId);
    if (!room || room.state === ROOM_STATES.DESTROYED) {
      return { error: 'Кімната не активна.' };
    }

    const participant = room.participants.get(socketId);
    if (!participant) {
      return { error: 'Учасник не знайдений у кімнаті.' };
    }

    const text = typeof payload.text === 'string' ? payload.text.trim() : '';
    if (!text || text.length > this.maxMessageLength) {
      return { error: 'Некоректне повідомлення.' };
    }

    const replyToId = typeof payload.replyToId === 'string' ? payload.replyToId.trim() : '';
    let replyTo = null;
    if (replyToId) {
      const original = room.history.find((message) => message.id === replyToId);
      replyTo = this.buildReplyPreview(original);
    }

    const message = {
      id: crypto.randomUUID(),
      type: 'text',
      text,
      sender: participant.role,
      senderLabel: RoomManager.roleTitle(participant.role),
      timestamp: Date.now(),
      replyTo
    };

    room.history.push(message);
    this.touchRoom(room);

    return {
      roomId: room.id,
      message
    };
  }

  createUploadMessage({ roomId, token, file }) {
    const room = this.rooms.get(roomId);
    if (!room || room.state === ROOM_STATES.DESTROYED) {
      return { status: 404, error: 'Кімнату не знайдено.' };
    }

    const role = this.getRoleFromToken(room, token);
    if (!role) {
      return { status: 403, error: 'Недійсний токен доступу.' };
    }

    const roleConnected = [...room.participants.values()].some((participant) => participant.role === role);
    if (!roleConnected) {
      return { status: 403, error: 'Спочатку приєднайтесь до кімнати.' };
    }

    if (!file) {
      return { status: 400, error: 'Файл не передано.' };
    }

    room.uploadedFiles.add(file.path);
    this.touchRoom(room);

    const message = {
      id: crypto.randomUUID(),
      type: file.mimetype.startsWith('image/') ? 'image' : 'file',
      sender: role,
      senderLabel: RoomManager.roleTitle(role),
      timestamp: Date.now(),
      attachment: {
        originalName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        url: `/uploads/${path.basename(file.path)}`
      }
    };

    room.history.push(message);

    return {
      roomId: room.id,
      message
    };
  }

  setTyping(socketId, isTyping) {
    const room = this.getRoomBySocket(socketId);
    if (!room || room.state === ROOM_STATES.DESTROYED) return null;

    const participant = room.participants.get(socketId);
    if (!participant) return null;

    if (isTyping) {
      room.typingByRole.add(participant.role);
    } else {
      room.typingByRole.delete(participant.role);
    }

    this.touchRoom(room);

    return {
      roomId: room.id,
      senderRole: participant.role,
      senderLabel: RoomManager.roleTitle(participant.role),
      isTyping
    };
  }

  async leaveBySocket(socketId, reason) {
    const room = this.getRoomBySocket(socketId);
    if (!room) return null;

    return this.destroyRoom(room.id, reason, socketId);
  }

  async disconnectBySocket(socketId, reason) {
    const room = this.getRoomBySocket(socketId);
    if (!room) return null;

    return this.destroyRoom(room.id, reason, socketId);
  }

  async expireInactiveRooms(reason) {
    const now = Date.now();
    const expired = [...this.rooms.values()].filter((room) => {
      if (room.state === ROOM_STATES.DESTROYED) return false;
      return now - room.lastActivityAt >= this.roomTtlMs;
    });

    const results = [];
    for (const room of expired) {
      const result = await this.destroyRoom(room.id, reason, null);
      if (result) results.push(result);
    }

    return results;
  }

  async destroyRoom(roomId, reason, initiatorSocketId = null) {
    const room = this.rooms.get(roomId);
    if (!room || room.state === ROOM_STATES.DESTROYED) return null;

    if (room.state === ROOM_STATES.CREATED) {
      this.transitionState(room, ROOM_STATES.WAITING_SECOND);
    }
    this.transitionState(room, ROOM_STATES.DESTROYED);

    const socketIds = [...room.participants.keys()];

    this.rooms.delete(room.id);
    for (const socketId of socketIds) {
      this.socketToRoom.delete(socketId);
    }

    const filesToDelete = [...room.uploadedFiles];
    room.participants.clear();
    room.history.length = 0;
    room.uploadedFiles.clear();
    room.typingByRole.clear();

    await Promise.all(filesToDelete.map((filePath) => fs.unlink(filePath).catch(() => null)));

    return {
      roomId,
      socketIds,
      reason,
      initiatorSocketId
    };
  }

  getRoomBySocket(socketId) {
    const roomId = this.socketToRoom.get(socketId);
    if (!roomId) return null;
    return this.rooms.get(roomId) || null;
  }

  getRoleFromToken(room, token) {
    if (token === room.hostToken) return 'host';
    if (token === room.guestToken) return 'guest';
    return null;
  }

  buildReplyPreview(message) {
    if (!message) return null;

    if (message.type === 'text') {
      return {
        id: message.id,
        sender: message.sender,
        senderLabel: message.senderLabel,
        type: 'text',
        preview: message.text.slice(0, 120)
      };
    }

    if (message.type === 'image' || message.type === 'file') {
      return {
        id: message.id,
        sender: message.sender,
        senderLabel: message.senderLabel,
        type: message.type,
        preview: message.attachment?.originalName || 'Вкладення'
      };
    }

    return null;
  }

  touchRoom(room) {
    room.lastActivityAt = Date.now();
  }

  transitionState(room, nextState) {
    const allowed = ALLOWED_TRANSITIONS[room.state] || new Set();
    if (!allowed.has(nextState)) {
      throw new Error(`Invalid room state transition: ${room.state} -> ${nextState}`);
    }
    room.state = nextState;
  }
}

module.exports = {
  RoomManager,
  ROOM_STATES
};
