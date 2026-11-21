@echo off
title Piano Compagnon - Installation sur 192.168.1.240
:: A lancer UNE fois depuis le PC. Cree la base, copie l'API, cree la tache planifiee et ouvre le port 8010.
set SERVER=\\192.168.1.240\c\PianoCompagnon\serveur
choice /c ON /m "Installer Piano Compagnon sur le serveur 192.168.1.240 ? (O=Oui N=Non)"
if errorlevel 2 goto fin

echo [1/5] Copie de l'API...
robocopy "%~dp0." "%SERVER%" /E /XF .env piano.db piano.log *.pyc /XD __pycache__ /NJH /NJS /NP
if errorlevel 8 ( echo [ERREUR] Copie impossible. & goto fin )

echo [2/5] Base de donnees...
"C:\NordicTimber_WebPlatform\backend\venv\Scripts\python.exe" "%~dp0preparer.py" || goto fin

echo [3/5] Tache planifiee PianoCompagnon (au demarrage, compte Systeme)...
schtasks /create /s 192.168.1.240 /tn "PianoCompagnon" /tr "C:\PianoCompagnon\serveur\_run_piano.bat" /sc onstart /ru SYSTEM /rl HIGHEST /f || goto fin

echo [4/5] Pare-feu : la regle du port 8010 est creee par la tache au demarrage.

echo [5/5] Demarrage...
schtasks /run /s 192.168.1.240 /tn "PianoCompagnon"
timeout /t 6 /nobreak >nul
powershell -NoProfile -Command "try { (Invoke-RestMethod http://192.168.1.240:8010/api/ping -TimeoutSec 8) | ConvertTo-Json -Compress } catch { 'API pas encore joignable : ' + $_.Exception.Message }"
echo.
echo Etape suivante : creer les comptes avec comptes.bat
:fin
pause
