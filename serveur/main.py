"""Piano Compagnon - API de synchronisation multi-utilisateur.

Chaque utilisateur a son propre répertoire (partitions + codification PCN), ses originaux
(photos / PDF) et sa progression. L'appli garde une copie locale et se synchronise ici
dès que le serveur est joignable (VPN).

Base : SQL Server en production (DB_KIND=mssql), SQLite pour les essais (DB_KIND=sqlite).
Lancement : uvicorn main:app --host 0.0.0.0 --port 8010
"""
from __future__ import annotations

import hashlib
import json
import os
import secrets
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

VERSION = "1.0.0"
HERE = Path(__file__).resolve().parent
import sys  # noqa: E402
if (HERE / "libs").is_dir():
    sys.path.append(str(HERE / "libs"))  # paquets propres au piano (SDK Anthropic)


def _load_env() -> None:
    env = HERE / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())


_load_env()
DB_KIND = os.environ.get("DB_KIND", "sqlite")
SESSION_DAYS = 90
MS_DAY = 86_400_000

# ---------------------------------------------------------------- base de données

if DB_KIND == "mssql":
    import pyodbc  # noqa: E402

    def _connect():
        return pyodbc.connect(
            "DRIVER={ODBC Driver 17 for SQL Server};"
            f"SERVER={os.environ['DB_SERVER']};DATABASE={os.environ['DB_NAME']};"
            f"UID={os.environ['DB_USER']};PWD={os.environ['DB_PASS']};",
            autocommit=False,
        )

    SCHEMA = [
        """IF OBJECT_ID('pc_users') IS NULL CREATE TABLE pc_users (
            id INT IDENTITY(1,1) PRIMARY KEY, login NVARCHAR(50) NOT NULL UNIQUE, name NVARCHAR(100) NOT NULL,
            salt NVARCHAR(64) NOT NULL, hash NVARCHAR(128) NOT NULL, created BIGINT NOT NULL)""",
        """IF OBJECT_ID('pc_sessions') IS NULL CREATE TABLE pc_sessions (
            token_hash NVARCHAR(64) PRIMARY KEY, user_id INT NOT NULL, expires BIGINT NOT NULL)""",
        """IF OBJECT_ID('pc_pieces') IS NULL CREATE TABLE pc_pieces (
            user_id INT NOT NULL, id NVARCHAR(64) NOT NULL, data NVARCHAR(MAX) NULL, updated BIGINT NOT NULL,
            deleted INT NOT NULL DEFAULT 0, rev BIGINT NOT NULL, PRIMARY KEY (user_id, id))""",
        """IF OBJECT_ID('pc_kv') IS NULL CREATE TABLE pc_kv (
            user_id INT NOT NULL, k NVARCHAR(100) NOT NULL, v NVARCHAR(MAX) NULL, updated BIGINT NOT NULL,
            rev BIGINT NOT NULL, PRIMARY KEY (user_id, k))""",
        """IF OBJECT_ID('pc_originals') IS NULL CREATE TABLE pc_originals (
            user_id INT NOT NULL, piece_id NVARCHAR(64) NOT NULL, idx INT NOT NULL, name NVARCHAR(255) NOT NULL,
            type NVARCHAR(100) NOT NULL, data NVARCHAR(MAX) NOT NULL, PRIMARY KEY (user_id, piece_id, idx))""",
    ]
else:
    _DB_PATH = os.environ.get("SQLITE_PATH", str(HERE / "piano.db"))

    def _connect():
        return sqlite3.connect(_DB_PATH)

    SCHEMA = [
        """CREATE TABLE IF NOT EXISTS pc_users (id INTEGER PRIMARY KEY AUTOINCREMENT, login TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL, created INTEGER NOT NULL)""",
        """CREATE TABLE IF NOT EXISTS pc_sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL,
            expires INTEGER NOT NULL)""",
        """CREATE TABLE IF NOT EXISTS pc_pieces (user_id INTEGER NOT NULL, id TEXT NOT NULL, data TEXT,
            updated INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, rev INTEGER NOT NULL, PRIMARY KEY (user_id, id))""",
        """CREATE TABLE IF NOT EXISTS pc_kv (user_id INTEGER NOT NULL, k TEXT NOT NULL, v TEXT,
            updated INTEGER NOT NULL, rev INTEGER NOT NULL, PRIMARY KEY (user_id, k))""",
        """CREATE TABLE IF NOT EXISTS pc_originals (user_id INTEGER NOT NULL, piece_id TEXT NOT NULL, idx INTEGER NOT NULL,
            name TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (user_id, piece_id, idx))""",
    ]


