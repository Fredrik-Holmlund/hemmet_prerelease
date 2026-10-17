/* Assignments: en tavla per raidgrupp, byggd som lootwatchs (github.com/Fredrik-Holmlund/LootWatch).

   board = {
     roster: [{ name, class, spec, role, group, color? }]     – från Raid-Helper-importen, gemensam för gruppen
     raids:  [{ id, name,
                sections: [{ id, name, rows: [{ id, role, player }] }],   – tanks / healers / ranged / melee
                columns:  [{ id, name, image }],                           – bossar (bild ur spelets Encounter Journal)
                cells:    { [rowId]: { [colId]: text } } }]
   }
   Varje raid har egna rader, som i lootwatch: MC kan ha tre tanks och Onyxia två.
   Den som får redigera gör det direkt, utan redigeringsläge: klick på en ruta öppnar en liten editor.
   I rutorna blir roller ("MT", "Healer 1") och spelarnamn brickor, och {skull} … {star} / {rt1}–{rt8} spelets markeringar. */

import { saveBoard, saveTemplate, deleteTemplate } from "./data.js";
import { can } from "./perms.js";
import { boardImage } from "./boardImage.js";

const SECTIONS = [
  { id: "tanks", name: "Tanks" }, { id: "healers", name: "Healers" },
  { id: "ranged", name: "Ranged" }, { id: "melee", name: "Melee" },
];
// spelets egna ikoner (Interface/TargetingFrame/UI-RaidTargetingIcon_1–8)
const MARKERS = {
  star: "star", circle: "circle", diamond: "diamond", triangle: "triangle", moon: "moon", square: "square", cross: "cross", x: "cross", skull: "skull",
  rt1: "star", rt2: "circle", rt3: "diamond", rt4: "triangle", rt5: "moon", rt6: "square", rt7: "cross", rt8: "skull",
};
const MARKER_ORDER = ["skull", "cross", "square", "moon", "triangle", "diamond", "circle", "star"];   // som i spelets meny

let ctx = null;       // { D, me, g, esc, CLASS_COLORS, openDrawer, closeDrawer, refresh }
let board = null;
let raidId = null;
let pop = null;       // öppen liten editor (ruta, spelarval)
let dragging = null;  // { type: "player" | "slot" | "reorder", value }
let renaming = null;  // "raid" | "col:<id>" | "row:<id>" | "add:<sektion>"

const uid = () => Math.random().toString(36).slice(2, 9);
const clone = x => structuredClone(x);
const low = s => String(s ?? "").trim().toLowerCase();
const esc = s => ctx.esc(s);
const canEdit = () => !!ctx && can.editAssignments(ctx.me, ctx.g, ctx.D.assignments);
const raid = () => board.raids.find(r => r.id === raidId);
const emptySections = () => SECTIONS.map(s => ({ ...s, rows: [] }));
const rowsOf = r => r.sections.flatMap(s => s.rows);

export const emptyBoard = () => ({ roster: [], raids: [] });

/* äldre format: flikar med gemensamma rader → raider med egna rader */
function migrate(b) {
  const x = clone(b);
  if (!x.raids) {
    x.raids = (x.tabs ?? []).map(t => ({ id: t.id, name: t.name, sections: clone(x.sections ?? emptySections()),
      columns: t.columns.map(c => ({ image: null, ...c })), cells: t.cells ?? {} }));
    delete x.tabs; delete x.sections;
  }
  x.roster ??= [];
  // kolumner utan bild får bossens porträtt om namnet stämmer med en boss i förvalen ("Golemagg" → Golemagg the Incinerator)
  const preset = (ctx?.D.raids ?? []).flatMap(p => p.columns.filter(c => c.image));
  x.raids.forEach(r => r.columns.forEach(c => {
    if (c.image) return;
    const n = low(c.name), first = n.split(" ")[0];
    const hit = preset.find(p => low(p.name) === n) ?? (first.length >= 4 && first !== "trash" ? preset.find(p => low(p.name).split(" ")[0] === first) : null);
    if (hit) c.image = hit.image;
  }));
  return x;
}
const templateRaid = t => t.data.tabs
  ? { name: t.data.tabs[0]?.name ?? t.name, sections: t.data.sections, columns: t.data.tabs[0]?.columns ?? [], cells: t.data.tabs[0]?.cells ?? {} }
  : t.data;

/* ---------- spelare och rutor ---------- */
function playerInfo(name) {
  if (!name) return null;
  const r = board.roster.find(p => low(p.name) === low(name));
  if (r) return { name: r.name, color: ctx.CLASS_COLORS[r.class] ?? r.color ?? "#fff", spec: r.spec };
  const m = ctx.D.members.find(m => low(m.character) === low(name));
  return { name: m?.character ?? name, color: m ? ctx.CLASS_COLORS[m.class] ?? "#fff" : "#c9bfb5", spec: null };
}
// mörk eller ljus text beroende på klassfärgen (shamanens blå behöver vit text, prästens vita svart)
function textOn(hex) {
  let h = String(hex || "#c9bfb5").replace("#", "");
  if (h.length === 3) h = [...h].map(x => x + x).join("");
  const n = parseInt(h, 16);
  const [r, g, b] = [n >> 16 & 255, n >> 8 & 255, n & 255].map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; });
  return .2126 * r + .7152 * g + .0722 * b > .18 ? "#0b0f1a" : "#ffffff";
}
const chip = (name, attrs = "", solid = false) => {
  const p = playerInfo(name);
  if (!p) return "";
  return solid ? `<span class="pchip pchip--solid" style="--c:${p.color};--ct:${textOn(p.color)}" ${attrs}>${esc(p.name)}</span>`
    : `<span class="pchip" style="--c:${p.color}" ${attrs}>${esc(p.name)}</span>`;
};
const placedIn = r => new Set(rowsOf(r).map(x => low(x.player)).filter(Boolean));

const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// roller som går att skriva i rutorna, längsta först så att "OT 2" vinner över "OT"; hela ord
function roleIndex(r) {
  const rows = rowsOf(r).filter(x => x.role?.trim());
  const byLabel = new Map(rows.map(x => [low(x.role), x]));
  const labels = [...byLabel.keys()].sort((a, b) => b.length - a.length);
  const re = labels.length ? new RegExp(`(?<![\\p{L}\\p{N}])(${labels.map(reEsc).join("|")})(?![\\p{L}\\p{N}])`, "giu") : null;
  return { byLabel, re };
}
const markerImg = (k, cls = "mk") => `<img class="${cls}" src="assets/markers/${MARKERS[k]}.png" alt="{${MARKERS[k]}}" title="${MARKERS[k]}">`;

/* rutans text som delar: roller och namn blir brickor, {markering} blir spelets ikon.
   Samma delar används av sidan (renderCell) och av bilden till Discord (boardImage.js). */
