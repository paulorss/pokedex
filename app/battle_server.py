"""
Servidor WebSocket e REST para o Módulo de Batalha Pokémon Online.
Gerencia matchmaking, convites em tempo real, salas de draft com timer de 60s,
regras de batalha sincronizadas e bots de IA.
"""
from __future__ import annotations

import asyncio
import json
import random
import uuid
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from app.battle_db import (
    get_all_trainers,
    get_leaderboard,
    get_recent_battles,
    get_user_by_id,
    get_user_by_token,
    get_user_by_username,
    login_user,
    record_battle_result,
    register_user,
)
from app.battle_engine import (
    BattleState,
    POKEMON_MAP,
    TEAM_STAMINA_LIMIT,
    auto_pick_team,
    calculate_pokemon_stamina,
)

router = APIRouter(prefix="/api/battle", tags=["battle"])

# Mapas de conexões ativas e salas de batalha
# user_id -> {"ws": WebSocket, "user": dict, "in_battle": bool, "room_id": str | None}
online_users: dict[int, dict[str, Any]] = {}

# room_id -> {"state": BattleState, "p1_ws": WebSocket | None, "p2_ws": WebSocket | None, "task": asyncio.Task | None}
active_rooms: dict[str, dict[str, Any]] = {}

# Convites pendentes: invite_id -> {"from_user": dict, "to_user": dict, "timeout_task": asyncio.Task}
pending_invites: dict[str, dict[str, Any]] = {}

BOT_NAMES = [
    "Treinador Red",
    "Líder Brock (Pedra)",
    "Líder Misty (Água)",
    "Campeã Cynthia",
    "Treinador Ash",
    "Gary Carvalho",
]


class RegisterRequest(BaseModel):
    username: str
    password: str
    display_name: str | None = None
    avatar_id: int | None = 25


class LoginRequest(BaseModel):
    username: str
    password: str


# ==================== REST ENDPOINTS ====================


@router.post("/register")
def api_register(req: RegisterRequest):
    try:
        data = register_user(req.username, req.password, req.display_name, req.avatar_id or 25)
        return {"ok": True, "user": data}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/login")
def api_login(req: LoginRequest):
    try:
        data = login_user(req.username, req.password)
        return {"ok": True, "user": data}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/me")
def api_me(authorization: str | None = Header(None)):
    token = ""
    if authorization and authorization.startswith("Bearer "):
        token = authorization[7:].strip()
    user = get_user_by_token(token)
    if not user:
        raise HTTPException(status_code=401, detail="Sessão inválida ou expirada.")
    return {"ok": True, "user": user}


@router.get("/leaderboard")
def api_leaderboard():
    return {"ok": True, "leaderboard": get_leaderboard(25)}


@router.get("/online_users")
def api_online():
    users_list = []
    for uid, data in online_users.items():
        u = data["user"]
        users_list.append({
            "id": u["id"],
            "username": u["username"],
            "display_name": u["display_name"],
            "avatar_id": u["avatar_id"],
            "rating": u["rating"],
            "in_battle": data.get("in_battle", False),
        })
    return {"ok": True, "users": users_list}


@router.get("/trainers")
def api_trainers():
    trainers = get_all_trainers(100)
    for t in trainers:
        uid = t["id"]
        t["is_online"] = uid in online_users
        t["in_battle"] = online_users[uid].get("in_battle", False) if uid in online_users else False
    return {"ok": True, "trainers": trainers}


@router.get("/history")
def api_history(user_id: int | None = None):
    return {"ok": True, "history": get_recent_battles(user_id=user_id, limit=15)}


@router.get("/stamina_info")
def api_stamina_info():
    """Retorna o limite regulamentar e tabela de custos."""
    return {"ok": True, "limit": TEAM_STAMINA_LIMIT}


# ==================== WEBSOCKET DISPATCHER ====================


