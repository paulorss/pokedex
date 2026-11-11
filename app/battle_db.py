"""
Módulo de banco de dados SQLite para o Sistema de Batalha Pokémon Online.
Gerencia cadastro/login de usuários, sessões, ranking ELO e histórico de partidas.
"""
from __future__ import annotations

import hashlib
import json
import os
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "battle.db"


def get_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    return conn


def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with get_connection() as conn:
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL COLLATE NOCASE,
            display_name TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            salt TEXT NOT NULL,
            avatar_id INTEGER DEFAULT 25,
            wins INTEGER DEFAULT 0,
            losses INTEGER DEFAULT 0,
            draws INTEGER DEFAULT 0,
            rating INTEGER DEFAULT 1000,
            created_at TEXT NOT NULL,
            last_seen TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS battle_history (
            id TEXT PRIMARY KEY,
            player1_id INTEGER,
            player2_id INTEGER,
            player1_name TEXT NOT NULL,
            player2_name TEXT NOT NULL,
            winner_id INTEGER,
            player1_team TEXT,
            player2_team TEXT,
            turns_played INTEGER DEFAULT 0,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS pokemon_cooldowns (
            user_id INTEGER NOT NULL,
            pokemon_id INTEGER NOT NULL,
            available_at TEXT NOT NULL,
            PRIMARY KEY (user_id, pokemon_id),
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_users_rating ON users(rating DESC);
        CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
        CREATE INDEX IF NOT EXISTS idx_cooldowns_user ON pokemon_cooldowns(user_id);
        """)
        conn.commit()


def hash_password(password: str, salt: str | None = None) -> tuple[str, str]:
    if not salt:
        salt = secrets.token_hex(16)
    hashed = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt.encode("utf-8"),
        iterations=100_000,
    ).hex()
    return hashed, salt


def register_user(username: str, password: str, display_name: str | None = None, avatar_id: int = 25) -> dict[str, Any]:
    username = username.strip()
    if not username or len(username) < 3:
        raise ValueError("O nome de usuário deve ter no mínimo 3 caracteres.")
    if len(username) > 24:
        raise ValueError("O nome de usuário pode ter no máximo 24 caracteres.")
    if not password or len(password) < 4:
        raise ValueError("A senha deve ter pelo menos 4 caracteres.")

    display = (display_name or username).strip()[:24]
    pw_hash, salt = hash_password(password)
    now = datetime.now(timezone.utc).isoformat()

    with get_connection() as conn:
        try:
            cursor = conn.execute(
                """
                INSERT INTO users (username, display_name, password_hash, salt, avatar_id, rating, created_at, last_seen)
                VALUES (?, ?, ?, ?, ?, 1000, ?, ?)
                """,
                (username, display, pw_hash, salt, int(avatar_id or 25), now, now),
            )
            user_id = cursor.lastrowid
            conn.commit()
        except sqlite3.IntegrityError:
            raise ValueError(f"O nome de usuário '{username}' já está cadastrado. Escolha outro.")

    token = create_session(user_id)
    return {
        "id": user_id,
        "username": username,
        "display_name": display,
        "avatar_id": int(avatar_id or 25),
        "rating": 1000,
        "wins": 0,
        "losses": 0,
        "draws": 0,
        "token": token,
    }


def login_user(username: str, password: str) -> dict[str, Any]:
    username = username.strip()
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
        if not row:
            raise ValueError("Usuário ou senha incorretos.")

        pw_hash, _ = hash_password(password, row["salt"])
        if pw_hash != row["password_hash"]:
            raise ValueError("Usuário ou senha incorretos.")

        user_id = row["id"]
        now = datetime.now(timezone.utc).isoformat()
        conn.execute("UPDATE users SET last_seen = ? WHERE id = ?", (now, user_id))
        conn.commit()

    token = create_session(user_id)
    return {
        "id": row["id"],
        "username": row["username"],
        "display_name": row["display_name"],
        "avatar_id": row["avatar_id"],
        "rating": row["rating"],
        "wins": row["wins"],
        "losses": row["losses"],
        "draws": row["draws"],
        "token": token,
    }


def create_session(user_id: int) -> str:
    token = secrets.token_hex(24)
    now = datetime.now(timezone.utc)
    expires = now + timedelta(days=30)
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
            (token, user_id, now.isoformat(), expires.isoformat()),
        )
        conn.commit()
    return token


def get_user_by_token(token: str) -> dict[str, Any] | None:
    if not token:
        return None
    with get_connection() as conn:
        row = conn.execute(
            """
            SELECT u.id, u.username, u.display_name, u.avatar_id, u.rating, u.wins, u.losses, u.draws, s.expires_at
            FROM sessions s
            JOIN users u ON u.id = s.user_id
            WHERE s.token = ?
            """,
            (token,),
        ).fetchone()

        if not row:
            return None

        # Verifica expiração
        try:
            expires = datetime.fromisoformat(row["expires_at"])
            if expires < datetime.now(timezone.utc):
                conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
                conn.commit()
                return None
        except Exception:
            pass

        now = datetime.now(timezone.utc).isoformat()
        conn.execute("UPDATE users SET last_seen = ? WHERE id = ?", (now, row["id"]))
        conn.commit()

        return {
            "id": row["id"],
            "username": row["username"],
            "display_name": row["display_name"],
            "avatar_id": row["avatar_id"],
            "rating": row["rating"],
            "wins": row["wins"],
            "losses": row["losses"],
            "draws": row["draws"],
        }


def get_user_by_id(user_id: int) -> dict[str, Any] | None:
    with get_connection() as conn:
        row = conn.execute(
            "SELECT id, username, display_name, avatar_id, rating, wins, losses, draws, last_seen FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
        return dict(row) if row else None


def get_user_by_username(username: str) -> dict[str, Any] | None:
    with get_connection() as conn:
        row = conn.execute(
            "SELECT id, username, display_name, avatar_id, rating, wins, losses, draws, last_seen FROM users WHERE username = ?",
            (username.strip(),),
        ).fetchone()
        return dict(row) if row else None


def record_battle_result(
    room_id: str,
    player1_id: int | None,
    player2_id: int | None,
    player1_name: str,
    player2_name: str,
    winner_id: int | None,
    p1_team: list[Any],
    p2_team: list[Any],
    turns_played: int = 0,
):
    now = datetime.now(timezone.utc).isoformat()
    with get_connection() as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO battle_history
            (id, player1_id, player2_id, player1_name, player2_name, winner_id, player1_team, player2_team, turns_played, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                room_id,
                player1_id,
                player2_id,
                player1_name,
                player2_name,
                winner_id,
                json.dumps(p1_team, ensure_ascii=False),
                json.dumps(p2_team, ensure_ascii=False),
                turns_played,
                now,
            ),
        )

        # Atualiza estatísticas e ELO dos jogadores reais
        if player1_id and player1_id > 0:
            if winner_id == player1_id:
                conn.execute("UPDATE users SET wins = wins + 1, rating = rating + 25 WHERE id = ?", (player1_id,))
            elif winner_id and winner_id != player1_id:
                conn.execute("UPDATE users SET losses = losses + 1, rating = MAX(100, rating - 15) WHERE id = ?", (player1_id,))
            else:
                conn.execute("UPDATE users SET draws = draws + 1 WHERE id = ?", (player1_id,))

        if player2_id and player2_id > 0:
            if winner_id == player2_id:
                conn.execute("UPDATE users SET wins = wins + 1, rating = rating + 25 WHERE id = ?", (player2_id,))
            elif winner_id and winner_id != player2_id:
                conn.execute("UPDATE users SET losses = losses + 1, rating = MAX(100, rating - 15) WHERE id = ?", (player2_id,))
            else:
                conn.execute("UPDATE users SET draws = draws + 1 WHERE id = ?", (player2_id,))

        conn.commit()


def get_all_trainers(limit: int = 100) -> list[dict[str, Any]]:
    with get_connection() as conn:
        rows = conn.execute(
            """
            SELECT id, username, display_name, avatar_id, rating, wins, losses, draws, last_seen
            FROM users
            ORDER BY rating DESC, wins DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]


def get_leaderboard(limit: int = 25) -> list[dict[str, Any]]:
    with get_connection() as conn:
        rows = conn.execute(
            """
            SELECT id, username, display_name, avatar_id, rating, wins, losses, draws
            FROM users
            ORDER BY rating DESC, wins DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]


def get_recent_battles(user_id: int | None = None, limit: int = 15) -> list[dict[str, Any]]:
    with get_connection() as conn:
        if user_id:
            rows = conn.execute(
                """
                SELECT * FROM battle_history
                WHERE player1_id = ? OR player2_id = ?
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (user_id, user_id, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT * FROM battle_history
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()

        out = []
        for r in rows:
            d = dict(r)
            try:
                d["player1_team"] = json.loads(d["player1_team"])
            except Exception:
                pass
            try:
                d["player2_team"] = json.loads(d["player2_team"])
            except Exception:
                pass
            out.append(d)
        return out


def mark_pokemon_ko(user_id: int | None, pokemon_ids: list[int], hours: int = 24) -> None:
    """Registra Pokémon derrotados em duelo, deixando-os indisponíveis por 24 horas."""
    if not user_id or user_id <= 0 or not pokemon_ids:
        return
    available_at = (datetime.now(timezone.utc) + timedelta(hours=hours)).isoformat()
    unique_ids = sorted({int(pid) for pid in pokemon_ids if int(pid) > 0})
    with get_connection() as conn:
        for pid in unique_ids:
            conn.execute(
                """
                INSERT OR REPLACE INTO pokemon_cooldowns (user_id, pokemon_id, available_at)
                VALUES (?, ?, ?)
                """,
                (user_id, pid, available_at),
            )
        conn.commit()


def get_user_cooldowns(user_id: int | None) -> dict[int, dict[str, Any]]:
    """Retorna os Pokémon atualmente em recuperação (24h) do treinador."""
    if not user_id or user_id <= 0:
        return {}
    now = datetime.now(timezone.utc)
    now_iso = now.isoformat()
    with get_connection() as conn:
        conn.execute("DELETE FROM pokemon_cooldowns WHERE user_id = ? AND available_at <= ?", (user_id, now_iso))
        conn.commit()
        rows = conn.execute(
            "SELECT pokemon_id, available_at FROM pokemon_cooldowns WHERE user_id = ?",
            (user_id,),
        ).fetchall()

    result: dict[int, dict[str, Any]] = {}
    for r in rows:
        try:
            avail_dt = datetime.fromisoformat(r["available_at"])
            remaining = max(1, int((avail_dt - now).total_seconds()))
        except Exception:
            remaining = 24 * 3600
        result[int(r["pokemon_id"])] = {
            "pokemon_id": int(r["pokemon_id"]),
            "available_at": r["available_at"],
            "remaining_seconds": remaining,
        }
    return result


init_db()

