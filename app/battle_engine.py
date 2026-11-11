"""
Motor da Arena Pokémon Online — duelos estratégicos em tempo real por rodadas.

Carrega todos os Pokémon cadastrados em data/pokemon.json (1.025+ espécies),
calcula o custo balanceado de Stamina com base nos atributos totais e resolve
rodadas simultâneas (Golpe, Técnica, Guarda ou Trocar) com tabela completa de
vantagens entre os 18 tipos oficiais Pokémon.
"""
from __future__ import annotations

import json
import random
from pathlib import Path
from typing import Any

DATA_PATH = Path(__file__).resolve().parent.parent / "data" / "pokemon.json"

TEAM_SIZE = 3
TEAM_BUDGET = 1550          # Limite de Stamina total para 3 Pokémon
DRAFT_SECONDS = 60
ROUND_SECONDS = 20
MAX_FOCO = 5
START_FOCO = 1
TECH_COST = 3
STRIKE_POWER = 26
TECH_SCALE = 1.32
STRONG_MULT = 1.5
SUPER_STRONG_MULT = 1.85
WEAK_MULT = 0.68
DOUBLE_WEAK_MULT = 0.5
GUARD_VS_STRIKE = 0.4
GUARD_VS_TECH = 0.55
BURN_ROUNDS = 2
BURN_FRACTION = 0.07
REGEN_FRACTION = 0.14
DRAIN_FOCO = 2

EFFECT_TEXT = {
    "queimar": f"Queima o alvo por {BURN_ROUNDS} rodadas",
    "regenerar": "Recupera parte da própria vida",
    "drenar": f"Tira {DRAIN_FOCO} de Foco do alvo",
    "quebra": "Atravessa a Guarda",
    "impeto": "Age primeiro e devolve 1 de Foco",
}

# Todos os 18 tipos oficiais com cor, técnica característica e efeito tático
ELEMENTS: dict[str, dict[str, Any]] = {
    "fire":     {"name": "Fogo",      "color": "#ff7a3d", "tech": "Lança-Chamas",       "power": 36, "effect": "queimar"},
    "water":    {"name": "Água",      "color": "#3a9bff", "tech": "Hidro Bomba",        "power": 37, "effect": "drenar"},
    "grass":    {"name": "Planta",    "color": "#58b368", "tech": "Raio Solar",         "power": 35, "effect": "regenerar"},
    "electric": {"name": "Elétrico",  "color": "#ffd23f", "tech": "Choque do Trovão",   "power": 34, "effect": "impeto"},
    "ice":      {"name": "Gelo",      "color": "#74d7ee", "tech": "Raio Congelante",    "power": 36, "effect": "drenar"},
    "fighting": {"name": "Lutador",   "color": "#e05a47", "tech": "Soco Dinâmico",      "power": 38, "effect": "quebra"},
    "poison":   {"name": "Venenoso",  "color": "#b45cd9", "tech": "Bomba de Lodo",      "power": 35, "effect": "queimar"},
    "ground":   {"name": "Terra",     "color": "#d4a656", "tech": "Terremoto",          "power": 38, "effect": "quebra"},
    "flying":   {"name": "Voador",    "color": "#89a8ff", "tech": "Ataque Aéreo",       "power": 34, "effect": "impeto"},
    "psychic":  {"name": "Psíquico",  "color": "#ff65a3", "tech": "Psíquico",           "power": 35, "effect": "impeto"},
    "bug":      {"name": "Inseto",    "color": "#94c43f", "tech": "Zumbido",            "power": 35, "effect": "regenerar"},
    "rock":     {"name": "Pedra",     "color": "#c9a66b", "tech": "Gume de Pedra",      "power": 38, "effect": "quebra"},
    "ghost":    {"name": "Fantasma",  "color": "#8d72e1", "tech": "Bola Sombria",       "power": 36, "effect": "drenar"},
    "dragon":   {"name": "Dragão",    "color": "#6e68ff", "tech": "Meteoro do Dragão",  "power": 36, "effect": "impeto"},
    "steel":    {"name": "Aço",       "color": "#9bb0c1", "tech": "Canhão de Flash",    "power": 37, "effect": "quebra"},
    "dark":     {"name": "Sombrio",   "color": "#7c6b86", "tech": "Pulso Sombrio",      "power": 36, "effect": "drenar"},
    "fairy":    {"name": "Fada",      "color": "#f48fb1", "tech": "Brilho Mágico",      "power": 35, "effect": "regenerar"},
    "normal":   {"name": "Normal",    "color": "#a8b2bd", "tech": "Hiper Raio",         "power": 36, "effect": "regenerar"},
}