async def broadcast_lobby():
    """Transmite a lista atualizada de treinadores cadastrados e status online para o lobby."""
    users_list = []
    for uid, data in online_users.items():
        u = data["user"]
        users_list.append({
            "id": u["id"],
            "username": u["username"],
            "display_name": u["display_name"],
            "avatar_id": u["avatar_id"],
            "rating": u["rating"],
            "in_battle": data.get("in_battle", False),
        })

    trainers = get_all_trainers(100)
    for t in trainers:
        uid = t["id"]
        t["is_online"] = uid in online_users
        t["in_battle"] = online_users[uid].get("in_battle", False) if uid in online_users else False

    msg = json.dumps({
        "type": "lobby_update",
        "online_users": users_list,
        "trainers": trainers,
    }, ensure_ascii=False)
    for uid, data in list(online_users.items()):
        if not data.get("in_battle"):
            try:
                await data["ws"].send_text(msg)
            except Exception:
                pass


async def send_to_user(user_id: int, msg: dict[str, Any]):
    if user_id in online_users:
        try:
            await online_users[user_id]["ws"].send_text(json.dumps(msg, ensure_ascii=False))
        except Exception:
            pass


async def broadcast_room(room_id: str, msg: dict[str, Any]):
    room = active_rooms.get(room_id)
    if not room:
        return
    text = json.dumps(msg, ensure_ascii=False)
    for ws in (room.get("p1_ws"), room.get("p2_ws")):
        if ws:
            try:
                await ws.send_text(text)
            except Exception:
                pass


async def run_draft_timer(room_id: str):
    """Timer regressivo de 60 segundos com auto-pick no timeout."""
    room = active_rooms.get(room_id)
    if not room:
        return
    state: BattleState = room["state"]

    while state.phase == "DRAFT" and state.draft_timer > 0:
        await asyncio.sleep(1)
        # Se a sala foi fechada nesse meio tempo
        if room_id not in active_rooms:
            return
        state.draft_timer -= 1
        await broadcast_room(room_id, {
            "type": "draft_tick",
            "timer": state.draft_timer,
            "p1_locked": state.p1_locked,
            "p2_locked": state.p2_locked,
            "p1_team_ids": state.p1_team_ids,
            "p2_team_ids": state.p2_team_ids,
        })

        if state.p1_locked and state.p2_locked:
            break

    # Se o tempo esgotou ou ambos confirmaram, inicia combate
    if state.phase == "DRAFT":
        state.start_battle_from_draft()
        await broadcast_room(room_id, {
            "type": "battle_started",
            "state": state.to_client_state(),
            "log": "⚔️ Equipes confirmadas! Batalha iniciada!",
        })

        # Se for contra Bot, inicia a rotina de ações do Bot
        if state.is_bot:
            asyncio.create_task(run_bot_loop(room_id))


async def run_bot_loop(room_id: str):
    """Simulador de ações e reações da IA."""
    while True:
        await asyncio.sleep(random.uniform(1.2, 1.8))
        room = active_rooms.get(room_id)
        if not room or room_id not in active_rooms:
            break
        state: BattleState = room["state"]
        if state.phase != "BATTLE":
            break

        # Cooldown ticks
        if state.p1_switch_cooldown > 0:
            state.p1_switch_cooldown = max(0, state.p1_switch_cooldown - 1)
        if state.p2_switch_cooldown > 0:
            state.p2_switch_cooldown = max(0, state.p2_switch_cooldown - 1)

        decision = state.bot_action_tick()
        if not decision:
            continue

        act = decision.get("action")
        if act == "resolve_charged":
            res = state.resolve_charged_attack(use_shield=decision.get("use_shield", False))
            await broadcast_room(room_id, {
                "type": "charged_resolved",
                "result": res,
                "state": state.to_client_state(),
            })
        elif act == "fast_attack":
            res = state.execute_fast_attack(2)
            await broadcast_room(room_id, {
                "type": "fast_attack_done",
                "result": res,
                "state": state.to_client_state(),
            })
        elif act == "charged_attack":
            res = state.queue_charged_attack(2, move_slot=decision.get("slot", 1))
            await broadcast_room(room_id, {
                "type": "charged_prompt",
                "pending": res,
                "state": state.to_client_state(),
            })
        elif act == "switch":
            res = state.switch_pokemon(2, decision.get("target_idx", 0))
            await broadcast_room(room_id, {
                "type": "switch_done",
                "result": res,
                "state": state.to_client_state(),
            })

        # Verifica se finalizou
        if state.phase == "FINISHED":
            finish_battle(room_id)
            break


