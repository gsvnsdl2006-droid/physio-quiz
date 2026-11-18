'use strict';

const socket = io();
const app = document.querySelector('#app');
const notice = document.querySelector('#notice');
const announcement = document.querySelector('#announcement');
const rules = document.querySelector('#rules');
const numbers = new Intl.NumberFormat();
const kinds = {
  visual: ['Movement Lab', 'Compare the visual evidence before you answer'],
  confidence: ['Double Down', 'Play safe or add +400 for a correct answer and −200 for a miss'],
  clue: ['Clue Drop', 'A clue appears halfway through. Answer correctly before it drops for +200'],
  retry: ['Second Look', 'Keep your first answer or change it once. A change resets your place in the speed race'],
  steady: ['Think Tank', 'Every correct answer earns 700 base points, regardless of speed'],
  bomb: ['Beat the Fuse', 'Lock a correct answer in the first 70% of the clock for +300'],
  final: ['Final Boss', 'Correct answers earn double the ranked base points']
};
const soundButton = document.querySelector('#sound');
let audio;
let soundOn = false;
let lastBeep;
let compare = 'all';
let bold = false;

function cue(notes) {
  if (!soundOn || audio?.state !== 'running') return;
  for (const [index, pitch] of notes.entries()) {
    const at = audio.currentTime + index * 0.115;
    const tone = audio.createOscillator();
    const volume = audio.createGain();
    tone.frequency.value = pitch;
    volume.gain.setValueAtTime(0.001, at);
    volume.gain.exponentialRampToValueAtTime(0.085, at + 0.02);
    volume.gain.exponentialRampToValueAtTime(0.001, at + 0.13);
    tone.connect(volume).connect(audio.destination);
    tone.start(at);
    tone.stop(at + 0.14);
  }
}

