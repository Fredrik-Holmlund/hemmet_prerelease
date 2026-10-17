import { loadData, saveGroup, setSlot, removeGroup, restoreGroup, deleteGroup, resetDemo, saveProfile } from "./data.js";
import { can, isLeadership } from "./perms.js";
import { renderAssignments, drawBoard, bindAssignments } from "./assignments.js";

const CLASS_COLORS = {
  warrior: "#C69B6D", paladin: "#F48CBA", hunter: "#AAD372", rogue: "#FFF468", priest: "#FFFFFF",
  mage: "#3FC7EB", warlock: "#8788EE", druid: "#FF7C0A", shaman: "#0070DD",
};
// raden "Raid Master" i bemanningstabellen är ingen funktion men står först
const RM_SLOT = { id: "raid_master", name: "Raid Master", purpose: "Helhetsansvar för gruppen." };
const LINK_NAMES = { thread: "Gruppens tråd på Discord" };   // övriga länkar togs bort 2026-10-12
// Visningsläget (hemmet.wtf/raiding/): samma sida för alla besökare. Man kan prova som ledning eller Raid Master,
// men inget sparas: varje sidladdning börjar med exempeldatan och utloggad. Byggskriptet i
// hemmet.wtf_leveling_plus_raiding sätter <html data-visning>.
const VISNING = document.documentElement.hasAttribute("data-visning");
const PAGE_TITLE = document.title;   // i visningsläget sökbara titeln från bygget, som startsidan behåller

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const paras = text => String(text).split(/\n\n+/).map(p => `<p>${esc(p)}</p>`).join("");
const NUM = n => `<span class="n">${n}</span>`;
const DAYS = [["mon", "mån"], ["tue", "tis"], ["wed", "ons"], ["thu", "tor"], ["fri", "fre"], ["sat", "lör"], ["sun", "sön"]];
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;
// "Ons & sön · 19:30", "Mån, ons & fre · 20:00", eller fritexten om det inte finns dagar
function scheduleText(g) {
  const days = DAYS.filter(([k]) => g.raid_days?.includes(k)).map(([, v]) => v);
  const list = days.length > 1 ? `${days.slice(0, -1).join(", ")} & ${days.at(-1)}` : days[0] ?? "";
  const parts = [cap(list), g.raid_start].filter(Boolean).join(" · ");
  const note = g.schedule_note ?? g.schedule;   // g.schedule: äldre sparad demo-data
  return [parts, parts && note ? `(${note})` : note].filter(Boolean).join(" ");
}
const RECRUIT_WORDS = 50;
const words = t => String(t ?? "").trim().split(/\s+/).filter(Boolean).length;
// signups i tre lägen: Öppet (signa direkt), Hör av dig (prata med Raid Master först), Fullt hus (ingen plats just nu)
const SIGNUP = {
  open: { name: "Öppet", hint: "Signa upp direkt i gruppens tråd." },
  ask: { name: "Hör av dig", hint: "Prata med Raid Master innan du signar." },
  full: { name: "Fullt hus", hint: "Rostern är full just nu." },
};
const hasRoom = g => g.signup === "open" || g.signup === "ask";
/* tillbaka-knapp och brödsmulor: crumbs([["Raidgrupper", "#raidgrupper"], ["Spiselgänget", "#grupp/x"], ["Assignments"]])
   knappen går ett steg upp (näst sista delen), sista delen är där man står. Ingen pil (2026-10-17: pilarna kändes "AI") */
function crumbs(parts, up = parts.at(-2)) {
  return `<nav class="crumbs" aria-label="Du är här">
    <a class="btn btn--ghost btn--sm" href="${up[1]}">Tillbaka</a>
    <ol class="crumbs__trail">${parts.map(([label, href], i) => i === parts.length - 1
      ? `<li aria-current="page">${esc(label)}</li>` : `<li><a href="${href}">${esc(label)}</a></li>`).join("")}</ol>
  </nav>`;
}
const pips = (rank, max = 3) => `<span class="pips" aria-hidden="true">${Array.from({ length: max }, (_, i) => `<i class="${i < rank ? "on" : ""}"></i>`).join("")}</span>`;

let D;   // { roles, functions, members, groups, assignments } + uppslag
let RAW;  // datalagrets tabeller; D byggs om från dem efter varje ändring
let me = null;   // inloggad medlem. I demon vald i listan, med Supabase från Discord-inloggningen
const ME_KEY = "hemmet-ledning-me";

function index(data) {
  const byId = arr => Object.fromEntries(arr.map(x => [x.id, x]));
  // äldre sparad data: nivå 1–5 blir A/B/C, och koder som inte är bokstav + siffra (t.ex. "HEM-40A") räknas om
  const lvl = v => typeof v === "number" ? (v >= 4 ? "A" : v === 3 ? "B" : "C") : v || null;
  for (const a of data.assignments) {
    if (a.slot === "contact" && !data.assignments.some(x => x.group_id === a.group_id && x.slot === "raid_master")) a.slot = "raid_master";
  }
  data.assignments = data.assignments.filter(a => a.slot !== "contact");
  for (const g of data.groups) {
    if (!SIGNUP[g.signup]) g.signup = g.recruiting ? "open" : "full";   // äldre sparad data: ja/nej
    delete g.recruiting;
    g.ambition = lvl(g.ambition);
    if (g.raid_id && !/^[ABC]\d+$/.test(g.raid_id)) g.raid_id = null;
  }
  for (const g of data.groups) {
    if (g.raid_id || !g.ambition || g.status !== "active") continue;
    const used = data.groups.filter(x => x !== g && x.status === "active" && x.size === g.size && x.raid_id?.startsWith(g.ambition))
      .map(x => parseInt(x.raid_id.slice(1), 10) || 0);
    g.raid_id = `${g.ambition}${Math.max(0, ...used) + 1}`;
  }
  data.functions.sort((a, b) => a.sort - b.sort);
  return { ...data, role: byId(data.roles), fn: byId(data.functions), member: byId(data.members), group: byId(data.groups) };
}

function refresh() {
  D = index(RAW);
  if (me) me = D.member[me.id] ?? null;
  renderAccount(); renderOrg(); renderGroups(); renderRoles();
}

/* ---------- uppslag ---------- */
const holders = (groupId, slot) => D.assignments.filter(a => a.group_id === groupId && a.slot === slot).map(a => D.member[a.member_id]).filter(Boolean);
const raidMaster = g => holders(g.id, "raid_master")[0];
const raidLeader = g => holders(g.id, "leadership");
// alla raidgrupper har en Raid Master; de sex funktionerna (och Raid Leader) bemannas bara i 20- och 40-manna
const isOrganized = g => g.size >= 20;
const organized = () => D.groups.filter(g => g.status === "active" && isOrganized(g));
const activeGroups = () => D.groups.filter(g => g.status === "active");
const guildRole = id => D.members.filter(m => m.guild_roles.includes(id));
const delegatedCount = g => D.functions.filter(f => holders(g.id, f.id).some(m => m !== raidMaster(g))).length;

/* vem som har en roll just nu, med sammanhang (vilken grupp) */
function roleHolders(roleId) {
  if (roleId === "guild_master" || roleId === "guild_leader") return guildRole(roleId).map(m => ({ m }));
  const out = [];
  if (roleId === "raid_master") return activeGroups().map(g => ({ m: raidMaster(g), ctx: g })).filter(x => x.m);
  for (const g of organized()) {
    const rm = raidMaster(g);
    if (roleId === "raid_master" && rm) out.push({ m: rm, ctx: g });   // (10-manna läggs till nedan)
    if (roleId === "raid_leader") raidLeader(g).forEach(m => out.push({ m, ctx: g }));
    if (roleId === "raid_admin") {
      const admins = new Set();
      D.functions.filter(f => f.id !== "leadership").forEach(f => holders(g.id, f.id).forEach(m => m !== rm && admins.add(m)));
      admins.forEach(m => out.push({ m, ctx: g }));
    }
  }
  return out;
}

/* allt en person ansvarar för, grupperat per raidgrupp */
function dutiesOf(m) {
  const per = new Map();
  for (const a of D.assignments.filter(a => a.member_id === m.id)) {
    const g = D.group[a.group_id];
    if (!g) continue;
    const name = a.slot === "raid_master" ? "Raid Master" : a.slot === "contact" ? "Raid Master"
      : a.slot === "leadership" ? "Raid Leader" : D.fn[a.slot]?.name ?? a.slot;
    if (!per.has(g)) per.set(g, []);
    per.get(g).push(name);
  }
  return [...per];
}

/* ---------- byggstenar ---------- */
// namn i klassfärg, pricken grön när personen är online på Discord
const status = m => m.online ? "online på Discord" : "offline";
const who = m => m ? `<button class="who${m.online ? " is-online" : ""}" style="--c:${CLASS_COLORS[m.class] ?? "#fff"}" data-member="${m.id}"
  title="${esc(m.character)} är ${status(m)}" aria-label="${esc(m.character)}, ${status(m)}"><i class="who__dot" aria-hidden="true"></i>${esc(m.character)}</button>` : "";
