const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const USERS_FILE = path.join(__dirname, 'users.json');
const JWT_SECRET = process.env.JWT_SECRET || 'supersecret';

// создаём файл users.json если не существует
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify([]));

app.use(express.json());

// ==== Helper functions ====
function readUsers() {
  const data = fs.readFileSync(USERS_FILE);
  return JSON.parse(data);
}
function writeUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// ==== API ====

// регистрация
app.post('/api/register', async (req, res) => {
  const { name, login, password } = req.body;
  if (!name || !login || !password) return res.status(400).json({ error: 'Все поля обязательны' });

  const users = readUsers();
  if (users.find(u => u.login === login)) return res.status(400).json({ error: 'Логин уже занят' });

  const hash = await bcrypt.hash(password, 10);
  const id = users.length ? users[users.length-1].id + 1 : 1;
  users.push({ id, name, login, passwordHash: hash });
  writeUsers(users);

  res.json({ ok: true });
});

// логин
app.post('/api/login', async (req, res) => {
  const { login, password } = req.body;
  const users = readUsers();
  const user = users.find(u => u.login === login);
  if (!user) return res.status(400).json({ error: 'Пользователь не найден' });

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) return res.status(400).json({ error: 'Неверный пароль' });

  const token = jwt.sign({ id: user.id, name: user.name, login: user.login }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ ok: true, token, name: user.name, login: user.login });
});

// админская страница для смены сервера
app.get('/api/admin', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });

  const token = auth.split(' ')[1];
  try {
    const data = jwt.verify(token, JWT_SECRET);
    if (data.login !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    // читаем сервер из файла
    const configPath = path.join(__dirname, 'server_config.json');
    let config = { signalingServer: '' };
    if (fs.existsSync(configPath)) config = JSON.parse(fs.readFileSync(configPath));
    res.json({ ok: true, signalingServer: config.signalingServer });
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
});

app.post('/api/admin', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });

  const token = auth.split(' ')[1];
  try {
    const data = jwt.verify(token, JWT_SECRET);
    if (data.login !== 'admin') return res.status(403).json({ error: 'Forbidden' });

    const { signalingServer } = req.body;
    const configPath = path.join(__dirname, 'server_config.json');
    fs.writeFileSync(configPath, JSON.stringify({ signalingServer }, null, 2));
    res.json({ ok: true });
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
});

// ==== Socket.IO сигналинг ====
const rooms = {};

io.on('connection', socket => {
  console.log('socket connected', socket.id);

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
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server listening on', PORT));