@echo off
:: Lance l'API Piano Compagnon (tache planifiee "PianoCompagnon", au demarrage du serveur, compte Systeme).
:: Utilise l'environnement Python de NT (fastapi, uvicorn, pyodbc deja installes).
cd /d C:\PianoCompagnon\serveur
:: ouvre le port 8010 au pare-feu si la regle n'existe pas encore
netsh advfirewall firewall show rule name="Piano Compagnon 8010" >nul 2>&1 || netsh advfirewall firewall add rule name="Piano Compagnon 8010" dir=in action=allow protocol=TCP localport=8010 >nul
"C:\NordicTimber_WebPlatform\backend\venv\Scripts\python.exe" -m uvicorn main:app --host 0.0.0.0 --port 8010 >> C:\PianoCompagnon\serveur\piano.log 2>&1