const whos = ms => `<span class="whos">${ms.map(who).join("")}</span>`;
const selfChip = rm => rm ? `<button class="who who--self${rm.online ? " is-online" : ""}" style="--c:${CLASS_COLORS[rm.class] ?? "#fff"}" data-member="${rm.id}"
  title="Ingen utsedd: Raid Master har det själv"><i class="who__dot" aria-hidden="true"></i>${esc(rm.character)}<small>Raid Master själv</small></button>` : "";
const qm = roleId => `<span class="qm" role="button" tabindex="0" data-role="${roleId}" aria-label="Om rollen ${esc(D.role[roleId].name)}">?</span>`;

/* ---------- startsidan: hierarkin med titlar, nivåerna och de sex uppgifterna ---------- */
function renderOrg() {
  const n = activeGroups().length;
  // hierarkins rutor som Group Finder-paneler: rubriklist med titeln, beskrivningen under
  const node = (roleId, sub, extra = "") => `<button class="lfgnode ${extra}" data-role="${roleId}">
      <span class="lfgnode__head">${esc(D.role[roleId].name)}</span>
      <span class="lfgnode__body"><span>${sub}</span><span class="node__more">Läs mer</span></span></button>`;
  $("#org").innerHTML = `
    <div class="tier"><div class="lfgnode lfgnode--lead">
      <span class="lfgnode__head">Ledningen</span>
      <div class="lead-roles">
        <button class="lead-role" data-role="guild_master"><b>Guild Master</b><small>Vision och sista ordet</small></button>
        <button class="lead-role" data-role="guild_leader"><b>Guild Leaders</b><small>Strategi, kultur och samordning</small></button>
      </div>
    </div></div>
    <div class="stem"></div>
    <div class="tier">${node("raid_master", `En per raidgrupp${n ? ` · ${NUM(n)} just nu` : ""}`, "node--top")}</div>
    <div class="stem"></div>
    <div class="groups-row" style="--n:2">
      <div class="gcol">${node("raid_leader", "Leder raiden och har sista ordet i taktiken")}</div>
      <div class="gcol">${node("raid_admin", "Hjälper till med uppgifterna när Raid Master delegerar")}</div>
    </div>
`;
  // de sex uppgifterna som guildens stadgar på pergament (pergament = utmärkelser och guildens stadgar, se formspråket)
  $("#fnSteps").innerHTML = `
  <section class="charter charter--plain">
    <h3 class="charter__title">Raid Masterns stadgar</h3>
    <p class="charter__lead">Det här ska alltid bli gjort i varje raidgrupp.</p>
    <ol class="charter__list">${D.functions.map(f => `<li><button data-fn="${f.id}">
      <span class="charter__n">${["I", "II", "III", "IV", "V", "VI"][f.sort - 1] ?? f.sort}</span><b>${esc(f.short_name ?? f.name)}</b><span>${esc(f.summary ?? f.purpose)}</span></button></li>`).join("")}</ol>
    <p class="charter__foot">Raid Master kan delegera uppgifter till Raid Admins eller andra spelare, men behåller alltid helhetsansvaret.</p>
  </section>`;
  $("#levelCards").innerHTML = levelPanels();
}

// nivåerna som små Group Finder-paneler: rubriklist, beskrivning och gruppernas rader (startsidan och Roller & ansvar)
function levelPanels() {
  return D.ambitions.map(a => {
    const gs = D.groups.filter(g => g.status === "active" && ambLevel(g.ambition) === a.level)
      .sort((x, y) => y.size - x.size || (x.raid_id ?? "~").localeCompare(y.raid_id ?? "~", "sv", { numeric: true }));   // 40, 20, 10 och sedan koden
    return `<section class="lfgpanel levelpanel">
      <header class="lfgpanel__head"><button class="levelpanel__title" data-ambition="${a.level}">
        ${levelBadge(a, "qlvl--md")}<span class="levelpanel__name" style="color:${a.color}">${esc(a.name)}</span><span class="levelpanel__q" style="color:${a.color}">${esc(a.quality)}</span></button></header>
      <p class="levelpanel__tag">${esc(a.tagline)}</p>
      <ul class="levelpanel__groups">
        ${gs.length ? gs.map(g => `<li><a href="#grupp/${g.id}">${codeTag(g)}<span>${esc(g.name)}</span><small>${NUM(g.size)}-manna</small></a></li>`).join("")
          : `<li class="levelpanel__none">Inga grupper än</li>`}
      </ul>
    </section>`;
  }).join("");
}

/* ---------- vy B: raidgrupperna ---------- */
// filtren på Raidgrupper: storlek, dagar, starttid och signups (flera val = någon av dem)
const gfilter = { sizes: new Set(), days: new Set(), time: "", open: false, roles: new Set() };   // open: Öppet och Hör av dig räknas båda som öppna
const TIME_SLOTS = [["early", "Före 19:00"], ["mid", "19:00–20:59"], ["late", "21:00 och senare"]];
const timeSlot = t => { if (!t) return null; const m = +t.slice(0, 2) * 60 + +t.slice(3, 5); return m < 19 * 60 ? "early" : m < 21 * 60 ? "mid" : "late"; };
const filterActive = () => gfilter.sizes.size || gfilter.days.size || gfilter.time || gfilter.open || gfilter.roles.size;
const passes = g => (!gfilter.open || hasRoom(g))
  && (!gfilter.roles.size || hasRoom(g) && (g.recruit_roles ?? []).some(r => gfilter.roles.has(r)))   // söker tank/healer/DPS
  && (!gfilter.sizes.size || gfilter.sizes.has(g.size))
  && (!gfilter.days.size || (g.raid_days ?? []).some(d => gfilter.days.has(d)))
  && (!gfilter.time || timeSlot(g.raid_start) === gfilter.time);
// raidgrupperna under rubrikerna 40-, 20- och 10-manna
const SIZE_SECTIONS = [
  { size: 40, note: "" },
  { size: 20, note: "" },
  { size: 10, note: "" },
];

/* korten som spelets Group Finder: panelen med äventyrarna på klippan, mörk rubriklist, rader och spelets rollikoner */
const ROLE_NAMES = { tank: "Tank", healer: "Healer", dps: "DPS" };
const roleIcons = (roles = [], cls = "") => roles.filter(r => ROLE_NAMES[r])
  .map(r => `<i class="role role--${r} ${cls}" title="${ROLE_NAMES[r]}" aria-label="${ROLE_NAMES[r]}"></i>`).join("");
// signupläget, och (när det finns plats) vilka roller rostern behöver
const recruitRow = g => {
  const s = SIGNUP[g.signup] ?? SIGNUP.full;
  const roles = hasRoom(g) ? roleIcons(g.recruit_roles) : "";
  const need = hasRoom(g) && g.recruit_roles?.length ? ` Behöver ${g.recruit_roles.map(r => ROLE_NAMES[r]).join(", ")}.` : "";
  return `<span class="signup signup--${g.signup}" title="${esc(s.hint + need)}"><span>${s.name}</span>${roles}</span>`;
};

function groupCard(g) {
  const ten = !isOrganized(g);
  const rm = raidMaster(g), rl = raidLeader(g);
  const row = (label, value) => `<div class="lfgcard__row"><dt>${label}</dt><dd>${value}</dd></div>`;
  return `<article class="gcard lfgcard" data-group="${g.id}" tabindex="0" role="link" aria-label="Öppna ${esc(g.name)}">
    <header class="lfgcard__head">
      <b>${esc(g.name)}</b>${codeTag(g)}
      <span class="lfgcard__size">${NUM(g.size)}-manna</span>
    </header>
    <dl class="lfgcard__rows">
      ${row("Raid Master", rm ? who(rm) : "–")}${ten ? "" : row("Raid Leader", rl.length ? whos(rl) : "–")}${row("Nivå", ambitionBtn(g.ambition))}
      ${row("Tid", esc(scheduleText(g) || "–"))}
      ${row("Signups", recruitRow(g))}
    </dl>
    ${g.recruit_note ? `<p class="lfgcard__note">${esc(g.recruit_note)}</p>` : ten && g.blurb ? `<p class="lfgcard__note lfgcard__note--plain">${esc(g.blurb)}</p>` : ""}
    <footer class="lfgcard__foot">
      <span>${ten ? "" : `<b>${NUM(delegatedCount(g))}</b> av ${NUM(D.functions.length)} funktioner delegerade`}</span>
      <span class="btn btn--primary btn--sm">Öppna</span>
    </footer>
  </article>`;
}

