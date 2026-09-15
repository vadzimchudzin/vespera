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

  function sma(closes, period, index) {
    if (index + 1 < period) return null;
    let sum = 0;
    for (let i = index - period + 1; i <= index; i += 1) sum += closes[i];
    return sum / period;
  }

  function themeColors() {
    const light = document.documentElement.getAttribute("data-theme") === "glass-light";
    return {
      text: light ? "rgba(60,60,67,0.72)" : "rgba(255,255,255,0.62)",
      grid: light ? "rgba(60,60,67,0.08)" : "rgba(255,255,255,0.06)",
      up: "#26a69a",
      down: "#ef5350",
      ma20: "#ff5a6a",
      ma200: "#5aa7ff",
    };
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
    ignoreRangeUntil = Date.now() + 500;
    setLiveBtn(false);
    if (!chart || lastBarIndex < 0) return;
    const visible = 72;
    const to = lastBarIndex + 3;
    const from = Math.max(-2, to - visible);
    try {
      chart.timeScale().setVisibleLogicalRange({ from, to });
    } catch {
      try {
        chart.timeScale().scrollToRealTime();
      } catch {
        /* ignore */
      }
    }
  }

  function goToLive() {
    centerLive();
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
      title: "SMA20",
    });
    ma200Series = chart.addLineSeries({
      color: c.ma200,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      title: "SMA200",
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
    const light = document.documentElement.getAttribute("data-theme") === "glass-light";
    const theme = light ? "light" : "dark";
    const c = themeColors();
    if (theme === lastTheme) return;
    lastTheme = theme;
    chart.applyOptions({
      layout: { textColor: c.text },
      grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
    });
    candleSeries.applyOptions({
      upColor: c.up,
      downColor: c.down,
      wickUpColor: c.up,
      wickDownColor: c.down,
    });
    if (pendingMarkers.length) candleSeries.setMarkers(pendingMarkers);
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
    const ma20 = [];
    const ma200 = [];
    for (let i = 0; i < closed.length; i += 1) {
      const a = sma(closes, 20, i);
      const b = sma(closes, 200, i);
      if (a != null) ma20.push({ time: closed[i].time, value: a });
      if (b != null) ma200.push({ time: closed[i].time, value: b });
    }
    ma20Series.setData(ma20);
    ma200Series.setData(ma200);
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

  function render(snap) {
    ensure();
    if (!chart || !snap) return;
    applyTheme();
    const closed = (snap.bars || []).map(toCandle).filter(Boolean);
    const forming = toCandle(snap.forming);
    const candles = forming ? closed.concat(forming) : closed.slice();
    if (!candles.length) return;

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
      const newestClosed = closed[closed.length - 1];
      if (newestClosed) candleSeries.update(newestClosed);
      paintAverages(closed);
      lastClosedHash = hash;
      lastBarIndex = candles.length - 1;
      if (forming) candleSeries.update(forming);
      if (followLive) centerLive();
    } else if (forming) {
      pendingForming = snap.forming;
      if (!raf) raf = requestAnimationFrame(paintPending);
    }

    const markers = (snap.markers || []).map((m) => {
      const win = m.result === "win";
      const loss = m.result === "loss";
      const up = m.side === "UP";
      let color = up ? "#7cff9a" : "#ff8b8b";
      if (win) color = "#7cff9a";
      if (loss) color = "#ff5a6a";
      const sizeLabel = m.size ? ` $${m.size}` : "";
      const res = win ? " ✓" : loss ? " ✕" : "";
      return {
        time: m.time,
        position: up ? "belowBar" : "aboveBar",
        color,
        shape: up ? "arrowUp" : "arrowDown",
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
    followLive = true;
    setLiveBtn(false);
  }

  window.VesperaChart = { render, ensure, updateForming, applyTheme, goToLive, reset, setRefreshMs, centerLive };
})();