def finish_battle(room_id: str):
    room = active_rooms.get(room_id)
    if not room:
        return
    state: BattleState = room["state"]
    state.phase = "FINISHED"

    winner_id = None
    if state.winner == 1:
        winner_id = state.p1_id
    elif state.winner == 2:
        winner_id = state.p2_id

    # Salva no SQLite
    try:
        record_battle_result(
            room_id=room_id,
            player1_id=state.p1_id,
            player2_id=state.p2_id,
            player1_name=state.p1_name,
            player2_name=state.p2_name,
            winner_id=winner_id,
            p1_team=state.p1_combatants,
            p2_team=state.p2_combatants,
            turns_played=state.turns_played,
        )
    except Exception as e:
        print(f"Erro ao salvar batalha no banco: {e}")

    asyncio.create_task(broadcast_room(room_id, {
        "type": "battle_ended",
        "winner": state.winner,
        "winner_name": state.p1_name if state.winner == 1 else state.p2_name,
        "state": state.to_client_state(),
        "log": f"🏆 Batalha encerrada! Vencedor: {state.p1_name if state.winner == 1 else state.p2_name}!",
    }))

    # Libera os usuários
    if state.p1_id and state.p1_id in online_users:
        online_users[state.p1_id]["in_battle"] = False
        online_users[state.p1_id]["room_id"] = None
    if state.p2_id and state.p2_id in online_users:
        online_users[state.p2_id]["in_battle"] = False
        online_users[state.p2_id]["room_id"] = None

    asyncio.create_task(broadcast_lobby())


