# extension/ フォルダを配布用ZIPにまとめる。
# 出力名は常に固定: dist\pdf-to-html-extension.zip
# 失敗しても既存ZIPを壊さないよう、一時ファイルに作ってから置き換える。
# 完了後は出力フォルダ(dist)を自動で開く。

$root = $PSScriptRoot
$src = Join-Path $root 'extension'
$distDir = Join-Path $root 'dist'
$zip = Join-Path $distDir 'pdf-to-html-extension.zip'
$tmp = Join-Path $distDir '_building.zip'

try {
    if (-not (Test-Path (Join-Path $src 'manifest.json'))) {
        throw "extension\manifest.json が見つかりません。build_extension.ps1 はプロジェクト直下に置いてください。"
    }
    New-Item -ItemType Directory -Force $distDir | Out-Null
    if (Test-Path $tmp) { Remove-Item $tmp -Force }

    # まず一時ファイルに作成し、成功したときだけ本番ファイルを置き換える(原子的)
    Compress-Archive -Path (Join-Path $src '*') -DestinationPath $tmp -ErrorAction Stop
    Move-Item -Force $tmp $zip

    # 古いバージョン番号付きZIPが残っていれば掃除
    Get-ChildItem $distDir -Filter 'pdf-to-html-extension-v*.zip' -ErrorAction SilentlyContinue |
        Remove-Item -Force

    # Chromeが読み込んでいるインストール先フォルダにも同期する。
    # 場所は local_config.json (Git管理外) の "install_dir" で指定 (未指定なら同期しない)
    $installed = $null
    $cfgPath = Join-Path $root 'local_config.json'
    if (Test-Path $cfgPath) {
        $installed = (Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json).install_dir
    }
    $synced = $false
    if ($installed -and (Test-Path $installed)) {
        robocopy $src $installed /MIR /NFL /NDL /NJH /NJS | Out-Null
        $synced = $true
    }

    $version = (Get-Content (Join-Path $src 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
    $sizeMB = [math]::Round((Get-Item $zip).Length / 1MB, 2)
    Write-Host ""
    Write-Host "===== 作成に成功しました =====" -ForegroundColor Green
    Write-Host "  ファイル: $zip"
    Write-Host "  バージョン: $version   サイズ: $sizeMB MB"
    Write-Host ""
    Write-Host "  このZIPを共有・上書きするだけで更新できます(ファイル名は固定)。"
    if ($synced) { Write-Host "  インストール先 ($installed) も同期済み。chrome://extensions で ↻ を押してください。" -ForegroundColor Cyan }
    Write-Host "  出力フォルダを開きます..."
    try { Start-Process explorer.exe $distDir } catch {}
}
catch {
    if (Test-Path $tmp) { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
    Write-Host ""
    Write-Host "===== 作成に失敗しました =====" -ForegroundColor Red
    Write-Host "  $($_.Exception.Message)"
    Write-Host "  (既存のZIPがあればそのまま残しています)"
}
