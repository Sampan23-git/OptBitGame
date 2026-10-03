(function () {
  'use strict';

  // Each song page sets window.RHYTHM_GAME_CONFIG before including this file:
  //   { beatmapPath: './БІти/song.json', menuHref: 'index.html', baseFallSpeed: 430 }
  const config = window.RHYTHM_GAME_CONFIG || {};
  const beatmapPath = config.beatmapPath;
  const menuHref = config.menuHref || 'index.html';
  const missesLimit = config.missesLimit || 100;
  const roundDurationMsFallback = config.roundDurationMs || 3 * 60 * 1000;

  // --- Tunable difficulty/feel constants -----------------------------------
  const baseFallSpeed = Number(config.baseFallSpeed) || 430; // px/sec baseline
  const hitWindowSec = 0.14;   // +/- how forgiving a hit is, in seconds of real audio time
  const minLeadTimeSec = 0.35; // never give the player less reaction time than this
  // ---------------------------------------------------------------------------

  const engine = window.beatmapEngine;

  let buttons = [];
  let laneButtons = [];
  let lanes = [];
  let laneButtonRects = [];
  const screenEl = document.querySelector('.screen');
  const laneControlsEl = document.querySelector('.lane-controls');
  let selectedLaneCount = Number(config.laneCount) || 4;

  const laneLayouts = {
    4: {
      glyphs: ['←', '↓', '↑', '→'],
      keys: { ArrowLeft: 0, ArrowDown: 1, ArrowUp: 2, ArrowRight: 3, KeyA: 0, KeyS: 1, KeyW: 2, KeyD: 3 }
    },
    6: {
      glyphs: ['A', 'S', 'D', 'J', 'K', 'L'],
      keys: { KeyA: 0, KeyS: 1, KeyD: 2, KeyJ: 3, KeyK: 4, KeyL: 5 }
    }
  };

  function buildLayoutButtons(targetLaneCount) {
    const lanesEl = document.querySelector('.lanes');
    const controlsEl = document.querySelector('.lane-controls');
    const buttonsEl = document.querySelector('.buttons');
    const glyphs = laneLayouts[targetLaneCount] ? laneLayouts[targetLaneCount].glyphs : laneLayouts[4].glyphs;

    if (lanesEl) {
      lanesEl.innerHTML = '';
      lanesEl.style.setProperty('--lane-count', String(targetLaneCount));
      for (let i = 0; i < targetLaneCount; i++) {
        const lane = document.createElement('div');
        lane.className = 'lane';
        lanesEl.appendChild(lane);
      }
    }

    if (controlsEl) {
      controlsEl.innerHTML = '';
      controlsEl.style.setProperty('--lane-count', String(targetLaneCount));
      for (let i = 0; i < targetLaneCount; i++) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'lane-button';
        btn.dataset.lane = String(i);
        btn.textContent = glyphs[i];
        controlsEl.appendChild(btn);
      }
    }

    if (buttonsEl) {
      buttonsEl.innerHTML = '';
      buttonsEl.style.setProperty('--button-count', String(targetLaneCount));
      for (let i = 0; i < targetLaneCount; i++) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'arrow-button';
        btn.textContent = glyphs[i];
        buttonsEl.appendChild(btn);
      }
    }

    buttons = Array.from(document.querySelectorAll('.arrow-button'));
    laneButtons = Array.from(document.querySelectorAll('.lane-button'));
    lanes = Array.from(document.querySelectorAll('.lane'));

    buttons.forEach((btn, i) => btn.addEventListener('click', () => triggerHit(i)));
    laneButtons.forEach((btn) => { const i = Number(btn.dataset.lane); btn.addEventListener('click', () => triggerHit(i)); });

    if (screenEl) {
      screenEl.style.setProperty('--lane-count', String(targetLaneCount));
    }
    recomputeLaneButtonRects();
  }

  buildLayoutButtons(selectedLaneCount);

  // Notes use compositor-friendly CSS transform animations. The JS loop only
  // schedules notes and handles hit/miss logic; it never rewrites note position
  // every frame. This is intentionally friendlier to Gecko/Firefox-derived
  // browsers where main-thread requestAnimationFrame can be less consistent.
  const comboText = document.getElementById('combo');
  const scoreText = document.getElementById('score');
  const missesText = document.getElementById('misses');
  const accuracyText = document.getElementById('accuracy');
  const timeLeftText = document.getElementById('timeLeft');
  const message = document.getElementById('message');
  const startButton = document.getElementById('startButton');
  const stopButton = document.getElementById('stopButton');
  const mainMenuBtn = document.getElementById('mainMenuBtn');
  const volumeControl = document.getElementById('volumeControl');
  const bgAudio = document.getElementById('bgAudio');
  const endModal = document.getElementById('endModal');
  const endModalTitle = document.getElementById('endModalTitle');
  const endModalMsg = document.getElementById('endModalMsg');
  const playAgainBtn = document.getElementById('playAgainBtn');
  const closeModalBtn = document.getElementById('closeModalBtn');

  let physicalKeyMap = laneLayouts[4].keys;
  let arrowGlyphs = laneLayouts[4].glyphs;
  const spawnY = -60;

  function syncKeyMapForLaneCount(laneCount) {
    const layout = laneLayouts[laneCount] || laneLayouts[4];
    physicalKeyMap = { ...layout.keys };
    arrowGlyphs = [...layout.glyphs];
  }

  let beatmap = null;
  let chart = [];          // full note chart for the round, sorted by spawnTime
  let nextChartIndex = 0;  // walk pointer into `chart`
  let spawned = [];        // notes currently visible on screen
  let activeGroups = [];   // chord groups still in play

  let combo = 0, score = 0, misses = 0, hits = 0, totalNotes = 0;
  let playing = false;
  let roundDurationMs = roundDurationMsFallback;
  let roundTimeout = null;
  let rafId = null;

  window.addEventListener('error', (ev) => {
    try { message.textContent = 'Error: ' + (ev.message || ev.error || 'unknown'); message.style.color = '#ff3333'; } catch (e) {}
  });
  window.addEventListener('unhandledrejection', (ev) => {
    try { message.textContent = 'Promise rejection: ' + (ev.reason && ev.reason.message ? ev.reason.message : ev.reason); message.style.color = '#ff3333'; } catch (e) {}
  });

  async function ensureBeatmap() {
    if (beatmap || !engine || !beatmapPath) return beatmap;
    try {
      beatmap = await engine.loadBeatmap(beatmapPath);
    } catch (e) {
      beatmap = null;
    }
    return beatmap;
  }
  ensureBeatmap();

  // Used only if the JSON beatmap can't be loaded, so the page still works.
  function buildFallbackChart(durationSec, laneCount = selectedLaneCount) {
    const notes = [];
    const step = 60 / 120;
    let lane = 0;
    for (let t = 1.5; t < durationSec - 1; t += step) {
      notes.push({ time: t, lane, source: 'beat', hit: false, missed: false, groupId: null });
      lane = (lane + 1) % laneCount;
    }
    return notes;
  }

  function clamp01(v) { return Math.min(1, Math.max(0, v)); }
  function formatScore(n) { return String(n).padStart(6, '0'); }
  function formatTime(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(s / 60), sec = s % 60;
    return String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
  }

  function getScreenRect() { return screenEl.getBoundingClientRect(); }

  // The hit line is shared by all four lanes. Measure it once per round/resize.
  function getHitLineY() {
    const screenRect = getScreenRect();
    if (laneControlsEl) {
      const r = laneControlsEl.getBoundingClientRect();
      return (r.top - screenRect.top) + r.height / 2 - 20;
    }
    return screenEl.clientHeight - 90;
  }

  let cachedHitLineY = null;

  function getFallSpeedAt(t) {
    if (!beatmap || !engine) return baseFallSpeed;
    return engine.getFallSpeed(beatmap, t, baseFallSpeed);
  }

  // A note is scheduled from the audio clock, not from frame count. Its CSS
  // transform animation then runs independently of the JS animation loop.
  function scheduleNote(note) {
    const hitY = cachedHitLineY == null ? getHitLineY() : cachedHitLineY;
    const speed = getFallSpeedAt(note.time);
    const distance = Math.max(60, hitY - spawnY);
    const leadTimeSec = Math.max(minLeadTimeSec, distance / speed);
    note.spawnTime = note.time - leadTimeSec;
    note.hitY = hitY;
    note.visualDurationMs = Math.max(1, leadTimeSec * 1000);
    return note;
  }

  function createNoteElement(note, audioTime) {
    const laneEl = lanes[note.lane];
    if (!laneEl) return;

    const el = document.createElement('div');
    el.className = 'note';
    el.textContent = arrowGlyphs[note.lane];
    el.style.left = '50%';
    el.style.top = '0';

    // CSS transform animation is compositor-friendly and avoids rewriting
    // style.transform from JavaScript every animation frame.
    el.style.setProperty('--note-start-y', spawnY + 'px');
    el.style.setProperty('--note-end-y', note.hitY + 'px');
    el.style.setProperty('--note-duration', note.visualDurationMs + 'ms');

    // We create notes slightly ahead of their spawn time. animation-delay
    // keeps the visual start locked to the audio clock; if JS is late, a
    // negative delay starts the animation at the correct point instead of
    // visibly jumping from the top.
    const delayMs = (note.spawnTime - audioTime) * 1000;
    el.style.animationDelay = delayMs + 'ms';
    el.style.animationPlayState = 'running';

    laneEl.appendChild(el);
    note.el = el;
    note._removed = false;
    spawned.push(note);
    totalNotes++;

    if (note.groupId) {
      let group = activeGroups.find((g) => g.id === note.groupId);
      if (!group) {
        group = { id: note.groupId, notes: [], hitLanes: new Set(), resolved: false };
        activeGroups.push(group);
      }
      group.notes.push(note);
    }
  }

  // Lane button positions relative to .screen, cached once per round (and on
  // resize) instead of measured with getBoundingClientRect() on every hit.
  // Reading layout geometry right after flashButton() adds its classes forces
  // a synchronous reflow on every keypress; the buttons don't move otherwise.
  function recomputeLaneButtonRects() {
    if (!screenEl) return;
    const screenRect = getScreenRect();
    laneButtonRects = Array.prototype.map.call(laneButtons, (btn) => {
      const rect = btn.getBoundingClientRect();
      return {
        left: (rect.left + rect.right) / 2 - screenRect.left,
        top: (rect.top + rect.height / 2) - screenRect.top
      };
    });
  }
  window.addEventListener('resize', () => {
    recomputeLaneButtonRects();
    cachedHitLineY = getHitLineY();
  });

  function spawnFlyingNote(laneIndex, type) {
    try {
      if (!screenEl) return;
      const el = document.createElement('div');
      el.className = 'flying-note ' + (type || 'hit');
      el.textContent = arrowGlyphs[laneIndex] || '';
      const cached = laneButtonRects[laneIndex];
      const left = cached ? cached.left : screenEl.clientWidth / 2;
      const top = cached ? cached.top : screenEl.clientHeight - 80;
      el.style.left = left + 'px';
      el.style.top = top + 'px';
      const duration = 350; // shorter life -> fewer flying-notes ever overlap during a fast combo
      el.style.animationDuration = duration + 'ms';
      screenEl.appendChild(el);
      setTimeout(() => { try { el.remove(); } catch (e) {} }, duration + 150);
    } catch (e) {}
  }

  // UI is deliberately split into two small render paths. Gameplay state changes
  // are rendered only when they actually happen; the clock is the only value that
  // needs periodic updates, and it only changes once per displayed second. This
  // avoids touching DOM text nodes from the animation loop.
  function setTextIfChanged(el, value, cache, key) {
    value = String(value);
    if (cache[key] === value) return;
    cache[key] = value;
    el.textContent = value;
  }

  const rendered = {
    combo: null,
    score: null,
    misses: null,
    accuracy: null,
    time: null
  };

  function renderStatsUI() {
    setTextIfChanged(comboText, combo, rendered, 'combo');
    setTextIfChanged(scoreText, formatScore(score), rendered, 'score');
    setTextIfChanged(missesText, misses, rendered, 'misses');
    const accuracy = (totalNotes === 0 ? 100 : Math.round((hits / totalNotes) * 100)) + '%';
    setTextIfChanged(accuracyText, accuracy, rendered, 'accuracy');
  }

  function renderTimerUI(remainingMs) {
    setTextIfChanged(timeLeftText, formatTime(remainingMs), rendered, 'time');
  }

  function removeNote(note, disabledClass) {
    if (note.el) {
      const el = note.el;
      if (disabledClass) {
        el.classList.add(disabledClass);
        setTimeout(() => { try { el.remove(); } catch (e) {} }, 700);
      } else {
        try { el.remove(); } catch (e) {}
      }
    }
    // CSS-animated notes disappear immediately on hit; missed notes may keep
    // a short disabled state for the hit-feedback effect. Do not allocate a
    // new array on every hit/miss. The active-note list is
    // compacted once per frame after all notes have been processed.
    note._removed = true;
  }

  function resolveGroupIfComplete(group) {
    if (!group || group.resolved) return;
    if (group.hitLanes.size >= group.notes.length) {
      group.resolved = true;
      const reward = 120 + group.notes.length * 50;
      score += reward;
      combo += 1;
      message.textContent = group.notes.length >= 4 ? 'PERFECT!' : 'DOUBLE!';
      message.style.color = '#7cffb2';
      activeGroups = activeGroups.filter((g) => g.id !== group.id);
    }
  }

  function registerMissSilently(note) {
    if (note.missed || note.hit) return;
    note.missed = true;
    removeNote(note, 'disabled');
  }

  function registerMiss(note) {
    if (note.missed || note.hit) return;
    note.missed = true;
    misses++; combo = 0;
    message.textContent = 'MISS!'; message.style.color = '#ff6b6b';
    removeNote(note, 'disabled');
    renderStatsUI();

    if (note.groupId) {
      const group = activeGroups.find((g) => g.id === note.groupId);
      if (group && !group.resolved) {
        group.resolved = true;
        group.notes.forEach((n) => { if (n !== note) registerMissSilently(n); });
        activeGroups = activeGroups.filter((g) => g.id !== group.id);
      }
    }

    if (misses >= missesLimit) endRound('too many misses');
  }

  function flashButton(laneIndex) {
    try {
      if (buttons[laneIndex]) { buttons[laneIndex].classList.add('active'); setTimeout(() => buttons[laneIndex].classList.remove('active'), 100); }
      const lb = laneButtons[laneIndex];
      if (lb) { lb.classList.add('active'); setTimeout(() => lb.classList.remove('active'), 100); }
    } catch (e) {}
  }

  function triggerHit(laneIndex) {
    if (!playing) return;
    if (laneButtons[laneIndex] && laneButtons[laneIndex].disabled) return;
    flashButton(laneIndex);

    const currentTime = bgAudio.currentTime || 0;
    let best = null, bestDiff = Infinity;
    for (const note of spawned) {
      if (note.lane !== laneIndex || note.hit || note.missed) continue;
      const diff = Math.abs(currentTime - note.time);
      if (diff < bestDiff) { bestDiff = diff; best = note; }
    }

    if (!best || bestDiff > hitWindowSec) {
      misses++; combo = 0;
      const early = best && best.time > currentTime;
      message.textContent = early ? 'EARLY' : 'MISS!';
      message.style.color = early ? '#ffd86b' : '#ff6b6b';
      spawnFlyingNote(laneIndex, 'miss');
      renderStatsUI();
      if (misses >= missesLimit) endRound('too many misses');
      return;
    }

    best.hit = true;

    if (best.groupId) {
      const group = activeGroups.find((g) => g.id === best.groupId);
      if (group) {
        hits++; // still counts toward accuracy, even though score comes from the group bonus
        group.hitLanes.add(laneIndex);
        spawnFlyingNote(laneIndex, 'group');
        removeNote(best, null);
        resolveGroupIfComplete(group);
        renderStatsUI();
        return;
      }
    }

    hits++; combo++;
    const accuracyFactor = clamp01(1 - bestDiff / hitWindowSec);
    score += Math.round(100 * (0.5 + accuracyFactor * 0.5));
    message.textContent = 'GOOD!'; message.style.color = '#7cffb2';
    spawnFlyingNote(laneIndex, 'hit');
    removeNote(best, null);
    renderStatsUI();
  }

  buttons.forEach((btn, i) => btn.addEventListener('click', () => triggerHit(i)));
  laneButtons.forEach((btn) => { const i = Number(btn.dataset.lane); btn.addEventListener('click', () => triggerHit(i)); });
  document.addEventListener('keydown', (e) => {
    if (e.repeat) return; // held key -> browser auto-repeats keydown; ignore, don't count as extra misses
    const idx = physicalKeyMap[e.code];
    if (idx !== undefined) { e.preventDefault(); triggerHit(idx); }
  }, { passive: false });

  let lastUiSecond = -1;
  let lastLogicTime = 0;
  const NOTE_SCHEDULE_LOOKAHEAD_SEC = 0.12;

  function gameLoop() {
    if (!playing) return;
    const currentTime = bgAudio.currentTime || 0;

    // Schedule visual note animations a little early. This decouples note
    // motion from requestAnimationFrame frequency while keeping hit/miss logic
    // on the authoritative audio clock.
    const scheduleUntil = currentTime + NOTE_SCHEDULE_LOOKAHEAD_SEC;
    while (nextChartIndex < chart.length && chart[nextChartIndex].spawnTime <= scheduleUntil) {
      createNoteElement(chart[nextChartIndex], currentTime);
      nextChartIndex++;
    }

    // Miss detection still uses audio time, never frame count.
    for (let i = 0; i < spawned.length; i++) {
      const note = spawned[i];
      if (note.hit || note.missed) continue;
      if (currentTime > note.time + hitWindowSec) registerMiss(note);
    }

    let writeIndex = 0;
    for (let readIndex = 0; readIndex < spawned.length; readIndex++) {
      const note = spawned[readIndex];
      if (note._removed) continue;
      spawned[writeIndex++] = note;
    }
    spawned.length = writeIndex;

    const uiSecond = Math.floor(currentTime);
    if (uiSecond !== lastUiSecond) {
      lastUiSecond = uiSecond;
      renderTimerUI(Math.max(0, roundDurationMs - currentTime * 1000));
    }

    const chartExhausted = nextChartIndex >= chart.length && spawned.length === 0;
    if (chartExhausted && (bgAudio.ended || currentTime * 1000 >= roundDurationMs)) {
      endRound('time');
      return;
    }

    lastLogicTime = currentTime;
    rafId = requestAnimationFrame(gameLoop);
  }

  function stopLoop() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  }

  function showLaneModePicker() {
    const existing = document.getElementById('laneModePicker');
    if (existing) {
      existing.remove();
    }

    const panel = document.createElement('div');
    panel.id = 'laneModePicker';
    panel.className = 'lane-mode-picker';
    panel.innerHTML = `
      <div class="lane-mode-card">
        <h3>Вибери режим раунду</h3>
        <div class="lane-mode-options">
          <button type="button" class="lane-mode-btn" data-lane-count="4">
            <span>4 кнопки</span>
            <small>← ↓ ↑ →</small>
          </button>
          <button type="button" class="lane-mode-btn" data-lane-count="6">
            <span>6 кнопок</span>
            <small>A S D J K L</small>
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(panel);

    panel.querySelectorAll('.lane-mode-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const laneCount = Number(btn.dataset.laneCount) || 4;
        selectedLaneCount = laneCount;
        syncKeyMapForLaneCount(laneCount);
        buildLayoutButtons(laneCount);
        panel.remove();
        startRound();
      });
    });
  }

  async function startRound() {
    await ensureBeatmap();

    const durationSec = (bgAudio && isFinite(bgAudio.duration) && bgAudio.duration > 0)
      ? bgAudio.duration
      : roundDurationMsFallback / 1000;
    roundDurationMs = durationSec * 1000;
    syncKeyMapForLaneCount(selectedLaneCount);

    chart = beatmap ? engine.buildChart(beatmap, { laneCount: selectedLaneCount }) : buildFallbackChart(durationSec, selectedLaneCount);
    chart.forEach(scheduleNote);
    chart.sort((a, b) => a.spawnTime - b.spawnTime);
    nextChartIndex = 0;

    combo = 0; score = 0; misses = 0; hits = 0; totalNotes = 0;
    spawned.forEach((n) => { try { n.el && n.el.remove(); } catch (e) {} });
    spawned = [];
    activeGroups = [];
    cachedHitLineY = getHitLineY();
    renderStatsUI();
    renderTimerUI(roundDurationMs);

    try { laneButtons.forEach((b) => { b.disabled = false; b.classList.remove('disabled'); }); } catch (e) {}
    recomputeLaneButtonRects();

    bgAudio.volume = Number(volumeControl.value);
    bgAudio.currentTime = 0;

    playing = true;
    stopButton.disabled = false; stopButton.style.display = 'inline-block';
    startButton.style.display = 'none';
    message.textContent = 'Гра почалась!'; message.style.color = '#d64c9b';

    if (roundTimeout) clearTimeout(roundTimeout);
    roundTimeout = setTimeout(() => endRound('time'), roundDurationMs + 2000);

    try { await bgAudio.play(); } catch (e) { /* needs a user gesture; Start click already provided one */ }

    stopLoop();
    lastUiSecond = -1;
    rafId = requestAnimationFrame(gameLoop);
  }

  function endRound(reason) {
    if (!playing) return;
    playing = false;
    stopLoop();
    if (roundTimeout) { clearTimeout(roundTimeout); roundTimeout = null; }

    stopButton.disabled = true; stopButton.style.display = 'none';
    startButton.style.display = 'inline-block'; startButton.disabled = false;

    try { bgAudio.pause(); bgAudio.currentTime = 0; } catch (e) {}

    message.style.color = '#ffd86b';
    let reasonText = '';
    if (reason === 'too many misses') reasonText = `Гру завершено — забагато помилок (${misses}). `;
    else if (reason === 'stopped') reasonText = 'Гра зупинена. ';
    message.textContent = `${reasonText}Підсумок: ${scoreText.textContent} очок. Натисніть "Почати гру" щоб зіграти ще.`;
    startButton.textContent = 'Грати ще раз';

    if (reason === 'time') {
      try {
        endModalTitle.textContent = 'Вітаємо!';
        endModalMsg.textContent = `Раунд завершено. Ваш рахунок: ${scoreText.textContent} очок.`;
        endModal.classList.add('visible'); endModal.setAttribute('aria-hidden', 'false');
      } catch (e) {}
    }
  }

  startButton.addEventListener('click', () => {
    showLaneModePicker();
  });
  stopButton.addEventListener('click', () => endRound('stopped'));
  volumeControl.addEventListener('input', () => { bgAudio.volume = Number(volumeControl.value); });

  try {
    playAgainBtn.addEventListener('click', () => {
      endModal.classList.remove('visible'); endModal.setAttribute('aria-hidden', 'true');
      showLaneModePicker();
    });
    closeModalBtn.addEventListener('click', () => {
      endModal.classList.remove('visible'); endModal.setAttribute('aria-hidden', 'true');
    });
    endModal.addEventListener('click', (e) => {
      if (e.target === endModal) { endModal.classList.remove('visible'); endModal.setAttribute('aria-hidden', 'true'); }
    });
  } catch (e) {}

  mainMenuBtn.addEventListener('click', () => {
    stopLoop();
    if (roundTimeout) clearTimeout(roundTimeout);
    playing = false;
    try { bgAudio.pause(); bgAudio.currentTime = 0; } catch (e) {}
    window.location.href = menuHref;
  });
})();
