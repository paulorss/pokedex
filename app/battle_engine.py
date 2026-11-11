"""
Motor do "Duelo dos Encantados" — jogo original de duelos por rodadas.

Cada treinador monta um trio de Encantados (criaturas originais de cinco
elementos) respeitando um orçamento de pontos. A cada rodada os dois escolhem
uma ação em segredo (Golpe, Técnica, Guarda ou Trocar); o servidor resolve a
rodada e devolve uma lista de eventos que o cliente anima em sequência.
"""
from __future__ import annotations

import random
from typing import Any

TEAM_SIZE = 3
TEAM_BUDGET = 10
ROUND_SECONDS = 20
MAX_FOCO = 5
START_FOCO = 1
TECH_COST = 3
STRIKE_POWER = 24
TECH_SCALE = 1.25
STRONG_MULT = 1.4
WEAK_MULT = 0.72
GUARD_VS_STRIKE = 0.4
GUARD_VS_TECH = 0.55
BURN_ROUNDS = 2
BURN_FRACTION = 0.07
REGEN_FRACTION = 0.14
DRAIN_FOCO = 2

ELEMENTS: dict[str, dict[str, str]] = {
    "brasa": {"name": "Brasa", "color": "#ff7a3d"},
    "mata": {"name": "Mata", "color": "#58b368"},
    "mare": {"name": "Maré", "color": "#3a9bff"},
    "pedra": {"name": "Pedra", "color": "#c9a66b"},
    "vento": {"name": "Vento", "color": "#a99bff"},
}

# Cada elemento leva vantagem sobre dois e desvantagem contra outros dois.
STRONG_AGAINST: dict[str, tuple[str, str]] = {
    "brasa": ("mata", "vento"),
    "mata": ("mare", "pedra"),
    "mare": ("brasa", "pedra"),
    "pedra": ("brasa", "vento"),
    "vento": ("mare", "mata"),
}

EFFECT_TEXT = {
    "queimar": f"Queima o alvo por {BURN_ROUNDS} rodadas",
    "regenerar": "Recupera parte da própria vida",
    "drenar": f"Tira {DRAIN_FOCO} de Foco do alvo",
    "quebra": "Atravessa a Guarda",
    "impeto": "Age primeiro e devolve 1 de Foco",
}


def _c(cid, name, element, form, hp, atk, df, spd, cost, c1, c2, tech, power, effect, lore):
    return {
        "id": cid, "name": name, "element": element, "form": form,
        "hp": hp, "atk": atk, "def": df, "spd": spd, "cost": cost,
        "colors": [c1, c2],
        "tech": {"name": tech, "power": power, "effect": effect, "effect_text": EFFECT_TEXT[effect]},
        "lore": lore,
    }


