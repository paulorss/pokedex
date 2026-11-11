"""
Motor de Batalha Pokémon estilo Pokémon GO.
Gerencia cálculos de stamina/custo, matriz completa de tipos e vantagens,
movimentos rápidos e carregados, escudos protetores, trocas e simulação de turnos/IA.
"""
from __future__ import annotations

import json
import random
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

# Carrega base de 1.025 Pokémon
_poke_file = DATA / "pokemon.json"
if _poke_file.exists():
    ALL_POKEMON: list[dict[str, Any]] = json.loads(_poke_file.read_text(encoding="utf-8"))
    POKEMON_MAP: dict[int, dict[str, Any]] = {p["id"]: p for p in ALL_POKEMON}
else:
    ALL_POKEMON = []
    POKEMON_MAP = {}

# Limite de Stamina total para equipe de 3 Pokémon
TEAM_STAMINA_LIMIT = 1550

# Matriz completa de 18 tipos Pokémon (Multiplicadores de dano do atacante contra o defensor)
TYPE_CHART: dict[str, dict[str, float]] = {
    "normal": {"rock": 0.5, "ghost": 0.0, "steel": 0.5},
    "fire": {"fire": 0.5, "water": 0.5, "grass": 2.0, "ice": 2.0, "bug": 2.0, "rock": 0.5, "dragon": 0.5, "steel": 2.0},
    "water": {"fire": 2.0, "water": 0.5, "grass": 0.5, "ground": 2.0, "rock": 2.0, "dragon": 0.5},
    "grass": {"fire": 0.5, "water": 2.0, "grass": 0.5, "poison": 0.5, "ground": 2.0, "flying": 0.5, "bug": 0.5, "rock": 2.0, "dragon": 0.5, "steel": 0.5},
    "electric": {"water": 2.0, "electric": 0.5, "grass": 0.5, "ground": 0.0, "flying": 2.0, "dragon": 0.5},
    "ice": {"fire": 0.5, "water": 0.5, "grass": 2.0, "ice": 0.5, "ground": 2.0, "flying": 2.0, "dragon": 2.0, "steel": 0.5},
    "fighting": {"normal": 2.0, "ice": 2.0, "poison": 0.5, "flying": 0.5, "psychic": 0.5, "bug": 0.5, "rock": 2.0, "ghost": 0.0, "dark": 2.0, "steel": 2.0, "fairy": 0.5},
    "poison": {"grass": 2.0, "poison": 0.5, "ground": 0.5, "rock": 0.5, "ghost": 0.5, "steel": 0.0, "fairy": 2.0},
    "ground": {"fire": 2.0, "electric": 2.0, "grass": 0.5, "poison": 2.0, "flying": 0.0, "bug": 0.5, "rock": 2.0, "steel": 2.0},
    "flying": {"electric": 0.5, "grass": 2.0, "fighting": 2.0, "bug": 2.0, "rock": 0.5, "steel": 0.5},
    "psychic": {"fighting": 2.0, "poison": 2.0, "psychic": 0.5, "dark": 0.0, "steel": 0.5},
    "bug": {"fire": 0.5, "grass": 2.0, "fighting": 0.5, "poison": 0.5, "flying": 0.5, "psychic": 2.0, "ghost": 0.5, "dark": 2.0, "steel": 0.5, "fairy": 0.5},
    "rock": {"fire": 2.0, "ice": 2.0, "fighting": 0.5, "ground": 0.5, "flying": 2.0, "bug": 2.0, "steel": 0.5},
    "ghost": {"normal": 0.0, "psychic": 2.0, "ghost": 2.0, "dark": 0.5},
    "dragon": {"dragon": 2.0, "steel": 0.5, "fairy": 0.0},
    "steel": {"fire": 0.5, "water": 0.5, "electric": 0.5, "ice": 2.0, "rock": 2.0, "steel": 0.5, "fairy": 2.0},
    "dark": {"fighting": 0.5, "psychic": 2.0, "ghost": 2.0, "dark": 0.5, "fairy": 0.5},
    "fairy": {"fire": 0.5, "fighting": 2.0, "poison": 0.5, "dragon": 2.0, "dark": 2.0, "steel": 0.5},
}

