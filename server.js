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
  const hasClue = q?.hint && (room.phase !== 'question' || Date.now() >= room.clueAt);
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
      answered: [...room.answers.values()].filter(answer => answer.locked).length,
      players: players.map(p => ({
        name: p.name, score: p.score, streak: p.streak, ready: p.ready,
        connected: Boolean(p.socket), me: p.token === token
      })),
      hostOnline: Boolean(room.host.socket),
      selected: room.answers.get(token)?.choice ?? null,
      locked: room.answers.get(token)?.locked ?? false,
      award: room.points.get(token) ?? null,
      question: q && { title: q.title, options: q.options, kind: q.kind, seconds: q.seconds, visual: q.visual, hint: hasClue ? q.hint : null },
      reveal: room.phase === 'results' ? { correct: q.correct, explanation: q.explanation } : null,
    });
  }
}

function finish(room) {
  if (room.phase !== 'question') return;
  clearTimeout(room.timer);
  const q = room.questions[room.index];
  clearTimeout(room.clueTimer);
  const correctInOrder = [...room.answers]
    .filter(([, answer]) => answer.choice === q.correct)
    .sort(([, a], [, b]) => a.order - b.order);
  const ranks = new Map(correctInOrder.map(([token], index) => [token, index + 1]));
  for (const player of room.players.values()) {
    const answer = room.answers.get(player.token);
    const rank = ranks.get(player.token);
    const correct = rank !== undefined;
    player.streak = correct ? player.streak + 1 : 0;
    const base = correct ? (q.kind === 'steady' ? 700 : Math.max(100, 1100 - rank * 100)) : 0;
    const bonuses = [];
    if (correct && q.kind === 'final') bonuses.push(['Final Boss', base]);
    if (correct && q.kind === 'bomb' && answer.at < room.deadline - q.seconds * 300) bonuses.push(['Beat the fuse', 300]);
    if (correct && q.kind === 'clue' && answer.at < room.clueAt) bonuses.push(['Before the clue', 200]);
    if (answer?.bold) bonuses.push(['Double Down', correct ? 400 : -200]);
    if (player.streak >= 3) bonuses.push(['Streak', 200]);
    const points = base + bonuses.reduce((sum, [, value]) => sum + value, 0);
    player.score += points;
    room.points.set(player.token, { points, base, rank: q.kind === 'steady' ? null : rank, bonuses });
  }
  room.phase = 'results';
  publish(room);
}

function finishIfEveryoneAnswered(room) {
  if (room.phase !== 'question') return;
  const active = [...room.players.values()].filter(p => p.socket);
  if (active.length && active.every(p => room.answers.get(p.token)?.locked)) finish(room);
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
      order: 0, expires: Date.now() + roomLifetime
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
    room.order = 0;
    room.phase = 'question';
    const milliseconds = room.questions[room.index].seconds * 1000;
    room.deadline = Date.now() + milliseconds;
    room.timer = setTimeout(() => finish(room), milliseconds);
    room.clueAt = room.deadline - milliseconds / 2;
    if (room.questions[room.index].hint) room.clueTimer = setTimeout(() => publish(room), milliseconds / 2);
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
    const previous = room.answers.get(player.token);
    if (previous?.locked) return ack({ error: 'Your answer is already locked.' });
    const retry = q.kind === 'retry';
    if (retry && data.lock === true && !previous) return ack({ error: 'Choose an answer first.' });
    if (retry && previous?.choice === data.choice) {
      if (data.lock !== true) return ack({ error: 'Choose a different answer or lock this one.' });
      previous.locked = true;
    } else {
      room.answers.set(player.token, {
        choice: data.choice,
        at: now,
        order: ++room.order,
        locked: !retry || Boolean(previous),
        bold: q.kind === 'confidence' && data.bold === true
      });
    }
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
      clearTimeout(room.clueTimer);
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
    clearTimeout(room.clueTimer);
    io.to(pin).emit('ended', 'This room expired. Start a fresh game to play again.');
    io.in(pin).disconnectSockets();
    rooms.delete(pin);
  }
}, 60_000).unref();

const port = process.env.PORT || 3000;
server.listen(port, '0.0.0.0', () => console.log(`Physio Quest Live listening on port ${port}`));
