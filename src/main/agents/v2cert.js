"use strict";

// The V2 certificates: what the two fast lanes must show on paper before anyone talks of real money. The rules are
// the frozen pre-registrations in research/v2money — latarb_v2.md for a9 (latency arbitrage) and lp_v1.md with its
// addendum C for a10 (LP with rewards). How the desk reads them (full days, phases, the evaluation point) is frozen
// in their desk addenda. Pure numbers, no I/O: the lanes feed them and save what toJSON() returns.

const HOUR = 3600000;
const DAY = 86400000;
const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const r6 = (x) => Math.round(x * 1e6) / 1e6;
const finite = (x) => typeof x === "number" && Number.isFinite(x);
const isMap = (x) => Boolean(x) && typeof x === "object" && !Array.isArray(x);
const dayKey = (t) => new Date(t).toISOString().slice(0, 10);

// ---- statistics ---------------------------------------------------------------------------------------------------

function lgamma(x) {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  const z = x - 1;
  let a = c[0];
  for (let i = 1; i < 9; i += 1) a += c[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}
// The continued fraction of the regularized incomplete beta function (Numerical Recipes, betacf).
function betacf(a, b, x) {
  const TINY = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-14) break;
  }
  return h;
}
function ibeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}
// P(T > t) for Student's t with df degrees of freedom: the one-sided p-value of "the mean is above zero".
function tTail(t, df) {
  if (!finite(t) || !(df > 0)) return null;
  const tail = 0.5 * ibeta(df / (df + t * t), df / 2, 0.5);
  return t >= 0 ? tail : 1 - tail;
}
// The t statistic of a mean from n, Σx and Σx²: one x per cluster (a window, a market).
function tFrom(n, s1, s2) {
  if (!(n >= 3)) return null;
  const m = s1 / n, v = (s2 - n * m * m) / (n - 1);
  if (!(v > 1e-18)) return null;
  return m / Math.sqrt(v / n);
}

// ---- a9: latency arbitrage (latarb_v2.md) -------------------------------------------------------------------------

// The certificate: >= 2000 BTC trades, >= 1000 of them BTC 5m; BTC 5m exit@10s > 0 with one-sided p < 0.01 (t by
// window); BTC 5m edge at the window's result > 0; no day above 50% of the P&L; >= 70% of full days positive. The
// desk's reading (desk addendum): a full day has >= 20 h of live feeds; at least 3 are needed; the verdict is taken
// once, when the counts and the full days are first reached, and stays; the kill switch stops the test after >= 500
// BTC 5m trades with exit@10s <= 0. A positive ETH control is a warning that the simulator may be wrong.
const LAT_CERT = Object.freeze({
  primary: "btc 5m", minBtc: 2000, minPrimary: 1000, pMax: 0.01, maxDayShare: 0.5, minPositiveDays: 0.7,
  fullDayMs: 20 * HOUR, minFullDays: 3, killAfter: 500, maxTries: 20, giveUpMs: 7 * DAY, retryMaxMs: 10 * 60000,
  controlMinTrades: 100, controlT: 2.5,
});
const ROLE = (key) => (key === LAT_CERT.primary ? "primary" : key.startsWith("btc ") ? "secondary" : "control");
const freshGroup = (sd) => ({ sd: sd ? 1 : 0, n: 0, sh: 0, pnl: 0, w: 0, s1: 0, s2: 0, rw: 0, rsh: 0, rpnl: 0, rs1: 0, rs2: 0, lost: 0 });
const GROUP_KEYS = Object.keys(freshGroup(false));
const WINDOW_KEYS = ["e", "n", "sh", "pnl", "uS", "uC", "dS", "dC", "tries", "next"];
const validGroup = (g) => isMap(g) && GROUP_KEYS.every((k) => finite(g[k]));
const validWindow = (w) => isMap(w) && typeof w.k === "string" && WINDOW_KEYS.every((k) => finite(w[k])) && (w.y === null || w.y === 0 || w.y === 1);
const validDay = (d) => isMap(d) && finite(d.n) && finite(d.pnl) && finite(d.up);
const mapOf = (x, valid) => (isMap(x) ? Object.fromEntries(Object.entries(x).filter(([, v]) => valid(v))) : {});
// What the window's trades would have made held to the result: Up pays 1 if Up won, Down if it lost.
const resPnl = (w) => w.uS * w.y + w.dS * (1 - w.y) - w.uC - w.dC;

class LatCert {
  constructor(saved = null, now = Date.now()) {
    const s = isMap(saved) ? saved : {};
    this.since = finite(s.since) ? s.since : now;
    this.g = mapOf(s.g, validGroup);
    this.w = mapOf(s.w, validWindow);
    this.days = mapOf(s.days, validDay);
    this.kill = isMap(s.kill) && finite(s.kill.t) ? s.kill : null;
    this.final = isMap(s.final) && finite(s.final.t) ? s.final : null;
    this.upAt = null;
  }

