"""
Servidor WebSocket e REST do "Duelo dos Encantados".
Gerencia contas, salão (lista de treinadores e convites), draft com timer de 60s
e o laço de rodadas: coleta as duas ações, resolve e transmite os eventos.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import random
import uuid
from typing import Any

from fastapi import APIRouter, Header, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from app.battle_db import (
    get_all_trainers,
    get_leaderboard,
    get_recent_battles,
    get_user_by_id,
    get_user_by_token,
    get_user_by_username,
    get_user_cooldowns,
    login_user,
    mark_pokemon_ko,
    record_battle_result,
    register_user,
)
from app.battle_engine import (
    ROUND_SECONDS,
    BattleState,
    auto_pick_team,
    rules_payload,
    validate_team,
)

log = logging.getLogger("duelo")
router = APIRouter(prefix="/api/battle", tags=["battle"])

# user_id -> {"ws": WebSocket, "user": dict, "in_battle": bool, "room_id": str | None}
online_users: dict[int, dict[str, Any]] = {}
# room_id -> {"state": BattleState, "p1_ws": WebSocket | None, "p2_ws": WebSocket | None, "closed": bool}
active_rooms: dict[str, dict[str, Any]] = {}
# invite_id -> {"from_user": dict, "to_user": dict}
pending_invites: dict[str, dict[str, Any]] = {}

BOT_NAMES = ["Líder Brock", "Líder Misty", "Campeão Lance", "Treinador Red", "Campeã Cynthia", "Treinadora Dawn"]
DEFAULT_AVATAR = 25
STARTER_AVATARS = [1, 4, 7, 25, 39, 94, 133, 143, 150, 248, 448, 658]
POLL_SECONDS = 0.2
EVENT_SECONDS = float(os.environ.get("DUELO_EVENT_SECONDS", "1.25"))  # tempo para animação dos eventos
RESULT_PADDING = 0.9


class RegisterRequest(BaseModel):
    username: str
    password: str
    display_name: str | None = None
    avatar_id: int | None = DEFAULT_AVATAR


class LoginRequest(BaseModel):
    username: str
    password: str


# ==================== REST ====================


@router.post("/register")
def api_register(req: RegisterRequest):
    try:
        return {"ok": True, "user": register_user(req.username, req.password, req.display_name,
                                                  req.avatar_id or DEFAULT_AVATAR)}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/login")
def api_login(req: LoginRequest):
    try:
        return {"ok": True, "user": login_user(req.username, req.password)}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


def _cooldowns_payload(user_id: int | None) -> dict[str, dict[str, Any]]:
    if not user_id or user_id <= 0:
        return {}
    return {str(pid): info for pid, info in get_user_cooldowns(user_id).items()}


@router.get("/me")
def api_me(authorization: str | None = Header(None)):
    token = authorization[7:].strip() if authorization and authorization.startswith("Bearer ") else ""
    user = get_user_by_token(token)
    if not user:
        raise HTTPException(status_code=401, detail="Sessão inválida ou expirada.")
    return {"ok": True, "user": user, "cooldowns": _cooldowns_payload(user["id"])}


@router.get("/cooldowns")
def api_cooldowns(authorization: str | None = Header(None)):
    token = authorization[7:].strip() if authorization and authorization.startswith("Bearer ") else ""
    user = get_user_by_token(token)
    if not user:
        raise HTTPException(status_code=401, detail="Sessão inválida ou expirada.")
    return {"ok": True, "cooldowns": _cooldowns_payload(user["id"])}


@router.get("/rules")
def api_rules():
    return {"ok": True, **rules_payload()}


@router.get("/leaderboard")
def api_leaderboard():
    return {"ok": True, "leaderboard": get_leaderboard(25)}


@router.get("/trainers")
def api_trainers():
    return {"ok": True, "trainers": _trainers_with_presence()}


@router.get("/history")
def api_history(user_id: int | None = None):
    rows = get_recent_battles(user_id=user_id, limit=15)
    for r in rows:  # o histórico da lista não precisa das equipes completas
        r.pop("player1_team", None)
        r.pop("player2_team", None)
    return {"ok": True, "history": rows}


# ==================== transmissão ====================


def _public_user(u: dict[str, Any]) -> dict[str, Any]:
    return {k: u.get(k) for k in ("id", "username", "display_name", "avatar_id", "rating")}


def _trainers_with_presence() -> list[dict[str, Any]]:
    trainers = get_all_trainers(100)
    for t in trainers:
        presence = online_users.get(t["id"])
        t["is_online"] = presence is not None
        t["in_battle"] = bool(presence and presence.get("in_battle"))
    return trainers


async def _send(ws: WebSocket | None, msg: dict[str, Any]) -> None:
    if ws is None:
        return
    try:
        await ws.send_text(json.dumps(msg, ensure_ascii=False))
    except Exception:  # conexão já encerrada: a limpeza ocorre no endpoint
        log.debug("envio descartado: conexão fechada")


async def broadcast_lobby() -> None:
    msg = {"type": "lobby_update", "trainers": _trainers_with_presence()}
    for data in list(online_users.values()):
        if not data.get("in_battle"):
            await _send(data["ws"], msg)


async def send_to_user(user_id: int, msg: dict[str, Any]) -> None:
    if user_id in online_users:
        await _send(online_users[user_id]["ws"], msg)


async def broadcast_room(room_id: str, msg: dict[str, Any]) -> None:
    room = active_rooms.get(room_id)
    if room:
        await _send(room.get("p1_ws"), msg)
        await _send(room.get("p2_ws"), msg)


# ==================== fluxo da partida ====================


def _open_room(state: BattleState, p1_ws: WebSocket, p2_ws: WebSocket | None) -> None:
    active_rooms[state.room_id] = {"state": state, "p1_ws": p1_ws, "p2_ws": p2_ws, "closed": False}
    for uid in (state.p1_id, state.p2_id if p2_ws else None):
        if uid in online_users:
            online_users[uid]["in_battle"] = True
            online_users[uid]["room_id"] = state.room_id
    asyncio.create_task(run_draft_timer(state.room_id))


async def run_draft_timer(room_id: str) -> None:
    room = active_rooms.get(room_id)
    if not room:
        return
    state: BattleState = room["state"]
    while state.phase == "DRAFT" and state.draft_timer > 0 and not room["closed"]:
        await asyncio.sleep(1)
        state.draft_timer -= 1
        await broadcast_room(room_id, {"type": "draft_tick", "timer": state.draft_timer})
    if state.phase == "DRAFT" and not room["closed"]:
        await start_battle(room_id)


async def start_battle(room_id: str) -> None:
    room = active_rooms.get(room_id)
    if not room or room["state"].phase != "DRAFT":
        return
    state: BattleState = room["state"]
    state.start_battle_from_draft()
    await broadcast_room(room_id, {"type": "battle_started", "state": state.to_client_state()})
    asyncio.create_task(run_round_loop(room_id))


async def run_round_loop(room_id: str) -> None:
    """Uma rodada por volta: espera as duas escolhas (ou o tempo), resolve e dá tempo para a animação."""
    await asyncio.sleep(2.2)  # entrada dos Encantados na arena
    while True:
        room = active_rooms.get(room_id)
        if not room or room["closed"]:
            return
        state: BattleState = room["state"]
        if state.phase != "BATTLE":
            return

        state.begin_round()
        if state.is_bot:
            state.choices[2] = state.bot_choose(2)
        await broadcast_room(room_id, {"type": "round_start", "state": state.to_client_state()})

        waited = 0.0
        while waited < ROUND_SECONDS and not state.both_ready() and state.phase == "BATTLE":
            await asyncio.sleep(POLL_SECONDS)
            waited += POLL_SECONDS
        if room["closed"] or state.phase != "BATTLE":
            return

        events = state.resolve_round()
        await broadcast_room(room_id, {"type": "round_result", "events": events,
                                       "state": state.to_client_state()})
        await asyncio.sleep(RESULT_PADDING + EVENT_SECONDS * len(events))
        if state.phase == "FINISHED":
            await finish_battle(room_id)
            return


async def finish_battle(room_id: str) -> None:
    room = active_rooms.get(room_id)
    if not room or room["closed"]:
        return
    room["closed"] = True
    state: BattleState = room["state"]
    state.phase = "FINISHED"
    winner_id = {1: state.p1_id, 2: state.p2_id}.get(state.winner)

    if state.round_no > 0 or state.winner:
        try:
            record_battle_result(
                room_id=room_id,
                player1_id=state.p1_id,
                # contra IA o rating do treinador representado não muda
                player2_id=None if state.is_bot else state.p2_id,
                player1_name=state.p1_name, player2_name=state.p2_name,
                winner_id=winner_id if not (state.is_bot and state.winner == 2) else -1,
                p1_team=[c["name"] for c in state.teams[1]],
                p2_team=[c["name"] for c in state.teams[2]],
                turns_played=state.round_no,
            )
        except Exception:
            log.exception("falha ao gravar o resultado da sala %s", room_id)

    for player_no, uid in ((1, state.p1_id), (2, None if state.is_bot else state.p2_id)):
        if uid:
            ko_ids = [c["id"] for c in state.teams[player_no] if c["hp"] <= 0 or c.get("fainted")]
            if ko_ids:
                mark_pokemon_ko(uid, ko_ids, hours=24)

    for uid in (state.p1_id, None if state.is_bot else state.p2_id):
        if uid in online_users:
            online_users[uid]["in_battle"] = False
            online_users[uid]["room_id"] = None
            online_users[uid]["user"] = get_user_by_id(uid) or online_users[uid]["user"]
            await send_to_user(uid, {"type": "cooldowns_update", "cooldowns": _cooldowns_payload(uid)})

    await broadcast_room(room_id, {
        "type": "battle_ended",
        "winner": state.winner,
        "winner_name": state.name_of(state.winner) if state.winner else None,
        "state": state.to_client_state(),
    })
    active_rooms.pop(room_id, None)
    await broadcast_lobby()


def _room_for(user_id: int, room_id: str | None) -> tuple[dict[str, Any], BattleState] | None:
    """Só devolve a sala se o usuário for um dos participantes."""
    room = active_rooms.get(room_id or "")
    if not room:
        return None
    state: BattleState = room["state"]
    if user_id not in (state.p1_id, None if state.is_bot else state.p2_id):
        return None
    return room, state


def _find_target(data: dict[str, Any]) -> dict[str, Any] | None:
    target_id = data.get("target_id")
    username = (data.get("target_username") or "").strip()[:24]
    try:
        if target_id is not None:
            return get_user_by_id(int(target_id))
    except (TypeError, ValueError):
        return None
    return get_user_by_username(username) if username else None


async def _start_bot_room(user: dict[str, Any], ws: WebSocket, opponent: dict[str, Any], prefix: str) -> None:
    p1_cd = get_user_cooldowns(user["id"])
    state = BattleState(room_id=f"{prefix}_{uuid.uuid4().hex[:10]}", p1_id=user["id"],
                        p1_name=user["display_name"], p2_id=opponent.get("id"),
                        p2_name=opponent["display_name"], is_bot=True,
                        p1_blocked=set(p1_cd.keys()))
    state.team_ids[2] = auto_pick_team([])
    state.locked[2] = True
    _open_room(state, ws, None)
    await _send(ws, {"type": "battle_matched", "room_id": state.room_id, "role": 1,
                     "opponent": {**_public_user(opponent), "is_bot": True},
                     "cooldowns": {str(k): v for k, v in p1_cd.items()},
                     "state": state.to_client_state()})
    await broadcast_lobby()


async def handle_ws_message(user_id: int, user: dict[str, Any], ws: WebSocket, data: dict[str, Any]) -> None:
    action = data.get("action")
    if online_users.get(user_id, {}).get("in_battle") and action in (
            "challenge", "challenge_offline_bot", "accept_challenge", "start_bot_battle"):
        await _send(ws, {"type": "error", "message": "Termine o duelo atual antes de começar outro."})
        return

    if action == "challenge":
        target = _find_target(data)
        if not target:
            await _send(ws, {"type": "error", "message": "Treinador não encontrado. Confira o nome de usuário."})
        elif target["id"] == user_id:
            await _send(ws, {"type": "error", "message": "Você não pode desafiar a si mesmo."})
        elif target["id"] not in online_users:
            await _send(ws, {"type": "trainer_offline_prompt", "target": _public_user(target)})
        elif online_users[target["id"]].get("in_battle"):
            await _send(ws, {"type": "error", "message": f"{target['display_name']} está em um duelo agora."})
        else:
            invite_id = uuid.uuid4().hex[:8]
            pending_invites[invite_id] = {"from_user": user, "to_user": target}
            await send_to_user(target["id"], {"type": "challenge_received", "invite_id": invite_id,
                                              "challenger": _public_user(user), "timeout": 30})
            await _send(ws, {"type": "challenge_sent", "target": target["display_name"]})

    elif action == "challenge_offline_bot":
        target = _find_target(data)
        if not target:
            await _send(ws, {"type": "error", "message": "Treinador não encontrado."})
            return
        await _start_bot_room(user, ws, target, "eco")

    elif action == "start_bot_battle":
        bot = {"id": None, "username": "", "display_name": random.choice(BOT_NAMES),
               "avatar_id": random.choice(STARTER_AVATARS), "rating": 1000}
        await _start_bot_room(user, ws, bot, "treino")

    elif action == "accept_challenge":
        inv = pending_invites.pop(data.get("invite_id"), None)
        if not inv or inv["to_user"]["id"] != user_id:
            await _send(ws, {"type": "error", "message": "O convite expirou."})
            return
        p1, p2 = inv["from_user"], inv["to_user"]
        if p1["id"] not in online_users or online_users[p1["id"]].get("in_battle"):
            await _send(ws, {"type": "error", "message": f"{p1['display_name']} não está mais disponível."})
            return
        p1_cd = get_user_cooldowns(p1["id"])
        p2_cd = get_user_cooldowns(p2["id"])
        state = BattleState(room_id=f"sala_{uuid.uuid4().hex[:10]}", p1_id=p1["id"], p1_name=p1["display_name"],
                            p2_id=p2["id"], p2_name=p2["display_name"],
                            p1_blocked=set(p1_cd.keys()), p2_blocked=set(p2_cd.keys()))
        _open_room(state, online_users[p1["id"]]["ws"], ws)
        for role, me, foe, cd in ((1, p1, p2, p1_cd), (2, p2, p1, p2_cd)):
            await send_to_user(me["id"], {"type": "battle_matched", "room_id": state.room_id, "role": role,
                                          "opponent": _public_user(foe),
                                          "cooldowns": {str(k): v for k, v in cd.items()},
                                          "state": state.to_client_state()})
        await broadcast_lobby()

    elif action == "decline_challenge":
        inv = pending_invites.pop(data.get("invite_id"), None)
        if inv and inv["to_user"]["id"] == user_id:
            await send_to_user(inv["from_user"]["id"], {"type": "challenge_declined", "by": user["display_name"]})

    elif action == "draft_update":
        found = _room_for(user_id, data.get("room_id"))
        if not found or found[1].phase != "DRAFT":
            return
        _, state = found
        try:
            team_ids = [int(x) for x in (data.get("team_ids") or [])]
        except (TypeError, ValueError):
            return
        player = state.player_of(user_id)
        error = validate_team(team_ids, blocked_ids=state.blocked_ids[player])
        if error:
            await _send(ws, {"type": "error", "message": error})
            return
        state.team_ids[player] = team_ids
        state.locked[player] = bool(data.get("locked")) and len(team_ids) > 0
        await broadcast_room(state.room_id, {
            "type": "draft_updated",
            "p1_locked": state.locked[1], "p2_locked": state.locked[2],
            "p1_count": len(state.team_ids[1]), "p2_count": len(state.team_ids[2]),
        })
        if state.locked[1] and state.locked[2]:
            await start_battle(state.room_id)

    elif action == "choose_action":
        found = _room_for(user_id, data.get("room_id"))
        if not found:
            return
        _, state = found
        player = state.player_of(user_id)
        res = state.submit_action(player, data)
        if not res["ok"]:
            await _send(ws, {"type": "action_rejected", "message": res["reason"]})
            return
        await broadcast_room(state.room_id, {"type": "ready_update",
                                             "p1_ready": state.choices[1] is not None,
                                             "p2_ready": state.choices[2] is not None})

    elif action == "surrender":
        found = _room_for(user_id, data.get("room_id"))
        if not found:
            return
        _, state = found
        state.winner = 3 - state.player_of(user_id)
        state.logs.append(f"{user['display_name']} desistiu do duelo.")
        await finish_battle(state.room_id)


# ==================== rota WebSocket ====================


async def websocket_battle_endpoint(websocket: WebSocket, token: str = ""):
    await websocket.accept()
    user = get_user_by_token(token)
    if not user:
        await _send(websocket, {"type": "auth_error", "message": "Entre com sua conta de treinador."})
        await websocket.close()
        return

    user_id = user["id"]
    previous = online_users.get(user_id)
    if previous:  # mesma conta aberta em outra aba: a conexão antiga é encerrada
        await _send(previous["ws"], {"type": "auth_error", "message": "Sua conta foi aberta em outro lugar."})
    online_users[user_id] = {"ws": websocket, "user": user, "in_battle": False, "room_id": None}
    await _send(websocket, {"type": "auth_success", "user": user, "cooldowns": _cooldowns_payload(user_id)})
    await broadcast_lobby()

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                data = json.loads(raw)
            except ValueError:
                continue
            if isinstance(data, dict):
                await handle_ws_message(user_id, user, websocket, data)
    except WebSocketDisconnect:
        pass
    except Exception:
        log.exception("erro no WebSocket do usuário %s", user_id)
    finally:
        current = online_users.get(user_id)
        if current and current["ws"] is websocket:
            online_users.pop(user_id, None)
            found = _room_for(user_id, current.get("room_id"))
            if found and found[1].phase != "FINISHED":
                state = found[1]
                state.winner = 3 - state.player_of(user_id)
                state.logs.append(f"{user['display_name']} saiu do duelo.")
                await finish_battle(state.room_id)
            await broadcast_lobby()
