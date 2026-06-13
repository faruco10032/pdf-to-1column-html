// converter.js — 論文PDFを1カラムHTMLに変換するパイプライン (pdf2html.py のJS移植)
//
// PyMuPDF版との主な違い:
// - ブロック/行構造はPDF.jsのtextContentアイテムから自前で再構築する
// - 図領域は「ページをCanvasに描画 → テキスト矩形を消去 → 残ったインクの
//   連結成分」として検出する (cluster_drawings相当)

// ---------------------------------------------------------------- 定数 (Python版と同値)

const MARGIN_ZONE = 80;  // ACMはヘッダーがy≈62と深い位置にあるため広めにとる
const FIG_MIN_AREA = 500;
const FIG_MAX_PAGE_FRAC = 0.92;
const TEXT_IN_FIG_FRAC = 0.6;
const MATH_DENSITY = 0.25;
const LINE_MATH_FRAC = 0.5;
const FIG_SCALE = 1.6;
const MATH_SCALE = 1.3;
const RENDER_DPI = 200;

const MATH_FONT_RE = /CMMI|CMSY|CMEX|CMBSY|MSAM|MSBM|RSFS|EUFM|EUSM|EUEX|StandardSym|Symbol|MathItalic|MTMI|MTSY|TXMI|TXSY/i;
const BOLD_FONT_RE = /bold|black|heavy|semibold|cmbx|-medi/i;
const ITALIC_FONT_RE = /italic|oblique|cmti|-ital/i;
const CAPTION_RE = /^\s*(Figure|Fig\.?|Table|TABLE|Algorithm|Listing|図|表)\s*\.?\s*\d+/i;
const SECTION_NUM_RE = /^(\d+(\.\d+)*\.?|[A-Z](\.\d+)+)\s+\S/;
const ROMAN_HEAD_RE = /^[IVXLCDM]+\.\s+[A-Z]/;
const ALPHA_HEAD_RE = /^[A-Z]\.\s+[A-Z]/;
const JOURNAL_HEAD_RE = /\bVOL\.\s*\d+|\bNO\.\s*\d+|^(IEEE|PROCEEDINGS OF)\b/i;
const PAGE_NUM_RE = /^\s*(page\s*)?\d{1,4}\s*$/i;
const SENT_END_RE = /[.!?:;]["”)\]]*\s*$/;
const REFS_HEAD_RE = /^(?:[IVXLCDM]+\.\s*|\d+\.?\s*)?(References|Bibliography|REFERENCES|参考文献|引用文献)$/;
const CJK_RE = /[぀-ヿ一-鿿]/;
// 番号付き見出し ("1 INTRODUCTION", "3.2 Synjet ...", "3. 実験")。
// 英文は番号の後が大文字 ("2 mm nozzle" を弾く)。
// 和文は番号にピリオドがある ("3. 実験") か多階層 ("2.1 実装") に限る
// ("3 の LED1 を..." のような数字始まりの本文行を弾く)
const NUM_HEAD_LAT_RE = /^\d+(\.\d+)*\.?\s+(?=[A-Z])/;
const NUM_HEAD_CJK_RE = /^(?:\d+(\.\d+)*[.．]|\d+(\.\d+)+)\s*(?=[぀-ヿ一-鿿])/;
const isNumHead = (t) => NUM_HEAD_LAT_RE.test(t) || NUM_HEAD_CJK_RE.test(t);
const CITE_RE = /\[(\s*\d{1,3}(?:\s*[,;–—-]\s*\d{1,3})*\s*)\]/g;
const MATH_CHARS = new Set(
  "∈∉≤≥≠≈∼≃≅×−±∓∑∏∫√∂∇∞∝∘·∧∨∩∪⊂⊃⊆⊇⊕⊗←→↔⇒⇔↦" +
  "αβγδεζηθικλμνξπρςστυφχψω" + "ΓΔΘΛΞΠΣΥΦΨΩ");

// ---------------------------------------------------------------- 矩形ユーティリティ

const rect = (x0, y0, x1, y1) => ({ x0, y0, x1, y1 });
const rW = (r) => Math.max(0, r.x1 - r.x0);
const rH = (r) => Math.max(0, r.y1 - r.y0);
const rArea = (r) => rW(r) * rH(r);
const rUnion = (a, b) => rect(Math.min(a.x0, b.x0), Math.min(a.y0, b.y0),
                              Math.max(a.x1, b.x1), Math.max(a.y1, b.y1));
const rIntersectArea = (a, b) => {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return w > 0 && h > 0 ? w * h : 0;
};
const overlapFrac = (inner, outer) =>
  rArea(inner) > 0 ? rIntersectArea(inner, outer) / rArea(inner) : 0;
const rGrow = (r, gx, gy) => rect(r.x0 - gx, r.y0 - gy, r.x1 + gx, r.y1 + gy);
const rIntersects = (a, b) =>
  a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

// a と b を結合すると、どちらにも属していなかった保護テキスト(本文・キャプション・
// 見出し)を新たに飲み込んでしまうか
function swallowsText(a, b, protectedRects) {
  const u = rUnion(a, b);
  for (const p of protectedRects) {
    if (overlapFrac(p, u) > 0.5 &&
        overlapFrac(p, a) < 0.5 && overlapFrac(p, b) < 0.5) return true;
  }
  return false;
}

function mergeRects(rects, xGap = 25, yGap = 12, protectedRects = []) {
  let list = rects.map((r) => ({ ...r }));
  let changed = true;
  while (changed) {
    changed = false;
    const out = [];
    for (const r of list) {
      const grown = rGrow(r, xGap, yGap);
      let merged = false;
      for (let i = 0; i < out.length; i++) {
        if (rIntersects(grown, out[i]) && !swallowsText(r, out[i], protectedRects)) {
          out[i] = rUnion(out[i], r);
          changed = true;
          merged = true;
          break;
        }
      }
      if (!merged) out.push(r);
    }
    list = out;
  }
  return list;
}

// ---------------------------------------------------------------- テキスト処理

const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const normText = (s) => s.replace(/ /g, " ").replace(/­/g, "-")
  .replace(/ﬀ/g, "ff").replace(/ﬁ/g, "fi").replace(/ﬂ/g, "fl")
  .replace(/ﬃ/g, "ffi").replace(/ﬄ/g, "ffl");

// スモールキャップス見出しの分断 ("I NTRODUCTION" / "R EFERENCES") を
// 見出しパターン照合用に正規化する
const normHeading = (s) =>
  s.replace(/\b([A-Z]) (?=[A-Z]{2,}\b)/g, "$1").replace(/\s{2,}/g, " ").trim();

function spanIsMath(sp) {
  if (MATH_FONT_RE.test(sp.font)) return true;
  const t = sp.text.trim();
  if (!t) return false;
  if (t.includes("�")) return true;  // ToUnicode破損フォントは画像化で見た目を保つ
  let n = 0;
  for (const c of t) if (MATH_CHARS.has(c)) n++;
  return n / t.length > 0.5;
}

// ---------------------------------------------------------------- パスA: ページのテキスト構造化

async function extractPage(page) {
  await page.getOperatorList(); // フォント実名の解決に必要 (描画時に再利用される)
  const tc = await page.getTextContent();
  const vp = page.getViewport({ scale: 1 });
  const pageRect = rect(0, 0, vp.width, vp.height);

  // アイテム → スパン (実フォント名・上原点座標つき)
  const spans = [];
  for (const it of tc.items) {
    if (!it.str || !it.str.length) continue;
    const tx = it.transform;
    const size = Math.hypot(tx[2], tx[3]) || Math.hypot(tx[0], tx[1]);
    const [, vy] = vp.convertToViewportPoint(tx[4], tx[5]);
    const angle = Math.atan2(tx[1], tx[0]);
    const st = tc.styles[it.fontName] || {};
    const asc = st.ascent || 0.8;
    const desc = st.descent || -0.2;
    let font = "";
    try {
      if (page.commonObjs.has(it.fontName)) {
        font = page.commonObjs.get(it.fontName)?.name || "";
      }
    } catch (e) { /* 未解決フォントは無視 */ }
    // 回転テキスト(arXivスタンプ等)でも正しい矩形になるよう、
    // ベースライン方向±アセント/ディセントの4隅をPDF空間で求めて変換する
    const cos = Math.cos(angle), sin = Math.sin(angle);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const u of [0, it.width]) {
      for (const v of [desc * size, asc * size]) {
        const [px, py] = vp.convertToViewportPoint(
          tx[4] + u * cos - v * sin, tx[5] + u * sin + v * cos);
        if (px < x0) x0 = px;
        if (px > x1) x1 = px;
        if (py < y0) y0 = py;
        if (py > y1) y1 = py;
      }
    }
    spans.push({
      text: normText(it.str),
      font, size,
      bold: BOLD_FONT_RE.test(font),
      italic: ITALIC_FONT_RE.test(font),
      rotated: Math.abs(angle) > 0.3,
      baseY: vy,
      rect: rect(x0, y0, x1, y1),
    });
  }

  // 行番号 (bioRxiv等: 同一x位置に昇順で並ぶ整数スパン) を除去する
  const numCols = new Map();
  for (const sp of spans) {
    const t = sp.text.trim();
    if (/^\d{1,4}$/.test(t)) {
      const key = Math.round(sp.rect.x0 / 6);
      if (!numCols.has(key)) numCols.set(key, []);
      numCols.get(key).push(sp);
    }
  }
  for (const col of numCols.values()) {
    if (col.length < 6) continue;
    col.sort((a, b) => a.rect.y0 - b.rect.y0);
    const vals = col.map((sp) => parseInt(sp.text, 10));
    let inc = 0;
    for (let i = 1; i < vals.length; i++) if (vals[i] === vals[i - 1] + 1) inc++;
    if (inc >= (vals.length - 1) * 0.7) for (const sp of col) sp.text = "";
  }

  // 回転スパン(arXivスタンプ等)は行クラスタリングに混ぜない。
  // 縦長の矩形が本文すべてと縦に重なり、カラム全体が1つの行に連鎖してしまう。
  const upright = spans.filter((sp) => !sp.rotated);
  const rotatedLines = spans.filter((sp) => sp.rotated)
    .map((sp) => makeLine([sp]));

  // スパン → 行: 矩形の縦方向の重なりでクラスタリング
  // (上付き文字はベースラインがずれるが矩形は本文行と重なるので同じ行になる)
  upright.sort((a, b) => a.rect.y0 - b.rect.y0 || a.rect.x0 - b.rect.x0);
  const clusters = [];
  for (const sp of upright) {
    let best = null;
    for (const cl of clusters) {
      const ov = Math.min(cl.y1, sp.rect.y1) - Math.max(cl.y0, sp.rect.y0);
      if (ov >= 0.45 * Math.min(rH(sp.rect), cl.y1 - cl.y0)) {
        if (!best || ov > best.ov) best = { cl, ov };
      }
    }
    if (best) {
      best.cl.spans.push(sp);
      best.cl.y0 = Math.min(best.cl.y0, sp.rect.y0);
      best.cl.y1 = Math.max(best.cl.y1, sp.rect.y1);
    } else {
      clusters.push({ y0: sp.rect.y0, y1: sp.rect.y1, spans: [sp] });
    }
  }

  // 行クラスタ → 行セグメント: 大きな水平ギャップで分割。
  // ページ中央線をまたぐギャップはカラム境界なので、狭くても(>4pt)分割する
  // (IEEEはカラム間隙が10pt程度しかなく、左右の行が融合してしまうため)
  const mid = (pageRect.x0 + pageRect.x1) / 2;
  const lines = [];
  for (const cl of clusters) {
    cl.spans.sort((a, b) => a.rect.x0 - b.rect.x0);
    let cur = [];
    for (const sp of cl.spans) {
      const prev = cur[cur.length - 1];
      if (prev) {
        const gap = sp.rect.x0 - prev.rect.x1;
        const crossesMid = prev.rect.x1 <= mid && sp.rect.x0 >= mid;
        if ((crossesMid && gap > 4) || gap > Math.max(12, prev.size * 2)) {
          lines.push(makeLine(cur));
          cur = [];
        }
      }
      cur.push(sp);
    }
    if (cur.length) lines.push(makeLine(cur));
  }
  lines.push(...rotatedLines);

  // 見出しパターンの行はスタイルが本文と同じでも独立ブロックにする
  // (IEEEのイタリック節見出しやスモールキャップス見出しが本文に融合するのを防ぐ)
  const isHeadingLine = (ln) => {
    const t = normHeading(ln.text);
    if (!t || t.length > 90 || SENT_END_RE.test(t)) return false;
    if (/[,]/.test(t)) return false;  // 著者名リスト等 ("A. Bicchi, ...") を除外
    const periods = (t.match(/\./g) || []).length;
    // 節見出しはピリオド1個だけ ("A. Method")。複数あるのは文献の著者名
    // ("C. M. Bishop. Neural ...") なので除外
    if (ROMAN_HEAD_RE.test(t) && periods === 1) return true;
    if (ALPHA_HEAD_RE.test(t) && t.split(/\s+/).length < 12 && periods === 1) return true;
    const letters = t.replace(/[^A-Za-z]/g, "");
    if (isNumHead(t) && t.split(/\s+/).length < 10 &&
        (letters.length >= 3 || CJK_RE.test(t))) return true;
    return /^[A-Z]{6,}$/.test(t.replace(/\s+/g, "")) && t.length < 40;
  };

  // 行 → ブロック: 縦の近接 + 横範囲の重なりで貪欲にまとめる
  lines.sort((a, b) => a.rect.y0 - b.rect.y0 || a.rect.x0 - b.rect.x0);
  const blocks = [];
  for (const ln of lines) {
    if (isHeadingLine(ln)) {
      blocks.push({ lines: [ln], rect: { ...ln.rect }, forced: true });
      continue;
    }
    let best = null;
    for (const bl of blocks) {
      if (bl.forced) continue;
      const last = bl.lines[bl.lines.length - 1];
      const gap = ln.baseY - last.baseY;
      if (gap <= 0.5 || gap > 1.7 * Math.max(ln.size, last.size)) continue;
      const xov = Math.min(bl.rect.x1, ln.rect.x1) - Math.max(bl.rect.x0, ln.rect.x0);
      if (xov < 0.3 * Math.min(rW(bl.rect), rW(ln.rect))) continue;
      // スタイル境界: サイズ・太字・イタリックが変わる行(見出し⇔本文)は
      // 同じブロックにしない
      if (Math.abs(ln.size - last.size) > 0.8) continue;
      if ((ln.boldFrac > 0.7) !== (last.boldFrac > 0.7)) continue;
      if ((ln.italFrac > 0.7) !== (last.italFrac > 0.7)) continue;
      if (!best || xov > best.xov) best = { bl, xov };
    }
    if (best) {
      best.bl.lines.push(ln);
      best.bl.rect = rUnion(best.bl.rect, ln.rect);
    } else {
      blocks.push({ lines: [ln], rect: { ...ln.rect } });
    }
  }
  for (const bl of blocks) finishBlock(bl);
  return { pageRect, blocks, allLineRects: lines.map((l) => l.rect) };
}

