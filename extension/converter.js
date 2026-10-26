// converter.js — 論文PDFを1カラムHTMLに変換するパイプライン
//
// - ブロック/行構造はPDF.jsのtextContentアイテムから自前で再構築する
// - 図領域は「ページをCanvasに描画 → テキスト矩形を消去 → 残ったインクの
//   連結成分」として検出する

// ---------------------------------------------------------------- 定数

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
// 文献ゾーンのスキャンを打ち切るべき既知のセクション語 (これ以外の全大文字1語
// 見出しは文献タイトル断片の誤爆とみなしてゾーンに取り込む)
const SECTION_WORDS = new Set(["ACKNOWLEDGMENT", "ACKNOWLEDGMENTS",
  "ACKNOWLEDGEMENT", "ACKNOWLEDGEMENTS", "APPENDIX", "APPENDICES",
  "REFERENCES", "BIBLIOGRAPHY", "SUPPLEMENTARY", "BIOGRAPHY"]);
const isJunkHeadFragment = (t) =>
  /^[A-Z]{3,14}$/.test(t.trim()) && !SECTION_WORDS.has(t.trim());
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

// ゼロ幅文字(DOI内の改行禁止ジョイナ等)は検索・リンク化を壊すので除去
const ZERO_WIDTH_RE = /[\u200b\u200c\u200d\u2060\ufeff]/g;
const normText = (s) => s.replace(/\u00a0/g, " ").replace(/\u00ad/g, "-")
  .replace(ZERO_WIDTH_RE, "")
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
    // "References" 等のセクション語1行は本文と同スタイルでも見出し
    // (本文直後に文献リストが続くジャーナルで先頭エントリに融合するのを防ぐ)
    if (REFS_HEAD_RE.test(t) || SECTION_WORDS.has(t.toUpperCase())) return true;
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
  // 字下げ等で複数段落が融合したブロックを段落単位に分割してから確定する
  const splitBlocks = [];
  for (const bl of blocks) splitBlocks.push(...splitParagraphBlock(bl));
  for (const bl of splitBlocks) finishBlock(bl);
  return { pageRect, blocks: splitBlocks, allLineRects: lines.map((l) => l.rect) };
}

const PARA_INDENT_MIN = 7, PARA_INDENT_MAX = 40;

