'use strict';

const socket = io();
const app = document.querySelector('#app');
const notice = document.querySelector('#notice');
const announcement = document.querySelector('#announcement');
const rules = document.querySelector('#rules');
const numbers = new Intl.NumberFormat();
const kinds = {
  classic: ['Classic', 'Correct answer +1,000'],
  speed: ['⚡ Speed', 'First correct answer gets +1,000 extra'],
  riddle: ['🧩 Riddle', 'Solve the clue'],
  visual: ['👀 Visual', 'Look for the visual clue'],
  bomb: ['💣 Beat the fuse', 'Correct in the first 70% gets +500 extra'],
  lebanese: ['🇱🇧 Lebanese round', 'Answer the question in Lebanese Arabic'],
  buzzer: ['🔔 Buzzer', 'First correct answer gets +500 extra'],
  final: ['🏆 Final Boss', 'Correct answer +2,000']
};
let mode = 'join';
let state;
let seat;
let lockedRequest = false;
let clockOffset = 0;
let noticeTimer;
let entry = { pin: new URLSearchParams(location.search).get('pin') || '', name: '', total: '30' };

try { seat = JSON.parse(sessionStorage.getItem('physio-seat')); } catch {}

function remember(value) {
  seat = value;
  try {
    if (value) sessionStorage.setItem('physio-seat', JSON.stringify(value));
    else sessionStorage.removeItem('physio-seat');
  } catch {}
}