@contextmanager
def db():
    con = _connect()
    try:
        yield con.cursor()
        con.commit()
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()


def init_db() -> None:
    with db() as cur:
        for stmt in SCHEMA:
            cur.execute(stmt)
        if DB_KIND == "mssql":
            cur.execute("IF COL_LENGTH('pc_users', 'admin') IS NULL ALTER TABLE pc_users ADD admin INT NOT NULL DEFAULT 0")
    if DB_KIND != "mssql":
        try:
            with db() as cur:
                cur.execute("ALTER TABLE pc_users ADD COLUMN admin INTEGER NOT NULL DEFAULT 0")
        except sqlite3.OperationalError:
            pass  # colonne déjà présente


def now_ms() -> int:
    return int(time.time() * 1000)


# ---------------------------------------------------------------- mots de passe

def hash_password(password: str, salt: str | None = None) -> tuple[str, str]:
    salt = salt or secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), 200_000)
    return salt, dk.hex()


def create_user(login: str, name: str, password: str, admin: bool = False) -> None:
    salt, h = hash_password(password)
    with db() as cur:
        cur.execute("INSERT INTO pc_users (login, name, salt, hash, created, admin) VALUES (?, ?, ?, ?, ?, ?)",
                    (login.strip().lower(), name.strip(), salt, h, now_ms(), int(admin)))


def user_count() -> int:
    with db() as cur:
        cur.execute("SELECT COUNT(*) FROM pc_users")
        return int(cur.fetchone()[0])


def set_password(login: str, password: str) -> bool:
    salt, h = hash_password(password)
    with db() as cur:
        cur.execute("UPDATE pc_users SET salt = ?, hash = ? WHERE login = ?", (salt, h, login.strip().lower()))
        return cur.rowcount > 0


# ---------------------------------------------------------------- application

app = FastAPI(title="Piano Compagnon", version=VERSION)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

_failures: dict[str, list[float]] = {}
_fail_lock = threading.Lock()


@app.on_event("startup")
def _startup() -> None:
    init_db()


def current_user(authorization: str = Header(default="")) -> int:
    token = authorization.removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(401, "Connexion requise")
    th = hashlib.sha256(token.encode()).hexdigest()
    with db() as cur:
        cur.execute("SELECT user_id, expires FROM pc_sessions WHERE token_hash = ?", (th,))
        row = cur.fetchone()
        if not row or row[1] < now_ms():
            raise HTTPException(401, "Session expirée : reconnectez-vous")
        # session glissante : prolongée à chaque usage
        cur.execute("UPDATE pc_sessions SET expires = ? WHERE token_hash = ?", (now_ms() + SESSION_DAYS * MS_DAY, th))
        return int(row[0])


class LoginIn(BaseModel):
    login: str
    password: str


@app.get("/api/ping")
def ping():
    return {"ok": True, "app": "piano-compagnon", "version": VERSION}


@app.post("/api/login")
def login(body: LoginIn):
    key = body.login.strip().lower()
    with _fail_lock:
        recent = [t for t in _failures.get(key, []) if t > time.time() - 600]
        _failures[key] = recent
        if len(recent) >= 8:
            raise HTTPException(429, "Trop d'essais : patientez 10 minutes")
    with db() as cur:
        cur.execute("SELECT id, name, salt, hash FROM pc_users WHERE login = ?", (key,))
        row = cur.fetchone()
        if not row or not secrets.compare_digest(hash_password(body.password, row[2])[1], row[3]):
            with _fail_lock:
                _failures.setdefault(key, []).append(time.time())
            raise HTTPException(401, "Identifiant ou mot de passe incorrect")
    return _open_session(row[0], key, row[1])


def _open_session(uid: int, login_name: str, name: str) -> dict:
    token = secrets.token_urlsafe(32)
    with db() as cur:
        cur.execute("INSERT INTO pc_sessions (token_hash, user_id, expires) VALUES (?, ?, ?)",
                    (hashlib.sha256(token.encode()).hexdigest(), uid, now_ms() + SESSION_DAYS * MS_DAY))
        cur.execute("DELETE FROM pc_sessions WHERE expires < ?", (now_ms(),))
        cur.execute("SELECT admin FROM pc_users WHERE id = ?", (uid,))
        admin = bool(cur.fetchone()[0])
    return {"token": token, "user": {"id": uid, "login": login_name, "name": name, "admin": admin}}


@app.post("/api/logout")
def logout(authorization: str = Header(default="")):
    token = authorization.removeprefix("Bearer ").strip()
    with db() as cur:
        cur.execute("DELETE FROM pc_sessions WHERE token_hash = ?", (hashlib.sha256(token.encode()).hexdigest(),))
    return {"ok": True}


