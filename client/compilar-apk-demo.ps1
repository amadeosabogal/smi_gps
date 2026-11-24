# Compila el APK de la DEMO (demo.woditek.com): otra direccion, otro nombre y otro identificador que la app de SMI,
# asi que ambas se pueden instalar en el mismo celular. No modifica ningun archivo del proyecto.
#
# Uso (PowerShell, desde la carpeta client):
#   .\compilar-apk-demo.ps1
#   .\compilar-apk-demo.ps1 -Marca "Mi Demo"        (nombre que se muestra dentro de la app; usar el mismo de la demo web)
#
# Resultado: android\app\build\outputs\apk\release\demo-gps.apk
#
# IMPORTANTE: despues de compilar la demo, para volver a compilar SMI usa los pasos normales de DESPLIEGUE.md
# (vite build con la direccion de SMI + cap sync + assembleRelease), porque este script deja en el proyecto la
# version web de la demo (carpetas dist y android\app\src\main\assets, que no van a git).
param(
  [string]$Url = 'https://demo.woditek.com',
  [string]$Marca = 'Demo',
  [string]$AppId = 'pe.woditek.gpsdemo',
  [string]$Nombre = 'Demo GPS Asistencia'
)
# 'Continue': Vite y Gradle escriben avisos por stderr y PowerShell 5.1 no debe tratarlos como error;
# los fallos reales se detectan con $LASTEXITCODE.
$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot

if (-not $env:JAVA_HOME) { $env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr' }
if (-not (Test-Path (Join-Path $env:JAVA_HOME 'bin\java.exe'))) { throw "No se encontro Java en JAVA_HOME ($env:JAVA_HOME). Instala Android Studio o ajusta JAVA_HOME." }
if (-not (Test-Path 'android\keystore.properties')) { throw 'Falta android\keystore.properties (la llave de firma). Sin ella el APK queda sin firmar y no se puede instalar.' }

# Variables solo para este proceso
$env:VITE_API_BASE_URL = $Url
$env:VITE_BRAND_NAME = $Marca
$env:APP_ID = $AppId
$env:APP_NAME = $Nombre

Write-Host "1/3 Compilando la web para $Url ..." -ForegroundColor Cyan
npx vite build
if ($LASTEXITCODE -ne 0) { throw 'Fallo vite build' }

Write-Host '2/3 Copiando la web a la app Android ...' -ForegroundColor Cyan
npx cap sync android
if ($LASTEXITCODE -ne 0) { throw 'Fallo cap sync' }

Write-Host '3/3 Compilando y firmando el APK ...' -ForegroundColor Cyan
Set-Location android
.\gradlew.bat assembleRelease "-PappId=$AppId" "-PappName=$Nombre" "-PappBrand=$Marca" --no-daemon
if ($LASTEXITCODE -ne 0) { throw 'Fallo gradle assembleRelease' }

$salida = 'app\build\outputs\apk\release'
# Se renombra (no se copia) para que no quede un app-release.apk de la demo que se pueda subir por error como el de SMI
Move-Item "$salida\app-release.apk" "$salida\demo-gps.apk" -Force
Write-Host ''
Write-Host "Listo: $(Resolve-Path "$salida\demo-gps.apk")" -ForegroundColor Green