function escape(value) {
  const span = document.createElement('span');
  span.textContent = String(value);
  return span.innerHTML.replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function toast(message) {
  clearTimeout(noticeTimer);
  notice.textContent = message;
  noticeTimer = setTimeout(() => { notice.textContent = ''; }, 5000);
}

function home() {
  return `
    <div class="hero">
      <section>
        <p class="eyebrow">LIVE MULTIPLAYER PHYSIO QUIZ</p>
        <h1>Physio<br><span>Quest.</span></h1>
        <p class="intro">Gather your group, grab your phones, and see how well you know the body in motion.</p>
        <button class="secondary" data-action="rules">Explore the playbook</button>
      </section>
      <section class="panel">
        <nav class="chooser" aria-label="Choose how to play">
          <button data-action="join" aria-pressed="${mode === 'join'}">Join game</button>
          <button data-action="host" aria-pressed="${mode === 'host'}">Host game</button>
        </nav>
        <h2>${mode === 'join' ? 'Find your room' : 'Set up a game'}</h2>
        <form id="entry-form">
          ${mode === 'join' ? `
            <label>Game PIN<input name="pin" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required placeholder="6-digit PIN" value="${escape(entry.pin)}"></label>
            <label>Nickname<input name="name" minlength="2" maxlength="24" autocomplete="nickname" required placeholder="Your name in the game" value="${escape(entry.name)}"></label>` : `
            <label>Game length<select name="total">
              ${[['10', 'Quick play'], ['20', 'Standard'], ['30', 'Full quest']].map(([count, label]) => `<option value="${count}" ${entry.total === count ? 'selected' : ''}>${label} · ${count} questions</option>`).join('')}
            </select></label>
            <p>Share your room PIN with the group and run the game from this screen.</p>`}
          <button class="primary" ${!socket.connected || lockedRequest ? 'disabled' : ''}>${mode === 'join' ? 'Join the room' : 'Create a room'}</button>
        </form>
      </section>
    </div>`;
}

function standings(s) {
  const title = s.phase === 'lobby' ? 'Players' : 'Leaderboard';
  return `<aside class="panel"><h2>${title} · ${s.players.length}</h2>
    ${s.players.length ? `<ol class="roster">${s.players.map((p) => `
      <li class="score"><strong>${s.phase === 'lobby' ? '' : `<span aria-hidden="true">${s.players.findIndex(other => other.score === p.score) + 1}. </span>`}${escape(p.name)}${p.me ? ' · You' : ''}
      <small>${!p.connected ? 'Reconnecting' : s.phase === 'lobby' ? (p.ready ? '✓ Ready' : 'Getting ready') : p.streak >= 2 ? `🔥 ${p.streak} in a row` : ''}</small></strong>
      ${s.phase === 'lobby' ? '' : `<b>${numbers.format(p.score)}</b>`}</li>`).join('')}</ol>` : '<p>Waiting for players to join.</p>'}
    </aside>`;
}

function lobby(s) {
  const active = s.players.filter(p => p.connected);
  const allReady = active.length && active.every(p => p.ready);
  const ready = s.players.find(p => p.me)?.ready;
  return `<section class="panel"><p class="eyebrow">LOBBY · ${s.total} QUESTIONS</p><h1>${s.host ? 'Invite your group' : 'You’re in!'}</h1>
    <p>${s.host ? 'Share this PIN or copy an invite link. Start when everyone is ready.' : 'Tap Ready when you’re set. The host starts the game.'}</p>
    <div class="pin" aria-label="Game PIN ${s.pin.split('').join(' ')}">${s.pin}</div>
    <div class="actions">${s.host ? `<button class="primary" data-action="next" ${allReady ? '' : 'disabled'}>Start game</button>
      <button class="secondary" data-action="copy">Copy invite link</button>` :
      `<button class="${ready ? 'secondary' : 'primary'}" data-action="ready">${ready ? '✓ Ready · Undo' : 'I’m ready'}</button>`}</div>
    </section>`;
}

function round(s) {
  const q = s.question;
  const [kind, rule] = kinds[q.kind] || kinds.classic;
  const revealed = s.phase === 'results';
  const live = !revealed && !s.host;
  const active = s.players.filter(p => p.connected).length;
  const correctChoice = revealed ? q.options[s.reveal.correct] : '';
  return `<section class="panel">
    <div class="meta"><p class="eyebrow">QUESTION ${s.index + 1} / ${s.total}</p>
      ${revealed ? '' : '<span class="clock" id="clock"></span>'}</div>
    ${revealed ? '' : `<progress id="timer" max="${q.seconds * 1000}" aria-label="Time remaining"></progress>`}
    <p>${kind} · ${rule}</p>
    ${q.visual && !q.title.includes(q.visual) ? `<div class="visual" aria-hidden="true">${escape(q.visual)}</div>` : ''}
    <h1>${escape(q.title)}</h1>
    <div class="options">${q.options.map((option, index) => {
      const selected = s.selected === index;
      const correct = revealed && s.reveal.correct === index;
      const type = correct ? 'correct' : selected ? (revealed ? 'wrong' : 'selected') : '';
      return `<button class="choice ${type}" data-action="answer" data-choice="${index}" ${live && s.selected === null && !lockedRequest && socket.connected ? '' : 'disabled'}><span class="letter">${'ABCD'[index] || index + 1}</span>
        <span>${escape(option)}${correct ? ' ✓' : ''}${selected ? '<small> · Your answer</small>' : ''}</span></button>`;
    }).join('')}</div>
    ${revealed ? `<div class="feedback">
      <strong>${s.host ? 'Correct answer' : s.points ? `+${numbers.format(s.points)} points` : s.selected === null ? 'No answer submitted' : '0 points'}</strong>
      <p>${escape(correctChoice)} · ${escape(s.reveal.explanation)}</p>
    </div>${s.host ? `<button class="primary" data-action="next">${s.index + 1 === s.total ? 'Show final standings' : 'Next question'}</button>` : '<p>Waiting for the host to continue.</p>'}` :
      `<p>${s.selected !== null ? '✓ Answer locked. ' : ''}${s.answered} answered · ${active} connected${s.buzzer ? ` · ${escape(s.buzzer)} buzzed first` : ''}</p>`}
    </section>`;
}

function finale(s) {
  const leaders = s.players.filter(p => p.score === s.players[0]?.score);
  const me = s.players.find(p => p.me);
  return `<section class="panel">
    <p class="eyebrow">🏆 FINAL STANDINGS</p>
    <h1>Quest complete!</h1>
    ${s.players[0]?.score ? `<h2>${leaders.map(p => escape(p.name)).join(', ')} ${leaders.length === 1 ? 'wins' : 'tie for first'}</h2><p>${numbers.format(leaders[0].score)} points</p>` : '<p>The points table is tied at zero.</p>'}
    ${me ? `<p>Your score · <strong>${numbers.format(me.score)} points</strong></p>` : ''}
    <button class="primary" data-action="leave">Back to home</button>
    </section>`;
}

function render() {
  const focus = app.contains(document.activeElement) ? document.activeElement : null;
  const s = state;
  app.innerHTML = s ? `<div class="room-head">
    <p>Room <strong>${s.pin}</strong> · ${s.host ? 'Host' : 'Player'}${!socket.connected ? ' · Reconnecting…' : !s.hostOnline && s.phase !== 'finished' ? ' · Host reconnecting…' : ''}</p>
    ${s.phase === 'finished' ? '' : `<button class="secondary" data-action="leave">${s.host ? 'Close game' : 'Leave game'}</button>`}
    </div><div class="board">${s.phase === 'lobby' ? lobby(s) : s.phase === 'finished' ? finale(s) : round(s)}${standings(s)}</div>` :
    seat ? '<p>Reconnecting to your room…</p>' : home();
  app.setAttribute('aria-busy', 'false');
  if (focus?.dataset.action) {
    const target = [...app.querySelectorAll('button')].find(button =>
      button.dataset.action === focus.dataset.action && button.dataset.choice === focus.dataset.choice);
    target?.focus({ preventScroll: true });
  } else if (focus?.name) {
    app.querySelector(`[name="${focus.name}"]`)?.focus({ preventScroll: true });
  }
  tick();
}

function tick() {
  const progress = document.querySelector('#timer');
  if (!progress || !state) return;
  const left = Math.max(0, state.deadline - Date.now() - clockOffset);
  progress.value = left;
  document.querySelector('#clock').textContent = `${Math.ceil(left / 1000)}s`;
}

function request(event, data, callback) {
  socket.timeout(5000).emit(event, data, (error, result) => {
    if (error) return callback({ error: 'Connection interrupted. Try again.' }, true);
    callback(result);
  });
}

function leave() {
  if (state?.host && state.phase !== 'finished' && !confirm('Close this game for everyone?')) return;
  socket.emit('leave');
  remember(null);
  state = null;
  render();
}

socket.on('connect', () => {
  if (!seat) return render();
  request('resume', seat, (result, timedOut) => {
    if (timedOut) {
      toast(result.error);
      socket.disconnect();
      setTimeout(() => socket.connect(), 1000);
      return;
    }
    if (!result.error) return;
    remember(null);
    state = null;
    toast(result.error);
    render();
  });
});
socket.on('disconnect', render);
socket.on('state', next => {
  if (!seat || seat.pin !== next.pin) return;
  const changed = state?.phase !== next.phase || state?.index !== next.index;
  state = next;
  clockOffset = next.now - Date.now();
  render();
  if (changed) {
    const message = {
      lobby: 'Joined the lobby',
      question: `Question ${next.index + 1}. ${next.question?.title}`,
      results: `Correct answer: ${next.question?.options[next.reveal?.correct]}`,
      finished: 'Game complete'
    };
    announcement.textContent = message[next.phase];
    app.querySelector('h1')?.setAttribute('tabindex', '-1');
    app.querySelector('h1')?.focus({ preventScroll: true });
  }
});
socket.on('ended', message => {
  remember(null);
  state = null;
  toast(message);
  render();
});

document.querySelector('#open-rules').onclick = () => rules.showModal();

app.addEventListener('input', event => {
  if (Object.hasOwn(entry, event.target.name)) entry[event.target.name] = event.target.value;
});

app.addEventListener('submit', event => {
  event.preventDefault();
  if (!socket.connected || lockedRequest) return;
  const data = mode === 'host' ? { total: Number(entry.total) } : { pin: entry.pin, name: entry.name };
  lockedRequest = true;
  render();
  request(mode === 'host' ? 'create' : 'join', data, result => {
    lockedRequest = false;
    if (result.error) {
      toast(result.error);
      if (result.error === 'Connection interrupted. Try again.') {
        socket.disconnect();
        socket.connect();
      }
    } else remember({ pin: result.pin, token: result.token });
    render();
  });
});

app.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const { action, choice } = button.dataset;
  if (action === 'rules') return rules.showModal();
  if (action === 'join' || action === 'host') {
    mode = action;
    return render();
  }
  if (action === 'leave') return leave();
  if (action === 'copy') {
    const invite = new URL('/', location.href);
    invite.searchParams.set('pin', state.pin);
    try {
      await navigator.clipboard.writeText(invite.href);
      toast('Invite link copied.');
    } catch {
      toast(`Share this page address and PIN ${state.pin}.`);
    }
    return;
  }
  if (!socket.connected) return toast('Reconnecting. Try again in a moment.');
  if (action === 'ready' || action === 'next') socket.emit(action);
  if (action === 'answer' && !lockedRequest) {
    lockedRequest = true;
    render();
    request('answer', { choice: Number(choice), index: state.index }, result => {
      lockedRequest = false;
      if (result.error) toast(result.error);
      render();
    });
  }
});

setInterval(tick, 100);
render();
