"""
Expande data/pokemon.json de 151 para todos os 1.025 Pokémon da Pokédex Nacional (Gerações 1 a 9)
integrando PokémonDB (1025 Pokémon com status atuais), Kaggle (801 Pokémon com nomes japoneses,
gênero e passos de ovos) e PokeAPI (CDN oficial de sprites e artworks em alta definição).
"""
from __future__ import annotations

import csv
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
RAW = DATA / "raw"
JSON_PATH = DATA / "pokemon.json"
LABELS_PATH = DATA / "labels.json"

TYPE_PT = {
    "normal": "Normal", "fire": "Fogo", "water": "Água", "grass": "Planta",
    "electric": "Elétrico", "ice": "Gelo", "fighting": "Lutador", "poison": "Venenoso",
    "ground": "Terrestre", "flying": "Voador", "psychic": "Psíquico", "bug": "Inseto",
    "rock": "Pedra", "ghost": "Fantasma", "dragon": "Dragão", "dark": "Sombrio",
    "steel": "Aço", "fairy": "Fada",
}

# Tabela de fraquezas elementais clássica
TYPE_CHART = {
    "normal": {"rock": 0.5, "ghost": 0, "steel": 0.5},
    "fire": {"fire": 0.5, "water": 0.5, "grass": 2, "ice": 2, "bug": 2, "rock": 0.5, "dragon": 0.5, "steel": 2},
    "water": {"fire": 2, "water": 0.5, "grass": 0.5, "ground": 2, "rock": 2, "dragon": 0.5},
    "grass": {"fire": 0.5, "water": 2, "grass": 0.5, "poison": 0.5, "ground": 2, "flying": 0.5, "bug": 0.5, "rock": 2, "dragon": 0.5, "steel": 0.5},
    "electric": {"water": 2, "grass": 0.5, "electric": 0.5, "ground": 0, "flying": 2, "dragon": 0.5},
    "ice": {"fire": 0.5, "water": 0.5, "grass": 2, "ice": 0.5, "ground": 2, "flying": 2, "dragon": 2, "steel": 0.5},
    "fighting": {"normal": 2, "ice": 2, "poison": 0.5, "flying": 0.5, "psychic": 0.5, "bug": 0.5, "rock": 2, "ghost": 0, "dark": 2, "steel": 2, "fairy": 0.5},
    "poison": {"grass": 2, "poison": 0.5, "ground": 0.5, "rock": 0.5, "ghost": 0.5, "steel": 0, "fairy": 2},
    "ground": {"fire": 2, "grass": 0.5, "electric": 2, "poison": 2, "flying": 0, "bug": 0.5, "rock": 2, "steel": 2},
    "flying": {"grass": 2, "electric": 0.5, "fighting": 2, "bug": 2, "rock": 0.5, "steel": 0.5},
    "psychic": {"fighting": 2, "poison": 2, "psychic": 0.5, "dark": 0, "steel": 0.5},
    "bug": {"fire": 0.5, "grass": 2, "fighting": 0.5, "poison": 0.5, "flying": 0.5, "psychic": 2, "ghost": 0.5, "dark": 2, "steel": 0.5, "fairy": 0.5},
    "rock": {"fire": 2, "ice": 2, "fighting": 0.5, "ground": 0.5, "flying": 2, "bug": 2, "steel": 0.5},
    "ghost": {"normal": 0, "psychic": 2, "ghost": 2, "dark": 0.5},
    "dragon": {"dragon": 2, "steel": 0.5, "fairy": 0},
    "dark": {"fighting": 0.5, "psychic": 2, "ghost": 2, "dark": 0.5, "fairy": 0.5},
    "steel": {"fire": 0.5, "water": 0.5, "electric": 0.5, "ice": 2, "rock": 2, "steel": 0.5, "fairy": 2},
    "fairy": {"fire": 0.5, "fighting": 2, "poison": 0.5, "dragon": 2, "dark": 2, "steel": 0.5},
}


def calc_effectiveness(types: list[str]) -> dict[str, float]:
    eff = {t: 1.0 for t in TYPE_PT}
    for def_type in types:
        for atk_type, targets in TYPE_CHART.items():
            if def_type in targets:
                eff[atk_type] *= targets[def_type]
    return eff


def load_pokemondb() -> dict[int, dict]:
    path = RAW / "pokemondb_all.csv"
    if not path.exists():
        print("pokemondb_all.csv não encontrado.")
        return {}
    out = {}
    with path.open(encoding="utf-8") as f:
        for r in csv.DictReader(f):
            try:
                pid = int(r["id"])
            except ValueError:
                continue
            # Pega a forma base primária (sem nome de forma como mega/alola)
            if pid not in out or not r.get("form"):
                types = [t.strip().lower() for t in r["types"].split("/") if t.strip()]
                out[pid] = {
                    "id": pid,
                    "name": r["name"],
                    "types": types,
                    "types_pt": [TYPE_PT.get(t, t.capitalize()) for t in types],
                    "stats": {
                        "hp": int(r["hp"]), "attack": int(r["attack"]), "defense": int(r["defense"]),
                        "sp_attack": int(r["sp_attack"]), "sp_defense": int(r["sp_defense"]),
                        "speed": int(r["speed"]), "total": int(r["total"]),
                        "legendary": int(r["total"]) >= 600,
                    }
                }
    return out