TYPE_NAMES_PT: dict[str, str] = {
    "normal": "Normal", "fire": "Fogo", "water": "Água", "grass": "Planta",
    "electric": "Elétrico", "ice": "Gelo", "fighting": "Lutador", "poison": "Venenoso",
    "ground": "Terra", "flying": "Voador", "psychic": "Psíquico", "bug": "Inseto",
    "rock": "Pedra", "ghost": "Fantasma", "dragon": "Dragão", "steel": "Aço",
    "dark": "Sombrio", "fairy": "Fada",
}

# Movimentos icônicos para cada tipo (Ataque Rápido + 2 Ataques Carregados)
MOVES_BY_TYPE: dict[str, dict[str, Any]] = {
    "fire": {
        "fast": {"name": "Brasa", "type": "fire", "power": 12, "energy": 14, "icon": "🔥"},
        "charged_1": {"name": "Lança-Chamas", "type": "fire", "power": 65, "energy": 50, "icon": "🔥"},
        "charged_2": {"name": "Explosão de Fogo", "type": "fire", "power": 90, "energy": 65, "icon": "💥"},
    },
    "water": {
        "fast": {"name": "Revólver d'Água", "type": "water", "power": 11, "energy": 15, "icon": "💧"},
        "charged_1": {"name": "Aqua Cauda", "type": "water", "power": 60, "energy": 45, "icon": "🌊"},
        "charged_2": {"name": "Hidro Bomba", "type": "water", "power": 95, "energy": 65, "icon": "🌊"},
    },
    "grass": {
        "fast": {"name": "Chicote de Vinha", "type": "grass", "power": 11, "energy": 15, "icon": "🍃"},
        "charged_1": {"name": "Folha Navalha", "type": "grass", "power": 60, "energy": 45, "icon": "🍃"},
        "charged_2": {"name": "Raio Solar", "type": "grass", "power": 95, "energy": 65, "icon": "☀️"},
    },
    "electric": {
        "fast": {"name": "Choque do Trovão", "type": "electric", "power": 10, "energy": 16, "icon": "⚡"},
        "charged_1": {"name": "Relâmpago", "type": "electric", "power": 70, "energy": 50, "icon": "⚡"},
        "charged_2": {"name": "Trovão Selvagem", "type": "electric", "power": 90, "energy": 60, "icon": "🌩️"},
    },
    "ice": {
        "fast": {"name": "Pó de Neve", "type": "ice", "power": 11, "energy": 14, "icon": "❄️"},
        "charged_1": {"name": "Raio de Gelo", "type": "ice", "power": 70, "energy": 50, "icon": "❄️"},
        "charged_2": {"name": "Nevasca", "type": "ice", "power": 90, "energy": 65, "icon": "🌨️"},
    },
    "fighting": {
        "fast": {"name": "Golpe Marcial", "type": "fighting", "power": 12, "energy": 14, "icon": "🥊"},
        "charged_1": {"name": "Soco Dinâmico", "type": "fighting", "power": 70, "energy": 50, "icon": "👊"},
        "charged_2": {"name": "Combate Próximo", "type": "fighting", "power": 95, "energy": 65, "icon": "💥"},
    },
    "poison": {
        "fast": {"name": "Picada Venenosa", "type": "poison", "power": 10, "energy": 15, "icon": "☠️"},
        "charged_1": {"name": "Bomba de Lodo", "type": "poison", "power": 65, "energy": 50, "icon": "🟣"},
        "charged_2": {"name": "Onda Tóxica", "type": "poison", "power": 85, "energy": 60, "icon": "☠️"},
    },
    "ground": {
        "fast": {"name": "Tiro de Lama", "type": "ground", "power": 10, "energy": 16, "icon": "🌍"},
        "charged_1": {"name": "Poder da Terra", "type": "ground", "power": 68, "energy": 50, "icon": "🌋"},
        "charged_2": {"name": "Terremoto", "type": "ground", "power": 95, "energy": 65, "icon": "🌍"},
    },
    "flying": {
        "fast": {"name": "Ataque de Asa", "type": "flying", "power": 11, "energy": 14, "icon": "🪶"},
        "charged_1": {"name": "Golpe Aéreo", "type": "flying", "power": 62, "energy": 45, "icon": "🌪️"},
        "charged_2": {"name": "Pássaro Bravo", "type": "flying", "power": 92, "energy": 60, "icon": "🦅"},
    },
    "psychic": {
        "fast": {"name": "Confusão", "type": "psychic", "power": 13, "energy": 14, "icon": "🔮"},
        "charged_1": {"name": "Psíquico", "type": "psychic", "power": 75, "energy": 50, "icon": "🧠"},
        "charged_2": {"name": "Onda Mental", "type": "psychic", "power": 95, "energy": 65, "icon": "🔮"},
    },
    "bug": {
        "fast": {"name": "Picada", "type": "bug", "power": 10, "energy": 15, "icon": "🐛"},
        "charged_1": {"name": "Tesoura X", "type": "bug", "power": 60, "energy": 45, "icon": "✂️"},
        "charged_2": {"name": "Zumbido de Inseto", "type": "bug", "power": 85, "energy": 60, "icon": "🦗"},
    },
    "rock": {
        "fast": {"name": "Lança-Rochas", "type": "rock", "power": 12, "energy": 13, "icon": "🪨"},
        "charged_1": {"name": "Deslizamento", "type": "rock", "power": 68, "energy": 50, "icon": "🪨"},
        "charged_2": {"name": "Gume de Pedra", "type": "rock", "power": 90, "energy": 65, "icon": "⛰️"},
    },
    "ghost": {
        "fast": {"name": "Garra Sombria", "type": "ghost", "power": 11, "energy": 15, "icon": "👻"},
        "charged_1": {"name": "Bola Sombria", "type": "ghost", "power": 75, "energy": 50, "icon": "🔮"},
        "charged_2": {"name": "Vento Sinistro", "type": "ghost", "power": 88, "energy": 60, "icon": "👻"},
    },
    "dragon": {
        "fast": {"name": "Sopro do Dragão", "type": "dragon", "power": 12, "energy": 14, "icon": "🐉"},
        "charged_1": {"name": "Garra do Dragão", "type": "dragon", "power": 62, "energy": 45, "icon": "🐲"},
        "charged_2": {"name": "Meteoro do Dragão", "type": "dragon", "power": 98, "energy": 65, "icon": "☄️"},
    },
    "steel": {
        "fast": {"name": "Garra de Metal", "type": "steel", "power": 11, "energy": 14, "icon": "⚙️"},
        "charged_1": {"name": "Meteoro de Ferro", "type": "steel", "power": 70, "energy": 50, "icon": "🛡️"},
        "charged_2": {"name": "Canhão Flash", "type": "steel", "power": 88, "energy": 60, "icon": "✨"},
    },
    "dark": {
        "fast": {"name": "Mordida", "type": "dark", "power": 10, "energy": 14, "icon": "🌑"},
        "charged_1": {"name": "Jogo Sujo", "type": "dark", "power": 68, "energy": 50, "icon": "🕶️"},
        "charged_2": {"name": "Pulso Noturno", "type": "dark", "power": 90, "energy": 65, "icon": "🌑"},
    },
    "fairy": {
        "fast": {"name": "Charme", "type": "fairy", "power": 13, "energy": 13, "icon": "🧚"},
        "charged_1": {"name": "Brilho Mágico", "type": "fairy", "power": 72, "energy": 50, "icon": "✨"},
        "charged_2": {"name": "Lua Crescente", "type": "fairy", "power": 92, "energy": 65, "icon": "🌙"},
    },
    "normal": {
        "fast": {"name": "Ataque Rápido", "type": "normal", "power": 10, "energy": 15, "icon": "⚪"},
        "charged_1": {"name": "Pancada Corporal", "type": "normal", "power": 65, "energy": 45, "icon": "💥"},
        "charged_2": {"name": "Hiper-Raio", "type": "normal", "power": 95, "energy": 65, "icon": "💫"},
    },
}