@app.get("/api/me")
def me(uid: int = Depends(current_user)):
    with db() as cur:
        cur.execute("SELECT id, login, name, admin FROM pc_users WHERE id = ?", (uid,))
        r = cur.fetchone()
    return {"id": r[0], "login": r[1], "name": r[2], "admin": bool(r[3])}


# ---------------------------------------------------------------- comptes

class NewUserIn(BaseModel):
    login: str = Field(min_length=2, max_length=50, pattern=r"^[A-Za-z0-9._-]+$")
    name: str = Field(min_length=1, max_length=100)
    password: str = Field(min_length=6, max_length=200)


class PasswordIn(BaseModel):
    password: str = Field(min_length=6, max_length=200)


def admin_user(uid: int = Depends(current_user)) -> int:
    with db() as cur:
        cur.execute("SELECT admin FROM pc_users WHERE id = ?", (uid,))
        if not cur.fetchone()[0]:
            raise HTTPException(403, "Réservé à l'administrateur")
    return uid


@app.get("/api/setup")
def setup_needed():
    """Vrai tant qu'aucun compte n'existe : l'appli propose alors de créer le compte administrateur."""
    return {"needsSetup": user_count() == 0}


@app.post("/api/setup")
def setup(body: NewUserIn):
    with _fail_lock:  # évite deux créations simultanées
        if user_count() > 0:
            raise HTTPException(409, "Le premier compte existe déjà : connectez-vous")
        create_user(body.login, body.name, body.password, admin=True)
    with db() as cur:
        cur.execute("SELECT id FROM pc_users WHERE login = ?", (body.login.strip().lower(),))
        uid = cur.fetchone()[0]
    return _open_session(uid, body.login.strip().lower(), body.name.strip())


@app.get("/api/users")
def list_users(_: int = Depends(admin_user)):
    with db() as cur:
        cur.execute("SELECT login, name, admin FROM pc_users ORDER BY login")
        return [{"login": r[0], "name": r[1], "admin": bool(r[2])} for r in cur.fetchall()]


@app.post("/api/users")
def add_user(body: NewUserIn, _: int = Depends(admin_user)):
    with db() as cur:
        cur.execute("SELECT 1 FROM pc_users WHERE login = ?", (body.login.strip().lower(),))
        if cur.fetchone():
            raise HTTPException(409, "Cet identifiant existe déjà")
    create_user(body.login, body.name, body.password)
    return {"ok": True}


@app.post("/api/users/{login_name}/password")
def reset_password(login_name: str, body: PasswordIn, _: int = Depends(admin_user)):
    if not set_password(login_name, body.password):
        raise HTTPException(404, "Compte introuvable")
    return {"ok": True}


@app.post("/api/me/password")
def change_my_password(body: PasswordIn, uid: int = Depends(current_user)):
    with db() as cur:
        cur.execute("SELECT login FROM pc_users WHERE id = ?", (uid,))
        login_name = cur.fetchone()[0]
    set_password(login_name, body.password)
    return {"ok": True}


# ---------------------------------------------------------------- synchronisation

class PieceIn(BaseModel):
    id: str = Field(max_length=64)
    data: dict | None = None
    updatedAt: int
    deleted: bool = False


class KvIn(BaseModel):
    key: str = Field(max_length=100)
    value: object = None
    updatedAt: int


class SyncIn(BaseModel):
    pieces: list[PieceIn] = []
    kv: list[KvIn] = []


@app.post("/api/sync")
def push(body: SyncIn, uid: int = Depends(current_user)):
    """Envoie les modifications locales ; la plus récente (updatedAt) l'emporte."""
    applied = 0
    rev = now_ms()
    with db() as cur:
        for p in body.pieces:
            cur.execute("SELECT updated FROM pc_pieces WHERE user_id = ? AND id = ?", (uid, p.id))
            row = cur.fetchone()
            data = None if p.deleted else json.dumps(p.data, ensure_ascii=False)
            if row is None:
                cur.execute("INSERT INTO pc_pieces (user_id, id, data, updated, deleted, rev) VALUES (?, ?, ?, ?, ?, ?)",
                            (uid, p.id, data, p.updatedAt, int(p.deleted), rev))
            elif p.updatedAt > row[0]:
                cur.execute("UPDATE pc_pieces SET data = ?, updated = ?, deleted = ?, rev = ? WHERE user_id = ? AND id = ?",
                            (data, p.updatedAt, int(p.deleted), rev, uid, p.id))
            else:
                continue
            if p.deleted:
                cur.execute("DELETE FROM pc_originals WHERE user_id = ? AND piece_id = ?", (uid, p.id))
            applied += 1
        for kv in body.kv:
            cur.execute("SELECT updated FROM pc_kv WHERE user_id = ? AND k = ?", (uid, kv.key))
            row = cur.fetchone()
            v = json.dumps(kv.value, ensure_ascii=False)
            if row is None:
                cur.execute("INSERT INTO pc_kv (user_id, k, v, updated, rev) VALUES (?, ?, ?, ?, ?)", (uid, kv.key, v, kv.updatedAt, rev))
            elif kv.updatedAt > row[0]:
                cur.execute("UPDATE pc_kv SET v = ?, updated = ?, rev = ? WHERE user_id = ? AND k = ?", (v, kv.updatedAt, rev, uid, kv.key))
            else:
                continue
            applied += 1
    return {"applied": applied, "now": now_ms()}