ROSTER: list[dict[str, Any]] = [
    _c(1, "Fagulho", "brasa", "bicho", 110, 62, 48, 70, 2, "#ff7a3d", "#ffd166", "Estalo de Brasa", 34, "queimar", "Nasce da última faísca de uma fogueira esquecida."),
    _c(2, "Tiçoara", "brasa", "ave", 118, 70, 50, 82, 3, "#e8452c", "#ffb347", "Rasante Ardente", 37, "impeto", "Risca o céu ao entardecer deixando um fio de luz."),
    _c(3, "Cinzal", "brasa", "quadrupede", 140, 74, 62, 58, 4, "#b23a2e", "#ff9f1c", "Trilha de Cinzas", 41, "queimar", "Por onde passa, o chão fica morno por dias."),
    _c(4, "Labarena", "brasa", "serpente", 150, 84, 60, 66, 5, "#d7263d", "#ffd23f", "Coluna de Fogo", 46, "queimar", "Dorme enrolada em brasas no fundo das grotas."),
    _c(5, "Cipozim", "mata", "bicho", 120, 54, 58, 60, 2, "#58b368", "#d9ed92", "Laço de Cipó", 32, "regenerar", "Balança nos cipós e imita o canto dos pássaros."),
    _c(6, "Brotéu", "mata", "quadrupede", 136, 60, 66, 50, 3, "#3f9b5f", "#f4d35e", "Seiva Viva", 35, "regenerar", "Carrega mudas nas costas e as planta onde descansa."),
    _c(7, "Folhagar", "mata", "ave", 124, 72, 54, 78, 4, "#2d8a54", "#b5e48c", "Vendaval de Folhas", 40, "impeto", "Suas penas são folhas que nunca secam."),
    _c(8, "Jatobarão", "mata", "golem", 172, 76, 80, 36, 5, "#2f6f4f", "#a7c957", "Raiz Profunda", 43, "regenerar", "Um tronco antigo que aprendeu a caminhar."),
    _c(9, "Espumim", "mare", "bicho", 116, 56, 54, 68, 2, "#4cc9f0", "#e0fbfc", "Borrifo", 32, "drenar", "Aparece na espuma quando a onda quebra."),
    _c(10, "Marulho", "mare", "serpente", 130, 66, 58, 64, 3, "#3a86ff", "#bde0fe", "Correnteza", 37, "drenar", "Desliza pelos igarapés sem fazer barulho."),
    _c(11, "Rebojo", "mare", "quadrupede", 144, 70, 66, 56, 4, "#2667ff", "#90e0ef", "Redemoinho d'Água", 41, "drenar", "Gira em torno de si mesmo antes de atacar."),
    _c(12, "Pororonca", "mare", "golem", 166, 80, 72, 44, 5, "#1d4ed8", "#a5f3fc", "Muralha de Maré", 44, "drenar", "Avança rio acima com o estrondo de uma onda."),
    _c(13, "Seixote", "pedra", "bicho", 128, 56, 70, 40, 2, "#a68a64", "#e9d8a6", "Pedrada", 34, "quebra", "Um seixo de rio que criou pernas e teimosia."),
    _c(14, "Lajedo", "pedra", "quadrupede", 150, 62, 80, 38, 3, "#8d7b68", "#ddb892", "Investida de Laje", 37, "quebra", "Toma sol imóvel até alguém confundi-lo com o chão."),
    _c(15, "Cascalhudo", "pedra", "golem", 164, 72, 84, 30, 4, "#7f6f5f", "#f2cc8f", "Chuva de Cascalho", 41, "quebra", "Coleciona pedrinhas e as arremessa quando contrariado."),
    _c(16, "Itaúna", "pedra", "serpente", 158, 82, 78, 46, 5, "#5c5248", "#ffc857", "Fenda de Granito", 46, "quebra", "Abre caminho pela rocha como se fosse areia."),
    _c(17, "Brisol", "vento", "ave", 104, 58, 44, 90, 2, "#b8c0ff", "#ffffff", "Sopro Ligeiro", 32, "impeto", "Tão leve que precisa se segurar para não ir embora."),
    _c(18, "Zunido", "vento", "bicho", 112, 66, 48, 86, 3, "#9d8df1", "#e0c3fc", "Zumbido Cortante", 36, "impeto", "Ouve-se primeiro; vê-se depois, se der tempo."),
    _c(19, "Redemunho", "vento", "serpente", 126, 74, 52, 84, 4, "#7b6cf6", "#c8b6ff", "Espiral", 40, "impeto", "Um pé de vento que nunca parou de rodar."),
    _c(20, "Ventarim", "vento", "quadrupede", 138, 82, 58, 80, 5, "#6247aa", "#e2cfea", "Tufão", 44, "impeto", "Corre na frente das tempestades anunciando a chuva."),
]
ROSTER_MAP: dict[int, dict[str, Any]] = {c["id"]: c for c in ROSTER}
MIN_COST = min(c["cost"] for c in ROSTER)


def element_multiplier(attack_element: str, defender_element: str) -> float:
    if defender_element in STRONG_AGAINST.get(attack_element, ()):
        return STRONG_MULT
    if attack_element in STRONG_AGAINST.get(defender_element, ()):
        return WEAK_MULT
    return 1.0


def team_cost(team_ids: list[int]) -> int:
    return sum(ROSTER_MAP[cid]["cost"] for cid in team_ids if cid in ROSTER_MAP)


def validate_team(team_ids: list[int]) -> str | None:
    """Devolve a mensagem de erro, ou None se a equipe (parcial ou completa) for válida."""
    if len(team_ids) > TEAM_SIZE:
        return f"A equipe tem no máximo {TEAM_SIZE} Encantados."
    if any(cid not in ROSTER_MAP for cid in team_ids):
        return "Encantado desconhecido na equipe."
    if len(set(team_ids)) != len(team_ids):
        return "Não é possível repetir o mesmo Encantado."
    cost = team_cost(team_ids)
    if cost > TEAM_BUDGET:
        return f"A equipe custa {cost} pontos; o limite é {TEAM_BUDGET}."
    return None


