"use strict";

(function () {
  const Engine = window.VectorLineAnalytics;
  if (!Engine) return;

  let rawLedgerRows = [];
  let rawModelKellyRows = [];
  let rawModelEvRows = [];
  let rawModelLeanRows = [];
  let cachedPools = null;
  let sourceLabel = "Loading…";

  let activeTab = "model"; // "model" | "firing" | "crosstab" | "cash" | "paper"
  let activeModelScope = "MODEL_EV"; // "MODEL_EV" | "MODEL_LEAN" | "MODEL_CARD"
  let activeFiringSource = "MODEL_EV";
  let activeCtSource = "MODEL_EV";
  let activeCtSide = "ALL";
  let activeCtLine = "ALL";

  let isUnitMode = Boolean(window.NHL_EDGE_UNITS_ONLY);
  let activePortfolioAvgStake = 10.0;
  const activeDrilldownMap = new Map();
  const activeSignalPatchMap = new Map();
  const VAULT_STORAGE_KEY = "vl_analytics_vault_pass";

  /* =========================================================================
     AES-256-GCM + GZIP VAULT DECRYPTION
     ========================================================================= */

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function decryptEncryptedSnapshot(envelope, passphrase) {
    const enc = new TextEncoder();
    const keyMaterial = await window.crypto.subtle.importKey(
      "raw",
      enc.encode(String(passphrase || "")),
      "PBKDF2",
      false,
      ["deriveKey"]
    );
    const aesKey = await window.crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: b64ToBytes(envelope.salt),
        iterations: Number(envelope.iter) || 600000,
        hash: "SHA-256"
      },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"]
    );
    const plainBuf = await window.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64ToBytes(envelope.iv) },
      aesKey,
      b64ToBytes(envelope.ct)
    );
    let jsonText;
    if (envelope.comp === "gzip" && typeof DecompressionStream === "function") {
      const ds = new DecompressionStream("gzip");
      const writer = ds.writable.getWriter();
      writer.write(new Uint8Array(plainBuf));
      writer.close();
      jsonText = await new Response(ds.readable).text();
    } else {
      jsonText = new TextDecoder().decode(plainBuf);
    }
    return JSON.parse(jsonText);
  }

  function setVaultLockedUI(locked, metaText = "") {
    const lockScreen = document.getElementById("vault-lock-screen");
    const mainShell = document.getElementById("analytics-main-shell");
    const lockBtn = document.getElementById("btn-lock-vault");
    const metaEl = document.getElementById("vault-updated-meta");
    if (lockScreen) lockScreen.hidden = !locked;
    if (mainShell) mainShell.hidden = locked;
    if (lockBtn) lockBtn.hidden = locked || !window.NHL_EDGE_ENCRYPTED_SNAPSHOT;
    if (metaEl && metaText) metaEl.textContent = metaText;
  }

  /* =========================================================================
     FORMATTERS
     ========================================================================= */

  function escHtml(str) {
    return String(str === null || str === undefined ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fmtMoney(val, signed = false, baseAvgOverride = null) {
    const raw = Number(val) || 0;
    if (isUnitMode) {
      const denom = baseAvgOverride && baseAvgOverride > 0 ? baseAvgOverride : activePortfolioAvgStake > 0 ? activePortfolioAvgStake : 10.0;
      const u = raw / denom;
      const absU = Math.abs(u).toFixed(2);
      if (!signed) return `${absU}u`;
      const sign = u > 0.004 ? "+" : u < -0.004 ? "-" : "";
      return `${sign}${absU}u`;
    }
    const absStr = Math.abs(raw).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
    if (!signed) return `$${absStr}`;
    const sign = raw > 0 ? "+" : raw < 0 ? "-" : "";
    return `${sign}$${absStr}`;
  }

  function fmtPct(val, signed = false) {
    if (val === null || val === undefined || !Number.isFinite(Number(val))) return "—";
    const v = Number(val);
    if (!signed) return `${v.toFixed(2)}%`;
    return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
  }

  function fmtOdds(odds) {
    const n = Math.round(Number(odds) || 0);
    if (!n) return "—";
    return n > 0 ? `+${n}` : `${n}`;
  }

  function valClass(v) {
    const n = Number(v) || 0;
    if (n > 0.005) return "val-pos";
    if (n < -0.005) return "val-neg";
    return "";
  }

  /* =========================================================================
     DATA INGESTION & NORMALIZED POOLS
     ========================================================================= */

  function ingestPayloadBundle(payload) {
    cachedPools = null;
    if (Array.isArray(payload)) {
      rawLedgerRows = payload.slice();
      rawModelKellyRows = [];
      rawModelEvRows = [];
      rawModelLeanRows = [];
      return;
    }
    if (payload && typeof payload === "object") {
      rawLedgerRows = []
        .concat(Array.isArray(payload.wagers) ? payload.wagers : [])
        .concat(Array.isArray(payload.settled_history) ? payload.settled_history : [])
        .concat(Array.isArray(payload.open_wagers) ? payload.open_wagers : []);
      rawModelKellyRows = Array.isArray(payload.model_kelly) ? payload.model_kelly.slice() : [];
      rawModelEvRows = Array.isArray(payload.model_ev) ? payload.model_ev.slice() : [];
      rawModelLeanRows = Array.isArray(payload.model_lean) ? payload.model_lean.slice() : [];
    }
  }

  function getPools() {
    if (cachedPools) return cachedPools;
    const normUser = Engine.normalizeBatch(rawLedgerRows, {
      paperSizingMode: "kelly_if_missing",
      bankroll: 500,
      dedupeShadows: true
    }).wagers;

    const cash = normUser.filter((w) => w.bet_type === "Cash");
    const paper = normUser.filter((w) => w.bet_type === "Paper");
    const modelCard = Engine.normalizeBatch(rawModelKellyRows, {
      paperSizingMode: "recorded",
      bankroll: 500,
      dedupeShadows: false
    }).wagers;
    const modelEv = Engine.normalizeBatch(rawModelEvRows, {
      paperSizingMode: "recorded",
      bankroll: 500,
      dedupeShadows: false
    }).wagers;
    const modelLean = Engine.normalizeBatch(rawModelLeanRows, {
      paperSizingMode: "recorded",
      bankroll: 500,
      dedupeShadows: false
    }).wagers;

    cachedPools = { cash, paper, modelCard, modelEv, modelLean };
    return cachedPools;
  }

  function populateDynamicSelects() {
    const pools = getPools();
    const allItems = pools.cash.concat(pools.modelEv).concat(pools.modelLean);

    // Cash Sportsbooks
    const bookSel = document.getElementById("cash-filter-book");
    if (bookSel) {
      const prev = bookSel.value || "ALL";
      const books = Array.from(new Set(pools.cash.map((w) => w.sportsbook).filter(Boolean))).sort();
      bookSel.innerHTML =
        `<option value="ALL">All Books</option>` +
        books.map((b) => `<option value="${escHtml(b)}">${escHtml(b)}</option>`).join("");
      if (books.includes(prev)) bookSel.value = prev;
    }

    // Teams
    const teamSel = document.getElementById("ct-filter-team");
    if (teamSel) {
      const prev = teamSel.value || "ALL";
      const teams = Array.from(new Set(allItems.map((w) => w.team).filter(Boolean))).sort();
      teamSel.innerHTML =
        `<option value="ALL">All Teams</option>` +
        teams.map((t) => `<option value="${escHtml(t)}">${escHtml(t)}</option>`).join("");
      if (teams.includes(prev)) teamSel.value = prev;
    }

    // Edge % Bands
    const edgeSel = document.getElementById("ct-filter-edge");
    if (edgeSel && edgeSel.options.length <= 1) {
      edgeSel.innerHTML =
        `<option value="ALL">All Edge Bands</option>` +
        Engine.EDGE_BUCKET_ORDER.filter((b) => b !== "Unmodeled")
          .map((b) => `<option value="${escHtml(b)}">${escHtml(b)}</option>`)
          .join("");
    }

    // Moneyline Bands
    const oddsSel = document.getElementById("ct-filter-odds");
    if (oddsSel && oddsSel.options.length <= 1) {
      oddsSel.innerHTML =
        `<option value="ALL">All Moneylines</option>` +
        Engine.ODDS_BUCKET_ORDER.map((b) => `<option value="${escHtml(b)}">${escHtml(b)}</option>`).join("");
    }
  }

  async function loadWagerData() {
    const pill = document.getElementById("data-source-pill");
    if (pill) pill.textContent = "Syncing…";

    // 1. Chrome Extension live storage + bundled model selections
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      try {
        const stored = await chrome.storage.local.get(["loggedWagersQueue", "settledWagersHistory"]);
        const openQ = Array.isArray(stored.loggedWagersQueue) ? stored.loggedWagersQueue : [];
        const settledH = Array.isArray(stored.settledWagersHistory) ? stored.settledWagersHistory : [];
        const snap = window.NHL_EDGE_WAGER_SNAPSHOT;
        if (snap && !Array.isArray(snap)) {
          rawModelKellyRows = Array.isArray(snap.model_kelly) ? snap.model_kelly : [];
          rawModelEvRows = Array.isArray(snap.model_ev) ? snap.model_ev : [];
          rawModelLeanRows = Array.isArray(snap.model_lean) ? snap.model_lean : [];
        }
        if (openQ.length > 0 || settledH.length > 0 || rawModelEvRows.length > 0) {
          rawLedgerRows = settledH.concat(openQ);
          cachedPools = null;
          const p = getPools();
          sourceLabel = `Extension Live (${p.modelEv.length.toLocaleString()} +EV • ${p.cash.length} Cash)`;
          populateDynamicSelects();
          renderActiveView();
          return;
        }
      } catch (_) {}
    }

    // 2. Local MCP HTTP Bridge
    const isHttpsRemote = window.location.protocol === "https:" && !/^(localhost|127\.0\.0\.1)$/i.test(window.location.hostname);
    if (!isHttpsRemote) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 1400);
        const resp = await fetch("http://127.0.0.1:8765/api/wagers", { signal: ctrl.signal });
        clearTimeout(timer);
        if (resp.ok) {
          const data = await resp.json();
          ingestPayloadBundle(data);
          const p = getPools();
          if (p.cash.length > 0 || p.modelEv.length > 0) {
            sourceLabel = `MCP Live (${p.modelEv.length.toLocaleString()} +EV • ${p.cash.length} Cash)`;
            populateDynamicSelects();
            renderActiveView();
            return;
          }
        }
      } catch (_) {}
    }

    // 3. Encrypted Vault Snapshot (GitHub Pages)
    if (window.NHL_EDGE_ENCRYPTED_SNAPSHOT && window.NHL_EDGE_ENCRYPTED_SNAPSHOT.ct) {
      const env = window.NHL_EDGE_ENCRYPTED_SNAPSHOT;
      const updatedTag = window.NHL_EDGE_SNAPSHOT_UPDATED_AT ? `Synced ${window.NHL_EDGE_SNAPSHOT_UPDATED_AT}` : "AES-256-GCM";
      let savedPass = "";
      try {
        savedPass = sessionStorage.getItem(VAULT_STORAGE_KEY) || localStorage.getItem(VAULT_STORAGE_KEY) || "";
      } catch (_) {}
      if (savedPass) {
        try {
          const unlocked = await decryptEncryptedSnapshot(env, savedPass);
          ingestPayloadBundle(unlocked);
          const p = getPools();
          sourceLabel = `🔒 Vault (${p.modelEv.length.toLocaleString()} +EV • ${p.cash.length} Cash • ${updatedTag})`;
          setVaultLockedUI(false);
          populateDynamicSelects();
          renderActiveView();
          return;
        } catch (_) {
          try {
            localStorage.removeItem(VAULT_STORAGE_KEY);
            sessionStorage.removeItem(VAULT_STORAGE_KEY);
          } catch (__) {}
        }
      }
      setVaultLockedUI(true, `AES-256-GCM Encrypted • ${updatedTag}`);
      const passInput = document.getElementById("vault-passphrase-input");
      if (passInput) passInput.focus();
      return;
    }

    // 4. Plaintext Bundled Snapshot
    if (window.NHL_EDGE_WAGER_SNAPSHOT) {
      ingestPayloadBundle(window.NHL_EDGE_WAGER_SNAPSHOT);
      const p = getPools();
      if (p.cash.length > 0 || p.modelEv.length > 0) {
        const updatedTag = window.NHL_EDGE_SNAPSHOT_UPDATED_AT ? ` • ${window.NHL_EDGE_SNAPSHOT_UPDATED_AT}` : "";
        sourceLabel = `Snapshot (${p.modelEv.length.toLocaleString()} +EV • ${p.cash.length} Cash${updatedTag})`;
        setVaultLockedUI(false);
        populateDynamicSelects();
        renderActiveView();
        return;
      }
    }

    sourceLabel = "No data loaded";
    renderActiveView();
  }

  /* =========================================================================
     SHARED UI COMPONENTS: ROLLING TRENDS, CHARTS, SIGNAL CARDS & TABLES
     ========================================================================= */

  function renderTrendsStrip(trends, stripId, badgeId, useDollarNet = false) {
    const strip = document.getElementById(stripId);
    const badge = document.getElementById(badgeId);
    if (badge) {
      badge.textContent = trends.slate_streak_label || "";
      badge.classList.toggle("is-hot", Boolean(trends.is_heating_up));
    }
    if (!strip) return;
    if (!trends.windows || trends.windows.length === 0) {
      strip.innerHTML = `<div class="panel-note">No settled slates in current filter.</div>`;
      return;
    }

    strip.innerHTML = trends.windows
      .map((w) => {
        const primaryRoi = useDollarNet ? w.roi_pct : w.flat_1u_roi_pct;
        const primaryNet = useDollarNet ? fmtMoney(w.net_profit, true) : `${w.flat_1u_net >= 0 ? "+" : ""}${w.flat_1u_net.toFixed(2)}u`;
        const isL3Hot = w.id === "l3" && trends.is_heating_up;
        const slateTag = w.slate_count ? `${w.winning_slates}/${w.slate_count} slates won` : `${w.settled_count} graded`;
        return `
          <div class="trend-chip ${isL3Hot ? "is-highlight" : ""}">
            <div class="trend-chip-top">
              <span>${escHtml(w.label)}</span>
              <span>${escHtml(slateTag)}</span>
            </div>
            <div class="trend-chip-main ${valClass(primaryRoi)}">
              ${fmtPct(primaryRoi, true)}
              <span style="font-size:0.8rem;font-weight:600;color:var(--text-primary);margin-inline-start:0.3rem;">(${primaryNet})</span>
            </div>
            <div class="trend-chip-sub">
              Record <strong>${escHtml(w.record)}</strong> (${w.win_rate_pct.toFixed(1)}% vs ${w.breakeven_pct.toFixed(1)}% BE)
            </div>
          </div>
        `;
      })
      .join("");
  }

  function renderDailySlateBarsChart(dailySlates, mountId, useDollars = false) {
    const mount = document.getElementById(mountId);
    if (!mount) return;
    if (!dailySlates || dailySlates.length === 0) {
      mount.innerHTML = `<div style="padding:2.2rem;text-align:center;color:var(--text-muted);">No settled slates to plot.</div>`;
      return;
    }

    const W = 540;
    const H = 215;
    const padL = 44;
    const padR = 16;
    const padT = 16;
    const padB = 30;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const vals = dailySlates.map((d) => (useDollars ? d.net_profit : d.flat_1u_net));
    const maxAbs = Math.max(2, ...vals.map((v) => Math.abs(v))) * 1.12;
    const zeroY = padT + plotH / 2;
    const slotW = plotW / dailySlates.length;
    const barW = Math.max(6, Math.min(28, slotW * 0.68));

    const bars = dailySlates
      .map((d, i) => {
        const v = useDollars ? d.net_profit : d.flat_1u_net;
        const barH = Math.max(2, (Math.abs(v) / maxAbs) * (plotH / 2));
        const x = padL + i * slotW + (slotW - barW) / 2;
        const y = v >= 0 ? zeroY - barH : zeroY;
        const col = v >= 0 ? "#38b06f" : "#e05252";
        const showLbl = dailySlates.length <= 10 || i % 2 === 0 || i === dailySlates.length - 1;
        const unitLbl = useDollars ? fmtMoney(v, true) : `${v >= 0 ? "+" : ""}${v.toFixed(2)}u`;
        return `
          <g>
            <title>${escHtml(d.date)} • Record ${escHtml(d.record)} (${d.win_rate_pct.toFixed(1)}%) • Net: ${unitLbl} (${fmtPct(useDollars ? d.roi_pct : d.flat_1u_roi_pct, true)} ROI)</title>
            <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" rx="2" fill="${col}" />
            ${showLbl ? `<text x="${(x + barW / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle" fill="#7f8892" font-size="9.5">${escHtml(d.shortDate)}</text>` : ""}
          </g>
        `;
      })
      .join("");

    mount.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily slate net units bar chart">
        <line x1="${padL}" y1="${(padT + 8).toFixed(1)}" x2="${W - padR}" y2="${(padT + 8).toFixed(1)}" stroke="#262b31" stroke-dasharray="3,3" />
        <line x1="${padL}" y1="${(H - padB - 8).toFixed(1)}" x2="${W - padR}" y2="${(H - padB - 8).toFixed(1)}" stroke="#262b31" stroke-dasharray="3,3" />
        <line x1="${padL}" y1="${zeroY.toFixed(1)}" x2="${W - padR}" y2="${zeroY.toFixed(1)}" stroke="#5c646d" stroke-width="1" />
        <text x="${padL - 6}" y="${padT + 11}" text-anchor="end" fill="#7f8892" font-size="9.5">+${maxAbs.toFixed(0)}u</text>
        <text x="${padL - 6}" y="${zeroY + 3}" text-anchor="end" fill="#7f8892" font-size="9.5">0</text>
        <text x="${padL - 6}" y="${H - padB - 5}" text-anchor="end" fill="#7f8892" font-size="9.5">-${maxAbs.toFixed(0)}u</text>
        ${bars}
      </svg>
    `;
  }

  function renderEquityTrajectoryChart(wagers, mountId, showSizedOverlay = false) {
    const mount = document.getElementById(mountId);
    if (!mount) return;

    const settled = (wagers || [])
      .filter((w) => ["WIN", "LOSS", "PUSH"].includes(w.grade) && !String(w.result_stat || "").startsWith("DNP"))
      .slice()
      .sort((a, b) => String(a.event_date || "").localeCompare(String(b.event_date || "")));

    if (settled.length === 0) {
      mount.innerHTML = `<div style="padding:2.2rem;text-align:center;color:var(--text-muted);">No settled selections to plot.</div>`;
      return;
    }

    const baseAvg = activePortfolioAvgStake > 0 ? activePortfolioAvgStake : 10;
    const byDate = new Map();
    settled.forEach((w) => {
      const d = w.event_date || "Unknown";
      if (!byDate.has(d)) byDate.set(d, { actualU: 0, flatU: 0 });
      const e = byDate.get(d);
      e.actualU += w.net_profit / baseAvg;
      e.flatU += w.unit_return;
    });

    const pts = [{ label: "Start", cumActual: 0, cumFlat: 0 }];
    let cAct = 0;
    let cFlat = 0;
    Array.from(byDate.keys())
      .sort()
      .forEach((d) => {
        const item = byDate.get(d);
        cAct += item.actualU;
        cFlat += item.flatU;
        pts.push({ label: d.slice(5), fullDate: d, cumActual: cAct, cumFlat: cFlat });
      });

    const W = 540;
    const H = 215;
    const padL = 44;
    const padR = 16;
    const padT = 16;
    const padB = 30;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const allVals = pts.flatMap((p) => (showSizedOverlay ? [p.cumActual, p.cumFlat, 0] : [p.cumFlat, 0]));
    const minY = Math.min(...allVals) - 0.8;
    const maxY = Math.max(...allVals) + 0.8;
    const spanY = Math.max(1, maxY - minY);

    const xAt = (i) => padL + (pts.length <= 1 ? plotW / 2 : (i / (pts.length - 1)) * plotW);
    const yAt = (v) => padT + ((maxY - v) / spanY) * plotH;
    const zeroY = yAt(0);

    const flatPoly = pts.map((p, i) => `${xAt(i).toFixed(1)},${yAt(p.cumFlat).toFixed(1)}`).join(" ");
    const actualPoly = pts.map((p, i) => `${xAt(i).toFixed(1)},${yAt(p.cumActual).toFixed(1)}`).join(" ");

    const xLabels = pts
      .map((p, i) => {
        if (pts.length > 8 && i % 2 === 1 && i !== pts.length - 1) return "";
        return `<text x="${xAt(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" fill="#7f8892" font-size="9.5">${escHtml(p.label)}</text>`;
      })
      .join("");

    const dots = pts
      .map(
        (p, i) => `
        <circle cx="${xAt(i).toFixed(1)}" cy="${yAt(showSizedOverlay ? p.cumActual : p.cumFlat).toFixed(1)}" r="3.4" fill="#38b06f">
          <title>${escHtml(p.fullDate || p.label)} • 1u Cumulative: ${p.cumFlat >= 0 ? "+" : ""}${p.cumFlat.toFixed(2)}u${showSizedOverlay ? ` | Sized: ${p.cumActual >= 0 ? "+" : ""}${p.cumActual.toFixed(2)}u` : ""}</title>
        </circle>
      `
      )
      .join("");

    mount.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Cumulative trajectory chart">
        <line x1="${padL}" y1="${zeroY.toFixed(1)}" x2="${W - padR}" y2="${zeroY.toFixed(1)}" stroke="#5c646d" stroke-width="1" />
        <text x="${padL - 6}" y="${(yAt(maxY - spanY * 0.1) + 3).toFixed(1)}" text-anchor="end" fill="#7f8892" font-size="9.5">+${(maxY - spanY * 0.1).toFixed(1)}u</text>
        <text x="${padL - 6}" y="${(zeroY + 3).toFixed(1)}" text-anchor="end" fill="#7f8892" font-size="9.5">0u</text>
        <text x="${padL - 6}" y="${(yAt(minY + spanY * 0.1) + 3).toFixed(1)}" text-anchor="end" fill="#7f8892" font-size="9.5">${(minY + spanY * 0.1).toFixed(1)}u</text>
        ${
          showSizedOverlay
            ? `<polyline fill="none" stroke="#4dabf7" stroke-width="2" stroke-dasharray="4,3" points="${flatPoly}" />
               <polyline fill="none" stroke="#38b06f" stroke-width="2.5" points="${actualPoly}" />`
            : `<polyline fill="none" stroke="#38b06f" stroke-width="2.5" points="${flatPoly}" />`
        }
        ${dots}
        ${xLabels}
      </svg>
    `;
  }

  function renderSignalCardsList(signals, mountId, sourceForJump, isCold = false) {
    const mount = document.getElementById(mountId);
    if (!mount) return;
    if (!signals || signals.length === 0) {
      mount.innerHTML = `<div class="panel-note" style="padding:0.5rem 0;">No qualifying pockets in current sample yet.</div>`;
      return;
    }

    mount.innerHTML = signals
      .map((sig) => {
        const patchId = `sig-${Math.random().toString(36).slice(2, 9)}`;
        activeSignalPatchMap.set(patchId, { source: sourceForJump, patch: sig.filter_patch || {} });
        const beatSign = sig.beat_market_pct >= 0 ? "+" : "";
        return `
          <article class="signal-card ${isCold ? "is-cold" : ""}">
            <div class="signal-card-top">
              <span class="signal-cat-tag">${escHtml(sig.icon || "🔥")} ${escHtml(sig.category)}</span>
              <span class="signal-l5-pill">Last 5: ${escHtml(sig.last5_str)}</span>
            </div>
            <div class="signal-headline">${escHtml(sig.headline)}</div>
            <div class="signal-metrics-row">
              <span><strong>${escHtml(sig.record)}</strong> (${sig.win_rate_pct.toFixed(1)}% • ${beatSign}${sig.beat_market_pct.toFixed(1)}% vs BE)</span>
              <strong class="${valClass(sig.flat_1u_roi_pct)}">${fmtPct(sig.flat_1u_roi_pct, true)} 1u ROI</strong>
            </div>
            <button type="button" class="signal-inspect-btn" data-sig-jump="${patchId}">Inspect in Cross-Tab →</button>
          </article>
        `;
      })
      .join("");

    mount.querySelectorAll("[data-sig-jump]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const entry = activeSignalPatchMap.get(btn.getAttribute("data-sig-jump"));
        if (entry) jumpToCrossTabWithPatch(entry.source, entry.patch);
      });
    });
  }

  function render1DBreakdownTable(wagers, dim, mountId) {
    const mount = document.getElementById(mountId);
    if (!mount) return;
    const bd = Engine.buildBreakdown(wagers, dim, null, 1.5);
    if (bd.rows.length === 0) {
      mount.innerHTML = `<div style="padding:1rem;color:var(--text-muted);">No selections match this filter.</div>`;
      return;
    }

    function rowHtml(r, isTotal) {
      const label = isTotal ? "ALL TOTAL" : r.key;
      const oversCnt = (r.wagers || []).filter((w) => w.selection === "Over" && (w.grade === "WIN" || w.grade === "LOSS")).length;
      const undersCnt = (r.wagers || []).filter((w) => w.selection === "Under" && (w.grade === "WIN" || w.grade === "LOSS")).length;
      const ouSplit = isTotal
        ? `${(wagers || []).filter((w) => w.selection === "Over" && (w.grade === "WIN" || w.grade === "LOSS")).length} O / ${(wagers || []).filter((w) => w.selection === "Under" && (w.grade === "WIN" || w.grade === "LOSS")).length} U`
        : `${oversCnt} O / ${undersCnt} U`;
      return `
        <tr>
          <th scope="row">${escHtml(label)}</th>
          <td class="num-cell">${r.settled_count} <span style="color:var(--text-muted);">(${r.open_count})</span></td>
          <td class="center-cell">${escHtml(ouSplit)}</td>
          <td class="center-cell"><strong>${escHtml(r.record)}</strong></td>
          <td class="num-cell">${r.win_rate_pct.toFixed(1)}% <span style="color:var(--text-muted);">(${r.breakeven_win_rate_pct.toFixed(1)}%)</span></td>
          <td class="num-cell">${fmtOdds(r.avg_odds)}</td>
          <td class="num-cell">${fmtPct(r.avg_edge_pct)}</td>
          <td class="num-cell ${valClass(r.flat_1u_net_units)}" style="font-weight:700;">${r.flat_1u_net_units >= 0 ? "+" : ""}${r.flat_1u_net_units.toFixed(2)}u</td>
          <td class="num-cell ${valClass(r.flat_1u_roi_pct)}" style="font-weight:700;">${fmtPct(r.flat_1u_roi_pct, true)}</td>
        </tr>
      `;
    }

    mount.innerHTML = `
      <table class="data-table" aria-label="${escHtml(bd.dimension_label)} breakdown">
        <thead>
          <tr>
            <th scope="col">${escHtml(bd.dimension_label)}</th>
            <th scope="col">Graded (Open)</th>
            <th scope="col" style="text-align:center;">Overs / Unders</th>
            <th scope="col" style="text-align:center;">W-L</th>
            <th scope="col">Hit % (BE %)</th>
            <th scope="col">Avg ML</th>
            <th scope="col">Avg Edge</th>
            <th scope="col">1u Net</th>
            <th scope="col">1u Flat ROI</th>
          </tr>
        </thead>
        <tbody>${bd.rows.map((r) => rowHtml(r, false)).join("")}</tbody>
        <tfoot>${rowHtml(bd.totals, true)}</tfoot>
      </table>
    `;
  }

  /* =========================================================================
     VIEW 1: PURE MODEL (ALL SCANNED SELECTIONS)
     ========================================================================= */

  function renderPureModelView() {
    const pools = getPools();
    const basePool = Engine.buildSourceCombination(pools, activeModelScope);

    const captionEl = document.getElementById("model-scope-caption");
    if (captionEl) {
      if (activeModelScope === "MODEL_EV") {
        captionEl.textContent = "Showing every scanned sportsbook prop where Model Edge > 0% (at most 1 side per prop — never 50/50 double-sided).";
      } else if (activeModelScope === "MODEL_LEAN") {
        captionEl.textContent = "Showing 1 pure model directional pick on 100% of scanned props (favored side vs. zero-vig sportsbook odds).";
      } else {
        captionEl.textContent = "Showing concentrated Simultaneous Kelly game-card recommendations (1 best prop per player, max 6 per game).";
      }
    }

    const market = (document.getElementById("model-filter-market") || {}).value || "ALL";
    const selection = (document.getElementById("model-filter-side") || {}).value || "ALL";
    const line = (document.getElementById("model-filter-line") || {}).value || "ALL";

    const filtered = Engine.filterWagers(basePool, { market, selection, line });
    const diag = Engine.computePortfolioDiagnostics(filtered, 1.5);
    const s = diag.summary;
    activePortfolioAvgStake = s.portfolio_avg_stake || 10.0;

    const trends = Engine.computeRollingTrends(filtered);
    renderTrendsStrip(trends, "model-trends-strip", "model-streak-badge", false);

    // Compute explicit Overs vs Unders split so user sees both sides immediately
    const overM = Engine.computeBucketMetrics(filtered.filter((w) => w.selection === "Over"));
    const underM = Engine.computeBucketMetrics(filtered.filter((w) => w.selection === "Under"));

    const kpiGrid = document.getElementById("model-kpi-grid");
    if (kpiGrid) {
      kpiGrid.innerHTML = `
        <div class="kpi-card">
          <div class="kpi-label">Graded Selections (${s.open_count} Open)</div>
          <div class="kpi-main">${escHtml(s.record)} <span style="font-size:0.9rem;color:var(--text-secondary);">(${s.win_rate_pct.toFixed(1)}%)</span></div>
          <div class="kpi-sub">Avg ML: <strong>${fmtOdds(s.avg_odds)}</strong> (${s.breakeven_win_rate_pct.toFixed(1)}% BE • ${s.win_vs_breakeven_pct >= 0 ? "+" : ""}${s.win_vs_breakeven_pct.toFixed(1)}% vs BE)</div>
        </div>

        <div class="kpi-card">
          <div class="kpi-label">Equal-Stake (1u Flat) ROI</div>
          <div class="kpi-main ${valClass(s.flat_1u_roi_pct)}">${fmtPct(s.flat_1u_roi_pct, true)}</div>
          <div class="kpi-sub">Net Units: <strong class="${valClass(s.flat_1u_net_units)}">${s.flat_1u_net_units >= 0 ? "+" : ""}${s.flat_1u_net_units.toFixed(2)}u</strong> • Avg Edge: <strong>${fmtPct(s.avg_edge_pct)}</strong></div>
        </div>

        <div class="kpi-card">
          <div class="kpi-label">Overs vs. Unders Split</div>
          <div class="kpi-main" style="font-size:1.04rem;">
            <span>O: ${escHtml(overM.record)} <strong class="${valClass(overM.flat_1u_roi_pct)}">(${fmtPct(overM.flat_1u_roi_pct, true)})</strong></span>
          </div>
          <div class="kpi-sub">
            U: <strong>${escHtml(underM.record)}</strong> <strong class="${valClass(underM.flat_1u_roi_pct)}">(${fmtPct(underM.flat_1u_roi_pct, true)})</strong>
          </div>
        </div>

        <div class="kpi-card">
          <div class="kpi-label">${activeModelScope === "MODEL_CARD" ? "Kelly Sized Portfolio ROI" : "Cash-Backed Execution"}</div>
          ${
            activeModelScope === "MODEL_CARD"
              ? `<div class="kpi-main ${valClass(s.roi_pct)}">${fmtPct(s.roi_pct, true)}</div>
                 <div class="kpi-sub">Sizing Δ vs 1u: <strong class="${valClass(s.sizing_impact_pct)}">${fmtPct(s.sizing_impact_pct, true)}</strong> • Avg Stake ${fmtMoney(s.avg_stake)}</div>`
              : `<div class="kpi-main">${filtered.filter((w) => w.wager_action === "Placed (Cash)").length} <span style="font-size:0.86rem;color:var(--text-secondary);">Backed w/ Cash</span></div>
                 <div class="kpi-sub"><strong>${filtered.filter((w) => w.wager_action !== "Placed (Cash)").length.toLocaleString()}</strong> Unbet Model Selections</div>`
          }
        </div>
      `;
    }

    renderDailySlateBarsChart(trends.daily_slates, "chart-model-daily", false);
    renderEquityTrajectoryChart(filtered, "chart-model-equity", activeModelScope === "MODEL_CARD");

    const firing = Engine.computeWhatsFiringFeed(filtered);
    renderSignalCardsList(firing.hot_signals.slice(0, 4), "model-firing-preview", activeModelScope, false);

    const bdDim = (document.getElementById("model-breakdown-dim") || {}).value || "edge_bucket";
    render1DBreakdownTable(filtered, bdDim, "model-breakdown-mount");
  }

  /* =========================================================================
     VIEW 2: WHAT'S FIRING (TRENDING NEWSFEED)
     ========================================================================= */

  function renderWhatsFiringView() {
    const pools = getPools();
    const wagers = Engine.buildSourceCombination(pools, activeFiringSource);
    const useDollar = activeFiringSource === "CASH" || activeFiringSource === "CASH_AND_MODEL";

    const trends = Engine.computeRollingTrends(wagers);
    renderTrendsStrip(trends, "firing-trends-strip", "firing-streak-badge", useDollar);

    const feed = Engine.computeWhatsFiringFeed(wagers);
    renderSignalCardsList(feed.hot_signals.slice(0, 6), "firing-headlines-grid", activeFiringSource, false);
    renderSignalCardsList(feed.team_signals.slice(0, 6), "firing-teams-grid", activeFiringSource, false);
    renderSignalCardsList(feed.player_signals.slice(0, 6), "firing-players-grid", activeFiringSource, false);
    renderSignalCardsList(feed.market_signals.slice(0, 6), "firing-markets-grid", activeFiringSource, false);
    renderSignalCardsList(feed.cold_traps.slice(0, 5), "firing-cold-grid", activeFiringSource, true);
  }

  /* =========================================================================
     VIEW 3: GRANULAR 2D CROSS-TAB EXPLORER
     ========================================================================= */

  function cellHeatClass(c, mode) {
    if (!c || c.settled_count === 0) return "empty-cell";
    if (mode === "calibration") {
      if (c.win_vs_breakeven_pct >= 5) return "pos-strong";
      if (c.win_vs_breakeven_pct > 0) return "pos-mild";
      if (c.win_vs_breakeven_pct <= -6) return "neg-strong";
      return "neg-mild";
    }
    const metric = c.flat_1u_roi_pct;
    if (metric >= 12) return "pos-strong";
    if (metric > 0) return "pos-mild";
    if (metric <= -12) return "neg-strong";
    if (metric < 0) return "neg-mild";
    return "";
  }

  function renderCrosstabCellInner(c, cellMode, outsizedMult) {
    if (!c || (c.settled_count === 0 && c.open_count === 0)) {
      return `<span>—</span>`;
    }
    const cellBase = c.portfolio_avg_stake || activePortfolioAvgStake;
    if (c.settled_count === 0 && c.open_count > 0) {
      return `<div class="ct-mid-line">0 graded (${c.open_count} open)</div>`;
    }

    const szBadge = `<span class="size-badge ${c.rel_stake_vs_avg >= outsizedMult ? "is-outsized" : ""}">${c.rel_stake_vs_avg.toFixed(2)}x</span>`;

    if (cellMode === "calibration") {
      const modStr = c.avg_model_prob_pct !== null ? `Mod ${c.avg_model_prob_pct.toFixed(0)}%` : `BE ${c.breakeven_win_rate_pct.toFixed(0)}%`;
      return `
        <div class="ct-top-line"><span class="${valClass(c.win_vs_breakeven_pct)}">Hit ${c.win_rate_pct.toFixed(1)}%</span> <span style="font-size:0.72rem;color:var(--text-secondary);">${modStr}</span></div>
        <div class="ct-mid-line">vs BE: <strong class="${valClass(c.win_vs_breakeven_pct)}">${fmtPct(c.win_vs_breakeven_pct, true)}</strong> • 1u: <strong class="${valClass(c.flat_1u_roi_pct)}">${fmtPct(c.flat_1u_roi_pct, true)}</strong></div>
        <div class="ct-bot-line"><span>${escHtml(c.record)} (n=${c.settled_count})</span><span>ML ${fmtOdds(c.avg_odds)}</span></div>
      `;
    }

    if (cellMode === "rel_size") {
      return `
        <div class="ct-top-line"><span>Avg ${fmtMoney(c.avg_stake, false, cellBase)}</span> ${szBadge}</div>
        <div class="ct-mid-line">W ${c.win_rel_stake.toFixed(2)}x • L ${c.loss_rel_stake.toFixed(2)}x</div>
        <div class="ct-bot-line"><span>${escHtml(c.record)}</span><span class="${valClass(c.roi_pct)}">${fmtPct(c.roi_pct, true)}</span></div>
      `;
    }

    if (cellMode === "full") {
      return `
        <div class="ct-top-line">
          <span class="${valClass(c.roi_pct)}">${fmtPct(c.roi_pct, true)}</span>
          <span style="font-size:0.74rem;" class="${valClass(c.net_profit)}">${fmtMoney(c.net_profit, true, cellBase)}</span>
        </div>
        <div class="ct-mid-line">${escHtml(c.record)} (${c.win_rate_pct.toFixed(0)}%) • +${fmtMoney(c.amount_won, false, cellBase)} / -${fmtMoney(c.amount_lost, false, cellBase)}</div>
        <div class="ct-bot-line"><span>1u: ${fmtPct(c.flat_1u_roi_pct, true)}</span>${szBadge}</div>
      `;
    }

    // Default clean cell: 1u ROI + Record + Hit % + Avg ML
    const hasSizingDiff = Math.abs(c.roi_pct - c.flat_1u_roi_pct) >= 0.25;
    return `
      <div class="ct-top-line">
        <span class="${valClass(c.flat_1u_roi_pct)}">${fmtPct(c.flat_1u_roi_pct, true)} <small style="font-weight:500;color:var(--text-muted);">1u</small></span>
        ${hasSizingDiff ? `<span style="font-size:0.73rem;" class="${valClass(c.roi_pct)}">$ ${fmtPct(c.roi_pct, true)}</span>` : `<span style="font-size:0.72rem;color:var(--text-secondary);">ML ${fmtOdds(c.avg_odds)}</span>`}
      </div>
      <div class="ct-mid-line"><strong>${escHtml(c.record)}</strong> (${c.win_rate_pct.toFixed(1)}% vs ${c.breakeven_win_rate_pct.toFixed(0)}% BE)</div>
      <div class="ct-bot-line"><span>Net ${c.flat_1u_net_units >= 0 ? "+" : ""}${c.flat_1u_net_units.toFixed(2)}u</span><span>n=${c.settled_count}</span></div>
    `;
  }

  function renderPresetPills() {
    const wrap = document.getElementById("preset-crosstab-pills");
    if (!wrap) return;
    const curRow = (document.getElementById("ct-row-dim") || {}).value;
    const curCol = (document.getElementById("ct-col-dim") || {}).value;

    wrap.innerHTML = Engine.PRESET_CROSSTABS.map((p) => {
      const isActive = p.rowDim === curRow && p.colDim === curCol;
      return `<button type="button" class="preset-pill ${isActive ? "active" : ""}" data-row="${p.rowDim}" data-col="${p.colDim}">${escHtml(p.label)}</button>`;
    }).join("");

    wrap.querySelectorAll(".preset-pill").forEach((btn) => {
      btn.addEventListener("click", () => {
        const rSel = document.getElementById("ct-row-dim");
        const cSel = document.getElementById("ct-col-dim");
        if (rSel) rSel.value = btn.getAttribute("data-row");
        if (cSel) cSel.value = btn.getAttribute("data-col");
        renderCrossTabView();
      });
    });
  }

  function renderCrossTabView() {
    const pools = getPools();
    const sourcePool = Engine.buildSourceCombination(pools, activeCtSource);

    const market = (document.getElementById("ct-filter-market") || {}).value || "ALL";
    const edgeBucket = (document.getElementById("ct-filter-edge") || {}).value || "ALL";
    const oddsBucket = (document.getElementById("ct-filter-odds") || {}).value || "ALL";
    const team = (document.getElementById("ct-filter-team") || {}).value || "ALL";
    const lastNSlates = Number((document.getElementById("ct-filter-window") || {}).value) || 0;

    const filtered = Engine.filterWagers(sourcePool, {
      market,
      selection: activeCtSide,
      line: activeCtLine,
      edgeBucket,
      oddsBucket,
      team,
      lastNSlates
    });

    const rowSel = document.getElementById("ct-row-dim");
    const colSel = document.getElementById("ct-col-dim");
    const cellMode = (document.getElementById("ct-cell-mode") || {}).value || "roi_vs_flat";

    let rowDim = (rowSel && rowSel.value) || "edge_bucket";
    let colDim = (colSel && colSel.value) || "odds_bucket";
    if (activeCtSource === "COMPARE_CASH_MODEL" && rowDim !== "bet_type" && colDim !== "bet_type") {
      colDim = "bet_type";
      if (colSel) colSel.value = "bet_type";
    }

    renderPresetPills();

    const summaryBar = document.getElementById("ct-slice-summary");
    const sm = Engine.computeBucketMetrics(filtered);
    activePortfolioAvgStake = sm.portfolio_avg_stake || 10.0;
    const oversN = filtered.filter((w) => w.selection === "Over" && (w.grade === "WIN" || w.grade === "LOSS")).length;
    const undersN = filtered.filter((w) => w.selection === "Under" && (w.grade === "WIN" || w.grade === "LOSS")).length;

    const activeTags = [
      activeCtSource.replace(/_/g, " "),
      market !== "ALL" ? market : null,
      activeCtSide !== "ALL" ? `${activeCtSide}s Only` : "Overs + Unders",
      activeCtLine !== "ALL" ? `Total ${activeCtLine}` : null,
      edgeBucket !== "ALL" ? `Edge ${edgeBucket}` : null,
      oddsBucket !== "ALL" ? `ML ${oddsBucket}` : null,
      team !== "ALL" ? `Team ${team}` : null,
      lastNSlates > 0 ? `Last ${lastNSlates} Slates` : null
    ].filter(Boolean);

    if (summaryBar) {
      summaryBar.innerHTML = `
        <div>
          <strong>Active Slice:</strong> ${escHtml(activeTags.join(" • "))}
          <span style="color:var(--text-secondary);margin-inline-start:0.5rem;">(${oversN} Overs • ${undersN} Unders)</span>
        </div>
        <div>
          Record: <strong>${escHtml(sm.record)}</strong> (${sm.win_rate_pct.toFixed(1)}%) •
          1u ROI: <strong class="${valClass(sm.flat_1u_roi_pct)}">${fmtPct(sm.flat_1u_roi_pct, true)}</strong> •
          Dollar ROI: <strong class="${valClass(sm.roi_pct)}">${fmtPct(sm.roi_pct, true)}</strong>
        </div>
      `;
    }

    const mount = document.getElementById("crosstab-mount");
    if (!mount) return;
    activeDrilldownMap.clear();

    const ct = Engine.buildCrosstab(filtered, rowDim, colDim, null, 1.5);
    if (ct.row_keys.length === 0 || ct.col_keys.length === 0) {
      mount.innerHTML = `<div style="padding:1.4rem;color:var(--text-muted);">No selections match this filter combination. Click <strong>↺ Reset Filters</strong> to widen.</div>`;
      return;
    }

    let cellSeq = 0;
    function regDrill(title, cellObj) {
      if (!cellObj || !cellObj.wagers || cellObj.wagers.length === 0) return "";
      const id = `drill-${++cellSeq}`;
      activeDrilldownMap.set(id, { title, cell: cellObj });
      return `data-drill-id="${id}"`;
    }

    const theadCols = ct.col_keys.map((ck) => `<th scope="col" style="text-align:center;">${escHtml(ck)}</th>`).join("");
    const bodyRows = ct.rows
      .map((r) => {
        const tds = ct.col_keys
          .map((ck) => {
            const c = r.cells[ck];
            return `<td class="ct-cell ${cellHeatClass(c, cellMode)}" ${regDrill(`${r.row_key} × ${ck}`, c)}>${renderCrosstabCellInner(c, cellMode, 1.5)}</td>`;
          })
          .join("");
        const rt = r.row_total;
        return `
          <tr>
            <th scope="row">${escHtml(r.row_key)}</th>
            ${tds}
            <td class="ct-cell ${cellHeatClass(rt, cellMode)}" ${regDrill(`Row Total: ${r.row_key}`, rt)} style="border-inline-start:2px solid var(--border-strong);">
              ${renderCrosstabCellInner(rt, cellMode, 1.5)}
            </td>
          </tr>
        `;
      })
      .join("");

    const colTotCells = ct.col_keys
      .map((ck) => {
        const ctCell = ct.col_totals[ck];
        return `<td class="ct-cell ${cellHeatClass(ctCell, cellMode)}" ${regDrill(`Column Total: ${ck}`, ctCell)}>${renderCrosstabCellInner(ctCell, cellMode, 1.5)}</td>`;
      })
      .join("");
    const gt = ct.grand_total;

    mount.innerHTML = `
      <table class="data-table" aria-label="${escHtml(ct.row_label)} by ${escHtml(ct.col_label)} cross-tab">
        <thead>
          <tr>
            <th scope="col">${escHtml(ct.row_label)} \\ ${escHtml(ct.col_label)}</th>
            ${theadCols}
            <th scope="col" style="text-align:center;border-inline-start:2px solid var(--border-strong);">Row Total</th>
          </tr>
        </thead>
        <tbody>${bodyRows}</tbody>
        <tfoot>
          <tr>
            <th scope="row">Col Total</th>
            ${colTotCells}
            <td class="ct-cell ${cellHeatClass(gt, cellMode)}" ${regDrill("Grand Total", gt)} style="border-inline-start:2px solid var(--border-strong);">
              ${renderCrosstabCellInner(gt, cellMode, 1.5)}
            </td>
          </tr>
        </tfoot>
      </table>
    `;

    mount.querySelectorAll("[data-drill-id]").forEach((td) => {
      td.addEventListener("click", () => {
        const entry = activeDrilldownMap.get(td.getAttribute("data-drill-id"));
        if (entry) openDrilldownModal(entry.title, entry.cell);
      });
    });
  }

  function jumpToCrossTabWithPatch(sourceMode, patch) {
    activeCtSource = sourceMode || "MODEL_EV";
    document.querySelectorAll("#ct-source-pills [data-ct-source]").forEach((b) => {
      b.setAttribute("aria-pressed", b.getAttribute("data-ct-source") === activeCtSource ? "true" : "false");
    });

    activeCtSide = patch.selection || "ALL";
    document.querySelectorAll("#ct-side-pills [data-ct-side]").forEach((b) => {
      b.setAttribute("aria-pressed", b.getAttribute("data-ct-side") === activeCtSide ? "true" : "false");
    });

    activeCtLine = patch.line || "ALL";
    document.querySelectorAll("#ct-line-pills [data-ct-line]").forEach((b) => {
      b.setAttribute("aria-pressed", b.getAttribute("data-ct-line") === activeCtLine ? "true" : "false");
    });

    const mkSel = document.getElementById("ct-filter-market");
    if (mkSel) mkSel.value = patch.market || "ALL";
    const ebSel = document.getElementById("ct-filter-edge");
    if (ebSel) ebSel.value = patch.edgeBucket || "ALL";
    const obSel = document.getElementById("ct-filter-odds");
    if (obSel) obSel.value = patch.oddsBucket || "ALL";
    const tmSel = document.getElementById("ct-filter-team");
    if (tmSel) tmSel.value = patch.team || "ALL";
    const winSel = document.getElementById("ct-filter-window");
    if (winSel) winSel.value = "0";

    switchWorkspaceTab("crosstab");
  }

  /* =========================================================================
     VIEW 4: CASH WAGERS LEDGER
     ========================================================================= */

  function renderCashScatterChart(wagers, mountId) {
    const mount = document.getElementById(mountId);
    if (!mount) return;
    const settled = (wagers || []).filter((w) => w.grade === "WIN" || w.grade === "LOSS");
    if (settled.length === 0) {
      mount.innerHTML = `<div style="padding:2.2rem;text-align:center;color:var(--text-muted);">No decided Cash wagers to plot.</div>`;
      return;
    }

    const baseAvg = activePortfolioAvgStake > 0 ? activePortfolioAvgStake : 10;
    const W = 540;
    const H = 215;
    const padL = 44;
    const padR = 18;
    const padT = 16;
    const padB = 30;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const pts = settled.map((w) => ({
      w,
      relX: baseAvg > 0 ? w.stake / baseAvg : 1,
      retU: baseAvg > 0 ? w.net_profit / baseAvg : w.unit_return
    }));

    const maxX = Math.max(2.1, ...pts.map((p) => p.relX)) + 0.1;
    const minX = Math.max(0.2, Math.min(0.4, ...pts.map((p) => p.relX)) - 0.1);
    const maxY = Math.max(1.8, ...pts.map((p) => p.retU)) + 0.25;
    const minY = Math.min(-2.1, ...pts.map((p) => p.retU)) - 0.25;

    const xAt = (rx) => padL + ((rx - minX) / (maxX - minX)) * plotW;
    const yAt = (ry) => padT + ((maxY - ry) / (maxY - minY)) * plotH;
    const zeroY = yAt(0);
    const avgX = xAt(1.0);
    const outX = xAt(1.5);

    const circles = pts
      .map((p) => {
        const col = p.w.grade === "WIN" ? "#38b06f" : "#e05252";
        return `
          <circle cx="${xAt(p.relX).toFixed(1)}" cy="${yAt(p.retU).toFixed(1)}" r="${p.relX >= 1.5 ? "5" : "3.8"}" fill="${col}" fill-opacity="0.84" stroke="#131518" stroke-width="1">
            <title>${escHtml(p.w.event_date)} • ${escHtml(p.w.player_team)} (${escHtml(p.w.market)} ${escHtml(p.w.selection)} ${escHtml(p.w.line)} @ ${fmtOdds(p.w.odds)}) • Stake: ${p.relX.toFixed(2)}x (${fmtMoney(p.w.stake)}) • P&amp;L: ${fmtMoney(p.w.net_profit, true)}</title>
          </circle>
        `;
      })
      .join("");

    mount.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Cash Stake Multiple vs Net Return scatter">
        <line x1="${padL}" y1="${zeroY.toFixed(1)}" x2="${W - padR}" y2="${zeroY.toFixed(1)}" stroke="#5c646d" stroke-width="1" />
        <line x1="${avgX.toFixed(1)}" y1="${padT}" x2="${avgX.toFixed(1)}" y2="${H - padB}" stroke="#495057" stroke-dasharray="3,3" />
        <line x1="${outX.toFixed(1)}" y1="${padT}" x2="${outX.toFixed(1)}" y2="${H - padB}" stroke="#f59f00" stroke-dasharray="4,3" />
        <text x="${avgX.toFixed(1)}" y="${H - 8}" text-anchor="middle" fill="#7f8892" font-size="9.5">1.0x Avg</text>
        <text x="${outX.toFixed(1)}" y="${padT + 9}" text-anchor="middle" fill="#ffd43b" font-size="9" font-weight="700">1.50x Outsized</text>
        ${circles}
      </svg>
    `;
  }

  function renderCashView() {
    const pools = getPools();
    const sportsbook = (document.getElementById("cash-filter-book") || {}).value || "ALL";
    const market = (document.getElementById("cash-filter-market") || {}).value || "ALL";
    const selection = (document.getElementById("cash-filter-side") || {}).value || "ALL";

    const filtered = Engine.filterWagers(pools.cash, { sportsbook, market, selection });
    const diag = Engine.computePortfolioDiagnostics(filtered, 1.5);
    const s = diag.summary;
    activePortfolioAvgStake = s.portfolio_avg_stake || 10.0;

    const trends = Engine.computeRollingTrends(filtered);
    renderTrendsStrip(trends, "cash-trends-strip", "cash-streak-badge", true);

    const overCash = Engine.computeBucketMetrics(filtered.filter((w) => w.selection === "Over"), activePortfolioAvgStake);
    const underCash = Engine.computeBucketMetrics(filtered.filter((w) => w.selection === "Under"), activePortfolioAvgStake);

    const kpiGrid = document.getElementById("cash-kpi-grid");
    if (kpiGrid) {
      kpiGrid.innerHTML = `
        <div class="kpi-card">
          <div class="kpi-label">Cash Record (${s.settled_count} Settled • ${s.open_count} Open)</div>
          <div class="kpi-main">${escHtml(s.record)} <span style="font-size:0.9rem;color:var(--text-secondary);">(${s.win_rate_pct.toFixed(1)}%)</span></div>
          <div class="kpi-sub">Overs: <strong>${escHtml(overCash.record)}</strong> • Unders: <strong>${escHtml(underCash.record)}</strong></div>
        </div>

        <div class="kpi-card">
          <div class="kpi-label">Wagered • Won (+) / Lost (−)</div>
          <div class="kpi-main">${fmtMoney(s.total_wagered)}</div>
          <div class="kpi-sub"><span class="val-pos">+${fmtMoney(s.amount_won)}</span> / <span class="val-neg">-${fmtMoney(s.amount_lost)}</span></div>
        </div>

        <div class="kpi-card">
          <div class="kpi-label">Actual Dollar ROI vs. 1u Flat</div>
          <div class="kpi-main ${valClass(s.roi_pct)}">${fmtPct(s.roi_pct, true)}</div>
          <div class="kpi-sub">Net <strong class="${valClass(s.net_profit)}">${fmtMoney(s.net_profit, true)}</strong> • 1u Flat: <strong class="${valClass(s.flat_1u_roi_pct)}">${fmtPct(s.flat_1u_roi_pct, true)}</strong> (Δ ${fmtPct(s.sizing_impact_pct, true)})</div>
        </div>

        <div class="kpi-card">
          <div class="kpi-label">Relative Bet Size</div>
          <div class="kpi-main">${fmtMoney(s.avg_stake)} <span style="font-size:0.86rem;color:var(--text-secondary);">avg</span></div>
          <div class="kpi-sub">Max <strong>${s.max_rel_stake.toFixed(2)}x</strong> • Win <strong>${s.win_rel_stake.toFixed(2)}x</strong> vs Loss <strong>${s.loss_rel_stake.toFixed(2)}x</strong></div>
        </div>
      `;
    }

    renderEquityTrajectoryChart(filtered, "chart-cash-equity", true);
    renderCashScatterChart(filtered, "chart-cash-scatter");

    const cfGrid = document.getElementById("cash-counterfactuals-grid");
    if (cfGrid) {
      cfGrid.innerHTML = diag.counterfactuals
        .map((cf) => {
          const cleanLabel = isUnitMode ? cf.label.replace(/\s*\([^)]*\$[^)]*\)/g, "") : cf.label;
          return `
            <div class="cf-card">
              <div class="cf-title">${escHtml(cleanLabel)}</div>
              <div class="cf-note">${escHtml(cf.note || "")}</div>
              <div class="cf-roi ${valClass(cf.roi_pct)}">${fmtPct(cf.roi_pct, true)} <span style="font-size:0.8rem;">(${fmtMoney(cf.net_profit, true)})</span></div>
              <div class="cf-cashflow">Wagered ${fmtMoney(cf.total_wagered)} • +${fmtMoney(cf.amount_won)} / -${fmtMoney(cf.amount_lost)}</div>
            </div>
          `;
        })
        .join("");
    }

    const swingsMount = document.getElementById("cash-swings-mount");
    if (swingsMount) {
      const rows = diag.largest_pnl_swings || [];
      swingsMount.innerHTML =
        rows.length === 0
          ? `<div style="padding:1rem;color:var(--text-muted);">No settled Cash wagers.</div>`
          : `
            <table class="data-table" aria-label="Largest Cash wager swings">
              <thead>
                <tr>
                  <th scope="col">Date &amp; Player</th>
                  <th scope="col" style="text-align:left;">Book</th>
                  <th scope="col" style="text-align:left;">Market &amp; Side</th>
                  <th scope="col">ML</th>
                  <th scope="col">Stake (Rel)</th>
                  <th scope="col" style="text-align:center;">Grade</th>
                  <th scope="col">Net P&amp;L</th>
                  <th scope="col">ROI Impact</th>
                </tr>
              </thead>
              <tbody>
                ${rows
                  .map(
                    (w) => `
                  <tr>
                    <th scope="row">${escHtml(w.event_date)} • ${escHtml(w.player_team)} ${w.team ? `(${escHtml(w.team)})` : ""}</th>
                    <td>${escHtml(w.sportsbook)}</td>
                    <td>${escHtml(w.market)} <strong>${escHtml(w.selection)}</strong> ${escHtml(w.line)}</td>
                    <td class="num-cell">${fmtOdds(w.odds)}</td>
                    <td class="num-cell">${fmtMoney(w.stake)} <span class="size-badge ${w.rel_stake_vs_avg >= 1.5 ? "is-outsized" : ""}">${w.rel_stake_vs_avg.toFixed(2)}x</span></td>
                    <td class="center-cell"><strong>${escHtml(w.grade)}</strong></td>
                    <td class="num-cell ${valClass(w.net_profit)}" style="font-weight:700;">${fmtMoney(w.net_profit, true)}</td>
                    <td class="num-cell ${valClass(w.portfolio_roi_impact_pct)}">${fmtPct(w.portfolio_roi_impact_pct, true)}</td>
                  </tr>
                `
                  )
                  .join("")}
              </tbody>
            </table>
          `;
    }
  }

  /* =========================================================================
     VIEW 5: PAPER SANDBOX PLACEHOLDER
     ========================================================================= */

  function renderPaperLabView() {
    const pools = getPools();
    const el = document.getElementById("paper-sandbox-summary");
    if (!el) return;
    const m = Engine.computeBucketMetrics(pools.paper);
    el.innerHTML = `
      <div class="trend-chip" style="max-inline-size:440px;">
        <div class="trend-chip-top"><span>Stored Paper Records</span><span>Archived in SQLite</span></div>
        <div class="trend-chip-main">${m.settled_count} Settled • ${m.open_count} Open</div>
        <div class="trend-chip-sub">Record ${escHtml(m.record)} (${m.win_rate_pct.toFixed(1)}%) • Ready for custom betting-system rules in upcoming Beta iterations.</div>
      </div>
    `;
  }

  /* =========================================================================
     MODAL DRILLDOWN & ROUTING
     ========================================================================= */

  function openDrilldownModal(title, cell) {
    const dlg = document.getElementById("cell-drilldown-dialog");
    const tEl = document.getElementById("drilldown-title");
    const subEl = document.getElementById("drilldown-subtitle");
    const bodyEl = document.getElementById("drilldown-body");
    if (!dlg || !bodyEl) return;

    const baseAvg = cell.portfolio_avg_stake || activePortfolioAvgStake || 10;
    tEl.textContent = title;
    subEl.textContent =
      `Graded: ${cell.settled_count} (${cell.open_count} Open) • Record: ${cell.record} (${cell.win_rate_pct.toFixed(1)}%) • ` +
      `1u Flat ROI: ${fmtPct(cell.flat_1u_roi_pct, true)} • Dollar ROI: ${fmtPct(cell.roi_pct, true)}`;

    const sortedWagers = (cell.wagers || [])
      .slice()
      .sort((a, b) => String(b.event_date || "").localeCompare(String(a.event_date || "")) || b.stake - a.stake);

    bodyEl.innerHTML = `
      <div class="table-scroll-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th scope="col">Date &amp; Player</th>
              <th scope="col" style="text-align:center;">Source</th>
              <th scope="col" style="text-align:left;">Market / Side / Total</th>
              <th scope="col">ML</th>
              <th scope="col">Edge %</th>
              <th scope="col" style="text-align:center;">Result</th>
              <th scope="col">1u Return</th>
            </tr>
          </thead>
          <tbody>
            ${sortedWagers
              .map(
                (w) => `
              <tr>
                <th scope="row">${escHtml(w.event_date)} • ${escHtml(w.player_team)} ${w.team ? `(${escHtml(w.team)})` : ""}</th>
                <td class="center-cell">${escHtml(w.bet_type)}</td>
                <td>${escHtml(w.market)} <strong>${escHtml(w.selection)}</strong> ${escHtml(w.line)}</td>
                <td class="num-cell">${fmtOdds(w.odds)}</td>
                <td class="num-cell">${fmtPct(w.edge_pct)}</td>
                <td class="center-cell"><strong>${escHtml(w.grade)}</strong>${w.result_stat ? ` <span style="color:var(--text-muted);">(${escHtml(w.result_stat)})</span>` : ""}</td>
                <td class="num-cell ${valClass(w.unit_return)}" style="font-weight:700;">${w.grade === "OPEN" ? "OPEN" : `${w.unit_return >= 0 ? "+" : ""}${w.unit_return.toFixed(2)}u`}</td>
              </tr>
            `
              )
              .join("")}
          </tbody>
        </table>
      </div>
    `;

    if (typeof dlg.showModal === "function" && !dlg.open) {
      dlg.showModal();
    }
  }

  function switchWorkspaceTab(tabId) {
    activeTab = tabId;
    document.querySelectorAll(".ws-tab").forEach((btn) => {
      btn.setAttribute("aria-selected", btn.getAttribute("data-tab") === tabId ? "true" : "false");
    });
    ["model", "firing", "crosstab", "cash", "paper"].forEach((id) => {
      const sec = document.getElementById(`view-${id}`);
      if (sec) sec.hidden = id !== tabId;
    });
    renderActiveView();
  }

  function renderActiveView() {
    const pill = document.getElementById("data-source-pill");
    if (pill) pill.textContent = sourceLabel;

    if (activeTab === "model") renderPureModelView();
    else if (activeTab === "firing") renderWhatsFiringView();
    else if (activeTab === "crosstab") renderCrossTabView();
    else if (activeTab === "cash") renderCashView();
    else if (activeTab === "paper") renderPaperLabView();
  }

  function syncUnitBtnUI() {
    const uBtn = document.getElementById("btn-unit-mode-toggle");
    if (!uBtn) return;
    if (window.NHL_EDGE_UNITS_ONLY) {
      uBtn.hidden = true;
      return;
    }
    uBtn.setAttribute("aria-pressed", isUnitMode ? "true" : "false");
    uBtn.textContent = isUnitMode ? "💵 Show $" : "💲 Show Units";
  }

  function initEvents() {
    const params = new URLSearchParams(window.location.search);
    const typeParam = (params.get("type") || "").toUpperCase();
    if (typeParam === "CASH") activeTab = "cash";
    else if (typeParam === "FIRING" || typeParam === "TRENDING") activeTab = "firing";
    else if (typeParam === "CROSSTAB") activeTab = "crosstab";
    else if (typeParam === "MODEL") {
      activeTab = "model";
      activeModelScope = "MODEL_CARD";
    }
    if (params.get("units") === "1") isUnitMode = true;

    syncUnitBtnUI();
    switchWorkspaceTab(activeTab);

    // Top Workspace Tabs
    document.querySelectorAll(".ws-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        switchWorkspaceTab(btn.getAttribute("data-tab") || "model");
      });
    });

    // Model Scope Pills
    document.querySelectorAll("#model-scope-pills [data-model-scope]").forEach((btn) => {
      btn.setAttribute("aria-pressed", btn.getAttribute("data-model-scope") === activeModelScope ? "true" : "false");
      btn.addEventListener("click", () => {
        activeModelScope = btn.getAttribute("data-model-scope") || "MODEL_EV";
        document.querySelectorAll("#model-scope-pills [data-model-scope]").forEach((b) => {
          b.setAttribute("aria-pressed", b === btn ? "true" : "false");
        });
        renderPureModelView();
      });
    });

    // Firing Feed Source Pills
    document.querySelectorAll("#firing-source-pills [data-firing-source]").forEach((btn) => {
      btn.addEventListener("click", () => {
        activeFiringSource = btn.getAttribute("data-firing-source") || "MODEL_EV";
        document.querySelectorAll("#firing-source-pills [data-firing-source]").forEach((b) => {
          b.setAttribute("aria-pressed", b === btn ? "true" : "false");
        });
        renderWhatsFiringView();
      });
    });

    // Cross-Tab Source, Side & Posted Total Pills
    document.querySelectorAll("#ct-source-pills [data-ct-source]").forEach((btn) => {
      btn.addEventListener("click", () => {
        activeCtSource = btn.getAttribute("data-ct-source") || "MODEL_EV";
        document.querySelectorAll("#ct-source-pills [data-ct-source]").forEach((b) => {
          b.setAttribute("aria-pressed", b === btn ? "true" : "false");
        });
        renderCrossTabView();
      });
    });

    document.querySelectorAll("#ct-side-pills [data-ct-side]").forEach((btn) => {
      btn.addEventListener("click", () => {
        activeCtSide = btn.getAttribute("data-ct-side") || "ALL";
        document.querySelectorAll("#ct-side-pills [data-ct-side]").forEach((b) => {
          b.setAttribute("aria-pressed", b === btn ? "true" : "false");
        });
        renderCrossTabView();
      });
    });

    document.querySelectorAll("#ct-line-pills [data-ct-line]").forEach((btn) => {
      btn.addEventListener("click", () => {
        activeCtLine = btn.getAttribute("data-ct-line") || "ALL";
        document.querySelectorAll("#ct-line-pills [data-ct-line]").forEach((b) => {
          b.setAttribute("aria-pressed", b === btn ? "true" : "false");
        });
        renderCrossTabView();
      });
    });

    // Reset Cross-Tab Filters
    const resetCtBtn = document.getElementById("btn-ct-reset");
    if (resetCtBtn) {
      resetCtBtn.addEventListener("click", () => {
        activeCtSide = "ALL";
        activeCtLine = "ALL";
        document.querySelectorAll("#ct-side-pills [data-ct-side]").forEach((b) => {
          b.setAttribute("aria-pressed", b.getAttribute("data-ct-side") === "ALL" ? "true" : "false");
        });
        document.querySelectorAll("#ct-line-pills [data-ct-line]").forEach((b) => {
          b.setAttribute("aria-pressed", b.getAttribute("data-ct-line") === "ALL" ? "true" : "false");
        });
        ["ct-filter-market", "ct-filter-edge", "ct-filter-odds", "ct-filter-team"].forEach((id) => {
          const el = document.getElementById(id);
          if (el) el.value = "ALL";
        });
        const winEl = document.getElementById("ct-filter-window");
        if (winEl) winEl.value = "0";
        renderCrossTabView();
      });
    }

    const jumpFiringBtn = document.getElementById("btn-jump-to-firing");
    if (jumpFiringBtn) {
      jumpFiringBtn.addEventListener("click", () => {
        activeFiringSource = activeModelScope === "MODEL_LEAN" ? "MODEL_EV" : activeModelScope;
        document.querySelectorAll("#firing-source-pills [data-firing-source]").forEach((b) => {
          b.setAttribute("aria-pressed", b.getAttribute("data-firing-source") === activeFiringSource ? "true" : "false");
        });
        switchWorkspaceTab("firing");
      });
    }

    // Select change listeners
    ["model-filter-market", "model-filter-side", "model-filter-line", "model-breakdown-dim"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("change", renderPureModelView);
    });

    [
      "ct-filter-market",
      "ct-filter-edge",
      "ct-filter-odds",
      "ct-filter-team",
      "ct-filter-window",
      "ct-row-dim",
      "ct-col-dim",
      "ct-cell-mode"
    ].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("change", renderCrossTabView);
    });

    ["cash-filter-book", "cash-filter-market", "cash-filter-side"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("change", renderCashView);
    });

    const swapBtn = document.getElementById("btn-swap-dims");
    if (swapBtn) {
      swapBtn.addEventListener("click", () => {
        const rSel = document.getElementById("ct-row-dim");
        const cSel = document.getElementById("ct-col-dim");
        if (rSel && cSel) {
          const tmp = rSel.value;
          rSel.value = cSel.value;
          cSel.value = tmp;
          renderCrossTabView();
        }
      });
    }

    const uBtn = document.getElementById("btn-unit-mode-toggle");
    if (uBtn) {
      uBtn.addEventListener("click", () => {
        isUnitMode = !isUnitMode;
        syncUnitBtnUI();
        renderActiveView();
      });
    }

    const refreshBtn = document.getElementById("btn-refresh-data");
    if (refreshBtn) refreshBtn.addEventListener("click", loadWagerData);

    const fileInput = document.getElementById("input-import-file");
    if (fileInput) {
      fileInput.addEventListener("change", async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const text = await file.text();
        if (file.name.toLowerCase().endsWith(".json")) {
          ingestPayloadBundle(JSON.parse(text));
        } else {
          ingestPayloadBundle(Engine.parseCsvText(text));
        }
        const p = getPools();
        sourceLabel = `Imported ${file.name} (${p.cash.length} Cash)`;
        populateDynamicSelects();
        renderActiveView();
      });
    }

    const exportBtn = document.getElementById("btn-export-analytics-json");
    if (exportBtn) {
      exportBtn.addEventListener("click", () => {
        const pools = getPools();
        const payload = {
          exported_at: new Date().toISOString(),
          active_tab: activeTab,
          model_ev_trends: Engine.computeRollingTrends(pools.modelEv),
          cash_trends: Engine.computeRollingTrends(pools.cash),
          whats_firing: Engine.computeWhatsFiringFeed(pools.modelEv)
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `vectorline_analytics_beta.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      });
    }

    const dlg = document.getElementById("cell-drilldown-dialog");
    const closeBtn = document.getElementById("btn-close-drilldown");
    if (closeBtn && dlg) closeBtn.addEventListener("click", () => dlg.close());
    if (dlg) {
      dlg.addEventListener("click", (ev) => {
        if (ev.target === dlg) dlg.close();
      });
    }

    // Encrypted Vault unlock & lock handlers
    const unlockForm = document.getElementById("vault-unlock-form");
    if (unlockForm) {
      unlockForm.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const env = window.NHL_EDGE_ENCRYPTED_SNAPSHOT;
        const passEl = document.getElementById("vault-passphrase-input");
        const remEl = document.getElementById("vault-remember-device");
        const errEl = document.getElementById("vault-error-msg");
        const btnEl = document.getElementById("btn-vault-unlock");
        if (!env || !passEl) return;

        const pass = passEl.value;
        if (errEl) errEl.hidden = true;
        if (btnEl) {
          btnEl.disabled = true;
          btnEl.textContent = "⏳ Unlocking…";
        }
        try {
          const unlocked = await decryptEncryptedSnapshot(env, pass);
          try {
            if (remEl && remEl.checked) {
              localStorage.setItem(VAULT_STORAGE_KEY, pass);
            } else {
              sessionStorage.setItem(VAULT_STORAGE_KEY, pass);
              localStorage.removeItem(VAULT_STORAGE_KEY);
            }
          } catch (_) {}
          passEl.value = "";
          ingestPayloadBundle(unlocked);
          const p = getPools();
          const updatedTag = window.NHL_EDGE_SNAPSHOT_UPDATED_AT ? ` • ${window.NHL_EDGE_SNAPSHOT_UPDATED_AT}` : "";
          sourceLabel = `🔒 Vault (${p.modelEv.length.toLocaleString()} +EV • ${p.cash.length} Cash${updatedTag})`;
          setVaultLockedUI(false);
          populateDynamicSelects();
          renderActiveView();
        } catch (_) {
          if (errEl) {
            errEl.textContent = "Incorrect passphrase — AES-256-GCM authentication failed.";
            errEl.hidden = false;
          }
        } finally {
          if (btnEl) {
            btnEl.disabled = false;
            btnEl.textContent = "🔓 Unlock Analytics Dashboard";
          }
        }
      });
    }

    const lockVaultBtn = document.getElementById("btn-lock-vault");
    if (lockVaultBtn) {
      lockVaultBtn.addEventListener("click", () => {
        try {
          localStorage.removeItem(VAULT_STORAGE_KEY);
          sessionStorage.removeItem(VAULT_STORAGE_KEY);
        } catch (_) {}
        rawLedgerRows = [];
        cachedPools = null;
        setVaultLockedUI(true);
      });
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    initEvents();
    loadWagerData();
  });
})();