function renderGroups() {
  const all = activeGroups();
  const active = all.filter(passes);
  const create = can.createGroup(me) && !filterActive();
  const chip = (attr, value, label, on) => `<button class="fchip" ${attr}="${value}" aria-pressed="${on}">${label}</button>`;
  $("#groupFilter").innerHTML = `<div class="gfilters">
    <div class="gfilters__row"><span class="gfilters__label">Storlek</span>${[40, 20, 10].map(n => chip("data-fsize", n, `${NUM(n)}-manna`, gfilter.sizes.has(n))).join("")}</div>
    <div class="gfilters__row"><span class="gfilters__label">Dagar</span>${DAYS.map(([k, v]) => chip("data-fday", k, cap(v), gfilter.days.has(k))).join("")}</div>
    <div class="gfilters__row"><span class="gfilters__label">Söker</span>${Object.entries(ROLE_NAMES).map(([k, v]) => chip("data-frole", k, `${roleIcons([k], "fchip__role")}${v}`, gfilter.roles.has(k))).join("")}</div>
    <div class="gfilters__row"><span class="gfilters__label">Start</span>${TIME_SLOTS.map(([k, v]) => chip("data-ftime", k, v, gfilter.time === k)).join("")}</div>
    <div class="gfilters__row gfilters__foot">
      <label class="bd__check"><input type="checkbox" data-only-open ${gfilter.open ? "checked" : ""}> Bara grupper som är öppna för signups</label>
      <span class="gfilters__count">Visar ${NUM(active.length)} av ${NUM(all.length)}</span>
      ${filterActive() ? `<button class="linkish" data-filter-reset>Rensa filtren</button>` : ""}
    </div>
  </div>`;
  $("#groups").innerHTML = SIZE_SECTIONS.map(({ size, note }) => {
    // efter kod (A1, A2, B1 …), grupper utan kod sist i bokstavsordning
    const gs = active.filter(g => g.size === size).sort((a, b) =>
      (a.raid_id ?? "~").localeCompare(b.raid_id ?? "~", "sv", { numeric: true }) || a.name.localeCompare(b.name, "sv"));
    if (!gs.length && !create) return "";   // tom rubrik visas bara för den som kan skapa en grupp där (och inte när man filtrerar)
    if (gfilter.sizes.size && !gfilter.sizes.has(size)) return "";
    return `<section class="gsec" aria-labelledby="gsec${size}">
      <h2 class="gsec__h" id="gsec${size}"><span>${NUM(size)}-manna</span> <small>${gs.length ? `${NUM(gs.length)} ${gs.length === 1 ? "grupp" : "grupper"}` : "inga grupper än"}</small></h2>
      ${note ? `<p class="note gsec__note">${note}</p>` : ""}
      <div class="gcards">
        ${gs.map(groupCard).join("")}
        ${create ? `<a class="gcard gcard--new" href="#ny-grupp/${size}"><span class="gcard__plus">+</span><span class="gcard__name">Ny ${size}-mannagrupp</span>
          <span class="gcard__meta">Starta en grupp och utse Raid Master</span></a>` : ""}
      </div>
    </section>`;
  }).join("") || `<p class="note">${filterActive() ? "Ingen grupp matchar filtren. Prova att rensa något, eller fråga i Discord: det brukar finnas plats." : "Inga raidgrupper än."}</p>`;

  // borttagna grupper syns bara för ledningen, som kan ångra eller radera för gott
  const removed = can.removeGroup(me) ? D.groups.filter(g => g.status === "archived") : [];
  $("#removed").innerHTML = removed.length ? `<p class="label">Borttagna grupper</p>
    ${removed.map(g => `<div class="removed__row">
      <a href="#grupp/${g.id}">${esc(g.name)}</a>
      <span class="removed__meta">${NUM(g.size)}-manna${changedBy(g) ? ` · borttagen ${changedBy(g)}` : ""}</span>
      <span class="removed__btns">${removeButtons(g)}</span>
    </div>`).join("")}` : "";
}

const changedBy = g => {
  const who = g.updated_by && D.member[g.updated_by];
  const when = g.updated_at ? new Date(g.updated_at).toLocaleDateString("sv-SE", { day: "numeric", month: "short" }) : "";
  return who ? `${esc(when)} av ${esc(who.character)}` : "";
};
const removeButtons = g => `<button class="btn btn--ghost btn--sm" data-restore="${g.id}">Återställ</button>
  <button class="btn btn--ghost btn--sm btn--danger" data-delete="${g.id}">Radera för gott</button>`;

/* ---------- vy C: roller och funktioner ---------- */
function roleBody(r) {
  const h = roleHolders(r.id);
  return `<div class="prose">${paras(r.description)}</div>
    <p class="label">Ansvarsområden</p><ul class="list">${r.responsibilities.map(x => `<li>${esc(x)}</li>`).join("")}</ul>
    <p class="label">Mandat</p><p style="margin:0">${esc(r.mandate)}</p>
    <p class="label">Har rollen nu</p>
    ${h.length ? `<div class="holders">${h.map(({ m, ctx }) => `<div class="holders__row">${who(m)}${ctx ? `<a class="holders__ctx" href="#grupp/${ctx.id}">${esc(ctx.name)}</a>` : ""}</div>`).join("")}</div>`
      : `<p class="note" style="margin:0">Ingen just nu.</p>`}`;
}

function fnBody(f) {
  return `<div class="prose">${paras(f.description)}</div>
    <p class="label">När</p><p style="margin:0">${esc(f.deadline)}</p>
    ${f.tools.length ? `<p class="label">Verktyg</p><div class="facts">${f.tools.map(t => `<span class="tag">${esc(t)}</span>`).join("")}</div>` : ""}
    <p class="label">${esc(f.holder_title ?? "Ansvarig")} per grupp</p>
    <div class="holders">${organized().map(g => {
      const h = holders(g.id, f.id);
      return `<div class="holders__row"><a class="holders__ctx" href="#grupp/${g.id}">${esc(g.name)}</a>${h.length ? h.map(who).join("") : selfChip(raidMaster(g))}</div>`;
    }).join("")}</div>`;
}

function renderRoles() {
  $("#ambList").innerHTML = levelPanels();
  // rollerna och funktionerna som paneler med utfällbara listrader
  $("#roleList").innerHTML = panel("Rollerna", D.roles.map(r => `<details class="acc">
    <summary><span class="acc__name">${esc(r.name)}</span><span class="acc__short">${esc(r.short)}</span></summary>
    <div class="acc__body">${roleBody(r)}</div></details>`).join(""), "lfgpanel--acc");
  $("#fnList").innerHTML = panel("Det som alltid ska bli gjort",
    `<p class="lfgpanel__intro">Sex funktioner i varje ${NUM(20)}- och ${NUM(40)}-mannagrupp. Raid Master kan göra dem själv eller lämna över dem.</p>`
    + D.functions.map(f => `<details class="acc">
    <summary><span class="acc__num acc__num--roman">${ROMAN[f.sort - 1] ?? f.sort}</span><span class="acc__name">${esc(f.name)}</span><span class="acc__short">${esc(f.purpose)}</span></summary>
    <div class="acc__body">${fnBody(f)}</div></details>`).join(""), "lfgpanel--acc");
}

/* ---------- gruppens info som text till Discord-tråden ----------
   Discords egen markdown: # rubrik, **fet**, > citat, -# liten text. Nivån som färgad cirkel i kvalitetsfärgen.
   Personer blir riktiga omnämnanden (<@id>) när discord_id finns (Supabase), annars @namn som går att justera i rutan. */
const QUALITY_DOT = { A: "🟠", B: "🟣", C: "🔵" };
const mention = m => m.discord_id ? `<@${m.discord_id}>` : `@${m.character}`;
function discordPost(g) {
  const a = amb(g.ambition), rm = raidMaster(g);
  const who = list => list.length ? list.map(mention).join(", ") : rm ? `${mention(rm)} *(Raid Master själv)*` : "–";
  const staff = [["Raid Master", rm ? [rm] : []]];
  if (isOrganized(g)) {
    staff.push(["Raid Leader", holders(g.id, "leadership")]);
    D.functions.filter(f => f.id !== "leadership").forEach(f => staff.push([f.name, holders(g.id, f.id)]));
  }
  const url = `${location.origin}${location.pathname}#grupp/${g.id}`;
  return [
    `# ${g.name}${g.raid_id ? `  \`${g.raid_id}\`` : ""}`,
    [`**${g.size}-manna**`, a && `${QUALITY_DOT[a.level] ?? ""} **${a.name}**`, scheduleText(g)].filter(Boolean).join("  ·  "),
    "",
    "## Vem ansvarar för vad",
    ...staff.map(([name, list]) => `> **${name}** — ${who(list)}`),
    ...(g.details || g.blurb ? ["", "## Detaljer", (g.details || g.blurb).trim()] : []),
    "",
    `-# Allt om gruppen: <${url}>`,
  ].filter((line, i, arr) => !(line === "" && arr[i - 1] === "")).join("\n");
}
function discordPostDrawer(g) {
  const text = discordPost(g);
  openDrawer(`<p class="eyebrow">${esc(g.name)}</p><h2>Text till Discord</h2>
    <p class="lead">Klistra in i gruppens tråd. Texten är formaterad för Discord: rubriker, fet stil och nivån som färgad cirkel. Du kan ändra i rutan innan du kopierar.</p>
    <textarea class="dpost" id="discordText" rows="22" spellcheck="false">${esc(text)}</textarea>
    <div class="dpost__bar">
      <button class="btn btn--primary" data-discord-copy>Kopiera</button>
      <span class="dpost__status" id="discordStatus" role="status"></span>
    </div>
    <p class="note">Namnen blir riktiga @-omnämnanden när sidan är kopplad till Discord. Tills dess: skriv om @namnet i Discord om det inte blir blått.</p>`);
}

