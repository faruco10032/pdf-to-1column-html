// background.js — ツールバーボタンで現在のタブのPDFをビューアに渡す。
// タブのURLが直接PDFを指していない場合(IEEE stamp.jsp 等、ページ内の
// <iframe>/<embed> にPDFが埋め込まれているケース)は、ページのDOMを走査して
// 本当のPDF URLを探し出してから変換する。

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.url) return;

  let pdfUrl = tab.url;

  // タブ内のフレームを走査して埋め込みPDFの実URLを探す。
  // 直リンクPDF(ネイティブPDFビューア)や chrome:// では executeScript が
  // 失敗するので、その場合は tab.url にフォールバックする。
  if (tab.id != null && /^https?:|^file:/.test(tab.url)) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: findPdfInFrame,
      });
      const found = pickBestPdf(results.map((r) => r.result), tab.url);
      if (found) pdfUrl = found;
    } catch (e) {
      // 権限なし / 注入不可ページ → tab.url をそのまま使う
    }
  }

  const viewer = chrome.runtime.getURL("viewer.html") +
    "?src=" + encodeURIComponent(pdfUrl);
  chrome.tabs.create({ url: viewer, index: tab.index + 1 });
});

// 各フレーム内で実行される(self-contained でなければならない)。
// このフレームに紐づく最有力のPDF候補を1つ返す。
function findPdfInFrame() {
  const candidates = [];
  const add = (raw, type) => {
    if (!raw) return;
    let abs;
    try { abs = new URL(raw, location.href).href; } catch (e) { return; }
    // pdf.js 系ビューア (viewer.html?file=ENCODED) から実ファイルを抽出
    try {
      const fileParam = new URL(abs).searchParams.get("file");
      if (fileParam && /^https?:|^file:/.test(fileParam)) {
        abs = new URL(fileParam, location.href).href;
      }
    } catch (e) {}
    if (!/^https?:|^file:/.test(abs)) return; // blob:/about: 等は対象外
    const t = (type || "").toLowerCase();
    let score = 30;
    if (t === "application/pdf") score = 90;
    else if (/\.pdf(\?|#|$)/i.test(abs)) score = 80;
    else if (/(\/|=|\?)[^?#]*pdf/i.test(abs)) score = 50;
    candidates.push({ url: abs, score });
  };

  // このフレーム自身がPDF(Chromeのネイティブビューア等)
  try {
    if (document.contentType === "application/pdf") {
      candidates.push({ url: location.href, score: 100 });
    }
  } catch (e) {}

  // 埋め込み要素の src/data を収集
  for (const el of document.querySelectorAll("embed, object, iframe")) {
    add(el.getAttribute("src") || el.getAttribute("data"),
        el.getAttribute("type"));
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] || null;
}

// 全フレームの候補から最良を選ぶ。タブURL自身が .pdf ならそれも候補に含める。
function pickBestPdf(results, tabUrl) {
  const all = (results || []).filter(Boolean);
  if (/\.pdf(\?|#|$)/i.test(tabUrl)) all.push({ url: tabUrl, score: 85 });
  all.sort((a, b) => b.score - a.score);
  // tab.url 自身を選ぶ意味はない(現状動作と同じ)ので、別URLが見つかった時だけ採用
  for (const c of all) {
    if (c.url !== tabUrl && c.score >= 50) return c.url;
  }
  return null;
}