function cellTokens(text, r = raid()) {
  if (!text) return [];
  const { byLabel, re } = roleIndex(r);
  // split med en fångande grupp: udda index är träffade roller
  const parts = re ? String(text).split(re) : [String(text)];
  return parts.flatMap((part, i) => {
    if (i % 2) { const row = byLabel.get(low(part)); return [{ t: "role", role: row.role, player: playerInfo(row.player) }]; }
    return wordTokens(part);
  });
}
function wordTokens(text) {
  if (!text) return [];
  // compen, guildens medlemmar och manuellt inskrivna namn som står på en rad
  const known = new Set([...board.roster.map(p => low(p.name)), ...ctx.D.members.map(m => low(m.character)),
    ...board.raids.flatMap(r => rowsOf(r).map(x => low(x.player))).filter(Boolean)]);
  return String(text).split(/(\s+)/).flatMap(tok => {
    if (!tok) return [];
    if (/^\s+$/.test(tok)) return [{ t: "sp" }];
    if (known.has(low(tok))) return [{ t: "chip", player: playerInfo(tok) }];
    // "MD{skull}" → text + ikon
    return tok.split(/(\{\w+\})/).filter(Boolean).map(x => {
      const k = x.match(/^\{(\w+)\}$/)?.[1]?.toLowerCase();
      return k && MARKERS[k] ? { t: "mk", k: MARKERS[k] } : { t: "text", v: x };
    });
  });
}
function renderCell(text, r = raid()) {
  return cellTokens(text, r).map(x =>
    x.t === "sp" ? " "
    : x.t === "text" ? esc(x.v)
    : x.t === "mk" ? markerImg(x.k)
    : x.t === "chip" ? `<span class="pchip" style="--c:${x.player.color}">${esc(x.player.name)}</span>`
    : x.player ? `<span class="pchip pchip--role" style="--c:${x.player.color}" title="${esc(x.role)}: ${esc(x.player.name)}"><small>${esc(x.role)}</small>${esc(x.player.name)}</span>`
    : `<span class="pchip pchip--role pchip--vacant" title="Ingen på ${esc(x.role)} än"><small>${esc(x.role)}</small>–</span>`).join("");
}

/* ---------- visa ---------- */
export function renderAssignments(c) {
  const sameGroup = ctx?.g?.id === c.g.id;
  ctx = c;
  const saved = c.D.boards.find(b => b.group_id === c.g.id);
  board = migrate(saved?.data ?? emptyBoard());
  if (!sameGroup || !board.raids.some(r => r.id === raidId)) raidId = board.raids[0]?.id ?? null;
  renaming = null;
  const by = saved?.updated_by && c.D.member[saved.updated_by];
  const when = saved?.updated_at ? new Date(saved.updated_at).toLocaleDateString("sv-SE", { day: "numeric", month: "short" }) : "";
  return `<div id="board" class="bd">
    ${by ? `<p class="note">Senast ändrad ${esc(when)} av ${esc(by.character)}</p>` : ""}
    <div id="boardBody"></div>
  </div>`;
}

// tabellen scrollar aldrig i sidled: får inte alla bossar plats visas så många som ryms, och man bläddrar
let ROLE_W = 112, PLAYER_W = 140, ADD_W = 40;
const MIN_COL = 116;   // så smalt att "MT | Kaminfejar" ryms
let colPage = 0;
function visibleColumns(r, width) {
  const n = r.columns.length;
  // på mobilen får roll och spelare mindre plats, så att minst en boss syns ordentligt
  [ROLE_W, PLAYER_W, ADD_W] = width < 640 ? [72, 104, 32] : [112, 140, 40];
  const per = Math.max(1, Math.floor((width - ROLE_W - PLAYER_W - (canEdit() ? ADD_W : 0) - 2) / MIN_COL));
  if (per >= n) { colPage = 0; return { cols: r.columns, pager: "" }; }
  const pages = Math.ceil(n / per);
  colPage = Math.min(Math.max(0, colPage), pages - 1);
  const start = colPage * per, cols = r.columns.slice(start, start + per);
  return { cols, pager: `<div class="bd__pager">
    <button data-colpage="-1" ${colPage === 0 ? "disabled" : ""} aria-label="Föregående bossar">‹</button>
    <span>${cols.length === 1 ? `Boss <b>${start + 1}</b>` : `Bossar <b>${start + 1}–${start + cols.length}</b>`} av ${n}</span>
    <button data-colpage="1" ${colPage === pages - 1 ? "disabled" : ""} aria-label="Fler bossar">›</button></div>` };
}

export function drawBoard() {
  const el = document.getElementById("boardBody");
  if (!el) return;
  closePop();
  const r = raid();
  // ritas tavlan innan sidan visas är bredden 0: räkna då med fönstret (sidans bredd är högst 1680 px, 16 px marginal)
  const width = el.clientWidth || Math.min(document.documentElement.clientWidth, 1680) - 32;
  const view = r ? visibleColumns(r, width) : null;
  el.innerHTML = bar() + pool(r) + raidTabs(r, view?.pager ?? "") + (r ? table(r, view.cols) : emptyState());
  const af = el.querySelector("[data-autofocus]");
  af?.focus({ preventScroll: true });
  if (af?.hasAttribute("data-select")) af.select();   // föreslaget namn: Enter tar det, eller skriv över
  // mät när sidan syns och typsnitten finns (tavlan kan ritas innan sidan visas)
  requestAnimationFrame(() => fitNames(el));
  document.fonts?.ready.then(() => fitNames(el));
}

function bar() {
  const edit = canEdit(), r = raid();
  if (!edit && !r) return "";
  return `<div class="bd__bar">
    <span class="bd__hint">${edit ? "Klicka i en ruta för att skriva. Dra spelare till en rad, eller välj i listan." : ""}</span>
    <span class="bd__tools">
      ${r ? `<button class="btn btn--primary btn--sm" data-bd="image">Bild till Discord</button>` : ""}
      ${edit ? `<button class="btn btn--ghost btn--sm" data-bd="import">Importera comp</button>
      <button class="btn btn--ghost btn--sm" data-bd="templates">Mallar</button>` : ""}
    </span>
  </div>`;
}

function emptyState() {
  return canEdit()
    ? `<div class="bd__emptybox"><p>Ingen raid upplagd än. Välj en raid så kommer bossarna med, eller utgå från en mall.</p>
        <button class="btn btn--primary" data-bd="raidadd">+ Lägg till raid</button></div>`
    : `<p class="note bd__emptynote">Inga assignments än.</p>`;
}

