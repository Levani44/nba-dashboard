"use strict";
/* Data layer: reads Supabase REST directly (publishable key, read-only RLS) and computes the same
   views the old local /api server produced. Writes go only through dash_* RPCs with the shared code. */
const CFG = window.NBA_CONFIG;
const H = { apikey: CFG.key, Authorization: `Bearer ${CFG.key}` };
const TTL = 120000;
const _cache = new Map();

function qs(params) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) (Array.isArray(v) ? v : [v]).forEach((x) => u.append(k, x));
  return u.toString();
}

async function sb(table, params = {}, { page = 1000, all = true } = {}) {
  const out = [];
  for (let off = 0; ; off += page) {
    const r = await fetch(`${CFG.url}/rest/v1/${table}?${qs(params)}`, {
      headers: { ...H, "Range-Unit": "items", Range: `${off}-${off + page - 1}` },
    });
    if (!r.ok) throw new Error(`${table}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    const rows = await r.json();
    out.push(...rows);
    if (!all || rows.length < page) return out;
  }
}

async function sbCount(table, params = {}) {
  const r = await fetch(`${CFG.url}/rest/v1/${table}?${qs({ select: "*", ...params })}`, {
    method: "HEAD", headers: { ...H, Prefer: "count=exact", Range: "0-0" },
  });
  return Number((r.headers.get("content-range") || "*/0").split("/")[1]) || 0;
}

async function rpc(fn, args) {
  const r = await fetch(`${CFG.url}/rest/v1/rpc/${fn}`, {
    method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify(args),
  });
  const txt = await r.text();
  if (!r.ok) { let m = txt; try { m = JSON.parse(txt).message || txt; } catch (_) {} throw new Error(m); }
  return txt ? JSON.parse(txt) : null;
}

function cached(key, fn, ttl = TTL) {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  const v = fn();
  _cache.set(key, { t: Date.now(), v });
  v.catch(() => _cache.delete(key));
  return v;
}
function clearCache() { _cache.clear(); }

const etDate = (iso) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const byId = (rows) => Object.fromEntries(rows.map((r) => [r.id, r]));

const teams = () => cached("teams", async () => byId(await sb("teams", { select: "id,abbreviation,display_name,logo_url" })), 3600000);
const players = () => cached("players", async () => byId(await sb("players", { select: "id,full_name,team_id,position,jersey,headshot_url" })), 600000);
const games = () => cached("games", async () => (await sb("games", { select: "*", order: "game_date.asc" })).map((g) => ({ ...g, et_date: etDate(g.game_date) })));
const stats = () => cached("stats", () => sb("player_game_stats", {
  select: "game_id,player_id,team_id,starter,did_not_play,dnp_reason,minutes,points,rebounds,assists,steals,blocks,turnovers,fgm,fga,fg3m,fg3a,ftm,fta,plus_minus",
}));
const todayET = () => etDate(new Date().toISOString());
/* market player prop lines from today on (informational only) */
const propLines = () => cached("props", () => sb("player_prop_lines", {
  select: "game_id,game_date,player_id,player_name,stat,line,over_odds,under_odds,provider,fetched_at",
  game_date: `gte.${todayET()}`, order: "game_date.asc,provider.asc",
}));
/* {player_id: {stat: row}}: the player's nearest game; a missing table or outage must not break other pages */
const nextLines = () => cached("nextlines", async () => {
  const out = {};
  for (const r of await propLines()) if (r.player_id) (out[r.player_id] ||= {})[r.stat] ||= r;
  return out;
}).catch(() => ({}));
const watchSet = () => cached("watch", async () => new Set((await sb("watchlist", { select: "player_id", active: "eq.true" })).map((w) => w.player_id)), 30000);

/* signals marked for observation: {alert_id: {id, active}}; a missing table must not break other pages */
const trackedMap = () => cached("tracked", async () => Object.fromEntries((await sb("tracked_signals", { select: "id,alert_id,active" })).map((r) => [r.alert_id, r])), 30000).catch(() => ({}));
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
/* notable automatic observations on tracked signals, newest first (same event on several stats of a player shown once) */
async function watchFeed(limit = 30, days = 7) {
  const rows = await sb("tracked_observations", { select: "*", notable: "eq.true", obs_date: `gte.${daysAgo(days)}`, order: "obs_date.desc,id.desc", limit: 200 }, { all: false });
  const seen = new Set();
  return rows.filter((o) => { const k = o.kind === "game" || o.kind === "missed" || o.kind === "status" ? o.id : `${o.player_id}|${o.dedupe_key}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, limit);
}

/* ---------- views ---------- */
async function apiOverview() {
  const [gs, t, p] = await Promise.all([games(), teams(), players()]);
  const final = gs.filter((g) => g.is_final);
  const rec = {};
  for (const g of final) {
    if (g.home_score == null || g.away_score == null) continue;
    const [w, l] = g.home_score > g.away_score ? [g.home_team_id, g.away_team_id] : [g.away_team_id, g.home_team_id];
    (rec[w] ||= [0, 0])[0]++; (rec[l] ||= [0, 0])[1]++;
  }
  const standings = Object.entries(rec).filter(([id]) => t[id]).map(([id, [w, l]]) => ({
    team_id: id, abbr: t[id].abbreviation, name: t[id].display_name, logo: t[id].logo_url, w, l, pct: w + l ? w / (w + l) : 0,
  })).sort((a, b) => b.pct - a.pct || b.w - a.w);
  const today = etDate(new Date().toISOString());
  const [report, runs, statRows, alertsNew, alertsDone, issues] = await Promise.all([
    sb("daily_reports", { select: "*", order: "report_date.desc", limit: 1 }, { all: false }),
    sb("agent_runs", { select: "*", order: "id.desc", limit: 60 }, { all: false }),
    sbCount("player_game_stats"), sbCount("alerts", { status: "eq.new", window_games: "eq.3" }),
    sbCount("alerts", { status: "eq.concluded", window_games: "eq.3" }), sbCount("data_issues", { resolved: "eq.false" }),
  ]);
  const [feed, tracked] = await Promise.all([watchFeed(6, 3).catch(() => []), trackedMap()]);
  const latest = {};
  for (const r of runs) latest[r.agent] ||= r;
  return {
    kpi: {
      games_final: final.length, validated: final.filter((g) => g.validated).length, players: Object.keys(p).length,
      stat_rows: statRows, alerts_new: alertsNew, alerts_concluded: alertsDone, open_issues: issues,
      today_games: gs.filter((g) => g.et_date === today).length,
    },
    watch: { feed, active: Object.values(tracked).filter((r) => r.active).length, players: p },
    report: report[0] || null, agents: Object.values(latest), standings, last_update: runs[0]?.finished_at,
  };
}

async function apiGames(q) {
  const [gs, t, p, st] = await Promise.all([games(), teams(), players(), stats()]);
  const dates = [...new Set(gs.map((g) => g.et_date))].sort();
  let d = q.date;
  if (!d) { const f = gs.filter((g) => g.is_final).map((g) => g.et_date); d = f.at(-1) || dates.at(-1); }
  const top = {};
  for (const s of st) if (s.points != null && (!top[s.game_id] || s.points > top[s.game_id].points)) top[s.game_id] = s;
  const pick = (id) => ({ abbreviation: t[id]?.abbreviation, display_name: t[id]?.display_name, logo_url: t[id]?.logo_url });
  return {
    date: d, dates,
    games: gs.filter((g) => g.et_date === d).map((g) => {
      const ts = top[g.id];
      return { ...g, home: pick(g.home_team_id), away: pick(g.away_team_id),
        top: ts ? { name: p[ts.player_id]?.full_name, points: ts.points, team: t[ts.team_id]?.abbreviation } : null };
    }),
  };
}

async function apiGame(id) {
  const [gs, t, p] = await Promise.all([games(), teams(), players()]);
  const g = gs.find((x) => x.id === id);
  if (!g) throw new Error("not found");
  const rows = (await sb("player_game_stats", { select: "*", game_id: `eq.${id}` })).map((r) => ({ ...r, name: p[r.player_id]?.full_name }));
  const side = (k) => {
    const tid = g[`${k}_team_id`];
    return { team: t[tid], score: g[`${k}_score`], rows: rows.filter((r) => r.team_id === tid)
      .sort((a, b) => (a.did_not_play - b.did_not_play) || ((+b.minutes || 0) - (+a.minutes || 0))) };
  };
  return { game: g, home: side("home"), away: side("away") };
}

const SUMS = ["minutes", "points", "rebounds", "assists", "steals", "blocks", "turnovers", "fgm", "fga", "fg3m", "fg3a", "ftm", "fta"];
function seasonTable() {
  return cached("season", async () => {
    const [st, p, t] = await Promise.all([stats(), players(), teams()]);
    const agg = {};
    for (const s of st) {
      if (s.did_not_play || !s.minutes) continue;
      const a = (agg[s.player_id] ||= { gp: 0, team_id: s.team_id, ...Object.fromEntries(SUMS.map((k) => [k, 0])) });
      a.gp++; a.team_id = s.team_id;
      for (const k of SUMS) a[k] += Number(s[k]) || 0;
    }
    const r1 = (x) => Math.round(x * 10) / 10;
    return Object.entries(agg).map(([id, a]) => {
      const pl = p[id] || {}, tid = pl.team_id || a.team_id;
      const row = { id, name: pl.full_name, team: t[tid]?.abbreviation, team_id: tid, pos: pl.position, headshot: pl.headshot_url, gp: a.gp };
      for (const k of ["minutes", "points", "rebounds", "assists", "steals", "blocks", "turnovers", "fg3m"]) row[k] = r1(a[k] / a.gp);
      row.fg_pct = a.fga ? r1((a.fgm / a.fga) * 100) : null;
      row.fg3_pct = a.fg3a ? r1((a.fg3m / a.fg3a) * 100) : null;
      row.ft_pct = a.fta ? r1((a.ftm / a.fta) * 100) : null;
      return row;
    });
  });
}

async function apiPlayers() {
  const [rows, w] = await Promise.all([seasonTable(), watchSet()]);
  return { players: rows.map((r) => ({ ...r, watch: w.has(r.id) })) };
}

async function apiPlayer(id) {
  const [p, gs, t, rows, w] = await Promise.all([players(), games(), teams(), seasonTable(), watchSet()]);
  const pl = p[id];
  if (!pl) throw new Error("not found");
  const gmap = byId(gs);
  const own = await sb("player_game_stats", { select: "*", player_id: `eq.${id}` });
  const log = own.filter((s) => gmap[s.game_id]).map((s) => {
    const g = gmap[s.game_id], home = s.team_id === g.home_team_id;
    const opp = home ? g.away_team_id : g.home_team_id;
    const [my, th] = home ? [g.home_score, g.away_score] : [g.away_score, g.home_score];
    return { ...s, date: g.et_date, opp: t[opp]?.abbreviation, home, result: g.is_final ? ((my || 0) > (th || 0) ? "W" : "L") : "", score: `${my}-${th}` };
  }).sort((a, b) => a.date.localeCompare(b.date));
  const [inj, alerts] = await Promise.all([
    sb("injuries", { select: "*", player_id: `eq.${id}`, order: "reported_at.desc", limit: 3 }, { all: false }),
    sb("alerts", { select: "*", player_id: `eq.${id}`, order: "created_at.desc", limit: 10 }, { all: false }),
  ]);
  const avg = rows.find((r) => r.id === id);
  const last5 = log.filter((r) => !r.did_not_play && +r.minutes > 0).slice(-5);
  const lastAvg = (k) => (last5.length ? last5.reduce((s, r) => s + (Number(r[k]) || 0), 0) / last5.length : null);
  const lines = Object.values((await nextLines())[id] || {}).sort((a, b) => statRank(a.stat) - statRank(b.stat))
    .map((r) => ({ ...r, last5: lastAvg(r.stat), season: avg?.[r.stat] ?? null }));
  return { player: { ...pl, team: t[pl.team_id] || {} }, avg, lines, log, injuries: inj,
    alerts: (await decorateAlerts(alerts)).sort(alertOrder), watch: w.has(id) };
}

/* points always first, then a fixed stat order; inside a stat: ★ players, then most minutes */
const STAT_ORDER = ["points", "rebounds", "assists", "fg3m", "blocks", "steals", "minutes"];
const statRank = (s) => { const i = STAT_ORDER.indexOf(s); return i < 0 ? 99 : i; };
const alertOrder = (a, b) => (statRank(a.stat) - statRank(b.stat)) || (b.watch - a.watch) || ((+b.details?.minutes_baseline || 0) - (+a.details?.minutes_baseline || 0));

/* why an alerted player has no market line: injury, next game not today, or the book skipped him */
async function noLineReasons(rows, p, lines) {
  const missing = [...new Set(rows.filter((a) => !lines[a.player_id]?.[a.stat]).map((a) => a.player_id))];
  if (!missing.length) return {};
  const [gs, props, inj] = await Promise.all([
    games(), propLines().catch(() => []),
    sb("injuries", { select: "player_id,status,short_comment,fetched_at", player_id: `in.(${missing.join(",")})`, order: "fetched_at.desc" }).catch(() => []),
  ]);
  const today = todayET(), fresh = Date.now() - 36 * 3600000;
  const gamesWithLines = new Set(props.map((r) => r.game_id).filter(Boolean));
  const latestInj = {};
  for (const r of inj) if (!(r.player_id in latestInj)) latestInj[r.player_id] = r;
  const out = {};
  for (const id of missing) {
    const team = p[id]?.team_id, i = latestInj[id];
    if (i && new Date(i.fetched_at) > fresh && /out|doubtful/i.test(i.status || "")) {
      out[id] = { kind: "injury", text: `ტრავმა (${i.status}), ბაზარი ხაზს არ დებს`, title: i.short_comment || "" };
      continue;
    }
    const g = gs.find((x) => !x.is_final && x.et_date >= today && (x.home_team_id === team || x.away_team_id === team));
    if (!g) out[id] = { kind: "nogame", text: "უახლოესი მატჩი არ ჩანს" };
    else if (g.et_date > today) out[id] = { kind: "later", text: `შემდეგი მატჩი ${g.et_date.slice(5).replace("-", "/")}, ხაზი მატჩის დღეს გამოჩნდება` };
    else if (gamesWithLines.has(g.id)) out[id] = { kind: "skipped", text: "დღეს თამაშობს, მაგრამ ბუკმეკერმა ამ სტატისტიკაზე ხაზი არ დადო" };
    else out[id] = { kind: "pending", text: "დღეს თამაშობს, ხაზი ჯერ არ დადებულა" };
  }
  return out;
}

async function decorateAlerts(rows) {
  const [p, t, w, lines, tr] = await Promise.all([players(), teams(), watchSet(), nextLines(), trackedMap()]);
  const ids = rows.map((a) => a.id);
  const [comments, why] = await Promise.all([
    ids.length ? sb("alert_comments", { select: "*", alert_id: `in.(${ids.join(",")})`, order: "created_at.asc" }) : [],
    noLineReasons(rows, p, lines).catch(() => ({})),
  ]);
  const byAlert = {};
  for (const c of comments) (byAlert[c.alert_id] ||= []).push(c);
  return rows.map((a) => {
    const pl = p[a.player_id] || {}, det = a.details || {};
    return { ...a, name: pl.full_name || det.player_name, team: t[det.team_id || pl.team_id]?.abbreviation,
      headshot: pl.headshot_url, priority: det.priority, watch: w.has(a.player_id), comments: byAlert[a.id] || [],
      prop: lines[a.player_id]?.[a.stat] || null, noLine: why[a.player_id] || null,
      tracked: !!tr[a.id]?.active, everTracked: !!tr[a.id] };
  });
}

async function apiAlerts(q) {
  const params = { select: "*", order: "created_at.desc" };
  if (q.status && q.status !== "all") params.status = `eq.${q.status}`;
  params.window_games = `eq.${+q.window || 3}`;
  const rows = await decorateAlerts(await sb("alerts", params));
  rows.sort(alertOrder);
  return { alerts: rows };
}

/* marked signals + what happened in the games after the signal (computed daily by agents/tracker.py) */
async function apiWatch(q) {
  const archived = q.archived === "1";
  const rows = await sb("tracked_signals", { select: "*", active: `eq.${!archived}`, order: "created_at.desc" });
  if (!rows.length) return { archived, items: [], feed: archived ? [] : await watchFeed().catch(() => []), players: await players() };
  const [alerts, obs, feed, p] = await Promise.all([
    sb("alerts", { select: "*", id: `in.(${rows.map((r) => r.alert_id).join(",")})` }).then(decorateAlerts),
    sb("tracked_observations", { select: "*", tracked_id: `in.(${rows.map((r) => r.id).join(",")})`, order: "obs_date.desc,id.desc" }),
    archived ? [] : watchFeed().catch(() => []), players(),
  ]);
  const am = byId(alerts), byT = {};
  for (const o of obs) (byT[o.tracked_id] ||= []).push(o);
  const items = rows.map((r) => ({ ...r, alert: am[r.alert_id] || null, obs: byT[r.id] || [] }))
    .sort((a, b) => (statRank(a.stat) - statRank(b.stat)) || b.created_at.localeCompare(a.created_at));
  return { archived, items, feed, players: p };
}

async function apiSystem() {
  const [runs, issues, reports, sig, res] = await Promise.all([
    sb("agent_runs", { select: "*", order: "id.desc", limit: 40 }, { all: false }),
    sb("data_issues", { select: "*", order: "created_at.desc", limit: 50 }, { all: false }),
    sb("daily_reports", { select: "report_date,summary,details", order: "report_date.desc", limit: 14 }, { all: false }),
    sb("agent_runs", { select: "details", agent: "eq.signals", status: "eq.ok", order: "id.desc", limit: 1 }, { all: false }),
    sb("agent_runs", { select: "agent", agent: "eq.researcher", order: "id.desc", limit: 1 }, { all: false }),
  ]);
  return { runs, issues, reports, config: { signals: sig[0]?.details?.config || {}, research: { auto: false, max_alerts_per_run: 5, last: res[0] } } };
}

async function apiPredictions(q) {
  const [gs, t, p] = await Promise.all([games(), teams(), players()]);
  const predGames = new Set((await cached("predgames", () => sb("predictions", { select: "game_id", stat: "eq.points" }))).map((r) => r.game_id));
  const dates = [...new Set(gs.filter((g) => predGames.has(g.id)).map((g) => g.et_date))].sort();
  let d = q.date;
  if (!d) { const today = etDate(new Date().toISOString()); d = dates.find((x) => x >= today) || dates.at(-1); }
  const day = gs.filter((g) => g.et_date === d && predGames.has(g.id)).sort((a, b) => a.game_date.localeCompare(b.game_date));
  const out = [];
  if (day.length) {
    const rows = await sb("predictions", { select: "game_id,player_id,team_id,stat,predicted,low,high,naive,actual,in_range,features", game_id: `in.(${day.map((g) => g.id).join(",")})` });
    const by = {};
    for (const r of rows) ((by[r.game_id] ||= {})[r.player_id] ||= {})[r.stat] = r;
    for (const g of day) {
      const plist = Object.entries(by[g.id] || {}).map(([pid, st]) => {
        const f = st.minutes || Object.values(st)[0];
        return { id: pid, name: p[pid]?.full_name, team_id: f.team_id, headshot: p[pid]?.headshot_url, injury: f.features?.injury, stats: st };
      }).sort((a, b) => (+(b.stats.points?.predicted) || 0) - (+(a.stats.points?.predicted) || 0));
      out.push({ game: g, home: t[g.home_team_id], away: t[g.away_team_id], players: plist });
    }
  }
  const ev = await sb("agent_runs", { select: "details", agent: "eq.evaluator", status: "eq.ok", order: "id.desc", limit: 1 }, { all: false });
  const acc = ev[0]?.details || {};
  return { date: d, dates, today: etDate(new Date().toISOString()), games: out, accuracy: { live: acc.accuracy_live || {}, backtest: acc.accuracy_backtest || {} } };
}

async function apiLines(q) {
  const [rows, gs, t, p, st] = await Promise.all([propLines(), games(), teams(), players(), stats()]);
  const dates = [...new Set(rows.map((r) => r.game_date))].sort();
  const date = q.date && dates.includes(q.date) ? q.date : dates[0] || null;
  const gmap = byId(gs);
  const played = {};
  for (const s of st) if (!s.did_not_play && +s.minutes > 0 && gmap[s.game_id]) (played[s.player_id] ||= []).push(s);
  const last5 = (pid, stat) => {
    const l = (played[pid] || []).slice().sort((a, b) => gmap[a.game_id].game_date.localeCompare(gmap[b.game_id].game_date)).slice(-5);
    return l.length ? l.reduce((sum, s) => sum + (Number(s[stat]) || 0), 0) / l.length : null;
  };
  const byGame = {};
  for (const r of rows.filter((x) => x.game_date === date)) {
    const pid = r.player_id || r.player_name;
    const pl = ((byGame[r.game_id || ""] ||= {})[pid] ||= { id: r.player_id, name: r.player_name, team_id: p[r.player_id]?.team_id, stats: {} });
    pl.stats[r.stat] = { ...r, last5: r.player_id ? last5(r.player_id, r.stat) : null };
  }
  const order = (pl) => Number(pl.stats.points?.line ?? -1);
  const out = Object.entries(byGame).map(([gid, gplayers]) => {
    const g = gmap[gid] || null;
    return { game: g, home: g && t[g.home_team_id], away: g && t[g.away_team_id],
      players: Object.values(gplayers).sort((a, b) => order(b) - order(a)) };
  }).sort((a, b) => (a.game?.game_date || "z").localeCompare(b.game?.game_date || "z"));
  const dayStats = STAT_ORDER.filter((s) => rows.some((r) => r.game_date === date && r.stat === s));
  const fetched = rows.reduce((m, r) => (r.fetched_at > m ? r.fetched_at : m), "");
  return { date, dates, today: todayET(), games: out, stats: dayStats, fetched,
    providers: [...new Set(rows.filter((r) => r.game_date === date).map((r) => r.provider))] };
}

/* ---------- auth + writes (shared passcode, kept in this browser only) ---------- */
const AUTH_KEY = "nba_dash_auth";
const getAuth = () => { try { return JSON.parse(localStorage.getItem(AUTH_KEY)); } catch (_) { return null; } };
async function login(name, code) {
  const ok = await rpc("dash_check_code", { p_code: code });
  if (!ok) return false;
  localStorage.setItem(AUTH_KEY, JSON.stringify({ name, code }));
  return true;
}
const logout = () => localStorage.removeItem(AUTH_KEY);

async function setAlertStatus(id, status) {
  const a = getAuth();
  await rpc("dash_set_alert_status", { p_code: a.code, p_alert_id: id, p_status: status });
}
async function addComment(id, body) {
  const a = getAuth();
  return rpc("dash_add_comment", { p_code: a.code, p_alert_id: id, p_author: a.name, p_body: body });
}
async function trackSignal(alertId, active, note) {
  const a = getAuth();
  await rpc("dash_track_signal", { p_code: a.code, p_alert_id: alertId, p_active: active, p_note: note || null, p_by: a.name });
  _cache.delete("tracked"); _cache.delete("watch");
}
async function setWatch(pid, active) {
  const a = getAuth();
  await rpc("dash_watchlist_set", { p_code: a.code, p_player_id: pid, p_active: active, p_note: null, p_added_by: a.name });
  _cache.delete("watch");
}

/* router compatible with the old /api paths */
async function nbaApi(path) {
  const u = new URL(path, "http://local");
  const q = Object.fromEntries(u.searchParams);
  const p = u.pathname;
  if (p === "/api/overview") return apiOverview();
  if (p === "/api/games") return apiGames(q);
  if (p.startsWith("/api/game/")) return apiGame(p.split("/").pop());
  if (p === "/api/players") return apiPlayers();
  if (p.startsWith("/api/player/")) return apiPlayer(p.split("/").pop());
  if (p === "/api/alerts") return apiAlerts(q);
  if (p === "/api/system") return apiSystem();
  if (p === "/api/watch") return apiWatch(q);
  if (p === "/api/predictions") return apiPredictions(q);
  if (p === "/api/lines") return apiLines(q);
  if (p === "/api/refresh") { clearCache(); return { ok: true }; }
  throw new Error("unknown " + p);
}

window.NBA = { api: nbaApi, getAuth, login, logout, setAlertStatus, addComment, setWatch, trackSignal, clearCache };
