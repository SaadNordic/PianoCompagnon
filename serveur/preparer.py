"""Prépare le serveur Piano Compagnon (lancé par installer_serveur.bat depuis le PC).

- écrit .env (base PianoCompagnon, mêmes identifiants SQL que NT) ici et sur le serveur ;
- crée la base PianoCompagnon et ses tables si besoin.
Aucun mot de passe n'est affiché.
"""
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
NT_ENV = Path(r"C:\NordicTimber_WebPlatform\backend\.env.server")
SERVER_DIR = Path(r"\\192.168.1.240\c\PianoCompagnon\serveur")


def read_env(p: Path) -> dict:
    out = {}
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def main() -> None:
    nt = read_env(NT_ENV)
    for k in ("DB_SERVER", "DB_USER", "DB_PASS"):
        if not nt.get(k):
            sys.exit(f"[ERREUR] {k} absent de {NT_ENV}")
    env = f"DB_KIND=mssql\nDB_SERVER={nt['DB_SERVER']}\nDB_NAME=PianoCompagnon\nDB_USER={nt['DB_USER']}\nDB_PASS={nt['DB_PASS']}\n"
    # clé Claude : celle des applis ND / NT (lecture des PDF et photos côté serveur)
    key = ""
    for src in (Path(r"C:\NordicTimber_WebPlatform\backend\.env"), Path(r"C:\ND_WebPlatform\backend\.env")):
        if src.exists():
            key = read_env(src).get("ANTHROPIC_API_KEY", "")
            if key:
                break
    if key:
        env += f"ANTHROPIC_API_KEY={key}\n"
    print("Cle Claude : " + ("ajoutee" if key else "INTROUVABLE"))
    (HERE / ".env").write_text(env, encoding="utf-8")
    if SERVER_DIR.exists():
        (SERVER_DIR / ".env").write_text(env, encoding="utf-8")
    print(".env ecrit (PC et serveur).")

    import pyodbc
    con = pyodbc.connect(
        "DRIVER={ODBC Driver 17 for SQL Server};"
        f"SERVER={nt['DB_SERVER']};DATABASE=master;UID={nt['DB_USER']};PWD={nt['DB_PASS']};",
        autocommit=True,
    )
    con.cursor().execute("IF DB_ID('PianoCompagnon') IS NULL CREATE DATABASE PianoCompagnon")
    con.close()
    print("Base PianoCompagnon prete.")

    os.environ.update({"DB_KIND": "mssql", "DB_NAME": "PianoCompagnon"})
    sys.path.insert(0, str(HERE))
    import main as api
    api.init_db()
    print("Tables pretes.")


if __name__ == "__main__":
    main()
