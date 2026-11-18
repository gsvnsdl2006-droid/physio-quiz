const express = require('express');
const { createServer } = require('node:http');
const { randomInt, randomUUID } = require('node:crypto');
const path = require('node:path');
const { Server } = require('socket.io');
const questions = require('./questions.json');

const app = express();
const server = createServer(app);
const io = new Server(server);
const rooms = new Map();
const roomLifetime = 3 * 60 * 60 * 1000;

app.use(express.static(path.join(__dirname, 'public')));

function publish(room) {
  const q = room.questions[room.index];
  const players = [...room.players.values()].sort((a, b) => b.score - a.score);
  const sockets = io.sockets.adapter.rooms.get(room.pin) || [];
  for (const target of sockets) {
    const client = io.sockets.sockets.get(target);
    if (!client) continue;
    const { token, host } = client.data;
    client.emit('state', {
      pin: room.pin,
      host,
      phase: room.phase,
      index: room.index,
      total: room.total,
      deadline: room.deadline,
      now: Date.now(),
      answered: room.answers.size,
      players: players.map(p => ({
        name: p.name, score: p.score, streak: p.streak, ready: p.ready,
        connected: Boolean(p.socket), me: p.token === token
      })),
      hostOnline: Boolean(room.host.socket),
      selected: room.answers.get(token)?.choice ?? null,
      points: room.points.get(token) ?? 0,
      question: q && { title: q.title, options: q.options, kind: q.kind, seconds: q.seconds, visual: q.visual },
      reveal: room.phase === 'results' ? { correct: q.correct, explanation: q.explanation } : null,
      buzzer: room.buzzer
    });
  }
}

function finish(room) {
  if (room.phase !== 'question') return;
  clearTimeout(room.timer);
  const q = room.questions[room.index];
  const firstCorrect = [...room.answers].find(([, answer]) => answer.choice === q.correct)?.[0];
  for (const player of room.players.values()) {
    const answer = room.answers.get(player.token);
    const correct = answer?.choice === q.correct;
    player.streak = correct ? player.streak + 1 : 0;
    if (!correct) continue;
    let points = q.kind === 'final' ? 2000 : 1000;
    if (q.kind === 'speed' && firstCorrect === player.token) points += 1000;
    if (q.kind === 'buzzer' && firstCorrect === player.token) points += 500;
    if (q.kind === 'bomb' && answer.at < room.deadline - q.seconds * 300) points += 500;
    if (player.streak >= 3) points += 200;
    player.score += points;
    room.points.set(player.token, points);
  }
  room.phase = 'results';
  publish(room);
}

function finishIfEveryoneAnswered(room) {
  if (room.phase !== 'question') return;
  const active = [...room.players.values()].filter(p => p.socket);
  if (active.length && active.every(p => room.answers.has(p.token))) finish(room);
}

function attach(socket, room, member, host, reply) {
  if (member.socket) {
    const previous = io.sockets.sockets.get(member.socket);
    previous?.leave(room.pin);
    if (previous) {
      previous.data = {};
      previous.emit('ended', 'This seat was opened in another tab.');
    }
  }
  member.socket = socket.id;
  socket.data = { pin: room.pin, token: member.token, host };
  socket.join(room.pin);
  reply({ ok: true, pin: room.pin, token: member.token });
  publish(room);
}