/* ---------- raidgruppens egen sida ---------- */
function renderGroupPage(g) {
  const rm = raidMaster(g);
  // Raid Master och Raid Leader först, sedan övriga funktioner i ordning
  const slots = [RM_SLOT, D.fn.leadership, ...D.functions.filter(f => f.id !== "leadership")].filter(Boolean);
  const rows = !isOrganized(g)
    ? `<tr class="key"><th scope="row"><button class="fnbtn" data-role="raid_master">Raid Master<small>${esc(RM_SLOT.purpose)}</small></button></th><td>${rm ? whos([rm]) : "–"}</td></tr>`
    : slots.map(f => {
    const h = holders(g.id, f.id);
    const label = f.id === "leadership" ? "Raid Leader" : f.name;
    const key = f.id === "raid_master" || f.id === "leadership";
    const btn = f.id === "raid_master" ? `<button class="fnbtn" data-role="raid_master">${label}<small>${esc(f.purpose)}</small></button>`
      : `<button class="fnbtn" data-fn="${f.id}">${esc(label)}<small>${esc(f.purpose)}</small></button>`;
    return `<tr class="${key ? "key" : ""}"><th scope="row">${btn}</th><td>${h.length ? whos(h) : selfChip(rm)}</td></tr>`;
  }).join("");
  const contact = (isOrganized(g) ? holders(g.id, "feedback")[0] : null) ?? rm;
  const fact = (k, v) => v ? `<div><dt>${k}</dt><dd>${v}</dd></div>` : "";
  const links = Object.entries(g.links ?? {}).filter(([k, url]) => url && LINK_NAMES[k]);

  const removed = g.status === "archived";

  $("#groupPage").innerHTML = `<div class="wrap gp">
    <div class="gp__bar">
      ${crumbs([["Raidgrupper", "#raidgrupper"], [g.name]])}
      ${removed ? `<span class="facts">${removeButtons(g)}</span>`
        : can.editGroup(me, g, D.assignments) ? `<span class="gp__actions"><button class="btn btn--ghost" data-discord-post="${g.id}">Text till Discord</button>
          <a class="btn btn--primary" href="#grupp/${g.id}/redigera">Redigera gruppen</a></span>` : ""}
    </div>
    <p class="eyebrow">${removed ? "Borttagen raidgrupp" : "Raidgrupp"}</p>
    ${groupHead(g)}
    ${changedBy(g) ? `<p class="note">${removed ? "Borttagen" : "Senast ändrad"} ${changedBy(g)}</p>` : ""}
    ${removed ? "" : groupTabs(g, "overview")}
    ${g.blurb ? `<p class="gp__blurb">${esc(g.blurb)}</p>` : ""}
    <dl class="lfgpanel gp__facts">
      ${fact("Storlek", `${NUM(g.size)} man`)}${fact("Nivå", amb(g.ambition) ? ambitionBtn(g.ambition) : "")}${fact("Tid", esc(scheduleText(g)))}${fact("Signups", recruitRow(g))}
    </dl>
    <div class="gp__grid">
      <div>
        ${panel("Vem ansvarar för vad", `<table class="staff"><thead><tr><th>Roll eller funktion</th><th>Ansvarig</th></tr></thead><tbody>${rows}</tbody></table>`, "lfgpanel--staff")}
        ${isOrganized(g) ? `<p class="note" style="margin-top:12px">Står det <i>Raid Master själv</i> finns ingen utsedd, och då har Raid Master uppgiften själv.</p>` : ""}
      </div>
      <div class="gp__side">
        ${panel(`Signups: ${SIGNUP[g.signup]?.name ?? ""} ${hasRoom(g) ? roleIcons(g.recruit_roles) : ""}`,
          `<div class="lfgpanel__body details__text">${g.recruit_note ? paras(g.recruit_note) : `<p>${{
            open: "Signa upp via RaidHelper i gruppens tråd.",
            ask: "Hör av dig till Raid Master innan du signar, i gruppens tråd eller direkt.",
            full: "Rostern är full just nu. Hör gärna av dig ändå, det kan bli plats.",
          }[g.signup] ?? ""}</p>`}</div>`, `lfgpanel--recruit lfgpanel--signup-${g.signup}`)}
        ${g.details ? panel("Detaljer", `<div class="lfgpanel__body details__text">${paras(g.details)}</div>`)
          : !removed && can.editGroup(me, g, D.assignments) ? panel("Detaljer", `<div class="lfgpanel__body">
            <p class="lfgpanel__muted">Här kan ni skriva vad ni raidar just nu och vad ni förväntar er av de som följer med.</p>
            <a class="btn btn--ghost btn--sm" href="#grupp/${g.id}/redigera">Skriv något</a></div>`) : ""}
        ${panel("Frågor om gruppen?", `<div class="lfgpanel__body">
          <p>Uttagning, loot eller hur en raid gick: börja här. Går det inte att lösa i gruppen tar Guild Leaders vid.</p>
          ${contact ? whos([contact]) : ""}
          ${links.length ? `<p class="label">Länkar</p><div class="facts">${links.map(([k, url]) => `<a class="btn btn--primary btn--sm" href="${esc(url)}" target="_blank" rel="noopener">${LINK_NAMES[k] ?? esc(k)}</a>`).join("")}</div>` : ""}
        </div>`)}
      </div>
    </div>
  </div>`;
}

// rubriken på gruppens sidor (översikt och assignments)
const groupHead = (g, h = "h1") => `<div class="gp__head"><${h} class="d2">${esc(g.name)}</${h}>${codeTag(g)}<span class="gp__size">${NUM(g.size)}-manna</span></div>`;
// en panel i spelets Group Finder-stil med rubriklist
const panel = (title, body, cls = "") => `<section class="lfgpanel ${cls}"><header class="lfgpanel__head"><h3>${title}</h3></header>${body}</section>`;

/* ---------- ambitionsnivå: A Min-Max, B Focused, C Chill ----------
   Äldre sparad demo-data har 1–5: 4–5 räknas som A, 3 som B, 1–2 som C. */
const ambLevel = v => typeof v === "number" ? (v >= 4 ? "A" : v === 3 ? "B" : "C") : v || null;
const amb = v => D.ambitions.find(a => a.level === ambLevel(v));
// nivåerna i spelets kvalitetsfärger: A Legendary (orange), B Epic (lila), C Rare (blå)
const levelBadge = (a, cls = "") => `<span class="qlvl ${cls}" style="--q:${a.color}" title="${esc(a.quality)}">${a.level}</span>`;
const levelText = v => { const a = amb(v); return a ? `${levelBadge(a)} <span style="color:${a.color}">${esc(a.name)}</span>` : ""; };
const ambitionBtn = v => {
  const a = amb(v);
  return a ? `<button class="amb" data-ambition="${a.level}" title="${esc(a.tagline)}">${levelBadge(a)}<span style="color:${a.color}">${esc(a.name)}</span></button>` : "–";
};
// gruppens kod: bokstaven är nivån, siffran nästa lediga i samma nivå och storlek (A1, B2 …)
function nextCode(level, size, exceptId) {
  const used = D.groups.filter(x => x.status === "active" && x.id !== exceptId && x.size === size && x.raid_id?.startsWith(level))
    .map(x => parseInt(x.raid_id.slice(1), 10) || 0);
  return `${level}${Math.max(0, ...used) + 1}`;
}
const codeTag = g => { const a = amb(g.ambition); return g.raid_id ? `<span class="gcode"${a ? ` style="--q:${a.color}"` : ""} title="${esc(a ? `${a.name} (${a.quality})` : "")}">${esc(g.raid_id)}</span>` : ""; };