function makeLine(spans) {
  let r = { ...spans[0].rect };
  for (const sp of spans) r = rUnion(r, sp.rect);
  // スパン間の隙間に空白を補う。ただしスモールキャップス
  // (大きい頭文字 + 小さい大文字の続き, 例 "I"+"NTRODUCTION") は隙間でも結合する
  let text = "";
  let prev = null;
  for (const sp of spans) {
    const smallCaps = prev && /[A-Z]$/.test(prev.text) && /^[A-Z]/.test(sp.text) &&
      sp.size < prev.size * 0.9;
    if (prev && !smallCaps && sp.rect.x0 - prev.rect.x1 > 0.18 * prev.size &&
        !text.endsWith(" ") && !sp.text.startsWith(" ")) text += " ";
    text += sp.text;
    prev = sp;
  }
  const sizes = spans.map((s) => s.size);
  const baseYs = spans.map((s) => s.baseY);
  let boldN = 0, italN = 0, total = 0;
  for (const sp of spans) {
    const n = sp.text.trim().length;
    total += n;
    if (sp.bold) boldN += n;
    if (sp.italic) italN += n;
  }
  return {
    spans, rect: r, text: text.trim(),
    size: median(sizes), baseY: median(baseYs),
    boldFrac: total ? boldN / total : 0,
    italFrac: total ? italN / total : 0,
  };
}

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