# Vantagens oficiais (2x) e desvantagens (0.5x) entre os 18 tipos
STRONG_AGAINST: dict[str, tuple[str, ...]] = {
    "fire":     ("grass", "ice", "bug", "steel"),
    "water":    ("fire", "ground", "rock"),
    "grass":    ("water", "ground", "rock"),
    "electric": ("water", "flying"),
    "ice":      ("grass", "ground", "flying", "dragon"),
    "fighting": ("normal", "ice", "rock", "dark", "steel"),
    "poison":   ("grass", "fairy"),
    "ground":   ("fire", "electric", "poison", "rock", "steel"),
    "flying":   ("grass", "fighting", "bug"),
    "psychic":  ("fighting", "poison"),
    "bug":      ("grass", "psychic", "dark"),
    "rock":     ("fire", "ice", "flying", "bug"),
    "ghost":    ("psychic", "ghost"),
    "dragon":   ("dragon",),
    "steel":    ("ice", "rock", "fairy"),
    "dark":     ("psychic", "ghost"),
    "fairy":    ("fighting", "dragon", "dark"),
    "normal":   (),
}

WEAK_AGAINST: dict[str, tuple[str, ...]] = {
    "fire":     ("fire", "water", "rock", "dragon"),
    "water":    ("water", "grass", "dragon"),
    "grass":    ("fire", "grass", "poison", "flying", "bug", "dragon", "steel"),
    "electric": ("electric", "grass", "dragon", "ground"),
    "ice":      ("fire", "water", "ice", "steel"),
    "fighting": ("poison", "flying", "psychic", "bug", "fairy", "ghost"),
    "poison":   ("poison", "ground", "rock", "ghost", "steel"),
    "ground":   ("grass", "bug", "flying"),
    "flying":   ("electric", "rock", "steel"),
    "psychic":  ("psychic", "steel", "dark"),
    "bug":      ("fire", "fighting", "poison", "flying", "ghost", "steel", "fairy"),
    "rock":     ("fighting", "ground", "steel"),
    "ghost":    ("dark", "normal"),
    "dragon":   ("steel", "fairy"),
    "steel":    ("fire", "water", "electric", "steel"),
    "dark":     ("fighting", "dark", "fairy"),
    "fairy":    ("fire", "poison", "steel"),
    "normal":   ("rock", "steel", "ghost"),
}


def element_multiplier(attacker: str, defender: str | list[str]) -> float:
    """Calcula o multiplicador de vantagem de tipo contra um ou dois tipos defensivos."""
    def_types = [defender] if isinstance(defender, str) else list(defender or ["normal"])
    strong_list = STRONG_AGAINST.get(attacker, ())
    weak_list = WEAK_AGAINST.get(attacker, ())
    score = 0
    for d in def_types[:2]:
        if d in strong_list:
            score += 1
        elif d in weak_list:
            score -= 1
    if score >= 2:
        return SUPER_STRONG_MULT
    if score == 1:
        return STRONG_MULT
    if score == -1:
        return WEAK_MULT
    if score <= -2:
        return DOUBLE_WEAK_MULT
    return 1.0


