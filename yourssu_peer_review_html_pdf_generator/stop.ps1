$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidFile = Join-Path $root ".server.pid"
$expectedNode = [System.IO.Path]::GetFullPath((Join-Path $root "runtime\node\node.exe"))

if (-not (Test-Path -LiteralPath $pidFile)) {
    Write-Host "실행 중인 서버 기록이 없습니다."
    exit 0
}

$serverPid = [int](Get-Content -LiteralPath $pidFile -Raw)
$process = Get-Process -Id $serverPid -ErrorAction SilentlyContinue
if ($null -ne $process) {
    $actualPath = [System.IO.Path]::GetFullPath($process.Path)
    if ($actualPath -ne $expectedNode) {
        throw "PID가 이 프로그램의 Node.js와 일치하지 않아 종료하지 않았습니다."
    }
    Stop-Process -Id $serverPid -Force
}
Remove-Item -LiteralPath $pidFile -Force
Write-Host "피어리뷰 생성기 서버를 종료했습니다."

