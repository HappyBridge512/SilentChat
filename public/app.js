const landingPanel = document.getElementById('landing');
const chatPanel = document.getElementById('chat');

const createRoomBtn = document.getElementById('createRoomBtn');
const createdRoom = document.getElementById('createdRoom');
const inviteLinkInput = document.getElementById('inviteLink');
const copyInviteBtn = document.getElementById('copyInviteBtn');
const openRoomLink = document.getElementById('openRoomLink');

const roomMeta = document.getElementById('roomMeta');
const roleTitle = document.getElementById('roleTitle');
const statusBar = document.getElementById('statusBar');
const typingIndicator = document.getElementById('typingIndicator');
const uploadProgress = document.getElementById('uploadProgress');
const uploadProgressBar = document.getElementById('uploadProgressBar');
const messages = document.getElementById('messages');
const replyBox = document.getElementById('replyBox');
const replyAuthor = document.getElementById('replyAuthor');
const replyPreview = document.getElementById('replyPreview');
const cancelReplyBtn = document.getElementById('cancelReplyBtn');
const composer = document.getElementById('composer');
const messageInput = document.getElementById('messageInput');
const fileInput = document.getElementById('fileInput');
const leaveBtn = document.getElementById('leaveBtn');
const toast = document.getElementById('toast');
const imageModal = document.getElementById('imageModal');
const imageModalImg = document.getElementById('imageModalImg');
const imageModalCaption = document.getElementById('imageModalCaption');
const closeImageModalBtn = document.getElementById('closeImageModalBtn');

const socket = io({ autoConnect: false });

let currentRoomId = null;
let currentToken = null;
let currentRole = null;
let roomActive = false;
let typingActive = false;
let typingTimeout = null;
let uploadInProgress = false;
let toastTimeout = null;
let activeReply = null;
const messageById = new Map();

const LINK_RE = /\b((?:https?:\/\/|www\.)[^\s<]+)/gi;
const CREATED_ROOM_CACHE_KEY = 'silent_duo_created_room';

function switchPanel(panel) {
  landingPanel.classList.remove('active');
  chatPanel.classList.remove('active');
  panel.classList.add('active');
}

function parseRoomContext() {
  const match = window.location.pathname.match(/^\/room\/([a-fA-F0-9-]+)$/);
  const token = new URLSearchParams(window.location.search).get('t');
  if (!match || !token) return null;

  return {
    roomId: match[1],
    token
  };
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function normalizeLinkCandidate(rawValue) {
  const trimmed = rawValue.trim().replace(/[),.;!?]+$/g, '');
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^www\./i.test(trimmed)) return `https://${trimmed}`;
  return null;
}

function isValidExternalUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (_error) {
    return false;
  }
}

function renderTextWithLinks(text) {
  const fragment = document.createDocumentFragment();
  let start = 0;

  const matches = [...text.matchAll(LINK_RE)];
  for (const match of matches) {
    const urlText = match[0];
    const index = match.index || 0;
    if (index > start) {
      fragment.appendChild(document.createTextNode(text.slice(start, index)));
    }

    const normalized = normalizeLinkCandidate(urlText);
    if (normalized && isValidExternalUrl(normalized)) {
      const link = document.createElement('a');
      link.href = normalized;
      link.target = '_blank';
      link.rel = 'noreferrer noopener';
      link.className = 'inline-link';
      link.textContent = urlText;
      fragment.appendChild(link);
    } else {
      fragment.appendChild(document.createTextNode(urlText));
    }

    start = index + urlText.length;
  }

  if (start < text.length) {
    fragment.appendChild(document.createTextNode(text.slice(start)));
  }

  return fragment;
}

function findInvalidLinkToken(text) {
  const matches = [...text.matchAll(LINK_RE)];
  for (const match of matches) {
    const candidate = normalizeLinkCandidate(match[0]);
    if (candidate && !isValidExternalUrl(candidate)) {
      return match[0];
    }
  }
  return null;
}

function getReplyPreviewText(message) {
  if (!message) return '';
  if (message.type === 'text') return message.text.slice(0, 100);
  if (message.type === 'image') return `Зображення: ${message.attachment?.originalName || 'image'}`;
  if (message.type === 'file') return `Файл: ${message.attachment?.originalName || 'file'}`;
  return 'Повідомлення';
}