def _pokemon_to_fighter(p: dict[str, Any]) -> dict[str, Any]:
    pid = int(p["id"])
    raw_types = [t for t in (p.get("types") or ["normal"]) if t in ELEMENTS] or ["normal"]
    primary = raw_types[0]
    secondary = raw_types[1] if len(raw_types) > 1 else primary
    el_info = ELEMENTS[primary]
    c1 = el_info["color"]
    c2 = ELEMENTS[secondary]["color"] if secondary != primary else "#ffe082"

    stats = p.get("stats") or {}
    base_hp = int(stats.get("hp", 60))
    base_atk = (int(stats.get("attack", 65)) + int(stats.get("sp_attack", 65))) / 2
    base_def = (int(stats.get("defense", 65)) + int(stats.get("sp_defense", 65))) / 2
    base_spd = int(stats.get("speed", 60))
    bst = int(stats.get("total") or (base_hp + int(stats.get("attack", 65)) + int(stats.get("defense", 65))
                                   + int(stats.get("sp_attack", 65)) + int(stats.get("sp_defense", 65)) + base_spd))

    # Stamina entre 200 e 720 garantindo equilíbrio com orçamento de 1550 para 3 Pokémon
    stamina_cost = max(200, min(720, bst))

    return {
        "id": pid,
        "name": p["name"],
        "element": primary,
        "types": raw_types,
        "types_pt": p.get("types_pt") or [ELEMENTS[t]["name"] for t in raw_types],
        "hp": 80 + round(base_hp * 0.65),
        "atk": max(30, round(base_atk)),
        "def": max(30, round(base_def)),
        "spd": max(20, base_spd),
        "cost": stamina_cost,
        "colors": [c1, c2],
        "tech": {
            "name": el_info["tech"],
            "power": el_info["power"],
            "effect": el_info["effect"],
            "effect_text": EFFECT_TEXT[el_info["effect"]],
        },
    }


def _load_roster() -> list[dict[str, Any]]:
    if not DATA_PATH.exists():
        return []
    raw = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    fighters = [_pokemon_to_fighter(p) for p in raw]
    fighters.sort(key=lambda f: f["id"])
    return fighters


ROSTER: list[dict[str, Any]] = _load_roster()
ROSTER_BY_ID: dict[int, dict[str, Any]] = {c["id"]: c for c in ROSTER}


def team_cost(team_ids: list[int]) -> int:
    return sum(ROSTER_BY_ID[cid]["cost"] for cid in team_ids if cid in ROSTER_BY_ID)


def validate_team(team_ids: list[int]) -> str | None:
    if len(team_ids) > TEAM_SIZE:
        return f"Escolha no máximo {TEAM_SIZE} Pokémon."
    if len(set(team_ids)) != len(team_ids):
        return "Não vale repetir o mesmo Pokémon na equipe."
    if any(cid not in ROSTER_BY_ID for cid in team_ids):
        return "Um dos Pokémon escolhidos não existe na Pokédex."
    if team_cost(team_ids) > TEAM_BUDGET:
        return f"O trio ultrapassa o limite de {TEAM_BUDGET} de Stamina."
    return None


def auto_pick_team(partial_ids: list[int] | None = None) -> list[int]:
    """Completa até 3 Pokémon sem ultrapassar o orçamento de Stamina (usado no fim dos 60s ou para a IA)."""
    picked = [cid for cid in (partial_ids or []) if cid in ROSTER_BY_ID][:TEAM_SIZE]
    used_elements = {ROSTER_BY_ID[cid]["element"] for cid in picked}
    spent = team_cost(picked)

    while len(picked) < TEAM_SIZE:
        slots_left = TEAM_SIZE - len(picked)
        min_reserve = 200 * (slots_left - 1)
        max_allow = TEAM_BUDGET - spent - min_reserve
        candidates = [c for c in ROSTER if c["id"] not in picked and c["cost"] <= max_allow]
        if not candidates:
            # Fallback para os mais leves caso o jogador já tenha gasto quase tudo
            candidates = sorted((c for c in ROSTER if c["id"] not in picked), key=lambda c: c["cost"])
        if not candidates:
            break
        # Prioriza variedade de tipos e Pokémon competitivos (350..560 SP) dentro do orçamento
        diverse = [c for c in candidates if c["element"] not in used_elements and 320 <= c["cost"] <= 560]
        pool = diverse or [c for c in candidates if c["element"] not in used_elements] or candidates
        chosen = random.choice(pool)
        picked.append(chosen["id"])
        used_elements.add(chosen["element"])
        spent += chosen["cost"]
    return picked


def build_combatant(cid: int) -> dict[str, Any]:
    base = ROSTER_BY_ID[cid]
    return {
        "id": base["id"],
        "name": base["name"],
        "element": base["element"],
        "types": list(base["types"]),
        "types_pt": list(base["types_pt"]),
        "colors": list(base["colors"]),
        "hp": base["hp"],
        "max_hp": base["hp"],
        "atk": base["atk"],
        "def": base["def"],
        "spd": base["spd"],
        "cost": base["cost"],
        "foco": START_FOCO,
        "tech": dict(base["tech"]),
        "burn": 0,
        "guarding": False,
        "guarded_last": False,
        "fainted": False,
    }


