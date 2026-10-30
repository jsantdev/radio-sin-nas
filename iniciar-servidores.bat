@echo off
setlocal

for %%I in ("%~dp0.") do set "PROJECT_ROOT=%%~fI"
set "WEBSERVER_PORT=80"
if not defined STARTUP_TIMEOUT_SECONDS set "STARTUP_TIMEOUT_SECONDS=120"
echo Tiempo maximo de inicio por servicio: %STARTUP_TIMEOUT_SECONDS% segundos.

echo Comprobando requisitos generales...
where node >nul 2>&1
if errorlevel 1 goto :missing_runtime
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 18 ? 0 : 1)" >nul 2>&1
if errorlevel 1 goto :missing_runtime
where npm >nul 2>&1
if errorlevel 1 goto :missing_runtime

if not exist "%PROJECT_ROOT%\package.json" (
  echo Error: no se encontro "%PROJECT_ROOT%\package.json".
  echo Carpeta del iniciador: %~dp0
  echo Verifica que package.json este junto a iniciar-servidores.bat.
  goto :failure
)
if not exist "%PROJECT_ROOT%\server.js" (
  echo Error: no se encontro el servidor web.
  goto :failure
)
if not exist "%PROJECT_ROOT%\public\index.html" (
  echo Error: no se encontro la pagina del panel.
  goto :failure
)

echo Comprobando dependencias del servidor de radio...
pushd "%PROJECT_ROOT%"
call :check_dependencies
if errorlevel 1 (
  popd
  goto :failure
)
popd

echo Liberando el puerto del servidor...
call :free_port "%WEBSERVER_PORT%"
if errorlevel 1 goto :failure

echo Iniciando servidor de radio...
start "Radio TikTok Live" /D "%PROJECT_ROOT%" cmd /k "echo [%date% %time%] [Radio TikTok Live] Directorio: %PROJECT_ROOT%&&echo [Radio TikTok Live] Puerto: %WEBSERVER_PORT%&&echo [Radio TikTok Live] Radio: / - Playlist: /playlist&&echo [Radio TikTok Live] Conector TikTok integrado&&echo [Radio TikTok Live] Ejecutando npm start...&&set PORT=%WEBSERVER_PORT%&&npm start"
call :wait_for_endpoint "Servidor integrado" "http://127.0.0.1:%WEBSERVER_PORT%/api/status"
if errorlevel 1 (
  echo Error: el servidor integrado no respondio despues de %STARTUP_TIMEOUT_SECONDS% segundos.
  goto :failure
)

echo.
echo La radio esta lista:
echo Radio: http://localhost:%WEBSERVER_PORT%/
echo Playlist: http://localhost:%WEBSERVER_PORT%/playlist
echo Panel TikTok: http://localhost:%WEBSERVER_PORT%/backend
call :open_chrome "http://localhost:%WEBSERVER_PORT%/" "http://localhost:%WEBSERVER_PORT%/playlist"
exit /b 0

:check_dependencies
call npm ls --depth=0 >nul 2>&1
if not errorlevel 1 exit /b 0
echo Dependencias incompletas; intentando instalarlas...
if exist package-lock.json (
  call npm ci
) else (
  call npm install
)
if errorlevel 1 (
  echo Error: no se pudieron instalar las dependencias en %CD%.
  exit /b 1
)
call npm ls --depth=0 >nul 2>&1
if errorlevel 1 (
  echo Error: las dependencias siguen incompletas en %CD%.
  exit /b 1
)
exit /b 0

:free_port
set "PORT_TO_CHECK=%~1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$p = 0; if (-not [int]::TryParse($env:PORT_TO_CHECK, [ref]$p) -or $p -lt 1 -or $p -gt 65535) { Write-Error 'El puerto debe ser un numero entre 1 y 65535.'; exit 1 }; $connections = @(Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue); $owners = @($connections | Select-Object -ExpandProperty OwningProcess -Unique); foreach ($owner in $owners) { if ($owner -in @(0, 4)) { Write-Error ('No se puede liberar el puerto {0}: pertenece al sistema (PID {1}).' -f $p, $owner); exit 1 }; Write-Host ('Cerrando PID {0} que ocupa el puerto {1}...' -f $owner, $p); Stop-Process -Id $owner -Force -ErrorAction Stop }; $deadline = (Get-Date).AddSeconds(10); while (@(Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue).Count -gt 0) { if ((Get-Date) -ge $deadline) { Write-Error ('El puerto {0} sigue ocupado.' -f $p); exit 1 }; Start-Sleep -Milliseconds 250 }; exit 0"
exit /b %errorlevel%

:wait_for_endpoint
set "WAIT_LABEL=%~1"
set "WAIT_URL=%~2"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$label = $env:WAIT_LABEL; $url = $env:WAIT_URL; $limit = 0; if (-not [int]::TryParse($env:STARTUP_TIMEOUT_SECONDS, [ref]$limit) -or $limit -lt 1) { Write-Error 'STARTUP_TIMEOUT_SECONDS debe ser un numero mayor que cero.'; exit 2 }; $timer = [Diagnostics.Stopwatch]::StartNew(); Write-Host ('[{0}] Esperando respuesta en {1} (limite: {2}s)...' -f $label, $url, $limit); while ($timer.Elapsed.TotalSeconds -lt $limit) { try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 $url; if ($r.StatusCode -eq 200) { Write-Host ('[{0}] Listo: HTTP {1}, espera total {2}s.' -f $label, $r.StatusCode, [math]::Floor($timer.Elapsed.TotalSeconds)); exit 0 }; Write-Host ('[{0}] HTTP {1} tras {2}s; reintentando...' -f $label, $r.StatusCode, [math]::Floor($timer.Elapsed.TotalSeconds)) } catch { Write-Host ('[{0}] Aun no responde tras {1}s: {2}' -f $label, [math]::Floor($timer.Elapsed.TotalSeconds), $_.Exception.Message) }; Start-Sleep -Seconds 1 }; Write-Host ('[{0}] Tiempo agotado: no respondio en {1}s.' -f $label, $limit); exit 1"
exit /b %errorlevel%

:open_chrome
set "CHROME_EXE="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME_EXE=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined CHROME_EXE if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME_EXE=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined CHROME_EXE if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "CHROME_EXE=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if defined CHROME_EXE (
  if "%~3"=="" (
    start "" "%CHROME_EXE%" --new-window "%~1" "%~2"
  ) else (
    start "" "%CHROME_EXE%" --new-window "%~1" "%~2" "%~3"
  )
  exit /b 0
)
where chrome.exe >nul 2>&1
if not errorlevel 1 (
  start "" chrome.exe --new-window "%~1" "%~2" "%~3"
  exit /b 0
)
echo Advertencia: no se encontro Google Chrome. Abre estas direcciones manualmente:
echo %~1
echo %~2
echo %~3
exit /b 0

:missing_runtime
echo Error: se requieren Node.js 18 o posterior y npm.
goto :failure

:failure
echo.
echo No se iniciaron los servidores porque fallo una comprobacion.
pause
exit /b 1
