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
from pydantic import BaseModel, Field

VERSION = "1.0.0"
HERE = Path(__file__).resolve().parent


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


def now_ms() -> int:
    return int(time.time() * 1000)


# ---------------------------------------------------------------- mots de passe

def hash_password(password: str, salt: str | None = None) -> tuple[str, str]:
    salt = salt or secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), 200_000)
    return salt, dk.hex()


def create_user(login: str, name: str, password: str) -> None:
    salt, h = hash_password(password)
    with db() as cur:
        cur.execute("INSERT INTO pc_users (login, name, salt, hash, created) VALUES (?, ?, ?, ?, ?)",
                    (login.strip().lower(), name.strip(), salt, h, now_ms()))


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
        token = secrets.token_urlsafe(32)
        cur.execute("INSERT INTO pc_sessions (token_hash, user_id, expires) VALUES (?, ?, ?)",
                    (hashlib.sha256(token.encode()).hexdigest(), row[0], now_ms() + SESSION_DAYS * MS_DAY))
        cur.execute("DELETE FROM pc_sessions WHERE expires < ?", (now_ms(),))
    return {"token": token, "user": {"id": row[0], "login": key, "name": row[1]}}


@app.post("/api/logout")
def logout(authorization: str = Header(default="")):
    token = authorization.removeprefix("Bearer ").strip()
    with db() as cur:
        cur.execute("DELETE FROM pc_sessions WHERE token_hash = ?", (hashlib.sha256(token.encode()).hexdigest(),))
    return {"ok": True}


@app.get("/api/me")
def me(uid: int = Depends(current_user)):
    with db() as cur:
        cur.execute("SELECT id, login, name FROM pc_users WHERE id = ?", (uid,))
        r = cur.fetchone()
    return {"id": r[0], "login": r[1], "name": r[2]}


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
