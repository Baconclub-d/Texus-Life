(function () {
  "use strict";

  const STORAGE_KEY = "pokerlife:pwa-mvp:v1";

  function defaultState() {
    return {
      onboarded: false,
      activeTab: "tasks",
      tasks: [],
      unsettledCards: [],
      drawChancesByDate: {},
      drawsByDate: {},
      settledDates: {},
      ledger: [],
      history: {},
      lastMessage: "",
      lastDrawnCard: null,
      sortCards: false,
      settlement: null,
      gambleSelection: null,
      settlementModes: {},
      editingTaskId: null,
      statsRange: 7,
      statsMetric: "settlementScore",
      selectedStatsPoint: null,
      lastRolloverDate: null
    };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? { ...defaultState(), ...JSON.parse(raw) } : defaultState();
    } catch {
      return defaultState();
    }
  }

  function saveState(state) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function restoreState(data, message) {
    return { ...defaultState(), ...data, lastMessage: message || "" };
  }

  window.PokerLifeStorage = { defaultState, loadState, restoreState, saveState };
})();
