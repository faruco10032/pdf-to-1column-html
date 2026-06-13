// viewer.js — 変換の進行表示と結果の描画
import * as pdfjsLib from "./pdf.min.mjs";
import { convertPdfToHtml } from "./converter.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("./pdf.worker.min.mjs", import.meta.url).href;

const statusEl = document.getElementById("status");
const setStatus = (msg, isError = false) => {
  statusEl.textContent = msg;
  statusEl.className = isError ? "error" : "";
};

function fileNameFromUrl(u) {
  try {
    const name = decodeURIComponent(new URL(u).pathname.split("/").pop() || "");
    return name.replace(/\.pdf$/i, "") || "converted";
  } catch (e) {
    return "converted";
  }
}

function buildStandaloneHtml(result) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${result.title.replace(/</g, "&lt;")}</title>
<style>${result.css}</style>
</head>
<body>
${result.bodyHtml}
</body>
</html>`;
}

async function main() {
  const src = new URLSearchParams(location.search).get("src");
  if (!src) {
    setStatus("エラー: 変換するPDFが指定されていません。PDFを開いたタブでツールバーのボタンを押してください。", true);
    return;
  }
  const fileName = fileNameFromUrl(src);

  let buf;
  try {
    setStatus("PDFを取得中…");
    const resp = await fetch(src, { credentials: "include" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    buf = await resp.arrayBuffer();
  } catch (e) {
    setStatus(`PDFの取得に失敗しました: ${e.message}\n` +
      "ローカルファイル(file://)の場合は、拡張機能の詳細設定で「ファイルのURLへのアクセスを許可する」を有効にしてください。", true);
    return;
  }
  const head = new TextDecoder("latin1").decode(new Uint8Array(buf.slice(0, 1024)));
  if (!head.includes("%PDF")) {
    setStatus("エラー: PDFデータを取得できませんでした。\n" +
      "ページ内に埋め込まれたPDFを自動検出できなかった可能性があります。" +
      "PDFが単独で表示されるタブ(アドレスバーがPDFを指している状態)で" +
      "アイコンを押すと確実です。", true);
    return;
  }

  let result;
  try {
    result = await convertPdfToHtml(pdfjsLib, buf, {
      fileName,
      onProgress: (msg) => setStatus(msg),
    });
  } catch (e) {
    console.error(e);
    setStatus(`変換に失敗しました: ${e.message}`, true);
    return;
  }

  // 結果を描画 (ブラウザ翻訳が効くよう lang=en のまま本文を置き換える)
  document.title = result.title;
  const style = document.getElementById("viewer-style");
  style.textContent = result.css + `
    #toolbar { position: fixed; top: 8px; right: 8px; z-index: 10;
               font-family: "Meiryo UI", sans-serif; }
    #toolbar button { font-size: 12px; padding: 4px 10px; cursor: pointer;
                      background: #fff; border: 1px solid #bbb; border-radius: 6px; }
  `;
  document.body.innerHTML =
    `<div id="toolbar"><button id="save-btn">HTMLを保存</button></div>` +
    result.bodyHtml;
  console.log("pdf2html:", result.summary);

  document.getElementById("save-btn").addEventListener("click", () => {
    const blob = new Blob([buildStandaloneHtml(result)], { type: "text/html" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = fileName + ".html";
    a.click();
    URL.revokeObjectURL(a.href);
  });

  // 検証用マーカー (ヘッドレステストで完了を検知する)
  document.documentElement.dataset.converted = "done";
  document.documentElement.dataset.summary = result.summary;
}

main();
