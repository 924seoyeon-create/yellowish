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
    editTaskId: null,
    lastCompleteInfo: null,  // info to render on focus-complete screen
    timerInterval: null,
    displayedUrgency: null,     // urgency currently shown on the home fire-stage
    displayedFireMode: null,    // "ladder" | "grid" | "overdue"
    calendarViewDate: null,
    calendarMode: "view",       // "view" | "pick"
    calendarSelectedDate: null,
    pickedDeadlineDate: null    // yyyy-mm-dd staged from the calendar picker for the add-task form
  };

  // Random focus-length pool offered for 오늘 (spec §8).
  const DURATIONS = [17, 23, 31, 37, 43];
  const DEFAULT_TODAY_MINUTES = 40;
  const SHRINE_AXE_MS = 3 * 60 * 60 * 1000;

  // Fire always rises from the bottom of the stage toward the foot at the
  // top. Never edit these to move the flame via `top` — see spec rule #16.
  // Level 1 sits below the visible stage (and is opacity:0 via CSS) so no
  // fire is visible at all — spec §6-1 "불은 화면에 나타나지 않는다".
  const FLAME_BOTTOM = { 1: -15, 2: 20, 3: 42, 4: 64 };

  const URGENCY_INFO = {
    1: { temp: "여유", message: "강 건너 불구경" },
    2: { temp: "보통", message: "아 따뜻하다" },
    3: { temp: "주의", message: "발등에 불 떨어짐" },
    4: { temp: "긴급", message: "불 속에 발을 집어넣음" },
    5: { temp: "매우 긴급", message: "화형ing~" }
  };

  const MENTIONS = {
    home: "다 울었니?<br>이제 할 일을 하자",
    pattern: "심연을 들여다보면<br>심연도 나를 들여다본다"
  };

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

  function reducedMotion(){
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

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
    return !!task.deadline && new Date(task.deadline).getTime() < Date.now();
  }

  function calculateUrgency(task){
    // MVP: user-defined urgency is used directly.
    // Later: combine deadline proximity + importance + externalCommitment + behavior patterns.
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

  // ============ MENTION (기본 멘트) ============
  // Shows a short mention line in place of a screen's content container,
  // then fades it out and hands off to renderFn. Spec requires every entry
  // into 오늘/신내림/패턴 to lead with its mention before the real content.
  function showMentionThen(containerEl, text, renderFn){
    if(reducedMotion()){ renderFn(); return; }
    containerEl.innerHTML = `<div class="mention-block"><div class="mention-text">${text}</div></div>`;
    const block = containerEl.querySelector(".mention-block");
    requestAnimationFrame(()=> block.classList.add("show"));
    setTimeout(()=>{
      block.classList.add("hide");
      setTimeout(renderFn, 260);
    }, 700);
  }

  function enterHome(){
    showMentionThen(document.getElementById("home-content"), MENTIONS.home, renderHome);
  }

  function enterPattern(){
    showMentionThen(document.getElementById("pattern-content"), MENTIONS.pattern, renderPatterns);
  }

  // ============ NAVIGATION ============
  function showScreen(name){
    state.currentScreen = name;
    document.querySelectorAll(".screen").forEach(el=>el.classList.remove("active"));
    document.getElementById("screen-"+name).classList.add("active");

    const nav = document.getElementById("bottom-nav");
    const hideNavOn = ["focus", "focus-complete", "add-task", "task-detail", "shrine", "shrine-timer", "other-tasks", "calendar"];
    nav.classList.toggle("hidden", hideNavOn.includes(name));

    document.querySelectorAll("#bottom-nav button").forEach(b=>{
      b.classList.toggle("active", b.dataset.nav === name);
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

  function fireStageHtml(mode){
    if(mode === "overdue"){
      return `<div class="fire-stage fire-grid-mode overdue-mode" aria-hidden="true"><div class="flame-grid">🔥🔥🔥<br>🔥🦶🔥<br>🔥🔥🔥</div></div>`;
    }
    if(mode === "grid"){
      return `<div class="fire-stage fire-grid-mode" aria-hidden="true"><div class="flame-grid">🔥🔥🔥<br>🔥🔥🔥<br>🔥🔥🔥</div></div>`;
    }
    return `
      <div class="fire-stage" id="home-fire-stage" aria-hidden="true">
        <div class="fire-track">
          <div class="flame" id="home-flame">🔥</div>
          <div class="foot" id="home-foot">🦶</div>
        </div>
      </div>`;
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

    const overdue = isOverdue(task);
    const urgency = effectiveUrgency(task);
    const others = activeTasks.length - 1;

    container.innerHTML = `
      <div id="home-fire-stage-wrap"></div>
      <div class="temp-label" id="home-temp-label"></div>
      <div class="urgency-caption" id="home-caption"></div>

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
  // (ladder vs level-5 grid vs overdue grid) hasn't changed, only the
  // flame's `bottom` position and text are touched, so the CSS transition
  // on `bottom` can animate smoothly between urgency levels.
  function applyUrgencyToHome(task, urgency, overdue, opts){
    opts = opts || {};
    const mode = overdue ? "overdue" : (urgency>=5 ? "grid" : "ladder");
    const modeChanged = state.displayedFireMode !== mode;
    state.displayedFireMode = mode;
    state.displayedUrgency = urgency;
    const isExtreme = overdue || urgency >= 5;
    const info = URGENCY_INFO[urgency];

    const wrap = document.getElementById("home-fire-stage-wrap");
    if(wrap && modeChanged){
      wrap.innerHTML = fireStageHtml(mode);
    }
    if(mode === "ladder"){
      const stage = document.getElementById("home-fire-stage");
      const flame = document.getElementById("home-flame");
      if(stage) stage.setAttribute("data-urgency", String(urgency));
      if(flame) flame.style.setProperty("--flame-bottom", FLAME_BOTTOM[urgency] + "%");
    }

    const tempLabel = document.getElementById("home-temp-label");
    if(tempLabel){
      tempLabel.textContent = overdue ? "위험" : info.temp;
      tempLabel.classList.toggle("hot", isExtreme);
    }

    const caption = document.getElementById("home-caption");
    if(caption){
      caption.textContent = overdue ? "발이 불타고 있습니다." : info.message;
      caption.classList.toggle("hot", isExtreme);
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
    if(!btn || !clearLink) return;
    if(state.pickedDeadlineDate){
      const [y,m,d] = state.pickedDeadlineDate.split("-");
      btn.textContent = `📅 ${y}년 ${Number(m)}월 ${Number(d)}일`;
      clearLink.hidden = false;
    }else{
      btn.textContent = "📅 날짜 선택";
      clearLink.hidden = true;
    }
  }

  function openAddTask(editId){
    state.editTaskId = editId || null;
    const form = document.getElementById("task-form");
    form.reset();
    state.pickedDeadlineDate = null;
    document.getElementById("f-deadline-time").value = "";
    document.getElementById("add-task-title").textContent = editId ? "작업 수정" : "무엇을 해야 하나요?";

    if(editId){
      const t = state.tasks.find(t=>t.id===editId);
      if(t){
        document.getElementById("f-title").value = t.title;
        document.getElementById("f-next").value = t.nextAction||"";
        if(t.deadline){
          const d = new Date(t.deadline);
          state.pickedDeadlineDate = dateKey(d);
          document.getElementById("f-deadline-time").value = `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
        }
        document.querySelector(`input[name=importance][value="${t.importance}"]`).checked = true;
        document.querySelector(`input[name=urgency][value="${t.urgency}"]`).checked = true;
        document.getElementById("f-commit").value = t.externalCommitment||"";
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

    let deadlineIso = null;
    if(state.pickedDeadlineDate){
      const timeVal = document.getElementById("f-deadline-time").value || "23:59";
      deadlineIso = new Date(`${state.pickedDeadlineDate}T${timeVal}:00`).toISOString();
    }

    const data = {
      title,
      nextAction: document.getElementById("f-next").value,
      deadline: deadlineIso,
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

  document.getElementById("f-deadline-date-btn").addEventListener("click", ()=>{
    openCalendar("pick");
  });
  document.getElementById("f-deadline-clear").addEventListener("click", ()=>{
    state.pickedDeadlineDate = null;
    document.getElementById("f-deadline-time").value = "";
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
      </div>
    `).join("");

    container.querySelectorAll(".other-task-item").forEach(el=>{
      bindActivate(el, ()=> openTaskDetail(el.dataset.id));
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

    const delay = reducedMotion() ? 0 : 700;
    setTimeout(renderShrineReady, delay);
  }

  function renderShrineReady(){
    const container = document.getElementById("shrine-content");
    const task = selectShrineTask();
    container.innerHTML = `
      <span class="bell-big small"><img src="icons/sinnaerim.png" alt=""></span>
      <div class="shrine-question">집중할 수 있는 순간이 왔어?</div>
      <div class="shrine-answer">그럼 지금 써.</div>
      ${task ? `<div class="shrine-current-task">지금: ${escapeHtml(task.title)}</div>` : ""}
      <div class="shrine-stopwatch-preview">00:00:00</div>
      <button type="button" class="btn btn-primary" id="shrine-start-btn">시작</button>
    `;
    document.getElementById("shrine-start-btn").addEventListener("click", ()=>{
      startShrineStopwatch(task ? task.id : null);
    });
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

    if(session.mode === "divine"){
      const overThreeHours = session.durationSeconds*1000 >= SHRINE_AXE_MS;
      container.innerHTML = `
        <div class="complete-icon"><img src="icons/sinnaerim.png" alt=""></div>
        <div class="complete-headline">신내림 종료</div>
        <div class="complete-minutes">${formatSessionDuration(session)}</div>
        ${overThreeHours ? `<div class="complete-axe">🪓 3시간 넘게 몰입했습니다.</div>` : ""}
        <div class="complete-sub">동안 실제로 작업했습니다.<br><br>잘했습니다.<br>여기서 멈춰도 됩니다.</div>
        <div class="field complete-memo-field">
          <label for="complete-memo">무엇을 하셨나요? <span style="opacity:.6;font-weight:400;">(선택)</span></label>
          <input type="text" id="complete-memo" placeholder="메모 (선택사항)" autocomplete="off">
        </div>
        <div class="stack">
          <button class="btn btn-primary" id="complete-again-btn">한 번 더</button>
          <button class="btn btn-secondary" id="complete-done-btn">오늘은 끝</button>
        </div>
      `;
    }else if(!interrupted){
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

    const memoInput = document.getElementById("complete-memo");
    const saveMemo = ()=>{
      if(memoInput && memoInput.value.trim()){
        session.notes = memoInput.value.trim();
        saveSessions();
      }
    };

    document.getElementById("complete-again-btn").addEventListener("click", ()=>{
      saveMemo();
      if(session.mode === "divine"){ openShrine(); return; }
      const task = state.tasks.find(t=>t.id===session.taskId);
      if(!task){ showScreen("home"); return; }
      openDurationPicker(task.id);
    });
    document.getElementById("complete-done-btn").addEventListener("click", ()=>{
      saveMemo();
      showScreen("home");
    });
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
