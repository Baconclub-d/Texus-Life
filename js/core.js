(function () {
  "use strict";

  const DAY_BOUNDARY_MINUTES = 30;
  const SUITS = [
    { id: "S", label: "黑桃", mark: "♠", order: 1 },
    { id: "H", label: "红桃", mark: "♥", order: 2 },
    { id: "C", label: "梅花", mark: "♣", order: 3 },
    { id: "D", label: "方片", mark: "♦", order: 4 }
  ];
  const RANKS = [
    { id: "A", label: "A", value: 14 },
    { id: "K", label: "K", value: 13 },
    { id: "Q", label: "Q", value: 12 },
    { id: "J", label: "J", value: 11 },
    { id: "10", label: "10", value: 10 },
    { id: "9", label: "9", value: 9 },
    { id: "8", label: "8", value: 8 },
    { id: "7", label: "7", value: 7 },
    { id: "6", label: "6", value: 6 },
    { id: "5", label: "5", value: 5 },
    { id: "4", label: "4", value: 4 },
    { id: "3", label: "3", value: 3 },
    { id: "2", label: "2", value: 2 }
  ];
  const SCORE_TABLE = [
    ["皇家同花顺", 160],
    ["同花顺", 140],
    ["四条", 115],
    ["葫芦", 75],
    ["同花", 45],
    ["顺子", 35],
    ["三条", 20],
    ["两对", 10],
    ["一对", 4],
    ["高牌", 1]
  ];

  function localDateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function usageDateKey(date) {
    return localDateKey(new Date(date.getTime() - DAY_BOUNDARY_MINUTES * 60 * 1000));
  }

  function todayKey() {
    return usageDateKey(new Date());
  }

  function addDaysKey(dateKey, days) {
    const [year, month, day] = dateKey.split("-").map(Number);
    const date = new Date(year, month - 1, day, 12);
    date.setDate(date.getDate() + days);
    return localDateKey(date);
  }

  function uid(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function deck() {
    const cards = [];
    SUITS.forEach((suit) => {
      RANKS.forEach((rank) => {
        cards.push({
          id: `${suit.id}${rank.id}`,
          suit: suit.id,
          suitLabel: suit.label,
          mark: suit.mark,
          rank: rank.id,
          rankLabel: rank.label,
          value: rank.value,
          joker: false
        });
      });
    });
    cards.push({ id: "BJ", rankLabel: "大王", mark: "★", value: 0, joker: true });
    cards.push({ id: "RJ", rankLabel: "小王", mark: "☆", value: 0, joker: true });
    return cards;
  }

  function availableDeck(cards) {
    const blocked = new Set(cards.map((card) => card.id));
    return deck().filter((card) => !blocked.has(card.id));
  }

  function cloneCard(card) {
    return { ...card, drawId: uid("draw"), drawnAt: new Date().toISOString() };
  }

  function cardName(card) {
    return card.joker ? card.rankLabel : `${card.mark}${card.rankLabel}`;
  }

  function sortedCards(cards) {
    return [...cards].sort((a, b) => {
      if (a.joker && !b.joker) return -1;
      if (!a.joker && b.joker) return 1;
      const suitA = SUITS.find((suit) => suit.id === a.suit)?.order || 0;
      const suitB = SUITS.find((suit) => suit.id === b.suit)?.order || 0;
      return suitA - suitB || b.value - a.value;
    });
  }

  function evaluateHand(cards, contextCards) {
    const jokers = cards.filter((card) => card.joker);
    if (!jokers.length) return scoreNormal(cards);
    const fixed = cards.filter((card) => !card.joker);
    const blocked = new Set((contextCards || cards).filter((card) => !card.joker).map((card) => card.id));
    fixed.forEach((card) => blocked.delete(card.id));
    const options = deck().filter((card) => !card.joker && !blocked.has(card.id));
    let best = null;

    function walk(index, picked, used) {
      if (index === jokers.length) {
        const result = scoreNormal([...fixed, ...picked]);
        if (!best || result.score > best.score || (result.score === best.score && result.rankValue > best.rankValue)) {
          best = { ...result, substitutions: picked.map(cardName) };
        }
        return;
      }
      options.forEach((option) => {
        if (used.has(option.id)) return;
        used.add(option.id);
        walk(index + 1, [...picked, option], used);
        used.delete(option.id);
      });
    }

    walk(0, [], new Set(fixed.map((card) => card.id)));
    return best || { name: "高牌", score: 1, rankValue: 0, substitutions: [] };
  }

  function scoreNormal(cards) {
    const values = cards.map((card) => card.value).sort((a, b) => b - a);
    const suits = cards.map((card) => card.suit);
    const counts = values.reduce((acc, value) => ((acc[value] = (acc[value] || 0) + 1), acc), {});
    const groups = Object.entries(counts)
      .map(([value, count]) => ({ value: Number(value), count }))
      .sort((a, b) => b.count - a.count || b.value - a.value);
    const flush = suits.every((suit) => suit === suits[0]);
    const unique = [...new Set(values)].sort((a, b) => b - a);
    const wheel = unique.join(",") === "14,5,4,3,2";
    const straight = unique.length === 5 && (unique[0] - unique[4] === 4 || wheel);
    const straightHigh = wheel ? 5 : unique[0];

    if (flush && straight && straightHigh === 14) return hand("皇家同花顺", straightHigh);
    if (flush && straight) return hand("同花顺", straightHigh);
    if (groups[0].count === 4) return hand("四条", groups[0].value);
    if (groups[0].count === 3 && groups[1].count === 2) return hand("葫芦", groups[0].value);
    if (flush) return hand("同花", values[0]);
    if (straight) return hand("顺子", straightHigh);
    if (groups[0].count === 3) return hand("三条", groups[0].value);
    if (groups[0].count === 2 && groups[1].count === 2) return hand("两对", Math.max(groups[0].value, groups[1].value));
    if (groups[0].count === 2) return hand("一对", groups[0].value);
    return hand("高牌", values[0]);
  }

  function hand(name, rankValue) {
    const row = SCORE_TABLE.find(([label]) => label === name);
    return { name, score: row ? row[1] : 0, rankValue, substitutions: [] };
  }

  function combinations(cards, size) {
    const result = [];
    function walk(start, chosen) {
      if (chosen.length === size) {
        result.push(chosen);
        return;
      }
      for (let i = start; i <= cards.length - (size - chosen.length); i += 1) {
        walk(i + 1, [...chosen, cards[i]]);
      }
    }
    walk(0, []);
    return result;
  }

  function recommendHand(cards) {
    return combinations(cards, 5).reduce((best, combo) => {
      const result = evaluateHand(combo, cards);
      if (!best || result.score > best.result.score || (result.score === best.result.score && result.rankValue > best.result.rankValue)) {
        return { cards: combo, result };
      }
      return best;
    }, null);
  }

  window.PokerLifeCore = {
    SCORE_TABLE,
    SUITS,
    addDaysKey,
    availableDeck,
    cardName,
    cloneCard,
    evaluateHand,
    recommendHand,
    sortedCards,
    todayKey,
    uid,
    usageDateKey
  };
})();