def auto_pick_team(current: list[int]) -> list[int]:
    """Completa a equipe ao acaso sem estourar o orçamento."""
    chosen = [cid for cid in dict.fromkeys(current) if cid in ROSTER_MAP][:TEAM_SIZE]
    if validate_team(chosen):
        chosen = []
    while len(chosen) < TEAM_SIZE:
        slots_after = TEAM_SIZE - len(chosen) - 1
        room = TEAM_BUDGET - team_cost(chosen) - slots_after * MIN_COST
        options = [c["id"] for c in ROSTER if c["id"] not in chosen and c["cost"] <= room]
        chosen.append(random.choice(options))
    return chosen


def build_combatant(cid: int) -> dict[str, Any]:
    base = ROSTER_MAP[cid]
    return {
        **{k: base[k] for k in ("id", "name", "element", "form", "colors", "atk", "def", "spd", "tech", "cost")},
        "max_hp": base["hp"],
        "hp": base["hp"],
        "foco": START_FOCO,
        "burn": 0,
        "guarding": False,
        "guarded_last": False,
        "fainted": False,
    }


class BattleState:
    """Uma partida entre dois treinadores (ou treinador contra IA)."""

    def __init__(self, room_id: str, p1_id: int | None, p1_name: str,
                 p2_id: int | None, p2_name: str, is_bot: bool = False):
        self.room_id = room_id
        self.p1_id, self.p1_name = p1_id, p1_name
        self.p2_id, self.p2_name = p2_id, p2_name
        self.is_bot = is_bot

        self.phase = "DRAFT"  # DRAFT -> BATTLE -> FINISHED
        self.draft_timer = 60
        self.locked = {1: False, 2: False}
        self.team_ids: dict[int, list[int]] = {1: [], 2: []}
        self.teams: dict[int, list[dict[str, Any]]] = {1: [], 2: []}
        self.active_idx = {1: 0, 2: 0}
        self.switched_last = {1: False, 2: False}

        self.round_no = 0
        self.round_seconds = ROUND_SECONDS
        self.choices: dict[int, dict[str, Any] | None] = {1: None, 2: None}
        self.winner: int | None = None
        self.logs: list[str] = []

    # ---------- utilidades ----------
    def name_of(self, player: int) -> str:
        return self.p1_name if player == 1 else self.p2_name

    def player_of(self, user_id: int) -> int:
        return 1 if self.p1_id == user_id else 2

    def active(self, player: int) -> dict[str, Any]:
        return self.teams[player][self.active_idx[player]]

    def both_ready(self) -> bool:
        return self.choices[1] is not None and self.choices[2] is not None

    # ---------- fluxo ----------
    def start_battle_from_draft(self) -> None:
        for player in (1, 2):
            self.team_ids[player] = auto_pick_team(self.team_ids[player])
            self.teams[player] = [build_combatant(cid) for cid in self.team_ids[player]]
        self.phase = "BATTLE"
        self.logs.append(
            f"{self.p1_name} abre com {self.active(1)['name']}; "
            f"{self.p2_name} abre com {self.active(2)['name']}."
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
                          if self.switched_last[player] else "Esse Encantado não pode entrar agora.")
                return {"ok": False, "reason": reason}
            choice = {"kind": "trocar", "idx": idx}
        else:
            return {"ok": False, "reason": "Ação desconhecida."}
        self.choices[player] = choice
        return {"ok": True}

    # ---------- resolução ----------
    def resolve_round(self) -> list[dict[str, Any]]:
        events: list[dict[str, Any]] = []
        acts = {p: (self.choices[p] or {"kind": "golpe"}) for p in (1, 2)}
        lost_turn: set[int] = set()

        for p in (1, 2):
            if acts[p]["kind"] == "trocar":
                self.active(p)["guarded_last"] = False
                self.active_idx[p] = acts[p]["idx"]
                events.append(self._event("switch", p, idx=acts[p]["idx"],
                                          text=f"{self.name_of(p)} chama {self.active(p)['name']}."))
        for p in (1, 2):
            if acts[p]["kind"] == "guarda":
                me = self.active(p)
                me["guarding"] = True
                me["foco"] = min(MAX_FOCO, me["foco"] + 2)
                events.append(self._event("guard", p, foco=me["foco"],
                                          text=f"{me['name']} ergue a Guarda."))

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

        mult = element_multiplier(atk["element"], tgt["element"])
        guarded = tgt["guarding"]
        broke_guard = guarded and effect == "quebra"
        guard_mult = 1.0
        if guarded and not broke_guard:
            guard_mult = GUARD_VS_TECH if is_tech else GUARD_VS_STRIKE
        ratio = (atk["atk"] + 40) / (tgt["def"] + 40)
        dmg = max(2, round(power * ratio * mult * guard_mult * random.uniform(0.93, 1.07)))
        tgt["hp"] = max(0, tgt["hp"] - dmg)

        note = " É vantagem de elemento!" if mult > 1 else (" O elemento resiste." if mult < 1 else "")
        if broke_guard:
            note += " A Guarda foi atravessada!"
        elif guarded:
            note += " A Guarda amortece."
        events = [self._event(
            "attack", player, kind=kind, name=move_name, element=atk["element"], dmg=dmg, mult=mult,
            guarded=guarded, broke_guard=broke_guard, target_hp=tgt["hp"], foco=atk["foco"],
            text=f"{atk['name']} usa {move_name} em {tgt['name']}: {dmg} de dano.{note}",
        )]

        if effect == "queimar" and tgt["hp"] > 0:
            tgt["burn"] = BURN_ROUNDS
            events.append(self._event("status", target_player, k="queimar",
                                      text=f"{tgt['name']} está em chamas."))
        elif effect == "regenerar":
            heal = min(atk["max_hp"] - atk["hp"], round(atk["max_hp"] * REGEN_FRACTION))
            if heal > 0:
                atk["hp"] += heal
                events.append(self._event("heal", player, heal=heal, hp=atk["hp"],
                                          text=f"{atk['name']} recupera {heal} de vida."))
        elif effect == "drenar" and tgt["hp"] > 0 and tgt["foco"] > 0:
            tgt["foco"] = max(0, tgt["foco"] - DRAIN_FOCO)
            events.append(self._event("drain", target_player, foco=tgt["foco"],
                                      text=f"{tgt['name']} perde Foco."))
        return events

    def _handle_faint(self, player: int) -> list[dict[str, Any]]:
        fallen = self.active(player)
        fallen["fainted"] = True
        fallen["burn"] = 0
        events = [self._event("faint", player, text=f"{fallen['name']} foi vencido.")]
        alive = [i for i, c in enumerate(self.teams[player]) if c["hp"] > 0]
        if not alive:
            self.phase = "FINISHED"
            self.winner = 3 - player
            events.append(self._event("end", self.winner,
                                      text=f"{self.name_of(self.winner)} vence o duelo!"))
        else:
            self.active_idx[player] = alive[0]
            events.append(self._event("enter", player, idx=alive[0],
                                      text=f"{self.name_of(player)} envia {self.active(player)['name']}."))
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
                                          text=f"{me['name']} sofre {dmg} com a queimadura."))
            for c in self.teams[p]:
                c["guarded_last"] = c["guarding"]
                c["guarding"] = False
            self.switched_last[p] = acts[p]["kind"] == "trocar"
        return events

    # ---------- IA ----------
    def bot_choose(self, player: int = 2) -> dict[str, Any]:
        me, foe = self.active(player), self.active(3 - player)
        allowed = self.available_actions(player)
        my_edge = element_multiplier(me["element"], foe["element"])
        foe_edge = element_multiplier(foe["element"], me["element"])

        if allowed["trocar"] and foe_edge > 1 and my_edge <= 1 and random.random() < 0.5:
            better = [i for i in allowed["trocar"]
                      if element_multiplier(foe["element"], self.teams[player][i]["element"]) < 1]
            if better:
                return {"kind": "trocar", "idx": random.choice(better)}
        if allowed["tecnica"] and (my_edge >= 1 or random.random() < 0.6):
            if random.random() < 0.8:
                return {"kind": "tecnica"}
        if allowed["guarda"] and foe["foco"] >= TECH_COST and random.random() < 0.55:
            return {"kind": "guarda"}
        if allowed["guarda"] and me["foco"] < TECH_COST and random.random() < 0.2:
            return {"kind": "guarda"}
        return {"kind": "golpe"}

    # ---------- serialização ----------
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
    """Dados estáticos que o cliente precisa para montar o draft e a ajuda."""
    return {
        "roster": ROSTER,
        "elements": ELEMENTS,
        "strong_against": {k: list(v) for k, v in STRONG_AGAINST.items()},
        "team_size": TEAM_SIZE,
        "team_budget": TEAM_BUDGET,
        "round_seconds": ROUND_SECONDS,
        "max_foco": MAX_FOCO,
        "tech_cost": TECH_COST,
    }