function finishBlock(bl) {
  const sizeCount = new Map();
  let boldN = 0, mathN = 0, total = 0, rotN = 0, allN = 0;
  for (const ln of bl.lines) {
    for (const sp of ln.spans) {
      const n = sp.text.trim().length;
      allN++;
      if (sp.rotated) rotN++;
      if (!n) continue;
      const key = Math.round(sp.size * 10) / 10;
      sizeCount.set(key, (sizeCount.get(key) || 0) + n);
      total += n;
      if (sp.bold) boldN += n;
      if (spanIsMath(sp)) mathN += n;
    }
  }
  let dom = 0, max = -1;
  for (const [k, v] of sizeCount) if (v > max) { max = v; dom = k; }
  bl.domSize = dom;
  bl.boldFrac = total ? boldN / total : 0;
  bl.mathFrac = total ? mathN / total : 0;
  bl.rotated = allN > 0 && rotN / allN > 0.5;
  // 行末ハイフネーションを結合した平文
  const parts = [];
  for (const ln of bl.lines) {
    const t = ln.text;
    if (!t) continue;
    if (parts.length && parts[parts.length - 1].endsWith("-") && /^[a-z]/.test(t)) {
      parts[parts.length - 1] = parts[parts.length - 1].slice(0, -1) + t;
    } else {
      parts.push(t);
    }
  }
  bl.plain = parts.join(" ");
}

// ---------------------------------------------------------------- 合字損傷の修復

// acmart旧版 (Linux Libertine) のTh合字バグ等で潰れた単語の修復テーブル (機能語)
const LIG_FIX_WORDS = {
  Te: "The", Tis: "This", Tat: "That", Tese: "These", Tose: "Those",
  Tey: "They", Teir: "Their", Tere: "There", Terefore: "Therefore",
  Tus: "Thus", Tough: "Though", Trough: "Through",
};

// ToUnicode破損で合字が潰れた単語を修復 ("Te"→"The", "Termal"→"Thermal")。
// "The"が皆無で"Te"が複数 → Th合字バグと判断。機能語テーブルと
// 「文書内に健全な形が存在する単語」のみ直す ("Taiwan"等は変更しない)
function repairLigatureDamage(pages) {
  const words = new Map();
  for (const pg of pages) {
    for (const bl of pg.blocks) {
      for (const w of bl.plain.match(/[A-Za-z]+/g) || []) {
        words.set(w, (words.get(w) || 0) + 1);
      }
    }
  }
  if ((words.get("The") || 0) > 0 || (words.get("Te") || 0) < 2) return 0;
  const corpus = new Set([...words.keys()].map((w) => w.toLowerCase()));
  const repair = new Map();
  for (const [k, v] of Object.entries(LIG_FIX_WORDS)) {
    if (words.has(k)) repair.set(k, v);
  }
  for (const w of words.keys()) {
    if (repair.has(w) || w.length < 3) continue;
    const cands = new Set();
    if (w[0] === "T" && corpus.has("th" + w.slice(1).toLowerCase())) {
      cands.add("Th" + w.slice(1));
    }
    for (let i = 0; i < w.length; i++) {
      const ch = w[i];
      if ("tfl".includes(ch)) {            // 重ね文字の潰れ (tt/ff/ll)
        const v = w.slice(0, i) + ch + w.slice(i);
        if (corpus.has(v.toLowerCase())) cands.add(v);
      }
      if (ch === "t") {                    // 語中の th の潰れ
        const v = w.slice(0, i + 1) + "h" + w.slice(i + 1);
        if (corpus.has(v.toLowerCase())) cands.add(v);
      }
    }
    if (cands.size === 1) repair.set(w, [...cands][0]);
  }
  if (!repair.size) return 0;
  const keys = [...repair.keys()].sort((a, b) => b.length - a.length)
    .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pat = new RegExp("\\b(" + keys.join("|") + ")\\b", "g");
  const fix = (s) => s.replace(pat, (m) => repair.get(m) || m);
  let n = 0;
  for (const pg of pages) {
    for (const bl of pg.blocks) {
      for (const ln of bl.lines) {
        for (const sp of ln.spans) {
          const t = fix(sp.text);
          if (t !== sp.text) { sp.text = t; n++; }
        }
        ln.text = fix(ln.text);
      }
      bl.plain = fix(bl.plain);
    }
  }
  return n;
}

// ---------------------------------------------------------------- ヘッダー/フッター

const marginKey = (t) => t.trim().toLowerCase().replace(/\d+/g, "#").slice(0, 80);

function collectRepeatedMargins(pages) {
  const counts = new Map();
  for (const pg of pages) {
    const seen = new Set();
    for (const bl of pg.blocks) {
      const cy = (bl.rect.y0 + bl.rect.y1) / 2;
      if (cy < MARGIN_ZONE || cy > pg.pageRect.y1 - MARGIN_ZONE) {
        const k = marginKey(bl.plain);
        if (k && !seen.has(k)) {
          counts.set(k, (counts.get(k) || 0) + 1);
          seen.add(k);
        }
      }
    }
  }
  const thresh = Math.max(2, Math.round(pages.length * 0.3));
  const out = new Set();
  for (const [k, c] of counts) if (c >= thresh) out.add(k);
  return out;
}

function isMarginJunk(bl, pageRect, repeated) {
  const cy = (bl.rect.y0 + bl.rect.y1) / 2;
  if (cy >= MARGIN_ZONE && cy <= pageRect.y1 - MARGIN_ZONE) return false;
  const t = bl.plain;
  if (PAGE_NUM_RE.test(t)) return true;
  if (t.toLowerCase().startsWith("arxiv:")) return true;
  if (JOURNAL_HEAD_RE.test(t)) return true;
  return repeated.has(marginKey(t));
}

// ---------------------------------------------------------------- 図領域 (インク連結成分)

const CELL = 4; // 連結成分解析のセルサイズ (デバイスpx)

