# 論文PDF → 1カラムHTML (Chrome拡張)

Chromeのタブで表示中の英語論文PDFを、読みやすい1カラムのHTMLに変換して新しいタブで開く拡張機能です。
図・表・数式は元の見た目のまま画像として残し、本文だけを正しい読み順のテキストにします。
変換後はブラウザの自動翻訳(右クリック →「日本語に翻訳」)で読む想定で、翻訳そのものは含めていません。

変換はすべてブラウザ内(PDF.js)で完結し、PDFや変換結果を外部に送信しません。

## 主な機能

- 2段組の論文も正しい読み順の1カラムに再構成。段落は字下げ・行末の位置から分割
- 図・表・数式(別行立て・行内とも)は画像として保持
- 参考文献を1件ずつに再構築し、本文の引用からリンク
  - 番号形式 `[1]` `[2, 5]` `[4]-[7]` `[4-7]`(範囲は個別リンクに展開)
  - 著者-年形式 `[Author 2016]` `(Simeone et al., 2015)` `(Ernst & Banks, 2002)` `Simeone et al. (2015)`
  - 文献リストは番号形式・ACM形式・APA形式に対応
- 引用にマウスを乗せると書誌情報をポップアップ表示し、Google Scholar でタイトル検索できる
- Chrome翻訳をかけても引用リンクがずれないよう、引用部分は翻訳対象外にする
- DOI/URL のクリッカブルリンク化、日本語論文対応
- IEEE Xplore などページ内に埋め込まれたPDFも自動検出
- 変換結果を単体のHTMLファイルとして保存可能

## インストール

1. このリポジトリの [`extension/`](extension/) フォルダを手元に置く(または配布用ZIPを展開する)
2. Chromeで `chrome://extensions` を開き、右上の「デベロッパーモード」をON
3. 「パッケージ化されていない拡張機能を読み込む」→ `extension` フォルダを選択

詳しい手順・使い方は [`extension/INSTALL.txt`](extension/INSTALL.txt)、
構成と変換パイプラインの説明は [`extension/README.md`](extension/README.md) を参照してください。

## 配布用ZIPの作成

`拡張をパッケージ.bat`(中身は `build_extension.ps1`)をダブルクリックすると、
`dist/pdf-to-html-extension.zip` を作成します(ファイル名は固定)。

Chrome で読み込んでいるフォルダが別の場所にある場合は、
[`local_config.example.json`](local_config.example.json) を `local_config.json` にコピーして
`install_dir` にそのフォルダを書いておくと、ビルド時にそこへも自動で同期します。
`local_config.json` は個人環境の設定なので Git の管理対象外です。

## プライバシー

[`PRIVACY_POLICY.md`](PRIVACY_POLICY.md) を参照してください。

## ライセンス

同梱の PDF.js(`extension/pdf.min.mjs` ほか)は Apache License 2.0 です。
詳細は [`extension/THIRD_PARTY_NOTICES.md`](extension/THIRD_PARTY_NOTICES.md) を参照してください。