function pool(r) {
  const placed = r ? placedIn(r) : new Set();
  const left = board.roster.filter(p => !placed.has(low(p.name)));
  if (!left.length || !canEdit()) return "";   // läsare ser inte poolen
  const groups = [...new Set(left.map(p => p.group ?? 0))].sort((a, b) => a - b);
  return `<div class="bd__pool lfgpanel" ${canEdit() ? `data-drop="pool"` : ""}>
    <header class="lfgpanel__head"><h3>Inte placerade${canEdit() ? ` <small>dra till en rad</small>` : ""}</h3></header>
    ${groups.map(n => `<div class="bd__poolrow"><span class="bd__grp">${n ? `Grupp ${n}` : "Utan grupp"}</span>
      ${left.filter(p => (p.group ?? 0) === n).map(p => {
        const info = playerInfo(p.name);
        return `<span class="pchip" style="--c:${info.color}" ${canEdit() ? `draggable="true" data-drag="${esc(p.name)}"` : ""}>${p.spec ? `<small>${esc(p.spec)}</small>` : ""}${esc(p.name)}</span>`;
      }).join("")}</div>`).join("")}
  </div>`;
}

function raidTabs(r, pager = "") {
  if (!board.raids.length) return "";
  return `<div class="bd__tabs" role="tablist">
    ${board.raids.map(x => x.id === raidId && renaming === "raid"
      ? `<input class="bd__tabinput" data-rename="raid" value="${esc(x.name)}" maxlength="40" data-autofocus aria-label="Raidens namn">`
      : `<button class="bd__tab" role="tab" aria-selected="${x.id === raidId}" data-raid="${x.id}">${esc(x.name)}</button>`).join("")}
    ${canEdit() ? `<button class="bd__tab bd__tab--add" data-bd="raidadd">+ Raid</button>` : ""}
    ${canEdit() && r ? `<span class="bd__raidctl">
      <button class="linkish" data-bd="raidrename">Byt namn</button>
      <button class="linkish linkish--danger" data-bd="raiddel">Ta bort ${esc(r.name)}</button></span>` : ""}
  </div>
  ${pager}`;
}

function table(r, cols = r.columns) {
  const edit = canEdit();
  const n = cols.length, all = r.columns.length;
  const head = cols.map(c => { const i = r.columns.indexOf(c); return `<th class="bd__col">
    <div class="bd__colhead">
      ${edit ? `<span class="bd__colctl">
        <button data-colmove="${c.id}" data-dir="-1" ${i === 0 ? "disabled" : ""} aria-label="Flytta vänster">←</button>
        <button data-coldel="${c.id}" aria-label="Ta bort ${esc(c.name)}">✕</button>
        <button data-colmove="${c.id}" data-dir="1" ${i === all - 1 ? "disabled" : ""} aria-label="Flytta höger">→</button></span>` : ""}
      <button class="bd__colimg" data-img-one="${c.id}" title="Bild av ${esc(c.name)} till Discord" aria-label="Bild av ${esc(c.name)} till Discord">📷</button>
      ${renaming === `col:${c.id}`
        ? `<input class="bd__nameinput" data-rename="col:${c.id}" value="${esc(c.name)}" maxlength="40" data-autofocus aria-label="Kolumnens namn">`
        : `<span class="bd__colname" ${edit ? `data-startrename="col:${c.id}" title="Klicka för att byta namn"` : ""}>${esc(c.name)}</span>`}
      ${c.image ? `<img class="bd__boss" src="${esc(c.image)}" alt="" loading="lazy">` : `<span class="bd__noboss"></span>`}
    </div></th>`; }).join("");
  const body = r.sections.map(s => {
    const rows = s.rows.map((row, ri) => {
      const role = renaming === `row:${row.id}`
        ? `<input class="bd__nameinput" data-rename="row:${row.id}" value="${esc(row.role)}" maxlength="30" data-autofocus aria-label="Roll">`
        : `<span class="bd__rolename" ${edit ? `data-startrename="row:${row.id}" title="Klicka för att byta namn"` : ""}>${esc(row.role)}</span>`;
      const cells = cols.map(c => {
        const v = r.cells[row.id]?.[c.id] ?? "";
        return `<td class="bd__cell${edit ? " is-editable" : ""}" ${edit ? `data-cell="${row.id}|${c.id}"` : ""}>${renderCell(v, r) || (edit ? `<span class="bd__ph">+</span>` : "")}</td>`;
      }).join("");
      return `<tr class="bd__row${ri % 2 ? " is-alt" : ""}" data-row="${row.id}" data-sec="${s.id}">
        <th class="bd__role" scope="row"><span class="bd__rolecell">
          ${edit ? `<span class="bd__grip" draggable="true" data-reorder="${row.id}" title="Dra för att flytta raden">⠿</span>` : ""}
          ${role}
          ${edit ? `<button class="bd__x" data-rowdel="${row.id}" aria-label="Ta bort raden ${esc(row.role)}">✕</button>` : ""}</span></th>
        <td class="bd__player${row.player ? " is-filled" : ""}" ${playerFill(row)} ${edit ? `data-drop-row="${row.id}"` : ""}>${slot(row, edit)}</td>
        ${cells}${edit ? `<td class="bd__coladd"></td>` : ""}
      </tr>`;
    }).join("");
    const add = !edit ? "" : renaming === `add:${s.id}`
      ? `<input class="bd__nameinput" data-rename="add:${s.id}" maxlength="30" value="${esc(nextRowName(s))}" placeholder="Rollnamn" data-autofocus data-select>`
      : `<button class="bd__addrow" data-startrename="add:${s.id}">+ Lägg till rad</button>`;
    return `<tr class="bd__sec bd__sec--${s.id}"><th colspan="2" scope="rowgroup">${esc(s.name)} <small>${s.rows.length} roller</small></th><td colspan="${n + (edit ? 1 : 0)}"></td></tr>
      ${rows}
      ${edit ? `<tr class="bd__add"><td colspan="2">${add}</td><td colspan="${n + 1}"></td></tr>` : ""}`;
  }).join("");
  return `<div class="bd__wrap"><table class="bd__table">
    <colgroup><col style="width:${ROLE_W}px"><col style="width:${PLAYER_W}px">${cols.map(() => "<col>").join("")}${edit ? `<col style="width:${ADD_W}px">` : ""}</colgroup>
    <thead><tr><th class="bd__role">Roll</th><th class="bd__player">Spelare</th>${head}
      ${edit ? `<th class="bd__coladd"><button data-bd="coladd" title="Lägg till kolumn" aria-label="Lägg till kolumn">+</button></th>` : ""}</tr></thead>
    <tbody>${body}</tbody></table></div>`;
}

// spelarcellen fylls helt med klassfärgen (texten mörk eller ljus efter färgen)
const playerFill = row => { const p = row.player && playerInfo(row.player); return p ? `style="--c:${p.color};--ct:${textOn(p.color)}"` : ""; };

function slot(row, edit) {
  if (row.player) {
    return `<span class="bd__slot">${chip(row.player, edit ? `draggable="true" data-slot="${row.id}" data-pick="${row.id}" title="Dra till en annan rad, eller klicka för att byta"` : "", true)}
      ${edit ? `<button class="bd__x" data-clear="${row.id}" aria-label="Ta bort spelaren">✕</button>` : ""}</span>`;
  }
  return edit ? `<button class="bd__pick" data-pick="${row.id}">dra eller välj <span aria-hidden="true">⌄</span></button>` : `<span class="bd__nobody">–</span>`;
}

