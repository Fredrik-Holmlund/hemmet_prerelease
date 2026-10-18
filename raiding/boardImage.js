/* Assignment-tavlan som bild till Discord. Ritas på en canvas i dubbel upplösning, med samma utseende som på sidan:
   spelets Group Finder-panel (äventyrarna på klippan, svart kant, guldlinje, mörka listrader), bossporträtt,
   raidmarkeringar, spelarcellen helt i klassfärg och HEMMET-loggan.

   boardImage({ title, subtitle, columns, sections, tokens, footer }) → <canvas>
     columns   [{ name, image }]                       – de bossar som ska med
     sections  [{ id, name, rows: [{ role, player, cells: [text per kolumn] }] }]
     tokens    text → delar, samma som sidan använder (cellTokens i assignments.js)
     player    i en rad: { name, color } eller null */

const SCALE = 2;
const PAD = 28, ROLE_W = 118, PLAYER_W = 150, COL_W = 150, LINE_H = 24, CELL_PAD = 8;
const F = { display: '"Cinzel", Georgia, serif', ui: '"Marcellus", Georgia, serif', body: '"Open Sans", system-ui, sans-serif' };
// samma toner som Group Finder-panelerna på sidan
const C = {
  bg: "#0c0908", head: "rgba(0,0,0,.5)", headOdd: "rgba(0,0,0,.6)", sec: "rgba(0,0,0,.55)",
  row: "rgba(10,8,7,.45)", rowAlt: "rgba(10,8,7,.68)", line: "rgba(0,0,0,.5)", goldLine: "rgba(240,210,122,.32)",
  bone: "#f4ede4", ash: "#c9bfb5", muted: "#b9ab94", faint: "#8a7d68", gold: "#f0d27a",
};
const SECTION_COLORS = { tanks: "#7ea6f2", healers: "#f4ede4", ranged: "#a99cf0", melee: "#e5a06a" };

const rgba = (hex, a) => {
  let h = String(hex || "#c9bfb5").replace("#", "");
  if (h.length === 3) h = h.split("").map(x => x + x).join("");
  const n = parseInt(h, 16);
  return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
};
const textOn = hex => {
  let h = String(hex || "#c9bfb5").replace("#", "");
  if (h.length === 3) h = h.split("").map(x => x + x).join("");
  const n = parseInt(h, 16);
  const [r, gr, b] = [n >> 16 & 255, n >> 8 & 255, n & 255].map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; });
  return .2126 * r + .7152 * gr + .0722 * b > .18 ? "#0b0f1a" : "#ffffff";
};
const loadImg = src => new Promise(res => {
  if (!src) return res(null);
  const i = new Image();
  i.onload = () => res(i);
  i.onerror = () => res(null);
  i.src = src;
});

