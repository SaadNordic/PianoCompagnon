@echo off
title Piano Compagnon - Mise a jour du serveur 192.168.1.240
:: Met a jour l'API, le SDK Claude (libs) et la version web (navigateur du PC).
set SERVER=\\192.168.1.240\c\PianoCompagnon
set PY=C:\NordicTimber_WebPlatform\backend\venv\Scripts\python.exe
cd /d "%~dp0"
if not exist libs\anthropic "%PY%" -m pip install --quiet --target libs anthropic
echo Version web...
cd /d "%~dp0.."
call npm run build || goto fin
echo Arret du service...
schtasks /end /s 192.168.1.240 /tn "PianoCompagnon" >nul 2>&1
timeout /t 8 /nobreak >nul
echo Copie...
robocopy "%~dp0." "%SERVER%\serveur" /E /XF .env piano.db piano.log *.pyc /XD __pycache__ /NJH /NJS /NP
robocopy "%~dp0..\dist" "%SERVER%\web" /MIR /NJH /NJS /NP
"%PY%" "%~dp0preparer.py"
schtasks /run /s 192.168.1.240 /tn "PianoCompagnon"
timeout /t 8 /nobreak >nul
powershell -NoProfile -Command "try { (Invoke-RestMethod http://192.168.1.240:8010/api/ping -TimeoutSec 8) | ConvertTo-Json -Compress } catch { 'API injoignable : ' + $_.Exception.Message }"
:fin
pause
