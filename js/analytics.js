(function () {
  "use strict";

  function balanceOf(state) {
    return state.ledger.reduce((sum, item) => sum + item.amount, 0);
  }

  function dateRange(days, todayKey, addDaysKey) {
    const end = todayKey();
    const dates = [];
    for (let i = days - 1; i >= 0; i -= 1) {
      dates.push(addDaysKey(end, -i));
    }
    return dates;
  }

  function statsForRange(state, days, todayKey, addDaysKey) {
    return dateRange(days, todayKey, addDaysKey).map((date) => {
      const dayItems = state.ledger.filter((item) => item.date === date);
      const settlementScore = dayItems
        .filter((item) => item.type === "income")
        .reduce((sum, item) => sum + item.amount, 0);
      const expense = Math.abs(
        dayItems
          .filter((item) => item.type === "expense")
          .reduce((sum, item) => sum + item.amount, 0)
      );
      const balance = state.ledger
        .filter((item) => item.date <= date)
        .reduce((sum, item) => sum + item.amount, 0);
      return { date, settlementScore, expense, balance };
    });
  }

  window.PokerLifeAnalytics = { balanceOf, statsForRange };
})();
