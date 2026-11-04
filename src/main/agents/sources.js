"use strict";

// Outside data for the model agents, cached: crypto spot and volatility, airport METARs and weather ensembles,
// news headlines. All public, keyless endpoints; a failing source only silences the agent that needs it.

const { fail } = require("./net");
const { metarTemp } = require("./models");

const ENSEMBLE_MODELS = "ecmwf_ifs025,gfs_seamless";

function decodeXml(text) {
  return String(text || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// A news query from a market question: the words that name the event, without the question's frame and dates.
function newsQuery(question) {
  const stop = new Set(["will", "the", "a", "an", "be", "by", "on", "in", "of", "to", "for", "at", "before", "after", "end", "than", "or", "and", "is", "are", "who", "what", "which", "when", "does", "do"]);
  const months = /^(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)$/i;
  const words = String(question || "").replace(/[?"“”]/g, " ").split(/\s+/)
    .filter((w) => w && !stop.has(w.toLowerCase()) && !months.test(w) && !/^\d{1,2}(st|nd|rd|th)?,?$/.test(w) && !/^20\d\d\??$/.test(w));
  return words.slice(0, 8).join(" ");
}

const METAR_BATCH = 3;
const METAR_ROW_CAP = 400;   // rows per response of the aviationweather.gov API

class Sources {
  constructor({ net, now = () => Date.now() }) {
    this.net = net;
    this.now = now;
    this.cache = new Map();
  }

  async _cached(key, ttlMs, load) {
    const t = this.now();
    const hit = this.cache.get(key);
    if (hit && t - hit.at < ttlMs) {
      if (hit.error) throw hit.error;
      return hit.value;
    }
    try {
      const value = await load();
      this.cache.set(key, { at: t, value });
      return value;
    } catch (error) {
      // a failed source is asked again after two minutes, not on every cycle
      this.cache.set(key, { at: t - ttlMs + Math.min(ttlMs, 120000), error });
      throw error;
    } finally {
      if (this.cache.size > 3000) for (const k of [...this.cache.keys()].slice(0, 1000)) this.cache.delete(k);
    }
  }

  // Spot: Binance first (the resolution source of Polymarket's crypto price markets), else Coinbase.
  spot(asset) {
    return this._cached(`spot:${asset}`, 20000, async () => {
      try {
        const row = await this.net.json(`https://api.binance.com/api/v3/ticker/price?symbol=${asset}USDT`, { timeout: 6000, maxBytes: 65536 });
        const price = Number(row?.price);
        if (price > 0) return { price, source: "binance" };
      } catch { /* restricted in some regions: fall back */ }
      const row = await this.net.json(`https://api.exchange.coinbase.com/products/${asset}-USD/ticker`, { timeout: 6000, maxBytes: 65536 });
      const price = Number(row?.price);
      if (!(price > 0)) throw fail("agents_spot_unavailable");
      return { price, source: "coinbase" };
    });
  }

  // Annualized volatility: Deribit's implied-volatility index (DVOL) for BTC and ETH, else a week of hourly returns.
  vol(asset) {
    return this._cached(`vol:${asset}`, 30 * 60000, async () => {
      if (asset === "BTC" || asset === "ETH") {
        try {
          const end = this.now();
          const body = await this.net.json(`https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=${asset}&resolution=3600&start_timestamp=${end - 6 * 3600000}&end_timestamp=${end}`, { timeout: 8000, maxBytes: 262144 });
          const rows = body?.result?.data;
          const v = Array.isArray(rows) && rows.length ? Number(rows[rows.length - 1][4]) : NaN;
          if (v > 5 && v < 400) return { sigma: v / 100, source: "deribit_dvol" };
        } catch { /* fall back to realized volatility */ }
      }
      const rows = await this.net.json(`https://api.exchange.coinbase.com/products/${asset}-USD/candles?granularity=3600`, { timeout: 8000, maxBytes: 1048576 });
      if (!Array.isArray(rows) || rows.length < 48) throw fail("agents_vol_unavailable");
      const closes = rows.map((r) => Number(r[4])).filter((v) => v > 0).reverse();
      const returns = [];
      for (let i = 1; i < closes.length; i++) returns.push(Math.log(closes[i] / closes[i - 1]));
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
      const sd = Math.sqrt(returns.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, returns.length - 1));
      return { sigma: Math.max(0.2, Math.min(3, sd * Math.sqrt(24 * 365.25))), source: "coinbase_realized" };
    });
  }

  // Highest and lowest price since a time: a touch market whose level was already reached has settled the question.
  extremes(asset, sinceMs) {
    return this._cached(`ext:${asset}:${Math.floor(sinceMs / 3600000)}`, 10 * 60000, async () => {
      const end = this.now();
      const span = end - sinceMs;
      if (span > 299 * 86400000) throw fail("agents_period_too_long");
      const granularity = span <= 12 * 86400000 ? 3600 : 86400;
      const rows = await this.net.json(`https://api.exchange.coinbase.com/products/${asset}-USD/candles?granularity=${granularity}&start=${new Date(sinceMs).toISOString()}&end=${new Date(end).toISOString()}`, { timeout: 8000, maxBytes: 1048576 });
      if (!Array.isArray(rows) || !rows.length) throw fail("agents_extremes_unavailable");
      return { high: Math.max(...rows.map((r) => Number(r[2]))), low: Math.min(...rows.map((r) => Number(r[1]))) };
    });
  }

  // Airport coordinates from the Aviation Weather Center (cached for a week).
  async stations(icaos) {
    const out = new Map();
    const missing = [];
    for (const id of icaos) {
      const hit = this.cache.get(`station:${id}`);
      if (hit && !hit.error && this.now() - hit.at < 7 * 86400000) out.set(id, hit.value);
      else missing.push(id);
    }
    for (let i = 0; i < missing.length; i += 40) {
      const ids = missing.slice(i, i + 40);
      try {
        const rows = await this.net.json(`https://aviationweather.gov/api/data/stationinfo?ids=${ids.join(",")}&format=json`, { timeout: 10000, maxBytes: 1048576 });
        for (const row of Array.isArray(rows) ? rows : []) {
          const id = String(row?.icaoId || "");
          const lat = Number(row?.lat), lon = Number(row?.lon);
          if (!/^[A-Z]{4}$/.test(id) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
          const value = { lat, lon, name: String(row.site || id).slice(0, 80) };
          this.cache.set(`station:${id}`, { at: this.now(), value });
          out.set(id, value);
        }
      } catch { /* the stations stay unknown this cycle */ }
    }
    return out;
  }

  // Routine METAR observations of the last 36 hours (SPECI reports do not count for the markets). The API returns at
  // most 400 rows per request, which would cut the older hours of a large batch: three stations a request, and a batch
  // that comes back full is asked again station by station.
  metars(icaos) {
    const ids = [...new Set(icaos)].sort();
    return this._cached(`metar:${ids.join(",")}`, 10 * 60000, async () => {
      const out = new Map(ids.map((id) => [id, []]));
      const fetchRows = (list) => this.net.json(`https://aviationweather.gov/api/data/metar?ids=${list.join(",")}&format=json&hours=36`, { timeout: 12000, maxBytes: 8 * 1024 * 1024 });
      const take = (rows) => {
        for (const row of Array.isArray(rows) ? rows : []) {
          if (String(row?.metarType || "METAR").toUpperCase() === "SPECI" || /^SPECI\b/.test(String(row?.rawOb || ""))) continue;
          const c = metarTemp(row);
          const t = Number(row?.obsTime) * 1000;
          if (c == null || !Number.isFinite(t) || !out.has(row.icaoId)) continue;
          out.get(row.icaoId).push({ t, c });
        }
      };
      const batches = [];
      for (let i = 0; i < ids.length; i += METAR_BATCH) batches.push(ids.slice(i, i + METAR_BATCH));
      let next = 0, failed = 0, lastError = null;
      const run = async () => {
        while (next < batches.length) {
          const list = batches[next++];
          try {   // a slow batch costs only its stations this cycle (they show no observations and are skipped)
            const rows = await fetchRows(list);
            if (Array.isArray(rows) && rows.length >= METAR_ROW_CAP && list.length > 1) {
              for (const id of list) take(await fetchRows([id]));
            } else take(rows);
          } catch (error) { failed += 1; lastError = error; }
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, batches.length) }, run));
      if (failed && failed === batches.length) throw lastError;
      return out;
    });
  }

  // Hourly 2 m temperature of every ensemble member (ECMWF IFS 0.25° and GFS), local times, one day back.
  ensemble(icao, station) {
    return this._cached(`ens:${icao}`, 60 * 60000, async () => {
      const body = await this.net.json(`https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${station.lat}&longitude=${station.lon}&hourly=temperature_2m&models=${ENSEMBLE_MODELS}&timezone=auto&forecast_days=3&past_days=1`, { timeout: 15000, maxBytes: 4 * 1024 * 1024 });
      const hourly = body?.hourly;
      if (!hourly || !Array.isArray(hourly.time)) throw fail("agents_weather_unavailable");
      const members = Object.entries(hourly).filter(([k, v]) => k.startsWith("temperature_2m") && Array.isArray(v)).map(([, v]) => v.map(Number));
      if (members.length < 10) throw fail("agents_weather_unavailable");
      return { times: hourly.time.map(String), members, offsetSec: Number(body.utc_offset_seconds) || 0, timezone: String(body.timezone || "") };
    });
  }

  // Recent headlines for an AI agent: titles and dates only (Google News RSS).
  headlines(question, { days = 3, limit = 5 } = {}) {
    const query = newsQuery(question);
    if (!query) return Promise.resolve([]);
    return this._cached(`news:${query}:${days}`, 3 * 3600000, async () => {
      const xml = await this.net.text(`https://news.google.com/rss/search?q=${encodeURIComponent(`${query} when:${days}d`)}&hl=en-US&gl=US&ceid=US:en`, { timeout: 8000, maxBytes: 2 * 1024 * 1024 });
      const items = [];
      for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
        const title = decodeXml(/<title>([\s\S]*?)<\/title>/.exec(match[1])?.[1]).slice(0, 180);
        const at = Date.parse(decodeXml(/<pubDate>([\s\S]*?)<\/pubDate>/.exec(match[1])?.[1]));
        if (title) items.push({ title, at: Number.isFinite(at) ? at : null });
        if (items.length >= limit) break;
      }
      return items;
    });
  }
}

module.exports = { Sources, newsQuery, decodeXml };
