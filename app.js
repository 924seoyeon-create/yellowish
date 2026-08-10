(function(){
  "use strict";

  // ============ STATE ============
  const STORAGE_KEYS = {
    tasks: "noreut_tasks",
    sessions: "noreut_sessions",
    focus: "noreut_current_focus"
  };

  const state = {
    tasks: [],
    focusSessions: [],
    currentFocus: null,      // active/paused focus session in progress
    currentScreen: "home",
    detailTaskId: null,
    editTaskId: null,
    lastCompleteInfo: null,  // info to render on focus-complete screen
    timerInterval: null,
    displayedUrgency: null,     // urgency currently shown on the home fire-stage
    displayedFireMode: null,    // "ladder" | "solo" | "overdue"
    calendarViewDate: null,
    calendarMode: "view",       // "view" | "pick"
    calendarSelectedDate: null,
    pickedDeadlineDate: null    // yyyy-mm-dd staged from the calendar picker for the add-task form
  };

  // Random focus-length pool offered for 오늘 (spec §8).
  const DURATIONS = [17, 23, 31, 37, 43];
  const DEFAULT_TODAY_MINUTES = 40;
  const SHRINE_AXE_MS = 3 * 60 * 60 * 1000;

  // Fire always rises from the bottom of the stage toward the foot, which
  // is pinned at the vertical center of the stage. Never edit these to move
  // the flame via `top` — see spec rule #16.
  // Level 1 sits below the visible stage (and is opacity:0 via CSS) so no
  // fire is visible at all — spec §6-1 "불은 화면에 나타나지 않는다".
  const FLAME_BOTTOM = { 1: -15, 2: 12, 3: 28, 4: 44 };

  const URGENCY_INFO = {
    1: { temp: "여유", message: "강 건너 불구경" },
    2: { temp: "보통", message: "아 따뜻하다" },
    3: { temp: "주의", message: "발등에 불 떨어짐" },
    4: { temp: "긴급", message: "불 속에 발을 집어넣음" },
    5: { temp: "매우 긴급", message: "화형ing~" }
  };

  const MENTIONS = {
    home: "다 울었니?<br>이제 할 일을 하자"
  };

  // 오늘 페이지는 행동으로의 전환 속도를 우선하므로 멘트 노출을 짧게 유지한다.
  const TODAY_MENTION_HOLD_MS = 750; // 기존 1500ms 대비 50% 단축
  const SHRINE_ARRIVED_HOLD_MS = 750;

  const PATTERN_MENTION_STAGES = [
    { html: "심연을 바라보면", holdMs: 600 },
    { html: "심연도 나를 바라본다.", holdMs: 600 },
    { html: "맞짝사랑이다.", holdMs: 900, gapBefore: 350 }
  ];

  const LOCATION_OPTIONS = [
    { emoji: "🏠", label: "집" },
    { emoji: "☕", label: "카페" },
    { emoji: "📚", label: "도서관" },
    { emoji: "🏢", label: "회사/학교" },
    { emoji: "🚶", label: "이동 중" },
    { emoji: "🌳", label: "야외" }
  ];
  const TRIGGER_OPTIONS = [
    { emoji: "💡", label: "아이디어가 떠올라서" },
    { emoji: "🔥", label: "마감 때문에" },
    { emoji: "✨", label: "갑자기 하고 싶어서" },
    { emoji: "🧠", label: "해야 할 일이 생각나서" },
    { emoji: "👤", label: "누군가에게 요청받아서" },
    { emoji: "🔄", label: "하던 일이 이어져서" }
  ];

  const IMPORTANCE_LABEL = { low: "낮음", medium: "보통", high: "높음" };

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

  function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,8); }

  function reducedMotion(){
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  // ============ TASK ============
  function createTask(data){
    const task = {
      id: uid(),
      title: data.title.trim(),
      nextAction: (data.nextAction||"").trim(),
      deadline: data.deadline || null,
      importance: data.importance || "medium",
      urgency: Number(data.urgency)||3,
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

  function deleteTask(id){
    state.tasks = state.tasks.filter(t=>t.id!==id);
    saveTasks();
  }

  function getActiveTasks(){
    return state.tasks.filter(t=>t.status==="active");
  }

  function isOverdue(task){
    return !!task.deadline && new Date(task.deadline).getTime() < Date.now();
  }

  // Maps hours-until-deadline to an urgency tier so the fire actually climbs
  // as the deadline nears, instead of sitting still at whatever level was
  // picked in the form (spec §6: "긴급도가 증가할수록 불이 점점 위로 이동한다").
  function timeBasedUrgencyLevel(deadlineIso){
    const hours = (new Date(deadlineIso).getTime() - Date.now()) / 3600000;
    if(hours >= 24) return 1;
    if(hours >= 6) return 2;
    if(hours >= 2) return 3;
    if(hours >= 0.5) return 4;
    return 5;
  }

  function calculateUrgency(task){
    // With a deadline, time-to-deadline is the whole story — this is what
    // lets the fire actually climb through all five tiers as it nears,
    // rather than sitting wherever the form's radio happened to default.
    // Without a deadline there's no time signal, so the manually chosen
    // level is used as-is.
    if(task.deadline) return timeBasedUrgencyLevel(task.deadline);
    return Math.min(5, Math.max(1, task.urgency||3));
  }

  // Urgency used for sorting/labels: overdue always reads as level 5.
  // The home fire-stage additionally special-cases overdue with its own
  // visual (see fireStageHtml) rather than just reusing the level-5 grid.
  function effectiveUrgency(task){
    if(isOverdue(task)) return 5;
    return calculateUrgency(task);
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

  function formatSessionDuration(session){
    const m = session.actualDuration;
    if(m >= 60) return `${Math.floor(m/60)}시간 ${m%60}분`;
    return `${m}분`;
  }

  function dateKey(d){
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  }

  // ============ SPLASH (홈) ============
  function enterAppFromSplash(){
    document.getElementById("app").classList.remove("pre-launch");
    showScreen("home");
  }

  // Returns to the very first screen (the 🪵 splash) — used by tapping the
  // "노릇노릇" brand text in the header from anywhere in the app.
  function returnToSplash(){
    document.getElementById("app").classList.add("pre-launch");
  }

  // ============ MENTION (기본 멘트) ============
  // Plays a sequence of short mention stages in place of a screen's content
  // container, then hands off to renderFn. Each stage is {html, holdMs,
  // gapBefore?} — gapBefore inserts a blank pause before that stage fades
  // in (used for the comedic beat before 패턴's "맞짝사랑이다.").
  const MENTION_FADE_MS = 260;

  // Token guard: if a screen is re-entered while a previous sequence on the
  // same container is still mid-flight (fast tab switching), the stale
  // chain's callbacks become no-ops instead of racing the newer one.
  let mentionSequenceToken = 0;

  // Tapping the mention itself skips straight to the real content instead
  // of waiting out the remaining stages — 오늘/신내림/패턴 should never make
  // an impatient tap wait on a flourish.
  function playMentionSequence(containerEl, stages, renderFn){
    const myToken = ++mentionSequenceToken;
    if(reducedMotion() || stages.length === 0){ renderFn(); return; }
    let done = false;
    function finish(){
      if(done) return;
      done = true;
      mentionSequenceToken++; // invalidate any still-pending timers for this run
      renderFn();
    }
    let i = 0;
    function showStage(){
      if(myToken !== mentionSequenceToken) return;
      const stage = stages[i];
      setTimeout(()=>{
        if(myToken !== mentionSequenceToken) return;
        containerEl.innerHTML = `<div class="mention-block"><div class="mention-text">${stage.html}</div></div>`;
        const block = containerEl.querySelector(".mention-block");
        block.addEventListener("click", finish);
        requestAnimationFrame(()=> block.classList.add("show"));
        setTimeout(()=>{
          if(myToken !== mentionSequenceToken) return;
          block.classList.add("hide");
          setTimeout(()=>{
            if(myToken !== mentionSequenceToken) return;
            i++;
            if(i < stages.length) showStage();
            else finish();
          }, MENTION_FADE_MS);
        }, stage.holdMs);
      }, stage.gapBefore || 0);
    }
    showStage();
  }

  function enterHome(){
    const el = document.getElementById("home-content");
    playMentionSequence(el, [{ html: MENTIONS.home, holdMs: TODAY_MENTION_HOLD_MS }], renderHome);
  }

  function enterPattern(){
    playMentionSequence(document.getElementById("pattern-content"), PATTERN_MENTION_STAGES, renderPatterns);
  }

  // ============ NAVIGATION ============
  function showScreen(name){
    state.currentScreen = name;
    document.querySelectorAll(".screen").forEach(el=>el.classList.remove("active"));
    document.getElementById("screen-"+name).classList.add("active");

    const nav = document.getElementById("bottom-nav");
    const hideNavOn = ["focus", "focus-complete", "add-task", "task-detail", "other-tasks", "calendar", "guide"];
    nav.classList.toggle("hidden", hideNavOn.includes(name));

    document.querySelectorAll("#bottom-nav button").forEach(b=>{
      const isShrineTab = b.dataset.nav === "shrine" && (name === "shrine" || name === "shrine-timer");
      b.classList.toggle("active", b.dataset.nav === name || isShrineTab);
    });

    if(name==="home") enterHome();
    if(name==="pattern") enterPattern();
    if(name==="task-detail") renderTaskDetail();
    if(name==="other-tasks") renderOtherTasks();
    if(name==="calendar") renderCalendarScreen();
    window.scrollTo(0,0);
  }

  // ============ RENDER: HOME (오늘) ============
  let homeTickInterval = null;

  // Builds the fire visual markup for a given mode. Uses classes only (no
  // ids) so it can be safely rendered into more than one container at once
  // (오늘's home view and a 다른 작업 task's detail view both use this).
  function fireStageHtml(mode){
    if(mode === "overdue"){
      return `<div class="fire-stage fire-grid-mode overdue-mode" aria-hidden="true"><div class="flame-grid">🔥🔥🔥<br>🔥🦶🔥<br>🔥🔥🔥</div></div>`;
    }
    if(mode === "solo"){
      return `<div class="fire-stage fire-solo-mode" aria-hidden="true"><div class="flame-solo">🔥</div></div>`;
    }
    return `
      <div class="fire-stage" aria-hidden="true">
        <div class="fire-track">
          <div class="flame">🔥</div>
          <div class="foot">🦶</div>
        </div>
      </div>`;
  }

  function fireModeFor(urgency, overdue){
    if(overdue) return "overdue";
    if(urgency >= 5) return "solo";
    return "ladder";
  }

  // Full (re)render of a fire-visual block: stage + temp label + caption.
  // Used both for a mode change on 오늘's home view and for the one-shot
  // snapshot shown on a task's detail screen (다른 작업 → 항목 클릭).
  function renderFireVisualInto(containerEl, urgency, overdue){
    const mode = fireModeFor(urgency, overdue);
    const info = URGENCY_INFO[urgency];
    const isExtreme = overdue || urgency >= 5;
    containerEl.innerHTML = `
      ${fireStageHtml(mode)}
      <div class="temp-label${isExtreme?' hot':''}">${overdue ? "위험" : info.temp}</div>
      <div class="urgency-caption${isExtreme?' hot':''}">${overdue ? "발이 불타고 있습니다." : info.message}</div>
    `;
    if(mode === "ladder"){
      const stage = containerEl.querySelector(".fire-stage");
      const flame = containerEl.querySelector(".flame");
      if(stage) stage.setAttribute("data-urgency", String(urgency));
      if(flame) flame.style.setProperty("--flame-bottom", FLAME_BOTTOM[urgency] + "%");
    }
    return mode;
  }

  function renderHome(){
    const container = document.getElementById("home-content");
    const task = getCurrentTask();
    const activeTasks = getActiveTasks();
    state.displayedUrgency = null;
    state.displayedFireMode = null;

    if(homeTickInterval){ clearInterval(homeTickInterval); homeTickInterval = null; }

    if(!task){
      container.innerHTML = `
        <div class="empty-state">
          <span class="big-emoji">🦶</span>
          <h2>아직 발등에 불이 떨어지지 않았어요.</h2>
          <p>오늘 해야 할 일이 있다면 가져와주세요</p>
          <button class="btn btn-primary" id="empty-add-btn">+ 오늘의 작업 추가</button>
        </div>
        <div class="shrine-hint">
          <span class="bell" id="empty-guide-bell" role="button" tabindex="0"><img src="icons/sinnaerim.png" alt=""></span>
          갑자기 신내림을 받으면<br>바로 시작할 수도 있어요.
        </div>
      `;
      document.getElementById("empty-add-btn").addEventListener("click", ()=>openAddTask());
      bindActivate(document.getElementById("empty-guide-bell"), ()=>openGuide());
      return;
    }

    const overdue = isOverdue(task);
    const urgency = effectiveUrgency(task);
    const others = activeTasks.length - 1;

    container.innerHTML = `
      <div id="home-fire-visual"></div>

      <div class="task-title" id="home-task-title" role="button" tabindex="0">${escapeHtml(task.title)}</div>
      <div class="task-next" id="home-task-next">${task.nextAction ? escapeHtml(task.nextAction) : ""}</div>

      <div class="divider"></div>
      <div id="home-deadline-row"></div>

      <div class="stack">
        <button class="btn btn-primary" id="home-start-btn">🔥 지금 시작</button>
      </div>

      <div class="home-links-row">
        <span class="home-link" id="home-calendar-link" role="button" tabindex="0">📅 달력</span>
        ${others > 0 ? `<span class="home-link" id="home-others-link" role="button" tabindex="0">다른 작업 ${others}개</span>` : ""}
      </div>
    `;

    document.getElementById("home-start-btn").addEventListener("click", ()=>openDurationPicker(task.id));
    document.getElementById("home-task-title").addEventListener("click", ()=>openTaskDetail(task.id));
    document.getElementById("home-task-title").addEventListener("keypress", e=>{ if(e.key==="Enter") openTaskDetail(task.id); });
    bindActivate(document.getElementById("home-calendar-link"), ()=>openCalendar("view"));
    bindActivate(document.getElementById("home-others-link"), ()=>openOtherTasks());

    applyUrgencyToHome(task, urgency, overdue, { skipTransition: true });

    homeTickInterval = setInterval(()=>{
      const t = getCurrentTask();
      if(!t || t.id !== task.id){ renderHome(); return; }
      applyUrgencyToHome(t, effectiveUrgency(t), isOverdue(t), { skipTransition: false });
    }, 15000);
  }

  // Updates the fire-stage + labels in place. When the visual "mode"
  // (ladder vs level-5 solo flame vs overdue grid) hasn't changed, only the
  // flame's `bottom` position and text are touched, so the CSS transition
  // on `bottom` can animate smoothly between urgency levels.
  function applyUrgencyToHome(task, urgency, overdue, opts){
    opts = opts || {};
    const mode = fireModeFor(urgency, overdue);
    const modeChanged = state.displayedFireMode !== mode;
    state.displayedFireMode = mode;
    state.displayedUrgency = urgency;
    const isExtreme = overdue || urgency >= 5;
    const info = URGENCY_INFO[urgency];

    const container = document.getElementById("home-fire-visual");
    if(container){
      if(modeChanged){
        renderFireVisualInto(container, urgency, overdue);
      }else{
        const tempLabel = container.querySelector(".temp-label");
        if(tempLabel){
          tempLabel.textContent = overdue ? "위험" : info.temp;
          tempLabel.classList.toggle("hot", isExtreme);
        }
        const caption = container.querySelector(".urgency-caption");
        if(caption){
          caption.textContent = overdue ? "발이 불타고 있습니다." : info.message;
          caption.classList.toggle("hot", isExtreme);
        }
        if(mode === "ladder"){
          const stage = container.querySelector(".fire-stage");
          const flame = container.querySelector(".flame");
          if(stage) stage.setAttribute("data-urgency", String(urgency));
          if(flame) flame.style.setProperty("--flame-bottom", FLAME_BOTTOM[urgency] + "%");
        }
      }
    }

    const nextEl = document.getElementById("home-task-next");
    if(nextEl) nextEl.style.display = isExtreme ? "none" : (task.nextAction ? "" : "none");

    const row = document.getElementById("home-deadline-row");
    if(row){
      if(overdue){
        row.innerHTML = `<div class="urgent-line">마감이 지났습니다.</div>`;
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

  // Binds click + Enter/Space activation to a non-<button> clickable element
  // (spans/divs used as list items or text links).
  function bindActivate(el, handler){
    if(!el) return;
    el.addEventListener("click", handler);
    el.addEventListener("keydown", e=>{
      if(e.key==="Enter" || e.key===" "){ e.preventDefault(); handler(); }
    });
  }

  // ============ FOCUS DURATION PICKER (오늘 §8: 랜덤 / 직접 설정 / 기본 40분) ============
  function openDurationPicker(taskId){
    const overlay = document.createElement("div");
    overlay.className = "toast-overlay";
    overlay.innerHTML = `
      <div class="toast-card duration-card" role="dialog" aria-label="집중 시간 선택">
        <h3 class="duration-title">집중 시간</h3>
        <div class="duration-options">
          <button type="button" class="btn btn-secondary duration-opt" data-choice="default">기본 40분</button>
          <button type="button" class="btn btn-secondary duration-opt" data-choice="random">랜덤</button>
        </div>
        <div class="duration-custom-row">
          <input type="number" min="1" max="240" id="duration-custom-input" placeholder="직접 입력">
          <span>분</span>
        </div>
        <button type="button" class="btn btn-primary" id="duration-custom-start">이 시간으로 시작</button>
      </div>
    `;
    document.getElementById("app").appendChild(overlay);
    overlay.addEventListener("click", (e)=>{ if(e.target===overlay) overlay.remove(); });

    overlay.querySelector('[data-choice="default"]').addEventListener("click", ()=>{
      overlay.remove();
      startFocus(taskId, "today", DEFAULT_TODAY_MINUTES);
    });
    overlay.querySelector('[data-choice="random"]').addEventListener("click", ()=>{
      overlay.remove();
      const d = DURATIONS[Math.floor(Math.random()*DURATIONS.length)];
      startFocus(taskId, "today", d);
    });
    overlay.querySelector('#duration-custom-start').addEventListener("click", ()=>{
      const v = Number(document.getElementById("duration-custom-input").value);
      const minutes = v>0 ? Math.min(240, Math.round(v)) : DEFAULT_TODAY_MINUTES;
      overlay.remove();
      startFocus(taskId, "today", minutes);
    });
  }

  // ============ ADD TASK ============
  function updateDeadlineDateButtonLabel(){
    const btn = document.getElementById("f-deadline-date-btn");
    const clearLink = document.getElementById("f-deadline-clear");
    const errorEl = document.getElementById("f-deadline-error");
    if(!btn || !clearLink) return;
    if(state.pickedDeadlineDate){
      const [y,m,d] = state.pickedDeadlineDate.split("-");
      btn.textContent = `📅 ${y}년 ${Number(m)}월 ${Number(d)}일`;
      clearLink.hidden = false;
      if(errorEl) errorEl.hidden = true;
    }else{
      btn.textContent = "📅 날짜 선택";
      clearLink.hidden = true;
    }
  }

  // AM/PM + 시 + 분 selects → "HH:mm" 24시간 문자열로 변환 (spec 요청: 오전/오후 숫자 선택 방식)
  function getDeadlineTimeValue(){
    const ampm = document.getElementById("f-deadline-ampm").value;
    let hour = Number(document.getElementById("f-deadline-hour").value);
    const minute = document.getElementById("f-deadline-minute").value;
    if(ampm === "AM"){ if(hour===12) hour = 0; }
    else{ if(hour!==12) hour += 12; }
    return `${String(hour).padStart(2,"0")}:${minute}`;
  }

  function setDeadlineTimeSelects(date){
    const h = date.getHours();
    const ampm = h < 12 ? "AM" : "PM";
    let h12 = h % 12; if(h12===0) h12 = 12;
    document.getElementById("f-deadline-ampm").value = ampm;
    document.getElementById("f-deadline-hour").value = String(h12);
    document.getElementById("f-deadline-minute").value = String(date.getMinutes()).padStart(2,"0");
  }

  function resetDeadlineTimeSelects(){
    document.getElementById("f-deadline-ampm").value = "PM";
    document.getElementById("f-deadline-hour").value = "11";
    document.getElementById("f-deadline-minute").value = "59";
  }

  // 마감 분(分) 선택은 1분 단위까지 지정 가능해야 하므로 60개 옵션을 동적으로 채운다.
  (function populateMinuteOptions(){
    const sel = document.getElementById("f-deadline-minute");
    let html = "";
    for(let m=0; m<60; m++){
      const v = String(m).padStart(2,"0");
      html += `<option value="${v}">${v}분</option>`;
    }
    sel.innerHTML = html;
  })();

  function openAddTask(editId){
    state.editTaskId = editId || null;
    const form = document.getElementById("task-form");
    form.reset();
    state.pickedDeadlineDate = null;
    resetDeadlineTimeSelects();
    document.getElementById("f-deadline-error").hidden = true;
    document.getElementById("add-task-title").textContent = editId ? "작업 수정" : "무엇을 해야 하나요?";

    if(editId){
      const t = state.tasks.find(t=>t.id===editId);
      if(t){
        document.getElementById("f-title").value = t.title;
        document.getElementById("f-next").value = t.nextAction||"";
        if(t.deadline){
          const d = new Date(t.deadline);
          state.pickedDeadlineDate = dateKey(d);
          setDeadlineTimeSelects(d);
        }
        document.querySelector(`input[name=importance][value="${t.importance}"]`).checked = true;
        document.querySelector(`input[name=urgency][value="${t.urgency}"]`).checked = true;
        document.getElementById("f-person").value = t.externalPerson||"";
        document.getElementById("f-stop").value = t.stoppingRule||"";
      }
    }
    updateDeadlineDateButtonLabel();
    showScreen("add-task");
  }

  document.getElementById("task-form").addEventListener("submit", function(e){
    e.preventDefault();
    const title = document.getElementById("f-title").value.trim();
    if(!title) return;

    const deadlineError = document.getElementById("f-deadline-error");
    if(!state.pickedDeadlineDate){
      deadlineError.hidden = false;
      document.getElementById("f-deadline-date-btn").focus();
      return;
    }
    deadlineError.hidden = true;
    const deadlineIso = new Date(`${state.pickedDeadlineDate}T${getDeadlineTimeValue()}:00`).toISOString();

    const data = {
      title,
      nextAction: document.getElementById("f-next").value,
      deadline: deadlineIso,
      importance: document.querySelector('input[name=importance]:checked').value,
      urgency: document.querySelector('input[name=urgency]:checked').value,
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

  document.getElementById("f-deadline-date-btn").addEventListener("click", ()=>{
    openCalendar("pick");
  });
  document.getElementById("f-deadline-clear").addEventListener("click", ()=>{
    state.pickedDeadlineDate = null;
    resetDeadlineTimeSelects();
    updateDeadlineDateButtonLabel();
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
    const overdue = isOverdue(t);
    container.innerHTML = `
      <div id="detail-fire-visual"></div>
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
    renderFireVisualInto(document.getElementById("detail-fire-visual"), urgency, overdue);
    document.getElementById("detail-start-btn").addEventListener("click", ()=>openDurationPicker(t.id));
    document.getElementById("detail-edit-btn").addEventListener("click", ()=>openAddTask(t.id));
    document.getElementById("detail-complete-btn").addEventListener("click", ()=>{
      completeTask(t.id);
      showScreen("home");
      showToast("완료했습니다.<br><br>이제 발등의 불이 하나 꺼졌습니다. 🔥", { autoCloseMs: 1800 });
    });
  }

  document.getElementById("detail-back").addEventListener("click", ()=>showScreen("home"));

  document.getElementById("shrine-back").addEventListener("click", ()=>showScreen("home"));

  // ============ GUIDE (신내림 사용 설명서) ============
  function openGuide(){ showScreen("guide"); }
  document.getElementById("guide-back").addEventListener("click", ()=>showScreen("home"));
  bindActivate(document.getElementById("guide-cta"), ()=>openShrine());

  document.getElementById("header-add-btn").addEventListener("click", ()=>openAddTask());

  // ============ OTHER TASKS (다른 작업, Flow D) ============
  function openOtherTasks(){
    showScreen("other-tasks");
  }

  function renderOtherTasks(){
    const container = document.getElementById("other-tasks-content");
    const current = getCurrentTask();
    const others = getActiveTasks().filter(t => !current || t.id !== current.id);

    if(others.length === 0){
      container.innerHTML = `<div class="empty-state" style="padding-top:40px;"><p>다른 작업이 없습니다.</p></div>`;
      return;
    }

    const order = { high: 0, medium: 1, low: 2 };
    const sorted = others.slice().sort((a,b)=> order[a.importance] - order[b.importance]);

    container.innerHTML = sorted.map(t => `
      <div class="other-task-item" data-id="${t.id}" role="button" tabindex="0">
        <div class="other-task-importance imp-${t.importance}">${IMPORTANCE_LABEL[t.importance]}</div>
        <div class="other-task-body">
          <div class="other-task-title">${escapeHtml(t.title)}</div>
          ${t.deadline ? `<div class="other-task-deadline">${formatDeadline(t.deadline)}</div>` : ""}
        </div>
        <button type="button" class="other-task-delete" data-id="${t.id}" aria-label="삭제">🗑</button>
      </div>
    `).join("");

    container.querySelectorAll(".other-task-item").forEach(el=>{
      bindActivate(el, ()=> openTaskDetail(el.dataset.id));
    });
    container.querySelectorAll(".other-task-delete").forEach(btn=>{
      btn.addEventListener("click", (e)=>{
        e.stopPropagation();
        if(confirm("이 작업을 삭제할까요? 되돌릴 수 없습니다.")){
          deleteTask(btn.dataset.id);
          renderOtherTasks();
        }
      });
      btn.addEventListener("keydown", e=> e.stopPropagation());
    });
  }

  document.getElementById("other-tasks-back").addEventListener("click", ()=>showScreen("home"));

  // ============ CALENDAR (달력) ============
  function openCalendar(mode){
    state.calendarMode = mode || "view";
    if(!state.calendarViewDate){
      const now = new Date();
      state.calendarViewDate = new Date(now.getFullYear(), now.getMonth(), 1);
    }
    state.calendarSelectedDate = null;
    showScreen("calendar");
  }

  function renderCalendarScreen(){
    const container = document.getElementById("calendar-content");
    const viewDate = state.calendarViewDate || new Date();
    const year = viewDate.getFullYear(), month = viewDate.getMonth();
    const firstDay = new Date(year, month, 1);
    const startWeekday = firstDay.getDay();
    const daysInMonth = new Date(year, month+1, 0).getDate();
    const todayKey = dateKey(new Date());

    const deadlineDates = {};
    getActiveTasks().forEach(t=>{
      if(t.deadline){
        const k = dateKey(new Date(t.deadline));
        deadlineDates[k] = (deadlineDates[k]||0) + 1;
      }
    });

    let cells = "";
    for(let i=0;i<startWeekday;i++) cells += `<div class="cal-cell empty"></div>`;
    for(let d=1; d<=daysInMonth; d++){
      const key = dateKey(new Date(year, month, d));
      const hasDeadline = !!deadlineDates[key];
      const isToday = key === todayKey;
      cells += `<button type="button" class="cal-cell${isToday?' today':''}${hasDeadline?' has-deadline':''}" data-date="${key}">${d}${hasDeadline?'<span class="cal-dot"></span>':''}</button>`;
    }

    container.innerHTML = `
      <h1 class="screen-title">${state.calendarMode==="pick" ? "마감일 선택" : "달력"}</h1>
      <div class="cal-header">
        <button type="button" class="cal-nav" id="cal-prev" aria-label="이전 달">‹</button>
        <div class="cal-month-label">${year}년 ${month+1}월</div>
        <button type="button" class="cal-nav" id="cal-next" aria-label="다음 달">›</button>
      </div>
      <div class="cal-weekdays"><span>일</span><span>월</span><span>화</span><span>수</span><span>목</span><span>금</span><span>토</span></div>
      <div class="cal-grid">${cells}</div>
      <div id="cal-selected-tasks"></div>
    `;

    document.getElementById("cal-prev").addEventListener("click", ()=>{
      state.calendarViewDate = new Date(year, month-1, 1);
      renderCalendarScreen();
    });
    document.getElementById("cal-next").addEventListener("click", ()=>{
      state.calendarViewDate = new Date(year, month+1, 1);
      renderCalendarScreen();
    });
    container.querySelectorAll(".cal-cell[data-date]").forEach(btn=>{
      btn.addEventListener("click", ()=> onCalendarDateClick(btn.dataset.date));
    });
  }

  function onCalendarDateClick(key){
    if(state.calendarMode === "pick"){
      state.pickedDeadlineDate = key;
      showScreen("add-task");
      updateDeadlineDateButtonLabel();
      return;
    }
    state.calendarSelectedDate = key;
    const tasksOnDate = getActiveTasks().filter(t => t.deadline && dateKey(new Date(t.deadline)) === key);
    const listEl = document.getElementById("cal-selected-tasks");
    if(!listEl) return;
    if(tasksOnDate.length===0){
      listEl.innerHTML = `<div class="cal-empty-day">${key} 마감인 작업이 없습니다.</div>`;
      return;
    }
    listEl.innerHTML = `<div class="cal-day-label">${key}</div>` + tasksOnDate.map(t=>`
      <div class="other-task-item" data-id="${t.id}" role="button" tabindex="0">
        <div class="other-task-importance imp-${t.importance}">${IMPORTANCE_LABEL[t.importance]}</div>
        <div class="other-task-body">
          <div class="other-task-title">${escapeHtml(t.title)}</div>
          <div class="other-task-deadline">${formatDeadline(t.deadline)}</div>
        </div>
      </div>`).join("");
    listEl.querySelectorAll(".other-task-item").forEach(el=>{
      bindActivate(el, ()=> openTaskDetail(el.dataset.id));
    });
  }

  document.getElementById("calendar-back").addEventListener("click", ()=>{
    if(state.calendarMode === "pick"){ showScreen("add-task"); }
    else{ showScreen("home"); }
  });

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
  // Not a countdown. 왔다 → 바로 시작 가능한 count-up 스톱워치. See §9-14.
  function openShrine(){
    showScreen("shrine");
    playBellSound();
    const container = document.getElementById("shrine-content");
    container.innerHTML = `
      <span class="bell-big"><img src="icons/sinnaerim.png" alt=""></span>
      <div class="shrine-arrived">왔다</div>
    `;
    setTimeout(renderShrineReady, reducedMotion() ? 0 : SHRINE_ARRIVED_HOLD_MS);
  }

  function renderShrineReady(){
    const container = document.getElementById("shrine-content");
    const task = selectShrineTask();
    container.innerHTML = `
      <span class="bell-big small"><img src="icons/sinnaerim.png" alt=""></span>
      <div class="shrine-question">지금의 마감이</div>
      <div class="shrine-answer">미래의 나를 구한다(제발)</div>
      ${task ? `<div class="shrine-current-task">지금: ${escapeHtml(task.title)}</div>` : ""}
      <div class="shrine-stopwatch-preview">00:00:00</div>
      <button type="button" class="btn btn-primary" id="shrine-start-btn">시작</button>
      <div class="home-link" id="shrine-guide-link" role="button" tabindex="0" style="margin-top:18px;">사용법</div>
    `;
    document.getElementById("shrine-start-btn").addEventListener("click", ()=>{
      startShrineStopwatch(task ? task.id : null);
    });
    bindActivate(document.getElementById("shrine-guide-link"), ()=>openGuide());
  }

  function startShrineStopwatch(taskId){
    state.currentFocus = {
      id: uid(),
      taskId: taskId || null,
      mode: "divine",
      plannedDuration: null,
      startedAt: Date.now(),
      accumulatedPauseMs: 0,
      pausedAt: null,
      status: "running"
    };
    saveFocus();
    showScreen("shrine-timer");
    runShrineTimer();
  }

  function runShrineTimer(){
    const focus = state.currentFocus;
    const task = focus.taskId ? state.tasks.find(t=>t.id===focus.taskId) : null;
    document.getElementById("shrine-timer-task-name").textContent = task ? task.title : "지금 이 순간";

    tickShrineTimer();
    if(state.timerInterval) clearInterval(state.timerInterval);
    state.timerInterval = setInterval(tickShrineTimer, 1000);
  }

  function tickShrineTimer(){
    const focus = state.currentFocus;
    if(!focus) return;
    const elapsedMs = getElapsedMs(focus);
    const totalSec = Math.max(0, Math.floor(elapsedMs/1000));
    const hh = String(Math.floor(totalSec/3600)).padStart(2,"0");
    const mm = String(Math.floor((totalSec%3600)/60)).padStart(2,"0");
    const ss = String(totalSec%60).padStart(2,"0");
    const timeEl = document.getElementById("shrine-timer-time");
    if(timeEl) timeEl.textContent = `${hh}:${mm}:${ss}`;

    // Easter egg only — never auto-ends the session past 3 hours (§13, §33).
    const axe = document.getElementById("shrine-axe");
    if(axe) axe.hidden = elapsedMs < SHRINE_AXE_MS;
  }

  document.getElementById("shrine-timer-stop-btn").addEventListener("click", ()=>{
    stopShrineStopwatch();
  });

  function stopShrineStopwatch(){
    const session = finishSession(false);
    if(!session) return;
    state.lastCompleteInfo = { session, interrupted: false };
    renderFocusComplete();
    showScreen("focus-complete");
  }

  // ============ FOCUS TIMER (오늘, countdown) ============
  function startFocus(taskId, mode, plannedMinutes){
    const planned = plannedMinutes || DEFAULT_TODAY_MINUTES;
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
    const screen = document.querySelector("#screen-focus .focus-screen");
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
      plannedDuration: focus.plannedDuration || null,
      actualDuration,
      durationSeconds: Math.max(0, Math.round(elapsedMs/1000)),
      startedAt: new Date(focus.startedAt).toISOString(),
      endedAt: new Date().toISOString(),
      notes: "",
      activity: "",
      location: "",
      trigger: "",
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

  function chipGroupHtml(groupId, options){
    return `<div class="chip-group" id="${groupId}">
      ${options.map(o=>`<button type="button" class="chip-option" data-value="${escapeHtml(o.label)}">${o.emoji} ${escapeHtml(o.label)}</button>`).join("")}
      <button type="button" class="chip-option" data-value="__custom__">✏️ 직접 입력</button>
    </div>`;
  }

  function setupChipGroup(groupId, customInputId){
    const group = document.getElementById(groupId);
    const customInput = document.getElementById(customInputId);
    group.querySelectorAll(".chip-option").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        group.querySelectorAll(".chip-option").forEach(b=>b.classList.remove("selected"));
        btn.classList.add("selected");
        const isCustom = btn.dataset.value === "__custom__";
        customInput.hidden = !isCustom;
        if(isCustom) customInput.focus();
      });
    });
  }

  function getSelectedChipValue(groupId, customInputId){
    const selected = document.getElementById(groupId).querySelector(".chip-option.selected");
    if(!selected) return "";
    if(selected.dataset.value === "__custom__") return document.getElementById(customInputId).value.trim();
    return selected.dataset.value;
  }

  // 신내림 종료 후 "나는 어떤 조건에서 집중이 찾아오는가?"를 나중에 발견하기 위한
  // 짧은 기록 화면. 무엇을/어디서/왜는 session에 저장되어 패턴 분석에 쓰인다.
  function renderDivineLogForm(session, overThreeHours){
    const container = document.getElementById("complete-content");
    const linkedTask = session.taskId ? state.tasks.find(t=>t.id===session.taskId) : null;
    const activeTasks = getActiveTasks();

    container.innerHTML = `
      <div class="complete-icon"><img src="icons/sinnaerim.png" alt=""></div>
      <div class="complete-headline">신내림 종료</div>
      <div class="complete-minutes">${formatSessionDuration(session)}</div>
      ${overThreeHours ? `<div class="complete-axe">🪓 3시간 넘게 몰입했습니다.</div>` : ""}
      <div class="complete-sub">잘 탔습니다.</div>

      <div class="field">
        <label>무엇을 했나요?</label>
        <select id="log-activity-select">
          ${activeTasks.map(t=>`<option value="${t.id}" ${linkedTask && linkedTask.id===t.id ? "selected" : ""}>${escapeHtml(t.title)}</option>`).join("")}
          <option value="__custom__" ${!linkedTask ? "selected" : ""}>직접 입력</option>
        </select>
        <input type="text" id="log-activity-custom" placeholder="무엇을 했나요?" autocomplete="off" ${linkedTask ? "hidden" : ""}>
      </div>

      <div class="field">
        <label>어디에서?</label>
        ${chipGroupHtml("log-location-group", LOCATION_OPTIONS)}
        <input type="text" id="log-location-custom" placeholder="장소" autocomplete="off" hidden>
      </div>

      <div class="field">
        <label>무엇 때문에 시작했나요?</label>
        ${chipGroupHtml("log-trigger-group", TRIGGER_OPTIONS)}
        <input type="text" id="log-trigger-custom" placeholder="계기" autocomplete="off" hidden>
      </div>

      <div class="stack">
        <button class="btn btn-primary" id="complete-log-btn">기록하기</button>
      </div>
      <div class="skip-link" id="complete-skip-link">건너뛰고 끝내기</div>
    `;

    const activitySelect = document.getElementById("log-activity-select");
    const activityCustom = document.getElementById("log-activity-custom");
    activitySelect.addEventListener("change", ()=>{
      activityCustom.hidden = activitySelect.value !== "__custom__";
      if(activitySelect.value === "__custom__") activityCustom.focus();
    });
    setupChipGroup("log-location-group", "log-location-custom");
    setupChipGroup("log-trigger-group", "log-trigger-custom");

    document.getElementById("complete-log-btn").addEventListener("click", ()=>{
      session.activity = activitySelect.value === "__custom__"
        ? activityCustom.value.trim()
        : (state.tasks.find(t=>t.id===activitySelect.value) || {}).title || "";
      session.location = getSelectedChipValue("log-location-group", "log-location-custom");
      session.trigger = getSelectedChipValue("log-trigger-group", "log-trigger-custom");
      saveSessions();
      showScreen("home");
      showToast("기록했습니다. 🔔", { autoCloseMs: 1200 });
    });
    document.getElementById("complete-skip-link").addEventListener("click", ()=>showScreen("home"));
  }

  function renderFocusComplete(){
    const { session, interrupted } = state.lastCompleteInfo;
    const container = document.getElementById("complete-content");

    if(session.mode === "divine"){
      renderDivineLogForm(session, session.durationSeconds*1000 >= SHRINE_AXE_MS);
      return;
    }

    if(!interrupted){
      container.innerHTML = `
        <div class="complete-icon">🔥</div>
        <div class="complete-headline">지금 시작 종료</div>
        <div class="complete-minutes">${formatSessionDuration(session)}</div>
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
        <div class="complete-minutes">${formatSessionDuration(session)}</div>
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
      openDurationPicker(task.id);
    });
    document.getElementById("complete-done-btn").addEventListener("click", ()=>showScreen("home"));
  }

  // recover an in-progress focus session after refresh
  function recoverFocusIfNeeded(){
    const focus = state.currentFocus;
    if(!focus) return false;
    if(focus.mode === "divine"){
      showScreen("shrine-timer");
      runShrineTimer();
      return true;
    }
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
    const divineSessionsWeek = weekSessions.filter(s=>s.mode==="divine");

    const totalWeekMin = weekSessions.reduce((sum,s)=>sum+s.actualDuration,0);
    const avgDivine = divineSessionsWeek.length
      ? Math.round(divineSessionsWeek.reduce((sum,s)=>sum+s.actualDuration,0)/divineSessionsWeek.length)
      : 0;

    const allDivine = sessions.filter(s=>s.mode==="divine");
    const longestDivine = allDivine.length
      ? allDivine.reduce((a,b)=> b.actualDuration>a.actualDuration ? b : a)
      : null;
    const overThreeHourCount = allDivine.filter(s=>s.actualDuration>=180).length;

    const bestHourLabel = computeBestHourRange(weekSessions);
    const topCatalyst = computeTopCatalyst(weekSessions);
    const overexertionTask = computeOverexertionTask();
    const divineSectionHtml = renderDivinePatternSection(allDivine);

    container.innerHTML = `
      <h1 class="screen-title">나의 작업 패턴</h1>
      <div class="pattern-grid">
        <div class="pattern-tile">
          <div class="label">이번 주 실제 작업</div>
          <div class="value">${Math.floor(totalWeekMin/60)}시간 ${totalWeekMin%60}분</div>
        </div>
        <div class="pattern-tile">
          <div class="label">신내림 횟수</div>
          <div class="value">${divineSessionsWeek.length}회</div>
        </div>
        <div class="pattern-tile">
          <div class="label">평균 신내림</div>
          <div class="value">${avgDivine}분</div>
        </div>
        <div class="pattern-tile">
          <div class="label">전체 세션</div>
          <div class="value">${sessions.length}회</div>
        </div>
      </div>
      <div class="divider"></div>
      ${bestHourLabel ? `<div class="pattern-insight-row"><span class="label">가장 잘 되는 시간</span><span class="value">${bestHourLabel}</span></div>` : ""}
      ${topCatalyst ? `<div class="pattern-insight-row"><span class="label">가장 효과적인 촉매</span><span class="value">${topCatalyst}</span></div>` : ""}
      ${longestDivine ? `<div class="pattern-insight-row"><span class="label">가장 긴 신내림</span><span class="value">${formatSessionDuration(longestDivine)}</span></div>` : ""}
      ${overThreeHourCount>0 ? `<div class="pattern-insight-row"><span class="label">3시간 이상 몰입</span><span class="value">🪓 ${overThreeHourCount}회</span></div>` : ""}
      ${overexertionTask ? `<div class="pattern-insight-row"><span class="label">과몰입이 잦은 작업</span><span class="value">${escapeHtml(overexertionTask)}</span></div>` : ""}
      ${divineSectionHtml}
      <div class="reset-link" id="reset-data-link">데이터 초기화</div>
    `;
    document.getElementById("reset-data-link").addEventListener("click", ()=>{
      if(confirm("모든 데이터를 초기화할까요? 되돌릴 수 없습니다.")){
        localStorage.removeItem(STORAGE_KEYS.tasks);
        localStorage.removeItem(STORAGE_KEYS.sessions);
        localStorage.removeItem(STORAGE_KEYS.focus);
        location.reload();
      }
    });
  }

  // ---- 나의 신내림: 시간대/장소/계기별 분석 ----
  function generalPeriodWord(hour){
    if(hour < 5) return "새벽";
    if(hour < 12) return "오전";
    if(hour < 18) return "오후";
    if(hour < 22) return "저녁";
    return "심야";
  }

  function formatHourRangeKorean(start, end){
    function part(h){
      const hh = ((h % 24) + 24) % 24;
      const period = hh < 12 ? "오전" : "오후";
      let h12 = hh % 12; if(h12===0) h12 = 12;
      return { period, h12 };
    }
    const s = part(start), e = part(end);
    if(s.period === e.period) return `${s.period} ${s.h12}~${e.h12}시`;
    return `${s.period} ${s.h12}시~${e.period} ${e.h12}시`;
  }

  function topGroup(items, keyFn){
    const counts = {};
    items.forEach(it=>{
      const k = keyFn(it);
      if(!k) return;
      counts[k] = (counts[k]||0)+1;
    });
    let bestKey = null;
    Object.keys(counts).forEach(k=>{ if(bestKey===null || counts[k] > counts[bestKey]) bestKey = k; });
    if(bestKey===null) return null;
    return { key: bestKey, count: counts[bestKey] };
  }

  function fourHourBucketStart(iso){ return Math.floor(new Date(iso).getHours()/4)*4; }

  function computeDivineTimeInsight(divineSessions){
    if(divineSessions.length < 3) return null;
    const top = topGroup(divineSessions, s => String(fourHourBucketStart(s.startedAt)));
    if(!top) return null;
    const start = Number(top.key);
    return { label: formatHourRangeKorean(start, start+4), startHour: start, count: top.count, total: divineSessions.length };
  }

  function computeDivineFieldInsight(divineSessions, field){
    const withField = divineSessions.filter(s=>s[field]);
    if(withField.length < 3) return null;
    const top = topGroup(withField, s=>s[field]);
    if(!top) return null;
    return { label: top.key, count: top.count, total: withField.length };
  }

  function patternBarRowHtml(title, desc, count, total){
    const pct = total>0 ? Math.round((count/total)*100) : 0;
    return `
      <div class="pattern-bar-row">
        <div class="pattern-bar-top">
          <span class="pattern-bar-label">${title}</span>
          <span class="pattern-bar-desc">${escapeHtml(desc)}</span>
        </div>
        <div class="pattern-bar-track"><div class="pattern-bar-fill" style="width:${pct}%"></div></div>
        <div class="pattern-bar-count">${count}회</div>
      </div>`;
  }

  function insightSentenceTimeOfDay(info){
    if(!info || info.count < 3 || info.count < Math.ceil(info.total*0.4)) return null;
    return `당신의 신내림은 ${generalPeriodWord(info.startHour)}에 자주 찾아오는 편입니다.<br>최근 신내림 ${info.total}회 중 ${info.count}회가 ${info.label}에 시작됐습니다.`;
  }

  function insightSentenceByField(divineSessions, field, fieldLabel){
    const withField = divineSessions.filter(s=>s[field]);
    const groups = {};
    withField.forEach(s=>{ (groups[s[field]] = groups[s[field]]||[]).push(s.actualDuration); });
    const keys = Object.keys(groups).filter(k=>groups[k].length>=3);
    if(keys.length===0) return null;
    let best=null, bestAvg=-1;
    keys.forEach(k=>{
      const avg = groups[k].reduce((a,b)=>a+b,0)/groups[k].length;
      if(avg>bestAvg){ bestAvg=avg; best=k; }
    });
    if(!best) return null;
    const others = withField.filter(s=>s[field]!==best).map(s=>s.actualDuration);
    if(field==="location"){
      if(others.length===0) return null;
      const othersAvg = others.reduce((a,b)=>a+b,0)/others.length;
      const diff = Math.round(bestAvg - othersAvg);
      if(diff < 5) return null;
      return `${escapeHtml(best)}에서 집중이 오래 지속되는 편입니다.<br>다른 곳보다 ${escapeHtml(best)}에서 평균 ${diff}분 더 오래 집중했습니다.`;
    }
    return `${escapeHtml(best)} 시작했을 때 집중 시간이 길어지는 편입니다.<br>이 계기였던 신내림의 평균 집중 시간은 ${Math.round(bestAvg)}분입니다.`;
  }

  function computeDivineCombo(divineSessions){
    const withBoth = divineSessions.filter(s=>s.location && s.trigger);
    if(withBoth.length < 6) return null;
    const groups = {};
    withBoth.forEach(s=>{
      const start = fourHourBucketStart(s.startedAt);
      const key = `${formatHourRangeKorean(start,start+4)}|${s.location}|${s.trigger}`;
      groups[key] = (groups[key]||0)+1;
    });
    let bestKey = null;
    Object.keys(groups).forEach(k=>{ if(bestKey===null || groups[k]>groups[bestKey]) bestKey = k; });
    if(bestKey===null) return null;
    const count = groups[bestKey];
    if(count < Math.ceil(withBoth.length*0.5)) return null;
    const [timeLabel, loc, trig] = bestKey.split("|");
    return { timeLabel, location: loc, trigger: trig, count, total: withBoth.length };
  }

  function comboCardHtml(combo){
    return `
      <div class="combo-card">
        <div class="combo-title">🔔 신내림 패턴 발견</div>
        <div class="combo-sub">당신에게 집중이 찾아오는 순간은<br>이런 조건과 관련이 있어 보입니다.</div>
        <div class="combo-conditions">
          <span class="combo-chip">${escapeHtml(combo.location)}</span>
          <span class="combo-plus">+</span>
          <span class="combo-chip">${escapeHtml(combo.timeLabel)}</span>
          <span class="combo-plus">+</span>
          <span class="combo-chip">${escapeHtml(combo.trigger)}</span>
        </div>
        <div class="combo-result">이 조건에서 최근 ${combo.total}번 중<br>${combo.count}번 집중을 시작했습니다.</div>
      </div>`;
  }

  // 데이터가 부족하면 항목별로 조용히 생략된다 (§12: 사용자를 단정하지 않는다).
  function renderDivinePatternSection(allDivine){
    if(allDivine.length < 3) return "";

    const timeInfo = computeDivineTimeInsight(allDivine);
    const locInfo = computeDivineFieldInsight(allDivine, "location");
    const trigInfo = computeDivineFieldInsight(allDivine, "trigger");
    const avgDuration = Math.round(allDivine.reduce((sum,s)=>sum+s.actualDuration,0)/allDivine.length);

    const bars = [
      timeInfo ? patternBarRowHtml("언제?", timeInfo.label, timeInfo.count, timeInfo.total) : "",
      locInfo ? patternBarRowHtml("어디서?", locInfo.label, locInfo.count, locInfo.total) : "",
      trigInfo ? patternBarRowHtml("무엇 때문에?", trigInfo.label, trigInfo.count, trigInfo.total) : ""
    ].join("");

    const sentences = [
      insightSentenceTimeOfDay(timeInfo),
      insightSentenceByField(allDivine, "location", "장소"),
      insightSentenceByField(allDivine, "trigger", "계기")
    ].filter(Boolean);

    const combo = computeDivineCombo(allDivine);

    if(!bars && sentences.length===0 && !combo) return "";

    return `
      <div class="divider"></div>
      <h2 class="pattern-section-title">🔔 나의 신내림</h2>
      ${bars}
      <div class="pattern-insight-row"><span class="label">평균 집중 시간</span><span class="value">${avgDuration}분</span></div>
      ${sentences.length ? `<div class="pattern-insights">${sentences.map(s=>`<p class="pattern-insight-sentence">${s}</p>`).join("")}</div>` : ""}
      ${combo ? comboCardHtml(combo) : ""}
    `;
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
    let deadlineDriven = 0, divine = 0, normal = 0;
    sessions.forEach(s=>{
      if(s.mode === "divine") divine++;
      else{
        const t = state.tasks.find(t=>t.id===s.taskId);
        if(t && t.deadline) deadlineDriven++;
        else normal++;
      }
    });
    if(deadlineDriven >= divine && deadlineDriven >= normal && deadlineDriven>0) return "마감 임박";
    if(divine >= normal && divine>0) return "신내림";
    if(normal>0) return "스스로 시작";
    return null;
  }

  function computeOverexertionTask(){
    const counts = {};
    state.focusSessions.forEach(s=>{
      if(!s.plannedDuration) return; // stopwatch sessions have no planned duration to overshoot
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
      if(target === "shrine"){
        // A stopwatch already running takes precedence over restarting the
        // 왔다 ritual — the nav is visible during 신내림 now (spec change),
        // so tapping the tab again should return to the running timer.
        if(state.currentFocus && state.currentFocus.mode === "divine"){
          showScreen("shrine-timer");
          runShrineTimer();
        }else{
          openShrine();
        }
      }else{
        showScreen(target);
      }
    });
  });

  document.getElementById("brand-home-btn").addEventListener("click", returnToSplash);
  document.getElementById("brand-home-btn").addEventListener("keydown", e=>{
    if(e.key==="Enter" || e.key===" "){ e.preventDefault(); returnToSplash(); }
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
