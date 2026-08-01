(function () {
  "use strict";

  const TextRules = window.YourssuTextRules;

  const COLORS = ["#2B2D6E", "#8B7CE8", "#C99410"];
  const GRID = { width: 1160, height: 460, gapX: 24, gapY: 18 };
  const SECTION_CONFIG = [
    { key: "continueTexts", section: "Continue", title: "\uB3D9\uB8CC\uAC00 \uBC14\uB77C\uBCF8 \uB098\uC758 \uAC15\uC810", bracket: "CONTINUE", icon: "\u201D" },
    { key: "improveTexts", section: "Improve/Start", title: "\uB354 \uB098\uC740 \uC131\uC7A5\uC744 \uC704\uD55C \uC81C\uC5B8", bracket: "IMPROVE/START", icon: "\u2191" },
    { key: "messageTexts", section: "Message", title: "\uB3D9\uB8CC\uB4E4\uC774 \uC804\uD558\uB294 \uD55C \uB9C8\uB514", bracket: "MESSAGE", icon: "\u2665" }
  ];

  const state = {
    nextCardId: 1,
    measureRoot: null,
    measureCache: new Map(),
    pages: [],
    validation: { ok: false, errors: [], warnings: [], pageCount: 0, fontReady: false }
  };

  function cleanText(value) {
    return TextRules.cleanText(value);
  }

  function semanticKey(value) {
    return TextRules.semanticKey(value);
  }

  function hasSemanticContent(value) {
    return TextRules.hasSemanticContent(value);
  }

  function legacyIsMeaningless(value, sectionKey) {
    const text = cleanText(value);
    if (!text || !hasSemanticContent(text)) return true;
    const key = semanticKey(text);
    const exact = new Set([
      "없음", "없습니다", "없어요", "없다", "딱히없음", "딱히없습니다",
      "별다른내용없음", "별다른내용없습니다", "특별히없음", "특별히없습니다",
      "생각나는게없음", "생각나는것이없음", "모름", "모르겠습니다",
      "답변어려움", "답변하기어려움", "판단어려움", "잘모르겠음",
      "크게없음", "딱히생각나지않음", "개선점없음", "해당없음",
      "없을것같아요", "없을것같습니다", "없는것같아요", "없는것같습니다",
      "없다고생각합니다", "잘하고있습니다", "잘모르겠어요", "생각나지않아요",
      "생각나는것없음", "특별히생각나는것없음", "특별히생각나는게없음",
      "별로없어요", "크게없어요", "딱히없어요", "아직은없음", "아직은없습니다"
    ]);
    if (exact.has(key) || /^(x|xx|xxx|na|none|null)$/i.test(key)) return true;
    if (key.length <= 28 && /^(딱히|별로|별다른|특별히|크게)?(생각나는|떠오르는)?(내용|부분|개선점|단점|약점|의견)?(이)?(없|모르)/.test(key)) return true;
    if (key.length <= 36 && /(답변|판단|평가|말씀).*(어렵|힘듦|불가)$/.test(key)) return true;
    if (key.length <= 90 && /^(함께|같이)?.{0,18}(프로젝트|협업|업무).{0,24}(경험|진행).{0,16}(없|못).{0,24}(판단|답변|말씀|모르|어렵)/.test(key)) return true;
    if (key.length <= 90 && /(판단할만큼|평가할만큼).{0,20}(업무|협업|프로젝트)?경험.{0,12}(없|부족)/.test(key)) return true;
    if (key.length <= 100 && /(잘알지못|아직잘모르).{0,30}(답변|판단|평가|말씀).{0,16}(어렵|못)/.test(key)) return true;
    if (sectionKey === "improveTexts") {
      if (key.length <= 90 && /^(지금|현재|아직)?(도|은|는)?(충분히)?잘(하고|해주고).*(개선|추가|보완).*(없|모르|못찾)/.test(key)) return true;
      if (key.length <= 105 && /(특별히|딱히|크게)?.{0,12}(개선|보완).{0,20}(필요|지점|부분).{0,20}(못찾|발견하지못|느끼지못|보이지않|없)/.test(key)) return true;
      if (key.length <= 105 && /아직.{0,20}(협업|프로젝트|업무).{0,24}(해보지못|하지못|경험이없).{0,24}(개선|답변|판단|말씀)/.test(key)) return true;
    }
    return false;
  }

  function isMeaningless(value, sectionKey) {
    return TextRules.isMeaningless(value, sectionKey);
  }

  function textLength(value) {
    return Array.from(cleanText(value)).length;
  }

  function makeCards(texts, section) {
    return (Array.isArray(texts) ? texts : [])
      .map(function (value, index) {
        return { value: cleanText(value), sourceIndex: index };
      })
      .filter(function (entry) { return !isMeaningless(entry.value, section.key); })
      .map(function (entry, visibleIndex) {
        return {
          id: state.nextCardId++,
          sourceIndex: entry.sourceIndex,
          visibleIndex: visibleIndex,
          fragment: 1,
          text: entry.value,
          color: COLORS[visibleIndex % COLORS.length],
          icon: section.icon,
          sectionKey: section.key
        };
      });
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[ch];
    });
  }

  function cardInnerHtml(card) {
    const continuation = card.fragment > 1 ? " <small>\u00B7 \uACC4\uC18D</small>" : "";
    return `<h3 data-check-overflow>\uC775\uBA85\uC758 \uB3D9\uB8CC${continuation}</h3>
      <span class="comment-icon" aria-hidden="true">${escapeHtml(card.icon)}</span>
      <p class="comment-body" data-check-overflow>${escapeHtml(card.text)}</p>`;
  }

  function ensureMeasureRoot() {
    if (state.measureRoot) return state.measureRoot;
    const root = document.createElement("div");
    root.className = "comment-measure-root";
    root.setAttribute("aria-hidden", "true");
    document.body.appendChild(root);
    state.measureRoot = root;
    return root;
  }

  function measureCard(card, width) {
    const roundedWidth = Math.max(120, Math.round(width));
    const cacheKey = `${roundedWidth}|${card.fragment}|${card.text}`;
    if (state.measureCache.has(cacheKey)) return state.measureCache.get(cacheKey);
    const element = document.createElement("article");
    element.className = "comment-card comment-card-measure";
    element.style.setProperty("--card-color", card.color);
    element.style.width = `${roundedWidth}px`;
    element.innerHTML = cardInnerHtml(card);
    ensureMeasureRoot().appendChild(element);
    // The rendered card uses border-box sizing and a 10px top accent border.
    // scrollHeight excludes those borders, which made every placed card about
    // 9px too short. Measure the real outer border box instead.
    const height = Math.ceil(element.getBoundingClientRect().height + 1);
    element.remove();
    state.measureCache.set(cacheKey, height);
    return height;
  }

  function splitBoundaries(text) {
    const boundaries = [];
    Array.from(text).forEach(function (ch, index) {
      if (/\s/.test(ch) || /[.!?\u3002\uFF01\uFF1F]/.test(ch)) boundaries.push(index + 1);
    });
    if (!boundaries.length || boundaries[boundaries.length - 1] !== text.length) boundaries.push(text.length);
    return boundaries;
  }

  function largestFittingText(card, width, maxHeight) {
    const boundaries = splitBoundaries(card.text);
    let low = 0;
    let high = boundaries.length - 1;
    let best = -1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candidateText = card.text.slice(0, boundaries[mid]).trim();
      const probe = Object.assign({}, card, { text: candidateText });
      if (candidateText && measureCard(probe, width) <= maxHeight) {
        best = boundaries[mid];
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    if (best > 0 && best < card.text.length) return best;
    let charLow = 1;
    let charHigh = Math.max(1, card.text.length - 1);
    let charBest = 0;
    while (charLow <= charHigh) {
      const mid = Math.floor((charLow + charHigh) / 2);
      const probe = Object.assign({}, card, { text: card.text.slice(0, mid).trim() });
      if (probe.text && measureCard(probe, width) <= maxHeight) {
        charBest = mid;
        charLow = mid + 1;
      } else {
        charHigh = mid - 1;
      }
    }
    return charBest;
  }

  function rebalanceSplitPoint(card, width, maxHeight, initialSplit) {
    const totalLength = textLength(card.text);
    const minimumTailLength = Math.min(220, Math.max(120, Math.floor(totalLength * 0.28)));
    const initialTail = cleanText(card.text.slice(initialSplit));
    if (textLength(initialTail) >= minimumTailLength) return initialSplit;

    const candidates = splitBoundaries(card.text).filter(function (boundary) {
      return boundary < initialSplit;
    }).reverse();
    for (let index = 0; index < candidates.length; index += 1) {
      const boundary = candidates[index];
      const head = cleanText(card.text.slice(0, boundary));
      const tail = cleanText(card.text.slice(boundary));
      if (textLength(tail) < minimumTailLength || !head) continue;
      if (measureCard(Object.assign({}, card, { text: head }), width) <= maxHeight) return boundary;
    }
    return initialSplit;
  }

  function splitOversizedCards(cards) {
    const result = [];
    cards.forEach(function (source) {
      let current = Object.assign({}, source);
      let guard = 0;
      while (measureCard(current, GRID.width) > GRID.height && guard < 40) {
        const initialSplit = largestFittingText(current, GRID.width, GRID.height);
        const splitAt = rebalanceSplitPoint(current, GRID.width, GRID.height, initialSplit);
        if (splitAt <= 0 || splitAt >= current.text.length) {
          throw new Error(`Cannot split feedback safely: source ${source.sourceIndex + 1}`);
        }
        const first = Object.assign({}, current, { text: current.text.slice(0, splitAt).trim() });
        if (!isMeaningless(first.text, first.sectionKey)) result.push(first);
        current = Object.assign({}, current, {
          id: state.nextCardId++,
          fragment: current.fragment + 1,
          text: current.text.slice(splitAt).trim()
        });
        guard += 1;
      }
      if (guard >= 40) throw new Error(`Feedback split limit exceeded: source ${source.sourceIndex + 1}`);
      if (!isMeaningless(current.text, current.sectionKey)) result.push(current);
    });
    return result;
  }

  function makePlacement(card, x, y, width, height) {
    return { card: card, x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
  }

  const MIN_CARD_HEIGHT = 126;

  function naturalCardHeight(card, width) {
    return Math.max(MIN_CARD_HEIGHT, measureCard(card, width));
  }

  function finalizeCandidate(name, placements, penalty) {
    if (!placements.length) return null;
    const bottom = Math.max.apply(null, placements.map(function (item) { return item.y + item.height; }));
    if (bottom > GRID.height + 0.5) return null;
    let contentArea = 0;
    let blankArea = 0;
    const naturalHeights = [];
    for (let index = 0; index < placements.length; index += 1) {
      const item = placements[index];
      const naturalHeight = naturalCardHeight(item.card, item.width);
      if (naturalHeight > item.height + 1) return null;
      naturalHeights.push(naturalHeight);
      contentArea += item.width * naturalHeight;
      blankArea += item.width * Math.max(0, item.height - naturalHeight);
    }
    const verticalWaste = Math.max(0, GRID.height - bottom) * GRID.width;
    const occupiedArea = placements.reduce(function (sum, item) {
      return sum + item.width * item.height;
    }, 0);
    const pageWaste = Math.max(0, GRID.width * GRID.height - occupiedArea);
    const centeredOffset = Math.max(0, Math.floor((GRID.height - bottom) / 2));
    placements.forEach(function (item) { item.y += centeredOffset; });
    return {
      name: name,
      cards: placements.map(function (item) { return item.card; }),
      placements: placements,
      usedArea: contentArea,
      blankArea: blankArea,
      score: -(blankArea * 2.2 + pageWaste * 0.025 + verticalWaste * 0.01 + (penalty || 0))
    };
  }

  function rowsCandidate(cards, rowCounts, name, penalty) {
    let index = 0;
    let y = 0;
    const placements = [];
    for (let rowIndex = 0; rowIndex < rowCounts.length; rowIndex += 1) {
      const count = rowCounts[rowIndex];
      const width = (GRID.width - GRID.gapX * (count - 1)) / count;
      const rowCards = cards.slice(index, index + count);
      if (rowCards.length !== count) return null;
      const heights = rowCards.map(function (card) { return naturalCardHeight(card, width); });
      const rowHeight = Math.max.apply(null, heights);
      if (rowHeight > GRID.height) return null;
      rowCards.forEach(function (card, cardIndex) {
        placements.push(makePlacement(card, cardIndex * (width + GRID.gapX), y, width, heights[cardIndex]));
      });
      y += rowHeight + (rowIndex < rowCounts.length - 1 ? GRID.gapY : 0);
      index += count;
    }
    return finalizeCandidate(name, placements, penalty);
  }

  function columnsStackCandidate(cards, columnCount, name, penalty, mode) {
    if (columnCount < 1 || cards.length < columnCount) return null;
    const width = (GRID.width - GRID.gapX * (columnCount - 1)) / columnCount;
    const columns = Array.from({ length: columnCount }, function () { return []; });
    const heights = Array(columnCount).fill(0);

    cards.forEach(function (card, index) {
      let columnIndex = index % columnCount;
      if (mode === "balanced") {
        columnIndex = heights.indexOf(Math.min.apply(null, heights));
      }
      const height = naturalCardHeight(card, width);
      columns[columnIndex].push({ card: card, height: height });
      heights[columnIndex] += height + (columns[columnIndex].length > 1 ? GRID.gapY : 0);
    });

    if (Math.max.apply(null, heights) > GRID.height) return null;
    const placements = [];
    columns.forEach(function (column, columnIndex) {
      let y = 0;
      column.forEach(function (entry, entryIndex) {
        placements.push(makePlacement(entry.card, columnIndex * (width + GRID.gapX), y, width, entry.height));
        y += entry.height + (entryIndex < column.length - 1 ? GRID.gapY : 0);
      });
    });
    return finalizeCandidate(name, placements, penalty);
  }

  function longLeftStackCandidate(cards, name, penalty) {
    if (cards.length < 3) return null;
    const leftWidth = Math.round(GRID.width * 0.61);
    const rightWidth = GRID.width - leftWidth - GRID.gapX;
    const leftCard = cards[0];
    const rightCards = cards.slice(1);
    const leftHeight = naturalCardHeight(leftCard, leftWidth);
    const rightHeights = rightCards.map(function (card) { return naturalCardHeight(card, rightWidth); });
    const rightTotal = rightHeights.reduce(function (sum, height) { return sum + height; }, 0) + GRID.gapY * (rightCards.length - 1);
    const total = Math.max(leftHeight, rightTotal);
    if (total > GRID.height) return null;
    const placements = [makePlacement(leftCard, 0, 0, leftWidth, leftHeight)];
    let y = 0;
    rightCards.forEach(function (card, index) {
      placements.push(makePlacement(card, leftWidth + GRID.gapX, y, rightWidth, rightHeights[index]));
      y += rightHeights[index] + GRID.gapY;
    });
    return finalizeCandidate(name, placements, penalty);
  }

  function fullTopCandidate(cards, bottomCount, name, penalty) {
    if (cards.length !== bottomCount + 1) return null;
    const topCard = cards[0];
    const topHeight = naturalCardHeight(topCard, GRID.width);
    const bottomWidth = (GRID.width - GRID.gapX * (bottomCount - 1)) / bottomCount;
    const bottomCards = cards.slice(1);
    const bottomHeights = bottomCards.map(function (card) { return naturalCardHeight(card, bottomWidth); });
    const bottomHeight = Math.max.apply(null, bottomHeights);
    if (topHeight + GRID.gapY + bottomHeight > GRID.height) return null;
    const placements = [makePlacement(topCard, 0, 0, GRID.width, topHeight)];
    bottomCards.forEach(function (card, index) {
      placements.push(makePlacement(card, index * (bottomWidth + GRID.gapX), topHeight + GRID.gapY, bottomWidth, bottomHeights[index]));
    });
    return finalizeCandidate(name, placements, penalty);
  }

  function candidateLayouts(cards) {
    const count = cards.length;
    const candidates = [];
    function add(value) { if (value) candidates.push(value); }
    if (count === 1) add(rowsCandidate(cards, [1], "single", 0));
    if (count === 2) {
      add(rowsCandidate(cards, [2], "columns-2", 0));
      add(columnsStackCandidate(cards, 1, "stack-2", 800, "sequential"));
    }
    if (count === 3) {
      add(rowsCandidate(cards, [3], "columns-3", 0));
      add(columnsStackCandidate(cards, 2, "stacked-columns-2", 500, "balanced"));
      add(longLeftStackCandidate(cards, "long-left-stack-2", 900));
      add(fullTopCandidate(cards, 2, "full-top-2", 1400));
    }
    if (count === 4) {
      add(rowsCandidate(cards, [2, 2], "grid-4", 0));
      add(columnsStackCandidate(cards, 2, "stacked-columns-2", 350, "balanced"));
      add(columnsStackCandidate(cards, 3, "stacked-columns-3", 700, "balanced"));
      add(longLeftStackCandidate(cards, "long-left-stack-3", 1000));
      add(fullTopCandidate(cards, 3, "full-top-3", 1500));
    }
    if (count === 5) {
      add(rowsCandidate(cards, [3, 2], "rows-3-2", 0));
      add(rowsCandidate(cards, [2, 3], "rows-2-3", 250));
      add(columnsStackCandidate(cards, 3, "stacked-columns-3", 350, "balanced"));
      add(columnsStackCandidate(cards, 2, "stacked-columns-2", 900, "balanced"));
      add(longLeftStackCandidate(cards, "long-left-stack-4", 1200));
    }
    if (count === 6) {
      add(rowsCandidate(cards, [3, 3], "grid-6", 0));
      add(columnsStackCandidate(cards, 3, "stacked-columns-3", 300, "balanced"));
      add(columnsStackCandidate(cards, 2, "stacked-columns-2", 1000, "balanced"));
    }
    return candidates.sort(function (a, b) { return b.score - a.score; });
  }

  function uniqueSelections(cards, count) {
    const results = [];
    const keys = new Set();
    function add(selection) {
      if (selection.length !== count) return;
      const key = selection.map(function (card) { return card.id; }).sort(function (a, b) { return a - b; }).join("/");
      if (!keys.has(key)) { keys.add(key); results.push(selection); }
    }
    add(cards.slice(0, count));
    add(cards.slice(-count));
    if (count > 1) add([cards[0]].concat(cards.slice(-(count - 1))));
    if (count > 2) add(cards.slice(0, Math.ceil(count / 2)).concat(cards.slice(-Math.floor(count / 2))));

    for (let start = 0; start + count <= cards.length; start += 1) add(cards.slice(start, start + count));

    const pool = [];
    const poolIds = new Set();
    cards.slice(0, 8).concat(cards.slice(-8)).forEach(function (card) {
      if (!poolIds.has(card.id)) { poolIds.add(card.id); pool.push(card); }
    });
    const selection = [];
    const combinationLimit = 480;
    function choose(start) {
      if (results.length >= combinationLimit) return;
      if (selection.length === count) { add(selection.slice()); return; }
      const needed = count - selection.length;
      for (let index = start; index <= pool.length - needed; index += 1) {
        selection.push(pool[index]);
        choose(index + 1);
        selection.pop();
        if (results.length >= combinationLimit) return;
      }
    }
    choose(0);
    return results;
  }

  function pageCountOrder(total) {
    const limit = Math.min(6, total);
    const preferred = {
      1: [1],
      2: [2, 1],
      3: [3, 2, 1],
      4: [4, 3, 2, 1],
      5: [5, 4, 3, 2, 1],
      6: [6, 5, 4, 3, 2, 1],
      7: [4, 3, 5, 6, 2, 1],
      8: [4, 5, 3, 6, 2, 1],
      9: [5, 4, 6, 3, 2, 1],
      10: [5, 6, 4, 3, 2, 1],
      11: [6, 5, 4, 3, 2, 1]
    };
    if (preferred[total]) return preferred[total].filter(function (count) { return count <= limit; });
    return Array.from({ length: limit }, function (_, index) { return limit - index; });
  }

  function orderedSelectionVariants(selection) {
    const variants = [];
    const keys = new Set();
    function add(cards) {
      const key = cards.map(function (card) { return card.id; }).join("/");
      if (!keys.has(key)) { keys.add(key); variants.push(cards); }
    }
    add(selection.slice().sort(function (a, b) {
      return measureCard(b, GRID.width) - measureCard(a, GRID.width) || a.sourceIndex - b.sourceIndex || a.fragment - b.fragment;
    }));
    add(selection.slice().sort(function (a, b) {
      return a.sourceIndex - b.sourceIndex || a.fragment - b.fragment;
    }));
    add(selection.slice().sort(function (a, b) {
      return measureCard(a, GRID.width) - measureCard(b, GRID.width) || a.sourceIndex - b.sourceIndex || a.fragment - b.fragment;
    }));
    return variants;
  }

  function pageOptions(remaining) {
    const options = [];
    const optionKeys = new Set();
    pageCountOrder(remaining.length).forEach(function (count) {
      const perCount = [];
      uniqueSelections(remaining, count).forEach(function (selection) {
        orderedSelectionVariants(selection).forEach(function (ordered) {
          candidateLayouts(ordered).slice(0, 2).forEach(function (layout) {
            const key = `${layout.name}|${layout.cards.map(function (card) { return card.id; }).join("/")}`;
            if (!optionKeys.has(key)) {
              optionKeys.add(key);
              perCount.push(layout);
            }
          });
        });
      });
      perCount.sort(function (a, b) { return b.score - a.score; });
      perCount.slice(0, 4).forEach(function (layout) { options.push(layout); });
    });
    return options;
  }

  function remainingAfterPage(remaining, page) {
    const used = new Set(page.cards.map(function (card) { return card.id; }));
    return remaining.filter(function (card) { return !used.has(card.id); });
  }

  function pageVisualCost(page) {
    let cost = -page.score;
    if (page.cards.length === 1) {
      const length = textLength(page.cards[0].text);
      cost += length <= 140 ? 240000000 : (length <= 260 ? 50000000 : 0);
    }
    return cost;
  }

  function projectedPlanCost(state) {
    const remainingCount = state.remaining.length;
    const minimumFuturePages = Math.ceil(remainingCount / 6);
    let cost = state.visualCost + minimumFuturePages * 1000000000;
    if (remainingCount === 1) cost += 300000000;
    else if (remainingCount > 6 && remainingCount % 6 === 1) cost += 80000000;
    if (minimumFuturePages === 1 && state.pages.length) {
      const previousCount = state.pages[state.pages.length - 1].cards.length;
      cost += Math.abs(previousCount - remainingCount) * 6000000;
    }
    return cost;
  }

  function completedPlanCost(state) {
    const counts = state.pages.map(function (page) { return page.cards.length; });
    const maximum = Math.max.apply(Math, counts);
    const minimum = Math.min.apply(Math, counts);
    const imbalance = maximum - minimum;
    return state.visualCost + imbalance * 120000000;
  }

  function stateKey(state) {
    return state.remaining.map(function (card) { return card.id; }).sort(function (a, b) { return a - b; }).join("/");
  }

  function planPagination(cards) {
    const initial = cards.slice().sort(function (a, b) {
      return measureCard(b, GRID.width) - measureCard(a, GRID.width) || a.sourceIndex - b.sourceIndex || a.fragment - b.fragment;
    });
    let beam = [{ remaining: initial, pages: [], visualCost: 0 }];
    const beamWidth = initial.length > 24 ? 28 : 44;

    for (let depth = 0; depth < initial.length; depth += 1) {
      const completed = [];
      const nextByKey = new Map();
      beam.forEach(function (state) {
        pageOptions(state.remaining).forEach(function (page) {
          const nextState = {
            remaining: remainingAfterPage(state.remaining, page),
            pages: state.pages.concat(page),
            visualCost: state.visualCost + pageVisualCost(page)
          };
          if (!nextState.remaining.length) {
            completed.push(nextState);
            return;
          }
          const key = stateKey(nextState);
          const existing = nextByKey.get(key);
          if (!existing || projectedPlanCost(nextState) < projectedPlanCost(existing)) nextByKey.set(key, nextState);
        });
      });

      if (completed.length) {
        completed.sort(function (a, b) { return completedPlanCost(a) - completedPlanCost(b); });
        return completed[0].pages;
      }

      beam = Array.from(nextByKey.values()).sort(function (a, b) {
        return projectedPlanCost(a) - projectedPlanCost(b);
      }).slice(0, beamWidth);
      if (!beam.length) break;
    }
    throw new Error("No safe global card layout plan could be selected.");
  }

  function paginate(cards) {
    const expanded = splitOversizedCards(cards);
    const pages = planPagination(expanded);
    return pages.sort(function (a, b) {
      const aShortSingle = a.cards.length === 1 && textLength(a.cards[0].text) <= 140 ? 1 : 0;
      const bShortSingle = b.cards.length === 1 && textLength(b.cards[0].text) <= 140 ? 1 : 0;
      return aShortSingle - bShortSingle;
    });
  }

  function commentCardHtml(placement) {
    const card = placement.card;
    const style = `--card-color:${card.color};left:${placement.x}px;top:${placement.y}px;width:${placement.width}px;height:${placement.height}px`;
    return `<article class="comment-card" style="${style}" data-card-id="${card.id}" data-safe-container>${cardInnerHtml(card)}</article>`;
  }

  function commentPageHtml(section, pageModel, localIndex) {
    const id = `comment-${section.section.toLowerCase().replace(/[^a-z]+/g, "-")}-${localIndex + 1}`;
    return `<section class="report-page comment-page" data-page-id="${id}" data-comment-section="${section.key}">
      <div class="comment-heading" data-safe-container>
        <div class="small-kicker">2026-1 YOURSSU PEER-REVIEW</div>
        <h2>${escapeHtml(section.title)} <span>[${escapeHtml(section.bracket)}]</span></h2>
      </div>
      <div class="comment-grid" data-layout="${pageModel.name}" data-safe-container>
        ${pageModel.placements.map(commentCardHtml).join("")}
      </div>
      <footer class="page-footer" data-safe-container>
        <span>Yourssu HR \u00B7 2026 Peer Review</span>
        <span>${escapeHtml(section.section)}</span>
        <span class="page-number"></span>
      </footer>
    </section>`;
  }

  function rebuildCommentPages(sectionModels) {
    document.querySelectorAll(".comment-page").forEach(function (node) { node.remove(); });
    const anchor = document.getElementById("comment-pages-anchor");
    const html = [];
    sectionModels.forEach(function (model) {
      model.pages = paginate(model.cards);
      model.pages.forEach(function (pageModel, index) { html.push(commentPageHtml(model.config, pageModel, index)); });
    });
    anchor.insertAdjacentHTML("beforebegin", html.join(""));
    state.pages = sectionModels;
    updatePageNumbers();
  }

  function updatePageNumbers() {
    const pages = Array.from(document.querySelectorAll(".report-page"));
    const total = pages.length;
    pages.forEach(function (page, index) {
      const number = page.querySelector(".page-number");
      if (number) number.textContent = `${String(index + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}`;
    });
  }

  function nextFrame() {
    return new Promise(function (resolve) { requestAnimationFrame(function () { requestAnimationFrame(resolve); }); });
  }

  function isOverflowing(element) {
    return element.scrollHeight > element.clientHeight + 1 || element.scrollWidth > element.clientWidth + 1;
  }

  function rectWithin(inner, outer, tolerance) {
    return inner.left >= outer.left - tolerance && inner.top >= outer.top - tolerance &&
      inner.right <= outer.right + tolerance && inner.bottom <= outer.bottom + tolerance;
  }

  function overlapDetail(first, second) {
    const a = first.getBoundingClientRect();
    const b = second.getBoundingClientRect();
    const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return width > 1 && height > 1 ? { width: width, height: height } : null;
  }

  function runPreflight() {
    const errors = [];
    const warnings = [];
    const pages = Array.from(document.querySelectorAll(".report-page"));
    pages.forEach(function (page, pageIndex) {
      const pageRect = page.getBoundingClientRect();
      Array.from(page.querySelectorAll("[data-safe-container], .safe-element, .comment-card")).forEach(function (element) {
        const rect = element.getBoundingClientRect();
        if (!rectWithin(rect, pageRect, 1)) {
          errors.push({ type: "PAGE_BOUNDARY", page: pageIndex + 1, element: element.className || element.tagName, detail: { left: rect.left - pageRect.left, top: rect.top - pageRect.top, right: rect.right - pageRect.right, bottom: rect.bottom - pageRect.bottom } });
        }
      });
      Array.from(page.querySelectorAll("[data-check-overflow], .comment-card")).forEach(function (element) {
        if (isOverflowing(element)) {
          errors.push({ type: "OVERFLOW", page: pageIndex + 1, element: element.className || element.tagName, detail: { scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight } });
        }
      });
      const cards = Array.from(page.querySelectorAll(".comment-card"));
      cards.forEach(function (card, firstIndex) {
        const body = card.querySelector(".comment-body");
        if (parseFloat(getComputedStyle(body).fontSize) < 21.2) errors.push({ type: "BODY_FONT_TOO_SMALL", page: pageIndex + 1, element: "comment-body", detail: getComputedStyle(body).fontSize });
        if (isMeaningless(body.textContent, page.dataset.commentSection)) errors.push({ type: "MEANINGLESS_CARD", page: pageIndex + 1, element: "comment-body", detail: body.textContent });
        cards.slice(firstIndex + 1).forEach(function (other) {
          const overlap = overlapDetail(card, other);
          if (overlap) errors.push({ type: "CARD_OVERLAP", page: pageIndex + 1, element: "comment-card", detail: overlap });
        });
      });
      const text = cleanText(page.innerText);
      if (text.length < 8) errors.push({ type: "BLANK_PAGE", page: pageIndex + 1, element: page.dataset.pageId || "page" });
    });
    const rootFont = getComputedStyle(document.body).fontFamily;
    if (!/Wanted Sans/i.test(rootFont)) errors.push({ type: "FONT_FALLBACK", page: 0, element: "body", detail: rootFont });
    if (document.fonts.status !== "loaded") errors.push({ type: "FONT_NOT_READY", page: 0, element: "document.fonts", detail: document.fonts.status });
    return { ok: errors.length === 0, errors: errors, warnings: warnings, pageCount: pages.length, fontReady: document.fonts.status === "loaded" };
  }

  async function initialize() {
    window.__REPORT_READY__ = false;
    try {
      const data = JSON.parse(document.getElementById("report-data").textContent);
      await document.fonts.ready;
      ensureMeasureRoot();
      const sectionModels = SECTION_CONFIG.map(function (config) {
        return { config: config, cards: makeCards(data.member[config.key], config), pages: [] };
      }).filter(function (model) { return model.cards.length > 0; });
      rebuildCommentPages(sectionModels);
      await nextFrame();
      updatePageNumbers();
      state.validation = runPreflight();
      window.__REPORT_VALIDATION__ = state.validation;
    } catch (error) {
      state.validation = { ok: false, errors: [{ type: "RUNTIME", page: 0, element: "report-runtime", detail: error.message }], warnings: [], pageCount: document.querySelectorAll(".report-page").length, fontReady: document.fonts.status === "loaded" };
      window.__REPORT_VALIDATION__ = state.validation;
      console.error(error);
    } finally {
      if (state.measureRoot) { state.measureRoot.remove(); state.measureRoot = null; }
      window.__REPORT_READY__ = true;
    }
  }

  initialize();
})();