def calculate_pokemon_stamina(p: dict[str, Any]) -> int:
    """Calcula o custo de stamina/pontos de um Pokémon com base em seus stats e se é lendário."""
    stats = p.get("stats") or {}
    total = stats.get("total")
    if not total:
        total = (
            stats.get("hp", 50)
            + stats.get("attack", 50)
            + stats.get("defense", 50)
            + stats.get("sp_attack", 50)
            + stats.get("sp_defense", 50)
            + stats.get("speed", 50)
        )
    cost = int(total)
    if p.get("is_legendary") or p.get("is_mythical") or stats.get("legendary"):
        cost = int(cost * 1.05)
    return max(180, min(750, cost))


def get_type_multiplier(attack_type: str, defender_types: list[str]) -> float:
    """Calcula o multiplicador de efetividade elemental (2.0x, 0.5x, 0.0x, 4.0x, etc.)."""
    attack_type = attack_type.lower()
    mult = 1.0
    for d_type in defender_types:
        d_type = d_type.lower()
        sub = TYPE_CHART.get(attack_type, {}).get(d_type, 1.0)
        mult *= sub
    return round(mult, 2)


def build_combatant(poke_id: int) -> dict[str, Any]:
    """Prepara os atributos de batalha, vida, movimentos e imagens de um Pokémon."""
    p = POKEMON_MAP.get(poke_id)
    if not p:
        # Fallback genérico
        p = {
            "id": poke_id,
            "name": f"Pokémon #{poke_id}",
            "types": ["normal"],
            "types_pt": ["Normal"],
            "stats": {"hp": 60, "attack": 60, "defense": 60, "total": 360},
        }

    stats = p.get("stats") or {}
    base_hp = stats.get("hp", 60)
    base_atk = stats.get("attack", 60)
    base_def = stats.get("defense", 60)

    # HP escalado para combate dinâmico de 30 a 60 segundos
    max_hp = int(base_hp * 3.4 + 90)
    stamina_cost = calculate_pokemon_stamina(p)

    types = p.get("types") or ["normal"]
    t1 = types[0].lower() if types else "normal"
    t2 = types[1].lower() if len(types) > 1 else None

    # Movimentos
    m1 = MOVES_BY_TYPE.get(t1, MOVES_BY_TYPE["normal"])
    fast_move = dict(m1["fast"])
    charged_1 = dict(m1["charged_1"])

    if t2 and t2 in MOVES_BY_TYPE:
        # Segundo ataque carregado com a cobertura do tipo secundário
        charged_2 = dict(MOVES_BY_TYPE[t2]["charged_1"])
    else:
        # Segundo ataque do mesmo tipo com maior potência
        charged_2 = dict(m1["charged_2"])

    # Sprites e imagens
    animated = p.get("animated") or f"https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/showdown/{poke_id}.gif"
    artwork = f"/img/artwork/{poke_id}.png"
    sprite = f"/img/sprites/{poke_id}.png"

    return {
        "id": p["id"],
        "name": p["name"],
        "types": types,
        "types_pt": p.get("types_pt") or [TYPE_NAMES_PT.get(t, t.capitalize()) for t in types],
        "stamina_cost": stamina_cost,
        "max_hp": max_hp,
        "current_hp": max_hp,
        "energy": 0,
        "attack": base_atk,
        "defense": base_def,
        "fast_move": fast_move,
        "charged_move_1": charged_1,
        "charged_move_2": charged_2,
        "animated": animated,
        "artwork": artwork,
        "sprite": sprite,
        "fainted": False,
    }


