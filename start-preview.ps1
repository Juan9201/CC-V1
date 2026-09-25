# Abre las dos vistas de subtítulos animados. No toca la app del puerto 3000.
# 3001 procesa el lote solo. 3002 es la misma app con la pantalla de revisión.
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$backend = Join-Path $root "backend"
$frontend = Join-Path $root "frontend"
$uvicorn = Join-Path $backend ".venv\Scripts\uvicorn.exe"
$npm = "C:\Program Files\nodejs\npm.cmd"

function Test-Port([int] $port) {
    return [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

function Start-Next([int] $port) {
    if (Test-Port $port) {
        return
    }
    $command = "`$env:NEXT_DIST_DIR='.next-$port'; & '$npm' run dev -- -p $port"
    Start-Process -FilePath "powershell.exe" -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-Command",$command -WorkingDirectory $frontend -WindowStyle Minimized
}

Write-Host "Abriendo subtítulos animados..."

if (-not (Test-Port 8001)) {
    if (-not (Test-Path $uvicorn)) {
        Write-Host "No está el entorno de Python en $backend"
        Read-Host "Enter para cerrar"
        exit 1
    }
    Start-Process -FilePath $uvicorn -ArgumentList "app.main:app","--host","127.0.0.1","--port","8001" -WorkingDirectory $backend -WindowStyle Minimized
}

Start-Next 3001
Start-Next 3002

$ready = $false
for ($i = 0; $i -lt 40; $i++) {
    if ((Test-Port 3001) -and (Test-Port 3002) -and (Test-Port 8001)) {
        $ready = $true
        break
    }
    Start-Sleep -Seconds 1
}

Start-Process "http://localhost:3002"
if ($ready) {
    Write-Host "Revision en http://localhost:3002"
    Write-Host "Sin revision en http://localhost:3001"
} else {
    Write-Host "La página se abrió. Si tarda, espera unos segundos y recarga."
}
Start-Sleep -Seconds 2
