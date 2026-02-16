# Silent Duo Chat

[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)
![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)
![Socket.IO](https://img.shields.io/badge/Socket.IO-4.x-black?logo=socketdotio)
![Tunnel](https://img.shields.io/badge/Public%20Access-Cloudflare%20Tunnel-F38020?logo=cloudflare&logoColor=white)

Anonymous, registration-free web chat for exactly **two participants**.

Built for quick private conversations with ephemeral rooms, one-time invite links, and automatic data cleanup.

## Features

- One-click room creation
- One-time invite link for the second participant
- Strict 2-user room limit
- Real-time messaging with Socket.IO
- File and image sharing
- Paste image from clipboard
- Reply-to-message support
- Full-size image preview modal
- Typing indicator
- Automatic room termination when one participant leaves
- Automatic cleanup of chat history and uploaded files

## How It Works

1. User A creates a room.
2. The server returns:
   - `hostUrl` for User A
   - `inviteUrl` for User B
3. User B joins using the one-time invite.
4. The room becomes active for two users only.
5. If either user leaves/disconnects, the room is destroyed.
6. Messages and temporary uploads are removed from memory/disk.

## Tech Stack

- **Backend:** Node.js, Express, Socket.IO, Multer
- **Frontend:** Vanilla HTML/CSS/JS
- **Public Access:** Cloudflare Tunnel (`trycloudflare.com`)

## Project Structure

```text
.
├─ public/              # Frontend (landing + chat UI)
├─ scripts/             # Utility scripts (e.g. free-port)
├─ tests/               # Smoke tests
├─ uploads/             # Temporary uploaded files (auto-cleaned)
├─ room-manager.js      # Room lifecycle + state machine logic
├─ server.js            # HTTP + socket transport layer
├─ package.json
└─ README.md
```

## Room State Machine

Room lifecycle is strictly controlled server-side:

```text
CREATED -> WAITING_SECOND -> ACTIVE -> DESTROYED
```

The server is the only authority for:

- joining
- leaving
- destroying
- TTL expiration

## Getting Started

### 1) Install dependencies

```bash
npm install
```

### 2) Run locally

```bash
npm start
```

Open: `http://localhost:3000`

### 3) If port 3000 is already in use

```bash
npm run start:clean
```

## Public Access (Internet)

Start with Cloudflare Tunnel:

```bash
npm run start:public
```

The console will print:

```text
Public tunnel URL: https://...trycloudflare.com
```

Use that URL to access/share the app.

If port 3000 is busy:

```bash
npm run start:public:clean
```

## Available Scripts

- `npm start` - Start server on local network.
- `npm run dev` - Same as start (simple dev mode).
- `npm run start:clean` - Free port 3000 and start server.
- `npm run start:public` - Start server with Cloudflare public tunnel.
- `npm run start:public:clean` - Free port 3000 and start public mode.
- `npm run test:smoke` - Run basic end-to-end smoke checks.

## Security & Privacy

Implemented protections include:

- Anti-cache headers (`no-store`, `no-cache`, `Expires: 0`)
- Security headers (`CSP`, `X-Frame-Options`, `nosniff`, etc.)
- Ephemeral in-memory message history
- Automatic room TTL cleanup
- Temporary file deletion on room destruction
- URL token removal from browser address bar after join

> Note: No web app can fully erase a user's browser history/downloads on their device.

## Testing

Run smoke tests:

```bash
npm run test:smoke
```

Checks include:

- two participants can join
- third participant is blocked
- room is destroyed on leave

## Troubleshooting

### `MODULE_NOT_FOUND` (e.g. `express`)

You are likely in the wrong folder or dependencies are missing.

```bash
npm install
```

### Public URL does not work (`NXDOMAIN`)

`trycloudflare` URLs are temporary.
Restart public mode and use the new URL printed in console.

### File upload returns server error

Ensure you are running the latest code and dependencies:

```bash
npm install
npm run start:public
```

## License

ISC