soundButton.onclick = async () => {
  if (soundOn) {
    soundOn = false;
    await audio.suspend();
  } else {
    try {
      audio ??= new AudioContext();
      await audio.resume();
      soundOn = true;
    } catch {
      return toast('Sound is unavailable in this browser.');
    }
  }
  soundButton.textContent = soundOn ? 'Sound on' : 'Sound off';
  soundButton.setAttribute('aria-pressed', String(soundOn));
  cue([440, 660]);
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

function motionStudy(visual) {
  const active = compare === 'all' ? 0 : Number(compare);
  const frame = visual.frames[active];
  const parts = frame.joints.slice(1).map(([x, y], index) => {
    const [fromX, fromY] = frame.joints[index];
    return `<span class="limb" style="left:${fromX}px;top:${fromY}px;width:${Math.hypot(x - fromX, y - fromY)}px;transform:rotate(${Math.atan2(y - fromY, x - fromX)}rad)"></span>`;
  });
  return `<figure class="lab motion">
    <figcaption>${escape(visual.title)}</figcaption>
    <div class="pose" role="img" aria-label="Frame ${active + 1}. Knee is ${frame.gap} diagram units ahead of the planted ankle.">
      <span class="plumb"></span>
      ${parts.join('')}
      ${frame.joints.map(([x, y], index) =>
        `<span class="joint joint-${index}" style="left:${x}px;top:${y}px"></span>`).join('')}
    </div>
    <div class="lab-switch" aria-label="Motion frames">
      ${visual.frames.map(({ name }, index) =>
        `<button class="secondary" data-action="compare" data-choice="${index}" aria-pressed="${active === index}">${index + 1} · ${escape(name)}</button>`).join('')}
    </div>
    <p class="motion-key">Purple dot · Knee &nbsp; Lime dot · Planted ankle</p>
  </figure>`;
}

function movementLab(visual) {
  if (visual.type === 'pose') return motionStudy(visual);
  const entries = Object.entries(visual.sets);
  const max = Math.max(...entries.flatMap(([, values]) => values));
  const selected = entries.map(([name, values], index) => ({ name, values, index }))
    .filter(({ index }) => compare === 'all' || compare === String(index));
  return `<figure class="lab">
    <figcaption>${escape(visual.title)}</figcaption>
    <div class="lab-switch" aria-label="Chart comparison">
      ${[['all', 'Compare all'], ...entries.map(([name], index) => [String(index), name])].map(([id, label]) =>
        `<button class="secondary" data-action="compare" data-choice="${id}" aria-pressed="${compare === id}">${escape(label)}</button>`).join('')}
    </div>
    <div class="lab-plot">
      ${visual.labels.map((label, column) => `<div class="lab-group">
        <div class="lab-bars">${selected.map(({ name, values, index }) =>
          `<div class="lab-trial trial-${index}" aria-label="${escape(name)} ${escape(label)}: ${values[column]}">
            <b>${values[column]}</b><span style="--size:${values[column] / max * 85}%"></span>
          </div>`).join('')}</div>
        <strong>${escape(label)}</strong>
      </div>`).join('')}
    </div>
    <ul class="lab-legend">${selected.map(({ name, index }) => `<li class="trial-${index}">${escape(name)}</li>`).join('')}</ul>
  </figure>`;
}

function pointLabel(points) {
  return `${points >= 0 ? '+' : '−'}${numbers.format(Math.abs(points))}`;
}

function round(s) {
  const q = s.question;
  const [kind, rule] = kinds[q.kind];
  const revealed = s.phase === 'results';
  const live = !revealed && !s.host;
  const active = s.players.filter(p => p.connected).length;
  const canAnswer = live && !s.locked && !lockedRequest && socket.connected;
  const award = s.award;
  const correctChoice = revealed ? q.options[s.reveal.correct] : '';
  return `<section class="panel">
    <div class="meta"><p class="eyebrow">QUESTION ${s.index + 1} / ${s.total}</p>
      ${revealed ? '' : '<span class="clock" id="clock"></span>'}</div>
    ${revealed ? '' : `<progress id="timer" max="${q.seconds * 1000}" aria-label="Time remaining"></progress>`}
    <p>${kind} · ${rule}</p>
    <h1>${escape(q.title)}</h1>
    ${q.visual ? movementLab(q.visual) : ''}
    ${q.kind === 'clue' ? `<p class="round-callout">${q.hint ? `Clue · ${escape(q.hint)}` : 'Clue drops halfway through the timer.'}</p>` : ''}
    ${q.kind === 'confidence' && live && !s.locked ? `<div class="round-callout actions">
      <button class="secondary" data-action="bold" aria-pressed="${bold}" ${canAnswer ? '' : 'disabled'}>${bold ? 'Double Down active' : 'Double Down'}</button>
      <span>${bold ? 'Risking 200 for a 400-point bonus' : 'Safe play selected'}</span>
    </div>` : ''}
    <div class="options">${q.options.map((option, index) => {
      const selected = s.selected === index;
      const correct = revealed && s.reveal.correct === index;
      const type = correct ? 'correct' : selected ? (revealed ? 'wrong' : 'selected') : '';
      return `<button class="choice ${type}" data-action="answer" data-choice="${index}" ${canAnswer && !selected ? '' : 'disabled'}><span class="letter">${'ABCD'[index] || index + 1}</span>
        <span>${escape(option)}${correct ? ' ✓' : ''}${selected ? '<small> · Your answer</small>' : ''}</span></button>`;
    }).join('')}</div>
    ${canAnswer && q.kind === 'retry' && s.selected !== null ?
      `<button class="secondary retry" data-action="lock">Lock this answer</button>` : ''}
    ${revealed ? `<div class="feedback">
      <strong>${s.host ? 'Correct answer' : s.selected === null ? 'No answer submitted' : award ? `${pointLabel(award.points)} points` : '0 points'}</strong>
      ${award?.base ? `<p class="breakdown">${award.rank ? `Correct answer #${award.rank} · ` : ''}${numbers.format(award.base)} base
        ${award.bonuses.map(([label, points]) => ` · ${label} ${pointLabel(points)}`).join('')}</p>` : award?.bonuses.length ?
        `<p class="breakdown">Double Down ${pointLabel(award.points)}</p>` : ''}
      <p>${escape(correctChoice)} · ${escape(s.reveal.explanation)}</p>
    </div>${s.host ? `<button class="primary" data-action="next">${s.index + 1 === s.total ? 'Show final standings' : 'Next question'}</button>` : '<p>Waiting for the host to continue.</p>'}` :
      `<p>${s.locked ? '✓ Answer locked. ' : s.selected !== null ? 'Answer saved. Keep it or change it once. ' : ''}${s.answered} locked in · ${active} connected</p>`}
    </section>`;
}

function finale(s) {
  const leaders = s.players.filter(p => p.score === s.players[0]?.score);
  const me = s.players.find(p => p.me);
  return `<section class="panel">
    <p class="eyebrow">🏆 FINAL STANDINGS</p>
    <h1>Quest complete!</h1>
    ${leaders.length && (leaders.length < s.players.length || leaders[0].score !== 0) ? `<h2>${leaders.map(p => escape(p.name)).join(', ')} ${leaders.length === 1 ? 'wins' : 'tie for first'}</h2><p>${numbers.format(leaders[0].score)} points</p>` : '<p>The points table is tied at zero.</p>'}
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
  const seconds = Math.ceil(left / 1000);
  document.querySelector('#clock').textContent = `${seconds}s`;
  progress.classList.toggle('fuse', state.question.kind === 'bomb' && left <= progress.max * 0.3);
  if (seconds > 0 && seconds <= 3 && lastBeep !== seconds) {
    lastBeep = seconds;
    cue([seconds === 1 ? 640 : 450]);
  }
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
  if (state?.index !== next.index) {
    compare = 'all';
    bold = false;
    lastBeep = undefined;
  }
  if (!changed && next.question?.hint && !state?.question?.hint) cue([540, 740]);
  state = next;
  clockOffset = next.now - Date.now();
  render();
  if (changed) {
    if (next.phase === 'question') cue([392, 523]);
    if (next.phase === 'results') cue(next.host || next.selected === next.reveal.correct ? [523, 659, 784] : [330, 247]);
    if (next.phase === 'finished') cue([392, 523, 659, 784]);
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
  if (action === 'compare') {
    compare = choice;
    return render();
  }
  if (action === 'bold') {
    bold = !bold;
    cue([bold ? 620 : 440]);
    return render();
  }
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
  if (['answer', 'lock'].includes(action) && !lockedRequest) {
    lockedRequest = true;
    render();
    const lock = action === 'lock';
    request('answer', { choice: lock ? state.selected : Number(choice), index: state.index, bold, lock }, result => {
      lockedRequest = false;
      if (result.error) toast(result.error);
      else cue([490]);
      render();
    });
  }
});

setInterval(tick, 100);
render();