def load_kaggle() -> dict[int, dict]:
    path = RAW / "pokemon.csv"
    if not path.exists():
        return {}
    out = {}
    with path.open(encoding="utf-8", errors="ignore") as f:
        for r in csv.DictReader(f):
            try:
                pid = int(r.get("pokedex_number", 0))
            except ValueError:
                continue
            if pid >= 1:
                male = r.get("percentage_male")
                out[pid] = {
                    "japanese_name": r.get("japanese_name", ""),
                    "percentage_male": float(male) if male and male.strip() else None,
                    "base_egg_steps": int(r.get("base_egg_steps", 0)) if r.get("base_egg_steps") else None,
                    "experience_growth": int(r.get("experience_growth", 0)) if r.get("experience_growth") else None,
                    "genus": r.get("classfication") or r.get("classification") or "",
                    "height_m": float(r.get("height_m", 1.0)) if r.get("height_m") else 1.0,
                    "weight_kg": float(r.get("weight_kg", 20.0)) if r.get("weight_kg") else 20.0,
                    "capture_rate": r.get("capture_rate", "45"),
                }
    return out


def main():
    existing_list = json.loads(JSON_PATH.read_text(encoding="utf-8")) if JSON_PATH.exists() else []
    existing_by_id = {p["id"]: p for p in existing_list}

    pokemondb = load_pokemondb()
    kaggle = load_kaggle()

    print(f"• Total na PokémonDB: {len(pokemondb)} Pokémon.")
    print(f"• Total no Kaggle: {len(kaggle)} Pokémon.")
    print(f"• Base atual: {len(existing_list)} Pokémon.")

    all_pokemons = []
    max_id = max(pokemondb.keys()) if pokemondb else 1025

    for pid in range(1, max_id + 1):
        if pid in existing_by_id and pid <= 151:
            # Preserva os 151 primeiros que já têm tradução completa, habilidades e descrições canônicas em PT-BR
            p = existing_by_id[pid]
            all_pokemons.append(p)
            continue

        pdb = pokemondb.get(pid)
        if not pdb:
            continue

        k = kaggle.get(pid, {})
        types = pdb["types"]
        eff = calc_effectiveness(types)

        name = pdb["name"]
        genus = k.get("genus") or f"Pokémon {pdb['types_pt'][0]}"
        desc = f"Pokémon #{pid:03d} registrado na Pokédex Nacional. Tipo {', '.join(pdb['types_pt'])} com total de atributos de {pdb['stats']['total']}."

        art_url = f"https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/{pid}.png"
        sprite_url = f"https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/{pid}.png"
        anim_url = f"https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/showdown/{pid}.gif"

        pokemon_obj = {
            "id": pid,
            "name": name,
            "slug": name.lower().replace(" ", "-"),
            "genus": genus,
            "types": types,
            "types_pt": pdb["types_pt"],
            "height_m": k.get("height_m", 1.0),
            "weight_kg": k.get("weight_kg", 20.0),
            "base_experience": 100,
            "abilities": [{"name": "Especial", "hidden": False, "description": "Habilidade nativa de espécie."}],
            "stats": pdb["stats"],
            "description": desc,
            "description_lang": "pt-br",
            "capture_rate": k.get("capture_rate", "45"),
            "base_happiness": 70,
            "habitat": "rare",
            "color": "custom",
            "is_legendary": pdb["stats"]["legendary"],
            "is_mythical": False,
            "evolution": [[pid]],
            "weaknesses": sorted([t for t, m in eff.items() if m > 1], key=lambda t: -eff[t]),
            "resistances": [t for t, m in eff.items() if 0 < m < 1],
            "immunities": [t for t, m in eff.items() if m == 0],
            "effectiveness": eff,
            "image": art_url,
            "sprite": sprite_url,
            "animated": anim_url,
            "japanese_name": k.get("japanese_name", ""),
            "percentage_male": k.get("percentage_male"),
            "base_egg_steps": k.get("base_egg_steps"),
            "experience_growth": k.get("experience_growth"),
            "gallery": [],
        }
        all_pokemons.append(pokemon_obj)

    # Ordena por ID
    all_pokemons.sort(key=lambda x: x["id"])

    # Salva pokemon.json (mantém data/labels.json intacto para as 151 classes do DenseNet)
    JSON_PATH.write_text(json.dumps(all_pokemons, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n✔ Sucesso! {len(all_pokemons)} Pokémon salvos em data/pokemon.json!")


if __name__ == "__main__":
    main()