function detectInkRects(canvas, ctx, scale, eraseRects, pageRect) {
  const W = canvas.width, H = canvas.height;
  const gw = Math.ceil(W / CELL), gh = Math.ceil(H / CELL);
  const grid = new Uint8Array(gw * gh);
  const img = ctx.getImageData(0, 0, W, H).data;
  for (let y = 0; y < H; y++) {
    const rowOff = y * W;
    const gy = (y / CELL) | 0;
    for (let x = 0; x < W; x++) {
      const i = (rowOff + x) * 4;
      if (img[i] < 245 || img[i + 1] < 245 || img[i + 2] < 245) {
        grid[gy * gw + ((x / CELL) | 0)] = 1;
      }
    }
  }
  // テキスト行の矩形を消去。ascent/descentの推定誤差でグリフの端が
  // インクとして残ると行ピッチごとの筋が連鎖結合してしまうため、
  // 縦方向は広め( ±3pt )に消す。
  for (const r of eraseRects) {
    const x0 = Math.max(0, (((r.x0 - 2) * scale) / CELL) | 0);
    const y0 = Math.max(0, (((r.y0 - 3) * scale) / CELL) | 0);
    const x1 = Math.min(gw - 1, Math.ceil(((r.x1 + 2) * scale) / CELL));
    const y1 = Math.min(gh - 1, Math.ceil(((r.y1 + 3) * scale) / CELL));
    for (let gy = y0; gy <= y1; gy++) grid.fill(0, gy * gw + x0, gy * gw + x1 + 1);
  }
  // BFSで連結成分のバウンディングボックスを求める
  const comps = [];
  const stack = [];
  for (let s = 0; s < grid.length; s++) {
    if (!grid[s]) continue;
    let minX = gw, minY = gh, maxX = 0, maxY = 0;
    stack.push(s);
    grid[s] = 0;
    while (stack.length) {
      const c = stack.pop();
      const cx = c % gw, cy = (c / gw) | 0;
      if (cx < minX) minX = cx;
      if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy;
      if (cy > maxY) maxY = cy;
      if (cx > 0 && grid[c - 1]) { grid[c - 1] = 0; stack.push(c - 1); }
      if (cx < gw - 1 && grid[c + 1]) { grid[c + 1] = 0; stack.push(c + 1); }
      if (cy > 0 && grid[c - gw]) { grid[c - gw] = 0; stack.push(c - gw); }
      if (cy < gh - 1 && grid[c + gw]) { grid[c + gw] = 0; stack.push(c + gw); }
    }
    const k = CELL / scale; // セル → pt
    comps.push(rect(minX * k, minY * k, (maxX + 1) * k, (maxY + 1) * k));
  }
  return comps;
}

function figureRects(comps, keptBlocks, pageRect, bodySize = 10, pageIndex = 1) {

  // 保護対象: 本文段落・キャプション・見出し級フォント・著者情報(@を含む)。
  // これらを新たに飲み込む結合・吸収は行わない
  const protectedRects = [];
  const labels = [];
  for (const b of keptBlocks) {
    if (!b.plain) continue;
    // 散文らしさ: 軸ラベル群("250 200 150 ... Frequency (Hz)")は長くても
    // 単語が少ないので保護せず、図への吸収を許す
    const longWords = (b.plain.match(/[A-Za-z]{4,}/g) || []).length;
    const cjkCount = (b.plain.match(/[぀-ヿ一-鿿]/g) || []).length;
    const isProse = (longWords >= 6 && b.plain.length >= 60) || cjkCount >= 30;
    // 保護対象は: 散文 / キャプション / 著者情報(@) / 見出しらしいブロック /
    // タイトル級の特大フォント(本文×1.4) / 文献見出し・文献エントリ行。
    // 単なる大きめフォントの図中ラベルや軸の数字列は保護しない(吸収を許す)
    const t = normHeading(b.plain);
    const letters = t.replace(/[^A-Za-z]/g, "");
    const letterFrac = letters.length / Math.max(1, t.replace(/\s/g, "").length);
    const secLike = SECTION_NUM_RE.test(t) && letters.length >= 3 && letterFrac > 0.5;
    const singleHead = t.split(/\s+/).length === 1 && t.length >= 4 &&
      /^[A-Z]/.test(t) && b.domSize >= bodySize + 1.2;
    const isHeadingish = secLike || ROMAN_HEAD_RE.test(t) || singleHead ||
      (ALPHA_HEAD_RE.test(t) && (t.match(/\./g) || []).length === 1);
    const isProtected = isProse || CAPTION_RE.test(b.plain) ||
      b.plain.includes("@") || isHeadingish || b.domSize >= bodySize * 1.4 ||
      REFS_HEAD_RE.test(t) || /^\[\d{1,3}\]\s/.test(b.plain);
    if (isProtected) protectedRects.push(b.rect);
    else if (b.plain.length < 200) labels.push(b.rect);
  }

  // 散文段落を2つ以上覆う候補は背景画像・装飾とみなして除外する
  comps = comps.filter((r) =>
    protectedRects.filter((p) => overlapFrac(p, r) > 0.6).length < 2);

  // 近接成分を結合 (罫線だけの表や点線プロットの点を先に接着する。
  // 点線の点(数pt)はここで線として繋がり、孤立した微小成分は次の面積フィルタで落ちる)
  let cand = mergeRects(comps, 8, 14, protectedRects);
  cand = cand.filter((r) => {
    if (rH(r) < 10 && rW(r) > 80) return false;       // 水平の区切り線
    if (rW(r) < 10 && rH(r) > 80) return false;       // 垂直線
    if (rArea(r) < FIG_MIN_AREA) return false;
    const cy = (r.y0 + r.y1) / 2;
    if (cy < MARGIN_ZONE || cy > pageRect.y1 - MARGIN_ZONE) return false; // ロゴ等
    return true;
  });
  let merged = mergeRects(cand, 25, 12, protectedRects);

  // 図に重なる/近接する短いラベル(軸ラベル等)を取り込む
  const firstPage = pageIndex === 0;
  let changed = true;
  while (changed && merged.length) {
    changed = false;
    for (const lb of labels) {
      for (let i = 0; i < merged.length; i++) {
        const f = merged[i];
        // 1ページ目は図の上側のラベルを取り込まない (タイトル・著者の保護)
        if (firstPage && lb.y1 <= f.y0 + 2) continue;
        const near = rGrow(f, 18, 18);
        if (overlapFrac(lb, f) > 0.25 ||
            (rIntersects(near, lb) && rArea(lb) < rArea(f) * 0.3)) {
          if (swallowsText(f, lb, protectedRects)) continue;
          const u = rUnion(f, lb);
          if (u.x0 !== f.x0 || u.y0 !== f.y0 || u.x1 !== f.x1 || u.y1 !== f.y1) {
            merged[i] = u;
            changed = true;
          }
        }
      }
    }
    if (changed) merged = mergeRects(merged, 25, 12, protectedRects);
  }
  return merged.filter((r) =>
    rArea(r) < rArea(pageRect) * FIG_MAX_PAGE_FRAC && rArea(r) >= FIG_MIN_AREA);
}

// ---------------------------------------------------------------- 数式領域

