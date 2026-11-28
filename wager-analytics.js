"use strict";

/**
 * VectorLine Analytics Engine — Beta v0.2 (Browser / Extension / Web Vault)
 *
 * Powers Pure Model (All +EV Scanned Selections, 1-Pick/Prop Lean, Card Top-6 Recs),
 * Cash Wagers, Source Combinations (Cash ∩ Model, Model Unbet, Off-Model Cash),
 * Rolling L3/L5/L7 Slate Momentum, "What's Firing Right Now" Signal Discovery,
 * and Granular Multi-Filter 2D Cross-Tabs (Over/Under, Posted Total, Edge %, Moneyline, Team).
 */
(function (root) {
  const EDGE_BUCKET_ORDER = [
    "< -10.0% (Strong Fade)",
    "-10.0% to -5.01% (-EV)",
    "-5.0% to -0.01% (Vig Zone)",
    "0.0% to +3.99% (Small +EV)",
    "4.0% – 4.99%",
    "5.0% – 6.99%",
    "7.0% – 9.99%",
    "10.0% – 11.99%",
    "12.0%+ (2G2BT)",
    "Unmodeled"
  ];

  const ODDS_BUCKET_ORDER = [
    "<= -201 (Chalk Cap)",
    "-151 to -200 (Heavy Fav)",
    "-126 to -150 (Mod Fav)",
    "-101 to -125 (Light Fav)",
    "+100 to +129 (Plus)",
    "+130+ (Underdog)"
  ];

  const MARKET_ORDER = [
    "SOG",
    "Points",
    "Assists",
    "Goals",
    "Saves",
    "Moneyline",
    "Spread",
    "Total",
    "Prop"
  ];

  const SELECTION_ORDER = ["Over", "Under", "ML", "Other"];

  const REL_SIZE_BUCKET_ORDER = [
    "< 0.75x Avg (Small)",
    "0.75x – 1.24x Avg (Standard)",
    "1.25x – 1.49x Avg (Elevated)",
    "1.50x+ Avg (Outsized)"
  ];

  const BET_TYPE_ORDER = ["Cash", "Model", "ModelEV", "ModelLean", "Paper"];
  const WAGER_ACTION_ORDER = ["Placed (Cash)", "Unbet (Model Only)", "Tracked (Paper)"];

  const DIMENSIONS = {
    edge_bucket: "Value Edge %",
    odds_bucket: "Attached Moneyline",
    selection: "Selection (Over / Under)",
    line: "Posted Total (0.5 / 1.5 / 2.5 / 3.5)",
    selection_line: "Side & Total (Over 2.5 vs Under 2.5)",
    market: "Market",
    market_selection: "Market • Selection",
    market_line_selection: "Market • Side • Total",
    team: "Player Team",
    rel_size_bucket: "Relative Wager Size (vs Avg)",
    wager_action: "Execution (Cash Backed vs Unbet)",
    bet_type: "Source (Cash vs Model)",
    sportsbook: "Sportsbook",
    event_date: "Slate Date"
  };

  const PRESET_CROSSTABS = [
    { id: "edge_x_odds", label: "Edge % × Moneyline", rowDim: "edge_bucket", colDim: "odds_bucket" },
    { id: "sel_line_x_edge", label: "Side & Total (O/U 2.5) × Edge %", rowDim: "selection_line", colDim: "edge_bucket" },
    { id: "sel_line_x_odds", label: "Side & Total (O/U 2.5) × Moneyline", rowDim: "selection_line", colDim: "odds_bucket" },
    { id: "market_x_selection", label: "Market × Over/Under", rowDim: "market", colDim: "selection" },
    { id: "mls_x_odds", label: "Market•Side•Total × Moneyline", rowDim: "market_line_selection", colDim: "odds_bucket" },
    { id: "edge_x_selection", label: "Edge % × Over/Under", rowDim: "edge_bucket", colDim: "selection" },
    { id: "team_x_selection", label: "Team × Over/Under", rowDim: "team", colDim: "selection" },
    { id: "size_x_odds", label: "Rel Bet Size × Moneyline", rowDim: "rel_size_bucket", colDim: "odds_bucket" }
  ];

  function round2(n) {
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  }

  function roundHalfDollar(n) {
    return Math.round(Number(n) * 2) / 2;
  }

  function safeFloat(val, fallback) {
    if (val === null || val === undefined) return fallback;
    if (typeof val === "number") return Number.isFinite(val) ? val : fallback;
    const s = String(val).trim().replace(/[$,%]/g, "");
    if (!s || /^(paper|none|null|n\/a|na)$/i.test(s)) return fallback;
    const n = Number(s);
    return Number.isFinite(n) ? n : fallback;
  }

  function normalizePlayerKey(name) {
    const clean = String(name || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\([A-Za-z/]+\)\s*$/, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
    if (!clean) return "";
    const parts = clean.split(/\s+/);
    const aliases = {
      joseph: "joe",
      nicholas: "nick",
      nicolas: "nic",
      alexander: "alex",
      alexandar: "alex",
      matthew: "matt",
      michael: "mike",
      william: "will",
      christopher: "chris",
      mitchell: "mitch",
      zachary: "zach",
      joshua: "josh",
      samuel: "sam",
      jacob: "jake",
      cameron: "cam",
      anthony: "tony",
      patrick: "pat",
      maxim: "max"
    };
    if (aliases[parts[0]]) parts[0] = aliases[parts[0]];
    return parts.join(" ");
  }

  function americanToDecimalNet(odds) {
    const o = Number(odds);
    if (!Number.isFinite(o) || o === 0) return 100 / 110;
    return o > 0 ? o / 100 : 100 / Math.abs(o);
  }

  function americanToImpliedProb(odds) {
    const o = Number(odds);
    if (!Number.isFinite(o) || o === 0) return 110 / 210;
    if (o > 0) return 100 / (o + 100);
    const absO = Math.abs(o);
    return absO / (absO + 100);
  }

  function probToAmericanInt(prob) {
    const p = Math.max(0.005, Math.min(0.995, Number(prob) || 0.5));
    if (Math.abs(p - 0.5) < 1e-9) return 100;
    if (p > 0.5) return -Math.round((p / (1 - p)) * 100);
    return Math.round(((1 - p) / p) * 100);
  }

  function normalizeMarketLabel(rawMarket) {
    const m = String(rawMarket || "Prop").trim();
    const low = m.toLowerCase();
    if (["sog", "shots", "shots on goal", "player shots on goal"].includes(low)) return "SOG";
    if (["points", "player points", "pts"].includes(low)) return "Points";
    if (["assists", "player assists", "ast"].includes(low)) return "Assists";
    if (["goals", "goal", "anytime goal", "goalscorer", "atgs"].includes(low)) return "Goals";
    if (["saves", "goalie saves", "total saves"].includes(low)) return "Saves";
    if (["ml", "moneyline", "money line"].includes(low)) return "Moneyline";
    if (["spread", "puck line", "puckline", "handicap"].includes(low)) return "Spread";
    if (["total", "game total", "over/under"].includes(low)) return "Total";
    return m;
  }

  function normalizeSelectionLabel(rawPick) {
    const p = String(rawPick || "").trim();
    const low = p.toLowerCase();
    if (low.startsWith("over") || low === "o" || ["yes", "atgs", "anytime"].includes(low)) return "Over";
    if (low.startsWith("under") || low === "u" || low === "no") return "Under";
    if (low === "ml" || low === "moneyline") return "ML";
    return p ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : "Other";
  }

  function normalizeGradeLabel(rawGrade) {
    const g = String(rawGrade || "OPEN").trim().toUpperCase();
    if (["W", "WIN", "WON", "CASHED"].includes(g)) return "WIN";
    if (["L", "LOSS", "LOST"].includes(g)) return "LOSS";
    if (["P", "PUSH", "VOID", "CANCELLED", "REFUNDED"].includes(g)) return "PUSH";
    return "OPEN";
  }

  function estimateKellyStake(odds, edgePct, bankroll = 500) {
    if (edgePct === null || !Number.isFinite(edgePct) || edgePct <= 0) {
      return roundHalfDollar(bankroll * 0.02);
    }
    const b = americanToDecimalNet(odds);
    const pBook = americanToImpliedProb(odds);
    const pModel = Math.max(0.01, Math.min(0.99, pBook + edgePct / 100));
    const q = 1 - pModel;
    const fullKelly = b > 0 ? (b * pModel - q) / b : 0;
    if (fullKelly <= 0) return 5.0;
    const raw = bankroll * 0.25 * fullKelly;
    const capped = Math.max(5.0, Math.min(bankroll * 0.05, raw));
    return Math.max(0.5, roundHalfDollar(capped));
  }

  function propSignature(w) {
    return `${w.event_date}|${w.player_norm}|${String(w.market || "").toUpperCase()}|${w.line}|${String(w.selection || "").toUpperCase()}`;
  }

  function normalizeWager(raw, opts = {}) {
    const paperSizingMode = opts.paperSizingMode || "kelly_if_missing";
    const bankroll = Number(opts.bankroll) || 500;
    const flatUnitStake = Number(opts.flatUnitStake) || 10;

    const rawStakeVal = raw.stake !== undefined ? raw.stake : raw.Stake_USD;
    const rawBetType = String(raw.betType || raw.Bet_Type || "").trim().toUpperCase();
    const explicitBetType = String(raw.bet_type || "").trim();
    const isModelRecord = ["Model", "ModelEV", "ModelLean"].includes(explicitBetType);

    const isPaper =
      isModelRecord ||
      Boolean(raw.is_paper) ||
      String(rawStakeVal || "").trim().toUpperCase() === "PAPER" ||
      rawBetType === "PAPER";

    let odds = safeFloat(raw.odds !== undefined ? raw.odds : raw.Odds, -110);
    if (!odds) odds = -110;

    let edgePct = safeFloat(
      raw.edge_pct !== undefined
        ? raw.edge_pct
        : raw.edgePct !== undefined
        ? raw.edgePct
        : raw.Edge_Pct,
      null
    );
    const fairOdds = safeFloat(
      raw.fair_odds !== undefined
        ? raw.fair_odds
        : raw.fairOdds !== undefined
        ? raw.fairOdds
        : raw.VectorLine_Edge_Fair,
      null
    );
    if (edgePct === null && fairOdds !== null && fairOdds !== 0) {
      edgePct = round2((americanToImpliedProb(fairOdds) - americanToImpliedProb(odds)) * 100);
    }

    const cashStake = isPaper ? 0 : safeFloat(rawStakeVal, 0) || 0;
    const explicitPaper =
      safeFloat(
        isModelRecord && Number(rawStakeVal) > 0
          ? rawStakeVal
          : raw.paper_stake !== undefined && Number(raw.paper_stake) > 0
          ? raw.paper_stake
          : raw.paperStake !== undefined && Number(raw.paperStake) > 0
          ? raw.paperStake
          : raw.Paper_Stake_USD !== undefined && Number(raw.Paper_Stake_USD) > 0
          ? raw.Paper_Stake_USD
          : raw.portfolioAdviceStake,
        0
      ) || 0;

    let stakeSource = "recorded";
    let paperStake = 0;
    let effectiveStake = cashStake;

    if (isPaper) {
      if (paperSizingMode === "flat_unit") {
        paperStake = flatUnitStake;
        stakeSource = "unit_default";
      } else if (explicitPaper > 0) {
        paperStake = explicitPaper;
        stakeSource = "recorded";
      } else if (paperSizingMode === "kelly_if_missing") {
        paperStake = estimateKellyStake(odds, edgePct, bankroll);
        stakeSource = "kelly_implied";
      } else {
        paperStake = flatUnitStake;
        stakeSource = "unit_default";
      }
      effectiveStake = paperStake;
    }

    const grade = normalizeGradeLabel(raw.grade !== undefined ? raw.grade : raw.Grade);
    const netDec = americanToDecimalNet(odds);
    const impliedProb = americanToImpliedProb(odds);

    let amountWon = 0;
    let amountLost = 0;
    let unitReturn = 0;

    const recordedCashNet = safeFloat(
      raw.net_profit !== undefined
        ? raw.net_profit
        : raw.Net_PnL_USD !== undefined
        ? raw.Net_PnL_USD
        : raw.betType === "LIVE" || (!isPaper && raw.wagerId)
        ? raw.payout
        : null,
      null
    );
    const recordedPaperNet = safeFloat(
      raw.paperPayout !== undefined ? raw.paperPayout : raw.Paper_PnL_USD,
      null
    );

    if (grade === "WIN") {
      if (!isPaper && recordedCashNet !== null && recordedCashNet > 0) {
        amountWon = round2(recordedCashNet);
        unitReturn = effectiveStake > 0 ? amountWon / effectiveStake : netDec;
      } else if (isPaper && stakeSource === "recorded" && recordedPaperNet !== null && recordedPaperNet > 0) {
        amountWon = round2(recordedPaperNet);
        unitReturn = effectiveStake > 0 ? amountWon / effectiveStake : netDec;
      } else {
        amountWon = round2(effectiveStake * netDec);
        unitReturn = netDec;
      }
    } else if (grade === "LOSS") {
      if (!isPaper && recordedCashNet !== null && recordedCashNet < 0) {
        amountLost = round2(Math.abs(recordedCashNet));
      } else {
        amountLost = round2(effectiveStake);
      }
      unitReturn = -1.0;
    }

    const netProfit = round2(amountWon - amountLost);
    const playerTeam = String(raw.player_team || raw.player || raw.Player || "Unknown").trim();
    const market = normalizeMarketLabel(raw.market || raw.Market || "Prop");
    const line = String(raw.line !== undefined && raw.line !== null ? raw.line : raw.Line || "").trim();
    // Critical: check `raw.selection` / `raw.Selection` FIRST so serialized NormalizedWager records preserve Under!
    const selection = normalizeSelectionLabel(
      raw.selection || raw.Selection || raw.pick || raw.side || raw.Pick || "Over"
    );
    const eventDate = String(raw.event_date || raw.date || raw.Date || raw.date_placed || "").trim().slice(0, 10);
    const wagerId = String(raw.wager_id || raw.wagerId || raw.ticket_no || raw.ticketNo || "").trim();

    const resolvedBetType = isModelRecord ? explicitBetType : isPaper ? "Paper" : "Cash";
    const modelProb = safeFloat(
      raw.model_prob !== undefined ? raw.model_prob : raw.modelProb,
      null
    );

    return {
      wager_id: wagerId || `W-${Math.random().toString(36).slice(2, 9)}`,
      event_date: eventDate,
      sportsbook: String(raw.sportsbook || raw.Sportsbook || "Unspecified Book").trim(),
      league: String(raw.league || raw.League || "NHL").trim().toUpperCase(),
      game_id: String(raw.game_id || raw.gameId || raw.Game_ID || "").trim(),
      player_team: playerTeam,
      player_norm: normalizePlayerKey(playerTeam),
      team: String(raw.team || raw.Team || "").trim().toUpperCase(),
      market,
      line,
      selection,
      odds: round2(odds),
      implied_prob: impliedProb,
      net_decimal: netDec,
      is_paper: isPaper,
      bet_type: resolvedBetType,
      stake: round2(effectiveStake),
      stake_source: raw.stake_source || stakeSource,
      fair_odds: fairOdds !== null ? round2(fairOdds) : null,
      edge_pct: edgePct !== null ? round2(edgePct) : null,
      model_prob: modelProb !== null ? Math.round(modelProb * 10000) / 10000 : null,
      funnel_stage: String(raw.funnel_stage || raw.funnelStage || "").trim(),
      grade,
      result_stat: String(raw.result_stat || raw.resultStat || raw.Actual_Stat || "").trim(),
      wager_action: String(raw.wager_action || (isPaper ? "Tracked (Paper)" : "Placed (Cash)")),
      rec_tier: String(raw.rec_tier || "Standard"),
      amount_won: amountWon,
      amount_lost: amountLost,
      net_profit: netProfit,
      unit_return: unitReturn
    };
  }

  function applyPaperGameCapScaling(wagers, bankroll = 500, gameCapPct = 15) {
    const maxGameDollars = bankroll * (gameCapPct / 100);
    if (maxGameDollars <= 0) return;
    const byGame = new Map();
    wagers.forEach((w) => {
      if (!w.is_paper || w.stake_source !== "kelly_implied") return;
      const key = `${w.event_date}|${w.game_id || w.team || w.wager_id}`;
      if (!byGame.has(key)) byGame.set(key, []);
      byGame.get(key).push(w);
    });
    byGame.forEach((group) => {
      const sumRaw = group.reduce((acc, w) => acc + w.stake, 0);
      if (sumRaw > maxGameDollars && sumRaw > 0) {
        const scale = maxGameDollars / sumRaw;
        group.forEach((w) => {
          w.stake = Math.max(0.5, roundHalfDollar(w.stake * scale));
          if (w.grade === "WIN") {
            w.amount_won = round2(w.stake * w.net_decimal);
            w.amount_lost = 0;
          } else if (w.grade === "LOSS") {
            w.amount_won = 0;
            w.amount_lost = round2(w.stake);
          }
          w.net_profit = round2(w.amount_won - w.amount_lost);
        });
      }
    });
  }

  function normalizeBatch(rawList, opts = {}) {
    const list = (rawList || []).map((r) => normalizeWager(r, opts));
    if ((opts.paperSizingMode || "kelly_if_missing") === "kelly_if_missing") {
      applyPaperGameCapScaling(list, Number(opts.bankroll) || 500, 15);
    }
    if (opts.dedupeShadows !== false) {
      return dedupeShadowOpen(list);
    }
    return { wagers: list, droppedShadows: 0 };
  }

  function dedupeShadowOpen(wagers) {
    const settledKeys = new Set();
    wagers.forEach((w) => {
      if (w.grade === "WIN" || w.grade === "LOSS" || w.grade === "PUSH") {
        settledKeys.add(`${propSignature(w)}|${w.is_paper ? 1 : 0}`);
      }
    });

    const seenOpenSigs = new Set();
    const cleaned = [];
    let droppedShadows = 0;

    wagers.forEach((w) => {
      const baseKey = `${propSignature(w)}|${w.is_paper ? 1 : 0}`;
      if (w.grade === "OPEN") {
        if (settledKeys.has(baseKey)) {
          droppedShadows++;
          return;
        }
        const openSig = `${baseKey}|${w.odds}|${w.stake}`;
        if (seenOpenSigs.has(openSig)) {
          droppedShadows++;
          return;
        }
        seenOpenSigs.add(openSig);
      }
      cleaned.push(w);
    });

    return { wagers: cleaned, droppedShadows };
  }

  function isDnpVoid(w) {
    return String((w && w.result_stat) || "").startsWith("DNP");
  }

  function mean(arr) {
    if (!arr || arr.length === 0) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  function median(arr) {
    if (!arr || arr.length === 0) return 0;
    const sorted = arr.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function computeCohortAvgStake(wagers) {
    const settledStakes = wagers
      .filter((w) => ["WIN", "LOSS", "PUSH"].includes(w.grade) && !isDnpVoid(w) && w.stake > 0)
      .map((w) => w.stake);
    if (settledStakes.length > 0) return mean(settledStakes);
    const allStakes = wagers.filter((w) => w.stake > 0).map((w) => w.stake);
    return mean(allStakes);
  }

  function computeBucketMetrics(wagers, portfolioAvgStake, outsizedMult = 1.5) {
    const voidRows = wagers.filter((w) => isDnpVoid(w));
    const settled = wagers.filter((w) => ["WIN", "LOSS", "PUSH"].includes(w.grade) && !isDnpVoid(w));
    const openRows = wagers.filter((w) => w.grade === "OPEN");
    const wins = settled.filter((w) => w.grade === "WIN");
    const losses = settled.filter((w) => w.grade === "LOSS");
    const pushes = settled.filter((w) => w.grade === "PUSH");
    const decided = settled.filter((w) => w.grade === "WIN" || w.grade === "LOSS");

    const settledStakes = settled.filter((w) => w.stake > 0).map((w) => w.stake);
    const allStakes = wagers.filter((w) => w.stake > 0).map((w) => w.stake);
    const activeStakes = settledStakes.length > 0 ? settledStakes : allStakes;

    const avgStake = mean(activeStakes);
    const medianStake = median(activeStakes);
    const minStake = activeStakes.length > 0 ? Math.min(...activeStakes) : 0;
    const maxStake = activeStakes.length > 0 ? Math.max(...activeStakes) : 0;

    const baseAvg = portfolioAvgStake && portfolioAvgStake > 0 ? portfolioAvgStake : avgStake;
    const relStakeVsAvg = baseAvg > 0 ? avgStake / baseAvg : 0;
    const maxRelStake = baseAvg > 0 ? maxStake / baseAvg : 0;

    const winStakes = wins.filter((w) => w.stake > 0).map((w) => w.stake);
    const lossStakes = losses.filter((w) => w.stake > 0).map((w) => w.stake);
    const avgWinStake = mean(winStakes);
    const avgLossStake = mean(lossStakes);
    const winRelStake = baseAvg > 0 && winStakes.length > 0 ? avgWinStake / baseAvg : 0;
    const lossRelStake = baseAvg > 0 && lossStakes.length > 0 ? avgLossStake / baseAvg : 0;

    const totalWagered = round2(settled.reduce((a, w) => a + w.stake, 0));
    const openWagered = round2(openRows.reduce((a, w) => a + w.stake, 0));
    const amountWon = round2(wins.reduce((a, w) => a + w.amount_won, 0));
    const amountLost = round2(losses.reduce((a, w) => a + w.amount_lost, 0));
    const netProfit = round2(amountWon - amountLost);

    const roiPct = totalWagered > 0 ? round2((netProfit / totalWagered) * 100) : 0;
    const profitFactor = amountLost > 0 ? round2(amountWon / amountLost) : amountWon > 0 ? 99.99 : null;
    const winRatePct = decided.length > 0 ? round2((wins.length / decided.length) * 100) : 0;

    const probSource = decided.length > 0 ? decided : wagers;
    const avgImpliedProb = probSource.length > 0 ? mean(probSource.map((w) => w.implied_prob)) : 0;
    const breakevenWinRatePct = probSource.length > 0 ? round2(avgImpliedProb * 100) : 0;
    const avgOdds = probSource.length > 0 ? probToAmericanInt(avgImpliedProb) : 0;
    const winVsBreakevenPct = decided.length > 0 ? round2(winRatePct - breakevenWinRatePct) : 0;

    const flat1uNetUnits = settled.reduce((a, w) => a + w.unit_return, 0);
    const flat1uRoiPct = settled.length > 0 ? round2((flat1uNetUnits / settled.length) * 100) : 0;
    const sizingImpactPct = settled.length > 0 ? round2(roiPct - flat1uRoiPct) : 0;
    const netAvgBetUnits = baseAvg > 0 ? round2(netProfit / baseAvg) : 0;

    const edgeVals = (settled.length > 0 ? settled : wagers)
      .map((w) => w.edge_pct)
      .filter((v) => v !== null && Number.isFinite(v));
    const avgEdgePct = edgeVals.length > 0 ? round2(mean(edgeVals)) : null;

    const modelProbVals = (decided.length > 0 ? decided : wagers)
      .map((w) => w.model_prob)
      .filter((v) => v !== null && v !== undefined && Number.isFinite(v));
    const avgModelProbPct = modelProbVals.length > 0 ? round2(mean(modelProbVals) * 100) : null;
    const calibrationGapPct =
      decided.length > 0 && avgModelProbPct !== null ? round2(winRatePct - avgModelProbPct) : null;

    const outsizedCount = settled.filter((w) => baseAvg > 0 && w.stake / baseAvg >= outsizedMult).length;

    return {
      total_wagers: wagers.length,
      settled_count: settled.length,
      open_count: openRows.length,
      void_count: voidRows.length,
      wins: wins.length,
      losses: losses.length,
      pushes: pushes.length,
      record: pushes.length > 0 ? `${wins.length}-${losses.length}-${pushes.length}` : `${wins.length}-${losses.length}`,
      win_rate_pct: winRatePct,
      avg_model_prob_pct: avgModelProbPct,
      calibration_gap_pct: calibrationGapPct,
      avg_odds: avgOdds,
      breakeven_win_rate_pct: breakevenWinRatePct,
      win_vs_breakeven_pct: winVsBreakevenPct,
      avg_edge_pct: avgEdgePct,
      total_wagered: totalWagered,
      open_wagered: openWagered,
      amount_won: amountWon,
      amount_lost: amountLost,
      net_profit: netProfit,
      net_avg_bet_units: netAvgBetUnits,
      roi_pct: roiPct,
      flat_1u_net_units: round2(flat1uNetUnits),
      flat_1u_roi_pct: flat1uRoiPct,
      sizing_impact_pct: sizingImpactPct,
      profit_factor: profitFactor,
      portfolio_avg_stake: round2(baseAvg),
      avg_stake: round2(avgStake),
      median_stake: round2(medianStake),
      min_stake: round2(minStake),
      max_stake: round2(maxStake),
      rel_stake_vs_avg: round2(relStakeVsAvg),
      max_rel_stake: round2(maxRelStake),
      avg_win_stake: round2(avgWinStake),
      avg_loss_stake: round2(avgLossStake),
      win_rel_stake: round2(winRelStake),
      loss_rel_stake: round2(lossRelStake),
      outsized_count: outsizedCount
    };
  }

  function simulateStakeCap(wagers, capMult, baseAvg) {
    const settled = wagers.filter((w) => ["WIN", "LOSS", "PUSH"].includes(w.grade) && !isDnpVoid(w) && w.stake > 0);
    if (settled.length === 0) {
      return { cap_multiple: capMult, cap_dollar_limit: 0, clipped_wager_count: 0, total_wagered: 0, amount_won: 0, amount_lost: 0, net_profit: 0, roi_pct: 0 };
    }
    const capDollars = round2(baseAvg * capMult);
    let totWagered = 0;
    let won = 0;
    let lost = 0;
    let clipped = 0;
    settled.forEach((w) => {
      const sEff = Math.min(w.stake, capDollars);
      if (w.stake > capDollars + 1e-6) clipped++;
      totWagered += sEff;
      if (w.grade === "WIN") won += sEff * w.unit_return;
      else if (w.grade === "LOSS") lost += sEff;
    });
    totWagered = round2(totWagered);
    won = round2(won);
    lost = round2(lost);
    const net = round2(won - lost);
    return {
      cap_multiple: capMult,
      cap_dollar_limit: capDollars,
      clipped_wager_count: clipped,
      total_wagered: totWagered,
      amount_won: won,
      amount_lost: lost,
      net_profit: net,
      roi_pct: totWagered > 0 ? round2((net / totWagered) * 100) : 0
    };
  }

  function computePortfolioDiagnostics(wagers, outsizedMult = 1.5) {
    const baseAvg = computeCohortAvgStake(wagers);
    const summary = computeBucketMetrics(wagers, baseAvg, outsizedMult);
    const settled = wagers.filter((w) => ["WIN", "LOSS", "PUSH"].includes(w.grade) && !isDnpVoid(w));

    const outsizedRows = wagers.filter((w) => baseAvg > 0 && w.stake / baseAvg >= outsizedMult);
    const normalRows = wagers.filter((w) => baseAvg <= 0 || w.stake / baseAvg < outsizedMult);
    const outsizedMetrics = computeBucketMetrics(outsizedRows, baseAvg, outsizedMult);
    const normalMetrics = computeBucketMetrics(normalRows, baseAvg, outsizedMult);

    const settledBySize = settled.slice().sort((a, b) => b.stake - a.stake || Math.abs(b.net_profit) - Math.abs(a.net_profit));
    const top3Ids = new Set(settled.length > 3 ? settledBySize.slice(0, 3).map((w) => w.wager_id) : []);
    const exTop3Metrics = computeBucketMetrics(
      settled.filter((w) => !top3Ids.has(w.wager_id)),
      baseAvg,
      outsizedMult
    );

    const counterfactuals = [
      {
        id: "actual",
        label: "Actual Sized Portfolio",
        note: "Recorded / Kelly stakes",
        total_wagered: summary.total_wagered,
        amount_won: summary.amount_won,
        amount_lost: summary.amount_lost,
        net_profit: summary.net_profit,
        roi_pct: summary.roi_pct
      },
      {
        id: "flat_1u",
        label: `Equal-Stake (1.0x = $${baseAvg.toFixed(2)})`,
        note: "Removes bet-size skew",
        total_wagered: round2(settled.length * baseAvg),
        amount_won: round2(settled.filter((w) => w.grade === "WIN").reduce((a, w) => a + baseAvg * w.unit_return, 0)),
        amount_lost: round2(settled.filter((w) => w.grade === "LOSS").length * baseAvg),
        net_profit: round2(summary.flat_1u_net_units * baseAvg),
        roi_pct: summary.flat_1u_roi_pct
      },
      {
        id: "cap_1_25x",
        label: "Capped at 1.25x Avg Stake",
        note: `Clips stakes > $${(baseAvg * 1.25).toFixed(2)}`,
        ...simulateStakeCap(settled, 1.25, baseAvg)
      },
      {
        id: "cap_1_50x",
        label: "Capped at 1.50x Avg Stake",
        note: `Clips stakes > $${(baseAvg * 1.5).toFixed(2)}`,
        ...simulateStakeCap(settled, 1.5, baseAvg)
      },
      {
        id: "ex_outsized",
        label: `Ex-Outsized (< ${outsizedMult.toFixed(2)}x Avg)`,
        note: `Excludes ${outsizedMetrics.settled_count} outsized bet(s)`,
        total_wagered: normalMetrics.total_wagered,
        amount_won: normalMetrics.amount_won,
        amount_lost: normalMetrics.amount_lost,
        net_profit: normalMetrics.net_profit,
        roi_pct: normalMetrics.roi_pct
      },
      {
        id: "ex_top_3",
        label: "Ex-Top 3 Largest Bets",
        note: "Tail concentration check",
        total_wagered: exTop3Metrics.total_wagered,
        amount_won: exTop3Metrics.amount_won,
        amount_lost: exTop3Metrics.amount_lost,
        net_profit: exTop3Metrics.net_profit,
        roi_pct: exTop3Metrics.roi_pct
      }
    ];

    function decorateSwing(w) {
      const relSz = baseAvg > 0 ? round2(w.stake / baseAvg) : 0;
      let roiImpact = 0;
      if (w.grade !== "OPEN" && summary.total_wagered - w.stake > 0) {
        const roiWithout = ((summary.net_profit - w.net_profit) / (summary.total_wagered - w.stake)) * 100;
        roiImpact = round2(summary.roi_pct - roiWithout);
      }
      return {
        ...w,
        rel_stake_vs_avg: relSz,
        portfolio_roi_impact_pct: roiImpact
      };
    }

    const largestPnlSwings = settled
      .slice()
      .sort((a, b) => Math.abs(b.net_profit) - Math.abs(a.net_profit) || b.stake - a.stake)
      .slice(0, 15)
      .map(decorateSwing);

    const largestWagers = wagers
      .slice()
      .sort((a, b) => b.stake - a.stake || Math.abs(b.net_profit) - Math.abs(a.net_profit))
      .slice(0, 15)
      .map(decorateSwing);

    let headline = "No settled selections in active filter";
    let explanation = "Adjust filters above or settle games to inspect performance.";

    if (summary.settled_count > 0) {
      const sd = summary.sizing_impact_pct;
      if (Math.abs(sd) >= 1.5) {
        headline =
          sd > 0
            ? `Positive Bet-Sizing Lift (+${sd.toFixed(2)}% ROI above 1u Flat)`
            : `Outsized Bet Swing Drag (${sd.toFixed(2)}% ROI vs 1u Flat)`;
      } else if ((summary.win_rate_pct < 50 && summary.roi_pct > 0) || (summary.win_rate_pct > 52 && summary.roi_pct < 0)) {
        headline = "Win-Rate vs. Moneyline / Sizing Divergence";
      } else {
        headline = `${summary.record} (${summary.win_rate_pct.toFixed(1)}% vs ${summary.breakeven_win_rate_pct.toFixed(1)}% BE) • ${summary.flat_1u_roi_pct >= 0 ? "+" : ""}${summary.flat_1u_roi_pct.toFixed(2)}% 1u ROI`;
      }

      explanation =
        `Record ${summary.record} (${summary.win_rate_pct.toFixed(1)}% hit rate vs ${summary.breakeven_win_rate_pct.toFixed(1)}% implied breakeven). ` +
        `Equal 1u stakes return ${summary.flat_1u_roi_pct >= 0 ? "+" : ""}${summary.flat_1u_roi_pct.toFixed(2)}% ROI` +
        (Math.abs(sd) >= 0.05
          ? `; sized stakes shifted ROI by ${sd >= 0 ? "+" : ""}${sd.toFixed(2)}% to ${summary.roi_pct >= 0 ? "+" : ""}${summary.roi_pct.toFixed(2)}%.`
          : ".");
    }

    return {
      summary,
      divergence_headline: headline,
      divergence_explanation: explanation,
      counterfactuals,
      outsized_metrics: outsizedMetrics,
      normal_metrics: normalMetrics,
      largest_pnl_swings: largestPnlSwings,
      largest_wagers: largestWagers
    };
  }

  /* =========================================================================
     ROLLING SLATE MOMENTUM & "WHAT'S FIRING RIGHT NOW" ENGINE
     ========================================================================= */

  function computeRollingTrends(wagers) {
    const settled = (wagers || []).filter((w) => ["WIN", "LOSS", "PUSH"].includes(w.grade) && !isDnpVoid(w));
    if (settled.length === 0) {
      return {
        windows: [],
        daily_slates: [],
        slate_streak_label: "No settled slates",
        is_heating_up: false,
        l3_vs_overall_roi_delta: 0
      };
    }

    const ordered = settled.slice().sort((a, b) => String(a.event_date || "").localeCompare(String(b.event_date || "")));
    const baseAvg = computeCohortAvgStake(ordered) || 10;

    const byDate = new Map();
    ordered.forEach((w) => {
      const d = w.event_date || "Unknown";
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d).push(w);
    });

    const sortedDates = Array.from(byDate.keys()).sort();
    const dailySlates = sortedDates.map((d) => {
      const dm = computeBucketMetrics(byDate.get(d), baseAvg);
      return {
        date: d,
        shortDate: d.slice(5),
        settled_count: dm.settled_count,
        wins: dm.wins,
        losses: dm.losses,
        record: `${dm.wins}-${dm.losses}`,
        win_rate_pct: dm.win_rate_pct,
        net_profit: dm.net_profit,
        roi_pct: dm.roi_pct,
        flat_1u_net: dm.flat_1u_net_units,
        flat_1u_roi_pct: dm.flat_1u_roi_pct
      };
    });

    let streakCount = 0;
    let streakDir = "";
    for (let i = dailySlates.length - 1; i >= 0; i--) {
      const ds = dailySlates[i];
      const metric = Math.abs(ds.net_profit) > 1e-6 ? ds.net_profit : ds.flat_1u_net;
      if (Math.abs(metric) < 1e-9) continue;
      const dir = metric > 0 ? "W" : "L";
      if (!streakDir) {
        streakDir = dir;
        streakCount = 1;
      } else if (dir === streakDir) {
        streakCount++;
      } else {
        break;
      }
    }

    const slateStreakLabel =
      streakDir === "W" && streakCount >= 2
        ? `🔥 ${streakCount} Straight Winning Slates`
        : streakDir === "W"
        ? "▲ Last Slate Won"
        : `${streakCount} Down Slate${streakCount !== 1 ? "s" : ""}`;

    function buildWindow(id, label, subset, slateCnt) {
      const m = computeBucketMetrics(subset, baseAvg);
      let winSlates = null;
      let actualSlates = null;
      if (slateCnt > 0) {
        const subDates = sortedDates.slice(-slateCnt);
        actualSlates = subDates.length;
        winSlates = subDates.filter((d) => {
          const dm = computeBucketMetrics(byDate.get(d), baseAvg);
          return dm.flat_1u_net_units > 0 || dm.net_profit > 0;
        }).length;
      }
      return {
        id,
        label,
        slate_count: actualSlates,
        winning_slates: winSlates,
        settled_count: m.settled_count,
        wins: m.wins,
        losses: m.losses,
        record: `${m.wins}-${m.losses}`,
        win_rate_pct: m.win_rate_pct,
        breakeven_pct: m.breakeven_win_rate_pct,
        net_profit: m.net_profit,
        roi_pct: m.roi_pct,
        flat_1u_net: m.flat_1u_net_units,
        flat_1u_roi_pct: m.flat_1u_roi_pct
      };
    }

    function lastKSlates(k) {
      const keep = new Set(sortedDates.slice(-k));
      return ordered.filter((w) => keep.has(w.event_date || "Unknown"));
    }

    const l3 = buildWindow("l3", "Last 3 Slates", lastKSlates(3), 3);
    const l5 = buildWindow("l5", "Last 5 Slates", lastKSlates(5), 5);
    const l7 = buildWindow("l7", "Last 7 Slates", lastKSlates(7), 7);
    const l15 = buildWindow("l15", "Last 15 Graded", ordered.slice(-15), 0);
    const overall = buildWindow("all", "Season Overall", ordered, sortedDates.length);

    const l3Delta = round2(l3.flat_1u_roi_pct - overall.flat_1u_roi_pct);
    const isHeatingUp = l3.flat_1u_roi_pct > 0 && (l3Delta >= 3.0 || (streakDir === "W" && streakCount >= 2));

    return {
      windows: [l3, l5, l7, l15, overall],
      daily_slates: dailySlates,
      slate_streak_label: slateStreakLabel,
      is_heating_up: isHeatingUp,
      l3_vs_overall_roi_delta: l3Delta
    };
  }

  function computeWhatsFiringFeed(wagers, opts = {}) {
    const recentSlates = Number(opts.recentSlates) || 5;
    const decided = (wagers || []).filter((w) => (w.grade === "WIN" || w.grade === "LOSS") && !isDnpVoid(w));
    if (decided.length === 0) {
      return { hot_signals: [], team_signals: [], player_signals: [], market_signals: [], cold_traps: [] };
    }

    const ordered = decided.slice().sort((a, b) => String(a.event_date || "").localeCompare(String(b.event_date || "")));
    const dates = Array.from(new Set(ordered.map((w) => w.event_date).filter(Boolean))).sort();
    const recentDateSet = new Set(dates.slice(-recentSlates));

    const isLarge = ordered.length >= 400;
    const minTeamN = isLarge ? 12 : 4;
    const minPlayerN = isLarge ? 5 : 3;
    const minPocketN = isLarge ? 14 : 5;

    function evalGroup(items, category, icon, headline, subtitle, filterPatch, minN) {
      if (!items || items.length < minN) return null;
      const m = computeBucketMetrics(items);
      const last5 = items.slice(-5);
      const l5Wins = last5.filter((x) => x.grade === "WIN").length;
      const recentItems = items.filter((x) => recentDateSet.has(x.event_date));
      const recM = recentItems.length > 0 ? computeBucketMetrics(recentItems) : m;

      const beatMarket = round2(m.win_rate_pct - m.breakeven_win_rate_pct);
      const roi1u = m.flat_1u_roi_pct;
      const score =
        roi1u * 0.65 +
        beatMarket * 0.85 +
        (recentItems.length >= 3 ? recM.flat_1u_roi_pct * 0.35 : 0) +
        (l5Wins >= 4 ? 8 : 0);

      return {
        category,
        icon,
        headline,
        subtitle,
        record: `${m.wins}-${m.losses}`,
        settled_count: m.settled_count,
        win_rate_pct: m.win_rate_pct,
        breakeven_pct: m.breakeven_win_rate_pct,
        beat_market_pct: beatMarket,
        avg_odds: m.avg_odds,
        roi_pct: m.roi_pct,
        flat_1u_roi_pct: roi1u,
        net_profit: m.net_profit,
        flat_1u_net: m.flat_1u_net_units,
        last5_str: `${l5Wins} of ${last5.length}`,
        last5_wins: l5Wins,
        last5_count: last5.length,
        recent_record: recentItems.length > 0 ? `${recM.wins}-${recM.losses}` : "",
        recent_roi_pct: recentItems.length > 0 ? recM.flat_1u_roi_pct : 0,
        filter_patch: filterPatch || {},
        _score: round2(score)
      };
    }

    // 1. Teams above market expectations
    const byTeam = new Map();
    ordered.forEach((w) => {
      if (!w.team) return;
      if (!byTeam.has(w.team)) byTeam.set(w.team, []);
      byTeam.get(w.team).push(w);
    });
    const teamSignals = [];
    const coldTraps = [];
    byTeam.forEach((rows, tm) => {
      const ev = evalGroup(
        rows,
        "TEAM",
        "🏒",
        `${tm} Skaters`,
        `Team skater group beating market implied odds`,
        { team: tm },
        minTeamN
      );
      if (!ev) return;
      if ((ev.flat_1u_roi_pct >= 5 && ev.beat_market_pct >= 2.5) || (ev.last5_count >= 5 && ev.last5_wins >= 4 && ev.flat_1u_roi_pct > 0)) {
        teamSignals.push(ev);
      } else if (ev.flat_1u_roi_pct <= -15 && rows.length >= minTeamN) {
        coldTraps.push(ev);
      }
    });
    teamSignals.sort((a, b) => b._score - a._score || b.settled_count - a.settled_count);

    // 2. Hot Individual Players
    const byPlayer = new Map();
    ordered.forEach((w) => {
      if (!w.player_team || w.player_team === "Unknown") return;
      const pk = `${w.player_norm}|${w.team}`;
      if (!byPlayer.has(pk)) byPlayer.set(pk, { name: w.player_team, team: w.team, rows: [] });
      byPlayer.get(pk).rows.push(w);
    });
    const playerSignals = [];
    byPlayer.forEach(({ name, team, rows }) => {
      const lbl = team ? `${name} (${team})` : name;
      const domSide = rows.filter((r) => r.selection === "Under").length >= rows.length * 0.7
        ? "Mostly Unders"
        : rows.filter((r) => r.selection === "Over").length >= rows.length * 0.7
        ? "Mostly Overs"
        : "Mixed O/U";
      const ev = evalGroup(
        rows,
        "PLAYER",
        "⭐",
        lbl,
        `${domSide} • Cashing above market expectation`,
        team ? { team } : {},
        minPlayerN
      );
      if (ev && ev.flat_1u_roi_pct >= 15 && ev.win_rate_pct >= 65) {
        playerSignals.push(ev);
      }
    });
    playerSignals.sort((a, b) => b.flat_1u_net - a.flat_1u_net || b.flat_1u_roi_pct - a.flat_1u_roi_pct);

    // 3. Market • Selection • Posted Total (e.g. SOG • Under 2.5, Goals • Over 0.5)
    const byMktTotSel = new Map();
    ordered.forEach((w) => {
      if (!w.market || !w.line || !w.selection) return;
      const k = `${w.market}|${w.selection}|${w.line}`;
      if (!byMktTotSel.has(k)) byMktTotSel.set(k, { mk: w.market, sel: w.selection, ln: w.line, rows: [] });
      byMktTotSel.get(k).rows.push(w);
    });
    const marketSignals = [];
    byMktTotSel.forEach(({ mk, sel, ln, rows }) => {
      const ev = evalGroup(
        rows,
        "MARKET • TOTAL",
        "🎯",
        `${mk} • ${sel} ${ln}`,
        `Posted total ${ln} (${sel}s)`,
        { market: mk, selection: sel, line: ln },
        minPocketN
      );
      if (!ev) return;
      if (ev.flat_1u_roi_pct >= 2.5) {
        marketSignals.push(ev);
      } else if (ev.flat_1u_roi_pct <= -8.5) {
        coldTraps.push(ev);
      }
    });

    // 4. Edge % × Moneyline Band Pockets
    const byEdgeOdds = new Map();
    ordered.forEach((w) => {
      const eb = classifyEdgeBucket(w.edge_pct);
      const ob = classifyOddsBucket(w.odds);
      if (eb === "Unmodeled") return;
      const k = `${eb}|||${ob}`;
      if (!byEdgeOdds.has(k)) byEdgeOdds.set(k, { eb, ob, rows: [] });
      byEdgeOdds.get(k).rows.push(w);
    });
    byEdgeOdds.forEach(({ eb, ob, rows }) => {
      const ev = evalGroup(
        rows,
        "EDGE × ODDS",
        "📐",
        `${eb} @ ${ob}`,
        `Edge band + attached moneyline pocket`,
        { edgeBucket: eb, oddsBucket: ob },
        minPocketN
      );
      if (!ev) return;
      if (ev.flat_1u_roi_pct >= 4.0) {
        marketSignals.push(ev);
      } else if (ev.flat_1u_roi_pct <= -12.0) {
        coldTraps.push(ev);
      }
    });

    marketSignals.sort((a, b) => b._score - a._score || b.settled_count - a.settled_count);
    coldTraps.sort((a, b) => a.flat_1u_roi_pct - b.flat_1u_roi_pct);

    const hotSignals = []
      .concat(marketSignals.slice(0, 4))
      .concat(teamSignals.slice(0, 4))
      .concat(playerSignals.slice(0, 4))
      .sort((a, b) => b._score - a._score);

    return {
      hot_signals: hotSignals.slice(0, 9),
      team_signals: teamSignals.slice(0, 9),
      player_signals: playerSignals.slice(0, 9),
      market_signals: marketSignals.slice(0, 9),
      cold_traps: coldTraps.slice(0, 6)
    };
  }

  /* =========================================================================
     DIMENSIONS, COMBINATION POOLS, FILTERING & CROSS-TABS
     ========================================================================= */

  function classifyEdgeBucket(edgePct) {
    if (edgePct === null || edgePct === undefined || !Number.isFinite(edgePct)) return "Unmodeled";
    if (edgePct < -10.0) return "< -10.0% (Strong Fade)";
    if (edgePct < -5.0) return "-10.0% to -5.01% (-EV)";
    if (edgePct < 0.0) return "-5.0% to -0.01% (Vig Zone)";
    if (edgePct < 4.0) return "0.0% to +3.99% (Small +EV)";
    if (edgePct < 5.0) return "4.0% – 4.99%";
    if (edgePct < 7.0) return "5.0% – 6.99%";
    if (edgePct < 10.0) return "7.0% – 9.99%";
    if (edgePct < 12.0) return "10.0% – 11.99%";
    return "12.0%+ (2G2BT)";
  }

  function classifyOddsBucket(odds) {
    if (odds <= -201) return "<= -201 (Chalk Cap)";
    if (odds <= -151) return "-151 to -200 (Heavy Fav)";
    if (odds <= -126) return "-126 to -150 (Mod Fav)";
    if (odds < 100) return "-101 to -125 (Light Fav)";
    if (odds < 130) return "+100 to +129 (Plus)";
    return "+130+ (Underdog)";
  }

  function classifyRelSizeBucket(stake, baseAvg) {
    if (!baseAvg || baseAvg <= 0 || !stake || stake <= 0) return "0.75x – 1.24x Avg (Standard)";
    const r = stake / baseAvg;
    if (r < 0.75) return "< 0.75x Avg (Small)";
    if (r < 1.25) return "0.75x – 1.24x Avg (Standard)";
    if (r < 1.5) return "1.25x – 1.49x Avg (Elevated)";
    return "1.50x+ Avg (Outsized)";
  }

  function getDimensionValue(w, dim, baseAvg) {
    switch (dim) {
      case "edge_bucket":
        return classifyEdgeBucket(w.edge_pct);
      case "odds_bucket":
        return classifyOddsBucket(w.odds);
      case "market":
        return w.market || "Prop";
      case "selection":
        return w.selection || "Other";
      case "line":
        return w.line || "—";
      case "selection_line":
        return `${w.selection || "Over"} ${w.line || ""}`.trim();
      case "market_selection":
        return `${w.market} • ${w.selection}`;
      case "market_line_selection":
        return `${w.market} • ${w.selection} ${w.line}`.trim();
      case "team":
        return w.team || "UNK";
      case "rel_size_bucket":
        return classifyRelSizeBucket(w.stake, baseAvg);
      case "bet_type":
        return w.bet_type;
      case "wager_action":
        return w.wager_action || "Unbet (Model Only)";
      case "sportsbook":
        return w.sportsbook || "Unspecified Book";
      case "event_date":
        return w.event_date || "Unknown";
      default:
        return String(w[dim] || "Other");
    }
  }

  function sortDimensionKeys(dim, keysIterable) {
    const keys = Array.from(new Set(keysIterable));
    const mapOrder = {
      edge_bucket: EDGE_BUCKET_ORDER,
      odds_bucket: ODDS_BUCKET_ORDER,
      market: MARKET_ORDER,
      selection: SELECTION_ORDER,
      rel_size_bucket: REL_SIZE_BUCKET_ORDER,
      bet_type: BET_TYPE_ORDER,
      wager_action: WAGER_ACTION_ORDER
    };
    if (mapOrder[dim]) {
      const ord = mapOrder[dim];
      return keys.sort((a, b) => {
        const ia = ord.indexOf(a);
        const ib = ord.indexOf(b);
        if (ia !== -1 && ib !== -1) return ia - ib;
        if (ia !== -1) return -1;
        if (ib !== -1) return 1;
        return a.localeCompare(b);
      });
    }
    if (dim === "line") {
      return keys.sort((a, b) => (parseFloat(a) || 999) - (parseFloat(b) || 999) || a.localeCompare(b));
    }
    if (dim === "selection_line") {
      return keys.sort((a, b) => {
        const pa = a.split(/\s+/);
        const pb = b.split(/\s+/);
        const la = parseFloat(pa[pa.length - 1]) || 999;
        const lb = parseFloat(pb[pb.length - 1]) || 999;
        if (la !== lb) return la - lb;
        return SELECTION_ORDER.indexOf(pa[0]) - SELECTION_ORDER.indexOf(pb[0]);
      });
    }
    if (dim === "market_selection" || dim === "market_line_selection") {
      return keys.sort((a, b) => {
        const [ma, restA] = a.split("•").map((s) => s.trim());
        const [mb, restB] = b.split("•").map((s) => s.trim());
        const dm =
          (MARKET_ORDER.indexOf(ma) === -1 ? 99 : MARKET_ORDER.indexOf(ma)) -
          (MARKET_ORDER.indexOf(mb) === -1 ? 99 : MARKET_ORDER.indexOf(mb));
        if (dm !== 0) return dm;
        return (restA || "").localeCompare(restB || "", undefined, { numeric: true });
      });
    }
    return keys.sort((a, b) => a.localeCompare(b));
  }

  function buildBreakdown(wagers, dimension, portfolioAvgStake, outsizedMult = 1.5) {
    const baseAvg = portfolioAvgStake && portfolioAvgStake > 0 ? portfolioAvgStake : computeCohortAvgStake(wagers);
    const groups = new Map();
    wagers.forEach((w) => {
      const k = getDimensionValue(w, dimension, baseAvg);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(w);
    });
    const keys = sortDimensionKeys(dimension, groups.keys());
    const rows = keys.map((k) => {
      const bucketWagers = groups.get(k) || [];
      return {
        key: k,
        wagers: bucketWagers,
        ...computeBucketMetrics(bucketWagers, baseAvg, outsizedMult)
      };
    });
    return {
      dimension,
      dimension_label: DIMENSIONS[dimension] || dimension,
      portfolio_avg_stake: round2(baseAvg),
      rows,
      totals: computeBucketMetrics(wagers, baseAvg, outsizedMult)
    };
  }

  function buildCrosstab(wagers, rowDim, colDim, portfolioAvgStake, outsizedMult = 1.5) {
    const avgByCohort = {
      Cash: computeCohortAvgStake(wagers.filter((w) => w.bet_type === "Cash")),
      Model: computeCohortAvgStake(wagers.filter((w) => w.bet_type === "Model")),
      ModelEV: computeCohortAvgStake(wagers.filter((w) => w.bet_type === "ModelEV")),
      ModelLean: computeCohortAvgStake(wagers.filter((w) => w.bet_type === "ModelLean")),
      Paper: computeCohortAvgStake(wagers.filter((w) => w.bet_type === "Paper"))
    };
    const overallAvg = portfolioAvgStake && portfolioAvgStake > 0 ? portfolioAvgStake : computeCohortAvgStake(wagers);

    function effectiveAvgFor(w) {
      if (rowDim === "bet_type" || colDim === "bet_type") {
        return avgByCohort[w.bet_type] || overallAvg;
      }
      return overallAvg;
    }

    const rowGroups = new Map();
    const colGroups = new Map();
    const cellGroups = new Map();

    wagers.forEach((w) => {
      const wAvg = effectiveAvgFor(w);
      const rk = getDimensionValue(w, rowDim, wAvg);
      const ck = getDimensionValue(w, colDim, wAvg);
      if (!rowGroups.has(rk)) rowGroups.set(rk, []);
      rowGroups.get(rk).push(w);
      if (!colGroups.has(ck)) colGroups.set(ck, []);
      colGroups.get(ck).push(w);
      const cellKey = `${rk}|||${ck}`;
      if (!cellGroups.has(cellKey)) cellGroups.set(cellKey, []);
      cellGroups.get(cellKey).push(w);
    });

    const rowKeys = sortDimensionKeys(rowDim, rowGroups.keys());
    const colKeys = sortDimensionKeys(colDim, colGroups.keys());

    const rows = rowKeys.map((rk) => {
      const cells = {};
      colKeys.forEach((ck) => {
        const cw = cellGroups.get(`${rk}|||${ck}`) || [];
        const cellBaseAvg = avgByCohort[ck] || avgByCohort[rk] || overallAvg;
        cells[ck] = {
          wagers: cw,
          ...computeBucketMetrics(cw, cellBaseAvg, outsizedMult)
        };
      });
      const rWagers = rowGroups.get(rk) || [];
      const rowBaseAvg = avgByCohort[rk] || overallAvg;
      return {
        row_key: rk,
        cells,
        row_total: {
          wagers: rWagers,
          ...computeBucketMetrics(rWagers, rowBaseAvg, outsizedMult)
        }
      };
    });

    const colTotals = {};
    colKeys.forEach((ck) => {
      const cWagers = colGroups.get(ck) || [];
      const colBaseAvg = avgByCohort[ck] || overallAvg;
      colTotals[ck] = {
        wagers: cWagers,
        ...computeBucketMetrics(cWagers, colBaseAvg, outsizedMult)
      };
    });

    return {
      row_dim: rowDim,
      row_label: DIMENSIONS[rowDim] || rowDim,
      col_dim: colDim,
      col_label: DIMENSIONS[colDim] || colDim,
      portfolio_avg_stake: round2(overallAvg),
      row_keys: rowKeys,
      col_keys: colKeys,
      rows,
      col_totals: colTotals,
      grand_total: {
        wagers,
        ...computeBucketMetrics(wagers, overallAvg, outsizedMult)
      }
    };
  }

  function buildSourceCombination(pools, sourceMode) {
    const cash = pools.cash || [];
    const modelEv = pools.modelEv || [];
    const modelCard = pools.modelCard || [];
    const modelLean = pools.modelLean || [];
    const paper = pools.paper || [];

    const cashSigSet = new Set(cash.map(propSignature));
    const modelEvSigSet = new Set(modelEv.map(propSignature));

    switch (String(sourceMode || "MODEL_EV").toUpperCase()) {
      case "CASH":
        return cash;
      case "MODEL_EV":
        return modelEv.map((m) => ({
          ...m,
          wager_action: cashSigSet.has(propSignature(m)) ? "Placed (Cash)" : "Unbet (Model Only)"
        }));
      case "MODEL_CARD":
      case "MODEL":
        return modelCard.map((m) => ({
          ...m,
          wager_action: cashSigSet.has(propSignature(m)) ? "Placed (Cash)" : "Unbet (Model Only)"
        }));
      case "MODEL_LEAN":
        return modelLean;
      case "CASH_AND_MODEL":
        // Cash bets that were also +EV Model selections
        return cash.filter((c) => modelEvSigSet.has(propSignature(c)) || (c.edge_pct !== null && c.edge_pct > 0));
      case "CASH_OFF_MODEL":
        // Cash bets placed without a +EV Model edge
        return cash.filter((c) => !modelEvSigSet.has(propSignature(c)) && (c.edge_pct === null || c.edge_pct <= 0));
      case "MODEL_UNBET":
        // +EV Model selections that were NOT bet with Cash
        return modelEv.filter((m) => !cashSigSet.has(propSignature(m)));
      case "COMPARE_CASH_MODEL":
        return cash.concat(modelCard).concat(modelEv);
      case "PAPER_SANDBOX":
      case "PAPER":
        return paper;
      default:
        return modelEv;
    }
  }

  function filterWagers(wagers, filters = {}) {
    const bt = String(filters.betType || "ALL").toUpperCase();
    const sb = String(filters.sportsbook || "ALL").toLowerCase();
    const mk = String(filters.market || "ALL").toLowerCase();
    const sel = String(filters.selection || "ALL").toLowerCase();
    const ln = String(filters.line || "ALL").trim();
    const eb = String(filters.edgeBucket || "ALL").trim();
    const ob = String(filters.oddsBucket || "ALL").trim();
    const tm = String(filters.team || "ALL").trim().toUpperCase();
    const lastNSlates = Number(filters.lastNSlates) || 0;
    const dateFrom = String(filters.dateFrom || "").trim().slice(0, 10);
    const dateTo = String(filters.dateTo || "").trim().slice(0, 10);

    let allowedDates = null;
    if (lastNSlates > 0) {
      const settledDates = Array.from(
        new Set(
          wagers
            .filter((w) => ["WIN", "LOSS", "PUSH"].includes(w.grade) && !isDnpVoid(w) && w.event_date)
            .map((w) => w.event_date)
        )
      ).sort();
      allowedDates = new Set(settledDates.slice(-lastNSlates));
    }

    return wagers.filter((w) => {
      if ((bt === "CASH" || bt === "LIVE") && w.bet_type !== "Cash") return false;
      if (bt === "PAPER" && w.bet_type !== "Paper") return false;
      if (bt === "MODEL" && w.bet_type !== "Model") return false;
      if (bt === "MODELEV" && w.bet_type !== "ModelEV") return false;
      if (bt === "MODELLEAN" && w.bet_type !== "ModelLean") return false;
      if (sb && sb !== "all" && w.sportsbook.toLowerCase() !== sb) return false;
      if (mk && mk !== "all" && w.market.toLowerCase() !== mk) return false;
      if (sel && sel !== "all" && w.selection.toLowerCase() !== sel) return false;
      if (ln && ln.toUpperCase() !== "ALL" && w.line !== ln) return false;
      if (eb && eb.toUpperCase() !== "ALL" && classifyEdgeBucket(w.edge_pct) !== eb) return false;
      if (ob && ob.toUpperCase() !== "ALL" && classifyOddsBucket(w.odds) !== ob) return false;
      if (tm && tm !== "ALL" && w.team.toUpperCase() !== tm) return false;
      if (allowedDates && !allowedDates.has(w.event_date)) return false;
      if (dateFrom && w.event_date && w.event_date < dateFrom) return false;
      if (dateTo && w.event_date && w.event_date > dateTo) return false;
      return true;
    });
  }

  function parseCsvText(csvText) {
    const lines = String(csvText || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length < 2) return [];

    function splitCsvRow(line) {
      const out = [];
      let cur = "";
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
          if (inQuotes && line[i + 1] === '"') {
            cur += '"';
            i++;
          } else {
            inQuotes = !inQuotes;
          }
        } else if (ch === "," && !inQuotes) {
          out.push(cur);
          cur = "";
        } else {
          cur += ch;
        }
      }
      out.push(cur);
      return out;
    }

    const headers = splitCsvRow(lines[0]).map((h) => h.trim());
    return lines.slice(1).map((line) => {
      const cols = splitCsvRow(line);
      const obj = {};
      headers.forEach((h, idx) => {
        obj[h] = cols[idx] !== undefined ? cols[idx].trim() : "";
      });
      return obj;
    });
  }

  root.VectorLineAnalytics = {
    EDGE_BUCKET_ORDER,
    ODDS_BUCKET_ORDER,
    DIMENSIONS,
    PRESET_CROSSTABS,
    normalizeWager,
    normalizeBatch,
    dedupeShadowOpen,
    computeBucketMetrics,
    computePortfolioDiagnostics,
    computeRollingTrends,
    computeWhatsFiringFeed,
    buildSourceCombination,
    buildBreakdown,
    buildCrosstab,
    filterWagers,
    parseCsvText
  };
})(typeof window !== "undefined" ? window : globalThis);