function formatReplyQuoteText(replyTo) {
  if (!replyTo) return '';
  const prefix =
    replyTo.type === 'image' ? 'Зображення: ' :
    replyTo.type === 'file' ? 'Файл: ' :
    '';
  return `${replyTo.senderLabel}: ${prefix}${replyTo.preview}`;
}

function createFallbackMessageFromNode(messageNode) {
  const messageId = messageNode.dataset.messageId;
  const metaText = messageNode.querySelector('.meta')?.textContent || 'Учасник';
  const senderLabel = metaText.split('•')[0].trim();
  const image = messageNode.querySelector('.preview-img');
  const fileLink = messageNode.querySelector('.file-link');
  const textNode = messageNode.querySelector('.message-text');

  if (image) {
    return {
      id: messageId,
      senderLabel,
      type: 'image',
      attachment: { originalName: image.alt || 'image' }
    };
  }

  if (fileLink) {
    return {
      id: messageId,
      senderLabel,
      type: 'file',
      attachment: { originalName: fileLink.textContent.replace(/^Файл:\s*/i, '').trim() || 'file' }
    };
  }

  return {
    id: messageId,
    senderLabel,
    type: 'text',
    text: textNode?.textContent || 'Повідомлення'
  };
}

function setReplyTarget(message) {
  activeReply = message;
  replyAuthor.textContent = message.senderLabel || 'Учасник';
  replyPreview.textContent = getReplyPreviewText(message);
  replyBox.classList.remove('hidden');
  messageInput.focus();
}

function clearReplyTarget() {
  activeReply = null;
  replyBox.classList.add('hidden');
}

