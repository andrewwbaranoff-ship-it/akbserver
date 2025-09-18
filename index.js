const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const USERS_FILE = path.join(__dirname, 'users.json');
const JWT_SECRET = process.env.JWT_SECRET || 'supersecret1396';

if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify([]));

app.use(cors());
app.use(express.json());

// ===== Пользователи =====
function readUsers() {
  return JSON.parse(fs.readFileSync(USERS_FILE));
}
function writeUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// Регистрация
app.post('/api/register', async (req, res) => {
  try {
    const { name, login, password } = req.body;
    if (!name || !login || !password) return res.status(400).json({ error: 'Все поля обязательны' });

    const users = readUsers();
    if (users.find(u => u.login === login)) return res.status(400).json({ error: 'Логин уже занят' });

    const hash = await bcrypt.hash(password, 10);
    users.push({ id: Date.now(), name, login, passwordHash: hash });
    writeUsers(users);
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Вход
app.post('/api/login', async (req, res) => {
  try {
    const { login, password } = req.body;
    const users = readUsers();
    const user = users.find(u => u.login === login);
    if (!user) return res.status(400).json({ error: 'Пользователь не найден' });

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) return res.status(400).json({ error: 'Неверный пароль' });

    const token = jwt.sign({ id: user.id, name: user.name, login: user.login }, JWT_SECRET, { expiresIn: '7d' });
    return res.json({ ok: true, token, name: user.name });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ===== WebRTC Signaling =====
const rooms = {};

io.on('connection', socket => {
  console.log('connected:', socket.id);

  socket.on('create-room', ({ roomCode, title }, cb) => {
    if (!roomCode) return cb && cb({ ok: false, error: 'Empty roomCode' });
    if (rooms[roomCode]) return cb && cb({ ok: false, error: 'Room exists' });
    rooms[roomCode] = { title: title || roomCode, owner: socket.id, createdAt: Date.now() };
    socket.join(roomCode);
    cb && cb({ ok: true, room: rooms[roomCode] });
  });

  socket.on('join-room', ({ roomCode, displayName }, cb) => {
    const room = rooms[roomCode];
    if (!room) return cb && cb({ ok: false, error: 'Room not found' });
    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.displayName = displayName || 'Guest';
    const clients = Array.from(io.sockets.adapter.rooms.get(roomCode) || [])
      .filter(id => id !== socket.id)
      .map(id => {
        const s = io.sockets.sockets.get(id);
        return { id, displayName: s && s.displayName ? s.displayName : 'Guest' };
      });
    cb && cb({ ok: true, participants: clients, title: room.title });
    socket.to(roomCode).emit('peer-joined', { id: socket.id, displayName: socket.displayName });
  });

  socket.on('offer', ({ target, sdp }) => {
    io.to(target).emit('offer', { from: socket.id, sdp, displayName: socket.displayName });
  });

  socket.on('answer', ({ target, sdp }) => {
    io.to(target).emit('answer', { from: socket.id, sdp });
  });

  socket.on('ice-candidate', ({ target, candidate }) => {
    io.to(target).emit('ice-candidate', { from: socket.id, candidate });
  });

  socket.on('chat-message', ({ roomCode, text, fromName }) => {
    if (!roomCode) return;
    io.in(roomCode).emit('chat-message', { fromName, text });
  });

  socket.on('disconnect', () => {
    const roomCode = socket.roomCode;
    if (roomCode) {
      socket.to(roomCode).emit('peer-left', { id: socket.id, displayName: socket.displayName });
      const roomClients = io.sockets.adapter.rooms.get(roomCode);
      if (!roomClients || roomClients.size === 0) delete rooms[roomCode];
    }
    console.log('disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server running on port', PORT));
