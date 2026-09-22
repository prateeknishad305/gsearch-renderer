#Requires -RunAsAdministrator
$ErrorActionPreference = "Stop"

$AppDir = "C:\apps\gsearch-renderer"
$NssmDir = "C:\apps\nssm"
$LogDir = "$AppDir\logs"
$Port = 3000
$Repo = "https://github.com/prateeknishad305/gsearch-renderer.git"
$Chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$Chrome86 = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
$NodeExe = "C:\Program Files\nodejs\node.exe"

function Need-Command($name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

Write-Host "gsearch-renderer Windows RDP 24/7 setup"

powercfg /change standby-timeout-ac 0 | Out-Null
powercfg /change hibernate-timeout-ac 0 | Out-Null
powercfg /hibernate off | Out-Null

if (-not (Need-Command winget)) {
  throw "winget not found. Install App Installer from Microsoft Store, or install Node/Git/Chrome manually, then re-run."
}

if (-not (Need-Command node)) {
  Write-Host "Installing Node.js LTS"
  winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
}
if (-not (Need-Command git)) {
  Write-Host "Installing Git"
  winget install -e --id Git.Git --accept-package-agreements --accept-source-agreements
}
if (-not (Test-Path $Chrome) -and -not (Test-Path $Chrome86)) {
  Write-Host "Installing Google Chrome"
  winget install -e --id Google.Chrome --accept-package-agreements --accept-source-agreements
}

$env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")

if (-not (Need-Command node)) { throw "node still not on PATH. Close PowerShell, open a new Administrator window, re-run this script." }
if (-not (Need-Command git)) { throw "git still not on PATH. Open a new Administrator PowerShell and re-run." }

New-Item -ItemType Directory -Force -Path "C:\apps" | Out-Null
if (-not (Test-Path $AppDir)) {
  git clone $Repo $AppDir
} else {
  Push-Location $AppDir
  git pull
  Pop-Location
}

Push-Location $AppDir
npm install
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

if (Test-Path $Chrome) { $ChromePath = $Chrome } else { $ChromePath = $Chrome86 }

$Token = -join ((48..57 + 65..90 + 97..122) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
@"
PORT=$Port
HOST=0.0.0.0
NODE_ENV=production
CHROMIUM_SOURCE=system
CHROMIUM_PATH=$ChromePath
BROWSER_REUSE=1
API_TOKEN=$Token
PROXY_FETCH=1
"@ | Set-Content -Path "$AppDir\.env" -Encoding ASCII

Pop-Location

if (-not (Test-Path "$NssmDir\nssm.exe")) {
  Write-Host "Downloading NSSM"
  $zip = "$env:TEMP\nssm.zip"
  Invoke-WebRequest -Uri "https://nssm.cc/release/nssm-2.24.zip" -OutFile $zip
  Expand-Archive -Path $zip -DestinationPath "$env:TEMP\nssm" -Force
  New-Item -ItemType Directory -Force -Path $NssmDir | Out-Null
  Copy-Item "$env:TEMP\nssm\nssm-2.24\win64\nssm.exe" "$NssmDir\nssm.exe" -Force
}

netsh advfirewall firewall delete rule name="gsearch-renderer" | Out-Null
netsh advfirewall firewall add rule name="gsearch-renderer" dir=in action=allow protocol=TCP localport=$Port | Out-Null

$nssm = "$NssmDir\nssm.exe"
& $nssm stop gsearch-renderer 2>$null
& $nssm remove gsearch-renderer confirm 2>$null
& $nssm install gsearch-renderer $NodeExe server.js
& $nssm set gsearch-renderer AppDirectory $AppDir
& $nssm set gsearch-renderer AppStdout "$LogDir\stdout.log"
& $nssm set gsearch-renderer AppStderr "$LogDir\stderr.log"
& $nssm set gsearch-renderer AppRotateFiles 1
& $nssm set gsearch-renderer AppRotateBytes 10485760
& $nssm set gsearch-renderer Start SERVICE_AUTO_START
& $nssm set gsearch-renderer AppRestartDelay 5000
& $nssm start gsearch-renderer

Start-Sleep -Seconds 3
try {
  $health = Invoke-RestMethod "http://127.0.0.1:$Port/api/health"
  Write-Host "health ok=$($health.ok) runtime=$($health.runtime.chromium_source)"
} catch {
  Write-Host "service started; health not ready yet. Check $LogDir\stderr.log"
}

Write-Host "API_TOKEN=$Token"
Write-Host "local: http://127.0.0.1:$Port/api/health"
Write-Host "RENDERER_URL=http://127.0.0.1:$Port"
Write-Host "service: nssm status gsearch-renderer"