export async function boardImage({ title, subtitle, columns, sections, tokens, footer }) {
  await Promise.all([`600 26px ${F.display}`, `400 14px ${F.ui}`, `400 13px ${F.body}`, `600 13px ${F.body}`, `600 11px ${F.body}`]
    .map(f => document.fonts.load(f).catch(() => null)));
  const markers = {};
  for (const k of ["star", "circle", "diamond", "triangle", "moon", "square", "cross", "skull"]) markers[k] = loadImg(`assets/markers/${k}.png`);
  const [logo, panelArt, ...bosses] = await Promise.all([loadImg("assets/logo.webp"), loadImg("assets/lfg-panel.webp"), ...columns.map(c => loadImg(c.image))]);
  for (const k in markers) markers[k] = await markers[k];

  const canvas = document.createElement("canvas");
  const g = canvas.getContext("2d");
  const font = f => { g.font = f; };
  const textW = (s, f) => { font(f); return g.measureText(s).width; };

  // ---------- mått ----------
  const tokenW = x => x.t === "sp" ? textW(" ", `400 13px ${F.body}`)
    : x.t === "text" ? textW(x.v, `400 13px ${F.body}`)
    : x.t === "mk" ? 20
    : x.t === "chip" ? textW(x.player.name, `600 13px ${F.body}`) + 18
    : textW(x.role, `600 11px ${F.body}`) + 13 + textW(x.player?.name ?? "-", `600 13px ${F.body}`) + 18;
  const layout = (toks, maxW) => {
    const lines = [[]];
    let w = 0;
    for (const x of toks) {
      const tw = tokenW(x);
      if (x.t === "sp" && !lines.at(-1).length) continue;
      if (w + tw > maxW && lines.at(-1).length) { lines.push([]); w = 0; if (x.t === "sp") continue; }
      lines.at(-1).push({ x, w: tw });
      w += tw;
    }
    return lines.filter(l => l.length).map(l => {
      while (l.length && l.at(-1).x.t === "sp") l.pop();
      return { items: l, w: l.reduce((s, i) => s + i.w, 0) };
    });
  };
  const wrapName = (s, maxW) => {   // bossnamn på högst två rader
    const words = s.split(" "), lines = [""];
    for (const w of words) {
      const next = lines.at(-1) ? `${lines.at(-1)} ${w}` : w;
      if (textW(next, `400 14px ${F.ui}`) > maxW && lines.at(-1)) lines.push(w); else lines[lines.length - 1] = next;
    }
    return lines.length > 2 ? [lines[0], `${lines.slice(1).join(" ")}`] : lines;
  };

  const width = PAD * 2 + ROLE_W + PLAYER_W + columns.length * COL_W;
  const TITLE_H = 74;
  const colNames = columns.map(c => wrapName(c.name, COL_W - 16));
  const hasImg = bosses.some(Boolean);
  const HEAD_H = 14 + Math.max(1, ...colNames.map(l => l.length)) * 18 + (hasImg ? 54 : 6);
  const SEC_H = 30;
  const laid = sections.map(s => ({ ...s, rows: s.rows.map(r => {
    const cells = r.cells.map(t => layout(tokens(t), COL_W - CELL_PAD * 2));
    const h = Math.max(34, Math.max(1, ...cells.map(c => c.length)) * LINE_H + 10);
    return { ...r, cells, h };
  }) }));
  const bodyH = laid.reduce((s, sec) => s + SEC_H + sec.rows.reduce((t, r) => t + r.h, 0), 0);
  const height = PAD + TITLE_H + HEAD_H + bodyH + 38;

  canvas.width = width * SCALE;
  canvas.height = height * SCALE;
  g.scale(SCALE, SCALE);
  g.textBaseline = "middle";

  // ---------- bakgrund och rubrik ----------
  g.fillStyle = C.bg;
  g.fillRect(0, 0, width, height);
  let x0 = PAD;
  if (logo) { const h = 44, w = logo.width * h / logo.height; g.drawImage(logo, PAD, PAD + 2, w, h); x0 += w + 14; }
  g.shadowColor = "#000"; g.shadowBlur = 4; g.shadowOffsetY = 1;
  font(`600 26px ${F.display}`); g.fillStyle = C.gold; g.textAlign = "left";
  g.fillText(title.toUpperCase(), x0, PAD + 16);
  g.shadowBlur = 0; g.shadowOffsetY = 0;
  font(`400 13px ${F.body}`); g.fillStyle = C.muted;
  g.fillText(subtitle, x0, PAD + 40);

  // ---------- panelen bakom tabellen: spelets Group Finder-bild, mörkad nedåt ----------
  const top = PAD + TITLE_H;
  const tableW = width - PAD * 2;
  const tableH = HEAD_H + bodyH;
  g.save();
  g.beginPath(); g.roundRect(PAD, top, tableW, tableH, 6); g.clip();
  if (panelArt) {
    const sc = Math.max(tableW / panelArt.width, tableH / panelArt.height);
    const iw = panelArt.width * sc, ih = panelArt.height * sc;
    g.drawImage(panelArt, PAD + (tableW - iw) / 2, top + (tableH - ih) * .3, iw, ih);
  }
  const shade = g.createLinearGradient(0, top, 0, top + tableH);
  shade.addColorStop(0, "rgba(12,9,8,.3)"); shade.addColorStop(1, "rgba(12,9,8,.8)");
  g.fillStyle = shade; g.fillRect(PAD, top, tableW, tableH);

  // ---------- tabellens huvud ----------
  g.fillStyle = C.head;
  g.fillRect(PAD, top, tableW, HEAD_H);
  font(`400 11px ${F.ui}`); g.fillStyle = C.muted;
  g.fillText("ROLL", PAD + 10, top + HEAD_H / 2);
  g.fillText("SPELARE", PAD + ROLE_W + 10, top + HEAD_H / 2);
  columns.forEach((c, i) => {
    const cx = PAD + ROLE_W + PLAYER_W + i * COL_W;
    if (i % 2 === 0) { g.fillStyle = "rgba(0,0,0,.12)"; g.fillRect(cx, top, COL_W, HEAD_H); }
    font(`400 14px ${F.ui}`); g.fillStyle = C.gold; g.textAlign = "center";
    colNames[i].forEach((l, j) => g.fillText(l, cx + COL_W / 2, top + 16 + j * 18));
    const img = bosses[i];
    if (img) {
      const ih = 48, iw = Math.min(96, img.width * ih / img.height);
      g.drawImage(img, cx + (COL_W - iw) / 2, top + HEAD_H - ih - 6, iw, ih);
    }
    g.textAlign = "left";
  });

  // ---------- rader ----------
  const chip = (x, y, name, color, label, solid = false) => {
    const lw = label ? textW(label, `600 11px ${F.body}`) + 13 : 0;
    const w = solid ? PLAYER_W - 16 : textW(name, `600 13px ${F.body}`) + 18 + lw;
    g.beginPath(); g.roundRect(x, y - 10, w, 20, solid ? 4 : 10);
    if (solid) {
      g.fillStyle = color; g.fill();
      font(`700 13px ${F.body}`); g.fillStyle = textOn(color); g.fillText(name, x + 8, y + .5);
      return w;
    }
    g.fillStyle = rgba(color, .13); g.fill();
    g.strokeStyle = rgba(color, .45); g.lineWidth = 1; g.stroke();
    let tx = x + 9;
    if (label) {
      font(`600 11px ${F.body}`); g.fillStyle = rgba(color, .8); g.fillText(label, tx, y + .5);
      tx += lw - 6;
      g.fillStyle = rgba(color, .35); g.fillRect(tx - 5, y - 6, 1, 12);
    }
    font(`600 13px ${F.body}`); g.fillStyle = color; g.fillText(name, tx, y + .5);
    return w;
  };
  const drawToken = (it, x, y) => {
    const t = it.x;
    if (t.t === "text") { font(`400 13px ${F.body}`); g.fillStyle = C.ash; g.fillText(t.v, x, y + .5); }
    else if (t.t === "mk") { const m = markers[t.k]; if (m) g.drawImage(m, x + 1, y - 9, 18, 18); }
    else if (t.t === "chip") chip(x, y, t.player.name, t.player.color);
    else if (t.t === "role") chip(x, y, t.player?.name ?? "-", t.player?.color ?? "#8a8178", t.role);
  };

  let y = top + HEAD_H;
  for (const sec of laid) {
    const accent = SECTION_COLORS[sec.id] ?? C.bone;
    g.fillStyle = C.sec; g.fillRect(PAD, y, tableW, SEC_H);
    g.fillStyle = accent; g.fillRect(PAD, y, 3, SEC_H);
    font(`400 13px ${F.ui}`); g.fillStyle = accent;
    g.fillText(sec.name.toUpperCase(), PAD + 14, y + SEC_H / 2);
    y += SEC_H;
    sec.rows.forEach((r, ri) => {
      g.fillStyle = ri % 2 ? C.rowAlt : C.row; g.fillRect(PAD, y, tableW, r.h);
      const mid = y + r.h / 2;
      font(`400 13px ${F.body}`); g.fillStyle = C.ash;
      g.fillText(r.role, PAD + 10, mid);
      if (r.player) {   // hela cellen i klassfärgen, som på sidan
        g.fillStyle = r.player.color; g.fillRect(PAD + ROLE_W, y, PLAYER_W, r.h - 1);
        font(`700 13px ${F.body}`); g.fillStyle = textOn(r.player.color); g.fillText(r.player.name, PAD + ROLE_W + 10, mid + .5);
      }
      else { g.fillStyle = C.faint; g.fillText("-", PAD + ROLE_W + 10, mid); }
      r.cells.forEach((lines, i) => {
        const cx = PAD + ROLE_W + PLAYER_W + i * COL_W;
        const y0 = mid - (lines.length - 1) * LINE_H / 2;
        lines.forEach((l, li) => {
          let x = cx + (COL_W - l.w) / 2;
          for (const it of l.items) { drawToken(it, x, y0 + li * LINE_H); x += it.w; }
        });
      });
      g.fillStyle = C.line; g.fillRect(PAD, y + r.h - 1, tableW, 1);
      y += r.h;
    });
  }
  // lodräta linjer
  g.fillStyle = C.line;
  [ROLE_W, ROLE_W + PLAYER_W, ...columns.map((_, i) => ROLE_W + PLAYER_W + (i + 1) * COL_W)].slice(0, -1)
    .forEach(dx => g.fillRect(PAD + dx, top, 1, y - top));
  g.restore();
  g.beginPath(); g.roundRect(PAD + .5, top + .5, tableW - 1, y - top - 1, 6);
  g.strokeStyle = "#000"; g.lineWidth = 1; g.stroke();
  g.beginPath(); g.roundRect(PAD + 1.5, top + 1.5, tableW - 3, y - top - 3, 5);
  g.strokeStyle = C.goldLine; g.stroke();

  // ---------- fot ----------
  font(`400 12px ${F.body}`); g.fillStyle = C.faint; g.textAlign = "right";
  g.fillText(footer, width - PAD, y + 20);
  g.textAlign = "left";
  return canvas;
}