function buildMathRegions(kept, pageRect) {
  const seeds = kept
    .filter((b) => b.mathFrac >= MATH_DENSITY && b.plain.length < 120)
    .map((b) => b.rect);
  if (!seeds.length) return [];
  let regions = mergeRects(seeds, 10, 4);
  const midline = (pageRect.x0 + pageRect.x1) / 2;
  let changed = true;
  while (changed) {
    changed = false;
    for (const b of kept) {
      const r = b.rect;
      for (let i = 0; i < regions.length; i++) {
        const reg = regions[i];
        if (r.y0 >= reg.y1 - 1 || r.y1 <= reg.y0 + 1) continue;
        const gap = Math.max(reg.x0 - r.x1, r.x0 - reg.x1, 0);
        if (gap > 40) continue;
        if ((r.x0 >= midline && midline > reg.x1) ||
            (reg.x0 >= midline && midline > r.x1)) continue;
        const u = rUnion(reg, r);
        if (u.x0 !== reg.x0 || u.y0 !== reg.y0 || u.x1 !== reg.x1 || u.y1 !== reg.y1) {
          regions[i] = u;
          changed = true;
        }
      }
    }
    if (changed) regions = mergeRects(regions, 10, 4);
  }
  return regions;
}

// ---------------------------------------------------------------- 読み順

function orderItems(items, pageRect) {
  if (!items.length) return [];
  const x0 = Math.min(...items.map((i) => i.rect.x0));
  const x1 = Math.max(...items.map((i) => i.rect.x1));
  const mid = (x0 + x1) / 2;
  const full = [], cols = [];
  let fullArea = 0, totalArea = 0;
  for (const it of items) {
    totalArea += rArea(it.rect);
    if (it.rect.x0 < mid - 15 && it.rect.x1 > mid + 15) {
      full.push(it);
      fullArea += rArea(it.rect);
    } else cols.push(it);
  }
  if (totalArea > 0 && fullArea / totalArea > 0.85) {
    return [...items].sort((a, b) => a.rect.y0 - b.rect.y0 || a.rect.x0 - b.rect.x0);
  }
  full.sort((a, b) => a.rect.y0 - b.rect.y0);
  const bounds = full.map((f) => f.rect.y0);
  const bands = Array.from({ length: full.length + 1 }, () => []);
  for (const it of cols) {
    let i = 0;
    while (i < bounds.length && bounds[i] <= it.rect.y0 + 2) i++;
    bands[i].push(it);
  }
  const out = [];
  const byPos = (a, b) => a.rect.y0 - b.rect.y0 || a.rect.x0 - b.rect.x0;
  for (let i = 0; i <= full.length; i++) {
    const left = bands[i].filter((b) => (b.rect.x0 + b.rect.x1) / 2 <= mid).sort(byPos);
    const right = bands[i].filter((b) => (b.rect.x0 + b.rect.x1) / 2 > mid).sort(byPos);
    out.push(...left, ...right);
    if (i < full.length) out.push(full[i]);
  }
  return out;
}

// ---------------------------------------------------------------- 行・ブロック → HTML

function spanToHtml(sp, line) {
  let t = escapeHtml(sp.text);
  if (!t.trim()) return t;
  const sup = sp.baseY < line.baseY - 0.25 * line.size && sp.size < 0.85 * line.size;
  if (sup) return `<sup>${t}</sup>`;
  if (sp.bold) t = `<b>${t}</b>`;
  if (sp.italic) t = `<i>${t}</i>`;
  return t;
}

function lineMathFrac(line) {
  let m = 0, t = 0;
  for (const sp of line.spans) {
    const n = sp.text.trim().length;
    t += n;
    if (n && spanIsMath(sp)) m += n;
  }
  return t ? m / t : 0;
}

function inlineMathImg(spans, crop, stats) {
  let r = { ...spans[0].rect };
  for (const sp of spans) r = rUnion(r, sp.rect);
  const c = crop(r, 1.5);
  if (!c) return "";
  const h = Math.round(c.hPt * (96 / 72) * MATH_SCALE);
  stats.inlineMath++;
  return `<img class="imath" alt="math" translate="no" style="height:${h}px" src="${c.url}">`;
}

function lineToHtml(line, crop, stats) {
  const spans = line.spans.filter((sp) => sp.text);
  if (!spans.length) return "";
  if (lineMathFrac(line) >= LINE_MATH_FRAC) return inlineMathImg(spans, crop, stats);
  // 数式スパンの連続区間 (間に挟まる3文字以下は数式に取り込む)
  const runs = [];
  for (const sp of spans) {
    const m = spanIsMath(sp);
    if (runs.length && runs[runs.length - 1].math === m) {
      runs[runs.length - 1].spans.push(sp);
    } else runs.push({ math: m, spans: [sp] });
  }
  let i = 1;
  while (i < runs.length - 1) {
    const mid = runs[i].spans.map((s) => s.text).join("").trim();
    if (!runs[i].math && runs[i - 1].math && runs[i + 1].math && mid.length <= 3) {
      runs[i - 1].spans.push(...runs[i].spans, ...runs[i + 1].spans);
      runs.splice(i, 2);
    } else i++;
  }
  const parts = [];
  for (const run of runs) {
    if (run.math) parts.push(inlineMathImg(run.spans, crop, stats));
    else {
      let h = "";
      let prev = null;
      for (const sp of run.spans) {
        if (prev && sp.rect.x0 - prev.rect.x1 > 0.18 * prev.size) h += " ";
        h += spanToHtml(sp, line);
        prev = sp;
      }
      parts.push(h);
    }
  }
  return parts.join("").trim();
}

const DEHYPHEN_RE = /-((?:<\/[a-z]+>)*)\s*$/;

function blockToHtml(block, crop, stats) {
  const plainParts = [], htmlParts = [];
  for (const ln of block.lines) {
    const lp = ln.text;
    if (!lp) continue;
    const lh = lineToHtml(ln, crop, stats);
    if (plainParts.length && plainParts[plainParts.length - 1].endsWith("-") &&
        /^[a-z]/.test(lp)) {
      plainParts[plainParts.length - 1] =
        plainParts[plainParts.length - 1].slice(0, -1) + lp;
      htmlParts[htmlParts.length - 1] =
        htmlParts[htmlParts.length - 1].replace(DEHYPHEN_RE, "$1") + lh;
    } else {
      plainParts.push(lp);
      htmlParts.push(lh);
    }
  }
  return { plain: plainParts.join(" "), html: htmlParts.join(" ") };
}

// ---------------------------------------------------------------- 参考文献