// 1ブロックに融合した複数の段落を行の幾何情報で分割する。
// LaTeX系論文は段落間に縦余白がなく字下げだけで段落を示すため、
// ブロック抽出では複数段落が1つに融合する。境界の判定:
//   (1) 字下げ: 行頭が左端より7〜40pt右で、前の行は左端揃え
//   (2) 短い行末: 両端揃えのテキストで前の行が右端に届いていない
//   (3) 全角スペース字下げ (日本語)
// ガード: 同一ベースライン上では分割しない / 20文字未満の断片を作る分割は取り消す
function splitParagraphBlock(bl) {
  const lines = bl.lines;
  const n = lines.length;
  if (bl.forced || n < 3) return [bl];
  const left = Math.min(...lines.map((l) => l.rect.x0));
  const right = Math.max(...lines.map((l) => l.rect.x1));
  const width = right - left;
  if (width < 120) return [bl];
  const indents = lines.map((l) => l.rect.x0 - left);
  const fracInd = indents.filter((d) => d >= PARA_INDENT_MIN).length / n;
  let fullN = 0;
  for (let i = 0; i < n - 1; i++) {
    if (lines[i].rect.x1 >= right - 0.04 * width) fullN++;
  }
  const justified = fullN / (n - 1) >= 0.6;

  const breaks = [];
  for (let i = 1; i < n; i++) {
    // 同じベースライン上の行同士 (ラン・イン見出しの番号 "4.3.1" 等) では分割しない
    if (lines[i].rect.y0 < lines[i - 1].rect.y1 - 2) continue;
    const d = indents[i], pd = indents[i - 1];
    const raw = lines[i].spans.length ? lines[i].spans[0].text : "";
    const indentStart = d >= PARA_INDENT_MIN && d <= PARA_INDENT_MAX &&
      pd < 4 && fracInd < 0.5;
    const shortPrev = justified && d < 4 &&
      lines[i - 1].rect.x1 < right - Math.max(18, 0.12 * width);
    const zenIndent = raw.startsWith("　");
    if (indentStart || shortPrev || zenIndent) breaks.push(i);
  }
  if (!breaks.length) return [bl];

  const groups = [];
  let prev = 0;
  for (const b of breaks.concat([n])) {
    if (b > prev) groups.push(lines.slice(prev, b));
    prev = b;
  }
  // 20文字未満の断片を作る分割は取り消す (単語断片が見出し等に誤爆するのを防ぐ)
  const gText = (g) => g.map((l) => l.text).join(" ").trim();
  const healed = [];
  for (const g of groups) {
    if (healed.length && (gText(g).length < 20 || gText(healed[healed.length - 1]).length < 20)) {
      healed[healed.length - 1].push(...g);
    } else {
      healed.push(g.slice());
    }
  }
  if (healed.length <= 1) return [bl];
  return healed.map((g) => {
    let r = { ...g[0].rect };
    for (const ln of g) r = rUnion(r, ln.rect);
    return { ...bl, lines: g, rect: r };
  });
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
  // 文献エントリ ("[25] ..." — 本文に vol./no. を含みジャーナルヘッダーと
  // 紛らわしい) はマージン付近にあってもノイズ扱いしない
  if (/^\[\d{1,3}\]\s/.test(t)) return false;
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

// 文献リストの直後に続く著者略歴 ("Akira ASANO (Member) received the B.E. degree ...",
// "Markus Grüner received his Ph.D. ...") の先頭。文献ゾーンの終端判定に使う
const BIO_START_RE = new RegExp(
  "^(?:\\p{Lu}[\\p{L}\\p{M}'’-]+\\s+){1,3}(?:\\([^)]{0,30}\\)\\s*)?(?:\\p{Lu}[\\p{L}\\p{M}'’-]+\\s+){0,3}" +
  "(?:received|graduated|is currently|is an? |was born|obtained|earned|joined)\\b" +
  // 「氏名 (Member)」だけの短い行 (写真横の名前行) も略歴の先頭とみなす
  "|^(?:\\p{Lu}[\\p{L}\\p{M}'’-]+\\s+){1,4}\\([^)]{0,30}\\)\\s*$", "u");

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
    const c2 = chunks[end];
    const k = c2.kind;
    if (k === "body" || k === "footnote") {
      if (BIO_START_RE.test(c2.plain)) break;   // 著者略歴が始まったら文献ゾーン終了
      zone.push(c2);
    }
    else if (k === "figure" || k === "math") keptFigs.push(c2);
    else if (k === "heading" && isJunkHeadFragment(c2.plain)) zone.push(c2);
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
  joined = repairWrappedUrls(joined);  // 折り返しで分断されたDOI/URLを再結合

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

// 著者-年の引用1件分 (例: "Gugenheimer et al. 2016", "Simeone et al., 2015",
// "Ernst & Banks, 2002", "Lombard and Ditton 1997", "Minsky 1980")。
// 年の前のカンマは任意、"et al" のピリオドも任意、接続は and / &。
// HTML側では "&" が "&amp;" にエスケープされているため、その形も受け付ける。
// 名前は \p{L} でアクセント付き文字 (Clément, Périard) も許容 (u フラグ必須)。
// 企業名 "3M Co., 2016" のような数字始まりも許す
const AY_WORD = "[\\p{L}\\p{M}'’-]+";
// 団体名 "World Health Organization, 2019" のような複数語(最大3語)も許す
// 姓の頭文字はアクセント付き大文字 (Özkardeşler) も許す (\p{Lu})
const AY_PART_SRC = "([\\p{Lu}0-9]" + AY_WORD + ")(?:\\s+(?:et\\s+al\\.?|(?:and|&amp;|&)\\s+\\p{Lu}" + AY_WORD + ")" +
  "|(?:\\s+\\p{Lu}[\\p{L}\\p{M}'’-]*\\.?){1,2})?,?\\s+(\\d{4}[a-z]?)";
const AY_PART_RE = new RegExp(AY_PART_SRC, "gu");
// 地の文の引用 "Simeone et al. (2015)" / "Ernst and Banks (2002)"
const AY_NARR_RE = new RegExp(
  "(\\p{Lu}" + AY_WORD + "(?:\\s+(?:et\\s+al\\.?|(?:and|&amp;|&)\\s+\\p{Lu}" + AY_WORD + "))?)\\s*\\((\\d{4}[a-z]?)\\)", "gu");
// 文献エントリ先頭の検出。名前トークンの連なりが
//   ACM形式: ". YEAR."          (Zikun Chen, ... Minamizawa. 2017. Title ...)
//   APA形式: " (YEAR[, 補足])." (Simeone, A. L., ..., & Gellersen, H. (2015). Title ...)
// で終わる箇所。APA形式は前エントリの終端(. ? ! または末尾のDOI/URL)直後に限定して
// 誤爆を防ぐ (DOIで終わるエントリはピリオドで閉じないことが多い)。
// APA形式は筆頭が企業名 ("3M Co. (2016).") の数字始まりも許す
// イニシャルはハイフン連結 ("Y.-H.") も許す
const AY_NAME = "(?:\\p{Lu}[\\p{L}\\p{M}'’\\-]*\\.?|\\p{Lu}\\.(?:-\\p{Lu}\\.)?|and|&|de|van|von|der|den|del|di|da|dos|la|le|el)";
const AY_ENTRY_SRC = AY_NAME + "(?:[\\s,]+" + AY_NAME + ")*\\.\\s*((?:19|20)\\d\\d[a-z]?)\\.";
const AY_ENTRY_APA_SRC = "(?<=^|[.?!][\"”)\\]]*\\s|https?://\\S+\\s)(?:\\d+[A-Z]\\w*|" + AY_NAME +
  ")(?:[\\s,]+" + AY_NAME + ")*,?\\s*\\(\\s*((?:19|20)\\d\\d[a-z]?)[^)]*\\)";

const AY_REFS_INLINE_RE = /^(References|Bibliography|REFERENCES)\s+(?=[A-Z0-9])/;

// 著者-年形式の論文向け。文献ゾーンを「著者… YEAR.」境界で個別エントリに再分割し、
// 本文中の [著者 年] 引用を対応エントリへリンクする。番号形式が失敗した場合に使う
function rebuildReferencesAuthorYear(chunks) {
  let start = -1;
  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i].kind === "heading" && REFS_HEAD_RE.test(chunks[i].plain.trim())) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) {
    // 見出しが先頭エントリに融合している場合 ("References Ansorge, U., ...")
    // はその本文チャンクをアンカーにし、見出し部分を切り出す
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const m = c.kind === "body" ? AY_REFS_INLINE_RE.exec(c.plain) : null;
      if (m && c.plain.length > m[0].length + 20) {
        const rest = c.plain.slice(m[0].length);
        chunks = [...chunks.slice(0, i),
          { kind: "heading", page: c.page, plain: m[1], html: escapeHtml(m[1]), level: -2 },
          { kind: "body", page: c.page, plain: rest, html: escapeHtml(rest) },
          ...chunks.slice(i + 1)];
        start = i + 1;
        break;
      }
    }
  }
  if (start < 0) return { chunks, nRefs: 0 };
  let end = start;
  const zone = [], keptFigs = [];
  while (end < chunks.length) {
    const c2 = chunks[end];
    const k = c2.kind;
    if (k === "body" || k === "footnote") {
      if (BIO_START_RE.test(c2.plain)) break;   // 著者略歴が始まったら文献ゾーン終了
      zone.push(c2);
    }
    else if (k === "figure" || k === "math") keptFigs.push(c2);
    else if (k === "heading" && isJunkHeadFragment(c2.plain)) zone.push(c2);
    else break;
    end++;
  }
  if (!zone.length) return { chunks, nRefs: 0 };

  // ゾーンを連結し、エントリ境界で分割 (ACM形式とAPA形式を両方試して多い方を採用)
  let joined = zone.map((c) => c.plain).join(" ")
    .replace(/(\w)-\s+(?=[a-z])/g, "$1").replace(/\s+/g, " ").trim();
  // 折り返しで分断されたDOI/URLを再結合 (エントリ境界の判定にURL末尾を使う)
  joined = repairWrappedUrls(joined);
  const findStarts = (src) => {
    const re = new RegExp(src, "gu");
    const out = [];
    let mm;
    while ((mm = re.exec(joined)) !== null) {
      out.push(mm.index);
      if (mm[0].length === 0) re.lastIndex++;
    }
    return out;
  };
  let entrySrc = AY_ENTRY_SRC;
  let starts = findStarts(AY_ENTRY_SRC);
  const startsApa = findStarts(AY_ENTRY_APA_SRC);
  if (startsApa.length > starts.length) { entrySrc = AY_ENTRY_APA_SRC; starts = startsApa; }
  if (starts.length < 3) return { chunks, nRefs: 0 };
  const bounds = starts.concat([joined.length]);
  const entries = [];
  for (let i = 0; i < starts.length; i++) {
    entries.push(joined.slice(starts[i], bounds[i + 1]).trim());
  }

  // 各エントリの (著者プレフィックス, 筆頭著者の姓, 年)
  const headRe = new RegExp("^" + entrySrc, "u");
  const firstSurname = (prefix) => {
    const head = prefix.split(/,|\band\b|&/)[0];
    const ws = head.match(/[\p{L}\p{M}'’\-]{2,}/gu) || [];   // アクセント付き文字も含む
    return ws.length ? ws[ws.length - 1] : "";
  };
  const meta = entries.map((ent) => {
    const m = headRe.exec(ent);
    let prefix = ent, year = "";
    if (m) {
      year = m[1];
      prefix = m[0].slice(0, m[0].lastIndexOf(m[1])).replace(/[\s(]+$/, "");
    }
    return { lead: firstSurname(prefix), prefix, year };
  });

  // 本文中の引用 (姓, 年) を収集: [..] と (..) の中、および地の文 "Name (YEAR)"
  const cites = new Set();
  for (const c of chunks.slice(0, start)) {
    if (!["body", "caption", "footnote"].includes(c.kind)) continue;
    for (const m of c.plain.matchAll(/[\[(]([^\[\]()<>]{4,200}?)[\])]/g)) {
      for (const part of m[1].split(/(?<!&amp);/)) {   // "&amp;" の ; は区切りでない
        const am = new RegExp(AY_PART_SRC, "u").exec(part);
        if (am) cites.add(am[1] + " " + am[2]);
      }
    }
    for (const m of c.plain.matchAll(AY_NARR_RE)) {
      cites.add(m[1].split(/\s+/)[0] + " " + m[2]);
    }
  }
  if (cites.size < 2) return { chunks, nRefs: 0 };

  // 引用 → エントリ番号: 筆頭著者の姓が一致するものを優先、無ければ著者一覧に含むもの
  const idOf = new Map();
  for (const key of cites) {
    const sp = key.lastIndexOf(" ");
    const surname = key.slice(0, sp), year = key.slice(sp + 1);
    let rid = null;
    for (let i = 0; i < meta.length; i++) {
      if (meta[i].year.slice(0, 4) === year.slice(0, 4) && meta[i].lead === surname) {
        rid = i + 1; break;
      }
    }
    if (rid === null) {
      for (let i = 0; i < meta.length; i++) {
        if (meta[i].year.slice(0, 4) === year.slice(0, 4) && meta[i].prefix.includes(surname)) {
          rid = i + 1; break;
        }
      }
    }
    if (rid !== null) idOf.set(key, rid);
  }

  const refs = entries.map((e, i) => ({
    kind: "ref", page: zone[0].page, plain: e, html: escapeHtml(e), level: i + 1,
  }));

  // 本文の引用をリンク化 (リンクを含むブロックは翻訳除外で包む)。
  // 対象: 地の文 "Simeone et al. (2015)" / 括弧内 "[..]" "(..)" の各パート
  const linkAy = (html) => {
    html = html.replace(AY_NARR_RE, (whole, names, year) => {
      const id = idOf.get(names.split(/\s+/)[0] + " " + year);
      return id
        ? wrapNoTranslate(`<a class="cite" href="#ref-${id}">${whole}</a>`) : whole;
    });
    return html.replace(/([\[(])([^\[\]()<>]{4,200}?)([\])])/g, (whole, open, inner, close) => {
      const body = open + inner.replace(AY_PART_RE, (pm, surname, year) => {
        const id = idOf.get(surname + " " + year);
        return id ? `<a class="cite" href="#ref-${id}">${pm}</a>` : pm;
      }) + close;
      return body.includes('class="cite"') ? wrapNoTranslate(body) : body;
    });
  };
  for (const c of chunks.slice(0, start)) {
    if (["body", "caption", "footnote"].includes(c.kind)) c.html = linkAy(c.html);
  }
  return { chunks: [...chunks.slice(0, start), ...refs, ...keptFigs, ...chunks.slice(end)],
           nRefs: refs.length };
}

const URL_LINK_RE = /https?:\/\/[^\s<>"]+/g;
// 行折り返しで分断されたURL ("https://doi.org/10.1145/ 3290605.3300233") を再結合。
// URL末尾が / . - = のとき、続くトークンに数字が含まれていればURLの続きとみなす
const URL_WRAP_RE = /(https?:\/\/[^\s<>"]+[/.=-])\s+(?=[^\s<>"]*\d)/g;
// スキーム直後で折り返された "https:// www.example.com/..." も再結合する
const URL_SCHEME_WRAP_RE = /(https?:\/\/)\s+(?=[\w-]+(?:\.[\w-]+)+)/g;
const repairWrappedUrls = (s) =>
  s.replace(URL_SCHEME_WRAP_RE, "$1").replace(URL_WRAP_RE, "$1");

function linkifyUrls(html) {
  return html.replace(URL_LINK_RE, (m) => {
    const url = m.replace(/[.,;)\]'"]+$/, "");
    const trail = m.slice(url.length);
    return `<a class="url" href="${url}" target="_blank" rel="noopener">${url}</a>${trail}`;
  });
}

// 引用ブロックを翻訳除外アイランドにする。Chrome翻訳は文を再構成する際に
// インラインリンクの中身を並べ替えて番号とリンク先の対応を壊すため、
// ブロック全体を translate=no で1つの不可分な単位として保護する
const wrapNoTranslate = (inner) =>
  `<span class="notranslate" translate="no">${inner}</span>`;

// 本文中の引用を参考文献へのリンクにする。
// [1] や [2, 5] は各番号を個別リンク。範囲引用は中間の番号も補って展開する:
//   [4]-[7] (ブラケット間) / [4-7] / [ 4 - 7 ] (ブラケット内) → [4, 5, 6, 7]
// リンクを含むブロックは翻訳除外 (translate=no) で包む。
function linkCitations(html, nRefs) {
  const linkNum = (n) => `<a class="cite" href="#ref-${n}">${n}</a>`;
  const numOrPlain = (n) => (n >= 1 && n <= nRefs ? linkNum(n) : String(n));
  // 中間展開してよい範囲: 昇順・文献数以内・幅30まで (誤爆防止)
  const validRange = (a, b) => a >= 1 && a < b && b <= nRefs && b - a <= 30;
  const expand = (a, b) => {
    const out = [];
    for (let k = a; k <= b; k++) out.push(linkNum(k));
    return out.join(", ");
  };

  // --- [4]-[7] 形式 (ブラケット間の範囲) → [4, 5, 6, 7]
  html = html.replace(
    /\[\s*(\d{1,3})\s*\]\s*[-–—~〜]\s*\[\s*(\d{1,3})\s*\]/g,
    (whole, sa, sb) => {
      const a = parseInt(sa, 10), b = parseInt(sb, 10);
      return validRange(a, b)
        ? wrapNoTranslate("[" + expand(a, b) + "]") : whole;
    });

  // --- ブラケット内: 範囲は展開、それ以外の数字は個別リンク
  return html.replace(CITE_RE, (whole, innerRaw) => {
    const inner = innerRaw.trim();
    const tokenRe = /(\d{1,3})\s*[-–—]\s*(\d{1,3})|(\d{1,3})/g;
    const out = [];
    let pos = 0, t;
    while ((t = tokenRe.exec(inner)) !== null) {
      out.push(inner.slice(pos, t.index));
      if (t[3] !== undefined) {
        out.push(numOrPlain(parseInt(t[3], 10)));
      } else {
        const a = parseInt(t[1], 10), b = parseInt(t[2], 10);
        if (validRange(a, b)) {
          out.push(expand(a, b));
        } else {
          const sep = t[0].replace(/[\d\s]/g, "") || "-";
          out.push(numOrPlain(a) + sep + numOrPlain(b));
        }
      }
      pos = t.index + t[0].length;
    }
    out.push(inner.slice(pos));
    const body = "[" + out.join("") + "]";
    // リンクが1つもできなかったブラケットは翻訳除外しない (単なる数字表記)
    return body.includes('class="cite"') ? wrapNoTranslate(body) : body;
  });
}

// デバッグ用エクスポート
export { linkCitations };
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
      } else if (plain.length < 40 &&
                 (REFS_HEAD_RE.test(plain.trim()) ||
                  /^(Acknowledge?ments?|Appendix|Appendices)$/i.test(plain.trim()))) {
        // 本文と同じフォントサイズの論文でも、単独行の "References" 等の
        // セクション語は見出しとして扱う (文献再構築のアンカーになる)
        chunk = { kind: "heading", page: p, plain, html: headHtml, level: -2 };
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

  // --- 段落結合 (カラム/ページまたぎ)。
  // 途中に図・数式・キャプション・脚注チャンクが挟まっていても、それらを
  // 飛び越えて直近の本文段落へ結合する (図はフロートなので読み順は保たれる)。
  // 見出しは節の区切りなので飛び越えない。
  const SKIP_OVER = ["figure", "math", "caption", "footnote"];
  const merged = [];
  for (const c of joined) {
    if (c.kind === "body" && /^[a-z]/.test(c.plain)) {
      let j = merged.length - 1;
      while (j >= 0 && SKIP_OVER.includes(merged[j].kind)) j--;
      const prev = j >= 0 ? merged[j] : null;
      if (prev && prev.kind === "body" && !SENT_END_RE.test(prev.plain)) {
        if (prev.plain.endsWith("-")) {
          prev.plain = prev.plain.slice(0, -1) + c.plain;
          prev.html = prev.html.replace(DEHYPHEN_RE, "$1") + c.html;
        } else {
          prev.plain += " " + c.plain;
          prev.html += " " + c.html;
        }
        continue;
      }
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
      if (c.kind === "footnote") c.html = repairWrappedUrls(c.html);
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
      case "ref": {
        // data-cite に原文(タグ除去・実体参照復元)を保持。Chrome翻訳は属性値を
        // 翻訳しないため、ポップアップ表示とScholar検索に常に原文を使える
        const citePlain = c.html.replace(/<[^>]+>/g, "")
          .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").trim();
        const citeAttr = citePlain.replace(/&/g, "&amp;").replace(/</g, "&lt;")
          .replace(/"/g, "&quot;");
        parts.push(`<p class="ref" id="ref-${c.level}" data-cite="${citeAttr}">${c.html}</p>`);
        break;
      }
      default:
        parts.push(`<p>${c.html}</p>`);
    }
  }

  // タイトルは検出した論文タイトル(h1)を優先する。PDFメタデータのTitleは
  // 誌名や "Microsoft Word - ..." のことが多い
  let title = opts.fileName || "converted";
  try {
    const meta = await pdf.getMetadata();
    if (meta?.info?.Title) title = meta.info.Title;
  } catch (e) { /* メタデータなし */ }
  const h1 = finalChunks.find((c) => c.kind === "heading" && c.level === 1);
  if (h1 && h1.plain.trim().length >= 10) title = h1.plain.trim();

  const summary = `${n}ページ / 段落 ${finalChunks.filter((c) => c.kind === "body").length}` +
    ` / 見出し ${finalChunks.filter((c) => c.kind === "heading").length}` +
    ` / 図 ${stats.nFig} / 数式 ${stats.nMath} / インライン数式 ${stats.inlineMath}` +
    ` / 文献 ${nRefs}`;

  return { bodyHtml: parts.join("\n"), title, summary, css: PAGE_CSS,
           popupScript: POPUP_SCRIPT };
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
  .cite-popup { position: fixed; z-index: 9999; max-width: 360px;
                background: #fff; color: #222; border: 1px solid #c4c4c4;
                border-radius: 8px; box-shadow: 0 6px 20px rgba(0,0,0,0.2);
                padding: 10px 12px; font-family: "Meiryo UI", system-ui, sans-serif;
                font-size: 13px; line-height: 1.55; text-align: left; }
  .cite-popup-text { margin-bottom: 8px; }
  .cite-popup-link { display: inline-block; color: #0b57d0; font-weight: bold;
                     text-decoration: none; white-space: nowrap; }
  .cite-popup-link:hover { text-decoration: underline; }
`;

// 引用リンクのホバーで書誌ポップアップ + Google Scholar検索リンクを出す。
// 引用ポップアップを初期化する。拡張のビューアページ(MV3)はインラインscriptが
// CSPで実行できないため、モジュール関数として直接呼ぶ(viewer.jsから)。
// グローバル(document/window/setTimeout等)のみ参照する自己完結関数にしてあり、
// 保存HTML用の文字列 POPUP_SCRIPT は toString() で生成する(単一ソース)。
export function initCitePopups() {
  var popup = null, hideTimer = null;
  function cleanTitle(t) {
    return t.replace(/^[\s"“”„'‘’]+/, "").replace(/[\s.,;:"“”]+$/, "").trim();
  }
  function firstSentence(t) {
    t = t.trim();
    var m = t.match(/\.\s+(?=[A-Z0-9"“])/);
    var out = m ? t.slice(0, m.index) : t;
    return cleanTitle(out.replace(/\s*\([^)]*\)\s*$/, ""));
  }
  // 参考文献テキストからタイトルだけを取り出す(著者・掲載誌は除く)。
  // 形式別: 引用符付き(IEEE) / 著者-年(ACM) / 番号付き「著者. タイトル. 誌名.」
  function extractTitle(cite) {
    var numbered = /^\s*\[/.test(cite);
    var s = cite.replace(/^\s*\[[^\]]*\]\s*/, "").trim();
    var q = s.match(/["“„]([^"”]{6,}?)["”]/);
    if (q) return cleanTitle(q[1]);
    if (!numbered) {
      // APA: "Igase, M. (2018). Title. Journal" / ACM: "Minamizawa. 2017. Title."
      var apa = s.match(/\(\s*(?:19|20)\d\d[a-z]?(?:,[^)]*)?\)\.?\s+(.+)$/);
      if (apa) return firstSentence(apa[1]);
      var ay = s.match(/\b(?:19|20)\d\d[a-z]?\.\s+(.+)$/);
      if (ay) return firstSentence(ay[1]);
    }
    var m = s.match(/[A-Za-z][a-z'’\-]+\.\s+(?=[A-Z])/);
    return firstSentence(m ? s.slice(m.index + m[0].length) : s);
  }
  function schedHide() {
    hideTimer = setTimeout(function () {
      if (popup) popup.style.display = "none";
    }, 300);
  }
  function ensure() {
    if (popup) return popup;
    popup = document.createElement("div");
    popup.className = "cite-popup";
    popup.style.display = "none";
    popup.addEventListener("mouseenter", function () { clearTimeout(hideTimer); });
    popup.addEventListener("mouseleave", schedHide);
    document.body.appendChild(popup);
    return popup;
  }
  function show(a, x, y) {
    var href = a.getAttribute("href") || "";
    var ref = document.getElementById(href.slice(1));
    if (!ref) return;
    var cite = (ref.getAttribute("data-cite") || ref.textContent || "").trim();
    if (!cite) return;
    var query = extractTitle(cite);
    if (query.length < 8) query = cite.replace(/^\s*\[[^\]]*\]\s*/, "");
    var p = ensure();
    clearTimeout(hideTimer);
    p.textContent = "";
    var t = document.createElement("div");
    t.className = "cite-popup-text";
    t.setAttribute("translate", "no");
    t.textContent = cite;
    p.appendChild(t);
    var link = document.createElement("a");
    link.className = "cite-popup-link";
    link.href = "https://scholar.google.com/scholar?q=" + encodeURIComponent(query);
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "🔍 Google Scholar で検索";
    p.appendChild(link);
    p.style.display = "block";
    p.style.visibility = "hidden";
    var w = p.offsetWidth, h = p.offsetHeight;
    var left = x + 14, top = y + 14;
    if (left + w > window.innerWidth - 8) left = x - w - 14;
    if (left < 8) left = 8;
    if (top + h > window.innerHeight - 8) top = y - h - 14;
    if (top < 8) top = 8;
    p.style.left = left + "px";
    p.style.top = top + "px";
    p.style.visibility = "visible";
  }
  var links = document.querySelectorAll("a.cite");
  for (var i = 0; i < links.length; i++) {
    var a = links[i];
    if (a.__citeBound) continue;
    a.__citeBound = true;
    a.addEventListener("mouseenter", (function (el) {
      return function (e) { show(el, e.clientX, e.clientY); };
    })(a));
    a.addEventListener("mouseleave", schedHide);
  }
}

// 保存HTML(通常ページ)用: 末尾に置いて自己実行するインライン文字列。
// 拡張ページでは使わない(viewer.jsが initCitePopups() を直接呼ぶ)。
export const POPUP_SCRIPT = "(" + initCitePopups.toString() + ")();";