class BattleState:
    """Estado e regras de uma partida entre dois treinadores."""

    def __init__(self, room_id: str, p1_id: int, p1_name: str,
                 p2_id: int | None, p2_name: str, is_bot: bool = False):
        self.room_id = room_id
        self.p1_id, self.p1_name = p1_id, p1_name
        self.p2_id, self.p2_name = p2_id, p2_name
        self.is_bot = is_bot

        self.phase = "DRAFT"
        self.draft_timer = DRAFT_SECONDS
        self.team_ids: dict[int, list[int]] = {1: [], 2: []}
        self.locked: dict[int, bool] = {1: False, 2: False}

        self.teams: dict[int, list[dict[str, Any]]] = {1: [], 2: []}
        self.active_idx = {1: 0, 2: 0}
        self.switched_last = {1: False, 2: False}

        self.round_no = 0
        self.round_seconds = ROUND_SECONDS
        self.choices: dict[int, dict[str, Any] | None] = {1: None, 2: None}
        self.winner: int | None = None
        self.logs: list[str] = []

    def name_of(self, player: int) -> str:
        return self.p1_name if player == 1 else self.p2_name

    def player_of(self, user_id: int) -> int:
        return 1 if self.p1_id == user_id else 2

    def active(self, player: int) -> dict[str, Any]:
        return self.teams[player][self.active_idx[player]]

    def both_ready(self) -> bool:
        return self.choices[1] is not None and self.choices[2] is not None

    def start_battle_from_draft(self) -> None:
        for player in (1, 2):
            self.team_ids[player] = auto_pick_team(self.team_ids[player])
            self.teams[player] = [build_combatant(cid) for cid in self.team_ids[player]]
        self.phase = "BATTLE"
        self.logs.append(
            f"{self.p1_name} envia {self.active(1)['name']}; "
            f"{self.p2_name} envia {self.active(2)['name']}!"
        )

    def begin_round(self) -> None:
        self.round_no += 1
        self.choices = {1: None, 2: None}

    def available_actions(self, player: int) -> dict[str, Any]:
        me = self.active(player)
        bench = [i for i, c in enumerate(self.teams[player])
                 if i != self.active_idx[player] and c["hp"] > 0]
        return {
            "golpe": True,
            "tecnica": me["foco"] >= TECH_COST,
            "guarda": not me["guarded_last"],
            "trocar": bench if not self.switched_last[player] else [],
        }

    def submit_action(self, player: int, action: dict[str, Any]) -> dict[str, Any]:
        if self.phase != "BATTLE":
            return {"ok": False, "reason": "A partida não está em andamento."}
        if self.choices[player] is not None:
            return {"ok": False, "reason": "Você já escolheu a ação desta rodada."}
        kind = action.get("kind")
        allowed = self.available_actions(player)
        if kind == "golpe":
            choice = {"kind": "golpe"}
        elif kind == "tecnica":
            if not allowed["tecnica"]:
                return {"ok": False, "reason": f"A Técnica custa {TECH_COST} de Foco."}
            choice = {"kind": "tecnica"}
        elif kind == "guarda":
            if not allowed["guarda"]:
                return {"ok": False, "reason": "Não dá para usar Guarda duas rodadas seguidas."}
            choice = {"kind": "guarda"}
        elif kind == "trocar":
            try:
                idx = int(action.get("idx", -1))
            except (TypeError, ValueError):
                idx = -1
            if idx not in allowed["trocar"]:
                reason = ("Não dá para trocar duas rodadas seguidas."
                          if self.switched_last[player] else "Esse Pokémon não pode entrar agora.")
                return {"ok": False, "reason": reason}
            choice = {"kind": "trocar", "idx": idx}
        else:
            return {"ok": False, "reason": "Ação desconhecida."}
        self.choices[player] = choice
        return {"ok": True}

    def resolve_round(self) -> list[dict[str, Any]]:
        events: list[dict[str, Any]] = []
        acts = {p: (self.choices[p] or {"kind": "golpe"}) for p in (1, 2)}
        lost_turn: set[int] = set()

        for p in (1, 2):
            if acts[p]["kind"] == "trocar":
                self.active(p)["guarded_last"] = False
                self.active_idx[p] = acts[p]["idx"]
                events.append(self._event("switch", p, idx=acts[p]["idx"],
                                          text=f"{self.name_of(p)} chama {self.active(p)['name']}!"))
        for p in (1, 2):
            if acts[p]["kind"] == "guarda":
                me = self.active(p)
                me["guarding"] = True
                me["foco"] = min(MAX_FOCO, me["foco"] + 2)
                events.append(self._event("guard", p, foco=me["foco"],
                                          text=f"{me['name']} ergue a Guarda!"))

        attackers = [p for p in (1, 2) if acts[p]["kind"] in ("golpe", "tecnica")]
        attackers.sort(key=lambda p: (self._priority(p, acts[p]), self.active(p)["spd"], random.random()),
                       reverse=True)
        for p in attackers:
            if self.phase != "BATTLE" or p in lost_turn:
                continue
            target_player = 3 - p
            events.extend(self._attack(p, acts[p]["kind"]))
            if self.active(target_player)["hp"] <= 0:
                lost_turn.add(target_player)
                events.extend(self._handle_faint(target_player))

        if self.phase == "BATTLE":
            events.extend(self._end_of_round(acts))
        self.logs.extend(e["text"] for e in events if e.get("text"))
        return events

    def _priority(self, player: int, act: dict[str, Any]) -> int:
        tech = self.active(player)["tech"]
        return 1 if act["kind"] == "tecnica" and tech["effect"] == "impeto" else 0

    def _event(self, t: str, player: int, **data: Any) -> dict[str, Any]:
        return {"t": t, "p": player, **data}

    def _attack(self, player: int, kind: str) -> list[dict[str, Any]]:
        atk = self.active(player)
        target_player = 3 - player
        tgt = self.active(target_player)
        is_tech = kind == "tecnica"
        effect = atk["tech"]["effect"] if is_tech else None

        if is_tech:
            atk["foco"] -= TECH_COST
            power, move_name = atk["tech"]["power"] * TECH_SCALE, atk["tech"]["name"]
        else:
            atk["foco"] = min(MAX_FOCO, atk["foco"] + 1)
            power, move_name = STRIKE_POWER, "Golpe"
        if effect == "impeto":
            atk["foco"] = min(MAX_FOCO, atk["foco"] + 1)

        mult = element_multiplier(atk["element"], tgt["types"])
        guarded = tgt["guarding"]
        broke_guard = guarded and effect == "quebra"
        guard_mult = 1.0
        if guarded and not broke_guard:
            guard_mult = GUARD_VS_TECH if is_tech else GUARD_VS_STRIKE
        ratio = (atk["atk"] + 45) / (tgt["def"] + 45)
        dmg = max(4, round(power * ratio * mult * guard_mult * random.uniform(0.93, 1.07)))
        tgt["hp"] = max(0, tgt["hp"] - dmg)

        note = " É super eficaz!" if mult > 1 else (" Não é muito eficaz..." if mult < 1 else "")
        if broke_guard:
            note += " Quebrou a Guarda!"
        elif guarded:
            note += " A Guarda amorteceu."
        events = [self._event(
            "attack", player, kind=kind, name=move_name, element=atk["element"], dmg=dmg, mult=mult,
            guarded=guarded, broke_guard=broke_guard, target_hp=tgt["hp"], foco=atk["foco"],
            text=f"{atk['name']} usa {move_name} em {tgt['name']}: {dmg} de dano.{note}",
        )]

        if effect == "queimar" and tgt["hp"] > 0:
            tgt["burn"] = BURN_ROUNDS
            events.append(self._event("status", target_player, k="queimar",
                                      text=f"{tgt['name']} sofre queimadura!"))
        elif effect == "regenerar":
            heal = min(atk["max_hp"] - atk["hp"], round(atk["max_hp"] * REGEN_FRACTION))
            if heal > 0:
                atk["hp"] += heal
                events.append(self._event("heal", player, heal=heal, hp=atk["hp"],
                                          text=f"{atk['name']} recupera {heal} de HP."))
        elif effect == "drenar" and tgt["hp"] > 0 and tgt["foco"] > 0:
            tgt["foco"] = max(0, tgt["foco"] - DRAIN_FOCO)
            events.append(self._event("drain", target_player, foco=tgt["foco"],
                                      text=f"{tgt['name']} perdeu Foco!"))
        return events

    def _handle_faint(self, player: int) -> list[dict[str, Any]]:
        fallen = self.active(player)
        fallen["fainted"] = True
        fallen["burn"] = 0
        events = [self._event("faint", player, text=f"{fallen['name']} fora de combate!")]
        alive = [i for i, c in enumerate(self.teams[player]) if c["hp"] > 0]
        if not alive:
            self.phase = "FINISHED"
            self.winner = 3 - player
            events.append(self._event("end", self.winner,
                                      text=f"{self.name_of(self.winner)} venceu o duelo!"))
        else:
            self.active_idx[player] = alive[0]
            events.append(self._event("enter", player, idx=alive[0],
                                      text=f"{self.name_of(player)} envia {self.active(player)['name']}!"))
        return events

    def _end_of_round(self, acts: dict[int, dict[str, Any]]) -> list[dict[str, Any]]:
        events: list[dict[str, Any]] = []
        for p in (1, 2):
            me = self.active(p)
            if me["burn"] > 0 and me["hp"] > 1:
                dmg = min(me["hp"] - 1, max(1, round(me["max_hp"] * BURN_FRACTION)))
                me["hp"] -= dmg
                me["burn"] -= 1
                events.append(self._event("burn", p, dmg=dmg, hp=me["hp"],
                                          text=f"{me['name']} sofre {dmg} da queimadura."))
            for c in self.teams[p]:
                c["guarded_last"] = c["guarding"]
                c["guarding"] = False
            self.switched_last[p] = acts[p]["kind"] == "trocar"
        return events

    def bot_choose(self, player: int = 2) -> dict[str, Any]:
        me, foe = self.active(player), self.active(3 - player)
        allowed = self.available_actions(player)
        my_edge = element_multiplier(me["element"], foe["types"])
        foe_edge = element_multiplier(foe["element"], me["types"])

        if allowed["trocar"] and foe_edge > 1 and my_edge <= 1 and random.random() < 0.5:
            better = [i for i in allowed["trocar"]
                      if element_multiplier(foe["element"], self.teams[player][i]["types"]) < 1]
            if better:
                return {"kind": "trocar", "idx": random.choice(better)}
        if allowed["tecnica"] and (my_edge >= 1 or random.random() < 0.65):
            if random.random() < 0.82:
                return {"kind": "tecnica"}
        if allowed["guarda"] and foe["foco"] >= TECH_COST and random.random() < 0.55:
            return {"kind": "guarda"}
        if allowed["guarda"] and me["foco"] < TECH_COST and random.random() < 0.18:
            return {"kind": "guarda"}
        return {"kind": "golpe"}

    def to_client_state(self) -> dict[str, Any]:
        return {
            "room_id": self.room_id,
            "phase": self.phase,
            "draft_timer": self.draft_timer,
            "round_no": self.round_no,
            "round_seconds": self.round_seconds,
            "is_bot": self.is_bot,
            "p1_name": self.p1_name, "p2_name": self.p2_name,
            "p1_id": self.p1_id, "p2_id": self.p2_id,
            "p1_locked": self.locked[1], "p2_locked": self.locked[2],
            "p1_team_ids": self.team_ids[1], "p2_team_ids": self.team_ids[2],
            "p1_team": self.teams[1], "p2_team": self.teams[2],
            "p1_active_idx": self.active_idx[1], "p2_active_idx": self.active_idx[2],
            "p1_ready": self.choices[1] is not None, "p2_ready": self.choices[2] is not None,
            "p1_actions": self.available_actions(1) if self.phase == "BATTLE" else None,
            "p2_actions": self.available_actions(2) if self.phase == "BATTLE" else None,
            "winner": self.winner,
            "winner_name": self.name_of(self.winner) if self.winner else None,
            "logs": self.logs[-8:],
        }


def rules_payload() -> dict[str, Any]:
    """Dados estáticos que o cliente precisa para montar o draft (1.025 Pokémon) e ajuda."""
    return {
        "roster": ROSTER,
        "elements": {k: {"name": v["name"], "color": v["color"]} for k, v in ELEMENTS.items()},
        "strong_against": {k: list(v) for k, v in STRONG_AGAINST.items()},
        "team_size": TEAM_SIZE,
        "team_budget": TEAM_BUDGET,
        "draft_seconds": DRAFT_SECONDS,
        "round_seconds": ROUND_SECONDS,
        "max_foco": MAX_FOCO,
        "tech_cost": TECH_COST,
    }
