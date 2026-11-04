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
const watchSet = () => cached("watch", async () => new Set((await sb("watchlist", { select: "player_id", active: "eq.true" })).map((w) => w.player_id)), 30000);

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
    sbCount("player_game_stats"), sbCount("alerts", { status: "eq.new" }),
    sbCount("alerts", { status: "eq.concluded" }), sbCount("data_issues", { resolved: "eq.false" }),
  ]);
  const latest = {};
  for (const r of runs) latest[r.agent] ||= r;
  return {
    kpi: {
      games_final: final.length, validated: final.filter((g) => g.validated).length, players: Object.keys(p).length,
      stat_rows: statRows, alerts_new: alertsNew, alerts_concluded: alertsDone, open_issues: issues,
      today_games: gs.filter((g) => g.et_date === today).length,
    },
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
      .sort((a, b) => (a.did_not_play - b.did_not_play) || (b.starter - a.starter) || ((+b.minutes || 0) - (+a.minutes || 0))) };
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
  return { player: { ...pl, team: t[pl.team_id] || {} }, avg: rows.find((r) => r.id === id), log, injuries: inj,
    alerts: await decorateAlerts(alerts), watch: w.has(id) };
}

async function decorateAlerts(rows) {
  const [p, t, w] = await Promise.all([players(), teams(), watchSet()]);
  const ids = rows.map((a) => a.id);
  const comments = ids.length ? await sb("alert_comments", { select: "*", alert_id: `in.(${ids.join(",")})`, order: "created_at.asc" }) : [];
  const byAlert = {};
  for (const c of comments) (byAlert[c.alert_id] ||= []).push(c);
  return rows.map((a) => {
    const pl = p[a.player_id] || {}, det = a.details || {};
    return { ...a, name: pl.full_name || det.player_name, team: t[det.team_id || pl.team_id]?.abbreviation,
      headshot: pl.headshot_url, priority: det.priority, watch: w.has(a.player_id), comments: byAlert[a.id] || [] };
  });
}

async function apiAlerts(q) {
  const params = { select: "*", order: "created_at.desc" };
  if (q.status && q.status !== "all") params.status = `eq.${q.status}`;
  const rows = await decorateAlerts(await sb("alerts", params));
  rows.sort((a, b) => (b.watch - a.watch) || ((a.status !== "new") - (b.status !== "new")) || ((b.priority || 0) - (a.priority || 0)));
  return { alerts: rows };
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
  return { date: d, dates, games: out, accuracy: { live: acc.accuracy_live || {}, backtest: acc.accuracy_backtest || {} } };
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
  if (p === "/api/predictions") return apiPredictions(q);
  if (p === "/api/refresh") { clearCache(); return { ok: true }; }
  throw new Error("unknown " + p);
}

window.NBA = { api: nbaApi, getAuth, login, logout, setAlertStatus, addComment, setWatch, clearCache };