function appendMessage(payload) {
  const shouldStickToBottom =
    messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;

  const item = document.createElement('article');
  const msgClass = payload.type === 'system'
    ? 'system'
    : payload.sender === currentRole
      ? 'self'
      : 'peer';

  item.className = `message ${msgClass}`;
  if (payload.id) {
    item.dataset.messageId = payload.id;
    messageById.set(payload.id, payload);
  }

  if (payload.type !== 'system') {
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${payload.senderLabel} • ${formatTime(payload.timestamp)}`;
    item.appendChild(meta);
  }

  if (payload.replyTo) {
    const quote = document.createElement('div');
    quote.className = 'reply-quote';
    quote.dataset.replyToId = payload.replyTo.id;
    quote.textContent = formatReplyQuoteText(payload.replyTo);
    item.appendChild(quote);
  }

  if (payload.type === 'text') {
    const text = document.createElement('div');
    text.className = 'message-text';
    text.appendChild(renderTextWithLinks(payload.text));
    item.appendChild(text);
  } else if (payload.type === 'image') {
    const caption = document.createElement('div');
    caption.textContent = payload.attachment.originalName;
    item.appendChild(caption);

    const img = document.createElement('img');
    img.src = payload.attachment.url;
    img.alt = payload.attachment.originalName;
    img.className = 'preview-img';
    item.appendChild(img);
  } else if (payload.type === 'file') {
    const link = document.createElement('a');
    link.href = payload.attachment.url;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.className = 'file-link';
    link.textContent = `Файл: ${payload.attachment.originalName}`;
    item.appendChild(link);
  } else if (payload.type === 'system') {
    item.textContent = payload.text;
  }

  if (payload.type !== 'system') {
    const actions = document.createElement('div');
    actions.className = 'message-actions';
    const replyBtn = document.createElement('button');
    replyBtn.type = 'button';
    replyBtn.className = 'reply-action';
    replyBtn.textContent = 'Відповісти';
    actions.appendChild(replyBtn);
    item.appendChild(actions);
  }

  messages.appendChild(item);
  if (shouldStickToBottom || payload.sender === currentRole) {
    messages.scrollTop = messages.scrollHeight;
  }
}

function setStatus(text) {
  statusBar.textContent = text;
}

function showToast(text) {
  toast.textContent = text;
  toast.classList.remove('hidden');
  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toast.classList.add('hidden');
  }, 1500);
}

function setTypingIndicator(isVisible, label = 'Інший учасник') {
  typingIndicator.textContent = isVisible ? `${label} друкує...` : ' ';
  typingIndicator.classList.toggle('active', Boolean(isVisible));
}

function setUploadProgress(percent) {
  uploadProgress.classList.toggle('hidden', percent <= 0 || percent >= 100);
  uploadProgressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
}

function openImageModal(src, caption) {
  imageModalImg.src = src;
  imageModalImg.alt = caption || 'Зображення';
  imageModalCaption.textContent = caption || '';
  imageModal.classList.remove('hidden');
  imageModal.setAttribute('aria-hidden', 'false');
}

function closeImageModal() {
  imageModal.classList.add('hidden');
  imageModal.setAttribute('aria-hidden', 'true');
  imageModalImg.src = '';
  imageModalImg.alt = '';
  imageModalCaption.textContent = '';
}

function clearClientTraces() {
  try { sessionStorage.clear(); } catch (_error) {}
  try { localStorage.clear(); } catch (_error) {}
}

function cacheCreatedRoom(inviteUrl, hostUrl) {
  try {
    sessionStorage.setItem(CREATED_ROOM_CACHE_KEY, JSON.stringify({
      inviteUrl,
      hostUrl
    }));
  } catch (_error) {
    // Ignore storage write failures.
  }
}

function restoreCreatedRoomFromCache() {
  try {
    const raw = sessionStorage.getItem(CREATED_ROOM_CACHE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed?.inviteUrl || !parsed?.hostUrl) return;

    inviteLinkInput.value = parsed.inviteUrl;
    openRoomLink.href = parsed.hostUrl;
    createdRoom.classList.remove('hidden');
  } catch (_error) {
    // Ignore corrupted cache.
  }
}

function emitTypingStop() {
  if (!typingActive || !roomActive) return;
  typingActive = false;
  socket.emit('typing-stop');
}

function handleTypingInput() {
  if (!roomActive) return;
  if (!typingActive) {
    typingActive = true;
    socket.emit('typing-start');
  }

  if (typingTimeout) clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    emitTypingStop();
  }, 900);
}

async function createRoom() {
  createRoomBtn.disabled = true;
  createRoomBtn.textContent = 'Створюю...';

  try {
    const res = await fetch('/api/rooms', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Не вдалося створити кімнату');

    const inviteAbsolute = data.inviteUrlPublic || new URL(data.inviteUrl, window.location.origin).toString();
    const hostAbsolute = data.hostUrlPublic || new URL(data.hostUrl, window.location.origin).toString();

    inviteLinkInput.value = inviteAbsolute;
    openRoomLink.href = hostAbsolute;
    createdRoom.classList.remove('hidden');
    cacheCreatedRoom(inviteAbsolute, hostAbsolute);
  } catch (err) {
    alert(err.message || 'Помилка створення кімнати.');
  } finally {
    createRoomBtn.disabled = false;
    createRoomBtn.textContent = 'Створити кімнату';
  }
}

async function copyInvite() {
  if (!inviteLinkInput.value) return;

  try {
    await navigator.clipboard.writeText(inviteLinkInput.value);
    showToast('Посилання скопійовано');
  } catch {
    inviteLinkInput.select();
    document.execCommand('copy');
    showToast('Посилання скопійовано');
  }
}

async function uploadFile(file) {
  if (!roomActive || !currentRoomId || !currentToken || uploadInProgress) {
    return;
  }

  uploadInProgress = true;
  setStatus(`Завантаження: ${file.name}`);
  setUploadProgress(1);

  try {
    await new Promise((resolve, reject) => {
      const formData = new FormData();
      formData.append('file', file);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/rooms/${currentRoomId}/upload?t=${encodeURIComponent(currentToken)}`);
      xhr.responseType = 'json';

      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        const percent = Math.round((event.loaded / event.total) * 100);
        setUploadProgress(percent);
      };

      xhr.onload = () => {
        const payload = xhr.response || {};
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
          return;
        }
        reject(new Error(payload.error || 'Помилка відправки файлу.'));
      };

      xhr.onerror = () => reject(new Error('Не вдалося відправити файл.'));
      xhr.send(formData);
    });

    setStatus('Файл відправлено.');
    showToast('Файл відправлено');
  } catch (err) {
    setStatus(err.message || 'Не вдалося відправити файл.');
  } finally {
    uploadInProgress = false;
    setUploadProgress(0);
    fileInput.value = '';
  }
}

function connectToRoom(roomId, token) {
  currentRoomId = roomId;
  currentToken = token;

  if (window.location.search.includes('t=')) {
    window.history.replaceState(null, '', `/room/${roomId}`);
  }

  switchPanel(chatPanel);
  setStatus('Підключення до кімнати...');

  socket.connect();
  socket.emit('join-room', { roomId, token });
}