function ambitionDrawer(level) {
  openDrawer(`<p class="eyebrow">Ambitionsnivåer</p><h2>Ett hem, många sätt att raida</h2>
    <p class="lead">Varje grupp har en nivå, så vet du vad du anmäler dig till. Bokstaven står först i gruppens kod, till exempel B2.</p>
    ${D.ambitions.map(a => {
      const gs = D.groups.filter(g => g.status === "active" && ambLevel(g.ambition) === a.level);
      return `<div class="ambx${a.level === ambLevel(level) ? " is-current" : ""}">
        <div class="ambx__head">${levelBadge(a, "qlvl--md")}<b style="color:${a.color}">${esc(a.name)}</b><small class="ambx__q">${esc(a.quality)}</small></div>
        <p class="ambx__tag">${esc(a.tagline)}</p>
        ${gs.length ? `<p class="ambx__groups">${gs.map(g => `<a href="#grupp/${g.id}">${g.raid_id ? `${esc(g.raid_id)} · ` : ""}${esc(g.name)}</a>`).join(" · ")}</p>` : ""}
      </div>`;
    }).join("")}
    <p class="note" style="margin-top:16px">Gränserna mellan nivåerna är inte huggna i sten. Exakt vad de innebär utvecklar vi tillsammans efter hand. Varje Raid Master beskriver gruppens egen ambition.</p>`);
}

/* ---------- gruppens flikar: översikt och assignments ---------- */
const groupTabs = (g, active) => `<nav class="gp__tabs" aria-label="${esc(g.name)}">
  <a href="#grupp/${g.id}" ${active === "overview" ? 'aria-current="page"' : ""}>Översikt</a>
  <a href="#grupp/${g.id}/assignments" ${active === "assignments" ? 'aria-current="page"' : ""}>Assignments</a></nav>`;

// Översikt och Assignments är flikar på samma sida: tillbaka-knappen går till listan, inte till översikten
function renderAssignmentsPage(g) {
  $("#groupPage").innerHTML = `<div class="wrap wrap--wide gp">
    <div class="gp__bar">${crumbs([["Raidgrupper", "#raidgrupper"], [g.name, `#grupp/${g.id}`], ["Assignments"]], ["Raidgrupper", "#raidgrupper"])}</div>
    <p class="eyebrow">Raidgrupp</p>
    ${groupHead(g)}
    ${groupTabs(g, "assignments")}
    ${renderAssignments({ D, me, g, esc, CLASS_COLORS, openDrawer, closeDrawer, refresh })}
  </div>`;
  drawBoard();
}

/* ---------- sidopanelen ---------- */
let lastFocus = null;
function openDrawer(html) {
  lastFocus = document.activeElement;
  $("#drawerBody").innerHTML = html;
  $("#scrim").hidden = false;
  const d = $("#drawer");
  d.classList.add("is-open"); d.setAttribute("aria-hidden", "false"); d.scrollTop = 0; d.focus();
}
function closeDrawer() {
  const d = $("#drawer");
  if (!d.classList.contains("is-open")) return;
  d.classList.remove("is-open"); d.setAttribute("aria-hidden", "true");
  $("#scrim").hidden = true;
  lastFocus?.focus?.();
}

const roleDrawer = r => openDrawer(`<p class="eyebrow">Roll</p><h2>${esc(r.name)}</h2><p class="lead">${esc(r.short)}</p>${roleBody(r)}`);
const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII"];
const fnDrawer = f => openDrawer(`<p class="eyebrow">Funktion ${ROMAN[f.sort - 1] ?? f.sort} av ${ROMAN[D.functions.length - 1] ?? D.functions.length}</p><h2>${esc(f.name)}</h2><p class="lead">${esc(f.purpose)}</p>${fnBody(f)}`);
function memberDrawer(m) {
  const titles = m.guild_roles.map(id => D.role[id]?.name).filter(Boolean);
  const duties = dutiesOf(m);
  openDrawer(`<p class="eyebrow">${titles.length ? esc(titles.join(" · ")) : "Medlem"}</p>
    <h2 class="person-name" style="--c:${CLASS_COLORS[m.class] ?? "#fff"}">${esc(m.character)}</h2>
    <p class="lead presence${m.online ? " is-online" : ""}"><i class="who__dot" aria-hidden="true"></i>${m.online ? "Online på Discord" : "Offline"}${m.discord ? ` · @${esc(m.discord)}` : ""}</p>
    ${me && me.id === m.id ? `<button class="btn btn--ghost btn--sm" data-profile style="margin-top:14px">Redigera min profil</button>` : ""}
    <p class="label">Ansvarar för</p>
    ${duties.length ? duties.map(([g, names]) => `<div class="duty"><a href="#grupp/${g.id}">${esc(g.name)}</a><p>${names.map(esc).join(" · ")}</p></div>`).join("")
      : `<p class="note" style="margin:0">${titles.length ? "Inget i någon enskild raidgrupp." : "Inget särskilt just nu. Vill du hjälpa till? Prata med en Raid Master."}</p>`}`);
}

/* ---------- min profil: namn i spelet och klass ----------
   Med Supabase hittas man via Discord-inloggningen och får bara ändra sin egen rad (RLS). */
const CLASS_NAMES = { warrior: "Warrior", paladin: "Paladin", hunter: "Hunter", rogue: "Rogue", priest: "Priest",
  shaman: "Shaman", mage: "Mage", warlock: "Warlock", druid: "Druid" };

function profileDrawer() {
  if (!me) return accountDrawer();
  openDrawer(`<p class="eyebrow">Min profil</p><h2 class="person-name" style="--c:${CLASS_COLORS[me.class] ?? "#fff"}">${esc(me.character)}</h2>
    <p class="lead">Så här syns du för guilden: på raidgrupperna, i organisationen och på assignment-tavlorna.</p>
    <label class="field" style="margin-top:20px"><span>Namn i spelet</span>
      <input id="profName" value="${esc(me.character)}" maxlength="12" autocomplete="off" spellcheck="false"></label>
    <div class="field"><span>Klass</span>
      <div class="classpick">${Object.entries(CLASS_NAMES).map(([k, n]) => `<label style="--c:${CLASS_COLORS[k]}">
        <input type="radio" name="profClass" value="${k}" ${me.class === k ? "checked" : ""}><span>${n}</span></label>`).join("")}</div>
    </div>
    <div class="ed__error" id="profError" role="alert" hidden></div>
    <div class="facts"><button class="btn btn--primary" data-profile-save>Spara</button><button class="btn btn--ghost" data-account>Avbryt</button></div>
    <p class="note" style="margin-top:14px">Byter du namn följer det med överallt, även på assignment-tavlorna.${me.discord ? ` Discord-kontot (@${esc(me.discord)}) ändras i Discord.` : ""}</p>`);
}

function saveProfileForm() {
  const name = $("#profName").value.trim();
  const cls = document.querySelector('[name="profClass"]:checked')?.value;
  const box = $("#profError");
  const err = !/^\p{L}{2,12}$/u.test(name) ? "Namnet ska vara 2–12 bokstäver, som i spelet."
    : D.members.find(m => m.id !== me.id && m.character.toLowerCase() === name.toLowerCase()) ? `${D.members.find(m => m.id !== me.id && m.character.toLowerCase() === name.toLowerCase()).character} finns redan i guilden.`
    : !CLASS_NAMES[cls] ? "Välj en klass." : null;
  if (err) { box.textContent = err; box.hidden = false; return; }
  saveProfile(me.id, { character: name[0].toUpperCase() + name.slice(1), cls });
  refresh(); route();
  accountDrawer();
}

/* ---------- inloggning ----------
   I demon väljer man vem man är. Med Supabase: "Logga in med Discord", och medlemmen hittas via Discord-id. */
function titleOf(m) {
  const t = m.guild_roles.map(id => D.role[id]?.name).filter(Boolean);
  if (t.length) return t.join(" · ");
  const active = D.groups.filter(g => g.status === "active");
  if (active.some(g => raidMaster(g) === m)) return "Raid Master";
  // har en funktion i någon grupp (utan att vara dess Raid Master): Raid Admin enligt briefen
  return D.assignments.some(a => a.member_id === m.id && D.fn[a.slot] && a.slot !== "leadership" && active.some(g => g.id === a.group_id))
    ? "Raid Admin" : "Medlem";
}

function renderAccount() {
  const acct = me
    ? `<button class="acct" data-account style="--c:${CLASS_COLORS[me.class] ?? "#fff"}"><b>${esc(me.character)}</b><small>${esc(titleOf(me))}</small></button>`
    : `<button class="btn btn--primary btn--sm" data-account>Logga in</button>`;
  // på hemmet.wtf: Flytta in alltid, och den man provar som när man har valt någon
  $("#account").innerHTML = VISNING ? `${me ? acct : ""}<a class="btn btn--primary btn--sm" href="../#join">Flytta in</a>` : acct;
}

