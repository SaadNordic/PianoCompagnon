@echo off
title Piano Compagnon - Mise a jour de l'API sur 192.168.1.240
set SERVER=\192.168.1.240\c\PianoCompagnon\serveur
schtasks /end /s 192.168.1.240 /tn "PianoCompagnon" >nul 2>&1
timeout /t 8 /nobreak >nul
robocopy "%~dp0." "%SERVER%" /E /XF .env piano.db piano.log *.pyc /XD __pycache__ /NJH /NJS /NP
schtasks /run /s 192.168.1.240 /tn "PianoCompagnon"
timeout /t 6 /nobreak >nul
powershell -NoProfile -Command "try { (Invoke-RestMethod http://192.168.1.240:8010/api/ping -TimeoutSec 8) | ConvertTo-Json -Compress } catch { 'API injoignable : ' + $_.Exception.Message }"
pause
