"use strict";
const $ = (s, el = document) => el.querySelector(s);
const view = $("#view");
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (v, d = 1) => (v === null || v === undefined || v === "" ? "–" : Number(v).toFixed(d).replace(/\.0$/, d ? ".0" : ""));
const api = (path) => window.NBA.api(path);

const STAT_KA = { points: "ქულები", rebounds: "მოხსნები", assists: "პასები", blocks: "ბლოკები", fg3m: "სამქულიანები", minutes: "წუთები" };
const LINE_STAT_KA = { ...STAT_KA, steals: "მოპარვები" };
const oddsTitle = (r) => (r.over_odds || r.under_odds ? `მეტი ${r.over_odds || "–"} / ნაკლები ${r.under_odds || "–"}` : "");
const VERDICT = {
  real_change: ["რეალური ცვლილება", "good"], noise: ["შემთხვევითი რყევა", "mute"], unclear: ["გაურკვეველი", "warn"],
};
const STATUS = { new: ["ახალი", "info"], investigating: ["კვლევაშია", "warn"], concluded: ["დასრულებული", "good"], closed: ["დახურული", "mute"] };
const RUN = { ok: "good", warning: "warn", failed: "bad", running: "info" };
const AGENT_KA = {
  collector: "შემგროვებელი", validator: "ვალიდატორი", signals: "სიგნალები", researcher: "მკვლევარი",
  reporter: "რეპორტიორი", predictor: "პროგნოზისტი", evaluator: "შემფასებელი", odds: "ბაზრის ხაზები", report_numeric: "რიცხვითი ანგარიში", orchestrator: "ორკესტრატორი",
};
const fmtDate = (s) => { if (!s) return "–"; const d = new Date(s); return d.toLocaleString("ka-GE", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); };
const fmtDay = (s) => new Date(s + "T12:00:00").toLocaleDateString("ka-GE", { weekday: "short", month: "long", day: "numeric" });
const pill = (txt, cls) => `<span class="pill ${cls}">${esc(txt)}</span>`;
/* recent average compared with the market line */
const vsLine = (avg, line) => {
  if (avg === null || avg === undefined) return "";
  const a = Number(avg), l = Number(line);
  return a > l ? pill("▲ ხაზზე მაღლა", "good") : a < l ? pill("▼ ხაზზე დაბლა", "bad") : pill("ხაზზე", "mute");
};
const teamTag = (t) => t ? `<span class="team">${t.logo_url || t.logo ? `<img src="${esc(t.logo_url || t.logo)}" alt="" loading="lazy">` : ""}${esc(t.abbreviation || t.abbr || "")}</span>` : "";