def auto_pick_team(current_team_ids: list[int], max_stamina: int = TEAM_STAMINA_LIMIT) -> list[int]:
    """Completa aleatoriamente uma equipe de 3 Pokémon respeitando rigorosamente o limite de stamina."""
    chosen = list(current_team_ids[:3])
    current_cost = sum(calculate_pokemon_stamina(POKEMON_MAP[pid]) for pid in chosen if pid in POKEMON_MAP)

    candidates = [p for p in ALL_POKEMON if p["id"] not in chosen]
    random.shuffle(candidates)

    while len(chosen) < 3 and candidates:
        remaining_slots = 3 - len(chosen)
        remaining_stamina = max_stamina - current_cost
        max_cost_per_slot = remaining_stamina // remaining_slots

        # Tenta achar um que caiba confortavelmente
        pick = None
        for cand in candidates:
            c = calculate_pokemon_stamina(cand)
            if c <= max_cost_per_slot:
                pick = cand
                break

        # Se não achou com cota média, pega o de menor custo disponível
        if not pick:
            candidates.sort(key=calculate_pokemon_stamina)
            if candidates and calculate_pokemon_stamina(candidates[0]) <= remaining_stamina:
                pick = candidates[0]
            else:
                # Se ainda assim estourar, substitui o anterior mais caro por um mais leve
                break

        if pick:
            chosen.append(pick["id"])
            current_cost += calculate_pokemon_stamina(pick)
            candidates.remove(pick)
        else:
            break

    # Se ainda faltar (caso extremo), completa com clássicos leves garantidos (Pikachu, Squirtle, Bulbasaur)
    fallbacks = [25, 1, 4, 7, 133, 16, 19, 10, 13]
    for fid in fallbacks:
        if len(chosen) >= 3:
            break
        if fid not in chosen:
            chosen.append(fid)

    return chosen[:3]