// roll- och spelarnamn som inte får plats krymps i stället för att bryta raden ("Warlock 4" på två rader)
function fitNames(root) {
  if (!root.isConnected || !root.offsetWidth) return;
  root.querySelectorAll(".bd__rolename, .bd__player .pchip--solid").forEach(el => {
    el.style.fontSize = "";
    let size = parseFloat(getComputedStyle(el).fontSize);
    while (el.scrollWidth > el.clientWidth + 1 && size > 10) { size -= .5; el.style.fontSize = `${size}px`; }
  });
}

/* ---------- små editorer (ruta, spelare) ---------- */
function openPop(anchor, html) {
  closePop();
  const el = document.createElement("div");
  el.className = "bd__pop";
  el.innerHTML = html;
  document.body.append(el);
  const a = anchor.getBoundingClientRect();
  let top = a.bottom + 4;
  if (top + el.offsetHeight > innerHeight - 8) top = Math.max(8, a.top - el.offsetHeight - 4);
  el.style.top = `${top}px`;
  el.style.left = `${Math.max(8, Math.min(a.left, innerWidth - el.offsetWidth - 8))}px`;
  pop = { el, anchor };
  el.querySelector("[data-pop-focus]")?.focus({ preventScroll: true });
  return el;
}
function closePop() { pop?.el.remove(); pop = null; }

function cellEditor(td) {
  const r = raid();
  const [rowId, colId] = td.dataset.cell.split("|");
  const row = rowsOf(r).find(x => x.id === rowId), col = r.columns.find(c => c.id === colId);
  const v = r.cells[rowId]?.[colId] ?? "";
  const el = openPop(td, `<div class="bd__popttl">${esc(row?.role)} · ${esc(col?.name)}</div>
    <label class="bd__poplbl">Koppla till roll</label>
    <select data-pop-role><option value="">+ roll …</option>
      ${rowsOf(r).filter(x => x.role).map(x => `<option value="${esc(x.role)}">${esc(x.role)}${x.player ? ` · ${esc(x.player)}` : ""}</option>`).join("")}</select>
    <label class="bd__poplbl">Text</label>
    <input data-pop-text data-pop-focus value="${esc(v)}" maxlength="80" placeholder="t.ex. Boss, Add {moon}, MT">
    <div class="bd__popmk">${MARKER_ORDER.map(k => `<button type="button" data-pop-mk="${k}" title="{${k}}">${markerImg(k, "")}</button>`).join("")}</div>
    <div class="bd__poppre" data-pop-preview>${renderCell(v, r)}</div>
    <div class="bd__popbtns">
      <button class="btn btn--primary btn--sm" data-pop="save">Spara</button>
      <button class="btn btn--ghost btn--sm" data-pop="clear">Rensa</button>
      <button class="bd__x bd__x--big" data-pop="close" aria-label="Stäng">✕</button>
    </div>`);
  el.dataset.cell = td.dataset.cell;
  const input = el.querySelector("[data-pop-text]");
  input.setSelectionRange(v.length, v.length);
}
function insertAtCursor(input, text) {
  const at = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, at), after = input.value.slice(input.selectionEnd ?? at);
  const add = `${before && !/\s$/.test(before) ? " " : ""}${text}`;
  input.value = before + add + after;
  input.focus({ preventScroll: true });
  input.setSelectionRange(before.length + add.length, before.length + add.length);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
function saveCell(value) {
  const [rowId, colId] = pop.el.dataset.cell.split("|");
  const r = raid();
  r.cells[rowId] ??= {};
  if (value.trim()) r.cells[rowId][colId] = value.trim(); else delete r.cells[rowId][colId];
  save();
}

function playerPicker(anchor, rowId) {
  const row = rowsOf(raid()).find(x => x.id === rowId);
  const names = board.roster.map(p => p.name);
  const members = ctx.D.members.map(m => m.character).filter(n => !names.some(x => low(x) === low(n)));
  const opt = n => `<button class="bd__pickopt" data-pick-name="${esc(n)}">${chip(n)}</button>`;
  const el = openPop(anchor, `<input class="bd__picksearch" data-pick-search data-pop-focus maxlength="24" placeholder="Sök eller skriv ett namn …" autocomplete="off">
    <button class="bd__pickopt bd__pickopt--free" data-pick-free hidden></button>
    <div class="bd__picklist">
      ${row?.player ? `<button class="bd__pickopt bd__pickopt--none" data-pick-name="">– Ingen</button>` : ""}
      ${names.length ? `<p class="bd__pickhead">Compen</p>${names.map(opt).join("")}` : ""}
      ${members.length ? `<p class="bd__pickhead">Guildens medlemmar</p>${members.map(opt).join("")}` : ""}
    </div>`);
  el.dataset.row = rowId;
}

/* ---------- ändra ---------- */
function save(redraw = true) {
  saveBoard(ctx.g.id, board, ctx.me);
  if (redraw) drawBoard();
}

/* lägg en spelare på en rad i aktiv raid; står hen redan på en annan rad flyttas hen */
function place(name, rowId) {
  const r = raid();
  rowsOf(r).forEach(x => { if (low(x.player) === low(name)) x.player = null; });
  const row = rowsOf(r).find(x => x.id === rowId);
  if (row && name) row.player = name;
  save();
}
/* dra en spelare från en rad till en annan: byter plats om målet är upptaget */
function moveSlot(fromId, toId) {
  const rows = rowsOf(raid());
  const a = rows.find(x => x.id === fromId), b = rows.find(x => x.id === toId);
  if (!a || !b || a === b) return;
  [a.player, b.player] = [b.player ?? null, a.player];
  save();
}
function reorder(fromId, toId) {
  const sec = raid().sections.find(s => s.rows.some(x => x.id === fromId));
  if (!sec || !sec.rows.some(x => x.id === toId) || fromId === toId) return;
  const from = sec.rows.findIndex(x => x.id === fromId);
  const [row] = sec.rows.splice(from, 1);
  sec.rows.splice(sec.rows.findIndex(x => x.id === toId) + (from <= sec.rows.findIndex(x => x.id === toId) ? 1 : 0), 0, row);
  save();
}

// standardnamn för nya rader i en sektion: "Ranged 6", "Melee 4" …
const ROW_LABEL = { tanks: "Tank", healers: "Healer", ranged: "Ranged", melee: "Melee" };
function nextRowName(sec) {
  const label = ROW_LABEL[sec.id] ?? sec.name;
  const nums = sec.rows.map(x => x.role.match(new RegExp(`^${label}\\s+(\\d+)$`, "i"))?.[1]).filter(Boolean).map(Number);
  return `${label} ${Math.max(sec.rows.length, ...nums) + 1}`;
}

