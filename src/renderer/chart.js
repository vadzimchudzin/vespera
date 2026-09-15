(() => {
  const LC = window.LightweightCharts;
  if (!LC) return;

  let chart;
  let candleSeries;
  let ma20Series;
  let ma200Series;
  let lastBarCount = 0;
  let lastMarkerKey = "";
  let lastClosedHash = "";

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
      },
      crosshair: { mode: LC.CrosshairMode.Normal },
      autoSize: true,
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
    window.addEventListener("resize", () => {
      if (!chart) return;
      chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
    });
  }

  function applyTheme() {
    if (!chart) return;
    const c = themeColors();
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
  }

  function toCandle(b) {
    if (!b) return null;
    const time = b.time != null ? b.time : Math.floor(Number(b.openTs) / 1000);
    if (!Number.isFinite(time)) return null;
    return { time, open: b.open, high: b.high, low: b.low, close: b.close };
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

  function updateForming(forming) {
    ensure();
    if (!candleSeries) return;
    const c = toCandle(forming);
    if (c) candleSeries.update(c);
  }

  function render(snap) {
    ensure();
    if (!chart || !snap) return;
    applyTheme();
    const closed = snap.bars || [];
    const bars = [...closed];
    if (snap.forming) bars.push(snap.forming);
    if (!bars.length) return;

    const candles = bars.map(toCandle).filter(Boolean);
    const hash = closedHash(closed);
    if (hash !== lastClosedHash) {
      candleSeries.setData(candles);
      paintAverages(closed);
      lastClosedHash = hash;
      lastBarCount = closed.length;
    } else if (snap.forming) {
      const c = toCandle(snap.forming);
      if (c) candleSeries.update(c);
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
    const key = JSON.stringify(markers);
    if (key !== lastMarkerKey) {
      candleSeries.setMarkers(markers);
      lastMarkerKey = key;
    }
  }

  window.VesperaChart = { render, ensure, updateForming, applyTheme };
})();
