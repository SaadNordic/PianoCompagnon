@echo off
:: Lance l'API Piano Compagnon (tache planifiee "PianoCompagnon", au demarrage du serveur, compte Systeme).
:: Utilise l'environnement Python de NT (fastapi, uvicorn, pyodbc deja installes).
cd /d C:\PianoCompagnon\serveur
"C:\NordicTimber_WebPlatform\backend\venv\Scripts\python.exe" -m uvicorn main:app --host 0.0.0.0 --port 8010 >> C:\PianoCompagnon\serveur\piano.log 2>&1