/* sätt spelare som inte står någonstans på en tom rad i rätt sektion, helst en med klassen i namnet */
function autoPlace(r) {
  const placed = placedIn(r);
  for (const p of board.roster) {
    if (placed.has(low(p.name))) continue;
    const sec = r.sections.find(s => s.id === p.role) ?? r.sections.find(s => s.id === "ranged");
    if (!sec) continue;
    const empty = sec.rows.filter(x => !x.player);
    const row = empty.find(x => low(x.role).includes(low(p.class))) ?? empty[0];
    if (row) row.player = p.name;
    else sec.rows.push({ id: uid(), role: nextRowName(sec), player: p.name });
    placed.add(low(p.name));
  }
}

function commitRename(key, value, keepAdding = true) {
  const v = value.trim();
  const r = raid();
  renaming = null;
  if (key === "raid") { if (v) r.name = v; return save(); }
  if (key.startsWith("col:")) { const c = r.columns.find(x => x.id === key.slice(4)); if (c && v) c.name = v; return save(); }
  if (key.startsWith("add:")) {
    const sec = r.sections.find(s => s.id === key.slice(4));
    if (sec && v) { sec.rows.push({ id: uid(), role: v, player: null }); if (keepAdding) renaming = key; }   // efter Enter: fortsätt lägga till
    return save();
  }
  if (key.startsWith("row:")) {
    const row = rowsOf(r).find(x => x.id === key.slice(4));
    if (!row || !v || v === row.role) return drawBoard();
    // rutor som pekar på rollen följer med när den döps om
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${reEsc(row.role)}(?![\\p{L}\\p{N}])`, "giu");
    Object.values(r.cells).forEach(cells => Object.keys(cells).forEach(k => { cells[k] = cells[k].replace(re, v); }));
    row.role = v;
    return save();
  }
}

/* ---------- lägg till raid ---------- */
function raidDrawer() {
  const r = raid();
  const tpls = ctx.D.templates;
  ctx.openDrawer(`<p class="eyebrow">Assignments</p><h2>Lägg till raid</h2>
    <p class="lead">Välj en raid så kommer bossarna med som kolumner, eller utgå från en av guildens mallar.</p>
    ${r ? `<label class="bd__check"><input type="checkbox" id="raidCopy" checked> Ta med roller och spelare från ${esc(r.name)}</label>` : ""}
    <p class="label">Raider</p>
    <div class="bd__raidopts">${ctx.D.raids.map(p => `<button class="bd__raidopt" data-raid-preset="${p.id}">
      <span>${p.columns.filter(c => c.image).slice(0, 3).map(c => `<img src="${esc(c.image)}" alt="">`).join("")}</span>
      <b>${esc(p.name)}</b><small>${p.columns.length - 1} bossar · ${p.size}-manna</small></button>`).join("")}</div>
    <p class="label">Guildens mallar</p>
    ${tpls.length ? tpls.map(t => `<button class="bd__raidopt bd__raidopt--tpl" data-raid-tpl="${t.id}"><b>${esc(t.name)}</b>${t.description ? `<small>${esc(t.description)}</small>` : ""}</button>`).join("")
      : `<p class="note" style="margin:0">Inga mallar än.</p>`}
    <p class="label">Egen raid</p>
    <div class="bd__inline"><input id="raidName" maxlength="40" placeholder="t.ex. Karazhan"><button class="btn btn--ghost btn--sm" data-bd="raidcustom">Skapa</button></div>`);
}

function addRaid({ name, columns = [], sections = null, cells = {} }) {
  const copyFrom = document.getElementById("raidCopy")?.checked ? raid() : null;
  const nr = {
    id: uid(), name,
    sections: sections ? clone(sections).map(s => ({ ...s, rows: s.rows.map(x => ({ ...x, player: null })) }))
      : copyFrom ? clone(copyFrom.sections) : emptySections(),
    columns: clone(columns),
    cells: clone(cells),
  };
  // nya kolumn-id, så att samma mall kan användas flera gånger
  const ids = {};
  nr.columns = nr.columns.map(c => { const id = uid(); ids[c.id] = id; return { ...c, id }; });
  Object.values(nr.cells).forEach(cs => Object.keys(cs).forEach(k => { if (ids[k]) { cs[ids[k]] = cs[k]; delete cs[k]; } }));
  autoPlace(nr);
  board.raids.push(nr);
  raidId = nr.id;
  ctx.closeDrawer();
  save();
}

/* ---------- Raid-Helper-import (Composition Tool → Export JSON) ---------- */
const MELEE = ["arms", "fury", "retribution", "enhancement", "feral", "assassination", "combat", "subtlety"];
const HEAL = ["restoration", "holy", "discipline", "dreamstate"];
const TANK = ["guardian", "protection"];

export function parseRaidHelper(text) {
  let json;
  try { json = JSON.parse(text); } catch { throw new Error("Det där ser inte ut som JSON. Kopiera hela exporten från Raid-Helper."); }
  const slots = Array.isArray(json?.slots) ? json.slots : Array.isArray(json) ? json : null;
  if (!slots) throw new Error("Hittar inga spelare (\"slots\") i datan.");
  // spec → klass ur exportens egen klasslista ("Tank" är ingen klass i Raid-Helper)
  const specClass = {};
  (json.classes ?? []).forEach(c => (c.specs ?? []).forEach(s => { specClass[low(s.name)] = low(c.name); }));
  const seen = new Set();
  const players = [];
  for (const s of slots) {
    const name = String(s?.name ?? "").trim();
    if (!name || seen.has(low(name))) continue;
    seen.add(low(name));
    const specRaw = String(s.specName ?? "");
    const spec = specRaw.replace(/\d+$/, "");
    let cls = low(s.className);
    if (!ctx.CLASS_COLORS[cls]) cls = specClass[low(specRaw)] ?? cls;
    const sp = low(spec);
    const role = low(s.className) === "tank" || TANK.includes(sp) ? "tanks"
      : HEAL.includes(sp) ? "healers" : MELEE.includes(sp) ? "melee" : "ranged";
    players.push({ name, class: cls, spec, role, group: Number(s.groupNumber) || null, color: s.color ?? null });
  }
  if (!players.length) throw new Error("Hittade inga spelare med namn i datan.");
  return players;
}

function importDrawer() {
  ctx.openDrawer(`<p class="eyebrow">Importera</p><h2>Comp från Raid-Helper</h2>
    <p class="lead">Öppna Composition Tool i Raid-Helper, välj Export JSON och klistra in här.</p>
    <label class="field" style="margin-top:18px"><span>JSON</span><textarea id="rhJson" rows="10" spellcheck="false" placeholder='{"slots":[…]}'></textarea></label>
    <div class="ed__error" id="rhError" role="alert" hidden></div>
    <p class="note">Spelarlistan byts ut i alla raider. Den som inte är med i den nya compen plockas bort från raderna, och de nya läggs
      på tomma rader i rätt sektion, helst en med klassen i namnet. Det som står i rutorna rörs inte.</p>
    <button class="btn btn--primary" data-bd="doimport">Importera</button>`);
}

function doImport() {
  const box = document.getElementById("rhError");
  try {
    const players = parseRaidHelper(document.getElementById("rhJson").value);
    const names = new Set(players.map(p => low(p.name)));
    board.raids.forEach(r => rowsOf(r).forEach(x => { if (x.player && !names.has(low(x.player))) x.player = null; }));
    board.roster = players;
    board.raids.forEach(autoPlace);
    save();
    const count = id => players.filter(p => p.role === id).length;
    ctx.openDrawer(`<p class="eyebrow">Importerat</p><h2>${players.length} spelare</h2>
      <p class="lead">${SECTIONS.map(s => `${count(s.id)} ${s.name.toLowerCase()}`).join(" · ")}</p>
      <p class="note" style="margin-top:14px">${board.raids.length ? "Spelarna har lagts ut på raderna. Dra om dem eller välj i listan om något hamnade fel."
        : "Lägg till en raid, så läggs spelarna ut på raderna."}</p>
      <button class="btn btn--primary" data-bd="closedrawer">Till tavlan</button>`);
  } catch (err) {
    box.textContent = err.message; box.hidden = false;
  }
}

/* ---------- mallar (en raid utan spelare) ---------- */
/* mallarna grupperade per raid (spelets ordning), raiden man står på först, med sökruta */
const raidKey = name => low(name).replace(/'s\b/g, "").split(/\s+/)[0] || "";
function templatesDrawer() {
  const { D, me } = ctx;
  const r = raid();
  const groups = new Map();   // nyckel → { title, images, items }
  D.raids.forEach(p => groups.set(raidKey(p.name), { title: p.name, images: p.columns.filter(c => c.image).slice(0, 3).map(c => c.image), items: [] }));
  for (const t of D.templates) {
    const tr = templateRaid(t);
    const key = groups.has(raidKey(tr.name)) ? raidKey(tr.name) : "egna";
    if (!groups.has(key)) groups.set(key, { title: "Egna raider", images: [], items: [] });
    groups.get(key).items.push({ t, tr });
  }
  const active = r ? raidKey(r.name) : null;
  const ordered = [...groups.entries()].filter(([, g]) => g.items.length)
    .sort(([a], [b]) => (b === active) - (a === active));   // raiden man står på först, annars spelets ordning
  const row = ({ t, tr }) => {
    const by = t.created_by && D.member[t.created_by];
    const text = low([t.name, t.description, tr.name].join(" "));
    return `<li class="tplrow" data-text="${esc(text)}">
      <div class="tplrow__main">
        <b>${esc(t.name)}</b>
        ${t.description ? `<p>${esc(t.description)}</p>` : ""}
        <small>${NUMS(tr.columns.length)} kolumner · ${NUMS(tr.sections.reduce((n, s) => n + s.rows.length, 0))} rader${by ? ` · av ${esc(by.character)}` : ""}
          ${can.deleteTemplate(me, t) ? ` · <button class="linkish linkish--danger" data-tpl-del="${t.id}">Ta bort</button>` : ""}</small>
      </div>
      ${canEdit() ? `<button class="btn btn--primary btn--sm" data-raid-tpl="${t.id}">Lägg till</button>` : ""}
    </li>`;
  };
  ctx.openDrawer(`<p class="eyebrow">Assignments</p><h2>Mallar</h2>
    <p class="lead">Guildens gemensamma upplägg, en raid i taget. Namnen följer inte med, bara roller, bossar och text. Rutor som pekar på roller (MT, Healer 1) fylls i av sig själva.</p>
    ${D.templates.length > 3 ? `<input class="tplsearch" data-tpl-search type="search" placeholder="Sök mall eller raid …" autocomplete="off">` : ""}
    <div class="tplgroups">
      ${ordered.length ? ordered.map(([key, g]) => `<section class="lfgpanel tplgroup">
        <header class="lfgpanel__head"><h3>${esc(g.title)}${key === active ? ` <small>du står här</small>` : ""}
          <span class="tplgroup__art">${g.images.map(src => `<img src="${esc(src)}" alt="">`).join("")}</span></h3></header>
        <ul class="tplgroup__list">${g.items.map(row).join("")}</ul>
      </section>`).join("") : `<p class="note" style="margin:0">Inga mallar än.</p>`}
      <p class="note tplnone" hidden>Ingen mall matchar sökningen.</p>
    </div>
    ${r && can.saveTemplate(me, D.assignments) && canEdit() ? `<section class="lfgpanel tplsave">
      <header class="lfgpanel__head"><h3>Spara ${esc(r.name)} som mall</h3></header>
      <div class="lfgpanel__body">
        <label class="field"><span>Namn</span><input id="tplName" maxlength="40" value="${esc(r.name)}"></label>
        <label class="field"><span>Kort beskrivning</span><input id="tplDesc" maxlength="120" placeholder="t.ex. Tre tanks, decurse och banish utdelade"></label>
        <div class="ed__error" id="tplError" role="alert" hidden></div>
        <button class="btn btn--ghost btn--sm" data-bd="tplsave">Spara som mall</button>
      </div>
    </section>` : ""}`);
}
const NUMS = n => `<span class="n">${n}</span>`;

function saveAsTemplate() {
  const r = raid();
  const name = document.getElementById("tplName").value.trim();
  const box = document.getElementById("tplError");
  if (!name) { box.textContent = "Mallen behöver ett namn."; box.hidden = false; return; }
  saveTemplate({ name, description: document.getElementById("tplDesc").value.trim() || null,
    data: { name: r.name, sections: clone(r.sections).map(s => ({ ...s, rows: s.rows.map(x => ({ ...x, player: null })) })),
      columns: clone(r.columns), cells: clone(r.cells) } }, ctx.me);
  ctx.refresh();
  templatesDrawer();
}

/* ---------- bild till Discord ---------- */
let imgBlob = null, imgSeq = 0;
const fileSlug = x => low(x).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function imageDrawer(onlyCol = null) {
  const r = raid();
  if (!r) return;
  imgBlob = null;
  ctx.openDrawer(`<p class="eyebrow">Bild till Discord</p><h2>${esc(r.name)}</h2>
    <p class="lead">Kopiera bilden och klistra in den i Discord med Ctrl+V.</p>
    <p class="label">Bossar</p>
    <div class="bd__colpick">
      <label class="bd__check bd__check--all"><input type="checkbox" data-img-all ${onlyCol ? "" : "checked"}> Alla</label>
      ${r.columns.map(c => `<label class="bd__check"><input type="checkbox" data-img-col="${c.id}" ${!onlyCol || onlyCol === c.id ? "checked" : ""}> ${esc(c.name)}</label>`).join("")}
    </div>
    <label class="bd__check"><input type="checkbox" data-img-hide checked> Dölj rader utan uppgifter</label>
    <div class="bd__imgprev" id="imgPrev"><p class="note">Ritar bilden …</p></div>
    <div class="facts">
      <button class="btn btn--primary" data-bd="imgcopy">Kopiera bild</button>
      <button class="btn btn--ghost" data-bd="imgdl">Ladda ner</button>
    </div>
    <p class="note" id="imgMsg" role="status" style="margin-top:10px"></p>`);
  updateImage();
}

async function updateImage() {
  const r = raid();
  const prev = document.getElementById("imgPrev");
  if (!r || !prev) return;
  const seq = ++imgSeq;
  const chosen = new Set([...document.querySelectorAll("[data-img-col]")].filter(i => i.checked).map(i => i.dataset.imgCol));
  const cols = r.columns.filter(c => chosen.has(c.id));
  imgBlob = null;
  if (!cols.length) { prev.innerHTML = `<p class="note">Välj minst en boss.</p>`; return; }
  const hide = document.querySelector("[data-img-hide]")?.checked;
  const sections = r.sections.map(s => ({
    id: s.id, name: s.name,
    rows: s.rows.map(row => ({ role: row.role, player: playerInfo(row.player), cells: cols.map(c => r.cells[row.id]?.[c.id] ?? "") }))
      .filter(row => !hide || row.cells.some(Boolean)),
  })).filter(s => s.rows.length);
  const when = new Date().toLocaleDateString("sv-SE", { day: "numeric", month: "short" });
  const one = cols.length === 1;
  const canvas = await boardImage({
    title: one ? cols[0].name : r.name,
    subtitle: [one ? r.name : null, ctx.g.name, `Assignments ${when}`].filter(Boolean).join(" · "),
    columns: cols.map(c => ({ name: c.name, image: c.image })),
    sections, tokens: t => cellTokens(t, r), footer: "hemmet.wtf",
  });
  const blob = await new Promise(res => canvas.toBlob(res, "image/png"));
  if (seq !== imgSeq) return;   // ett nyare val hann före
  imgBlob = blob;
  imgBlob.fileName = `${fileSlug(ctx.g.name)}-${fileSlug(one ? `${r.name} ${cols[0].name}` : r.name)}.png`;
  const img = new Image();
  img.src = URL.createObjectURL(blob);
  img.alt = "Förhandsvisning av bilden";
  prev.replaceChildren(img);
}

async function copyImage() {
  const msg = document.getElementById("imgMsg");
  if (!imgBlob) { msg.textContent = "Bilden ritas fortfarande, försök igen om en sekund."; return; }
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": imgBlob })]);
    msg.textContent = "Kopierad! Klistra in i Discord med Ctrl+V.";
  } catch {
    msg.textContent = "Webbläsaren lät inte sidan kopiera bilden. Använd Ladda ner i stället.";
  }
}

function downloadImage() {
  if (!imgBlob) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(imgBlob);
  a.download = imgBlob.fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

/* ---------- händelser (kopplas en gång, gäller den tavla som visas) ---------- */
export function bindAssignments() {
  const onBoard = () => !!ctx && !!document.getElementById("board");

  document.addEventListener("click", e => {
    if (!onBoard()) return;
    const t = e.target.closest("[data-colpage],[data-img-one],[data-pick-free],[data-bd],[data-raid],[data-raid-preset],[data-raid-tpl],[data-tpl-del],[data-colmove],[data-coldel],[data-rowdel],[data-clear],[data-pick],[data-startrename],[data-cell],[data-pop],[data-pop-mk],[data-pick-name]");
    if (!t) return;
    const d = t.dataset;
    if (d.colpage) { colPage += Number(d.colpage); return drawBoard(); }
    if (d.raid) { raidId = d.raid; renaming = null; colPage = 0; return drawBoard(); }
    if (d.bd === "templates") return templatesDrawer();
    if (d.bd === "image") return imageDrawer();
    if (d.imgOne) return imageDrawer(d.imgOne);
    if (d.bd === "imgcopy") return copyImage();
    if (d.bd === "imgdl") return downloadImage();
    if (d.bd === "closedrawer") return ctx.closeDrawer();
    if (d.tplDel) {
      const tpl = ctx.D.templates.find(x => x.id === d.tplDel);
      if (tpl && can.deleteTemplate(ctx.me, tpl) && confirm(`Ta bort mallen "${tpl.name}"?`)) { deleteTemplate(tpl.id); ctx.refresh(); templatesDrawer(); }
      return;
    }
    if (!canEdit()) return;
    // små editorer
    if (d.pop === "close") return closePop();
    if (d.pop === "save") return saveCell(pop.el.querySelector("[data-pop-text]").value);
    if (d.pop === "clear") return saveCell("");
    if (d.popMk) return insertAtCursor(pop.el.querySelector("[data-pop-text]"), `{${d.popMk}}`);
    if (d.pickName !== undefined && pop?.el.dataset.row) return place(d.pickName, pop.el.dataset.row);
    if (d.pickFree && pop?.el.dataset.row) return place(d.pickFree, pop.el.dataset.row);
    if (d.cell) return cellEditor(t);
    if (d.pick) return playerPicker(t, d.pick);
    if (d.clear) { const row = rowsOf(raid()).find(x => x.id === d.clear); if (row) row.player = null; return save(); }
    // raider
    if (d.bd === "import") return importDrawer();
    if (d.bd === "doimport") return doImport();
    if (d.bd === "tplsave") return saveAsTemplate();
    if (d.bd === "raidadd") return raidDrawer();
    if (d.raidPreset) { const p = ctx.D.raids.find(x => x.id === d.raidPreset); if (p) addRaid({ name: p.name, columns: p.columns.map((c, i) => ({ ...c, id: `c${i}` })) }); return; }
    if (d.raidTpl) { const tpl = ctx.D.templates.find(x => x.id === d.raidTpl); if (tpl) addRaid(templateRaid(tpl)); return; }
    if (d.bd === "raidcustom") {
      const name = document.getElementById("raidName").value.trim() || `Raid ${board.raids.length + 1}`;
      return addRaid({ name, columns: [{ id: "c0", name: "Trash", image: null }] });
    }
    const r = raid();
    if (!r) return;
    if (d.bd === "raidrename") { renaming = "raid"; return drawBoard(); }
    if (d.bd === "raiddel") {
      if (!confirm(`Ta bort ${r.name} med alla dess rader och rutor?`)) return;
      const i = board.raids.indexOf(r);
      board.raids.splice(i, 1);
      raidId = (board.raids[i - 1] ?? board.raids[0])?.id ?? null;   // grannen till vänster
      return save();
    }
    if (d.startrename) { renaming = d.startrename; return drawBoard(); }
    if (d.bd === "coladd") { const id = uid(); r.columns.push({ id, name: "Ny boss", image: null }); renaming = `col:${id}`; return save(); }
    if (d.colmove) {
      const i = r.columns.findIndex(c => c.id === d.colmove), j = i + Number(d.dir);
      if (i >= 0 && j >= 0 && j < r.columns.length) [r.columns[i], r.columns[j]] = [r.columns[j], r.columns[i]];
      return save();
    }
    if (d.coldel) {
      const col = r.columns.find(c => c.id === d.coldel);
      if (!col || !confirm(`Ta bort kolumnen "${col.name}"?`)) return;
      r.columns = r.columns.filter(c => c.id !== col.id);
      Object.values(r.cells).forEach(cs => delete cs[col.id]);
      return save();
    }
    if (d.rowdel) {
      r.sections.forEach(s => { s.rows = s.rows.filter(x => x.id !== d.rowdel); });
      delete r.cells[d.rowdel];
      return save();
    }
  });

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (onBoard() && !pop && !renaming) drawBoard(); }, 150);
  });

  // stäng editorn vid klick utanför, Esc, eller när man scrollar sidan
  document.addEventListener("mousedown", e => { if (pop && !pop.el.contains(e.target) && !e.target.closest("[data-cell],[data-pick]")) closePop(); });
  document.addEventListener("scroll", e => { if (pop && !pop.el.contains(e.target)) closePop(); }, true);

  document.addEventListener("keydown", e => {
    if (!onBoard()) return;
    if (pop && e.key === "Escape") { e.stopPropagation(); return closePop(); }
    if (pop && e.key === "Enter" && e.target.matches("[data-pop-text]")) { e.preventDefault(); return saveCell(e.target.value); }
    if (pop && e.key === "Enter" && e.target.matches("[data-pick-search]")) {
      // Enter: första träffen i listan, annars namnet som det är skrivet
      e.preventDefault();
      const name = e.target.value.trim();
      if (!name) return;
      const hit = [...pop.el.querySelectorAll("[data-pick-name]")].find(b => !b.hidden && b.dataset.pickName);
      return place(hit && low(hit.dataset.pickName).includes(low(name)) ? hit.dataset.pickName : name, pop.el.dataset.row);
    }
    if (e.target.matches("[data-rename]")) {
      // markera fältet som klart: när det ritas bort tappar det fokus, och då får focusout inte spara en gång till
      if (e.key === "Enter") { e.preventDefault(); e.target.dataset.done = "1"; commitRename(e.target.dataset.rename, e.target.value); }
      if (e.key === "Escape") { e.stopPropagation(); e.target.dataset.done = "1"; renaming = null; drawBoard(); }
    }
    if (e.key === "Enter" && e.target.id === "raidName") { e.preventDefault(); document.querySelector('[data-bd="raidcustom"]')?.click(); }
  });
  document.addEventListener("focusout", e => {
    if (!onBoard() || !e.target.matches?.("[data-rename]") || e.target.dataset.done || !e.target.isConnected
      || renaming !== e.target.dataset.rename) return;
    const key = e.target.dataset.rename;
    if (key.startsWith("add:") && !e.target.value.trim()) { renaming = null; return drawBoard(); }
    commitRename(key, e.target.value, false);   // klickade bort: spara och stäng
  });
  document.addEventListener("input", e => {
    if (pop && e.target.matches("[data-pop-text]")) pop.el.querySelector("[data-pop-preview]").innerHTML = renderCell(e.target.value);
    if (e.target.matches?.("[data-tpl-search]")) {
      const q = low(e.target.value);
      let any = false;
      document.querySelectorAll(".tplgroup").forEach(g => {
        let hits = 0;
        g.querySelectorAll(".tplrow").forEach(row => { const hit = !q || row.dataset.text.includes(q) || low(g.querySelector("h3").textContent).includes(q); row.hidden = !hit; hits += hit; });
        g.hidden = !hits; any ||= hits > 0;
      });
      document.querySelector(".tplnone").hidden = any;
      return;
    }
    if (pop && e.target.matches("[data-pick-search]")) {
      const q = low(e.target.value);
      pop.el.querySelectorAll("[data-pick-name]").forEach(b => { b.hidden = !!q && !low(b.dataset.pickName).includes(q); });
      // namn som inte finns i listan: skriv in det manuellt (en invite, en ersättare …)
      const free = pop.el.querySelector("[data-pick-free]");
      const name = e.target.value.trim();
      const exists = [...pop.el.querySelectorAll("[data-pick-name]")].some(b => low(b.dataset.pickName) === low(name));
      free.hidden = !name || exists;
      free.innerHTML = `Använd <b>"${esc(name)}"</b>`;
      free.dataset.pickFree = name;
    }
  });
  document.addEventListener("change", e => {
    if (e.target.matches("[data-img-all]")) {
      document.querySelectorAll("[data-img-col]").forEach(i => { i.checked = e.target.checked; });
      return updateImage();
    }
    if (e.target.matches("[data-img-col]")) {
      const all = [...document.querySelectorAll("[data-img-col]")];
      document.querySelector("[data-img-all]").checked = all.every(i => i.checked);
      return updateImage();
    }
    if (e.target.matches("[data-img-hide]")) return updateImage();
    if (pop && e.target.matches("[data-pop-role]") && e.target.value) {
      insertAtCursor(pop.el.querySelector("[data-pop-text]"), e.target.value);
      e.target.value = "";
    }
  });

  // dra och släpp: spelare från poolen, spelare mellan rader (byter plats), rader inom en sektion
  document.addEventListener("dragstart", e => {
    if (!onBoard() || !canEdit()) return;
    const t = e.target.closest?.("[data-drag],[data-slot],[data-reorder]");
    if (!t) return;
    closePop();
    dragging = t.dataset.drag !== undefined ? { type: "player", value: t.dataset.drag }
      : t.dataset.slot !== undefined ? { type: "slot", value: t.dataset.slot } : { type: "reorder", value: t.dataset.reorder };
    e.dataTransfer.setData("text/plain", dragging.value);
    e.dataTransfer.effectAllowed = "move";
    if (dragging.type === "reorder") e.dataTransfer.setDragImage(t.closest("tr"), 20, 16);
  });
  const target = e => {
    if (!dragging) return null;
    if (dragging.type === "reorder") {
      const tr = e.target.closest?.("tr[data-row]");
      const from = document.querySelector(`tr[data-row="${dragging.value}"]`);
      return tr && from && tr.dataset.sec === from.dataset.sec ? tr : null;
    }
    return e.target.closest?.("[data-drop-row],[data-drop='pool']");
  };
  document.addEventListener("dragover", e => {
    const t = target(e);
    if (!t) return;
    e.preventDefault();
    document.querySelectorAll(".is-over").forEach(x => x !== t && x.classList.remove("is-over"));
    t.classList.add("is-over");
  });
  document.addEventListener("drop", e => {
    const t = target(e);
    if (!t) return;
    e.preventDefault();
    const { type, value } = dragging;
    dragging = null;
    if (type === "reorder") return reorder(value, t.dataset.row);
    const toPool = t.dataset.drop === "pool";
    if (type === "player") return toPool ? null : place(value, t.dataset.dropRow);
    if (type === "slot") {
      if (toPool) { const row = rowsOf(raid()).find(x => x.id === value); if (row) row.player = null; return save(); }
      return moveSlot(value, t.dataset.dropRow);
    }
  });
  document.addEventListener("dragend", () => { dragging = null; document.querySelectorAll(".is-over").forEach(x => x.classList.remove("is-over")); });
}