async def handle_ws_message(user_id: int, user: dict[str, Any], ws: WebSocket, data: dict[str, Any]):
    action = data.get("action")

    # 1. Desafiar outro usuário online ou cadastrado
    if action == "challenge":
        target_username = (data.get("target_username") or "").strip()
        target_id = data.get("target_id")

        target_db = None
        if target_id:
            target_db = get_user_by_id(int(target_id))
        elif target_username:
            target_db = get_user_by_username(target_username)

        if not target_db:
            await ws.send_text(json.dumps({
                "type": "error",
                "message": f"Treinador '{target_username or target_id}' não foi encontrado no cadastro.",
            }, ensure_ascii=False))
            return

        if target_db["id"] == user_id:
            await ws.send_text(json.dumps({
                "type": "error",
                "message": "Você não pode desafiar a si mesmo!",
            }, ensure_ascii=False))
            return

        # Se o usuário cadastrado estiver online
        if target_db["id"] in online_users:
            target_status = online_users[target_db["id"]]
            if target_status.get("in_battle"):
                await ws.send_text(json.dumps({
                    "type": "error",
                    "message": f"{target_db['display_name']} já está em uma batalha no momento.",
                }, ensure_ascii=False))
                return

            invite_id = str(uuid.uuid4())[:8]
            pending_invites[invite_id] = {
                "from_user": user,
                "to_user": target_db,
            }

            # Notifica o desafiado
            await send_to_user(target_db["id"], {
                "type": "challenge_received",
                "invite_id": invite_id,
                "challenger": {
                    "id": user["id"],
                    "username": user["username"],
                    "display_name": user["display_name"],
                    "avatar_id": user["avatar_id"],
                    "rating": user["rating"],
                },
                "timeout": 30,
            })

            await ws.send_text(json.dumps({
                "type": "challenge_sent",
                "target": target_db["display_name"],
                "invite_id": invite_id,
            }, ensure_ascii=False))
        else:
            # Usuário cadastrado está offline no momento! Notifica para permitir batalha vs IA de seu perfil
            await ws.send_text(json.dumps({
                "type": "trainer_offline_prompt",
                "target": {
                    "id": target_db["id"],
                    "username": target_db["username"],
                    "display_name": target_db["display_name"],
                    "avatar_id": target_db["avatar_id"],
                    "rating": target_db["rating"],
                },
                "message": f"Treinador '{target_db['display_name']}' está offline no momento.",
            }, ensure_ascii=False))

    # 1.1 Desafiar perfil de treinador offline (IA representa o treinador)
    elif action == "challenge_offline_bot":
        target_id = data.get("target_id")
        target_username = (data.get("target_username") or "").strip()
        target_db = None
        if target_id:
            target_db = get_user_by_id(int(target_id))
        elif target_username:
            target_db = get_user_by_username(target_username)

        bot_name = target_db["display_name"] if target_db else (target_username or "Treinador")
        bot_avatar = target_db["avatar_id"] if target_db else 25
        bot_rating = target_db["rating"] if target_db else 1000

        room_id = f"ghost_{uuid.uuid4().hex[:10]}"
        state = BattleState(
            room_id=room_id,
            p1_id=user["id"],
            p1_name=user["display_name"],
            p2_id=target_db["id"] if target_db else None,
            p2_name=bot_name,
            is_bot=True,
        )

        state.p2_team_ids = auto_pick_team([])
        state.p2_locked = True

        active_rooms[room_id] = {
            "state": state,
            "p1_ws": ws,
            "p2_ws": None,
            "task": None,
        }

        online_users[user["id"]]["in_battle"] = True
        online_users[user["id"]]["room_id"] = room_id

        await ws.send_text(json.dumps({
            "type": "battle_matched",
            "room_id": room_id,
            "role": 1,
            "opponent": {
                "display_name": bot_name,
                "username": target_db["username"] if target_db else "",
                "rating": bot_rating,
                "avatar_id": bot_avatar,
                "is_bot": True,
            },
            "state": state.to_client_state(for_player=1),
        }, ensure_ascii=False))

        active_rooms[room_id]["task"] = asyncio.create_task(run_draft_timer(room_id))
        await broadcast_lobby()

    # 2. Aceitar desafio
    elif action == "accept_challenge":
        invite_id = data.get("invite_id")
        inv = pending_invites.pop(invite_id, None)
        if not inv:
            await ws.send_text(json.dumps({"type": "error", "message": "Convite expirado ou não encontrado."}))
            return

        p1_u = inv["from_user"]
        p2_u = inv["to_user"]

        if p1_u["id"] not in online_users or p2_u["id"] not in online_users:
            await ws.send_text(json.dumps({"type": "error", "message": "Um dos jogadores se desconectou."}))
            return

        room_id = f"room_{uuid.uuid4().hex[:10]}"
        state = BattleState(
            room_id=room_id,
            p1_id=p1_u["id"],
            p1_name=p1_u["display_name"],
            p2_id=p2_u["id"],
            p2_name=p2_u["display_name"],
            is_bot=False,
        )

        active_rooms[room_id] = {
            "state": state,
            "p1_ws": online_users[p1_u["id"]]["ws"],
            "p2_ws": online_users[p2_u["id"]]["ws"],
            "task": None,
        }

        online_users[p1_u["id"]]["in_battle"] = True
        online_users[p1_u["id"]]["room_id"] = room_id
        online_users[p2_u["id"]]["in_battle"] = True
        online_users[p2_u["id"]]["room_id"] = room_id

        # Inicia a sala de seleção sincronizada
        await send_to_user(p1_u["id"], {
            "type": "battle_matched",
            "room_id": room_id,
            "role": 1,
            "opponent": p2_u,
            "state": state.to_client_state(for_player=1),
        })
        await send_to_user(p2_u["id"], {
            "type": "battle_matched",
            "room_id": room_id,
            "role": 2,
            "opponent": p1_u,
            "state": state.to_client_state(for_player=2),
        })

        active_rooms[room_id]["task"] = asyncio.create_task(run_draft_timer(room_id))
        await broadcast_lobby()

    # 3. Recusar desafio
    elif action == "decline_challenge":
        invite_id = data.get("invite_id")
        inv = pending_invites.pop(invite_id, None)
        if inv:
            await send_to_user(inv["from_user"]["id"], {
                "type": "challenge_declined",
                "by": user["display_name"],
            })

    # 4. Iniciar Batalha contra Bot (Treino IA)
    elif action == "start_bot_battle":
        room_id = f"bot_{uuid.uuid4().hex[:10]}"
        bot_name = random.choice(BOT_NAMES)
        state = BattleState(
            room_id=room_id,
            p1_id=user["id"],
            p1_name=user["display_name"],
            p2_id=None,
            p2_name=bot_name,
            is_bot=True,
        )

        # Bot já escolhe 3 Pokémon equilibrados automaticamente
        state.p2_team_ids = auto_pick_team([])
        state.p2_locked = True

        active_rooms[room_id] = {
            "state": state,
            "p1_ws": ws,
            "p2_ws": None,
            "task": None,
        }

        online_users[user["id"]]["in_battle"] = True
        online_users[user["id"]]["room_id"] = room_id

        await ws.send_text(json.dumps({
            "type": "battle_matched",
            "room_id": room_id,
            "role": 1,
            "opponent": {"display_name": bot_name, "rating": 1000, "avatar_id": 25, "is_bot": True},
            "state": state.to_client_state(for_player=1),
        }, ensure_ascii=False))

        active_rooms[room_id]["task"] = asyncio.create_task(run_draft_timer(room_id))
        await broadcast_lobby()

    # 5. Escolha / Draft de Pokémon (dentro dos 60 segundos)
    elif action == "draft_update":
        room_id = data.get("room_id")
        team_ids = [int(x) for x in data.get("team_ids", [])][:3]
        locked = bool(data.get("locked", False))

        room = active_rooms.get(room_id)
        if not room:
            return
        state: BattleState = room["state"]
        if state.phase != "DRAFT":
            return

        # Valida limite de stamina
        total_stamina = sum(calculate_pokemon_stamina(POKEMON_MAP[pid]) for pid in team_ids if pid in POKEMON_MAP)
        if total_stamina > TEAM_STAMINA_LIMIT:
            await ws.send_text(json.dumps({
                "type": "error",
                "message": f"Stamina total ({total_stamina}) excedeu o limite máximo de {TEAM_STAMINA_LIMIT} SP!",
            }, ensure_ascii=False))
            return

        is_p1 = (state.p1_id == user_id)
        if is_p1:
            state.p1_team_ids = team_ids
            state.p1_locked = locked
        else:
            state.p2_team_ids = team_ids
            state.p2_locked = locked

        await broadcast_room(room_id, {
            "type": "draft_updated",
            "p1_team_ids": state.p1_team_ids,
            "p2_team_ids": state.p2_team_ids,
            "p1_locked": state.p1_locked,
            "p2_locked": state.p2_locked,
        })

        # Se ambos travaram antes dos 60s
        if state.p1_locked and state.p2_locked:
            state.start_battle_from_draft()
            await broadcast_room(room_id, {
                "type": "battle_started",
                "state": state.to_client_state(),
                "log": "⚔️ Ambos os treinadores confirmaram! O combate começou!",
            })
            if state.is_bot:
                asyncio.create_task(run_bot_loop(room_id))

    # 6. Ataque Rápido
    elif action == "fast_attack":
        room_id = data.get("room_id")
        room = active_rooms.get(room_id)
        if not room:
            return
        state: BattleState = room["state"]
        player_num = 1 if state.p1_id == user_id else 2

        res = state.execute_fast_attack(player_num)
        if res.get("ok"):
            await broadcast_room(room_id, {
                "type": "fast_attack_done",
                "result": res,
                "state": state.to_client_state(),
            })
            if state.phase == "FINISHED":
                finish_battle(room_id)

    # 7. Disparar Ataque Carregado
    elif action == "charged_attack":
        room_id = data.get("room_id")
        slot = int(data.get("slot", 1))
        room = active_rooms.get(room_id)
        if not room:
            return
        state: BattleState = room["state"]
        player_num = 1 if state.p1_id == user_id else 2

        res = state.queue_charged_attack(player_num, slot)
        if res.get("ok"):
            await broadcast_room(room_id, {
                "type": "charged_prompt",
                "pending": res,
                "state": state.to_client_state(),
            })

    # 8. Decisão de Usar Escudo
    elif action == "resolve_shield":
        room_id = data.get("room_id")
        use_shield = bool(data.get("use_shield", False))
        room = active_rooms.get(room_id)
        if not room:
            return
        state: BattleState = room["state"]

        res = state.resolve_charged_attack(use_shield=use_shield)
        if res.get("ok"):
            await broadcast_room(room_id, {
                "type": "charged_resolved",
                "result": res,
                "state": state.to_client_state(),
            })
            if state.phase == "FINISHED":
                finish_battle(room_id)

    # 9. Trocar Pokémon em campo
    elif action == "switch_pokemon":
        room_id = data.get("room_id")
        target_idx = int(data.get("target_idx", 0))
        room = active_rooms.get(room_id)
        if not room:
            return
        state: BattleState = room["state"]
        player_num = 1 if state.p1_id == user_id else 2

        res = state.switch_pokemon(player_num, target_idx)
        if res.get("ok"):
            await broadcast_room(room_id, {
                "type": "switch_done",
                "result": res,
                "state": state.to_client_state(),
            })

    # 10. Desistir / Render-se
    elif action == "surrender":
        room_id = data.get("room_id")
        room = active_rooms.get(room_id)
        if not room:
            return
        state: BattleState = room["state"]
        player_num = 1 if state.p1_id == user_id else 2
        state.winner = 2 if player_num == 1 else 1
        state.phase = "FINISHED"
        state.logs.append(f"🏳️ {state.p1_name if player_num == 1 else state.p2_name} desistiu da partida.")
        finish_battle(room_id)


