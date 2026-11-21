@echo off
title Piano Compagnon - Comptes
:: Exemples :  comptes.bat ajouter saad "Saad"     comptes.bat motdepasse saad     comptes.bat liste
cd /d "%~dp0"
"C:\NordicTimber_WebPlatform\backend\venv\Scripts\python.exe" utilisateurs.py %*
pause