function rebuildReferences(chunks) {
  let start = -1;
  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i].kind === "heading" && REFS_HEAD_RE.test(chunks[i].plain.trim())) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) {
    // フォールバック: 後方から「冒頭付近に[1]があり、以降に[2][3]..が連なる」
    // チャンクをアンカーとして探す (文献見出しがない/壊れている論文用)
    for (let i = chunks.length - 1; i >= 0; i--) {
      const c = chunks[i];
      const pos = c.plain.indexOf("[1]");
      if ((c.kind !== "body" && c.kind !== "footnote") || pos < 0 || pos > 30) continue;
      const tail = chunks.slice(i, i + 30)
        .filter((x) => x.kind === "body" || x.kind === "footnote")
        .map((x) => x.plain).join(" ");
      let seq = 1;
      for (const m of tail.matchAll(/\[(\d{1,3})\]/g)) {
        if (parseInt(m[1], 10) === seq + 1) seq++;
      }
      if (seq >= 5) { start = i; break; }
    }
    if (start < 0) return { chunks, nRefs: 0 };
  }
  // ゾーンのスキャン: 図・数式チャンクは飛ばして継続 (文献は複数ページにまたがる)
  let end = start;
  const zone = [];
  const keptFigs = [];
  while (end < chunks.length) {
    const k = chunks[end].kind;
    if (k === "body" || k === "footnote") zone.push(chunks[end]);
    else if (k === "figure" || k === "math") keptFigs.push(chunks[end]);
    else break;
    end++;
  }
  if (!zone.length) return { chunks, nRefs: 0 };
  // ページごとに繰り返されるランニングヘッダ/フッタの混入を除去
  const cnt = new Map();
  for (const c of zone) {
    const k = c.plain.slice(0, 60);
    cnt.set(k, (cnt.get(k) || 0) + 1);
  }
  const cleanZone = zone.filter((c) => cnt.get(c.plain.slice(0, 60)) < 3);

  let joined = cleanZone.map((c) => c.html).join(" ");
  joined = joined.replace(/(\w)-((?:<\/[ib]>)*) ((?:<[ib]>)*)(?=[a-z])/g, "$1$2$3");
  joined = joined.replace(/(\w)-((?:<\/[ib]>)*) ((?:<[ib]>)*)(?=[A-Z])/g, "$1-$2$3");
  joined = joined.replace(URL_WRAP_RE, "$1");  // 折り返しで分断されたDOI/URLを再結合

  const starts = [];
  let expected = 1;
  for (const m of joined.matchAll(/\[(\d{1,3})\]/g)) {
    if (parseInt(m[1], 10) === expected) {
      starts.push({ pos: m.index, n: expected });
      expected++;
    }
  }
  if (starts.length < 3) return { chunks, nRefs: 0 };

  const refs = [];
  for (let i = 0; i < starts.length; i++) {
    const e = i + 1 < starts.length ? starts[i + 1].pos : joined.length;
    refs.push({
      kind: "ref", page: zone[0].page, plain: "",
      html: joined.slice(starts[i].pos, e).trim(), level: starts[i].n,
    });
  }
  return { chunks: [...chunks.slice(0, start), ...refs, ...keptFigs, ...chunks.slice(end)],
           nRefs: refs.length };
}

// [著者 年] 形式の引用 (例: [Gugenheimer et al. 2016], [Halvey and Smith 2012])
const AY_PART_RE = /([A-Z][\w'’-]+)(?:\s+(?:et\s+al\.?|and\s+[A-Z][\w'’-]+))?\s+(\d{4}[a-z]?)/g;

// 著者-年形式の論文向け: 文献ゾーンのチャンクにアンカーを付け、
// 本文中の [著者 年] 引用をリンクにする。番号形式の再構築が失敗した場合に使う
function rebuildReferencesAuthorYear(chunks) {
  let start = -1;
  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i].kind === "heading" && REFS_HEAD_RE.test(chunks[i].plain.trim())) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return { chunks, nRefs: 0 };
  const zoneIdx = [];
  let end = start;
  while (end < chunks.length) {
    const k = chunks[end].kind;
    if (k === "body" || k === "footnote") zoneIdx.push(end);
    else if (k !== "figure" && k !== "math") break;
    end++;
  }
  if (!zoneIdx.length) return { chunks, nRefs: 0 };

  // 本文中の引用 (姓, 年) を収集
  const cites = new Set();
  for (const c of chunks.slice(0, start)) {
    if (!["body", "caption", "footnote"].includes(c.kind)) continue;
    for (const m of c.plain.matchAll(/\[([^\[\]<>]{4,120}?)\]/g)) {
      for (const part of m[1].split(";")) {
        const am = [...part.matchAll(AY_PART_RE)][0];
        if (am) cites.add(am[1] + " " + am[2]);
      }
    }
  }
  if (cites.size < 2) return { chunks, nRefs: 0 };

  // 各引用を「姓と年を両方含む」最初のゾーンチャンクに対応付ける
  const anchorOf = new Map();
  for (const key of cites) {
    const [surname, year] = key.split(" ");
    for (const zi of zoneIdx) {
      const p = chunks[zi].plain;
      if (p.includes(surname) && p.includes(year.slice(0, 4))) {
        anchorOf.set(key, zi);
        break;
      }
    }
  }
  if (!anchorOf.size) return { chunks, nRefs: 0 };

  zoneIdx.forEach((zi, n) => {
    chunks[zi].kind = "ref";
    chunks[zi].level = n + 1;
  });

  const idOf = new Map();
  for (const [key, zi] of anchorOf) idOf.set(key, chunks[zi].level);
  const linkAy = (html) =>
    html.replace(/\[([^\[\]<>]{4,120}?)\]/g, (whole, inner) =>
      "[" + inner.replace(AY_PART_RE, (pm, surname, year) => {
        const id = idOf.get(surname + " " + year);
        return id ? `<a class="cite" href="#ref-${id}">${pm}</a>` : pm;
      }) + "]");
  for (const c of chunks.slice(0, start)) {
    if (["body", "caption", "footnote"].includes(c.kind)) c.html = linkAy(c.html);
  }
  return { chunks, nRefs: zoneIdx.length };
}

const URL_LINK_RE = /https?:\/\/[^\s<>"]+/g;
// 行折り返しで分断されたURL ("https://doi.org/10.1145/ 3290605.3300233") を再結合。
// URL末尾が / . - = のとき、続くトークンに数字が含まれていればURLの続きとみなす
const URL_WRAP_RE = /(https?:\/\/[^\s<>"]+[/.=-])\s+(?=[^\s<>"]*\d)/g;

function linkifyUrls(html) {
  return html.replace(URL_LINK_RE, (m) => {
    const url = m.replace(/[.,;)\]'"]+$/, "");
    const trail = m.slice(url.length);
    return `<a class="url" href="${url}" target="_blank" rel="noopener">${url}</a>${trail}`;
  });
}

function linkCitations(html, nRefs) {
  return html.replace(CITE_RE, (whole, inner) => {
    const linked = inner.replace(/\d{1,3}/g, (d) => {
      const n = parseInt(d, 10);
      return n >= 1 && n <= nRefs
        ? `<a class="cite" href="#ref-${n}">${n}</a>` : d;
    });
    return "[" + linked + "]";
  });
}

// デバッグ用エクスポート
export { extractPage, buildMathRegions, orderItems, detectInkRects, figureRects,
         overlapFrac, isMarginJunk, collectRepeatedMargins };

// ---------------------------------------------------------------- メイン

export async function convertPdfToHtml(pdfjsLib, data, opts = {}) {
  // PDF.jsのrenderはrequestAnimationFrameでスケジュールされるため、
  // タブが非表示だと止まってしまう。変換中はsetTimeoutベースに差し替える。
  const origRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 0);
  try {
    return await convertInner(pdfjsLib, data, opts);
  } finally {
    globalThis.requestAnimationFrame = origRaf;
  }
}