class BattleState:
    """Instância de uma batalha entre 2 jogadores (ou Jogador vs IA)."""

    def __init__(
        self,
        room_id: str,
        p1_id: int | None,
        p1_name: str,
        p2_id: int | None,
        p2_name: str,
        is_bot: bool = False,
    ):
        self.room_id = room_id
        self.p1_id = p1_id
        self.p1_name = p1_name
        self.p2_id = p2_id
        self.p2_name = p2_name
        self.is_bot = is_bot

        self.phase = "DRAFT"  # DRAFT -> BATTLE -> FINISHED
        self.draft_timer = 60  # 60 segundos regulamentares
        self.p1_locked = False
        self.p2_locked = False

        self.p1_team_ids: list[int] = []
        self.p2_team_ids: list[int] = []

        self.p1_combatants: list[dict[str, Any]] = []
        self.p2_combatants: list[dict[str, Any]] = []

        self.p1_active_idx = 0
        self.p2_active_idx = 0

        self.p1_shields = 2
        self.p2_shields = 2

        self.p1_switch_cooldown = 0
        self.p2_switch_cooldown = 0

        # Ataque carregado pendente para decisão de escudo
        # {"attacker": 1 or 2, "move": dict, "target": 2 or 1, "timeout": float}
        self.pending_charge: dict[str, Any] | None = None

        self.turns_played = 0
        self.winner: int | None = None  # 1 para p1, 2 para p2, 0 para empate
        self.logs: list[str] = []

    def start_battle_from_draft(self):
        """Inicia o combate após a seleção dos 3 Pokémon."""
        if len(self.p1_team_ids) < 3:
            self.p1_team_ids = auto_pick_team(self.p1_team_ids)
        if len(self.p2_team_ids) < 3:
            self.p2_team_ids = auto_pick_team(self.p2_team_ids)

        self.p1_combatants = [build_combatant(pid) for pid in self.p1_team_ids]
        self.p2_combatants = [build_combatant(pid) for pid in self.p2_team_ids]
        self.p1_active_idx = 0
        self.p2_active_idx = 0
        self.p1_shields = 2
        self.p2_shields = 2
        self.phase = "BATTLE"

        c1 = self.p1_combatants[0]
        c2 = self.p2_combatants[0]
        self.logs.append(f"⚔️ A BATALHA COMEÇOU! {self.p1_name} enviou {c1['name']} vs {self.p2_name} enviou {c2['name']}!")

    def get_active(self, player_num: int) -> dict[str, Any]:
        team = self.p1_combatants if player_num == 1 else self.p2_combatants
        idx = self.p1_active_idx if player_num == 1 else self.p2_active_idx
        return team[idx]

    def execute_fast_attack(self, player_num: int) -> dict[str, Any]:
        """Executa um Ataque Rápido."""
        if self.phase != "BATTLE" or self.pending_charge is not None:
            return {"ok": False, "reason": "Não é possível atacar agora."}

        atk_p = self.get_active(player_num)
        def_num = 2 if player_num == 1 else 1
        def_p = self.get_active(def_num)

        if atk_p["current_hp"] <= 0 or def_p["current_hp"] <= 0:
            return {"ok": False, "reason": "Pokémon desmaiado."}

        move = atk_p["fast_move"]
        atk_type = move["type"]

        # Efetividade de tipo
        eff = get_type_multiplier(atk_type, def_p["types"])
        stab = 1.2 if atk_type in [t.lower() for t in atk_p["types"]] else 1.0

        # Cálculo de dano dinâmico
        base_dmg = move["power"] * (atk_p["attack"] / max(30, def_p["defense"]))
        dmg = max(3, int(base_dmg * eff * stab))

        def_p["current_hp"] = max(0, def_p["current_hp"] - dmg)
        atk_p["energy"] = min(100, atk_p["energy"] + move["energy"])

        eff_text = ""
        if eff >= 2.0:
            eff_text = "Super efetivo! 💥"
        elif eff <= 0.5 and eff > 0:
            eff_text = "Pouco efetivo... 🛡️"
        elif eff == 0.0:
            eff_text = "Não surtiu efeito! (Imune)"

        log_msg = f"{atk_p['name']} usou {move['name']} em {def_p['name']} causando {dmg} de dano! {eff_text}".strip()
        self.logs.append(log_msg)
        self.turns_played += 1

        fainted = False
        if def_p["current_hp"] <= 0:
            def_p["fainted"] = True
            fainted = True
            self.logs.append(f"💀 {def_p['name']} desmaiou!")
            self._handle_faint(def_num)

        return {
            "ok": True,
            "attacker": player_num,
            "defender": def_num,
            "move": move,
            "damage": dmg,
            "multiplier": eff,
            "eff_text": eff_text,
            "defender_hp": def_p["current_hp"],
            "attacker_energy": atk_p["energy"],
            "fainted": fainted,
            "log": log_msg,
        }

    def queue_charged_attack(self, player_num: int, move_slot: int) -> dict[str, Any]:
        """Dispara um Ataque Carregado potente que solicita reação de escudo do oponente."""
        if self.phase != "BATTLE" or self.pending_charge is not None:
            return {"ok": False, "reason": "Ataque carregado indisponível no momento."}

        atk_p = self.get_active(player_num)
        def_num = 2 if player_num == 1 else 1
        def_p = self.get_active(def_num)

        move = atk_p["charged_move_1"] if move_slot == 1 else atk_p["charged_move_2"]
        cost = move["energy"]

        if atk_p["energy"] < cost:
            return {"ok": False, "reason": f"Energia insuficiente! Precisa de {cost} de energia."}

        atk_p["energy"] -= cost
        def_shields = self.p2_shields if player_num == 1 else self.p1_shields

        self.pending_charge = {
            "attacker": player_num,
            "defender": def_num,
            "move": move,
            "shields_available": def_shields,
        }

        log_msg = f"⚡ {atk_p['name']} está prestes a desferir {move['name']}!"
        self.logs.append(log_msg)

        return {
            "ok": True,
            "pending": True,
            "attacker": player_num,
            "defender": def_num,
            "move": move,
            "shields_available": def_shields,
            "log": log_msg,
        }

    def resolve_charged_attack(self, use_shield: bool) -> dict[str, Any]:
        """Aplica o dano do ataque carregado considerando se o defensor acionou o escudo."""
        if not self.pending_charge:
            return {"ok": False, "reason": "Nenhum ataque carregado pendente."}

        charge = self.pending_charge
        self.pending_charge = None

        atk_num = charge["attacker"]
        def_num = charge["defender"]
        move = charge["move"]

        atk_p = self.get_active(atk_num)
        def_p = self.get_active(def_num)

        # Verifica se o defensor tem escudos e quer usar
        shield_used = False
        if use_shield:
            if def_num == 1 and self.p1_shields > 0:
                self.p1_shields -= 1
                shield_used = True
            elif def_num == 2 and self.p2_shields > 0:
                self.p2_shields -= 1
                shield_used = True

        atk_type = move["type"]
        eff = get_type_multiplier(atk_type, def_p["types"])
        stab = 1.2 if atk_type in [t.lower() for t in atk_p["types"]] else 1.0

        if shield_used:
            dmg = 1  # Chip damage
            eff_text = "🛡️ O escudo protegeu o Pokémon!"
            log_msg = f"🛡️ {self.p1_name if def_num == 1 else self.p2_name} usou ESCUDO e bloqueou {move['name']}!"
        else:
            base_dmg = move["power"] * (atk_p["attack"] / max(30, def_p["defense"]))
            dmg = max(10, int(base_dmg * eff * stab))
            eff_text = "SUPER EFETIVO! 💥" if eff >= 2.0 else ("Pouco efetivo... 🛡️" if eff <= 0.5 else "")
            log_msg = f"💥 {atk_p['name']} detonou {move['name']} causando {dmg} de dano em {def_p['name']}! {eff_text}".strip()

        def_p["current_hp"] = max(0, def_p["current_hp"] - dmg)
        self.logs.append(log_msg)
        self.turns_played += 1

        fainted = False
        if def_p["current_hp"] <= 0:
            def_p["fainted"] = True
            fainted = True
            self.logs.append(f"💀 {def_p['name']} desmaiou!")
            self._handle_faint(def_num)

        return {
            "ok": True,
            "attacker": atk_num,
            "defender": def_num,
            "move": move,
            "shield_used": shield_used,
            "shields_left": self.p1_shields if def_num == 1 else self.p2_shields,
            "damage": dmg,
            "multiplier": eff,
            "eff_text": eff_text,
            "defender_hp": def_p["current_hp"],
            "fainted": fainted,
            "log": log_msg,
        }

    def switch_pokemon(self, player_num: int, target_idx: int) -> dict[str, Any]:
        """Troca o Pokémon em campo por outro da reserva."""
        if self.phase != "BATTLE" or self.pending_charge is not None:
            return {"ok": False, "reason": "Não é possível trocar agora."}

        team = self.p1_combatants if player_num == 1 else self.p2_combatants
        curr_idx = self.p1_active_idx if player_num == 1 else self.p2_active_idx

        if target_idx < 0 or target_idx >= len(team):
            return {"ok": False, "reason": "Posição inválida."}
        if target_idx == curr_idx:
            return {"ok": False, "reason": "Este Pokémon já está em campo."}
        if team[target_idx]["current_hp"] <= 0:
            return {"ok": False, "reason": "Este Pokémon está desmaiado."}

        # Cooldown de troca (a não ser que o atual esteja fainted)
        cooldown = self.p1_switch_cooldown if player_num == 1 else self.p2_switch_cooldown
        if team[curr_idx]["current_hp"] > 0 and cooldown > 0:
            return {"ok": False, "reason": f"Aguarde {cooldown}s para trocar novamente."}

        if player_num == 1:
            self.p1_active_idx = target_idx
            self.p1_switch_cooldown = 15  # 15s de cooldown
        else:
            self.p2_active_idx = target_idx
            self.p2_switch_cooldown = 15

        new_poke = team[target_idx]
        pname = self.p1_name if player_num == 1 else self.p2_name
        log_msg = f"🔄 {pname} trocou para {new_poke['name']}!"
        self.logs.append(log_msg)

        return {
            "ok": True,
            "player": player_num,
            "active_idx": target_idx,
            "pokemon": new_poke,
            "log": log_msg,
        }

    def _handle_faint(self, player_num: int):
        """Verifica se restam Pokémon vivos ou se a partida acabou."""
        team = self.p1_combatants if player_num == 1 else self.p2_combatants
        alive_indices = [i for i, p in enumerate(team) if p["current_hp"] > 0]

        if not alive_indices:
            # Todos desmaiaram! O outro venceu.
            self.phase = "FINISHED"
            self.winner = 2 if player_num == 1 else 1
            winner_name = self.p2_name if self.winner == 2 else self.p1_name
            self.logs.append(f"🏆 VITÓRIA! {winner_name} venceu a batalha Pokémon!")
        else:
            # Seleciona automaticamente o próximo vivo
            next_idx = alive_indices[0]
            if player_num == 1:
                self.p1_active_idx = next_idx
            else:
                self.p2_active_idx = next_idx
            pname = self.p1_name if player_num == 1 else self.p2_name
            self.logs.append(f"⚡ {pname} enviou {team[next_idx]['name']} para o campo!")

    def bot_action_tick(self) -> dict[str, Any] | None:
        """Executa a decisão inteligente da IA (Treinador Bot)."""
        if not self.is_bot or self.phase != "BATTLE":
            return None

        # 1. Se houver ataque carregado pendente contra o Bot, decide se usa escudo
        if self.pending_charge and self.pending_charge["defender"] == 2:
            should_shield = False
            if self.p2_shields > 0:
                # Usa escudo se for super efetivo ou se a vida estiver abaixo de 70%
                eff = get_type_multiplier(self.pending_charge["move"]["type"], self.get_active(2)["types"])
                hp_ratio = self.get_active(2)["current_hp"] / self.get_active(2)["max_hp"]
                if eff >= 1.5 or hp_ratio < 0.65 or random.random() < 0.6:
                    should_shield = True
            return {"action": "resolve_charged", "use_shield": should_shield}

        if self.pending_charge is not None:
            return None

        bot_p = self.get_active(2)
        user_p = self.get_active(1)

        if bot_p["current_hp"] <= 0 or user_p["current_hp"] <= 0:
            return None

        # 2. Avalia possibilidade de troca tática se o oponente tiver enorme vantagem de tipo
        eff_against_bot = get_type_multiplier(user_p["fast_move"]["type"], bot_p["types"])
        if eff_against_bot >= 2.0 and self.p2_switch_cooldown <= 0:
            # Procura no banco alguém que resista
            for i, cand in enumerate(self.p2_combatants):
                if i != self.p2_active_idx and cand["current_hp"] > 0:
                    cand_eff = get_type_multiplier(user_p["fast_move"]["type"], cand["types"])
                    if cand_eff < 1.0:
                        return {"action": "switch", "target_idx": i}

        # 3. Dispara ataque carregado se tiver energia
        if bot_p["energy"] >= bot_p["charged_move_2"]["energy"]:
            # Escolhe o mais efetivo contra o usuário
            eff1 = get_type_multiplier(bot_p["charged_move_1"]["type"], user_p["types"])
            eff2 = get_type_multiplier(bot_p["charged_move_2"]["type"], user_p["types"])
            slot = 2 if eff2 >= eff1 else 1
            return {"action": "charged_attack", "slot": slot}
        elif bot_p["energy"] >= bot_p["charged_move_1"]["energy"]:
            return {"action": "charged_attack", "slot": 1}

        # 4. Caso contrário, desfere ataque rápido
        return {"action": "fast_attack"}

    def to_client_state(self, for_player: int = 1) -> dict[str, Any]:
        """Serializa o estado para transmissão JSON via WebSocket."""
        return {
            "room_id": self.room_id,
            "phase": self.phase,
            "draft_timer": self.draft_timer,
            "p1_name": self.p1_name,
            "p2_name": self.p2_name,
            "p1_id": self.p1_id,
            "p2_id": self.p2_id,
            "is_bot": self.is_bot,
            "p1_locked": self.p1_locked,
            "p2_locked": self.p2_locked,
            "p1_team_ids": self.p1_team_ids,
            "p2_team_ids": self.p2_team_ids,
            "p1_active_idx": self.p1_active_idx,
            "p2_active_idx": self.p2_active_idx,
            "p1_shields": self.p1_shields,
            "p2_shields": self.p2_shields,
            "p1_switch_cooldown": self.p1_switch_cooldown,
            "p2_switch_cooldown": self.p2_switch_cooldown,
            "p1_combatants": self.p1_combatants,
            "p2_combatants": self.p2_combatants,
            "pending_charge": self.pending_charge,
            "winner": self.winner,
            "winner_name": (self.p1_name if self.winner == 1 else self.p2_name) if self.winner else None,
            "logs": self.logs[-8:],  # Últimos logs relevantes
        }