@app.get("/api/sync")
def pull(since: int = 0, uid: int = Depends(current_user)):
    """Renvoie ce qui a changé sur le serveur depuis `since` (ms, horloge du serveur)."""
    with db() as cur:
        cur.execute("SELECT id, data, updated, deleted FROM pc_pieces WHERE user_id = ? AND rev >= ?", (uid, since))
        pieces = [{"id": r[0], "data": json.loads(r[1]) if r[1] else None, "updatedAt": r[2], "deleted": bool(r[3])}
                  for r in cur.fetchall()]
        cur.execute("SELECT k, v, updated FROM pc_kv WHERE user_id = ? AND rev >= ?", (uid, since))
        kv = [{"key": r[0], "value": json.loads(r[1]) if r[1] else None, "updatedAt": r[2]} for r in cur.fetchall()]
    return {"now": now_ms(), "pieces": pieces, "kv": kv}


# ---------------------------------------------------------------- originaux (photos / PDF)

class OriginalIn(BaseModel):
    name: str = Field(max_length=255)
    type: str = Field(max_length=100)
    data: str  # base64


class OriginalsIn(BaseModel):
    files: list[OriginalIn]


@app.put("/api/originals/{piece_id}")
def put_originals(piece_id: str, body: OriginalsIn, uid: int = Depends(current_user)):
    if len(piece_id) > 64:
        raise HTTPException(400, "Identifiant trop long")
    with db() as cur:
        cur.execute("DELETE FROM pc_originals WHERE user_id = ? AND piece_id = ?", (uid, piece_id))
        for i, f in enumerate(body.files):
            cur.execute("INSERT INTO pc_originals (user_id, piece_id, idx, name, type, data) VALUES (?, ?, ?, ?, ?, ?)",
                        (uid, piece_id, i, f.name, f.type, f.data))
    return {"ok": True, "count": len(body.files)}


@app.get("/api/originals/{piece_id}")
def get_originals(piece_id: str, uid: int = Depends(current_user)):
    with db() as cur:
        cur.execute("SELECT name, type, data FROM pc_originals WHERE user_id = ? AND piece_id = ? ORDER BY idx", (uid, piece_id))
        return {"files": [{"name": r[0], "type": r[1], "data": r[2]} for r in cur.fetchall()]}


# ---------------------------------------------------------------- lecture PDF / photos par Claude

SCAN_SYSTEM = """You transcribe piano sheet music (PDF pages or photos) into a compact text format.
Read every page in order and transcribe ALL measures, both hands, as faithfully as possible.

Output ONLY the transcription, no commentary, no markdown fence. Format:

TITLE: <title, or empty>
COMPOSER: <composer, or empty>
TIME: <beats>/<beat-type>   (e.g. 4/4, 3/4, 6/8)
KEY: <number of sharps as positive integer, flats as negative; 0 for C major / A minor>
TEMPO: <quarter-note BPM; estimate from the tempo marking if no number, default 90>
M1 | RH: <events> | LH: <events>
M2 | RH: <events> | LH: <events>
...

Events are separated by spaces. Each event is <pitches>:<duration>
- pitches: one note like C4, F#3, Bb5, E##4, Dbb3 (scientific pitch: middle C = C4), a chord joined with + like C4+E4+G4, or r for a rest.
- Always write the actual sounding accidental of each note, taking the key signature and earlier accidentals in the measure into account (e.g. in G major write F#4, not F4).
- duration in quarter notes: 4 whole, 3 dotted half, 2 half, 1.5 dotted quarter, 1 quarter, 0.75 dotted eighth, 0.5 eighth, 0.25 sixteenth; triplets as fractions like 1/3 or 2/3.
- append ~ to an event whose notes are tied to the same notes in the next event (also across the bar line).
- If one hand plays several simultaneous voices, separate the voices with & (each voice starts at the beginning of the measure and should fill it), e.g. RH: E5:1 D5:1 C5:2 & C4+E4:4
- Each hand's events (each voice) must add up to the measure length; fill with rests where needed. For a pickup (anacrusis) measure, start it with a rest so that it has the full length.
- Expand repeat signs and first/second endings into the order in which they are played; do not write repeat marks.
- Ignore lyrics, fingerings, dynamics and pedal marks. Grace notes are omitted.
- If a page is hard to read, give your best reading rather than skipping measures."""