async function convertInner(pdfjsLib, data, opts) {
  const onProgress = opts.onProgress || (() => {});
  // cMapは日本語等のCIDフォントのテキスト抽出に必須
  const pdf = await pdfjsLib.getDocument({
    data,
    cMapUrl: new URL("./cmaps/", import.meta.url).href,
    cMapPacked: true,
  }).promise;
  const n = pdf.numPages;

  // --- パスA: 全ページのテキスト構造化
  const pages = [];
  for (let p = 1; p <= n; p++) {
    onProgress(`テキスト解析中 ${p}/${n} ページ`);
    const page = await pdf.getPage(p);
    pages.push({ page, ...(await extractPage(page)) });
  }
  repairLigatureDamage(pages);
  const repeated = collectRepeatedMargins(pages);

  // 本文フォントサイズ (最頻値)
  const sizeCount = new Map();
  for (const pg of pages) {
    for (const bl of pg.blocks) {
      if (bl.domSize) {
        sizeCount.set(bl.domSize,
          (sizeCount.get(bl.domSize) || 0) + bl.plain.length);
      }
    }
  }
  let bodySize = 10, max = -1;
  for (const [k, v] of sizeCount) if (v > max) { max = v; bodySize = k; }

  // --- パスB: ページごとに描画 → 図検出 → 読み順 → チャンク化
  const scale = RENDER_DPI / 72;
  const chunks = [];
  const stats = { inlineMath: 0, nFig: 0, nMath: 0, nJunk: 0 };
  const headingSizes = new Set();

  for (let p = 0; p < n; p++) {
    onProgress(`レイアウト解析中 ${p + 1}/${n} ページ`);
    const pg = pages[p];
    const vp = pg.page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await pg.page.render({ canvasContext: ctx, viewport: vp }).promise;

    const crop = (r, padPt = 1.5) => {
      const x0 = Math.max(0, Math.floor((r.x0 - padPt) * scale));
      const y0 = Math.max(0, Math.floor((r.y0 - padPt) * scale));
      const x1 = Math.min(canvas.width, Math.ceil((r.x1 + padPt) * scale));
      const y1 = Math.min(canvas.height, Math.ceil((r.y1 + padPt) * scale));
      const w = x1 - x0, h = y1 - y0;
      if (w < 3 || h < 3) return null;
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      c.getContext("2d").drawImage(canvas, x0, y0, w, h, 0, 0, w, h);
      return { url: c.toDataURL("image/png"), wPt: w / scale, hPt: h / scale };
    };

    // 使えるブロック (回転・マージンノイズ除去)
    const kept = [];
    for (const bl of pg.blocks) {
      if (bl.rotated || !bl.plain) continue;
      if (isMarginJunk(bl, pg.pageRect, repeated)) { stats.nJunk++; continue; }
      kept.push(bl);
    }

    // 図領域: インク連結成分から
    const comps = detectInkRects(canvas, ctx, scale, pg.allLineRects, pg.pageRect);
    const figs = figureRects(comps, kept, pg.pageRect, bodySize, p);
    // キャプションと散文段落は図領域に重なっていても必ずテキストとして残す
    // (背景画像の上に本文が載っているレイアウトの保険)
    const isProseBlk = (b) =>
      ((b.plain.match(/[A-Za-z]{4,}/g) || []).length >= 6 && b.plain.length >= 60) ||
      (b.plain.match(/[぀-ヿ一-鿿]/g) || []).length >= 30;
    const inFig = (b) => !CAPTION_RE.test(b.plain) && !isProseBlk(b) &&
      figs.some((f) => overlapFrac(b.rect, f) > TEXT_IN_FIG_FRAC);
    const keptOut = kept.filter((b) => !inFig(b));

    // 数式領域
    const mathRegions = buildMathRegions(keptOut, pg.pageRect);
    const inMath = (b) => mathRegions.some((m) => overlapFrac(b.rect, m) > 0.5);

    // 読み順に並べる
    const items = [
      ...figs.map((r) => ({ kind: "figure", rect: r })),
      ...mathRegions.map((r) => ({ kind: "math", rect: r })),
      ...keptOut.filter((b) => !inMath(b)).map((b) => ({ kind: "text", rect: b.rect, block: b })),
    ];

    for (const it of orderItems(items, pg.pageRect)) {
      if (it.kind === "figure" || it.kind === "math") {
        const c = crop(it.rect, 3);
        if (!c || c.wPt * c.hPt < 100) continue;
        const sc = it.kind === "math" ? MATH_SCALE : FIG_SCALE;
        const cssW = Math.round(c.wPt * (96 / 72) * sc);
        chunks.push({ kind: it.kind, page: p, img: c.url, cssW, plain: "", html: "" });
        if (it.kind === "math") stats.nMath++; else stats.nFig++;
        continue;
      }
      const bl = it.block;
      const { plain: rawPlain, html } = blockToHtml(bl, crop, stats);
      if (!rawPlain) continue;
      // 見出しパターンの照合はスモールキャップス分断を正規化した文字列で行う
      const plain = normHeading(rawPlain);
      const letters = plain.replace(/[^A-Za-z]/g, "");
      const upperFrac = letters.length
        ? (letters.replace(/[^A-Z]/g, "").length / letters.length) : 0;
      let chunk;
      // 見出しはスモールキャップス分断 ("I. I NTRODUCTION") を含むことがあるので、
      // 表示にも正規化済みテキストを使う (装飾タグはhタグのスタイルで十分)
      const headHtml = escapeHtml(plain);
      if (CAPTION_RE.test(plain)) {
        chunk = { kind: "caption", page: p, plain, html };
      } else if (ROMAN_HEAD_RE.test(plain) && plain.length < 100 && upperFrac > 0.7) {
        chunk = { kind: "heading", page: p, plain, html: headHtml, level: -2 };
      } else if (ALPHA_HEAD_RE.test(plain) && plain.length < 90 &&
                 !SENT_END_RE.test(plain) && plain.split(/\s+/).length < 12 &&
                 (plain.match(/\./g) || []).length === 1 && !plain.includes(",")) {
        chunk = { kind: "heading", page: p, plain, html: headHtml, level: -3 };
      } else if (plain.length < 40 && plain.split(/\s+/).length === 1 &&
                 letters.length >= 6 && upperFrac > 0.85 && !/\d/.test(plain)) {
        // 番号なし全大文字の単語見出し ("ACKNOWLEDGMENT", "REFERENCES" 等)。
        // 複数語は表タイトル ("PASCAL VOC") の誤検出が多いので対象外
        chunk = { kind: "heading", page: p, plain, html: headHtml, level: -2 };
      } else if (/^\d{1,4}$/.test(plain)) {
        continue;  // 数字だけの孤立ブロック (取りこぼしたページ番号・軸ラベル等)
      } else if (isNumHead(plain) && plain.length < 90 &&
                 !SENT_END_RE.test(plain) && !plain.includes(",") &&
                 plain.split(/\s+/).length < 10 &&
                 (letters.length >= 3 || CJK_RE.test(plain))) {
        // 番号付き見出し。番号の深さ→hレベル ("3.2 ..." → h3)
        const depth = (plain.split(/\s+/)[0].replace(/\.$/, "").match(/\./g) || []).length;
        chunk = { kind: "heading", page: p, plain, html: headHtml,
                  level: -Math.min(depth + 2, 4) };
      } else if (plain.length < 150 && !SENT_END_RE.test(plain) &&
                 (letters.length >= 3 || CJK_RE.test(plain)) &&
                 (bl.domSize >= bodySize + 1.2 ||
                  (bl.boldFrac > 0.7 && SECTION_NUM_RE.test(plain)))) {
        headingSizes.add(bl.domSize);
        chunk = { kind: "heading", page: p, plain, html: headHtml, level: bl.domSize };
      } else if (bl.domSize && bl.domSize <= bodySize - 1.5) {
        chunk = { kind: "footnote", page: p, plain, html };
      } else {
        chunk = { kind: "body", page: p, plain, html, bold: bl.boldFrac };
      }
      chunks.push(chunk);
    }
    pg.page.cleanup(); // canvas・フォントリソースを解放
  }

  // --- タイトル昇格: 均一フォント論文対応。
  // 文書先頭のチャンクが「短い・文末記号なし・太字」ならタイトルとみなす
  for (const c of chunks) {
    if (c.kind === "figure" || c.kind === "math") break;
    if (c.kind === "heading") break;
    if (c.kind === "body") {
      if (c.page === 0 && c.plain.length < 150 &&
          !SENT_END_RE.test(c.plain) && (c.bold || 0) > 0.5) {
        c.kind = "heading";
        c.level = -1;
      }
      break;
    }
  }

  // --- 複数行に割れたタイトルの結合。文書内で最大フォントサイズの見出し
  // (=タイトル)同士に限定する (著者行とAbstract等の同サイズ誤結合を防ぐ)
  const sizeLevels = chunks.filter((c) => c.kind === "heading" && c.level > 0)
    .map((c) => c.level);
  const maxHeadSize = sizeLevels.length ? Math.max(...sizeLevels) : 0;
  const tmp = [];
  for (const c of chunks) {
    const prev = tmp[tmp.length - 1];
    if (c.kind === "heading" && prev && prev.kind === "heading" &&
        c.level > 0 && prev.level > 0 &&
        Math.abs(c.level - maxHeadSize) < 0.3 &&
        Math.abs(prev.level - maxHeadSize) < 0.3 &&
        !SENT_END_RE.test(prev.plain)) {
      prev.plain += " " + c.plain;
      prev.html += " " + c.html;
      prev.level = Math.max(prev.level, c.level);
      continue;
    }
    tmp.push(c);
  }
  chunks.length = 0;
  chunks.push(...tmp);

  // --- ドロップキャップ: 見出し末尾の孤立大文字を次の本文の先頭へ
  for (let i = 0; i < chunks.length - 1; i++) {
    const c = chunks[i], nxt = chunks[i + 1];
    const m = c.plain.match(/\s([A-Z])$/);
    if (c.kind === "heading" && m && nxt.kind === "body" && /^[A-Z]/.test(nxt.plain)) {
      c.plain = c.plain.slice(0, m.index).trimEnd();
      c.html = c.html.replace(
        new RegExp(`\\s*(?:<b>|<i>)*${m[1]}(?:</b>|</i>)*\\s*$`), "");
      nxt.plain = m[1] + nxt.plain;
      nxt.html = m[1] + nxt.html;
    }
  }

  // --- 見出しレベル決定 (負値はパターン検出の固定レベル)
  const ranked = [...headingSizes].sort((a, b) => b - a);
  for (const c of chunks) {
    if (c.kind !== "heading") continue;
    c.level = c.level < 0 ? -c.level
      : Math.min(ranked.indexOf(c.level) + 1 || 4, 4);
  }

  // --- h1の結合 (タイトルの泣き別れ)
  let joined = [];
  for (const c of chunks) {
    const prev = joined[joined.length - 1];
    if (c.kind === "heading" && prev && prev.kind === "heading" &&
        prev.level === 1 && c.level === 1 && !SENT_END_RE.test(prev.plain)) {
      prev.plain += " " + c.plain;
      prev.html += " " + c.html;
      continue;
    }
    joined.push(c);
  }

  // --- 段落結合 (カラム/ページまたぎ)
  const merged = [];
  for (const c of joined) {
    const prev = merged[merged.length - 1];
    if (c.kind === "body" && prev && prev.kind === "body" &&
        /^[a-z]/.test(c.plain) && !SENT_END_RE.test(prev.plain)) {
      if (prev.plain.endsWith("-")) {
        prev.plain = prev.plain.slice(0, -1) + c.plain;
        prev.html = prev.html.replace(DEHYPHEN_RE, "$1") + c.html;
      } else {
        prev.plain += " " + c.plain;
        prev.html += " " + c.html;
      }
      continue;
    }
    merged.push(c);
  }

  // --- 参考文献の再構築と引用リンク・URLリンク化
  let { chunks: finalChunks, nRefs } = rebuildReferences(merged);
  if (nRefs) {
    for (const c of finalChunks) {
      if (c.kind === "body" || c.kind === "caption" || c.kind === "footnote") {
        c.html = linkCitations(c.html, nRefs);
      }
    }
  } else {
    // 番号形式でなければ著者-年形式 ([Author et al. 2016]) を試す
    ({ chunks: finalChunks, nRefs } = rebuildReferencesAuthorYear(finalChunks));
  }
  for (const c of finalChunks) {
    if (["body", "caption", "footnote", "ref"].includes(c.kind)) {
      if (c.kind === "footnote") c.html = c.html.replace(URL_WRAP_RE, "$1");
      c.html = linkifyUrls(c.html);
    }
  }

  // --- HTML組み立て
  const parts = [];
  for (const c of finalChunks) {
    switch (c.kind) {
      case "figure":
        parts.push(`<figure class="figure"><img alt="figure p.${c.page + 1}" style="width:${c.cssW}px" src="${c.img}"></figure>`);
        break;
      case "math":
        parts.push(`<figure class="math-block"><img alt="equation p.${c.page + 1}" style="width:${c.cssW}px" src="${c.img}"></figure>`);
        break;
      case "heading":
        parts.push(`<h${c.level}>${c.html}</h${c.level}>`);
        break;
      case "caption":
        parts.push(`<p class="caption">${c.html}</p>`);
        break;
      case "footnote":
        parts.push(`<p class="footnote">${c.html}</p>`);
        break;
      case "ref":
        parts.push(`<p class="ref" id="ref-${c.level}">${c.html}</p>`);
        break;
      default:
        parts.push(`<p>${c.html}</p>`);
    }
  }

  let title = opts.fileName || "converted";
  try {
    const meta = await pdf.getMetadata();
    if (meta?.info?.Title) title = meta.info.Title;
  } catch (e) { /* メタデータなし */ }

  const summary = `${n}ページ / 段落 ${finalChunks.filter((c) => c.kind === "body").length}` +
    ` / 見出し ${finalChunks.filter((c) => c.kind === "heading").length}` +
    ` / 図 ${stats.nFig} / 数式 ${stats.nMath} / インライン数式 ${stats.inlineMath}` +
    ` / 文献 ${nRefs}`;

  return { bodyHtml: parts.join("\n"), title, summary, css: PAGE_CSS };
}

