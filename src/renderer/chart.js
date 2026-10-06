(() => {
  const LC = window.LightweightCharts;
  if (!LC) return;

  let chart;
  let candleSeries;
  let ma20Series;
  let ma200Series;
  let lastMarkerKey = "";
  let lastClosedHash = "";
  let lastBarIndex = 0;
  let followLive = true;
  let ignoreRangeUntil = 0;
  let pendingForming = null;
  let raf = 0;
  let seeded = false;
  let refreshMs = 100;
  let lastPaintAt = 0;
  let pendingMarkers = [];
  let lastTheme = "";
  let lastCandlePoint = null;
  let lastIntervalSec = 60;
  let fastPeriod = 20;
  let slowPeriod = 200;
  let maType = "SMA";
  let sourceKey = "";

  /** EMA series seeded with the SMA of the first `period` closes. */
  function emaSeries(closes, period) {
    const out = new Array(closes.length).fill(null);
    if (closes.length < period) return out;
    const k = 2 / (period + 1);
    let prev = sma(closes, period, period - 1);
    out[period - 1] = prev;
    for (let i = period; i < closes.length; i += 1) {
      prev = closes[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  function sma(closes, period, index) {
    if (index + 1 < period) return null;
    let sum = 0;
    for (let i = index - period + 1; i <= index; i += 1) sum += closes[i];
    return sum / period;
  }

  /** Chart colours come from the active theme's CSS tokens. */
  function themeColors() {
    const css = getComputedStyle(document.documentElement);
    const v = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
    return {
      text: v("--chart-text", "rgba(255,255,255,0.62)"),
      grid: v("--chart-grid", "rgba(255,255,255,0.06)"),
      up: v("--candle-up", "#26a69a"),
      down: v("--candle-down", "#ef5350"),
      ma20: v("--ma-fast", "#ff5a6a"),
      ma200: v("--ma-slow", "#5aa7ff"),
      markUp: v("--mark-up", "#7cff9a"),
      markDown: v("--mark-down", "#ff8b8b"),
      markWin: v("--mark-win", "#7cff9a"),
      markLoss: v("--mark-loss", "#ff5a6a"),
      labelBg: v("--select-bg", "#1c1c1e"),
    };
  }

  function markerColor(kind, c) {
    return { win: c.markWin, loss: c.markLoss, up: c.markUp, down: c.markDown }[kind] || c.markUp;
  }

  function liveBtn() {
    return document.getElementById("btnLive");
  }

  function setLiveBtn(show) {
    const btn = liveBtn();
    if (!btn) return;
    btn.hidden = !show;
  }

  function setRefreshMs(ms) {
    const n = Number(ms);
    refreshMs = Number.isFinite(n) ? Math.min(2000, Math.max(1, Math.round(n))) : 100;
  }

  function centerLive() {
    followLive = true;
    ignoreRangeUntil = Date.now() + 1200;
    setLiveBtn(false);
    if (!chart) return;
    try {
      chart.priceScale("right").applyOptions({ autoScale: true });
    } catch {
      /* ignore */
    }
    if (candleSeries) {
      try {
        candleSeries.priceScale().applyOptions({ autoScale: true });
      } catch {
        /* ignore */
      }
    }
    const last = lastCandlePoint;
    const lastT = last ? Number(last.time) : NaN;
    const barSec = lastIntervalSec > 0 ? lastIntervalSec : 60;
    if (Number.isFinite(lastT)) {
      try {
        chart.timeScale().setVisibleRange({
          from: lastT - barSec * 48,
          to: lastT + barSec * 6,
        });
      } catch {
        try {
          chart.timeScale().scrollToRealTime();
        } catch {
          /* ignore */
        }
      }
    } else {
      try {
        chart.timeScale().scrollToRealTime();
      } catch {
        /* ignore */
      }
    }
    if (!last || !candleSeries) return;
    const high = Number(last.high);
    const low = Number(last.low);
    const close = Number(last.close);
    if (![high, low, close].every(Number.isFinite)) return;
    const mid = (high + low) / 2 || close;
    const span = Math.max(high - low, Math.abs(close) * 0.004, 1e-8);
    const pad = span * 8;
    try {
      candleSeries.priceScale().setVisibleRange({ from: mid - pad, to: mid + pad });
    } catch {
      /* ignore */
    }
    try {
      candleSeries.priceScale().applyOptions({ autoScale: true });
    } catch {
      /* ignore */
    }
  }

  function goToLive() {
    centerLive();
    requestAnimationFrame(() => centerLive());
    setTimeout(() => centerLive(), 60);
  }

  function applyMarkers(list) {
    if (!candleSeries) return;
    pendingMarkers = list || [];
    const key = JSON.stringify(pendingMarkers);
    candleSeries.setMarkers(pendingMarkers);
    lastMarkerKey = key;
  }

  function ensure() {
    const el = document.getElementById("chart");
    if (!el || chart) return;
    const c = themeColors();
    chart = LC.createChart(el, {
      layout: {
        background: { type: LC.ColorType.Solid, color: "transparent" },
        textColor: c.text,
        fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: c.grid },
        horzLines: { color: c.grid },
      },
      rightPriceScale: { borderVisible: false },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 6,
        shiftVisibleRangeOnNewBar: true,
      },
      crosshair: { mode: LC.CrosshairMode.Normal },
      autoSize: true,
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true,
      },
    });
    candleSeries = chart.addCandlestickSeries({
      upColor: c.up,
      downColor: c.down,
      borderVisible: false,
      wickUpColor: c.up,
      wickDownColor: c.down,
    });
    ma20Series = chart.addLineSeries({
      color: c.ma20,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      title: `SMA${fastPeriod}`,
    });
    ma200Series = chart.addLineSeries({
      color: c.ma200,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      title: `SMA${slowPeriod}`,
    });
    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (!range || Date.now() < ignoreRangeUntil) return;
      if (lastBarIndex <= 0) return;
      const atLive = range.to >= lastBarIndex - 2;
      if (!atLive && followLive) {
        followLive = false;
        setLiveBtn(true);
      }
    });
    window.addEventListener("resize", () => {
      if (!chart) return;
      chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
      if (followLive) goToLive();
    });
  }

  function applyTheme() {
    if (!chart) return;
    const theme = document.documentElement.getAttribute("data-theme") || "glass-dark";
    if (theme === lastTheme) return;
    lastTheme = theme;
    const c = themeColors();
    chart.applyOptions({
      layout: { textColor: c.text },
      grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
      crosshair: {
        vertLine: { labelBackgroundColor: c.ma200 },
        horzLine: { labelBackgroundColor: c.ma200 },
      },
    });
    candleSeries.applyOptions({
      upColor: c.up,
      downColor: c.down,
      wickUpColor: c.up,
      wickDownColor: c.down,
    });
    if (ma20Series) ma20Series.applyOptions({ color: c.ma20 });
    if (ma200Series) ma200Series.applyOptions({ color: c.ma200 });
    // markers carry theme colours too: recolour the ones already on the chart
    if (pendingMarkers.length) {
      applyMarkers(pendingMarkers.map((m) => ({ ...m, color: markerColor(m._kind, c) })));
    }
  }

  function toCandle(b) {
    if (!b) return null;
    let time = b.time != null ? Number(b.time) : Math.floor(Number(b.openTs) / 1000);
    if (!Number.isFinite(time)) return null;
    if (time > 1e12) time = Math.floor(time / 1000);
    const open = Number(b.open);
    const high = Number(b.high);
    const low = Number(b.low);
    const close = Number(b.close);
    if (![open, high, low, close].every(Number.isFinite)) return null;
    return {
      time,
      open,
      high: Math.max(high, open, close),
      low: Math.min(low, open, close),
      close,
    };
  }

  function closedHash(closed) {
    if (!closed.length) return "0";
    const last = closed[closed.length - 1];
    return `${closed.length}:${last.time}:${last.close}`;
  }

  function paintAverages(closed) {
    const closes = closed.map((b) => b.close);
    const label = maType === "EMA" ? "EMA" : "SMA";
    const fastVals = maType === "EMA" ? emaSeries(closes, fastPeriod) : null;
    const slowVals = maType === "EMA" ? emaSeries(closes, slowPeriod) : null;
    const ma20 = [];
    const ma200 = [];
    for (let i = 0; i < closed.length; i += 1) {
      const a = fastVals ? fastVals[i] : sma(closes, fastPeriod, i);
      const b = slowVals ? slowVals[i] : sma(closes, slowPeriod, i);
      if (a != null) ma20.push({ time: closed[i].time, value: a });
      if (b != null) ma200.push({ time: closed[i].time, value: b });
    }
    ma20Series.setData(ma20);
    ma200Series.setData(ma200);
    try {
      ma20Series.applyOptions({ title: `${label}${fastPeriod}` });
      ma200Series.applyOptions({ title: `${label}${slowPeriod}` });
    } catch {
      /* ignore */
    }
    const legendFast = document.querySelector(".chart-legend .lg.ma20");
    const legendSlow = document.querySelector(".chart-legend .lg.ma200");
    if (legendFast) legendFast.textContent = `${label}${fastPeriod}`;
    if (legendSlow) legendSlow.textContent = `${label}${slowPeriod}`;
  }

  function paintPending() {
    raf = 0;
    if (!candleSeries || !pendingForming) return;
    const now = Date.now();
    if (now - lastPaintAt < refreshMs) {
      raf = requestAnimationFrame(paintPending);
      return;
    }
    lastPaintAt = now;
    const c = toCandle(pendingForming);
    if (!c) return;
    lastCandlePoint = c;
    try {
      candleSeries.update(c);
    } catch {
      return;
    }
    if (followLive && chart) {
      ignoreRangeUntil = Date.now() + 80;
      try {
        chart.timeScale().scrollToRealTime();
      } catch {
        /* ignore */
      }
    }
  }

  function updateForming(forming) {
    ensure();
    if (!forming) return;
    pendingForming = forming;
    if (!seeded && candleSeries) {
      const c = toCandle(forming);
      if (c) {
        try {
          candleSeries.update(c);
        } catch {
          /* empty series — wait for setData */
        }
      }
    }
    if (!raf) raf = requestAnimationFrame(paintPending);
  }

  let priceTick = 0;
  /** Axis precision follows the exchange tick, so low-priced pairs are not shown as 0.00. */
  function applyPriceFormat(tick) {
    if (!(tick > 0) || tick === priceTick || !candleSeries) return;
    priceTick = tick;
    const precision = Math.min(10, Math.max(0, Math.round(-Math.log10(tick))));
    const priceFormat = { type: "price", precision, minMove: Number(tick.toFixed(precision)) || tick };
    for (const series of [candleSeries, ma20Series, ma200Series]) {
      if (series) series.applyOptions({ priceFormat });
    }
  }

  function render(snap) {
    ensure();
    if (!chart || !snap) return;
    const nextSource = `${snap.execution?.mode || "local"}:${snap.settings?.symbol || ""}:${snap.settings?.timeframe || ""}`;
    if (sourceKey !== nextSource) {
      sourceKey = nextSource;
      seeded = false;
      pendingForming = null;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    }
    const nextFast = Number(snap.settings && snap.settings.fastPeriod) || 20;
    const nextSlow = Number(snap.settings && snap.settings.slowPeriod) || 200;
    const nextMa = (snap.settings && snap.settings.maType) === "EMA" ? "EMA" : "SMA";
    if (nextFast !== fastPeriod || nextSlow !== slowPeriod || nextMa !== maType) {
      fastPeriod = nextFast;
      slowPeriod = nextSlow;
      maType = nextMa;
      lastClosedHash = "";
      seeded = false;
      lastMarkerKey = "";
    }
    applyTheme();
    applyPriceFormat(Number(snap.settings && snap.settings.tickSize));
    const closed = (snap.bars || []).map(toCandle).filter(Boolean);
    const candidate = toCandle(snap.forming);
    const latestClosed = closed[closed.length - 1];
    const forming = candidate && (!latestClosed || candidate.time > latestClosed.time) ? candidate : null;
    const candles = forming ? closed.concat(forming) : closed.slice();
    if (!candles.length) return;
    lastCandlePoint = candles[candles.length - 1];
    if (closed.length >= 2) {
      const dt = Number(closed[closed.length - 1].time) - Number(closed[closed.length - 2].time);
      if (Number.isFinite(dt) && dt > 0) lastIntervalSec = dt;
    }

    const hash = closedHash(closed);
    const closedCount = closed.length;
    const prevCount = lastClosedHash ? Number(lastClosedHash.split(":")[0]) : 0;
    const needReseed = !seeded || closedCount + 2 < prevCount;
    if (needReseed) {
      candleSeries.setData(candles);
      paintAverages(closed);
      lastClosedHash = hash;
      lastBarIndex = candles.length - 1;
      seeded = true;
      lastMarkerKey = "";
      ignoreRangeUntil = Date.now() + 400;
      centerLive();
    } else if (hash !== lastClosedHash) {
      // REST may correct a closed candle older than the already-painted live bar.
      candleSeries.setData(candles);
      paintAverages(closed);
      lastClosedHash = hash;
      lastBarIndex = candles.length - 1;
      if (followLive) centerLive();
      lastMarkerKey = "";
    } else if (forming) {
      pendingForming = snap.forming;
      if (!raf) raf = requestAnimationFrame(paintPending);
    }

    const mc = themeColors();
    const markers = (snap.markers || []).map((m) => {
      const win = m.result === "win";
      const loss = m.result === "loss";
      const up = m.side === "UP";
      const kind = win ? "win" : loss ? "loss" : up ? "up" : "down";
      const color = markerColor(kind, mc);
      const sizeLabel = m.size ? ` $${m.size}` : "";
      const res = win ? " ✓" : loss ? " ✕" : "";
      return {
        time: m.time,
        position: up ? "belowBar" : "aboveBar",
        color,
        shape: up ? "arrowUp" : "arrowDown",
        _kind: kind,
        text: `${m.side}${sizeLabel}${res}`,
      };
    });
    if (JSON.stringify(markers) !== lastMarkerKey) applyMarkers(markers);
  }

  function reset() {
    lastClosedHash = "";
    lastMarkerKey = "";
    lastBarIndex = 0;
    seeded = false;
    pendingForming = null;
    pendingMarkers = [];
    lastTheme = "";
    lastCandlePoint = null;
    followLive = true;
    setLiveBtn(false);
  }

  window.VesperaChart = { render, ensure, updateForming, applyTheme, goToLive, reset, setRefreshMs, centerLive };
})();
