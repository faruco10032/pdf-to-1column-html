# プライバシーポリシー / Privacy Policy

**対象拡張機能 / Extension:** 論文PDF → 1カラムHTML (PDF to 1-column HTML)
**最終更新日 / Last updated:** 2026-06-13

---

## 日本語

本拡張機能（以下「本拡張」）は、ユーザーのプライバシーを最大限尊重します。

### 収集する情報

本拡張は、いかなる個人情報・利用データも **収集・保存・外部送信しません**。

- 変換対象のPDFデータ、変換結果のHTML、ページの内容、閲覧履歴、URL、その他一切のデータを、開発者や第三者のサーバーに送信することはありません。
- アナリティクス、トラッキング、広告SDK等は一切含まれていません。

### データの処理方法

- PDFの取得・解析・HTMLへの変換は、すべてユーザーのブラウザ内（ローカル）で完結します。
- 認証付きPDF（大学プロキシ等）を取得する際、ブラウザが保持するCookieが、そのPDFを配信しているサイト **に対してのみ** 送信されます（通常のブラウザのアクセスと同じ挙動）。このCookieが開発者や第三者に渡ることはありません。
- 「HTMLを保存」機能でダウンロードされるファイルは、ユーザーのローカル端末に保存されるのみです。

### 権限の利用目的

- **activeTab** — ユーザーがアイコンをクリックした、その時点のタブのPDFを取得するため。
- **scripting** — クリックしたページに埋め込まれたPDFの実URLを検出するため、読み取り専用でDOMを走査します。ページの改変やデータ送信は行いません。
- **ホストへのアクセス (`<all_urls>`)** — ユーザーが指定する任意のドメインのPDFを取得して変換するため。取得したデータは外部送信されません。

### お問い合わせ

ご質問は次の連絡先までお願いします: **t.kameoka10032@gmail.com**

---

## English

This extension respects your privacy to the fullest extent.

### Information We Collect

This extension does **not collect, store, or transmit** any personal information or usage data.

- PDF data, converted HTML, page content, browsing history, URLs, or any other data are never sent to the developer or any third party.
- The extension contains no analytics, tracking, or advertising SDKs.

### How Data Is Processed

- Fetching, parsing, and converting the PDF to HTML happen entirely within your browser (locally).
- When fetching an authenticated PDF (e.g., behind a university proxy), the browser's cookies are sent **only to the site hosting that PDF** — identical to normal browser behavior. These cookies are never shared with the developer or any third party.
- Files produced by the "Save HTML" feature are saved only to your local device.

### Why Each Permission Is Used

- **activeTab** — To access the PDF in the tab that is active at the moment you click the toolbar icon.
- **scripting** — To detect the real URL of a PDF embedded in the page by scanning the DOM in a read-only manner. It never modifies the page or transmits data.
- **Host access (`<all_urls>`)** — To fetch and convert PDFs hosted on any domain you choose. Fetched data is never transmitted externally.

### Contact

For questions, please contact: **t.kameoka10032@gmail.com**