function accountDrawer() {
  if (!me) {
    const pick = m => `<button class="pick" data-login="${m.id}"><span class="person-name" style="--c:${CLASS_COLORS[m.class] ?? "#fff"}">${esc(m.character)}</span><small>${esc(titleOf(m))}</small></button>`;
    const sorted = [...D.members].sort((a, b) => a.character.localeCompare(b.character, "sv"));
    const lead = sorted.filter(isLeadership);
    const rms = sorted.filter(m => !isLeadership(m) && titleOf(m) === "Raid Master");
    const rest = sorted.filter(m => !lead.includes(m) && !rms.includes(m));
    const block = (label, list) => list.length ? `<p class="label">${label}</p><div class="picks">${list.map(pick).join("")}</div>` : "";
    return openDrawer(`<p class="eyebrow">Logga in</p><h2>Vem är du?</h2>
      <p class="lead">Här loggar du sen in med Discord. I förhandsvisningen väljer du själv, så ser du vad varje roll får göra.</p>
      ${block("Ledningen", lead)}${block("Raid Masters", rms)}${block("Övriga", rest)}`);
  }
  const lead = isLeadership(me);
  const own = D.groups.filter(g => g.status === "active" && can.editGroup(me, g, D.assignments));
  openDrawer(`<p class="eyebrow">Inloggad</p><h2 class="person-name" style="--c:${CLASS_COLORS[me.class] ?? "#fff"}">${esc(me.character)}</h2>
    <p class="lead">${esc(titleOf(me))} · ${esc(CLASS_NAMES[me.class] ?? me.class)}</p>
    <button class="btn btn--primary btn--sm" data-profile style="margin-top:14px">Min profil</button>
    <p class="label">Det här kan du ändra</p>
    <ul class="list">
      ${lead ? "<li>Skapa och ta bort raidgrupper</li><li>Utse och byta Raid Master</li>" : ""}
      ${own.length ? `<li>${lead ? "Alla raidgrupper" : `Din grupp: ${own.map(g => `<a href="#grupp/${g.id}/redigera">${esc(g.name)}</a>`).join(", ")}`}: uppgifter, Raid Leader och funktionerna</li>` : "<li>Inget just nu. Raid Master eller ledningen fixar bemanningen.</li>"}
    </ul>
    <div class="facts" style="margin-top:24px">
      <button class="btn btn--ghost" data-logout>Byt person</button>
      <button class="btn btn--ghost" data-reset>Återställ exempeldata</button>
    </div>`);
}

function login(id) {
  me = (id && D.member[id]) || null;
  if (!VISNING) try { if (me) localStorage.setItem(ME_KEY, me.id); else localStorage.removeItem(ME_KEY); } catch { /* bara för den här sidvisningen */ }
  refresh(); route();
}

/* ---------- redigera eller skapa raidgrupp ---------- */
let draft = null;   // { g, slots: { slot: [member_id] }, isNew }
const SIZES = [10, 20, 40];

function startEdit(g, size = 40) {
  const base = g ?? { id: null, name: "", size, raid_id: "", ambition: "", raid_days: [], raid_start: "", schedule_note: "", blurb: "", details: "", signup: "open", recruit_roles: [], recruit_note: "", status: "active", links: {} };
  const slots = {};
  for (const s of ["raid_master", ...D.functions.map(f => f.id)]) slots[s] = base.id ? holders(base.id, s).map(m => m.id) : [];
  draft = { g: structuredClone(base), slots, isNew: !g };
  renderEditor();
}

function slotRow(slot, label, hint, { single = false, locked = false } = {}) {
  const ids = draft.slots[slot];
  const chips = ids.map(id => D.member[id]).filter(Boolean).map(m => `<span class="who" style="--c:${CLASS_COLORS[m.class] ?? "#fff"}">${esc(m.character)}${locked ? ""
    : `<button type="button" class="who__x" data-unassign="${slot}" data-id="${m.id}" aria-label="Ta bort ${esc(m.character)} från ${esc(label)}">✕</button>`}</span>`).join("");
  const options = D.members.filter(m => !ids.includes(m.id)).sort((a, b) => a.character.localeCompare(b.character, "sv"))
    .map(m => `<option value="${m.id}">${esc(m.character)}</option>`).join("");
  const picker = locked || (single && ids.length) ? "" : `<select class="pickadd" data-assign="${slot}" aria-label="Lägg till: ${esc(label)}"><option value="">+ Lägg till</option>${options}</select>`;
  return `<div class="ed__slot"><div class="ed__slotname">${esc(label)}${hint ? `<small>${hint}</small>` : ""}</div><div class="whos">${chips}${picker}</div></div>`;
}

function staffEditor() {
  const locked = !can.editStructure(me);
  if (draft.g.size < 20) return slotRow("raid_master", "Raid Master", locked ? "Utses och byts av Guild Leaders" : "Krävs för alla raidgrupper", { single: true, locked });
  const empty = "Tom = Raid Master gör det själv";
  return slotRow("raid_master", "Raid Master", locked ? "Utses och byts av Guild Leaders" : "Krävs för alla raidgrupper", { single: true, locked })
    + slotRow("leadership", "Raid Leader", "Tom = Raid Master leder själv")
    + D.functions.filter(f => f.id !== "leadership").map(f => slotRow(f.id, f.name, empty)).join("");
}

function renderEditor() {
  const { g, isNew } = draft;
  const structure = can.editStructure(me);
  const back = isNew ? "#raidgrupper" : `#grupp/${g.id}`;
  const field = (name, label, value, attrs = "") => `<label class="field"><span>${label}</span><input name="${name}" value="${esc(value ?? "")}" ${attrs}></label>`;
  $("#groupPage").innerHTML = `<form class="wrap gp" id="editor" novalidate>
    <div class="gp__bar">${crumbs(isNew ? [["Raidgrupper", "#raidgrupper"], ["Ny raidgrupp"]]
      : [["Raidgrupper", "#raidgrupper"], [g.name, back], ["Redigera"]])}</div>
    <p class="eyebrow">${isNew ? "Ny raidgrupp" : "Redigera raidgrupp"}</p>
    <h1 class="d2">${isNew ? "Ett nytt <span>rum</span>" : esc(g.name)}</h1>
    <div class="ed__grid">
      <fieldset class="ed__box"><legend>Om gruppen</legend>
        ${field("name", "Namn", g.name, 'required maxlength="40" autocomplete="off"')}
        <div class="field"><span>Storlek</span>
          <div class="seg">${SIZES.map(s => `<label><input type="radio" name="size" value="${s}" ${g.size === s ? "checked" : ""} ${structure ? "" : "disabled"}><span class="n">${s}</span></label>`).join("")}</div>
          ${structure ? "" : `<small>Storleken ändras av Guild Leaders.</small>`}
        </div>
        <label class="field"><span>Ambitionsnivå</span><select name="ambition"><option value="">Inte satt</option>${D.ambitions.map(a => `<option value="${a.level}" ${ambLevel(g.ambition) === a.level ? "selected" : ""}>${a.level} · ${esc(a.name)} (${esc(a.quality)})</option>`).join("")}</select>
          <small>Gruppen får en kod efter nivån, t.ex. A1 eller B2.${g.raid_id ? ` Nu: ${esc(g.raid_id)}.` : ""}</small>
          <small><button type="button" class="linkish" data-ambition="${g.ambition ?? "A"}">Vad betyder nivåerna?</button></small></label>
        <div class="field"><span>Raiddagar</span>
          <div class="seg seg--multi">${DAYS.map(([k, v]) => `<label><input type="checkbox" name="raid_days" value="${k}" ${g.raid_days?.includes(k) ? "checked" : ""}><span>${cap(v)}</span></label>`).join("")}</div>
        </div>
        <div class="field-row">
          ${field("raid_start", "Starttid", g.raid_start, 'type="time" step="900"')}
          ${field("schedule_note", "Tillägg (valfritt)", g.schedule_note ?? g.schedule, 'maxlength="40" placeholder="t.ex. När det passar"')}
        </div>
        <label class="field"><span>Om gruppen</span><textarea name="blurb" rows="2" maxlength="300" placeholder="En mening eller två om vilka ni är.">${esc(g.blurb ?? "")}</textarea></label>
        <label class="field"><span>Detaljer</span><textarea name="details" rows="7" maxlength="2000" placeholder="Vad ni raidar just nu, krav och förväntningar, consumables …">${esc(g.details ?? "")}</textarea>
          <small>Visas i rutan Detaljer på gruppens sida. Tom rad = nytt stycke.</small></label>
        <div class="field"><span>Signups</span>
          <div class="seg">${Object.entries(SIGNUP).map(([k, v]) => `<label title="${esc(v.hint)}"><input type="radio" name="signup" value="${k}" ${(g.signup ?? "open") === k ? "checked" : ""}><span>${v.name}</span></label>`).join("")}</div>
          <small id="signupHint">${esc(SIGNUP[g.signup ?? "open"]?.hint ?? "")}</small>
        </div>
        <div class="field" id="recruitRoles" ${g.signup === "full" ? "hidden" : ""}><span>Vilka roller behöver rostern?</span>
          <div class="rolepick">${Object.entries(ROLE_NAMES).map(([k, n]) => `<label><input type="checkbox" name="recruit_roles" value="${k}" ${g.recruit_roles?.includes(k) ? "checked" : ""}>
            <span>${roleIcons([k])}${n}</span></label>`).join("")}</div>
        </div>
        <label class="field" id="recruitNote"><span>Mer om rostern <small id="recruitCount">${words(g.recruit_note)} / ${RECRUIT_WORDS} ord</small></span>
          <textarea name="recruit_note" rows="3" maxlength="400" placeholder="t.ex. Vi behöver en healer, gärna präst eller druid. Eller: reserver är alltid välkomna.">${esc(g.recruit_note ?? "")}</textarea></label>
      </fieldset>
      <div class="ed__col">
        <fieldset class="ed__box"><legend>Vem ansvarar för vad</legend><div id="staffBox">${staffEditor()}</div></fieldset>
        <fieldset class="ed__box"><legend>Discord</legend>
          ${field("link_thread", "Gruppens tråd på Discord", g.links?.thread, 'type="url" placeholder="https://discord.com/channels/…"')}
        </fieldset>
      </div>
    </div>
    <div class="ed__error" id="edError" role="alert" hidden></div>
    <div class="ed__actions">
      <button class="btn btn--primary" type="submit">${isNew ? "Skapa gruppen" : "Spara"}</button>
      <a class="btn btn--ghost" href="${back}">Avbryt</a>
      ${!isNew && can.removeGroup(me) ? `<button class="btn btn--ghost btn--danger" type="button" data-remove="${g.id}">Ta bort gruppen</button>` : ""}
    </div>
  </form>`;
}