# ==================== WEBSOCKET ROUTE ====================


async def websocket_battle_endpoint(websocket: WebSocket, token: str = ""):
    await websocket.accept()
    user = get_user_by_token(token)
    if not user:
        await websocket.send_text(json.dumps({
            "type": "auth_error",
            "message": "Autenticação necessária. Faça login de Treinador.",
        }, ensure_ascii=False))
        await websocket.close()
        return

    user_id = user["id"]
    online_users[user_id] = {
        "ws": websocket,
        "user": user,
        "in_battle": False,
        "room_id": None,
    }

    # Confirma conexão e envia dados do perfil
    await websocket.send_text(json.dumps({
        "type": "auth_success",
        "user": user,
        "stamina_limit": TEAM_STAMINA_LIMIT,
    }, ensure_ascii=False))

    await broadcast_lobby()

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                data = json.loads(raw)
            except Exception:
                continue
            await handle_ws_message(user_id, user, websocket, data)
    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"WS error user {user_id}: {e}")
    finally:
        # Limpeza ao desconectar
        data = online_users.pop(user_id, None)
        if data and data.get("room_id"):
            room_id = data["room_id"]
            room = active_rooms.get(room_id)
            if room:
                state: BattleState = room["state"]
                if state.phase != "FINISHED":
                    state.winner = 2 if state.p1_id == user_id else 1
                    state.phase = "FINISHED"
                    state.logs.append(f"🔌 {user['display_name']} desconectou-se da partida.")
                    finish_battle(room_id)
        await broadcast_lobby()