  toJSON() { return { v: 1, since: this.since, g: this.g, w: this.w, days: this.days, kill: this.kill, final: this.final }; }

  _day(t) {
    const k = dayKey(t);
    if (!this.days[k]) this.days[k] = { n: 0, pnl: 0, up: 0 };
    const keys = Object.keys(this.days);
    if (keys.length > 400) for (const old of keys.sort().slice(0, keys.length - 400)) delete this.days[old];
    return this.days[k];
  }

  // One closed trade: { slug, group: "btc 5m", shadow, t, end, up (bought Up), shares, entry, fee0 (entry fee), pnl }.
  add(tr) {
    let w = this.w[tr.slug];
    if (!w) {
      w = { k: tr.group, sd: tr.shadow ? 1 : 0, e: tr.end, n: 0, sh: 0, pnl: 0, uS: 0, uC: 0, dS: 0, dC: 0, y: null, tries: 0, next: tr.end + 60000 };
      this.w[tr.slug] = w;
    }
    w.n += 1;
    w.sh = r6(w.sh + tr.shares);
    w.pnl = r6(w.pnl + tr.pnl);
    const cost = tr.shares * tr.entry + tr.fee0;
    if (tr.up) { w.uS = r6(w.uS + tr.shares); w.uC = r6(w.uC + cost); } else { w.dS = r6(w.dS + tr.shares); w.dC = r6(w.dC + cost); }
    if (!tr.shadow) {
      const d = this._day(tr.t);
      d.n += 1;
      d.pnl = r6(d.pnl + tr.pnl);
    }
  }

  // Windows whose result is due: over for a minute, not known yet, not given up (20 tries with a backoff).
  due(now, limit = 10) {
    const out = [];
    for (const [slug, w] of Object.entries(this.w)) {
      if (out.length >= limit) break;
      if (w.y == null && now >= w.next && w.tries < LAT_CERT.maxTries) out.push(slug);
    }
    return out;
  }
  outcome(slug, up) { if (this.w[slug]) this.w[slug].y = up ? 1 : 0; }
  retry(slug, now) {
    const w = this.w[slug];
    if (!w) return;
    w.tries += 1;
    w.next = now + Math.min(LAT_CERT.retryMaxMs, 30000 * 2 ** Math.min(w.tries, 10));
  }

  // Finished windows move into their group's sums. A window waits while one of its trades is still open or held,
  // and for its result until the tries run out or a week has passed (then it counts without one).
  fold(now, busy = new Set()) {
    for (const [slug, w] of Object.entries(this.w)) {
      if (busy.has(slug) || now < w.e + 30000) continue;
      const known = w.y != null;
      if (!known && w.tries < LAT_CERT.maxTries && now < w.e + LAT_CERT.giveUpMs) continue;
      const g = this.g[w.k] || (this.g[w.k] = freshGroup(w.sd));
      this._into(g, w);
      delete this.w[slug];
    }
  }
  _into(g, w) {
    g.n += w.n;
    g.sh = r6(g.sh + w.sh);
    g.pnl = r6(g.pnl + w.pnl);
    g.w += 1;
    g.s1 = r6(g.s1 + w.pnl);
    g.s2 = r6(g.s2 + w.pnl * w.pnl);
    if (w.y != null) {
      const rp = resPnl(w);
      g.rw += 1;
      g.rsh = r6(g.rsh + w.sh);
      g.rpnl = r6(g.rpnl + rp);
      g.rs1 = r6(g.rs1 + rp);
      g.rs2 = r6(g.rs2 + rp * rp);
    } else g.lost += 1;
  }

  // Time with live feeds, by UTC day: the lane samples it every few seconds; a gap counts at most maxGapMs.
  uptime(now, healthy, maxGapMs = 120000) {
    const last = this.upAt;
    this.upAt = now;
    if (last == null || !healthy || !(now > last)) return;
    let from = Math.max(last, now - maxGapMs);
    while (from < now) {
      const end = Math.min(now, (Math.floor(from / DAY) + 1) * DAY);
      const d = this._day(from);
      d.up += end - from;
      from = end;
    }
  }