_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()


class ScanIn(BaseModel):
    files: list[OriginalIn]


def _run_scan(job: dict, files: list[OriginalIn]) -> None:
    try:
        import anthropic
    except ImportError:
        job.update(state="error", error="SDK Anthropic absent du serveur")
        return
    blocks: list[dict] = []
    for f in files:
        if f.type == "application/pdf":
            blocks.append({"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": f.data}})
        else:
            blocks.append({"type": "image", "source": {"type": "base64", "media_type": f.type or "image/jpeg", "data": f.data}})
    blocks.append({"type": "text", "text": "Transcribe this piano score."})
    client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
    try:
        with client.beta.messages.stream(
            model="claude-opus-5-5",
            max_tokens=64000,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",  # si le modèle refuse, l'API réessaie avec le modèle de secours
            thinking={"type": "adaptive"},
            output_config={"effort": "high"},
            system=SCAN_SYSTEM,
            messages=[{"role": "user", "content": blocks}],
        ) as stream:
            for text in stream.text_stream:
                job["text"] += text
                job["measures"] = sum(1 for line in job["text"].splitlines() if line.strip().upper().startswith("M") and "|" in line)
            msg = stream.get_final_message()
        if msg.stop_reason == "refusal":
            job.update(state="error", error="Claude a refusé de lire ce document.")
            return
        job["text"] = "".join(b.text for b in msg.content if b.type == "text") or job["text"]
        job.update(state="done", truncated=msg.stop_reason == "max_tokens")
    except anthropic.AuthenticationError:
        job.update(state="error", error="La clé Claude du serveur est refusée.")
    except anthropic.PermissionDeniedError:
        job.update(state="error", error="Accès refusé par Anthropic (crédit du compte ?).")
    except anthropic.RateLimitError:
        job.update(state="error", error="Trop de demandes en même temps : réessayez dans une minute.")
    except anthropic.APIConnectionError:
        job.update(state="error", error="Le serveur n'arrive pas à joindre Anthropic (accès Internet ?).")
    except anthropic.APIStatusError as e:
        job.update(state="error", error=f"Erreur Anthropic ({e.status_code}) : réessayez plus tard.")
    except Exception as e:  # noqa: BLE001
        job.update(state="error", error=f"Erreur : {e}")


@app.post("/api/scan")
def scan_start(body: ScanIn, uid: int = Depends(current_user)):
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise HTTPException(503, "Clé Claude non configurée sur le serveur")
    if not body.files:
        raise HTTPException(400, "Aucune page reçue")
    with _jobs_lock:
        for k in [k for k, j in _jobs.items() if j["started"] < time.time() - 3 * 3600]:
            del _jobs[k]
        jid = secrets.token_urlsafe(12)
        job = {"uid": uid, "state": "running", "measures": 0, "text": "", "error": None, "truncated": False, "started": time.time()}
        _jobs[jid] = job
    threading.Thread(target=_run_scan, args=(job, body.files), daemon=True).start()
    return {"job": jid}


@app.get("/api/scan/{jid}")
def scan_status(jid: str, uid: int = Depends(current_user)):
    job = _jobs.get(jid)
    if not job or job["uid"] != uid:
        raise HTTPException(404, "Lecture introuvable (serveur redémarré ?)")
    out = {"state": job["state"], "measures": job["measures"], "elapsed": int(time.time() - job["started"]), "error": job["error"]}
    if job["state"] == "done":
        out.update(text=job["text"], truncated=job["truncated"])
    return out


# ---------------------------------------------------------------- application web (navigateur du PC)
# Le dossier ../web contient la version web de l'appli (npm run build). Monté en dernier :
# les routes /api/... ci-dessus restent prioritaires.
WEB_DIR = HERE.parent / "web"
if WEB_DIR.is_dir():
    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
else:
    @app.get("/", response_class=HTMLResponse)
    def accueil():
        return ("<!doctype html><meta charset='utf-8'><title>Piano Compagnon</title>"
                "<body style='font-family:system-ui;padding:40px'><h1>Piano Compagnon</h1>"
                "<p>Le serveur fonctionne. Version web non installée.</p></body>")
