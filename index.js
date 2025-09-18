const express = require('express');
const http = require('http');
const fs = require('fs');
const cors = require('cors');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const JWT_SECRET = process.env.JWT_SECRET || 'supersecret1396';
const USERS_FILE = path.join(__dirname, 'users.json');

app.use(cors());
app.use(bodyParser.json());

// ===== Работа с users.json =====
function loadUsers() {
  if(!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify([]));
  return JSON.parse(fs.readFileSync(USERS_FILE));
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// ===== Регистрация =====
app.post('/api/register', (req, res) => {
  const { name, login, password } = req.body;
  const users = loadUsers();
  if(users.find(u => u.login === login)) return res.json({ ok:false, error:"Логин занят" });
  users.push({ name, login, password });
  saveUsers(users);
  res.json({ ok:true });
});

// ===== Вход =====
app.post('/api/login', (req, res) => {
  const { login, password } = req.body;
  const users = loadUsers();
  const user = users.find(u => u.login === login && u.password === password);
  if(!user) return res.json({ ok:false, error:"Неверный логин или пароль" });
  const token = jwt.sign({ login }, JWT_SECRET);
  res.json({ ok:true, token, name:user.name });
});

// ===== Комнаты =====
let rooms = {}; // { roomCode: { name, owner, participants:[{id, displayName}], messages:[] } }

// ===== Socket.IO =====
io.on('connection', socket => {
  console.log('New connection:', socket.id);

  socket.on('join-room', ({ roomCode, displayName }, callback) => {
    if(!rooms[roomCode]) rooms[roomCode] = { name: roomCode, owner: displayName, participants: [], messages: [] };
    const room = rooms[roomCode];

    // Добавляем участника
    room.participants.push({ id: socket.id, displayName });
    socket.join(roomCode);

    // Отправляем текущих участников
    callback({ ok:true, participants: room.participants });

    // Уведомление другим
    socket.to(roomCode).emit('chat-message', { text:`${displayName} присоединился`, type:'text', fromName:'Система' });
  });

  socket.on('chat-message', data => {
    const room = rooms[data.roomCode];
    if(!room) return;
    room.messages.push(data);
    io.to(data.roomCode).emit('chat-message', data);
  });

  // WebRTC сигналинг
  socket.on('signal', data => {
    if(data.to) io.to(data.to).emit('signal', { from: socket.id, signal: data.signal });
  });

  // Завершение комнаты владельцем
  socket.on('end-room', roomCode => {
    const room = rooms[roomCode];
    if(room && room.owner === socket.id) {
      io.to(roomCode).emit('chat-message', { text:'Комната завершена владельцем', type:'text', fromName:'Система' });
      delete rooms[roomCode];
    }
  });

  socket.on('disconnecting', () => {
    for(const roomCode of socket.rooms) {
      const room = rooms[roomCode];
      if(room) {
        room.participants = room.participants.filter(p => p.id !== socket.id);
        io.to(roomCode).emit('chat-message', { text:'Участник вышел', type:'text', fromName:'Система' });
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