/* tiny markdown: headings, bullets, bold */
function md(src) {
  const lines = String(src || "").split(/\r?\n/);
  let html = "", inList = false;
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  for (const ln of lines) {
    const h = ln.match(/^(#{1,3})\s+(.*)/), li = ln.match(/^\s*[-*]\s+(.*)/);
    if (!li && inList) { html += "</ul>"; inList = false; }
    if (h) html += `<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`;
    else if (li) { if (!inList) { html += "<ul>"; inList = true; } html += `<li>${inline(li[1])}</li>`; }
    else if (ln.trim()) html += `<p>${inline(ln)}</p>`;
  }
  return html + (inList ? "</ul>" : "");
}

/* ---------------- Overview ---------------- */
async function overview() {
  const d = await api("/api/overview");
  const k = d.kpi;
  $("#nav-alerts").textContent = k.alerts_new || "";
  $("#updated").textContent = d.last_update ? "ბოლო განახლება: " + fmtDate(d.last_update) : "";
  const kpi = (label, value, hint = "", cls = "") => `<div class="card kpi ${cls}"><div class="label">${label}</div><div class="value">${value}</div><div class="hint">${hint}</div></div>`;
  const st = d.standings;
  view.innerHTML = `
    <div class="head"><div><h1>მიმოხილვა</h1><p class="sub">სეზონის მდგომარეობა და დღევანდელი ანგარიში</p></div></div>
    <div class="grid kpis">
      ${kpi("დასრულებული მატჩები", k.games_final, `${k.validated} შემოწმებული`)}
      ${kpi("დღეს მატჩები", k.today_games, "ET დროით")}
      ${kpi("მოთამაშეები", k.players, `${k.stat_rows.toLocaleString()} სტატ. ხაზი`)}
      ${kpi("სიგნალები კვლევისთვის", k.alerts_new, `${k.alerts_concluded} დასრულებული`, "accent")}
      ${kpi("მონაცემთა პრობლემები", k.open_issues, k.open_issues ? "ნახე სისტემაში" : "ყველაფერი რიგზეა")}
    </div>
    <div class="grid cols-2">
      <div class="card report">${d.report ? `<div class="toolbar" style="justify-content:space-between;margin-bottom:6px">
          <span class="muted">${esc(d.report.report_date)}</span>${pill(d.report.details?.source === "claude" ? "Claude ანგარიში" : "ავტომატური", d.report.details?.source === "claude" ? "info" : "mute")}</div>
          ${md(d.report.summary)}` : `<div class="empty">ანგარიში ჯერ არ არის</div>`}</div>
      <div class="grid" style="align-content:start">
        <div class="card"><h2>აგენტები</h2><div class="agents">
          ${d.agents.map((a) => `<div class="agent"><div><b>${esc(AGENT_KA[a.agent] || a.agent)}</b><small>${esc(a.message || "")}</small></div>
            <div style="text-align:right">${pill(a.status, RUN[a.status] || "mute")}<br><small class="muted">${fmtDate(a.finished_at || a.started_at)}</small></div></div>`).join("")}
        </div></div>
        <div class="card"><h2>ცხრილი (მოგება–წაგება)</h2><div class="table-wrap" style="max-height:420px"><table>
          <thead><tr><th>#</th><th>გუნდი</th><th class="num">W</th><th class="num">L</th><th class="num">%</th></tr></thead>
          <tbody>${st.map((r, i) => `<tr><td class="muted">${i + 1}</td><td>${teamTag(r)}</td><td class="num">${r.w}</td><td class="num">${r.l}</td><td class="num">${(r.pct * 100).toFixed(0)}</td></tr>`).join("")}</tbody>
        </table></div></div>
      </div>
    </div>`;
}

/* ---------------- Games ---------------- */
async function gamesView(params) {
  const d = await api("/api/games" + (params.date ? `?date=${encodeURIComponent(params.date)}` : ""));
  const i = d.dates.indexOf(d.date);
  const prev = d.dates[i - 1], next = d.dates[i + 1];
  const card = (g) => {
    const final = g.is_final, hw = final && g.home_score > g.away_score, aw = final && g.away_score > g.home_score;
    const row = (t, s, win, lose) => `<div class="row ${lose ? "lose" : ""}"><span class="team"><img src="${esc(t.logo_url)}" alt="" loading="lazy"><span><b>${esc(t.abbreviation)}</b> <span class="muted">${esc(t.display_name)}</span></span></span><span class="score">${s ?? ""}</span></div>`;
    const state = final ? pill("დასრულდა", "mute") : g.status === "STATUS_IN_PROGRESS" ? pill("მიმდინარე", "bad") : pill(new Date(g.game_date).toLocaleTimeString("ka-GE", { hour: "2-digit", minute: "2-digit" }), "info");
    return `<div class="card game ${final ? "click" : ""}" ${final ? `data-game="${esc(g.id)}"` : ""}>
      ${row(g.away, g.away_score, aw, hw)}${row(g.home, g.home_score, hw, aw)}
      <div class="meta"><span>${g.top ? `⭐ ${esc(g.top.name)} (${esc(g.top.team)}) ${g.top.points} ქ.` : "სტუმარი / მასპინძელი"}</span>${state}</div></div>`;
  };
  view.innerHTML = `
    <div class="head"><div><h1>მატჩები</h1><p class="sub">${d.date ? fmtDay(d.date) : ""} · ${d.games.length} მატჩი</p></div>
      <div class="datebar">
        <button class="btn icon" ${prev ? `data-go="${prev}"` : "disabled"}>←</button>
        <input type="date" id="gdate" value="${esc(d.date || "")}" min="${esc(d.dates[0] || "")}" max="${esc(d.dates.at(-1) || "")}">
        <button class="btn icon" ${next ? `data-go="${next}"` : "disabled"}>→</button>
      </div></div>
    ${d.games.length ? `<div class="grid games">${d.games.map(card).join("")}</div>` : `<div class="card empty">ამ დღეს მატჩი არ არის</div>`}`;
  view.querySelectorAll("[data-go]").forEach((b) => (b.onclick = () => (location.hash = `#/games?date=${b.dataset.go}`)));
  $("#gdate").onchange = (e) => (location.hash = `#/games?date=${e.target.value}`);
  view.querySelectorAll("[data-game]").forEach((c) => (c.onclick = () => openGame(c.dataset.game)));
}

async function openGame(id) {
  modal(`<div class="loading">იტვირთება…</div>`);
  const d = await api(`/api/game/${id}`);
  const side = (s) => `<div class="card mt"><h2>${teamTag(s.team)}</h2><div class="table-wrap"><table>
    <thead><tr><th>მოთამაშე</th><th class="num">PTS</th><th class="num">MIN</th><th class="num">REB</th><th class="num">AST</th><th class="num">STL</th><th class="num">BLK</th><th class="num">TO</th><th class="num">FG</th><th class="num">3PT</th><th class="num">FT</th><th class="num">+/-</th></tr></thead>
    <tbody>${s.rows.map((r) => r.did_not_play
      ? `<tr class="dnp click" data-player="${esc(r.player_id)}"><td>${esc(r.name)}</td><td colspan="11">DNP${r.dnp_reason ? " – " + esc(r.dnp_reason) : ""}</td></tr>`
      : `<tr class="click" data-player="${esc(r.player_id)}"><td>${r.starter ? "<b>" + esc(r.name) + "</b>" : esc(r.name)}</td><td class="num"><b>${r.points}</b></td><td class="num">${num(r.minutes, 0)}</td><td class="num">${r.rebounds}</td><td class="num">${r.assists}</td><td class="num">${r.steals}</td><td class="num">${r.blocks}</td><td class="num">${r.turnovers}</td><td class="num">${r.fgm}-${r.fga}</td><td class="num">${r.fg3m}-${r.fg3a}</td><td class="num">${r.ftm}-${r.fta}</td><td class="num">${r.plus_minus > 0 ? "+" : ""}${r.plus_minus ?? ""}</td></tr>`).join("")}</tbody></table></div></div>`;
  modal(`<div class="box-head">
      <div class="t"><img src="${esc(d.away.team.logo_url)}" alt=""><div>${esc(d.away.team.abbreviation)}</div></div>
      <div class="s">${d.away.score} – ${d.home.score}</div>
      <div class="t"><img src="${esc(d.home.team.logo_url)}" alt=""><div>${esc(d.home.team.abbreviation)}</div></div></div>
    <p class="sub" style="text-align:center">${fmtDate(d.game.game_date)} ${d.game.validated ? pill("✓ შემოწმებული", "good") : ""}</p>
    ${side(d.away)}${side(d.home)}<p class="muted">სახელი მუქად = სასტარტო შემადგენლობა. დააჭირე მოთამაშეს პროფილისთვის.</p>`);
  $("#modal-body").querySelectorAll("[data-player]").forEach((r) => (r.onclick = () => openPlayer(r.dataset.player)));
}

/* ---------------- Players ---------------- */
const pstate = { q: "", team: "", sort: "points", dir: -1, minGp: 3, watch: false };
let pcache = null;
async function playersView() {
  const d = pcache || (pcache = await api("/api/players"));
  const teams = [...new Set(d.players.map((p) => p.team).filter(Boolean))].sort();
  view.innerHTML = `
    <div class="head"><div><h1>მოთამაშეები</h1><p class="sub">სეზონის საშუალოები თითო თამაშზე</p></div>
      <div class="toolbar">
        <input type="search" id="pq" placeholder="მოძებნე მოთამაშე…" value="${esc(pstate.q)}">
        <select id="pteam"><option value="">ყველა გუნდი</option>${teams.map((t) => `<option ${t === pstate.team ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>
        <select id="pgp">${[1, 3, 5, 8].map((n) => `<option value="${n}" ${n === pstate.minGp ? "selected" : ""}>≥${n} თამაში</option>`).join("")}</select>
        <button class="chip ${pstate.watch ? "on" : ""}" id="pwatch">★ ჩემი სია</button>
      </div></div>
    <div class="card"><div class="table-wrap" id="ptable"></div></div>`;
  const cols = [["name", "მოთამაშე"], ["team", "გუნდი"], ["gp", "GP", 1], ["points", "PTS", 1], ["minutes", "MIN", 1], ["rebounds", "REB", 1], ["assists", "AST", 1],
    ["steals", "STL", 1], ["blocks", "BLK", 1], ["fg3m", "3PM", 1], ["fg_pct", "FG%", 1], ["fg3_pct", "3P%", 1], ["ft_pct", "FT%", 1]];
  const render = () => {
    const q = pstate.q.toLowerCase();
    let rows = d.players.filter((p) => p.gp >= pstate.minGp && (!pstate.team || p.team === pstate.team) && (!q || (p.name || "").toLowerCase().includes(q)) && (!pstate.watch || p.watch));
    rows.sort((a, b) => { const x = a[pstate.sort], y = b[pstate.sort]; return (typeof x === "string" ? String(x).localeCompare(y) : (x ?? -1) - (y ?? -1)) * pstate.dir; });
    $("#ptable").innerHTML = rows.length ? `<table><thead><tr><th></th>${cols.map(([k, l, n]) => `<th class="sort ${n ? "num" : ""} ${pstate.sort === k ? "sorted" : ""}" data-k="${k}">${l}${pstate.sort === k ? (pstate.dir < 0 ? " ↓" : " ↑") : ""}</th>`).join("")}</tr></thead>
      <tbody>${rows.slice(0, 300).map((p) => `<tr class="click" data-player="${esc(p.id)}"><td><button class="star ${p.watch ? "on" : ""}" data-star="${esc(p.id)}" title="ჩემს სიაში">★</button></td>
        <td><div class="who"><img class="avatar" src="${esc(p.headshot || "")}" alt="" loading="lazy" onerror="this.style.visibility='hidden'"><div><b>${esc(p.name)}</b><small>${esc(p.pos || "")}</small></div></div></td>
        <td>${esc(p.team || "")}</td>${cols.slice(2).map(([k]) => `<td class="num">${k === "gp" ? p.gp : num(p[k])}</td>`).join("")}</tr>`).join("")}</tbody></table>`
      : `<div class="empty">ვერაფერი მოიძებნა</div>`;
    $("#ptable").querySelectorAll("th.sort").forEach((th) => (th.onclick = () => { const k = th.dataset.k; pstate.dir = pstate.sort === k ? -pstate.dir : (k === "name" || k === "team" ? 1 : -1); pstate.sort = k; render(); }));
    $("#ptable").querySelectorAll("tr[data-player]").forEach((tr) => (tr.onclick = (e) => { if (!e.target.closest(".star")) openPlayer(tr.dataset.player); }));
    $("#ptable").querySelectorAll("[data-star]").forEach((b) => (b.onclick = async () => { const p = d.players.find((x) => x.id === b.dataset.star); if (await toggleWatch(p.id, !p.watch)) { p.watch = !p.watch; render(); } }));
  };
  $("#pq").oninput = (e) => { pstate.q = e.target.value; render(); };
  $("#pteam").onchange = (e) => { pstate.team = e.target.value; render(); };
  $("#pgp").onchange = (e) => { pstate.minGp = +e.target.value; render(); };
  $("#pwatch").onclick = (e) => { pstate.watch = !pstate.watch; e.target.classList.toggle("on", pstate.watch); render(); };
  render();
}

async function toggleWatch(id, active) {
  if (!(await requireAuth())) return false;
  try { await window.NBA.setWatch(id, active); } catch (e) { toast("შეცდომა: " + e.message); return false; }
  pcache = null;
  toast(active ? "★ დაემატა ჩემს სიაში" : "ამოიშალა სიიდან");
  return true;
}

function barChart(log, key, avg) {
  // showMin: under each bar, also show the minutes played in that game (not needed on the minutes chart itself)
  const showMin = key !== "minutes";
  const W = 760, H = showMin ? 186 : 170, P = 22, PB = showMin ? 38 : 22, n = log.length;
  if (!n) return "";
  const max = Math.max(1, ...log.map((r) => Number(r[key]) || 0), avg || 0);
  const bw = Math.min(42, (W - P * 2) / n - 6);
  const x = (i) => P + i * ((W - P * 2) / n) + 3;
  const y = (v) => H - PB - (v / max) * (H - P - PB);
  const mins = (r) => (r.did_not_play || r.minutes == null ? "" : `${Math.round(Number(r.minutes))} წუთი`);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:${H}px">
    ${log.map((r, i) => { const v = r.did_not_play ? 0 : Number(r[key]) || 0, m = mins(r); return `<rect class="bar ${r.did_not_play ? "dnp" : ""}" x="${x(i)}" y="${y(v)}" width="${bw}" height="${H - PB - y(v)}" rx="4"><title>${esc(r.date)} vs ${esc(r.opp)}: ${v}${m ? " · " + m : ""}</title></rect>
      <text x="${x(i) + bw / 2}" y="${y(v) - 4}" text-anchor="middle">${r.did_not_play ? "" : v}</text>
      <text x="${x(i) + bw / 2}" y="${H - PB + 14}" text-anchor="middle">${esc(r.opp || "")}</text>
      ${showMin ? `<text class="min" x="${x(i) + bw / 2}" y="${H - 6}" text-anchor="middle">${r.did_not_play ? "DNP" : m}</text>` : ""}`; }).join("")}
    ${avg ? `<line class="avg" x1="${P}" x2="${W - P}" y1="${y(avg)}" y2="${y(avg)}"/>` : ""}
  </svg>`;
}

async function openPlayer(id) {
  modal(`<div class="loading">იტვირთება…</div>`);
  const d = await api(`/api/player/${id}`);
  const p = d.player, a = d.avg || {};
  let key = "points";
  const drawChart = () => { $("#pchart").innerHTML = barChart(d.log, key, a[key]); };
  const inj = d.injuries[0];
  modal(`<div class="prof"><img class="avatar lg" src="${esc(p.headshot_url || "")}" alt="" onerror="this.style.visibility='hidden'">
      <div><h1>${esc(p.full_name)} <button class="star ${d.watch ? "on" : ""}" id="pstar" title="ჩემს სიაში">★</button></h1>
      <div class="muted">${teamTag(p.team)} · ${esc(p.position || "")} ${p.jersey ? "· #" + esc(p.jersey) : ""}</div>
      ${inj ? `<div class="mt">${pill("🩹 " + inj.status, "bad")} <span class="muted">${esc(inj.short_comment || "")}</span></div>` : ""}</div></div>
    <div class="statline">${[["GP", a.gp], ["PTS", num(a.points)], ["MIN", num(a.minutes)], ["REB", num(a.rebounds)], ["AST", num(a.assists)], ["STL", num(a.steals)], ["BLK", num(a.blocks)], ["3PM", num(a.fg3m)], ["FG%", num(a.fg_pct)], ["3P%", num(a.fg3_pct)]]
      .map(([l, v]) => `<div><b>${v ?? "–"}</b><small>${l}</small></div>`).join("")}</div>
    ${d.lines.length ? `<h2>ბაზრის ხაზები <small class="muted" style="font-weight:400">${esc(d.lines[0].provider)} · ${esc(d.lines[0].game_date)}</small></h2><div class="table-wrap mb"><table>
      <thead><tr><th>სტატისტიკა</th><th class="num">ხაზი</th><th class="num">ბოლო 5-ის საშუალო</th><th class="num">სეზონის საშუალო</th><th></th></tr></thead>
      <tbody>${d.lines.map((r) => `<tr><td>${esc(LINE_STAT_KA[r.stat] || r.stat)}</td><td class="num" title="${esc(oddsTitle(r))}"><b>${num(r.line)}</b></td><td class="num">${num(r.last5)}</td><td class="num">${num(r.season)}</td><td>${vsLine(r.last5, r.line)}</td></tr>`).join("")}</tbody></table></div>` : ""}
    <div class="toolbar" style="justify-content:space-between"><h2 style="margin:0">ფორმა თამაშების მიხედვით</h2>
      <div class="chips" id="pkeys">${Object.entries(STAT_KA).map(([k, l]) => `<button class="chip ${k === key ? "on" : ""}" data-k="${k}">${l}</button>`).join("")}</div></div>
    <div id="pchart" class="mt"></div><p class="muted" style="margin:4px 0 0">წყვეტილი ხაზი = სეზონის საშუალო</p>
    ${d.alerts.length ? `<h2 class="mt">სიგნალები</h2>${d.alerts.map(alertCard).join("")}` : ""}
    <h2 class="mt">თამაშების ჟურნალი</h2><div class="table-wrap"><table>
      <thead><tr><th>თარიღი</th><th>მეტოქე</th><th>შედეგი</th><th class="num">PTS</th><th class="num">MIN</th><th class="num">REB</th><th class="num">AST</th><th class="num">BLK</th><th class="num">FG</th><th class="num">3PT</th><th class="num">+/-</th></tr></thead>
      <tbody>${[...d.log].reverse().map((r) => `<tr class="${r.did_not_play ? "dnp" : ""}"><td>${esc(r.date)}</td><td>${r.home ? "" : "@ "}${esc(r.opp)}</td><td>${r.result ? pill(r.result + " " + r.score, r.result === "W" ? "good" : "bad") : ""}</td>
        ${r.did_not_play ? `<td colspan="8" class="muted">DNP ${esc(r.dnp_reason || "")}</td>` : `<td class="num"><b>${r.points}</b></td><td class="num">${num(r.minutes, 0)}</td><td class="num">${r.rebounds}</td><td class="num">${r.assists}</td><td class="num">${r.blocks}</td><td class="num">${r.fgm}-${r.fga}</td><td class="num">${r.fg3m}-${r.fg3a}</td><td class="num">${r.plus_minus > 0 ? "+" : ""}${r.plus_minus ?? ""}</td>`}</tr>`).join("")}</tbody></table></div>`);
  drawChart();
  $("#pkeys").querySelectorAll("[data-k]").forEach((b) => (b.onclick = () => { key = b.dataset.k; $("#pkeys").querySelectorAll(".chip").forEach((c) => c.classList.toggle("on", c === b)); drawChart(); }));
  $("#pstar").onclick = async (e) => { if (await toggleWatch(p.id, !d.watch)) { d.watch = !d.watch; e.target.classList.toggle("on", d.watch); } };
  bindAlertActions($("#modal-body"), () => openPlayer(id));
}

/* ---------------- Predictions ---------------- */
async function predictionsView(params) {
  const d = await api("/api/predictions" + (params.date ? `?date=${encodeURIComponent(params.date)}` : ""));
  const live = Object.keys(d.accuracy.live).length > 0;
  const acc = live ? d.accuracy.live : d.accuracy.backtest;
  const i = d.dates.indexOf(d.date), prev = d.dates[i - 1], next = d.dates[i + 1];
  const keys = [["points", "PTS"], ["minutes", "MIN"], ["rebounds", "REB"], ["assists", "AST"], ["fg3m", "3PM"]];
  const accCard = (k, l) => { const a = acc[k]; if (!a) return ""; const better = a.improvement_pct > 0;
    return `<div class="card kpi"><div class="label">${STAT_KA[k] || l}</div><div class="value">±${num(a.mae, 2)}</div>
      <div class="hint">საშუალოსთან ±${num(a.naive_mae, 2)} · <span class="pill ${better ? "good" : "bad"}">${a.improvement_pct > 0 ? "+" : ""}${num(a.improvement_pct)}%</span></div>
      <div class="hint">დიაპაზონში: ${num(a.in_range_pct, 0)}% · n=${a.n}</div></div>`; };
  const cell = (st) => { if (!st) return `<td class="num muted">–</td>`;
    const act = st.actual !== null && st.actual !== undefined;
    return `<td class="num" title="დიაპაზონი ${num(st.low)}–${num(st.high)} · საშუალო ${num(st.naive)}"><b>${num(st.predicted)}</b>
      ${act ? `<br><span class="pill ${st.in_range ? "good" : "bad"}">${num(st.actual, 0)}</span>` : `<br><small class="muted">${num(st.low, 0)}–${num(st.high, 0)}</small>`}</td>`; };
  const game = (G, idx) => { const g = G.game, final = g.is_final;
    const team = (tid) => G.players.filter((p) => p.team_id === tid);
    const tbl = (t, rows) => `<h2 class="mt">${teamTag(t)}</h2><div class="table-wrap"><table>
      <thead><tr><th>მოთამაშე</th>${keys.map(([, l]) => `<th class="num">${l}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((p) => `<tr class="click" data-player="${esc(p.id)}"><td><b>${esc(p.name)}</b>${p.injury ? " " + pill("🩹 " + p.injury, "warn") : ""}</td>${keys.map(([k]) => cell(p.stats[k])).join("")}</tr>`).join("")}</tbody></table></div>`;
    return `<details class="card mt" ${final && idx > 1 ? "" : "open"}><summary style="cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:10px">
        <span class="team">${teamTag(G.away)} <span class="muted">@</span> ${teamTag(G.home)}</span>
        <span>${final ? pill(`${g.away_score}–${g.home_score} დასრულდა`, "mute") : pill(new Date(g.game_date).toLocaleTimeString("ka-GE", { hour: "2-digit", minute: "2-digit" }), "info")}</span></summary>
      ${tbl(G.away, team(g.away_team_id))}${tbl(G.home, team(g.home_team_id))}</details>`; };
  view.innerHTML = `
    <div class="head"><div><h1>პროგნოზები</h1><p class="sub">მოდელი baseline_v1 · ${d.date ? fmtDay(d.date) : ""} · ${d.games.length} მატჩი</p></div>
      <div class="datebar"><button class="btn icon" ${prev ? `data-go="${prev}"` : "disabled"}>←</button>
        <select id="pdate">${d.dates.map((x) => `<option ${x === d.date ? "selected" : ""}>${x}</option>`).join("")}</select>
        <button class="btn icon" ${next ? `data-go="${next}"` : "disabled"}>→</button></div></div>
    ${d.date !== d.today ? `<div class="card notice">ℹ️ დღევანდელი (${esc(d.today)}, აშშ დროით) პროგნოზები ჯერ არ არის. ისინი ყოველდღე <b>15:00-ზე</b> (თბილისის დროით) ავტომატური გაშვების შემდეგ ჩნდება. ქვემოთ ბოლო ხელმისაწვდომი დღეა (${esc(d.date)}).</div>` : ""}
    ${d.games.length ? d.games.map(game).join("") : `<div class="card empty">პროგნოზები ჯერ არ არის. ისინი ყოველდღე 15:00-ზე (თბილისის დროით) ჩნდება.</div>`}
    <h2 class="mt" style="margin-top:28px">სიზუსტე ${live ? "(რეალური პროგნოზები)" : "(backtest: წარსული მატჩები, მხოლოდ მანამდე არსებული მონაცემით)"}</h2>
    <div class="grid kpis">${keys.map(([k, l]) => accCard(k, l)).join("")}</div>
    <p class="muted" style="margin-top:4px">±ცდომილება = საშუალოდ რამდენით სცდება. „საშუალოსთან“ = თუ უბრალოდ სეზონის საშუალოს ვიტყოდით. მწვანე % = მოდელი ჯობია. ცხრილში: მსხვილი = პროგნოზი, ქვემოთ დიაპაზონი ან ფაქტი (მწვანე = დიაპაზონში მოხვდა).</p>`;
  view.querySelectorAll("[data-go]").forEach((b) => (b.onclick = () => (location.hash = `#/predictions?date=${b.dataset.go}`)));
  $("#pdate").onchange = (e) => (location.hash = `#/predictions?date=${e.target.value}`);
  view.querySelectorAll("tr[data-player]").forEach((tr) => (tr.onclick = () => openPlayer(tr.dataset.player)));
}

/* ---------------- Market lines ---------------- */
async function linesView(params) {
  const d = await api("/api/lines" + (params.date ? `?date=${encodeURIComponent(params.date)}` : ""));
  const cell = (st) => (st ? `<td class="num" title="${esc(oddsTitle(st))}"><b>${num(st.line)}</b>${st.last5 != null ? `<br><small class="${Number(st.last5) > Number(st.line) ? "up" : Number(st.last5) < Number(st.line) ? "down" : "muted"}">${num(st.last5)}</small>` : ""}</td>` : `<td class="num muted">–</td>`);
  const table = (rows) => `<div class="table-wrap"><table><thead><tr><th>მოთამაშე</th>${d.stats.map((s) => `<th class="num">${esc(LINE_STAT_KA[s] || s)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((p) => `<tr ${p.id ? `class="click" data-player="${esc(p.id)}"` : ""}><td><b>${esc(p.name)}</b></td>${d.stats.map((s) => cell(p.stats[s])).join("")}</tr>`).join("")}</tbody></table></div>`;
  const game = (G) => {
    if (!G.game) return `<div class="card mt"><h2>სხვა</h2>${table(G.players)}</div>`;
    const g = G.game, of = (tid) => G.players.filter((p) => p.team_id === tid), rest = G.players.filter((p) => p.team_id !== g.away_team_id && p.team_id !== g.home_team_id);
    return `<div class="card mt"><div class="toolbar" style="justify-content:space-between"><span class="team">${teamTag(G.away)} <span class="muted">@</span> ${teamTag(G.home)}</span>${pill(new Date(g.game_date).toLocaleTimeString("ka-GE", { hour: "2-digit", minute: "2-digit" }), "info")}</div>
      <h2 class="mt">${teamTag(G.away)}</h2>${table(of(g.away_team_id))}<h2 class="mt">${teamTag(G.home)}</h2>${table(of(g.home_team_id))}${rest.length ? `<h2 class="mt">სხვა</h2>${table(rest)}` : ""}</div>`;
  };
  view.innerHTML = `
    <div class="head"><div><h1>ბაზრის ხაზები</h1><p class="sub">${d.date ? `${fmtDay(d.date)} · ${d.games.length} მატჩი · ${esc(d.providers.join(", "))}` : "მომავალი მატჩები"}</p></div>
      ${d.dates.length > 1 ? `<div class="datebar"><select id="ldate">${d.dates.map((x) => `<option ${x === d.date ? "selected" : ""}>${x}</option>`).join("")}</select></div>` : ""}</div>
    ${d.games.length ? `${d.date !== d.today ? `<div class="card notice">ℹ️ დღევანდელი (${esc(d.today)}, აშშ დროით) ხაზები არ არის. ქვემოთ უახლოესი დღეა.</div>` : ""}${d.games.map(game).join("")}
      <p class="muted" style="margin-top:10px">მსხვილი = ბაზრის ხაზი, ქვემოთ = ბოლო 5 თამაშის საშუალო (მწვანე = ხაზზე მაღლა, წითელი = დაბლა). მხოლოდ ინფორმაციისთვის. განახლდა: ${fmtDate(d.fetched)}</p>`
      : `<div class="card empty">ხაზები ჯერ არ არის. ისინი ყოველდღე 15:00-ზე (თბილისის დროით) ჩნდება.</div>`}`;
  const sel = $("#ldate"); if (sel) sel.onchange = (e) => (location.hash = `#/lines?date=${e.target.value}`);
  view.querySelectorAll("tr[data-player]").forEach((tr) => (tr.onclick = () => openPlayer(tr.dataset.player)));
}

/* ---------------- Alerts ---------------- */
function alertCard(a) {
  const det = a.details || {};
  const up = a.rule === "above_avg_streak";
  const v = VERDICT[a.verdict], s = STATUS[a.status] || [a.status, "mute"];
  return `<div class="card alert">
    <div class="top"><div class="who">${a.headshot ? `<img class="avatar" src="${esc(a.headshot)}" alt="" loading="lazy">` : ""}
      <div><b class="click" data-player="${esc(a.player_id)}" style="cursor:pointer">${esc(a.name || det.player_name)}</b>${a.watch ? ' <span class="star on">★</span>' : ""}<small>${esc(a.team || "")} · ${esc(STAT_KA[a.stat] || a.stat)}</small></div></div>
      <div style="text-align:right">${v ? pill(v[0], v[1]) : pill(s[0], s[1])}</div></div>
    <div class="change"><span class="pill ${up ? "good" : "bad"}">${up ? "▲ მატება" : "▼ კლება"}</span>
      <span class="muted" title="საშუალო ბოლო ${a.window_games || 3} თამაშამდე"><small>საშუალო</small> ${num(a.season_avg)}</span><span class="arrow">→</span><b title="ბოლო ${a.window_games || 3} თამაში, ძველიდან ახლისკენ"><small class="muted" style="font-size:12px;font-weight:400">ბოლო ${a.window_games || 3}:</small> ${(det.last_values || []).map((x, i) => num(x, 0) + (a.stat !== "minutes" && det.minutes_last && det.minutes_last[i] != null ? ` <small class="muted" style="font-size:12px;font-weight:400">(${num(det.minutes_last[i], 0)} წუთი)</small>` : "")).join(" · ")}</b></div>
    <div class="facts"><span>⏱ წუთი: ${num(det.minutes_baseline)} → ${(det.minutes_last || []).map((x) => num(x, 0)).join("/")}</span>
      <span>🎯 FGA: ${num(det.fga_baseline)} → ${(det.fga_last || []).join("/")}</span>${det.priority != null ? `<span>⚡ ${num(det.priority, 0)}</span>` : ""}</div>
    ${a.prop ? `<div class="mline" title="${esc(oddsTitle(a.prop))}">ბაზრის ხაზი: <b>${num(a.prop.line)}</b> <span class="muted">(${esc(a.prop.provider)}${a.prop.game_date !== todayET() ? " · " + esc(a.prop.game_date) : ""})</span>
      ${a.recent_avg != null ? `<span class="muted">ბოლო ${a.window_games || 3}-ის საშუალო ${num(a.recent_avg)}</span> ${vsLine(a.recent_avg, a.prop.line)}` : ""}</div>` : ""}
    ${a.conclusion ? `<p>${esc(a.conclusion)}</p>` : ""}
    <div class="actions">${Object.entries(STATUS).map(([k, [l]]) => `<button class="chip sm ${a.status === k ? "on" : ""}" data-status="${k}" data-alert="${a.id}">${l}</button>`).join("")}</div>
    <div class="comments">${(a.comments || []).map((c) => `<div class="cmt"><b>${esc(c.author)}</b> <small class="muted">${fmtDate(c.created_at)}</small><div>${esc(c.body)}</div></div>`).join("")}
      <form class="cform" data-alert="${a.id}"><input name="body" placeholder="კომენტარი…" maxlength="2000" autocomplete="off"><button class="btn sm">➤</button></form></div></div>`;
}

function bindAlertActions(root, rerender) {
  root.querySelectorAll("[data-status]").forEach((b) => (b.onclick = async () => {
    if (!(await requireAuth())) return;
    try { await window.NBA.setAlertStatus(+b.dataset.alert, b.dataset.status); toast("სტატუსი შეიცვალა"); rerender(); }
    catch (e) { toast("შეცდომა: " + e.message); }
  }));
  root.querySelectorAll("form.cform").forEach((f) => (f.onsubmit = async (e) => {
    e.preventDefault();
    const body = f.elements.body.value.trim();
    if (!body || !(await requireAuth())) return;
    try { await window.NBA.addComment(+f.dataset.alert, body); rerender(); }
    catch (err) { toast("შეცდომა: " + err.message); }
  }));
}

let astate = "new", awin = 3;
async function alertsView() {
  const d = await api(`/api/alerts?status=${astate}&window=${awin}`);
  const wins = [5, 3, 2, 1];
  const chips = [["new", "ახალი"], ["concluded", "დასრულებული"], ["closed", "დახურული"], ["all", "ყველა"]];
  view.innerHTML = `
    <div class="head"><div><h1>სიგნალები</h1><p class="sub">ბოლო ${awin === 1 ? "თამაში" : awin + " თამაში"} ადრინდელ საშუალოზე მკვეთრად მაღლა ან დაბლა. ★ = ჩემი სია</p></div>
      <div class="toolbar"><div class="chips">${wins.map((n) => `<button class="chip ${n === awin ? "on" : ""}" data-w="${n}">ბოლო ${n}</button>`).join("")}</div>
      <div class="chips">${chips.map(([k, l]) => `<button class="chip ${k === astate ? "on" : ""}" data-s="${k}">${l}</button>`).join("")}</div></div></div>
    ${d.alerts.length ? `<div class="grid alerts">${d.alerts.map(alertCard).join("")}</div>` : `<div class="card empty">სიგნალი არ არის</div>`}`;
  view.querySelectorAll("[data-s]").forEach((b) => (b.onclick = () => { astate = b.dataset.s; alertsView(); }));
  view.querySelectorAll("[data-w]").forEach((b) => (b.onclick = () => { awin = +b.dataset.w; alertsView(); }));
  bindAlertActions(view, alertsView);
  view.querySelectorAll("[data-player]").forEach((b) => (b.onclick = () => openPlayer(b.dataset.player)));
}

/* ---------------- System ---------------- */
async function systemView() {
  const d = await api("/api/system");
  const dur = (r) => (r.finished_at && r.started_at ? Math.round((new Date(r.finished_at) - new Date(r.started_at)) / 1000) + " წმ" : "–");
  view.innerHTML = `
    <div class="head"><div><h1>სისტემა</h1><p class="sub">აგენტების გაშვებები, მონაცემთა ხარისხი და პარამეტრები</p></div></div>
    <div class="grid cols-2">
      <div class="card"><h2>აგენტების გაშვებები</h2><div class="table-wrap"><table>
        <thead><tr><th>#</th><th>აგენტი</th><th>სტატუსი</th><th>დრო</th><th class="num">ხანგრძლ.</th><th class="num">ჩანაწ.</th><th>შეტყობინება</th></tr></thead>
        <tbody>${d.runs.map((r) => `<tr><td class="muted">${r.id}</td><td>${esc(AGENT_KA[r.agent] || r.agent)}</td><td>${pill(r.status, RUN[r.status] || "mute")}${r.status === "failed" && d.runs.some((x) => x.agent === r.agent && x.id > r.id && x.status === "ok") ? " " + pill("✓ გამოსწორდა", "good") : ""}</td><td>${fmtDate(r.started_at)}</td><td class="num">${dur(r)}</td><td class="num">${r.rows_written ?? ""}</td><td class="muted">${esc(r.message || "")}</td></tr>`).join("")}</tbody></table></div></div>
      <div class="grid" style="align-content:start">
        <div class="card"><h2>მონაცემთა პრობლემები</h2>${d.issues.length ? `<table><tbody>${d.issues.map((i) => `<tr><td>${pill(i.resolved ? "გადაწყდა" : "ღია", i.resolved ? "good" : "bad")}</td><td>${esc(i.check_name)}</td><td class="muted">${esc(i.message)}</td></tr>`).join("")}</tbody></table>` : `<div class="empty">✓ პრობლემა არ არის</div>`}</div>
        <div class="card"><h2>პარამეტრები</h2>
          <p class="muted" style="margin:0 0 6px">სიგნალები: კლება &lt; ${d.config.signals.below_factor}× · მატება &gt; ${d.config.signals.above_factor}× · ბაზისი ≥ ${d.config.signals.min_baseline_games} თამაში · ≥ ${d.config.signals.min_avg_minutes} წუთი${(d.config.signals.windows || []).length ? " · ფანჯრები: ბოლო " + d.config.signals.windows.join("/") : ""}</p>
          <p class="muted" style="margin:0">Claude კვლევა: ${d.config.research.auto ? pill("ავტომატური", "good") : pill("ხელით (/research)", "mute")} · დღეში მაქს. ${d.config.research.max_alerts_per_run}</p></div>
        <div class="card"><h2>ანგარიშების არქივი</h2>${d.reports.map((r) => `<button class="btn ghost" style="display:block;width:100%" data-rep="${esc(r.report_date)}">📄 ${esc(r.report_date)} <span class="muted">${r.details?.source === "claude" ? "· Claude" : "· ავტომატური"}</span></button>`).join("")}</div>
      </div></div>`;
  view.querySelectorAll("[data-rep]").forEach((b) => (b.onclick = () => { const r = d.reports.find((x) => x.report_date === b.dataset.rep); modal(`<div class="report">${md(r.summary)}</div>`); }));
}

/* ---------------- auth ---------------- */
function toast(msg) {
  let t = $("#toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add("show");
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 2600);
}
function renderUser() {
  const a = window.NBA.getAuth();
  $("#user").innerHTML = a ? `👤 ${esc(a.name)} <button class="linkbtn" id="logout">გასვლა</button>` : `<button class="linkbtn" id="loginbtn">🔑 შესვლა რედაქტირებისთვის</button>`;
  const lo = $("#logout"), li = $("#loginbtn");
  if (lo) lo.onclick = () => { window.NBA.logout(); renderUser(); toast("გამოხვედი"); };
  if (li) li.onclick = () => requireAuth();
}
function requireAuth() {
  if (window.NBA.getAuth()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const prev = $("#modal").hidden ? null : $("#modal-body").innerHTML;
    modal(`<h1>შესვლა</h1><p class="sub">სტატუსის შეცვლას, კომენტარს და ★ სიას საერთო კოდი სჭირდება. ერთხელ შეიყვანე და ეს ბრაუზერი დაიმახსოვრებს.</p>
      <form id="authf" class="authf"><label>შენი სახელი<input name="uname" required maxlength="40" placeholder="მაგ. ლევანი"></label>
      <label>კოდი<input name="code" required type="password" autocomplete="off"></label>
      <div class="toolbar"><button class="btn primary">შესვლა</button><span id="autherr" class="muted"></span></div></form>`);
    const done = (ok) => { if (prev !== null) modal(prev); else $("#modal").hidden = true; $("#modal-x").onclick = () => ($("#modal").hidden = true); renderUser(); resolve(ok); };
    $("#modal-x").onclick = () => done(false);
    $("#authf").onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target.elements;
      try {
        if (await window.NBA.login(f.uname.value.trim(), f.code.value.trim())) { done(true); toast("✓ შესული ხარ"); }
        else $("#autherr").textContent = "კოდი არასწორია";
      } catch (err) { $("#autherr").textContent = err.message; }
    };
  });
}

/* ---------------- shell ---------------- */
function modal(html) { $("#modal-body").innerHTML = html; $("#modal").hidden = false; }
$("#modal-x").onclick = () => ($("#modal").hidden = true);
$("#modal").onclick = (e) => { if (e.target.id === "modal") $("#modal").hidden = true; };
document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("#modal").hidden = true; });
$("#refresh").onclick = async () => { await api("/api/refresh"); pcache = null; route(); };
renderUser();

const ROUTES = { "": overview, games: gamesView, players: playersView, predictions: predictionsView, lines: linesView, alerts: alertsView, system: systemView };
async function route() {
  const [path, qs] = location.hash.replace(/^#\/?/, "").split("?");
  const params = Object.fromEntries(new URLSearchParams(qs || ""));
  document.querySelectorAll("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.r === path));
  view.innerHTML = `<div class="loading">იტვირთება…</div>`;
  try { await (ROUTES[path] || overview)(params); }
  catch (e) { view.innerHTML = `<div class="card empty">შეცდომა: ${esc(e.message)}</div>`; }
}
window.addEventListener("hashchange", route);
route();
api("/api/overview").then((d) => { $("#nav-alerts").textContent = d.kpi.alerts_new || ""; $("#updated").textContent = d.last_update ? "ბოლო განახლება: " + fmtDate(d.last_update) : ""; }).catch(() => {});
