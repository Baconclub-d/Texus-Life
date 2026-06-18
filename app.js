(function () {
  "use strict";

  const {
    SCORE_TABLE,
    addDaysKey,
    availableDeck: availableCards,
    cardName,
    cloneCard,
    evaluateHand,
    recommendHand,
    sortedCards,
    todayKey,
    uid,
    usageDateKey
  } = window.PokerLifeCore;
  const { balanceOf: calculateBalance, statsForRange: calculateStats } = window.PokerLifeAnalytics;
  const {
    defaultState,
    loadState,
    restoreState,
    saveState: persistState
  } = window.PokerLifeStorage;

  let state = loadState();
  normalizeLoadedState();
  reconcileMissedDays();
  let toastTimer = null;
  let transientDrawnCard = null;
  let transientDrawnAt = 0;
  const app = document.getElementById("app");
  const backupInput = document.getElementById("backupInput");

  function saveState() {
    persistState(state);
  }

  function normalizeLoadedState() {
    const today = todayKey();
    let changed = false;
    state.migratedPostSettlementTasks = state.migratedPostSettlementTasks || {};
    state.tasks.forEach((task) => {
      const date = task.completedDate;
      const wasCompletedAfterSettledDay =
        task.completed &&
        date &&
        date < today &&
        state.settledDates[date] &&
        !state.migratedPostSettlementTasks[task.id];
      if (!wasCompletedAfterSettledDay) return;
      if ((state.drawChancesByDate[date] || 0) > 0) {
        state.drawChancesByDate[date] -= 1;
      }
      task.completedDate = today;
      state.drawChancesByDate[today] = (state.drawChancesByDate[today] || 0) + 1;
      state.migratedPostSettlementTasks[task.id] = today;
      changed = true;
    });
    if (changed) saveState();
  }

  function reconcileMissedDays() {
    const currentDate = todayKey();
    const candidateDates = new Set();
    Object.keys(state.drawChancesByDate).forEach((date) => {
      if (date < currentDate && !state.settledDates[date]) candidateDates.add(date);
    });
    Object.keys(state.drawsByDate).forEach((date) => {
      if (date < currentDate && !state.settledDates[date]) candidateDates.add(date);
    });
    state.unsettledCards.forEach((card) => {
      if (!card.drawnAt) return;
      const date = usageDateKey(new Date(card.drawnAt));
      if (date < currentDate && !state.settledDates[date]) candidateDates.add(date);
    });
    state.tasks.forEach((task) => {
      if (task.completed && task.completedDate < currentDate && !state.settledDates[task.completedDate]) {
        candidateDates.add(task.completedDate);
      }
    });
    if (state.lastRolloverDate && state.lastRolloverDate < currentDate) {
      let date = state.lastRolloverDate;
      while (date < currentDate) {
        if (!state.settledDates[date]) candidateDates.add(date);
        date = addDaysKey(date, 1);
      }
    }
    const dates = [...candidateDates].sort();
    let totalDrawn = 0;
    let totalHands = 0;
    dates.forEach((date) => {
      const result = autoCloseDay(state, date);
      totalDrawn += result.drawn;
      totalHands += result.hands;
    });
    state.lastRolloverDate = currentDate;
    if (dates.length) {
      state.lastMessage = `已补执行跨日结算：自动抽 ${totalDrawn} 张，结算 ${totalHands} 手`;
      state.lastMessageAt = Date.now();
    }
    saveState();
    return dates.length > 0;
  }

  function setState(mutator) {
    if (state.lastRolloverDate && state.lastRolloverDate !== todayKey()) {
      reconcileMissedDays();
    }
    const previousMessage = state.lastMessage;
    mutator(state);
    if (state.lastMessage && state.lastMessage !== previousMessage) {
      state.lastMessageAt = Date.now();
    }
    saveState();
    render();
  }

  function availableDeck() {
    return availableCards(state.unsettledCards);
  }

  function availableDeckFor(draft) {
    return availableCards(draft.unsettledCards);
  }

  function drawOne() {
    const today = todayKey();
    const chances = state.drawChancesByDate[today] || 0;
    if (chances <= 0) return flash("暂无抽牌机会");
    const pool = availableDeck();
    if (!pool.length) return flash("牌堆已空，请先结算");
    const card = cloneCard(pool[Math.floor(Math.random() * pool.length)]);
    transientDrawnCard = card;
    transientDrawnAt = Date.now();
    setState((draft) => {
      draft.unsettledCards.push(card);
      draft.drawChancesByDate[today] = chances - 1;
      draft.drawsByDate[today] = (draft.drawsByDate[today] || 0) + 1;
      draft.lastDrawnCard = null;
      draft.lastMessage = `抽到 ${cardName(card)}`;
    });
  }

  function drawAll() {
    const chances = state.drawChancesByDate[todayKey()] || 0;
    if (!chances) return flash("暂无抽牌机会");
    for (let i = 0; i < chances; i += 1) drawOne();
  }

  function flash(message) {
    setState((draft) => {
      draft.lastMessage = message;
    });
  }

  function autoSettleOneHand(draft, date) {
    if (draft.unsettledCards.length < 5) return false;
    const rec = recommendHand(draft.unsettledCards);
    const selectedIds = new Set(rec.cards.map((card) => card.drawId));
    draft.unsettledCards = draft.unsettledCards.filter((card) => !selectedIds.has(card.drawId));
    draft.ledger.unshift({
      id: uid("ledger"),
      date,
      type: "income",
      label: `${rec.result.name}自动结算`,
      amount: rec.result.score,
      createdAt: new Date().toISOString()
    });
    const entry = ensureHistory(draft, date);
    entry.hands.push({ name: rec.result.name, score: rec.result.score, automatic: true });
    entry.income = entry.hands.reduce((sum, item) => sum + item.score, 0);
    entry.balanceAfter = balanceOf(draft);
    entry.net = entry.income - entry.expense;
    return true;
  }

  function autoCloseDay(draft, date) {
    let chances = draft.drawChancesByDate[date] || 0;
    let drawn = 0;
    let hands = 0;
    draft.settlement = null;
    draft.gambleSelection = null;

    while (chances > 0) {
      let pool = availableDeckFor(draft);
      if (!pool.length) {
        if (!autoSettleOneHand(draft, date)) break;
        hands += 1;
        pool = availableDeckFor(draft);
      }
      const card = cloneCard(pool[Math.floor(Math.random() * pool.length)]);
      draft.unsettledCards.push(card);
      chances -= 1;
      drawn += 1;
      draft.drawsByDate[date] = (draft.drawsByDate[date] || 0) + 1;
    }

    draft.drawChancesByDate[date] = chances;
    while (autoSettleOneHand(draft, date)) hands += 1;

    const entry = ensureHistory(draft, date);
    entry.automaticSettlement = { drawn, hands };
    entry.balanceAfter = balanceOf(draft);
    entry.net = entry.income - entry.expense;
    draft.settledDates[date] = true;
    draft.settlementModes[date] = "automatic";
    archiveCompletedTasks(draft, date);
    return { drawn, hands };
  }

  function startSettlement() {
    const today = todayKey();
    if ((state.drawChancesByDate[today] || 0) > 0) return flash("需要先抽完今日机会");
    if (state.unsettledCards.length < 5) return flash("未满一手，暂不可结算");
    if (state.settledDates[today]) return flash("今日已结算");
    if (state.gambleSelection) return flash("请先取消“以小博大”");
    const rec = recommendHand(state.unsettledCards);
    setState((draft) => {
      draft.settlement = {
        selectedIds: rec.cards.map((card) => card.drawId),
        recommendedIds: rec.cards.map((card) => card.drawId),
        recommended: rec.result
      };
      draft.lastMessage = `推荐 ${rec.result.name} +${rec.result.score}`;
    });
  }

  function settleSelected() {
    if (!state.settlement || state.settlement.selectedIds.length !== 5) return flash("请选择 5 张牌");
    const selected = state.unsettledCards.filter((card) => state.settlement.selectedIds.includes(card.drawId));
    const result = evaluateHand(selected, state.unsettledCards);
    const today = todayKey();
    setState((draft) => {
      draft.unsettledCards = draft.unsettledCards.filter((card) => !draft.settlement.selectedIds.includes(card.drawId));
      draft.ledger.unshift({
        id: uid("ledger"),
        date: today,
        type: "income",
        label: `${result.name}结算`,
        amount: result.score,
        createdAt: new Date().toISOString()
      });
      const entry = ensureHistory(draft, today);
      entry.hands.push({ name: result.name, score: result.score });
      entry.income += result.score;
      entry.balanceAfter = balanceOf(draft);
      draft.lastMessage = `${result.name} +${result.score}`;
      if (draft.unsettledCards.length >= 5) {
        const rec = recommendHand(draft.unsettledCards);
        draft.settlement = {
          selectedIds: rec.cards.map((card) => card.drawId),
          recommendedIds: rec.cards.map((card) => card.drawId),
          recommended: rec.result
        };
      } else {
        draft.settlement = null;
        draft.settledDates[today] = true;
        draft.settlementModes[today] = "settlement";
        archiveCompletedTasks(draft, today);
      }
    });
  }

  function startGamble() {
    const today = todayKey();
    if ((state.drawChancesByDate[today] || 0) > 0) return flash("需要先抽完今日机会");
    if (state.unsettledCards.length < 5) return flash("至少需要 5 张未结算牌");
    if (state.settledDates[today]) return flash("今日已完成牌局");
    if (state.settlement) return flash("已进入结算流程，不能改为以小博大");
    setState((draft) => {
      draft.gambleSelection = { selectedIds: [] };
      draft.lastMessage = "请选择 4 张牌保留到次日";
    });
  }

  function cancelGamble() {
    setState((draft) => {
      draft.gambleSelection = null;
      draft.lastMessage = "已取消以小博大";
    });
  }

  function confirmGamble() {
    if (!state.gambleSelection || state.gambleSelection.selectedIds.length !== 4) {
      return flash("请选择恰好 4 张牌");
    }
    const today = todayKey();
    if ((state.drawChancesByDate[today] || 0) > 0) return flash("出现了新的抽牌机会，请先抽完");
    if (state.settledDates[today]) return flash("今日已完成牌局");
    setState((draft) => {
      const keptIds = new Set(draft.gambleSelection.selectedIds);
      const discardedCount = draft.unsettledCards.length - keptIds.size;
      draft.unsettledCards = draft.unsettledCards.filter((card) => keptIds.has(card.drawId));
      draft.gambleSelection = null;
      draft.settledDates[today] = true;
      draft.settlementModes[today] = "gamble";
      const entry = ensureHistory(draft, today);
      entry.gamble = { kept: 4, discarded: discardedCount };
      entry.balanceAfter = balanceOf(draft);
      archiveCompletedTasks(draft, today);
      draft.lastMessage = `以小博大：保留 4 张，弃掉 ${discardedCount} 张`;
    });
  }

  function ensureHistory(draft, date) {
    if (!draft.history[date]) {
      draft.history[date] = {
        date,
        tasks: [],
        draws: 0,
        hands: [],
        income: 0,
        expense: 0,
        net: 0,
        balanceAfter: balanceOf(draft)
      };
    }
    const entry = draft.history[date];
    entry.draws = draft.drawsByDate[date] || entry.draws || 0;
    entry.expense = Math.abs(
      draft.ledger.filter((item) => item.date === date && item.type === "expense").reduce((sum, item) => sum + item.amount, 0)
    );
    entry.income = entry.hands.reduce((sum, item) => sum + item.score, 0);
    entry.net = entry.income - entry.expense;
    return entry;
  }

  function archiveCompletedTasks(draft, date) {
    const completed = draft.tasks.filter((task) => task.completed && task.completedDate === date);
    if (!completed.length) return;
    const entry = ensureHistory(draft, date);
    entry.tasks = [...new Set([...entry.tasks, ...completed.map((task) => task.title)])];
    draft.tasks = draft.tasks.filter((task) => !(task.completed && task.completedDate === date));
  }

  function balanceOf(draft = state) {
    return calculateBalance(draft);
  }

  function statsForRange(days) {
    return calculateStats(state, days, todayKey, addDaysKey);
  }

  function addTask(event) {
    event.preventDefault();
    const input = event.currentTarget.elements.taskTitle;
    const title = input.value.trim();
    if (!title) return;
    setState((draft) => {
      draft.tasks.unshift({
        id: uid("task"),
        title,
        createdAt: new Date().toISOString(),
        createdDate: todayKey(),
        completed: false,
        completedDate: null,
        drawSpent: false
      });
      draft.lastMessage = "任务已加入牌桌";
    });
  }

  function completeTask(id) {
    setState((draft) => {
      const task = draft.tasks.find((item) => item.id === id);
      if (!task || task.completed) return;
      const today = todayKey();
      const rewardDate = draft.settledDates[today] ? addDaysKey(today, 1) : today;
      task.completed = true;
      task.completedDate = rewardDate;
      draft.drawChancesByDate[rewardDate] = (draft.drawChancesByDate[rewardDate] || 0) + 1;
      draft.lastMessage = rewardDate === today ? "获得 1 次抽牌机会" : "今日已结算，已计入明日抽牌机会";
    });
  }

  function editTask(id) {
    const task = state.tasks.find((item) => item.id === id);
    if (!task || task.completed) return flash("已完成任务不能编辑");
    setState((draft) => {
      draft.editingTaskId = id;
    });
  }

  function saveTaskEdit(event, id) {
    event.preventDefault();
    const title = event.currentTarget.elements.taskTitle.value.trim();
    if (!title) return flash("任务内容不能为空");
    setState((draft) => {
      const task = draft.tasks.find((item) => item.id === id);
      if (task && !task.completed) task.title = title;
      draft.editingTaskId = null;
      draft.lastMessage = "任务已更新";
    });
  }

  function cancelTaskEdit() {
    setState((draft) => {
      draft.editingTaskId = null;
    });
  }

  function deleteTask(id) {
    const task = state.tasks.find((item) => item.id === id);
    if (!task || task.completed) return flash("已完成任务不能删除");
    if (!confirm("删除这个任务？")) return;
    setState((draft) => {
      draft.tasks = draft.tasks.filter((item) => item.id !== id);
      draft.lastMessage = "任务已删除";
    });
  }

  function undoTask(id) {
    const task = state.tasks.find((item) => item.id === id);
    const today = todayKey();
    if (!task || !task.completed) return;
    if (task.completedDate !== today) return flash("已计入未来日期，暂不支持取消");
    if ((state.drawsByDate[today] || 0) > 0) return flash("今日已经抽过牌，不能取消完成");
    setState((draft) => {
      const item = draft.tasks.find((entry) => entry.id === id);
      item.completed = false;
      item.completedDate = null;
      draft.drawChancesByDate[today] = Math.max(0, (draft.drawChancesByDate[today] || 0) - 1);
      draft.lastMessage = "已取消完成，抽牌机会 -1";
    });
  }

  function addLedger(event, type) {
    event.preventDefault();
    const amountInput = event.currentTarget.elements.amount;
    const dateInput = event.currentTarget.elements.date;
    const amountRaw = Number(amountInput.value);
    if (!Number.isFinite(amountRaw) || amountRaw === 0) return flash("请输入有效金额");
    const amount = type === "expense" ? -Math.abs(amountRaw) : amountRaw;
    const date = dateInput.value || todayKey();
    setState((draft) => {
      draft.ledger.unshift({
        id: uid("ledger"),
        date,
        type,
        label: type === "expense" ? "支出抵扣" : "初始化或调整",
        amount,
        createdAt: new Date().toISOString()
      });
      const entry = ensureHistory(draft, date);
      entry.balanceAfter = balanceOf(draft);
      entry.net = entry.income - entry.expense;
      draft.lastMessage = type === "expense" ? "支出已记录" : "余额已调整";
    });
    event.currentTarget.reset();
  }

  function exportBackup() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `pokerlife-backup-${todayKey()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function importBackup(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        state = restoreState(data, "备份已导入");
        saveState();
        render();
      } catch {
        flash("备份文件格式不正确");
      }
    };
    reader.readAsText(file);
  }

  function resetData() {
    if (!confirm("确定重置全部数据？此操作不可恢复。")) return;
    if (!confirm("请再次确认：所有任务、牌堆、积分和历史都会清空。")) return;
    state = defaultState();
    saveState();
    render();
  }

  function onboard(event) {
    event.preventDefault();
    const amount = Number(event.currentTarget.elements.initial.value || 0);
    setState((draft) => {
      if (amount !== 0) {
        draft.ledger.unshift({
          id: uid("ledger"),
          date: todayKey(),
          type: "adjustment",
          label: "初始化余额",
          amount,
          createdAt: new Date().toISOString()
        });
      }
      draft.onboarded = true;
      draft.lastMessage = "欢迎上桌";
    });
  }

  function render() {
    app.innerHTML = state.onboarded ? renderApp() : renderOnboarding();
    bindEvents();
    scheduleToastClear();
  }

  function renderOnboarding() {
    return `
      <main class="onboarding">
        <section class="hero-table">
          <p class="eyebrow">PokerLife PWA</p>
          <h1>上桌</h1>
          <p>完成现实任务，获得抽牌机会；用牌型结算积分，再把积分变成现实开销的边界。</p>
          <form data-action="onboard" class="inline-form">
            <label>初始余额</label>
            <input name="initial" type="number" step="1" value="0" />
            <button type="submit">开始使用</button>
          </form>
        </section>
        <section class="score-grid">${scoreTableHtml()}</section>
      </main>
    `;
  }

  function renderApp() {
    const tab = state.activeTab;
    return `
      <header class="topbar">
        <div>
          <p class="eyebrow">上桌 PokerLife</p>
          <h1>${tabTitle(tab)}</h1>
        </div>
        <button class="icon-button" data-action="settings" title="设置">⚙</button>
      </header>
      ${isMessageFresh() ? `<div class="toast">${escapeHtml(state.lastMessage)}</div>` : ""}
      <main class="screen">${renderTab(tab)}</main>
      <nav class="bottom-nav">
        ${navButton("tasks", "任务")}
        ${navButton("draw", "抽牌")}
        ${navButton("points", "积分")}
        ${navButton("history", "历史")}
      </nav>
    `;
  }

  function tabTitle(tab) {
    return { tasks: "任务", draw: "抽牌", points: "积分", history: "历史" }[tab] || "任务";
  }

  function navButton(id, label) {
    return `<button class="${state.activeTab === id ? "active" : ""}" data-tab="${id}">${label}</button>`;
  }

  function renderTab(tab) {
    if (tab === "draw") return renderDraw();
    if (tab === "points") return renderPoints();
    if (tab === "history") return renderHistory();
    return renderTasks();
  }

  function renderTasks() {
    const openTasks = state.tasks.filter((task) => !task.completed);
    const completed = state.tasks.filter((task) => task.completed);
    return `
      <section class="panel">
        <form data-action="add-task" class="task-form">
          <input name="taskTitle" placeholder="添加一个现实任务" autocomplete="off" />
          <button type="submit">加入</button>
        </form>
      </section>
      <section class="list">
        ${openTasks.length ? openTasks.map(taskRow).join("") : empty("还没有未完成任务")}
        ${completed.length ? `<h2>已完成，待归档</h2>${completed.map(taskRow).join("")}` : ""}
      </section>
    `;
  }

  function taskRow(task) {
    if (state.editingTaskId === task.id) {
      return `
        <form class="task-row editing" data-action="save-task-edit" data-id="${task.id}">
          <span class="check"></span>
          <input name="taskTitle" value="${escapeHtml(task.title)}" autocomplete="off" />
          <menu>
            <button type="submit">保存</button>
            <button type="button" data-action="cancel-task-edit">取消</button>
          </menu>
        </form>
      `;
    }
    return `
      <article class="task-row ${task.completed ? "done" : ""}">
        <button class="check" data-action="${task.completed ? "undo-task" : "complete-task"}" data-id="${task.id}">
          ${task.completed ? "✓" : ""}
        </button>
        <div>
          <strong>${escapeHtml(task.title)}</strong>
          <span>${task.completed ? `完成于 ${task.completedDate}` : `创建于 ${task.createdDate}`}</span>
        </div>
        <menu>
          <button data-action="edit-task" data-id="${task.id}">编辑</button>
          <button data-action="delete-task" data-id="${task.id}">删除</button>
        </menu>
      </article>
    `;
  }

  function renderDraw() {
    const today = todayKey();
    const chances = state.drawChancesByDate[today] || 0;
    const completedToday = state.tasks.filter((task) => task.completedDate === today).length;
    const cards = state.sortCards ? sortedCards(state.unsettledCards) : state.unsettledCards;
    const drawAnimationCard = isDrawAnimationFresh() ? transientDrawnCard : null;
    return `
      <section class="stats">
        ${stat("今日完成", completedToday)}
        ${stat("可抽次数", chances)}
        ${stat("未结算牌", state.unsettledCards.length)}
      </section>
      <p class="boundary-note">每日 00:30 结算边界；未主动处理时，系统自动抽完并按推荐连续结算。</p>
      <section class="table-zone ${state.settlement || state.gambleSelection ? "settling" : ""}">
        <div class="deck-visual"><span></span><span></span><span></span></div>
        ${drawAnimationCard ? `<div class="flying-card ${cardColorClass(drawAnimationCard)}">${cardFaceInner(drawAnimationCard)}</div>` : ""}
        <div class="actions">
          <div class="action-row">
            <button data-action="draw-one">抽 1 张</button>
            <button data-action="draw-all">全部抽完</button>
          </div>
          <div class="action-row resolution-actions">
            <button data-action="settle-start">${settleButtonLabel()}</button>
            <button class="gamble-button" data-action="gamble-start">${gambleButtonLabel()}</button>
          </div>
        </div>
      </section>
      ${state.settlement ? renderSettlement() : ""}
      ${state.gambleSelection ? renderGambleSelection() : ""}
      <section class="panel">
        <div class="section-head">
          <h2>未结算牌堆</h2>
          <button data-action="toggle-sort">${state.sortCards ? "按抽牌顺序" : "整理牌面"}</button>
        </div>
        <div class="cards">${cards.map(cardHtml).join("") || empty("暂无未结算牌")}</div>
      </section>
    `;
  }

  function renderSettlement() {
    const selected = state.unsettledCards.filter((card) => state.settlement.selectedIds.includes(card.drawId));
    const selectedResult = selected.length === 5 ? evaluateHand(selected, state.unsettledCards) : null;
    return `
      <section class="settlement panel">
        <div class="section-head">
          <div>
            <h2>单手结算</h2>
            <p>推荐 ${state.settlement.recommended.name} +${state.settlement.recommended.score}</p>
          </div>
          <strong>${selectedResult ? `${selectedResult.name} +${selectedResult.score}` : `${selected.length}/5`}</strong>
        </div>
        <div class="cards selectable">
          ${state.unsettledCards.map((card) => cardHtml(card, state.settlement.selectedIds.includes(card.drawId))).join("")}
        </div>
        <button class="primary wide" data-action="settle-confirm">结算这手</button>
      </section>
    `;
  }

  function renderGambleSelection() {
    const selectedIds = state.gambleSelection.selectedIds;
    const discardedCount = Math.max(0, state.unsettledCards.length - 4);
    return `
      <section class="settlement gamble-panel panel">
        <div class="section-head">
          <div>
            <h2>以小博大</h2>
            <p>选择 4 张保留到次日，其余牌无积分弃掉</p>
          </div>
          <strong>${selectedIds.length}/4</strong>
        </div>
        <div class="cards selectable">
          ${state.unsettledCards.map((card) => cardHtml(card, selectedIds.includes(card.drawId))).join("")}
        </div>
        <p class="gamble-summary">确认后将保留 4 张，弃掉 ${discardedCount} 张，并结束今日牌局。</p>
        <div class="confirm-row">
          <button data-action="gamble-cancel">取消</button>
          <button class="primary" data-action="gamble-confirm">确认以小博大</button>
        </div>
      </section>
    `;
  }

  function settleButtonLabel() {
    const today = todayKey();
    if (state.settlementModes[today] === "gamble") return "已以小博大";
    if (state.settlementModes[today] === "automatic") return "已自动结算";
    if (state.settledDates[today]) return "已结算";
    if (state.settlement) return "结算中";
    if ((state.drawChancesByDate[today] || 0) > 0) return "先抽完今日机会";
    if (state.unsettledCards.length < 5) return "未满一手";
    return "进入结算";
  }

  function gambleButtonLabel() {
    const today = todayKey();
    if (state.settlementModes[today] === "gamble") return "今日已使用";
    if (state.settlementModes[today] === "automatic") return "已自动结算";
    if (state.settledDates[today]) return "今日已结算";
    if (state.gambleSelection) return "选择中";
    if ((state.drawChancesByDate[today] || 0) > 0) return "先抽完再博";
    if (state.unsettledCards.length < 5) return "至少需 5 张";
    return "以小博大";
  }

  function cardHtml(card, selected = false) {
    return `
      <button class="card ${cardColorClass(card)} ${card.joker ? "joker" : ""} ${selected ? "selected" : ""}" data-action="select-card" data-id="${card.drawId || ""}">
        ${cardFaceInner(card)}
      </button>
    `;
  }

  function cardColorClass(card) {
    if (card.suit === "H") return "heart";
    if (card.suit === "D") return "diamond";
    if (card.suit === "C") return "club";
    if (card.suit === "S") return "spade";
    return "";
  }

  function cardFaceInner(card) {
    const corner = card.joker ? card.mark : `${card.rankLabel}${card.mark}`;
    return `
      <span class="corner top">${corner}</span>
      <b class="pip">${card.joker ? card.rankLabel : card.mark}</b>
      <span class="corner bottom">${corner}</span>
    `;
  }

  function renderPoints() {
    const range = state.statsRange || 7;
    return `
      <section class="balance">
        <p>当前余额</p>
        <strong>${balanceOf()}</strong>
      </section>
      ${renderStats(range)}
      <section class="forms-two">
        <form data-action="add-expense" class="panel ledger-form">
          <h2>记录支出</h2>
          <input name="date" type="date" value="${todayKey()}" />
          <input name="amount" type="number" step="1" placeholder="金额" />
          <button type="submit">记一笔支出</button>
        </form>
        <form data-action="add-adjustment" class="panel ledger-form">
          <h2>初始化或调整</h2>
          <input name="date" type="date" value="${todayKey()}" />
          <input name="amount" type="number" step="1" placeholder="可为负数" />
          <button type="submit">调整余额</button>
        </form>
      </section>
      <section class="list">${state.ledger.map(ledgerRow).join("") || empty("暂无积分流水")}</section>
    `;
  }

  function renderStats(range) {
    const rows = statsForRange(range);
    const metric = state.statsMetric || "settlementScore";
    const incomeTotal = rows.reduce((sum, row) => sum + row.settlementScore, 0);
    const expenseTotal = rows.reduce((sum, row) => sum + row.expense, 0);
    const latestBalance = rows[rows.length - 1]?.balance || 0;
    return `
      <section class="panel stats-panel">
        <div class="section-head">
          <div>
            <h2>趋势统计</h2>
            <p>最近 ${range} 天</p>
          </div>
          <div class="segmented">
            <button class="${range === 7 ? "active" : ""}" data-action="stats-range" data-range="7">7天</button>
            <button class="${range === 30 ? "active" : ""}" data-action="stats-range" data-range="30">30天</button>
          </div>
        </div>
        <div class="metric-tabs">
          <button class="${metric === "settlementScore" ? "active" : ""}" data-action="stats-metric" data-metric="settlementScore">
            <span>结算得分</span><strong>${incomeTotal}</strong>
          </button>
          <button class="${metric === "balance" ? "active" : ""}" data-action="stats-metric" data-metric="balance">
            <span>现有积分</span><strong>${latestBalance}</strong>
          </button>
          <button class="${metric === "expense" ? "active" : ""}" data-action="stats-metric" data-metric="expense">
            <span>积分开销</span><strong>${expenseTotal}</strong>
          </button>
        </div>
        ${lineChartHtml(rows, metric)}
        ${statsPointDetail(rows, metric)}
      </section>
    `;
  }

  function lineChartHtml(rows, metric) {
    const width = 320;
    const height = 180;
    const pad = 24;
    const metricConfig = {
      settlementScore: { label: "结算得分", className: "income-line" },
      balance: { label: "现有积分", className: "balance-line" },
      expense: { label: "积分开销", className: "expense-line" }
    }[metric] || { label: "结算得分", className: "income-line" };
    const values = rows.map((row) => row[metric]);
    const rawMin = Math.min(...values);
    const rawMax = Math.max(...values);
    const min = rawMin < 0 ? rawMin : 0;
    const max = rawMax === min ? min + 1 : rawMax;
    const xFor = (index) => pad + (index * (width - pad * 2)) / Math.max(1, rows.length - 1);
    const yFor = (value) => height - pad - ((value - min) * (height - pad * 2)) / Math.max(1, max - min);
    const points = (key) => rows.map((row, index) => `${xFor(index).toFixed(1)},${yFor(row[key]).toFixed(1)}`).join(" ");
    const firstLabel = rows[0]?.date.slice(5) || "";
    const lastLabel = rows[rows.length - 1]?.date.slice(5) || "";
    const mid = (min + max) / 2;
    const showMidTick = Math.abs(max - min) > 1;
    const midLabel = formatAxisValue(mid);
    const latest = values[values.length - 1] || 0;
    const selectedDate = state.selectedStatsPoint?.metric === metric ? state.selectedStatsPoint.date : null;
    const pointNodes = rows
      .map((row, index) => {
        const x = xFor(index).toFixed(1);
        const y = yFor(row[metric]).toFixed(1);
        const selected = row.date === selectedDate;
        return `
          <circle class="chart-dot ${metricConfig.className} ${selected ? "selected" : ""}" cx="${x}" cy="${y}" r="${selected ? 4.5 : 3}"></circle>
          <circle class="chart-hit" cx="${x}" cy="${y}" r="10" data-action="stats-point" data-date="${row.date}" data-metric="${metric}"></circle>
        `;
      })
      .join("");
    return `
      <div class="chart-head">
        <span>${metricConfig.label}</span>
        <strong>${latest}</strong>
      </div>
      <svg class="line-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="最近${metricConfig.label}趋势折线图">
        <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${height - pad}" class="axis"></line>
        <line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}" class="axis"></line>
        ${showMidTick ? `<line x1="${pad}" y1="${yFor(mid).toFixed(1)}" x2="${width - pad}" y2="${yFor(mid).toFixed(1)}" class="grid-line"></line>` : ""}
        <text x="${pad}" y="16" class="chart-label">${formatAxisValue(max)}</text>
        ${showMidTick ? `<text x="${pad}" y="${yFor(mid).toFixed(1) - 4}" class="chart-label">${midLabel}</text>` : ""}
        <text x="${pad}" y="${height - pad - 4}" class="chart-label">${formatAxisValue(min)}</text>
        <text x="${pad}" y="${height - 6}" class="chart-label">${firstLabel}</text>
        <text x="${width - pad}" y="${height - 6}" class="chart-label end">${lastLabel}</text>
        <polyline class="chart-line ${metricConfig.className}" points="${points(metric)}"></polyline>
        ${pointNodes}
      </svg>
    `;
  }

  function formatAxisValue(value) {
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
  }

  function statsPointDetail(rows, metric) {
    const selected = state.selectedStatsPoint;
    if (!selected || selected.metric !== metric) {
      return `<p class="point-detail muted">点按折线上的圆点查看日期和数值</p>`;
    }
    const row = rows.find((item) => item.date === selected.date);
    if (!row) return `<p class="point-detail muted">点按折线上的圆点查看日期和数值</p>`;
    const labels = {
      settlementScore: "结算得分",
      balance: "现有积分",
      expense: "积分开销"
    };
    return `
      <div class="point-detail">
        <span>${row.date}</span>
        <strong>${labels[metric]}：${row[metric]}</strong>
      </div>
    `;
  }

  function ledgerRow(item) {
    return `
      <article class="ledger-row">
        <div><strong>${escapeHtml(item.label)}</strong><span>${item.date}</span></div>
        <b class="${item.amount >= 0 ? "plus" : "minus"}">${item.amount >= 0 ? "+" : ""}${item.amount}</b>
      </article>
    `;
  }

  function renderHistory() {
    const rows = Object.values(state.history).sort((a, b) => b.date.localeCompare(a.date));
    return `
      <section class="list history-list">
        ${rows.length ? rows.map(historyRow).join("") : empty("暂无历史记录")}
      </section>
    `;
  }

  function historyRow(entry) {
    return `
      <article class="history-row">
        <div class="section-head">
          <h2>${entry.date}</h2>
          <strong>余额 ${entry.balanceAfter}</strong>
        </div>
        <p>完成任务：${entry.tasks.length ? entry.tasks.map(escapeHtml).join("、") : "无"}</p>
        <p>抽牌 ${entry.draws || 0} 张 · 结算 ${entry.hands.length} 手</p>
        ${entry.automaticSettlement ? `<p class="automatic-history">00:30 自动结算：补抽 ${entry.automaticSettlement.drawn} 张 · 结算 ${entry.automaticSettlement.hands} 手</p>` : ""}
        ${entry.gamble ? `<p class="gamble-history">以小博大：保留 ${entry.gamble.kept} 张 · 弃牌 ${entry.gamble.discarded} 张</p>` : ""}
        <p>${entry.hands.map((handItem) => `${handItem.name} +${handItem.score}`).join("、") || "暂无牌局收入"}</p>
        <p>收入 +${entry.income || 0} · 支出 -${entry.expense || 0} · 净变化 ${entry.net || 0}</p>
      </article>
    `;
  }

  function renderSettings() {
    return `
      <dialog class="settings" open>
        <div class="section-head">
          <h2>设置</h2>
          <button data-action="close-settings">×</button>
        </div>
        ${scoreTableHtml()}
        <div class="settings-actions">
          <button data-action="export">导出备份</button>
          <button data-action="import">导入备份</button>
          <button class="danger" data-action="reset">重置数据</button>
        </div>
      </dialog>
    `;
  }

  function scoreTableHtml() {
    return `
      <table class="score-table">
        <thead><tr><th>牌型</th><th>分值</th></tr></thead>
        <tbody>${SCORE_TABLE.map(([name, score]) => `<tr><td>${name}</td><td>${score}</td></tr>`).join("")}</tbody>
      </table>
    `;
  }

  function stat(label, value) {
    return `<div class="stat"><span>${label}</span><strong>${value}</strong></div>`;
  }

  function empty(text) {
    return `<p class="empty">${text}</p>`;
  }

  function isMessageFresh() {
    return Boolean(state.lastMessage && state.lastMessageAt && Date.now() - state.lastMessageAt < 2600);
  }

  function isDrawAnimationFresh() {
    return Boolean(transientDrawnCard && Date.now() - transientDrawnAt < 900);
  }

  function scheduleToastClear() {
    clearTimeout(toastTimer);
    if (!isMessageFresh()) return;
    const remaining = Math.max(0, 2600 - (Date.now() - state.lastMessageAt));
    toastTimer = setTimeout(() => {
      state.lastMessage = "";
      state.lastMessageAt = 0;
      saveState();
      document.querySelector(".toast")?.remove();
    }, remaining);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
  }

  function bindEvents() {
    document.querySelectorAll("[data-tab]").forEach((button) => {
      button.addEventListener("click", () => setState((draft) => (draft.activeTab = button.dataset.tab)));
    });
    document.querySelectorAll("[data-action]").forEach((el) => {
      const action = el.dataset.action;
      if (action === "onboard") el.addEventListener("submit", onboard);
      if (action === "add-task") el.addEventListener("submit", addTask);
      if (action === "complete-task") el.addEventListener("click", () => completeTask(el.dataset.id));
      if (action === "undo-task") el.addEventListener("click", () => undoTask(el.dataset.id));
      if (action === "edit-task") el.addEventListener("click", () => editTask(el.dataset.id));
      if (action === "save-task-edit") el.addEventListener("submit", (event) => saveTaskEdit(event, el.dataset.id));
      if (action === "cancel-task-edit") el.addEventListener("click", cancelTaskEdit);
      if (action === "delete-task") el.addEventListener("click", () => deleteTask(el.dataset.id));
      if (action === "draw-one") el.addEventListener("click", drawOne);
      if (action === "draw-all") el.addEventListener("click", drawAll);
      if (action === "toggle-sort") el.addEventListener("click", () => setState((draft) => (draft.sortCards = !draft.sortCards)));
      if (action === "settle-start") el.addEventListener("click", startSettlement);
      if (action === "settle-confirm") el.addEventListener("click", settleSelected);
      if (action === "gamble-start") el.addEventListener("click", startGamble);
      if (action === "gamble-cancel") el.addEventListener("click", cancelGamble);
      if (action === "gamble-confirm") el.addEventListener("click", confirmGamble);
      if (action === "select-card") el.addEventListener("click", () => toggleSelectedCard(el.dataset.id));
      if (action === "add-expense") el.addEventListener("submit", (event) => addLedger(event, "expense"));
      if (action === "add-adjustment") el.addEventListener("submit", (event) => addLedger(event, "adjustment"));
      if (action === "stats-range") el.addEventListener("click", () => setState((draft) => (draft.statsRange = Number(el.dataset.range))));
      if (action === "stats-metric") {
        el.addEventListener("click", () =>
          setState((draft) => {
            draft.statsMetric = el.dataset.metric;
            draft.selectedStatsPoint = null;
          })
        );
      }
      if (action === "stats-point") {
        el.addEventListener("click", () =>
          setState((draft) => {
            draft.selectedStatsPoint = { date: el.dataset.date, metric: el.dataset.metric };
          })
        );
      }
      if (action === "settings") el.addEventListener("click", openSettings);
      if (action === "close-settings") el.addEventListener("click", closeSettings);
      if (action === "export") el.addEventListener("click", exportBackup);
      if (action === "import") el.addEventListener("click", () => backupInput.click());
      if (action === "reset") el.addEventListener("click", resetData);
    });
  }

  function toggleSelectedCard(drawId) {
    if (!drawId) return;
    setState((draft) => {
      const selection = draft.gambleSelection || draft.settlement;
      if (!selection) return;
      const maxCards = draft.gambleSelection ? 4 : 5;
      const selected = selection.selectedIds;
      if (selected.includes(drawId)) {
        selection.selectedIds = selected.filter((id) => id !== drawId);
      } else if (selected.length < maxCards) {
        selected.push(drawId);
      }
    });
  }

  function openSettings() {
    if (document.querySelector(".settings")) return;
    app.insertAdjacentHTML("beforeend", renderSettings());
    bindSettingsEvents();
  }

  function closeSettings() {
    document.querySelector(".settings")?.remove();
  }

  function bindSettingsEvents() {
    document.querySelectorAll(".settings [data-action]").forEach((el) => {
      const action = el.dataset.action;
      if (action === "close-settings") el.addEventListener("click", closeSettings);
      if (action === "export") el.addEventListener("click", exportBackup);
      if (action === "import") el.addEventListener("click", () => backupInput.click());
      if (action === "reset") el.addEventListener("click", resetData);
    });
  }

  backupInput.addEventListener("change", (event) => importBackup(event.target.files[0]));

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
  }

  function checkDayBoundary() {
    if (state.lastRolloverDate === todayKey()) return;
    if (reconcileMissedDays()) render();
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) checkDayBoundary();
  });
  window.setInterval(checkDayBoundary, 60 * 1000);

  render();
})();
