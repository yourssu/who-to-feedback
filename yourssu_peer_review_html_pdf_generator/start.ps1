$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = Join-Path $root "runtime\node\node.exe"
$server = Join-Path $root "app\server.js"
$logs = Join-Path $root "logs"
$pidFile = Join-Path $root ".server.pid"
$selectedPort = $null

function Test-GeneratorServer([int]$port) {
    try {
        $response = Invoke-RestMethod -Uri "http://localhost:$port/api/health" -TimeoutSec 1
        return $response.ok -eq $true -and $response.app -eq "yourssu-peer-review-generator"
    } catch {
        return $false
    }
}

function Test-PortInUse([int]$port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $task = $client.ConnectAsync("127.0.0.1", $port)
        if (-not $task.Wait(250)) { return $false }
        return $client.Connected
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

if (-not (Test-Path -LiteralPath $node)) {
    throw "내장 Node.js를 찾을 수 없습니다: $node"
}

foreach ($port in 8765..8775) {
    if (Test-GeneratorServer $port) {
        $selectedPort = $port
        break
    }
    if (-not (Test-PortInUse $port)) {
        $selectedPort = $port
        break
    }
}

if ($null -eq $selectedPort) {
    throw "사용 가능한 포트가 없습니다. 8765~8775 포트를 확인해 주세요."
}

$url = "http://localhost:$selectedPort/"

if (-not (Test-GeneratorServer $selectedPort)) {
    New-Item -ItemType Directory -Force -Path $logs | Out-Null
    $stdout = Join-Path $logs "server-output.log"
    $stderr = Join-Path $logs "server-error.log"
    $previousPort = $env:PORT
    $env:PORT = [string]$selectedPort
    $process = Start-Process -FilePath $node `
        -ArgumentList @($server) `
        -WorkingDirectory $root `
        -WindowStyle Hidden `
        -RedirectStandardOutput $stdout `
        -RedirectStandardError $stderr `
        -PassThru
    $env:PORT = $previousPort
    Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding ascii

    $ready = $false
    for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
        Start-Sleep -Milliseconds 250
        if (Test-GeneratorServer $selectedPort) {
            $ready = $true
            break
        }
        if ($process.HasExited) {
            throw "서버가 시작 중 종료되었습니다. logs 폴더를 확인해 주세요."
        }
    }
    if (-not $ready) {
        throw "서버 시작 시간이 초과되었습니다. logs 폴더를 확인해 주세요."
    }
}

Start-Process $url