socket.on('join-success', (data) => {
  currentRole = data.role;
  roomActive = true;
  clearReplyTarget();
  messageById.clear();

  roomMeta.textContent = `Кімната: ${data.roomId}`;
  roleTitle.textContent = data.roleLabel;
  setStatus(data.participants < 2 ? 'Очікування другого учасника...' : 'Обидва учасники на місці.');

  messages.innerHTML = '';
  for (const message of data.history) {
    appendMessage(message);
  }
});

socket.on('join-error', (errorText) => {
  alert(errorText);
  socket.disconnect();
  window.location.href = '/';
});

socket.on('system-message', ({ text }) => {
  appendMessage({ type: 'system', text });
  setStatus(text);
});

socket.on('chat-message', (payload) => {
  setTypingIndicator(false);
  appendMessage(payload);
  setStatus('Підключено');
});

socket.on('peer-typing', ({ isTyping, senderLabel }) => {
  setTypingIndicator(Boolean(isTyping), senderLabel || 'Інший учасник');
});

socket.on('room-ended', ({ reason }) => {
  roomActive = false;
  emitTypingStop();
  setTypingIndicator(false);
  setUploadProgress(0);
  clearReplyTarget();
  setStatus(reason);
  appendMessage({ type: 'system', text: reason });

  messageInput.disabled = true;
  fileInput.disabled = true;
  clearClientTraces();

  setTimeout(() => {
    window.location.href = '/';
  }, 1800);
});

socket.on('disconnect', () => {
  if (!roomActive) return;
  setStatus('З\'єднання перервано.');
});

composer.addEventListener('submit', (event) => {
  event.preventDefault();

  const text = messageInput.value.trim();
  if (!text || !roomActive) return;
  const invalidLinkToken = findInvalidLinkToken(text);
  if (invalidLinkToken) {
    setStatus(`Некоректне посилання: ${invalidLinkToken}`);
    return;
  }

  emitTypingStop();
  socket.emit('chat-message', { text, replyToId: activeReply?.id || '' });
  messageInput.value = '';
  clearReplyTarget();
});

messageInput.addEventListener('input', handleTypingInput);
messageInput.addEventListener('blur', emitTypingStop);
messageInput.addEventListener('paste', async (event) => {
  const items = event.clipboardData?.items || [];
  const imageItems = [...items].filter((item) => item.type.startsWith('image/'));
  if (imageItems.length === 0) return;

  event.preventDefault();
  for (const item of imageItems) {
    const blob = item.getAsFile();
    if (!blob) continue;
    const ext = blob.type.split('/')[1] || 'png';
    const file = new File([blob], `pasted-image-${Date.now()}.${ext}`, { type: blob.type });
    await uploadFile(file);
  }
});

fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  if (!file) return;
  await uploadFile(file);
});

messages.addEventListener('click', (event) => {
  const button = event.target.closest('.reply-action');
  if (button) {
    const messageNode = event.target.closest('.message');
    if (!messageNode?.dataset.messageId) return;
    const messageId = messageNode.dataset.messageId;
    const message = messageById.get(messageId) || createFallbackMessageFromNode(messageNode);
    setReplyTarget(message);
    return;
  }

  const image = event.target.closest('.preview-img');
  if (image) {
    openImageModal(image.src, image.alt);
    return;
  }

  const quote = event.target.closest('.reply-quote');
  if (!quote?.dataset.replyToId) return;
  const target = messages.querySelector(`[data-message-id="${quote.dataset.replyToId}"]`);
  if (!target) {
    showToast('Оригінальне повідомлення не знайдено');
    return;
  }
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.remove('jump-highlight');
  void target.offsetWidth;
  target.classList.add('jump-highlight');
});

cancelReplyBtn.addEventListener('click', clearReplyTarget);
closeImageModalBtn.addEventListener('click', closeImageModal);
imageModal.addEventListener('click', (event) => {
  if (event.target === imageModal) {
    closeImageModal();
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeImageModal();
  }
});

leaveBtn.addEventListener('click', () => {
  if (roomActive) {
    socket.emit('leave-room');
  } else {
    window.location.href = '/';
  }
});

createRoomBtn.addEventListener('click', createRoom);
copyInviteBtn.addEventListener('click', copyInvite);
clearReplyTarget();

const roomContext = parseRoomContext();
if (roomContext) {
  connectToRoom(roomContext.roomId, roomContext.token);
} else {
  switchPanel(landingPanel);
  restoreCreatedRoomFromCache();
}
