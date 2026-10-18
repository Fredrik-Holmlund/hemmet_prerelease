/* Datalagret. I demon: exempeldatan i data/*.json, och det man ändrar sparas i webbläsaren (localStorage).
   Med Supabase byts funktionerna här mot anrop, med samma namn och samma kolumner:
     loadData()                     → select * från varje tabell
     saveGroup(g, me)               → upsert into groups
     setSlot(groupId, slot, ids)    → delete + insert i assignments för (group_id, slot)
     removeGroup / restoreGroup     → update groups set status = 'archived' / 'active'
     deleteGroup(id)                → delete from groups (assignments följer med via on delete cascade)
     saveBoard(groupId, board, me)  → upsert into assignment_boards
     saveTemplate(t, me)            → insert into assignment_templates
     deleteTemplate(id)             → delete from assignment_templates
     saveProfile(id, { character, class }) → update members (bara sin egen rad, se RLS)
   Behörigheterna kontrolleras av databasen (RLS), inte bara av sidan.

   Tabellerna
   roles        id, level, name, short, description, responsibilities[], mandate        – guildens formella roller
   functions    id, sort, name, purpose, description, deadline, tools[], holder_title?    – de sex obligatoriska funktionerna
   members      id, character, class, discord, guild_roles[], online   – guild_master / guild_leader; online från Discord-boten
   groups       id, name, size, raid_id, ambition, raid_days[] (mon–sun), raid_start (HH:MM), schedule_note, status, blurb, details, signup (open/ask/full), recruit_roles[], recruit_note, links, updated_by, updated_at
   assignments  group_id, slot, member_id   – slot = "raid_master", ett funktions-id eller "contact" (10-manna)
                en rad per person: samma person kan stå på flera rader, flera personer på samma slot
   ambitions    level (1–5), name, tagline, expect { rubrik: text }
   boards       group_id, data, updated_by, updated_at   – assignment-tavlan, se assignments.js
   templates    id, name, description, data (en raid utan spelare), created_by, created_at   – guildens mallar
   raids        id, name, size, columns [{ name, image }]   – förvalda raider med bossarna, från scripts/fetch_bosses.py */

const TABLES = ["roles", "functions", "members", "groups", "assignments", "ambitions", "boards", "templates", "raids"];
const KEY = "hemmet-ledning-demo";
const EDITABLE = ["groups", "assignments", "boards", "templates", "members"];   // resten hämtas alltid färskt från filerna
// höj när exempeldatan i data/*.json ändras: äldre sparade demoändringar slängs då, annars syns inte det nya
const SEED_VERSION = 3;

let db = null;

function persist() {
  if (document.documentElement.hasAttribute("data-visning")) return;   // visningsläget: ändringarna lever bara i sidvisningen
  try { localStorage.setItem(KEY, JSON.stringify({ seed: SEED_VERSION, ...Object.fromEntries(EDITABLE.map(t => [t, db[t]])) })); } catch { /* privat läge: ändringarna lever bara tills sidan laddas om */ }
}

export async function loadData() {
  const rows = await Promise.all(TABLES.map(t => fetch(`data/${t}.json`).then(r => {
    if (!r.ok) throw new Error(`data/${t}.json: ${r.status}`);
    return r.json();
  })));
  db = Object.fromEntries(TABLES.map((t, i) => [t, rows[i]]));
  if (document.documentElement.hasAttribute("data-visning")) return db;   // visningsläget: alltid exempeldatan
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (saved?.seed === SEED_VERSION) EDITABLE.forEach(t => Array.isArray(saved[t]) && (db[t] = saved[t]));
    else if (saved) localStorage.removeItem(KEY);
  } catch { /* trasig eller blockerad lagring: kör på exempeldatan */ }
  return db;
}

const slugify = s => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "grupp";

export function saveGroup(g, me) {
  const row = { ...g, updated_by: me?.id ?? null, updated_at: new Date().toISOString() };
  if (!row.id) {
    let id = slugify(row.name), n = 2;
    while (db.groups.some(x => x.id === id)) id = `${slugify(row.name)}-${n++}`;
    row.id = id;
    db.groups.push(row);
  } else {
    const i = db.groups.findIndex(x => x.id === row.id);
    if (i < 0) db.groups.push(row); else db.groups[i] = row;
  }
  persist();
  return row;
}

export function setSlot(groupId, slot, memberIds) {
  db.assignments = db.assignments.filter(a => !(a.group_id === groupId && a.slot === slot))
    .concat([...new Set(memberIds)].map(member_id => ({ group_id: groupId, slot, member_id })));
  persist();
}

function setStatus(id, status, me) {
  const g = db.groups.find(x => x.id === id);
  if (g) saveGroup({ ...g, status }, me);
}
export const removeGroup = (id, me) => setStatus(id, "archived", me);
export const restoreGroup = (id, me) => setStatus(id, "active", me);

export function deleteGroup(id) {
  db.groups = db.groups.filter(g => g.id !== id);
  db.assignments = db.assignments.filter(a => a.group_id !== id);
  persist();
}

export function resetDemo() {
  try { localStorage.removeItem(KEY); } catch { /* inget att rensa */ }
}

/* ---------- assignments ---------- */
export function saveBoard(groupId, data, me) {
  const row = { group_id: groupId, data: structuredClone(data), updated_by: me?.id ?? null, updated_at: new Date().toISOString() };
  const i = db.boards.findIndex(b => b.group_id === groupId);
  if (i < 0) db.boards.push(row); else db.boards[i] = row;   // samma array: uppslagen i app.js ser ändringen direkt
  persist();
  return row;
}

export function saveTemplate(t, me) {
  const row = { ...t, id: `tpl-${Date.now().toString(36)}`, created_by: me?.id ?? null, created_at: new Date().toISOString() };
  db.templates.push(row);
  persist();
  return row;
}

export function deleteTemplate(id) {
  const i = db.templates.findIndex(t => t.id === id);
  if (i >= 0) db.templates.splice(i, 1);
  persist();
}

/* ---------- egen profil ----------
   Byter man namn följer det med på assignment-tavlorna: spelarplatser, compen och namn i rutorna. */
export function saveProfile(id, { character, cls }) {
  const m = db.members.find(x => x.id === id);
  if (!m) return null;
  const old = m.character;
  m.character = character;
  m.class = cls;
  if (old.toLowerCase() !== character.toLowerCase()) {
    const same = n => String(n ?? "").toLowerCase() === old.toLowerCase();
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${old.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "giu");
    for (const b of db.boards) {
      (b.data.roster ?? []).forEach(p => { if (same(p.name)) p.name = character; });
      (b.data.raids ?? []).forEach(r => {
        r.sections.forEach(s => s.rows.forEach(row => { if (same(row.player)) row.player = character; }));
        Object.values(r.cells).forEach(cells => Object.keys(cells).forEach(k => { cells[k] = cells[k].replace(re, character); }));
      });
    }
  }
  persist();
  return m;
}