  groups() {
    const out = {};
    for (const [k, g] of Object.entries(this.g)) out[k] = { ...g };
    for (const w of Object.values(this.w)) this._into(out[w.k] || (out[w.k] = freshGroup(w.sd)), w);
    return Object.entries(out).map(([key, g]) => {
      const t = tFrom(g.w, g.s1, g.s2), rt = tFrom(g.rw, g.rs1, g.rs2);
      return {
        key, role: ROLE(key), shadow: Boolean(g.sd), trades: g.n, windows: g.w, shares: r2(g.sh), pnl: r2(g.pnl),
        exit: g.sh > 0 ? r6(g.pnl / g.sh) : null, t: t == null ? null : r2(t), p: t == null ? null : r6(tTail(t, g.w - 1)),
        res: g.rsh > 0 ? r6(g.rpnl / g.rsh) : null, resT: rt == null ? null : r2(rt), resWindows: g.rw, noResult: g.lost,
      };
    }).sort((a, b) => ["primary", "secondary", "control"].indexOf(a.role) - ["primary", "secondary", "control"].indexOf(b.role) || a.key.localeCompare(b.key));
  }

  _checks(groups) {
    const C = LAT_CERT;
    const P = groups.find((g) => g.key === C.primary) || { trades: 0, exit: null, t: null, p: null, res: null };
    const btc = groups.filter((g) => g.key.startsWith("btc ")).reduce((s, g) => s + g.trades, 0);
    const days = Object.entries(this.days).filter(([, d]) => d.n > 0 || d.up > 0).sort(([a], [b]) => a.localeCompare(b));
    const total = days.reduce((s, [, d]) => s + d.pnl, 0);
    const best = days.reduce((m, [, d]) => Math.max(m, d.pnl), -Infinity);
    const share = total > 0 ? best / total : null;
    const full = days.filter(([, d]) => d.up >= C.fullDayMs);
    const positive = full.filter(([, d]) => d.pnl > 0).length;
    const posShare = full.length ? positive / full.length : null;
    return {
      counts: btc >= C.minBtc && P.trades >= C.minPrimary,
      fullDays: full.length,
      checks: [
        { id: "btc_trades", value: btc, need: C.minBtc, ok: btc >= C.minBtc },
        { id: "primary_trades", value: P.trades, need: C.minPrimary, ok: P.trades >= C.minPrimary },
        { id: "exit", value: P.exit, t: P.t, p: P.p, need: C.pMax, ok: P.exit != null && P.exit > 0 && P.p != null && P.p < C.pMax },
        { id: "resolution", value: P.res, ok: P.res != null && P.res > 0 },
        { id: "day_share", value: share == null ? null : r4(share), need: C.maxDayShare, ok: share != null && share <= C.maxDayShare },
        { id: "positive_days", value: posShare == null ? null : r4(posShare), full: full.length, positive, minFull: C.minFullDays, need: C.minPositiveDays,
          ok: full.length >= C.minFullDays && posShare >= C.minPositiveDays },
      ],
      primary: P,
    };
  }

  // The kill switch and the verdict, once each; returns what happened now (for the journal and Telegram).
  evaluate(now) {
    const groups = this.groups(), c = this._checks(groups), out = [];
    if (!this.final && !this.kill && c.primary.trades >= LAT_CERT.killAfter && c.primary.exit != null && c.primary.exit <= 0) {
      this.kill = { t: now, trades: c.primary.trades, exit: c.primary.exit, t2: c.primary.t };
      out.push({ op: "v2_kill", trades: c.primary.trades, exit: c.primary.exit });
    }
    if (!this.final && !this.kill && c.counts && c.fullDays >= LAT_CERT.minFullDays) {
      const pass = c.checks.every((x) => x.ok);
      this.final = { t: now, verdict: pass ? "pass" : "fail", checks: c.checks };
      out.push({ op: "v2_verdict", verdict: this.final.verdict, trades: c.primary.trades, exit: c.primary.exit, p: c.primary.p });
    }
    return out;
  }

  summary(now = Date.now()) {
    const groups = this.groups(), c = this._checks(groups);
    const warnings = [];
    for (const g of groups) {
      if (g.role === "control" && g.trades >= LAT_CERT.controlMinTrades && g.exit > 0 && g.t != null && g.t > LAT_CERT.controlT) warnings.push({ id: "control_positive", key: g.key, t: g.t });
    }
    const days = Object.entries(this.days).sort(([a], [b]) => b.localeCompare(a)).slice(0, 14)
      .map(([day, d]) => ({ day, trades: d.n, pnl: r2(d.pnl), upH: r2(d.up / HOUR), full: d.up >= LAT_CERT.fullDayMs }));
    return {
      rule: "latarb_v2", since: this.since, verdict: this.kill ? "kill" : this.final ? this.final.verdict : "collecting",
      kill: this.kill, final: this.final ? { t: this.final.t, verdict: this.final.verdict } : null,
      checks: c.checks, fullDays: c.fullDays, groups, days, warnings, pending: Object.keys(this.w).length, at: now,
    };
  }
}

