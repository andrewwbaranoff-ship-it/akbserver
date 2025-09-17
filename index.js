const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "https://akbconf.netlify.app/",
    methods: ["GET", "POST"]
  }
});

const rooms = {};

io.on('connection', socket => {
  console.log('client connected:', socket.id);

  socket.on('create-room', ({ roomCode, title }, cb) => {
    if (!roomCode) return cb({ ok: false, error: 'Нет кода' });
    if (rooms[roomCode]) return cb({ ok: false, error: 'Комната уже существует' });
    rooms[roomCode] = { title, owner: socket.id, createdAt: Date.now() };
    socket.join(roomCode);
    cb({ ok: true, room: rooms[roomCode] });
  });

  socket.on('join-room', ({ roomCode, displayName }, cb) => {
    if (!rooms[roomCode]) return cb({ ok: false, error: 'Комната не найдена' });
    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.displayName = displayName || 'Guest';
    const clients = Array.from(io.sockets.adapter.rooms.get(roomCode) || [])
      .filter(id => id !== socket.id)
      .map(id => {
        const s = io.sockets.sockets.get(id);
        return { id, displayName: s?.displayName || 'Guest' };
      });
    cb({ ok: true, others: clients, room: rooms[roomCode] });
    socket.to(roomCode).emit('new-user', { id: socket.id, displayName: socket.displayName });
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

  socket.on('chat-message', ({ roomCode, message }) => {
    io.in(roomCode).emit('chat-message', { from: socket.id, displayName: socket.displayName, message, ts: Date.now() });
  });

  socket.on('disconnect', () => {
    const roomCode = socket.roomCode;
    if (roomCode) {
      socket.to(roomCode).emit('user-left', { id: socket.id });
      const roomClients = io.sockets.adapter.rooms.get(roomCode);
      if (!roomClients || roomClients.size === 0) delete rooms[roomCode];
    }
    console.log('client disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Signaling server running on ${PORT}`));