function saveDraft(form) {
  const fd = new FormData(form);
  const val = k => String(fd.get(k) ?? "").trim();
  const { g, isNew } = draft;
  const allowed = isNew ? can.createGroup(me) : can.editGroup(me, D.group[g.id] ?? g, D.assignments);
  const name = val("name"), size = g.size, errors = [];
  if (!allowed) errors.push("Du har inte behörighet att ändra den här gruppen.");
  if (!name) errors.push("Gruppen behöver ett namn.");
  if (D.groups.some(x => x.id !== g.id && x.status === "active" && x.name.toLowerCase() === name.toLowerCase())) errors.push("Det finns redan en grupp som heter så.");
  if (!draft.slots.raid_master.length) errors.push("Gruppen behöver en Raid Master.");
  if (words(val("recruit_note")) > RECRUIT_WORDS) errors.push(`Texten om rostern får vara högst ${RECRUIT_WORDS} ord (nu ${words(val("recruit_note"))}).`);
  if (val("raid_start") && !/^([01]\d|2[0-3]):[0-5]\d$/.test(val("raid_start"))) errors.push("Starttiden ska skrivas som TT:MM, t.ex. 19:30.");
  const links = {};
  for (const k of Object.keys(LINK_NAMES)) {
    const v = val(`link_${k}`);
    if (v && !/^https:\/\/\S+$/i.test(v)) errors.push(`Länken till ${LINK_NAMES[k]} ska börja med https://`);
    links[k] = v || null;
  }
  if (errors.length) {
    const box = $("#edError");
    box.innerHTML = errors.map(e => `<p>${esc(e)}</p>`).join("");
    box.hidden = false;
    box.scrollIntoView({ block: "center" });
    return;
  }
  const saved = saveGroup({ ...g, name, size, ambition: val("ambition") || null,
    // koden: behåll den om nivå och storlek är oförändrade, annars nästa lediga
    raid_id: !val("ambition") ? null
      : g.raid_id && ambLevel(g.ambition) === val("ambition") && g.size === size && g.raid_id.startsWith(val("ambition")) ? g.raid_id
      : nextCode(val("ambition"), size, g.id), raid_days: fd.getAll("raid_days"), raid_start: val("raid_start") || null, schedule_note: val("schedule_note") || null, schedule: undefined,
    blurb: val("blurb") || null, details: val("details") || null,
    signup: val("signup") || "open", recruit_note: val("recruit_note") || null,
    recruit_roles: val("signup") !== "full" ? fd.getAll("recruit_roles") : [], links }, me);
  if (can.editStructure(me)) setSlot(saved.id, "raid_master", draft.slots.raid_master);
  // funktionerna bemannas bara i 20- och 40-manna; blir gruppen 10-manna töms de (storleken ändras bara av ledningen)
  D.functions.forEach(f => setSlot(saved.id, f.id, size >= 20 ? draft.slots[f.id] : []));
  draft = null;
  refresh();
  location.hash = `grupp/${saved.id}`;
}

/* ---------- navigering ----------
   #grupp/<id>  gruppens sida · #grupp/<id>/redigera  redigera · #ny-grupp  skapa · allt annat huvudsidan */
// sidorna: start (infon), raidgrupper, roller. Gruppens egna sidor visas i #groupPage, under Raidgrupper i menyn.
const PAGES = { "": "start", "#": "start", "#start": "start", "#organisation": "start", "#raidgrupper": "raidgrupper", "#raidgrupper/soker": "raidgrupper", "#roller": "roller" };
const PAGE_TITLES = { start: "Ordning i hemmet", raidgrupper: "Raidgrupper", roller: "Roller & ansvar" };