export const PAGE_CSS = `
  body { max-width: 760px; margin: 2rem auto; padding: 0 1rem;
         font-family: Georgia, "Yu Mincho", serif; font-size: 17px;
         line-height: 1.75; color: #1a1a1a; background: #fdfdfa; }
  h1 { font-size: 1.6em; line-height: 1.3; }
  h2 { font-size: 1.3em; margin-top: 2em; }
  h3, h4 { font-size: 1.1em; margin-top: 1.6em; }
  p { margin: 0.9em 0; text-align: justify; }
  figure { margin: 1.5em 0; text-align: center; }
  figure img { max-width: 100%; height: auto; }
  figure.math-block { margin: 0.8em 0; }
  p.caption { font-size: 0.88em; color: #444; margin-top: 0.4em; }
  p.footnote { font-size: 0.82em; color: #555; border-left: 3px solid #ddd;
               padding-left: 0.8em; }
  p.ref { font-size: 0.88em; margin: 0.45em 0; padding-left: 2.2em;
          text-indent: -2.2em; text-align: left; }
  p.ref:target { background: #fff3b0; transition: background 0.3s; }
  a.cite { color: #0b57d0; text-decoration: none; }
  a.cite:hover { text-decoration: underline; }
  a.url { color: #0b57d0; text-decoration: none; word-break: break-all; }
  a.url:hover { text-decoration: underline; }
  img.imath { vertical-align: middle; margin: 0 2px; }
  sup { font-size: 0.7em; }
`;