// ---- a10: LP with rewards (lp_v1.md, addendum C) ------------------------------------------------------------------

// Pass: net (pessimistic rewards + mark-to-market) > 0 over >= 24 h with no market above 25% of it, then the same
// over another 24 h on a universe rebuilt at its start. Addendum C: the shield (hs, the lane) against the same quotes
// without it (h, a shadow fed the same books and trades): the paired difference by market, t > 2, and hs net > 0.
// The desk's reading (desk addendum): the hours are the lane's hours with live books and trades; the shield test is
// read on phase 1.
const LP_CERT = Object.freeze({ phaseMs: 24 * HOUR, maxMarketShare: 0.25, shieldT: 2 });

// Per-market nets of one phase: { cid: [hs, h] }; the phase's P&L, the top market's share and the paired test.
function lpPhase(nets) {
  const rows = Object.values(nets || {}).filter((x) => Array.isArray(x) && finite(x[0]) && finite(x[1]));
  const hs = rows.reduce((s, x) => s + x[0], 0), h = rows.reduce((s, x) => s + x[1], 0);
  const top = rows.reduce((m, x) => Math.max(m, x[0]), -Infinity);
  const d = rows.map((x) => x[0] - x[1]);
  const t = tFrom(d.length, d.reduce((s, x) => s + x, 0), d.reduce((s, x) => s + x * x, 0));
  return { markets: rows.length, net: r2(hs), netH: r2(h), topShare: hs > 0 && rows.length ? r4(top / hs) : null, shieldT: t == null ? null : r2(t) };
}
function lpChecks(p, done) {
  return [
    { id: "hours", value: p.hours, need: LP_CERT.phaseMs / HOUR, ok: done },
    { id: "net", value: p.net, ok: p.net > 0 },
    { id: "top_market", value: p.topShare, need: LP_CERT.maxMarketShare, ok: p.topShare != null && p.topShare <= LP_CERT.maxMarketShare },
  ];
}
// state: { upMs, ph1: { t, upMs, nets } | null, ph2: same | null, nets (now), shocks, pulledMs, marketMs, rewardsHs, rewardsH }
function lpSummary(state, now = Date.now()) {
  const up = state.upMs || 0;
  // phase 2: what each market made since phase 1 closed; one that made nothing since (it left at the rebuild) is out
  const sub = (a, b) => {
    const out = {};
    for (const [cid, x] of Object.entries(a || {})) {
      const y = b && b[cid];
      if (y && x[0] === y[0] && x[1] === y[1]) continue;
      out[cid] = y ? [x[0] - y[0], x[1] - y[1]] : [x[0], x[1]];
    }
    return out;
  };
  const p1nets = state.ph1 ? state.ph1.nets : state.nets;
  const p1 = { ...lpPhase(p1nets), hours: r2(Math.min(up, LP_CERT.phaseMs) / HOUR), done: Boolean(state.ph1) };
  p1.checks = lpChecks(p1, p1.done);
  const p2 = state.ph1 ? { ...lpPhase(state.ph2 ? sub(state.ph2.nets, state.ph1.nets) : sub(state.nets, state.ph1.nets)),
    hours: r2(Math.min(Math.max(0, up - state.ph1.upMs), LP_CERT.phaseMs) / HOUR), done: Boolean(state.ph2) } : null;
  if (p2) p2.checks = lpChecks(p2, p2.done);
  const failed = (p) => p && p.done && !p.checks.every((x) => x.ok);
  const verdict = failed(p1) || failed(p2) ? "fail" : p1.done && p2 && p2.done ? "pass" : "collecting";
  const shield = { t: p1.shieldT, net: p1.net, need: LP_CERT.shieldT, decided: p1.done,
    helps: p1.shieldT != null && p1.shieldT > LP_CERT.shieldT && p1.net > 0 };
  const days = up / DAY;
  return {
    rule: "lp_v1", verdict, phase: !state.ph1 ? 1 : !state.ph2 ? 2 : null, upH: r2(up / HOUR), phase1: p1, phase2: p2, shield,
    perDay: days > 0 ? { net: r2(lpPhase(state.nets).net / days), shocks: r2((state.shocks || 0) / days) } : null,
    pulledShare: state.marketMs > 0 ? r4(state.pulledMs / state.marketMs) : null,
    rewardsGivenUp: finite(state.rewardsH) && finite(state.rewardsHs) ? r2(state.rewardsH - state.rewardsHs) : null, at: now,
  };
}

module.exports = { LatCert, LAT_CERT, LP_CERT, lpPhase, lpSummary, tTail, tFrom, ibeta, dayKey };
