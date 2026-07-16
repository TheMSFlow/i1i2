(() => {
  const STORAGE_KEY = 'i1i2-state-v1';

  /* ---------- state ---------- */
  let state = {
    sideSize: null,
    groups: [],       // [{id, players:[...], incomplete:bool}]
    queue: [],        // array of group ids waiting
    active: [null, null], // [groupId, groupId] currently on pitch
    streaks: {},       // groupId -> streak count
    duration: 300,     // seconds, referee-set round length
    remaining: 300,
    timerRunning: false,
    timerEndsAt: null, // epoch ms, used to survive refresh while running
  };

  /* ---------- persistence ---------- */
  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function load() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    try {
      const parsed = JSON.parse(raw);
      state = Object.assign(state, parsed);
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ---------- dom refs ---------- */
  const setupScreen = document.getElementById('setup-screen');
  const gameScreen = document.getElementById('game-screen');
  const formatGrid = document.getElementById('format-grid');
  const playerCountInput = document.getElementById('player-count');
  const createGroupsBtn = document.getElementById('create-groups-btn');
  const setupError = document.getElementById('setup-error');

  const teamALabel = document.getElementById('team-a-label');
  const teamBLabel = document.getElementById('team-b-label');
  const teamANumbers = document.getElementById('team-a-numbers');
  const teamBNumbers = document.getElementById('team-b-numbers');
  const teamAStreak = document.getElementById('team-a-streak');
  const teamBStreak = document.getElementById('team-b-streak');
  const teamAStreakCount = document.getElementById('team-a-streak-count');
  const teamBStreakCount = document.getElementById('team-b-streak-count');
  const teamAGoalBtn = document.getElementById('team-a-goal');
  const teamBGoalBtn = document.getElementById('team-b-goal');

  const timerDisplay = document.getElementById('timer-display');
  const durationInput = document.getElementById('duration-input');
  const presetRow = document.querySelector('.preset-row');
  const startTimerBtn = document.getElementById('start-timer-btn');
  const pauseTimerBtn = document.getElementById('pause-timer-btn');
  const resumeTimerBtn = document.getElementById('resume-timer-btn');
  const timerSetupControls = document.getElementById('timer-setup-controls');
  const timerRunningControls = document.getElementById('timer-running-controls');

  const queueList = document.getElementById('queue-list');
  const queueEmpty = document.getElementById('queue-empty');
  const newGameBtn = document.getElementById('new-game-btn');
  const whistleFlash = document.getElementById('whistle-flash');

  let selectedSize = null;
  let selectedPreset = null;
  let tickHandle = null;
  let audioCtx = null;
  let wakeLock = null;

  /* ---------- setup screen ---------- */

  formatGrid.addEventListener('click', (e) => {
    const btn = e.target.closest('.format-btn');
    if (!btn) return;
    selectedSize = parseInt(btn.dataset.size, 10);
    [...formatGrid.children].forEach(b => b.classList.toggle('selected', b === btn));
    validateSetup();
  });

  playerCountInput.addEventListener('input', validateSetup);

  function validateSetup() {
    const n = parseInt(playerCountInput.value, 10);
    const valid = selectedSize && n >= selectedSize * 2;
    createGroupsBtn.disabled = !valid;
    setupError.hidden = true;
  }

  createGroupsBtn.addEventListener('click', () => {
    const n = parseInt(playerCountInput.value, 10);
    if (!selectedSize || !n || n < selectedSize * 2) {
      setupError.textContent = `You need at least ${selectedSize * 2} players to field two ${selectedSize}v${selectedSize} squads.`;
      setupError.hidden = false;
      return;
    }
    startNewGame(selectedSize, n);
  });

  /* ---------- grouping logic ---------- */

  function shuffledNumbers(n) {
    const arr = Array.from({ length: n }, (_, i) => i + 1);
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function buildGroups(size, n) {
    const shuffled = shuffledNumbers(n);
    const groups = [];
    let id = 1;
    for (let i = 0; i < shuffled.length; i += size) {
      const players = shuffled.slice(i, i + size);
      groups.push({
        id: id++,
        players,
        incomplete: players.length < size,
      });
    }
    return groups;
  }

  function startNewGame(size, n) {
    const groups = buildGroups(size, n);
    const ids = groups.map(g => g.id);

    state = {
      sideSize: size,
      groups,
      queue: ids.slice(2),
      active: [ids[0] ?? null, ids[1] ?? null],
      streaks: { [ids[0]]: 0, [ids[1]]: 0 },
      duration: state.duration || 300,
      remaining: state.duration || 300,
      timerRunning: false,
      timerEndsAt: null,
    };
    save();
    render();
  }

  function groupById(id) {
    return state.groups.find(g => g.id === id);
  }

  /* ---------- goal / swap logic ---------- */

  function handleGoal(side) {
    if (state.active[0] === null || state.active[1] === null) return;
    const winnerSlot = side === 'a' ? 0 : 1;
    const loserSlot = side === 'a' ? 1 : 0;
    const winnerId = state.active[winnerSlot];

    state.streaks[winnerId] = (state.streaks[winnerId] || 0) + 1;

    // loser goes to back of queue
    state.queue.push(state.active[loserSlot]);

    // pull next challenger
    const nextId = state.queue.shift() ?? null;
    state.active[loserSlot] = nextId;
    if (nextId !== null) state.streaks[nextId] = 0;

    // fresh clock for the new matchup
    state.remaining = state.duration;
    if (state.timerRunning) {
      state.timerEndsAt = Date.now() + state.remaining * 1000;
      runTick();
    }

    save();
    render();
  }

  teamAGoalBtn.addEventListener('click', () => handleGoal('a'));
  teamBGoalBtn.addEventListener('click', () => handleGoal('b'));

  /* ---------- timer ---------- */

  function formatTime(sec) {
    const m = Math.floor(sec / 60).toString().padStart(2, '0');
    const s = Math.floor(sec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  function setDuration(minutes) {
    state.duration = minutes * 60;
    if (!state.timerRunning) state.remaining = state.duration;
    save();
    render();
  }

  durationInput.addEventListener('change', () => {
    const m = Math.max(1, Math.min(60, parseInt(durationInput.value, 10) || 5));
    durationInput.value = m;
    selectedPreset = null;
    [...presetRow.children].forEach(b => b.classList.remove('selected'));
    setDuration(m);
  });

  presetRow.addEventListener('click', (e) => {
    const btn = e.target.closest('.preset-btn');
    if (!btn) return;
    const m = parseInt(btn.dataset.min, 10);
    durationInput.value = m;
    [...presetRow.children].forEach(b => b.classList.toggle('selected', b === btn));
    setDuration(m);
  });

  /* ---------- audio + wake lock ---------- */

  // Create/resume the AudioContext from within a user gesture so the whistle
  // is allowed to sound later (iOS Safari blocks contexts created off-gesture).
  function ensureAudio() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      if (!audioCtx) audioCtx = new Ctx();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      return audioCtx;
    } catch (e) {
      return null;
    }
  }

  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch (e) {
      // denied or unsupported, ignore
    }
  }

  function releaseWakeLock() {
    try {
      if (wakeLock) { wakeLock.release(); wakeLock = null; }
    } catch (e) { /* ignore */ }
  }

  // The OS auto-drops a wake lock when the tab is hidden; re-acquire on return.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.timerRunning) requestWakeLock();
  });

  startTimerBtn.addEventListener('click', () => {
    ensureAudio();
    requestWakeLock();
    state.timerRunning = true;
    state.timerEndsAt = Date.now() + state.remaining * 1000;
    save();
    render();
    runTick();
  });

  pauseTimerBtn.addEventListener('click', () => {
    state.timerRunning = false;
    state.remaining = Math.max(0, Math.round((state.timerEndsAt - Date.now()) / 1000));
    state.timerEndsAt = null;
    releaseWakeLock();
    save();
    render();
  });

  resumeTimerBtn.addEventListener('click', () => {
    ensureAudio();
    requestWakeLock();
    state.timerRunning = true;
    state.timerEndsAt = Date.now() + state.remaining * 1000;
    save();
    render();
    runTick();
  });

  function runTick() {
    clearInterval(tickHandle);
    tickHandle = setInterval(() => {
      if (!state.timerRunning) { clearInterval(tickHandle); return; }
      const remaining = Math.max(0, Math.round((state.timerEndsAt - Date.now()) / 1000));
      state.remaining = remaining;
      updateTimerDisplay();
      if (remaining <= 0) {
        clearInterval(tickHandle);
        onTimerExpire();
      }
    }, 250);
  }

  function onTimerExpire() {
    state.timerRunning = false;
    state.timerEndsAt = null;
    releaseWakeLock();

    playWhistle();
    flashScreen();

    // both active teams eliminated, go to back of queue
    const [aId, bId] = state.active;
    if (aId !== null) state.queue.push(aId);
    if (bId !== null) state.queue.push(bId);

    const nextA = state.queue.shift() ?? null;
    const nextB = state.queue.shift() ?? null;
    state.active = [nextA, nextB];
    if (nextA !== null) state.streaks[nextA] = 0;
    if (nextB !== null) state.streaks[nextB] = 0;

    state.remaining = state.duration;
    save();
    render();
  }

  /* ---------- whistle synth ---------- */

  function playWhistle() {
    try {
      const ctx = ensureAudio();
      if (!ctx) return;
      const now = ctx.currentTime;
      const duration = 1.3;

      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(2950, now);
      osc.frequency.linearRampToValueAtTime(3150, now + 0.08);
      osc.frequency.linearRampToValueAtTime(2900, now + duration);

      const tremolo = ctx.createOscillator();
      tremolo.frequency.value = 24; // pea-whistle trill rate

      const tremoloGain = ctx.createGain();
      tremoloGain.gain.value = 0.28;
      tremolo.connect(tremoloGain);

      const mainGain = ctx.createGain();
      mainGain.gain.value = 0.32;
      tremoloGain.connect(mainGain.gain);

      osc.connect(mainGain);
      mainGain.connect(ctx.destination);

      mainGain.gain.setValueAtTime(mainGain.gain.value, now + duration - 0.15);
      mainGain.gain.linearRampToValueAtTime(0.0001, now + duration);

      osc.start(now);
      tremolo.start(now);
      osc.stop(now + duration);
      tremolo.stop(now + duration);
      // reuse the shared context; do not close it
    } catch (e) {
      // audio not available, fail silently
    }
  }

  function flashScreen() {
    whistleFlash.classList.remove('active');
    void whistleFlash.offsetWidth; // restart animation
    whistleFlash.classList.add('active');
  }

  /* ---------- render ---------- */

  function renderTeamCard({ groupId, labelEl, numbersEl, streakEl, streakCountEl }) {
    const group = groupId !== null ? groupById(groupId) : null;
    if (!group) {
      labelEl.textContent = 'Waiting for next squad';
      numbersEl.innerHTML = '';
      streakEl.hidden = true;
      return;
    }
    labelEl.innerHTML = `Squad ${group.id}` + (group.incomplete ? '<span class="incomplete-badge" style="margin-left:0.5rem;">Incomplete</span>' : '');
    numbersEl.innerHTML = group.players.map(p => `<span class="number-chip">${p}</span>`).join('');
    const streak = state.streaks[groupId] || 0;
    streakEl.hidden = streak <= 0;
    streakCountEl.textContent = streak;
  }

  function updateTimerDisplay() {
    timerDisplay.textContent = formatTime(state.remaining);
    timerDisplay.classList.toggle('critical', state.remaining <= 10 && state.remaining > 0 && state.timerRunning);
  }

  function render() {
    const hasGame = state.groups.length > 0;
    setupScreen.hidden = hasGame;
    gameScreen.hidden = !hasGame;
    if (!hasGame) return;

    renderTeamCard({
      groupId: state.active[0],
      labelEl: teamALabel, numbersEl: teamANumbers,
      streakEl: teamAStreak, streakCountEl: teamAStreakCount,
    });
    renderTeamCard({
      groupId: state.active[1],
      labelEl: teamBLabel, numbersEl: teamBNumbers,
      streakEl: teamBStreak, streakCountEl: teamBStreakCount,
    });

    const noOpponent = state.active[0] === null || state.active[1] === null;
    teamAGoalBtn.disabled = noOpponent;
    teamBGoalBtn.disabled = noOpponent;

    durationInput.value = Math.round(state.duration / 60);
    updateTimerDisplay();

    timerSetupControls.hidden = state.timerRunning;
    timerRunningControls.hidden = !state.timerRunning;
    pauseTimerBtn.hidden = !state.timerRunning;
    resumeTimerBtn.hidden = true;
    if (!state.timerRunning && state.remaining < state.duration && state.remaining > 0) {
      // paused mid-round
      timerSetupControls.hidden = true;
      timerRunningControls.hidden = false;
      pauseTimerBtn.hidden = true;
      resumeTimerBtn.hidden = false;
    }

    // queue
    queueList.innerHTML = '';
    queueEmpty.hidden = state.queue.length > 0;
    state.queue.forEach((gid, i) => {
      const g = groupById(gid);
      if (!g) return;
      const li = document.createElement('li');
      li.className = 'queue-item';
      li.innerHTML = `
        <span class="queue-position">${i + 1}</span>
        <span class="queue-numbers">Squad ${g.id} — ${g.players.join(', ')}${g.incomplete ? ' (Incomplete)' : ''}</span>
      `;
      queueList.appendChild(li);
    });
  }

  newGameBtn.addEventListener('click', () => {
    if (!confirm('Start a new game? This clears the current squads and queue.')) return;
    clearInterval(tickHandle);
    releaseWakeLock();
    localStorage.removeItem(STORAGE_KEY);
    state = {
      sideSize: null, groups: [], queue: [], active: [null, null],
      streaks: {}, duration: 300, remaining: 300,
      timerRunning: false, timerEndsAt: null,
    };
    selectedSize = null;
    [...formatGrid.children].forEach(b => b.classList.remove('selected'));
    playerCountInput.value = '';
    createGroupsBtn.disabled = true;
    render();
  });

  /* ---------- init ---------- */

  function init() {
    const hadState = load();
    if (hadState && state.timerRunning && state.timerEndsAt) {
      const remaining = Math.max(0, Math.round((state.timerEndsAt - Date.now()) / 1000));
      state.remaining = remaining;
      if (remaining <= 0) {
        onTimerExpire();
      } else {
        requestWakeLock();
        runTick();
      }
    }
    render();
  }

  init();
})();