io.on('connection', socket => {
  socket.on('create', (data, ack) => {
    if (typeof ack !== 'function') return;
    if (socket.data.pin) return ack({ error: 'You are already in a room.' });
    let pin;
    do { pin = String(randomInt(100000, 1000000)); } while (rooms.has(pin));
    const total = [10, 20, questions.length].includes(data?.total) ? data.total : questions.length;
    const room = {
      pin, total, questions: [...questions.slice(0, total - 1), questions.at(-1)], host: { token: randomUUID() }, players: new Map(),
      phase: 'lobby', index: -1, deadline: 0, answers: new Map(), points: new Map(),
      buzzer: null, expires: Date.now() + roomLifetime
    };
    rooms.set(pin, room);
    attach(socket, room, room.host, true, ack);
  });

  socket.on('join', (data, ack) => {
    if (typeof ack !== 'function') return;
    if (socket.data.pin) return ack({ error: 'You are already in a room.' });
    const room = rooms.get(data?.pin);
    if (!room) return ack({ error: 'That PIN was not found. Check it with your host.' });
    const name = typeof data.name === 'string' ? data.name.trim().slice(0, 24) : '';
    if (room.phase !== 'lobby') return ack({ error: 'This game has already started.' });
    if (name.length < 2) return ack({ error: 'Enter a nickname with at least two characters.' });
    if (room.players.size >= 100) return ack({ error: 'This room is full.' });
    if ([...room.players.values()].some(p => p.name.toLowerCase() === name.toLowerCase())) {
      return ack({ error: 'That nickname is taken. Choose another one.' });
    }
    const member = { token: randomUUID(), name, score: 0, streak: 0, ready: false };
    room.players.set(member.token, member);
    attach(socket, room, member, false, ack);
  });

  socket.on('resume', (data, ack) => {
    if (typeof ack !== 'function') return;
    if (socket.data.pin) return ack({ error: 'You are already in a room.' });
    const room = rooms.get(data?.pin);
    const host = room && room.host.token === data?.token;
    const member = host ? room.host : room?.players.get(data?.token);
    if (!member) return ack({ error: 'This room has closed. Join a new game.' });
    attach(socket, room, member, Boolean(host), ack);
  });

  socket.on('ready', () => {
    const room = rooms.get(socket.data.pin);
    const player = room?.players.get(socket.data.token);
    if (room?.phase !== 'lobby' || !player) return;
    player.ready = !player.ready;
    publish(room);
  });

  socket.on('next', () => {
    const room = rooms.get(socket.data.pin);
    if (!socket.data.host || !room || !['lobby', 'results'].includes(room.phase)) return;
    if (room.phase === 'lobby') {
      const active = [...room.players.values()].filter(p => p.socket);
      if (!active.length || active.some(p => !p.ready)) return;
    }
    if (room.index + 1 === room.total) {
      room.phase = 'finished';
      return publish(room);
    }
    room.index++;
    room.answers.clear();
    room.points.clear();
    room.buzzer = null;
    room.phase = 'question';
    const milliseconds = room.questions[room.index].seconds * 1000;
    room.deadline = Date.now() + milliseconds;
    room.timer = setTimeout(() => finish(room), milliseconds);
    publish(room);
  });

  socket.on('answer', (data, ack) => {
    if (typeof ack !== 'function') return;
    const room = rooms.get(socket.data.pin);
    const player = room?.players.get(socket.data.token);
    const now = Date.now();
    if (!player || room.phase !== 'question' || data?.index !== room.index || now >= room.deadline) {
      return ack({ error: 'Voting has closed.' });
    }
    const q = room.questions[room.index];
    if (!Number.isInteger(data.choice) || !q.options[data.choice]) return ack({ error: 'Choose an answer.' });
    if (room.answers.has(player.token)) return ack({ error: 'Your answer is already locked.' });
    room.answers.set(player.token, { choice: data.choice, at: now });
    if (q.kind === 'buzzer' && !room.buzzer) room.buzzer = player.name;
    ack({ ok: true });
    publish(room);
    finishIfEveryoneAnswered(room);
  });

  socket.on('leave', () => {
    const { pin, token, host } = socket.data;
    const room = rooms.get(pin);
    if (!room) return;
    socket.leave(pin);
    socket.data = {};
    if (host && room.phase === 'finished') {
      room.host.socket = null;
      return publish(room);
    }
    if (host) {
      clearTimeout(room.timer);
      io.to(pin).emit('ended', 'The host closed the game.');
      rooms.delete(pin);
      return;
    }
    if (room.phase === 'lobby') room.players.delete(token);
    else room.players.get(token).socket = null;
    publish(room);
    finishIfEveryoneAnswered(room);
  });

  socket.on('disconnect', () => {
    const { pin, token, host } = socket.data;
    const room = rooms.get(pin);
    const member = host ? room?.host : room?.players.get(token);
    if (member?.socket !== socket.id) return;
    member.socket = null;
    publish(room);
    finishIfEveryoneAnswered(room);
  });
});

setInterval(() => {
  for (const [pin, room] of rooms) {
    if (Date.now() < room.expires) continue;
    clearTimeout(room.timer);
    io.to(pin).emit('ended', 'This room expired. Start a fresh game to play again.');
    io.in(pin).disconnectSockets();
    rooms.delete(pin);
  }
}, 60_000).unref();

const port = process.env.PORT || 3000;
server.listen(port, '0.0.0.0', () => console.log(`Physio Quest Live listening on port ${port}`));