function showMain(page, title) {
  document.querySelectorAll("main.page").forEach(el => { el.hidden = el.dataset.page !== page; });
  $("#groupPage").hidden = page !== null;
  const active = page ?? "raidgrupper";
  document.querySelectorAll("[data-nav]").forEach(a => {
    if (a.dataset.nav === active) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  document.title = VISNING && page === "start" ? PAGE_TITLE : `${title} · HEMMET`;
  window.scrollTo(0, 0);
}
const showPage = title => showMain(null, title);

function denied() {
  $("#groupPage").innerHTML = `<div class="wrap gp"><div class="gp__bar">${crumbs([["Raidgrupper", "#raidgrupper"], ["Låst"]])}</div>
    <p class="eyebrow">Låst dörr</p><h1 class="d2">Här behövs <span>nycklar</span></h1>
    <p class="lede">Det här kan bara ledningen eller gruppens Raid Master ändra.</p>
    ${me ? "" : `<p style="margin-top:28px"><button class="btn btn--primary" data-account>${VISNING ? "Prova som ledning eller Raid Master" : "Logga in"}</button></p>`}</div>`;
  return "Låst";
}

function route() {
  closeDrawer();
  const h = decodeURIComponent(location.hash);
  // borttagna grupper finns bara för ledningen
  const visible = id => { const g = D.group[id]; return g && (g.status !== "archived" || can.removeGroup(me)) ? g : null; };
  let m, g;
  if ((m = h.match(/^#ny-grupp(?:\/(10|20|40))?$/))) {
    return showPage(can.createGroup(me) ? (startEdit(null, Number(m[1]) || 40), "Ny raidgrupp") : denied());
  }
  if ((m = h.match(/^#grupp\/([^/]+)\/redigera$/)) && (g = visible(m[1]))) {
    if (g.status === "archived") { location.replace(`#grupp/${g.id}`); return; }   // återställ först, sen redigera
    return showPage(can.editGroup(me, g, D.assignments) ? (startEdit(g), `Redigera ${g.name}`) : denied());
  }
  if ((m = h.match(/^#grupp\/([^/]+)\/assignments$/)) && (g = visible(m[1])) && g.status !== "archived") {
    renderAssignmentsPage(g);
    return showPage(`Assignments · ${g.name}`);
  }
  if ((m = h.match(/^#grupp\/([^/]+)$/)) && (g = visible(m[1]))) {
    renderGroupPage(g);
    return showPage(g.name);
  }
  draft = null;
  const page = PAGES[h] ?? "start";
  if (h === "#raidgrupper/soker" || h === "#raidgrupper") {   // /soker: öppna för signups (Öppet och Hör av dig)
    gfilter.open = h === "#raidgrupper/soker";
    renderGroups();
  }
  if (!(h in PAGES)) history.replaceState(null, "", "#start");   // okänd adress: till start
  showMain(page, PAGE_TITLES[page]);
}

function bindFilters() {
  document.addEventListener("click", e => {
    const t = e.target.closest("[data-fsize],[data-fday],[data-ftime],[data-frole],[data-filter-reset]");
    if (!t) return;
    const toggle = (set, v) => { if (set.has(v)) set.delete(v); else set.add(v); };
    if (t.dataset.fsize) toggle(gfilter.sizes, +t.dataset.fsize);
    if (t.dataset.fday) toggle(gfilter.days, t.dataset.fday);
    if (t.dataset.frole) toggle(gfilter.roles, t.dataset.frole);
    if (t.dataset.ftime) gfilter.time = gfilter.time === t.dataset.ftime ? "" : t.dataset.ftime;
    if (t.hasAttribute("data-filter-reset")) { gfilter.sizes.clear(); gfilter.days.clear(); gfilter.time = ""; gfilter.open = false; gfilter.roles.clear(); }
    renderGroups();
  });
}

function bind() {
  bindFilters();
  document.addEventListener("click", async e => {
    const open = e.target.closest("[data-discord-post]");
    if (open) return discordPostDrawer(D.groups.find(g => g.id === open.dataset.discordPost));
    if (!e.target.closest("[data-discord-copy]")) return;
    const box = $("#discordText"), status = $("#discordStatus");
    try { await navigator.clipboard.writeText(box.value); status.textContent = "Kopierat. Klistra in i tråden med Ctrl+V."; }
    catch { box.select(); status.textContent = "Kunde inte kopiera automatiskt. Texten är markerad, tryck Ctrl+C."; }
  });
  document.addEventListener("click", e => {
    const a = e.target.closest("[data-profile],[data-profile-save],[data-login],[data-logout],[data-reset],[data-account],[data-unassign],[data-remove],[data-restore],[data-delete],[data-ambition]");
    if (a) {
      if (a.hasAttribute("data-profile")) profileDrawer();
      else if (a.hasAttribute("data-profile-save")) saveProfileForm();
      else if (a.dataset.login) login(a.dataset.login);
      else if (a.hasAttribute("data-logout")) { login(null); accountDrawer(); }
      else if (a.hasAttribute("data-reset")) {
        if (confirm("Ta bort allt du har ändrat och gå tillbaka till exempeldatan?")) { resetDemo(); location.hash = ""; location.reload(); }
      }
      else if (a.hasAttribute("data-account")) accountDrawer();
      else if (a.dataset.ambition) ambitionDrawer(a.dataset.ambition);
      else if (a.dataset.unassign) {
        const s = draft.slots[a.dataset.unassign];
        s.splice(s.indexOf(a.dataset.id), 1);
        $("#staffBox").innerHTML = staffEditor();
      }
      // ta bort = går att ångra, radera = för gott. Bara ledningen, och databasen kontrollerar igen.
      else if (can.removeGroup(me) && (a.dataset.remove || a.dataset.restore || a.dataset.delete)) {
        const g = D.group[a.dataset.remove || a.dataset.restore || a.dataset.delete];
        if (!g) return;
        if (a.dataset.remove && confirm(`Ta bort ${g.name}? Gruppen försvinner från sidan, men ledningen kan återställa den.`)) {
          removeGroup(g.id, me); draft = null; refresh(); location.hash = "raidgrupper";
        }
        if (a.dataset.restore) { restoreGroup(g.id, me); refresh(); route(); }
        if (a.dataset.delete && confirm(`Radera ${g.name} för gott? Gruppen och all bemanning försvinner och går inte att få tillbaka.`)) {
          deleteGroup(g.id); refresh();
          if (location.hash === `#grupp/${g.id}`) location.hash = "raidgrupper"; else route();
        }
      }
      return;
    }
    if (e.target.closest("#editor")) return;   // i formuläret öppnar namnen ingen panel
    const t = e.target.closest("[data-member],[data-role],[data-fn],[data-group]");
    if (!t) return;
    if (t.dataset.member) memberDrawer(D.member[t.dataset.member]);
    else if (t.dataset.role) roleDrawer(D.role[t.dataset.role]);
    else if (t.dataset.fn) fnDrawer(D.fn[t.dataset.fn]);
    else if (t.dataset.group) location.hash = `grupp/${t.dataset.group}`;
  });
  document.addEventListener("change", e => {
    const t = e.target;
    if (t.matches("[data-assign]") && t.value) {
      const slot = t.dataset.assign;
      draft.slots[slot].push(t.value);
      $("#staffBox").innerHTML = staffEditor();
      document.querySelector(`[data-assign="${slot}"]`)?.focus();
    }
    if (t.matches('#editor input[name="size"]')) { draft.g.size = +t.value; $("#staffBox").innerHTML = staffEditor(); }
    if (t.matches("[data-only-open]")) { gfilter.open = t.checked; renderGroups(); }
    if (t.matches('#editor input[name="signup"]')) { $("#recruitRoles").hidden = t.value === "full"; $("#signupHint").textContent = SIGNUP[t.value].hint; }
  });
  document.addEventListener("input", e => {
    if (!e.target.matches('#editor [name="recruit_note"]')) return;
    const n = words(e.target.value), c = $("#recruitCount");
    c.textContent = `${n} / ${RECRUIT_WORDS} ord`;
    c.classList.toggle("is-over", n > RECRUIT_WORDS);
  });
  document.addEventListener("submit", e => { if (e.target.id === "editor") { e.preventDefault(); saveDraft(e.target); } });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") closeDrawer();
    if ((e.key === "Enter" || e.key === " ") && e.target.matches(".qm,[data-group][tabindex]")) { e.preventDefault(); e.target.click(); }
  });
  bindAssignments();
  $("#scrim").addEventListener("click", closeDrawer);
  $("#drawerClose").addEventListener("click", closeDrawer);
  // länkar inne i panelen (t.ex. till en grupp) stänger den via route()
  window.addEventListener("hashchange", route);

}

/* Guldlinjen under menyn (samma kod i leveling-sidans och intranätets app.js): en linje som åker till det man hovrar,
   tillbaka till den valda sidan, och vid sidbyte från förra sidans val till det nya (läget sparas i sessionStorage).
   Returnerar en funktion att anropa när den valda sidan byts utan sidladdning. */
function slideBar(nav) {
  const bar = document.createElement("span");
  bar.className = "site-nav__bar"; nav.append(bar);
  const current = () => nav.querySelector("a[aria-current]");
  const jump = (fn) => { bar.style.transition = "none"; fn(); void bar.offsetWidth; bar.style.transition = ""; };
  const place = (a) => {
    if (!a) { bar.style.opacity = "0"; return; }
    bar.style.width = a.offsetWidth + "px"; bar.style.transform = `translateX(${a.offsetLeft}px)`;
    bar.style.opacity = a.hasAttribute("aria-current") ? "1" : ".5";
  };
  let from = null;
  try { from = JSON.parse(sessionStorage.getItem("hemmet-navbar") ?? "null"); sessionStorage.removeItem("hemmet-navbar"); } catch { /* utan lagring: ingen åkning vid sidbyte */ }
  if (from && current()) {
    jump(() => { bar.style.width = from.w + "px"; bar.style.transform = `translateX(${from.x}px)`; bar.style.opacity = "1"; });
    requestAnimationFrame(() => requestAnimationFrame(() => place(current())));
  } else jump(() => place(current()));
  nav.addEventListener("mouseover", (e) => { const a = e.target.closest("a"); if (a && nav.contains(a)) place(a); });
  nav.addEventListener("mouseleave", () => place(current()));
  const again = () => jump(() => place(current()));
  addEventListener("resize", again); document.fonts?.ready.then(again);
  addEventListener("pagehide", () => {
    const a = current();
    if (a) try { sessionStorage.setItem("hemmet-navbar", JSON.stringify({ x: a.offsetLeft, w: a.offsetWidth })); } catch { /* ingen lagring */ }
  });
  return () => place(current());
}

loadData().then(data => {
  RAW = data;
  D = index(RAW);
  try { me = VISNING ? null : D.member[localStorage.getItem(ME_KEY)] ?? null; } catch { me = null; }
  if (VISNING) {   // en del av hemmet.wtf: loggan leder hem, och det man provar sparas inte
    $(".demobar__text").textContent = "Påhittad data";
    document.querySelectorAll(".topbar__brand, .foot__brand").forEach(a => { a.href = "../"; });
    // EN meny för hela hemmet.wtf, samma som på huvudsidan: Levelingresan · Raiding · Om oss (+ Flytta in i #account).
    // Sidans egna delar (Översikt · Raidgrupper · Roller & ansvar) blir flikar under menyn; route() markerar dem som vanligt.
    const own = $(".topbar nav"), sub = document.createElement("nav");
    sub.className = "subnav"; sub.setAttribute("aria-label", "Raiding");
    sub.innerHTML = own.innerHTML;
    sub.querySelector('[data-nav="start"]').textContent = "Översikt";
    own.outerHTML = `<nav class="site-nav" id="siteNav" aria-label="HEMMET"><a href="../">Hem</a><a href="../levelingresan/">Levelingresan</a><a href="#start" aria-current="page">Raiding</a><a href="../#faq">Om oss</a></nav>`;
    $(".topbar").after(sub);
    slideBar($("#siteNav"));
    $(".topbar__right").insertAdjacentHTML("beforeend", `<button class="topbar__menu" type="button" aria-expanded="false" aria-controls="siteNav">Meny</button>`);
    const bar = $(".topbar"), menuBtn = $(".topbar__menu");
    menuBtn.addEventListener("click", () => menuBtn.setAttribute("aria-expanded", String(bar.classList.toggle("is-open"))));
    bar.addEventListener("click", e => { if (e.target.closest(".site-nav a")) { bar.classList.remove("is-open"); menuBtn.setAttribute("aria-expanded", "false"); } });
  }
  refresh(); bind(); route();
}).catch(err => {
  document.querySelector("#org").innerHTML = `<p class="note">Kunde inte läsa datan (${esc(err.message)}).</p>`;
  console.error(err);
});
