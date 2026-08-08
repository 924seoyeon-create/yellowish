(function(){
  "use strict";

  // ============ STATE ============
  const STORAGE_KEYS = {
    tasks: "noreut_tasks",
    sessions: "noreut_sessions",
    focus: "noreut_current_focus",
    seeded: "noreut_seeded"
  };

  const state = {
    tasks: [],
    focusSessions: [],
    currentFocus: null,      // active/paused focus session in progress
    currentScreen: "home",
    detailTaskId: null,
    lastCompleteInfo: null,  // info to render on focus-complete screen
    timerInterval: null,
    displayedUrgency: null   // urgency currently shown on the home fire-stage
  };

  const DURATIONS = [17, 23, 27, 31, 37];

  // Fire always rises from the bottom of the stage toward the foot at the
  // top. Never edit these to move the flame via `top` — see spec rule #16.
  const FLAME_BOTTOM = { 1: 4, 2: 22, 3: 40, 4: 58, 5: 74 };

  const URGENCY_INFO = {
    1: { temp: "따뜻한 온도", message: "아직 여유가 있습니다." },
    2: { temp: "더운 온도", message: "슬슬 시작해도 좋겠습니다." },
    3: { temp: "매우 더운 온도", message: "발등이 따뜻해지고 있습니다." },
    4: { temp: "화상 온도", message: "🔥 발등에 불이 가까워졌습니다." },
    5: { temp: "화재 온도", message: "🔥 발등에 불 떨어졌습니다." }
  };

  // Selectable stopping-rule checkboxes are stored as plain strings split by "\n".

  // ============ STORAGE ============
  function loadData(){
    try{
      state.tasks = JSON.parse(localStorage.getItem(STORAGE_KEYS.tasks)) || [];
    }catch(e){ state.tasks = []; }
    try{
      state.focusSessions = JSON.parse(localStorage.getItem(STORAGE_KEYS.sessions)) || [];
    }catch(e){ state.focusSessions = []; }
    try{
      state.currentFocus = JSON.parse(localStorage.getItem(STORAGE_KEYS.focus)) || null;
    }catch(e){ state.currentFocus = null; }

    if(!localStorage.getItem(STORAGE_KEYS.seeded)){
      seedSampleTask();
      localStorage.setItem(STORAGE_KEYS.seeded, "1");
    }
  }

  function saveTasks(){ localStorage.setItem(STORAGE_KEYS.tasks, JSON.stringify(state.tasks)); }
  function saveSessions(){ localStorage.setItem(STORAGE_KEYS.sessions, JSON.stringify(state.focusSessions)); }
  function saveFocus(){
    if(state.currentFocus){
      localStorage.setItem(STORAGE_KEYS.focus, JSON.stringify(state.currentFocus));
    }else{
      localStorage.removeItem(STORAGE_KEYS.focus);
    }
  }

  function seedSampleTask(){
    const deadline = new Date(Date.now() + 18*60*60*1000);
    state.tasks.push({
      id: uid(),
      title: "보고서 초안 작성",
      nextAction: "첫 번째 문단 작성하기",
      deadline: deadline.toISOString(),
      importance: "high",
      urgency: 4,
      externalCommitment: "",
      externalPerson: "",
      stoppingRule: "",
      createdAt: new Date().toISOString(),
      completedAt: null,
      status: "active",
      isSample: true
    });
    saveTasks();
  }

  function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,8); }

  // ============ TASK ============
  function createTask(data){
    // remove untouched sample task once the user starts adding their own
    const sampleIdx = state.tasks.findIndex(t => t.isSample && t.status === "active");
    if(sampleIdx !== -1){ state.tasks.splice(sampleIdx, 1); }

    const task = {
      id: uid(),
      title: data.title.trim(),
      nextAction: (data.nextAction||"").trim(),
      deadline: data.deadline || null,
      importance: data.importance || "medium",
      urgency: Number(data.urgency)||3,
      externalCommitment: (data.externalCommitment||"").trim(),
      externalPerson: (data.externalPerson||"").trim(),
      stoppingRule: (data.stoppingRule||"").trim(),
      createdAt: new Date().toISOString(),
      completedAt: null,
      status: "active"
    };
    state.tasks.push(task);
    saveTasks();
    return task;
  }

  function updateTask(id, data){
    const t = state.tasks.find(t=>t.id===id);
    if(!t) return;
    Object.assign(t, data);
    saveTasks();
  }

  function completeTask(id){
    const t = state.tasks.find(t=>t.id===id);
    if(!t) return;
    t.status = "completed";
    t.completedAt = new Date().toISOString();
    saveTasks();
  }

  function getActiveTasks(){
    return state.tasks.filter(t=>t.status==="active");
  }

  function isOverdue(task){
    return task.deadline && new Date(task.deadline).getTime() < Date.now();
  }

  function effectiveUrgency(task){
    if(isOverdue(task)) return 5;
    return calculateUrgency(task);
  }

  function calculateUrgency(task){
    // MVP: user-defined urgency is used directly.
    // Later: combine deadline proximity + importance + externalCommitment + behavior patterns.
    return Math.min(5, Math.max(1, task.urgency||3));
  }

  function getCurrentTask(){
    if(state.currentFocus && state.currentFocus.taskId){
      const t = state.tasks.find(t=>t.id===state.currentFocus.taskId && t.status==="active");
      if(t) return t;
    }
    const active = getActiveTasks();
    if(active.length===0) return null;

    const withDeadline = active.filter(t=>t.deadline);
    withDeadline.sort((a,b)=> new Date(a.deadline) - new Date(b.deadline));
    if(withDeadline.length) return withDeadline[0];

    const sorted = active.slice().sort((a,b)=>{
      if(effectiveUrgency(b) !== effectiveUrgency(a)) return effectiveUrgency(b)-effectiveUrgency(a);
      const imp = {low:0, medium:1, high:2};
      return (imp[b.importance]||0) - (imp[a.importance]||0);
    });
    return sorted[0];
  }

  function selectShrineTask(){
    if(state.currentFocus && state.currentFocus.taskId){
      const t = state.tasks.find(t=>t.id===state.currentFocus.taskId && t.status==="active");
      if(t) return t;
    }
    return getCurrentTask();
  }

  // ============ TIME FORMAT ============
  function formatDeadline(iso){
    const d = new Date(iso);
    const mm = d.getMonth()+1, dd = d.getDate();
    const hh = String(d.getHours()).padStart(2,"0"), mi = String(d.getMinutes()).padStart(2,"0");
    return `${mm}월 ${dd}일 ${hh}:${mi}`;
  }

  function formatCountdown(iso){
    const diffMs = new Date(iso).getTime() - Date.now();
    if(diffMs <= 0) return "마감되었습니다.";
    const totalMin = Math.floor(diffMs/60000);
    const days = Math.floor(totalMin/1440);
    const hours = Math.floor((totalMin%1440)/60);
    const mins = totalMin%60;
    if(days > 0) return `${days}일 ${hours}시간`;
    if(hours > 0) return `${hours}시간 ${mins}분`;
    return `${mins}분`;
  }

  const IMPORTANCE_LABEL = { low:"낮음", medium:"보통", high:"높음" };

  // ============ SPLASH (홈) ============
  function enterAppFromSplash(){
    document.getElementById("app").classList.remove("pre-launch");
    showScreen("home");
  }

  // ============ NAVIGATION ============
  function showScreen(name){
    state.currentScreen = name;
    document.querySelectorAll(".screen").forEach(el=>el.classList.remove("active"));
    document.getElementById("screen-"+name).classList.add("active");

    const nav = document.getElementById("bottom-nav");
    const hideNavOn = ["focus", "focus-complete", "add-task", "task-detail", "shrine"];
    nav.classList.toggle("hidden", hideNavOn.includes(name));

    document.querySelectorAll("#bottom-nav button").forEach(b=>{
      b.classList.toggle("active", b.dataset.nav === name);
    });

    if(name==="home") renderHome();
    if(name==="pattern") renderPatterns();
    if(name==="task-detail") renderTaskDetail();
    window.scrollTo(0,0);
  }

  // ============ RENDER: HOME (오늘) ============
  let homeTickInterval = null;

  function renderHome(){
    const container = document.getElementById("home-content");
    const task = getCurrentTask();
    const activeTasks = getActiveTasks();
    state.displayedUrgency = null;

    if(homeTickInterval){ clearInterval(homeTickInterval); homeTickInterval = null; }

    if(!task){
      container.innerHTML = `
        <div class="empty-state">
          <span class="big-emoji">🦶</span>
          <h2>아직 오늘의 작업이 없습니다.</h2>
          <p>오늘 해야 할 일이 있다면<br>하나만 가져와주세요.</p>
          <button class="btn btn-primary" id="empty-add-btn">+ 오늘의 일 추가</button>
        </div>
        <div class="shrine-hint">
          <span class="bell"><img src="icons/sinnaerim.png" alt=""></span>
          갑자기 신내림이 오면<br>바로 시작할 수도 있어요.
        </div>
      `;
      document.getElementById("empty-add-btn").addEventListener("click", ()=>openAddTask());
      return;
    }

    const urgency = effectiveUrgency(task);
    const isExtreme = urgency >= 5;
    const others = activeTasks.length - 1;

    container.innerHTML = `
      <div class="fire-stage" id="home-fire-stage" aria-hidden="true">
        <div class="fire-track">
          <div class="flame" id="home-flame">🔥</div>
          <div class="foot" id="home-foot">🦶</div>
        </div>
      </div>
      <div class="temp-label" id="home-temp-label"></div>
      <div class="urgency-caption" id="home-caption"></div>

      <div class="task-title" id="home-task-title" role="button" tabindex="0">${escapeHtml(task.title)}</div>
      <div class="task-next" id="home-task-next">${task.nextAction ? escapeHtml(task.nextAction) : ""}</div>

      <div class="divider"></div>
      <div id="home-deadline-row"></div>

      <div class="stack">
        <button class="btn btn-primary" id="home-start-btn">🔥 지금 시작</button>
      </div>

      ${others > 0 ? `<div class="other-tasks-link" id="home-others-link">다른 작업 ${others}개</div>` : ""}
    `;

    document.getElementById("home-start-btn").addEventListener("click", ()=>startFocus(task.id, "normal"));
    document.getElementById("home-task-title").addEventListener("click", ()=>openTaskDetail(task.id));
    document.getElementById("home-task-title").addEventListener("keypress", e=>{ if(e.key==="Enter") openTaskDetail(task.id); });
    const othersLink = document.getElementById("home-others-link");
    if(othersLink) othersLink.addEventListener("click", ()=>showOtherTasks());

    applyUrgencyToHome(task, urgency, { skipTransition: true });

    homeTickInterval = setInterval(()=>{
      const t = getCurrentTask();
      if(!t || t.id !== task.id){ renderHome(); return; }
      const u = effectiveUrgency(t);
      applyUrgencyToHome(t, u, { skipTransition: false });
      const row = document.getElementById("home-deadline-row");
      if(row && t.deadline && u < 5){
        const el = document.getElementById("home-countdown");
        if(el) el.textContent = formatCountdown(t.deadline);
      }
    }, 15000);
  }

  // Updates only the fire-stage + labels in place (no innerHTML rebuild)
  // so the flame's `bottom` transition animates smoothly between urgency
  // levels instead of snapping to a new position.
  function applyUrgencyToHome(task, urgency, opts){
    opts = opts || {};
    const changed = state.displayedUrgency !== urgency;
    state.displayedUrgency = urgency;
    const isExtreme = urgency >= 5;
    const info = URGENCY_INFO[urgency];

    const stage = document.getElementById("home-fire-stage");
    const flame = document.getElementById("home-flame");
    const foot = document.getElementById("home-foot");
    if(stage) stage.setAttribute("data-urgency", String(urgency));
    if(flame) flame.style.setProperty("--flame-bottom", FLAME_BOTTOM[urgency] + "%");
    if(foot) foot.classList.toggle("foot-hidden", isExtreme);

    const tempLabel = document.getElementById("home-temp-label");
    if(tempLabel){ tempLabel.textContent = info.temp; tempLabel.classList.toggle("hot", isExtreme); }

    const caption = document.getElementById("home-caption");
    if(caption){
      caption.textContent = isExtreme ? "지금 이것부터." : info.message;
      caption.classList.toggle("hot", isExtreme);
    }

    const nextEl = document.getElementById("home-task-next");
    if(nextEl) nextEl.style.display = isExtreme ? "none" : (task.nextAction ? "" : "none");

    const row = document.getElementById("home-deadline-row");
    if(row){
      if(isExtreme){
        row.innerHTML = `<div class="urgent-line">지금 이것부터.</div>`;
      }else if(task.deadline){
        row.innerHTML = `
          <div class="meta-row">
            <span class="meta-label">마감까지</span>
            <span class="meta-value" id="home-countdown">${formatCountdown(task.deadline)}</span>
          </div>`;
      }else{
        row.innerHTML = "";
      }
    }

    if(changed && !opts.skipTransition){
      // no-op: CSS transition on `bottom`/opacity handles the animation
    }
  }

  function showOtherTasks(){
    const current = getCurrentTask();
    const others = getActiveTasks().filter(t=>t.id !== (current&&current.id));
    if(others.length===0) return;
    const list = others.map(t=>`• ${escapeHtml(t.title)}`).join("<br>");
    showToast(`다른 작업<br><br>${list}`);
  }

  function showToast(html, opts){
    opts = opts || {};
    const overlay = document.createElement("div");
    overlay.className = "toast-overlay";
    overlay.innerHTML = `<div class="toast-card"><p>${html}</p></div>`;
    const close = ()=>{
      overlay.remove();
      if(opts.onClose) opts.onClose();
    };
    overlay.addEventListener("click", close);
    document.getElementById("app").appendChild(overlay);
    if(opts.autoCloseMs) setTimeout(close, opts.autoCloseMs);
  }

  function escapeHtml(str){
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // ============ ADD TASK ============
  function openAddTask(editId){
    state.editTaskId = editId || null;
    const form = document.getElementById("task-form");
    form.reset();
    document.getElementById("add-task-title").textContent = editId ? "작업 수정" : "무엇을 해야 하나요?";

    if(editId){
      const t = state.tasks.find(t=>t.id===editId);
      if(t){
        document.getElementById("f-title").value = t.title;
        document.getElementById("f-next").value = t.nextAction||"";
        if(t.deadline){
          const d = new Date(t.deadline);
          d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
          document.getElementById("f-deadline").value = d.toISOString().slice(0,16);
        }
        document.querySelector(`input[name=importance][value="${t.importance}"]`).checked = true;
        document.querySelector(`input[name=urgency][value="${t.urgency}"]`).checked = true;
        document.getElementById("f-commit").value = t.externalCommitment||"";
        document.getElementById("f-person").value = t.externalPerson||"";
        document.getElementById("f-stop").value = t.stoppingRule||"";
      }
    }
    showScreen("add-task");
  }

  document.getElementById("task-form").addEventListener("submit", function(e){
    e.preventDefault();
    const title = document.getElementById("f-title").value.trim();
    if(!title) return;

    const deadlineRaw = document.getElementById("f-deadline").value;
    const data = {
      title,
      nextAction: document.getElementById("f-next").value,
      deadline: deadlineRaw ? new Date(deadlineRaw).toISOString() : null,
      importance: document.querySelector('input[name=importance]:checked').value,
      urgency: document.querySelector('input[name=urgency]:checked').value,
      externalCommitment: document.getElementById("f-commit").value,
      externalPerson: document.getElementById("f-person").value,
      stoppingRule: document.getElementById("f-stop").value
    };

    if(state.editTaskId){
      updateTask(state.editTaskId, data);
      openTaskDetail(state.editTaskId);
    }else{
      const t = createTask(data);
      openTaskDetail(t.id);
    }
  });

  document.getElementById("add-task-back").addEventListener("click", ()=>{
    if(state.editTaskId){ openTaskDetail(state.editTaskId); }
    else{ showScreen("home"); }
  });

  // ============ TASK DETAIL ============
  function openTaskDetail(id){
    state.detailTaskId = id;
    showScreen("task-detail");
  }

  function renderTaskDetail(){
    const t = state.tasks.find(t=>t.id===state.detailTaskId);
    const container = document.getElementById("detail-content");
    if(!t){
      container.innerHTML = `<p>작업을 찾을 수 없습니다.</p>`;
      return;
    }
    const urgency = effectiveUrgency(t);
    container.innerHTML = `
      <div class="detail-flame">🔥</div>
      <div class="detail-title">${escapeHtml(t.title)}</div>
      ${t.nextAction ? `<div class="detail-next">${escapeHtml(t.nextAction)}</div>` : ""}

      <div class="divider"></div>
      ${t.deadline ? `
      <div class="meta-row"><span class="meta-label">마감</span><span class="meta-value">${formatDeadline(t.deadline)}</span></div>` : ""}
      <div class="meta-row"><span class="meta-label">중요도</span><span class="meta-value">${IMPORTANCE_LABEL[t.importance]}</span></div>
      <div class="meta-row"><span class="meta-label">긴급도</span><span class="meta-value">${URGENCY_INFO[urgency].temp}</span></div>
      ${t.externalPerson ? `
      <div class="meta-row"><span class="meta-label">외부 약속</span><span class="meta-value">${escapeHtml(t.externalPerson)}</span></div>` : ""}

      ${t.stoppingRule ? `
      <div class="divider"></div>
      <div class="meta-label" style="margin-bottom:6px;">종료 기준</div>
      <div class="stopping-rule">${escapeHtml(t.stoppingRule)}</div>` : ""}

      <div class="divider"></div>
      <div class="stack">
        <button class="btn btn-primary" id="detail-start-btn">🔥 지금 시작</button>
        <div class="btn-row">
          <button class="btn btn-secondary" id="detail-edit-btn">수정</button>
          <button class="btn btn-secondary" id="detail-complete-btn">완료</button>
        </div>
      </div>
    `;
    document.getElementById("detail-start-btn").addEventListener("click", ()=>startFocus(t.id, "normal"));
    document.getElementById("detail-edit-btn").addEventListener("click", ()=>openAddTask(t.id));
    document.getElementById("detail-complete-btn").addEventListener("click", ()=>{
      completeTask(t.id);
      showScreen("home");
      showToast("완료했습니다.<br><br>이제 발등의 불이 하나 꺼졌습니다. 🔥", { autoCloseMs: 1800 });
    });
  }

  document.getElementById("detail-back").addEventListener("click", ()=>showScreen("home"));

  document.getElementById("shrine-back").addEventListener("click", ()=>showScreen("home"));

  document.getElementById("header-add-btn").addEventListener("click", ()=>openAddTask());

  // ============ SOUND ============
  let audioCtx = null;
  function playBellSound(){
    try{
      audioCtx = audioCtx || new (window.AudioContext||window.webkitAudioContext)();
      const now = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.exponentialRampToValueAtTime(660, now+0.3);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.12, now+0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now+0.6);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(now);
      osc.stop(now+0.65);
    }catch(e){ /* sound is optional */ }
  }

  // ============ SHRINE (신내림) ============
  function openShrine(){
    showScreen("shrine");
    playBellSound();
    const container = document.getElementById("shrine-content");
    container.innerHTML = `<span class="bell-big"><img src="icons/sinnaerim.png" alt=""></span>`;

    setTimeout(()=>{
      const task = selectShrineTask();
      if(!task){
        container.innerHTML = `
          <div class="empty-state" style="padding-top:20px;">
            <span class="big-emoji"><img src="icons/sinnaerim.png" alt=""></span>
            <h2>아직 불 붙은 일이 없습니다.</h2>
            <p>그래도 지금 집중하고 싶다면<br>새 작업을 하나 만들어주세요.</p>
            <button class="btn btn-primary" id="shrine-add-btn">작업 만들기</button>
          </div>`;
        document.getElementById("shrine-add-btn").addEventListener("click", ()=>openAddTask());
        return;
      }

      const duration = DURATIONS[Math.floor(Math.random()*DURATIONS.length)];
      state.pendingBurst = { taskId: task.id, duration };

      container.innerHTML = `
        <div class="burst-label">FOCUS BURST</div>
        <div class="burst-copy">지금 이 순간을 씁니다.</div>
        <div class="burst-task">${escapeHtml(task.title)}</div>
        <div class="burst-duration">${String(duration).padStart(2,"0")}:00</div>
        <button class="btn btn-primary" id="burst-start-btn">시작</button>
      `;
      document.getElementById("burst-start-btn").addEventListener("click", ()=>{
        startFocus(task.id, "focus_burst", duration);
      });
    }, 400);
  }

  // ============ FOCUS TIMER ============
  function startFocus(taskId, mode, plannedMinutes){
    const planned = plannedMinutes || 25;
    state.currentFocus = {
      id: uid(),
      taskId,
      mode,
      plannedDuration: planned,
      startedAt: Date.now(),
      accumulatedPauseMs: 0,
      pausedAt: null,
      status: "running",
      overexertionWarned: false
    };
    saveFocus();
    showScreen("focus");
    runFocusTimer();
  }

  function getElapsedMs(focus, now){
    now = now || Date.now();
    if(focus.status === "paused"){
      return focus.pausedAt - focus.startedAt - focus.accumulatedPauseMs;
    }
    return now - focus.startedAt - focus.accumulatedPauseMs;
  }

  function runFocusTimer(){
    const task = state.tasks.find(t=>t.id===state.currentFocus.taskId);
    document.getElementById("focus-task-name").textContent = task ? task.title : "";
    updatePauseButtonLabel();

    tickFocus();
    if(state.timerInterval) clearInterval(state.timerInterval);
    state.timerInterval = setInterval(tickFocus, 1000);
  }

  function tickFocus(){
    const focus = state.currentFocus;
    if(!focus) return;
    const plannedMs = focus.plannedDuration*60000;
    const elapsed = getElapsedMs(focus);
    const remaining = Math.max(0, plannedMs - elapsed);

    const mm = String(Math.floor(remaining/60000)).padStart(2,"0");
    const ss = String(Math.floor((remaining%60000)/1000)).padStart(2,"0");
    document.getElementById("focus-time").textContent = `${mm}:${ss}`;
    const pct = Math.min(100, (elapsed/plannedMs)*100);
    document.getElementById("focus-progress").style.width = pct+"%";

    // Overexertion guard: gently nudge, never force-stop, once a session
    // runs meaningfully past its own planned duration.
    if(focus.status === "running" && !focus.overexertionWarned && elapsed > plannedMs * 1.5){
      focus.overexertionWarned = true;
      saveFocus();
      showStopNudge();
    }

    if(remaining <= 0 && focus.status === "running"){
      completeFocus();
    }
  }

  function showStopNudge(){
    const screen = document.querySelector(".focus-screen");
    if(!screen || document.getElementById("stop-nudge")) return;
    const nudge = document.createElement("div");
    nudge.className = "stop-nudge";
    nudge.id = "stop-nudge";
    nudge.textContent = "🛑 충분히 했습니다. 지금 더 하는 것은 중요한 일을 미루는 것일 수도 있어요.";
    screen.appendChild(nudge);
  }

  function updatePauseButtonLabel(){
    const btn = document.getElementById("focus-pause-btn");
    if(!btn || !state.currentFocus) return;
    btn.textContent = state.currentFocus.status === "paused" ? "재개" : "일시정지";
  }

  document.getElementById("focus-pause-btn").addEventListener("click", ()=>{
    const focus = state.currentFocus;
    if(!focus) return;
    if(focus.status === "running"){
      focus.status = "paused";
      focus.pausedAt = Date.now();
    }else{
      focus.accumulatedPauseMs += Date.now() - focus.pausedAt;
      focus.pausedAt = null;
      focus.status = "running";
    }
    saveFocus();
    updatePauseButtonLabel();
  });

  document.getElementById("focus-stop-btn").addEventListener("click", ()=>{
    stopFocus();
  });

  function finishSession(interrupted){
    const focus = state.currentFocus;
    if(!focus) return null;
    clearInterval(state.timerInterval);
    state.timerInterval = null;

    const elapsedMs = getElapsedMs(focus);
    const actualDuration = Math.max(0, Math.round(elapsedMs/60000));

    const session = {
      id: focus.id,
      taskId: focus.taskId,
      mode: focus.mode,
      plannedDuration: focus.plannedDuration,
      actualDuration,
      startedAt: new Date(focus.startedAt).toISOString(),
      endedAt: new Date().toISOString(),
      interrupted
    };
    state.focusSessions.push(session);
    saveSessions();

    state.currentFocus = null;
    saveFocus();
    return session;
  }

  function completeFocus(){
    const session = finishSession(false);
    if(!session) return;
    state.lastCompleteInfo = { session, interrupted: false };
    renderFocusComplete();
    showScreen("focus-complete");
  }

  function stopFocus(){
    const session = finishSession(true);
    if(!session) return;
    state.lastCompleteInfo = { session, interrupted: true };
    renderFocusComplete();
    showScreen("focus-complete");
  }

  function renderFocusComplete(){
    const { session, interrupted } = state.lastCompleteInfo;
    const container = document.getElementById("complete-content");

    if(!interrupted){
      container.innerHTML = `
        <div class="complete-icon"><img src="icons/sinnaerim.png" alt=""></div>
        <div class="complete-headline">신내림 종료</div>
        <div class="complete-minutes">${session.actualDuration}분</div>
        <div class="complete-sub">동안 실제로 작업했습니다.<br><br>잘했습니다.<br>여기서 멈춰도 됩니다.</div>
        <div class="stack">
          <button class="btn btn-primary" id="complete-again-btn">한 번 더</button>
          <button class="btn btn-secondary" id="complete-done-btn">오늘은 끝</button>
        </div>
      `;
    }else{
      container.innerHTML = `
        <div class="complete-icon">🦶</div>
        <div class="complete-headline">집중을 멈췄습니다.</div>
        <div class="complete-minutes">${session.actualDuration}분</div>
        <div class="complete-sub">실제로 작업한 시간입니다.<br><br>그래도 시작한 건 기록됩니다.</div>
        <div class="stack">
          <button class="btn btn-primary" id="complete-again-btn">다시 시작</button>
          <button class="btn btn-secondary" id="complete-done-btn">오늘은 끝</button>
        </div>
      `;
    }

    document.getElementById("complete-again-btn").addEventListener("click", ()=>{
      const task = state.tasks.find(t=>t.id===session.taskId);
      if(!task){ showScreen("home"); return; }
      if(session.mode === "focus_burst"){
        openShrine();
      }else{
        startFocus(task.id, session.mode);
      }
    });
    document.getElementById("complete-done-btn").addEventListener("click", ()=>showScreen("home"));
  }

  // recover an in-progress focus session after refresh
  function recoverFocusIfNeeded(){
    const focus = state.currentFocus;
    if(!focus) return false;
    const plannedMs = focus.plannedDuration*60000;
    const elapsed = getElapsedMs(focus);
    if(elapsed >= plannedMs && focus.status === "running"){
      showScreen("focus");
      completeFocus();
      return true;
    }
    showScreen("focus");
    runFocusTimer();
    return true;
  }

  // ============ PATTERNS ============
  function renderPatterns(){
    const container = document.getElementById("pattern-content");
    const sessions = state.focusSessions;

    if(sessions.length < 3){
      container.innerHTML = `
        <h1 class="screen-title">나의 작업 패턴</h1>
        <div class="empty-state" style="padding-top:30px;">
          <span class="big-emoji">📊</span>
          <p>아직 패턴이 충분히 쌓이지 않았어요.<br><br>몇 번만 더 집중해보면<br>당신에게 잘 맞는 순간이 보이기 시작합니다.</p>
        </div>
      `;
      return;
    }

    const weekAgo = Date.now() - 7*24*60*60*1000;
    const weekSessions = sessions.filter(s => new Date(s.startedAt).getTime() >= weekAgo);
    const burstSessions = weekSessions.filter(s=>s.mode==="focus_burst");

    const totalWeekMin = weekSessions.reduce((sum,s)=>sum+s.actualDuration,0);
    const avgBurst = burstSessions.length
      ? Math.round(burstSessions.reduce((sum,s)=>sum+s.actualDuration,0)/burstSessions.length)
      : 0;

    const bestHourLabel = computeBestHourRange(weekSessions);
    const topCatalyst = computeTopCatalyst(weekSessions);
    const overexertionTask = computeOverexertionTask();

    container.innerHTML = `
      <h1 class="screen-title">나의 작업 패턴</h1>
      <div class="pattern-grid">
        <div class="pattern-tile">
          <div class="label">이번 주 실제 작업</div>
          <div class="value">${Math.floor(totalWeekMin/60)}시간 ${totalWeekMin%60}분</div>
        </div>
        <div class="pattern-tile">
          <div class="label">FOCUS BURST</div>
          <div class="value">${burstSessions.length}회</div>
        </div>
        <div class="pattern-tile">
          <div class="label">평균 Burst</div>
          <div class="value">${avgBurst}분</div>
        </div>
        <div class="pattern-tile">
          <div class="label">전체 세션</div>
          <div class="value">${sessions.length}회</div>
        </div>
      </div>
      <div class="divider"></div>
      ${bestHourLabel ? `<div class="pattern-insight-row"><span class="label">가장 잘 되는 시간</span><span class="value">${bestHourLabel}</span></div>` : ""}
      ${topCatalyst ? `<div class="pattern-insight-row"><span class="label">가장 효과적인 촉매</span><span class="value">${topCatalyst}</span></div>` : ""}
      ${overexertionTask ? `<div class="pattern-insight-row"><span class="label">과몰입이 잦은 작업</span><span class="value">${escapeHtml(overexertionTask)}</span></div>` : ""}
      <div class="reset-link" id="reset-data-link">데이터 초기화</div>
    `;
    document.getElementById("reset-data-link").addEventListener("click", ()=>{
      if(confirm("모든 데이터를 초기화할까요? 되돌릴 수 없습니다.")){
        localStorage.removeItem(STORAGE_KEYS.tasks);
        localStorage.removeItem(STORAGE_KEYS.sessions);
        localStorage.removeItem(STORAGE_KEYS.focus);
        localStorage.removeItem(STORAGE_KEYS.seeded);
        location.reload();
      }
    });
  }

  function computeBestHourRange(sessions){
    if(sessions.length < 3) return null;
    const buckets = {}; // 3-hour buckets
    sessions.forEach(s=>{
      const h = new Date(s.startedAt).getHours();
      const bucket = Math.floor(h/3)*3;
      buckets[bucket] = (buckets[bucket]||0) + s.actualDuration;
    });
    let best = null;
    Object.keys(buckets).forEach(k=>{
      if(!best || buckets[k] > buckets[best]) best = k;
    });
    if(best===null) return null;
    const start = Number(best);
    const end = (start+3)%24;
    const pad = n=>String(n).padStart(2,"0");
    return `${pad(start)}:00 ~ ${pad(end)}:00`;
  }

  function computeTopCatalyst(sessions){
    if(sessions.length < 3) return null;
    let deadlineDriven = 0, burst = 0, normal = 0;
    sessions.forEach(s=>{
      if(s.mode === "focus_burst") burst++;
      else{
        const t = state.tasks.find(t=>t.id===s.taskId);
        if(t && t.deadline) deadlineDriven++;
        else normal++;
      }
    });
    if(deadlineDriven >= burst && deadlineDriven >= normal && deadlineDriven>0) return "마감 임박";
    if(burst >= normal && burst>0) return "신내림";
    if(normal>0) return "스스로 시작";
    return null;
  }

  function computeOverexertionTask(){
    const counts = {};
    state.focusSessions.forEach(s=>{
      const plannedMs = s.plannedDuration*60000;
      if(s.actualDuration*60000 > plannedMs*1.5){
        counts[s.taskId] = (counts[s.taskId]||0)+1;
      }
    });
    let topId = null;
    Object.keys(counts).forEach(id=>{
      if(counts[id] >= 2 && (!topId || counts[id] > counts[topId])) topId = id;
    });
    if(!topId) return null;
    const t = state.tasks.find(t=>t.id===topId);
    return t ? t.title : null;
  }

  // ============ BOTTOM NAV ============
  document.querySelectorAll("#bottom-nav button").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const target = btn.dataset.nav;
      if(target === "shrine"){ openShrine(); }
      else{ showScreen(target); }
    });
  });

  document.getElementById("splash-log").addEventListener("click", enterAppFromSplash);
  document.getElementById("splash-log").addEventListener("keypress", e=>{
    if(e.key==="Enter" || e.key===" ") enterAppFromSplash();
  });

  // ============ SERVICE WORKER ============
  if("serviceWorker" in navigator){
    window.addEventListener("load", ()=>{
      navigator.serviceWorker.register("sw.js").catch(()=>{ /* offline support is best-effort */ });
    });
  }

  // ============ INIT ============
  loadData();
  if(recoverFocusIfNeeded()){
    // an in-progress focus session takes priority over the splash screen
    document.getElementById("app").classList.remove("pre-launch");
  }

})();
