# setup-wsl.ps1 — 在 Windows 11 上啟用 WSL2 並安裝 Ubuntu 22.04
# 以「系統管理員身分執行 PowerShell」執行此腳本
#
# 用法：
#   以管理員身分開啟 PowerShell，執行：
#   Set-ExecutionPolicy Bypass -Scope Process -Force
#   .\scripts\setup-wsl.ps1

$ErrorActionPreference = "Stop"

Write-Host "=== BNI-Masta Windows 環境設定 ===" -ForegroundColor Cyan
Write-Host ""

# 1. 檢查是否以管理員身分執行
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "✗ 請以「系統管理員身分」執行此腳本" -ForegroundColor Red
    Write-Host "  右鍵 PowerShell → 以系統管理員身分執行"
    exit 1
}

# 2. 啟用 WSL 功能
Write-Host "── Step 1：啟用 WSL 功能 ──" -ForegroundColor Yellow
$wslFeature = Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux
if ($wslFeature.State -ne "Enabled") {
    Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux -NoRestart
    Write-Host "  ✓ WSL 功能已啟用"
} else {
    Write-Host "  · WSL 功能已存在"
}

# 3. 啟用虛擬機器平台（WSL2 必須）
Write-Host ""
Write-Host "── Step 2：啟用虛擬機器平台 ──" -ForegroundColor Yellow
$vmFeature = Get-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform
if ($vmFeature.State -ne "Enabled") {
    Enable-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform -NoRestart
    Write-Host "  ✓ VirtualMachinePlatform 已啟用"
} else {
    Write-Host "  · VirtualMachinePlatform 已存在"
}

# 4. 設定 WSL 預設版本為 2
Write-Host ""
Write-Host "── Step 3：設定 WSL 預設版本為 2 ──" -ForegroundColor Yellow
wsl --set-default-version 2 2>&1 | Out-Null
Write-Host "  ✓ 預設版本 = 2"

# 5. 安裝 Ubuntu 22.04
Write-Host ""
Write-Host "── Step 4：安裝 Ubuntu 22.04 ──" -ForegroundColor Yellow
$distros = wsl --list --quiet 2>&1
if ($distros -match "Ubuntu-22.04") {
    Write-Host "  · Ubuntu 22.04 已安裝"
} else {
    Write-Host "  正在安裝 Ubuntu 22.04（需要網路，約 500MB）..."
    wsl --install -d Ubuntu-22.04
    Write-Host "  ✓ Ubuntu 22.04 安裝完成"
}

# 6. 提示後續步驟
Write-Host ""
Write-Host "=== 設定完成 ===" -ForegroundColor Green
Write-Host ""
Write-Host "後續步驟：" -ForegroundColor Cyan
Write-Host "  1. 重新開機（如果剛才啟用了 WSL 功能）"
Write-Host "  2. 開啟 Ubuntu 22.04（開始功能表搜尋），設定 Linux 使用者名稱與密碼"
Write-Host "  3. 進入 Ubuntu 後，執行安裝腳本："
Write-Host ""

# 計算 repo 在 WSL2 內的路徑
$repoPath = Split-Path -Parent $PSScriptRoot
$wslPath = $repoPath -replace "\\", "/" -replace "^([A-Za-z]):", '/mnt/$1'.ToLower()
$driveLetter = $repoPath.Substring(0,1).ToLower()
$wslPath = "/mnt/$driveLetter" + ($repoPath.Substring(2) -replace "\\", "/")

Write-Host "     cd `"$wslPath`"" -ForegroundColor White
Write-Host "     bash scripts/install-wsl.sh" -ForegroundColor White
Write-Host ""
Write-Host "  4. 照 SETUP.md 申請 OpenRouter、Cloudflare、Google OAuth"
