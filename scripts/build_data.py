"""
Monta a base de dados LOCAL da Pokédex (1ª geração, 151 Pokémon).

Fontes:
  * PokeAPI (https://pokeapi.co)            -> tipos, altura, peso, habilidades,
                                                 descrição, espécie, evolução, sprites
  * PokémonDB (pokemondb.net/pokedex/all)     -> status base atuais (prioridade)
  * Gist armgilles (Pokemon.csv)              -> status base (reserva), lendário
  * Kaggle rounakbanik/pokemon (opcional)     -> coloque o arquivo em data/raw/pokemon.csv
                                                 para mesclar fraquezas (against_*),
                                                 nome japonês, classificação etc.
  * Hugging Face RogerKoala/gen1-pokemon-classifier -> pesos do modelo (pokedex.safetensors)
  * Hugging Face Space RogerKoala/Pokedex     -> Pokemons.txt (ordem das classes)

Depois de executado, o app funciona 100% offline.

Uso:
    python scripts/build_data.py
"""
from __future__ import annotations

import csv
import io
import json
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
RAW = DATA / "raw"
MODEL_DIR = ROOT / "model"
IMG_ART = ROOT / "web" / "img" / "artwork"
IMG_SPRITE = ROOT / "web" / "img" / "sprites"

POKEAPI = "https://pokeapi.co/api/v2"
GIST_CSV = "https://gist.githubusercontent.com/armgilles/194bcff35001e7eb53a2a8b441e8b2c6/raw/"
POKEMONDB = "https://pokemondb.net/pokedex/all"
HF_MODEL = "https://huggingface.co/RogerKoala/gen1-pokemon-classifier/resolve/main/pokedex.safetensors"
HF_LABELS = "https://huggingface.co/spaces/RogerKoala/Pokedex/raw/main/Pokemons.txt"

TYPE_PT = {
    "normal": "Normal", "fire": "Fogo", "water": "Água", "grass": "Planta",
    "electric": "Elétrico", "ice": "Gelo", "fighting": "Lutador", "poison": "Venenoso",
    "ground": "Terrestre", "flying": "Voador", "psychic": "Psíquico", "bug": "Inseto",
    "rock": "Pedra", "ghost": "Fantasma", "dragon": "Dragão", "dark": "Sombrio",
    "steel": "Aço", "fairy": "Fada",
}

session = requests.Session()
session.headers["User-Agent"] = "pokedex-local/1.0"


def get(url: str, *, binary: bool = False, retries: int = 4):
    for attempt in range(retries):
        try:
            r = session.get(url, timeout=60)
            r.raise_for_status()
            return r.content if binary else r.json()
        except Exception as exc:  # noqa: BLE001
            if attempt == retries - 1:
                raise
            print(f"  ! erro em {url}: {exc} (tentando de novo)")
            time.sleep(2 * (attempt + 1))


def download(url: str, dest: Path) -> None:
    if dest.exists() and dest.stat().st_size > 0:
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(get(url, binary=True))


def norm(name: str) -> str:
    name = name.replace("♀", "f").replace("♂", "m").lower()
    return re.sub(r"[^a-z0-9]", "", name)


def pick_text(entries, lang_pref=("pt-br", "pt", "en"), key="flavor_text"):
    by_lang: dict[str, str] = {}
    for e in entries:
        lang = e["language"]["name"]
        by_lang.setdefault(lang, e[key])
    for lang in lang_pref:
        if lang in by_lang:
            return " ".join(by_lang[lang].replace("\f", " ").split()), lang
    return "", ""


def flatten_chain(node, out):
    out.append(int(node["species"]["url"].rstrip("/").split("/")[-1]))
    for child in node["evolves_to"]:
        flatten_chain(child, out)
    return out


def chain_stages(node):
    """Retorna lista de estágios: [[ids estágio 1], [ids estágio 2], ...]"""
    stages, level = [], [node]
    while level:
        stages.append([int(n["species"]["url"].rstrip("/").split("/")[-1]) for n in level])
        level = [c for n in level for c in n["evolves_to"]]
    return stages


def load_gist_stats():
    print("• Baixando Pokemon.csv (gist armgilles)...")
    text = session.get(GIST_CSV, timeout=60).text
    (RAW / "Pokemon_armgilles.csv").write_text(text, encoding="utf-8")
    stats = {}
    for row in csv.DictReader(io.StringIO(text)):
        n = int(row["#"])
        if n > 151 or n in stats or "Mega" in row["Name"]:
            continue
        stats[n] = {
            "hp": int(row["HP"]), "attack": int(row["Attack"]), "defense": int(row["Defense"]),
            "sp_attack": int(row["Sp. Atk"]), "sp_defense": int(row["Sp. Def"]),
            "speed": int(row["Speed"]), "total": int(row["Total"]),
            "legendary": row["Legendary"] == "True",
        }
    return stats


def load_pokemondb():
    """Tabela https://pokemondb.net/pokedex/all (status base atuais)."""
    print("• Baixando tabela da PokémonDB (pokemondb.net/pokedex/all)...")
    try:
        html = session.get(POKEMONDB, timeout=60).text
    except Exception as exc:  # noqa: BLE001
        print(f"  ! PokémonDB indisponível ({exc}) — usando apenas o gist.")
        return {}
    out, rows_csv = {}, ["id,name,form,types,total,hp,attack,defense,sp_attack,sp_defense,speed"]
    for tr in re.findall(r"<tr>(.*?)</tr>", html, re.S):
        m = re.search(r'data-sort-value="(\d+)"', tr)
        if not m:
            continue
        n = int(m.group(1))
        name = re.search(r'class="ent-name"[^>]*>([^<]+)<', tr)
        form = re.search(r'<small class="text-muted">([^<]+)</small>', tr)
        types = re.findall(r'type-icon type-(\w+)', tr)
        nums = [int(x) for x in re.findall(r'<td class="cell-num(?: cell-total)?">(\d+)</td>', tr)]
        if not name or len(nums) != 7:
            continue
        rows_csv.append(f'{n},"{name.group(1)}","{form.group(1) if form else ""}",{"/".join(types)},'
                        + ",".join(map(str, nums)))
        if n <= 151 and n not in out and not form:
            total, hp, atk, de, spa, spd, spe = nums
            out[n] = {"hp": hp, "attack": atk, "defense": de, "sp_attack": spa,
                      "sp_defense": spd, "speed": spe, "total": total}
    (RAW / "pokemondb_all.csv").write_text("\n".join(rows_csv), encoding="utf-8")
    print(f"  {len(out)} Pokémon da 1ª geração lidos da PokémonDB.")
    return out


def load_kaggle():
    path = RAW / "pokemon.csv"
    if not path.exists():
        print("• (opcional) data/raw/pokemon.csv do Kaggle não encontrado — ignorando.")
        return {}
    print("• Mesclando dataset Kaggle rounakbanik/pokemon...")
    out = {}
    with path.open(encoding="utf-8", errors="ignore") as f:
        for row in csv.DictReader(f):
            n = int(row["pokedex_number"])
            if n > 151:
                continue
            out[n] = {
                "japanese_name": row.get("japanese_name"),
                "classification": row.get("classfication") or row.get("classification"),
                "capture_rate_kaggle": row.get("capture_rate"),
                "percentage_male": row.get("percentage_male") or None,
                "base_egg_steps": row.get("base_egg_steps"),
                "experience_growth": row.get("experience_growth"),
            }
    return out


def type_effectiveness(types: list[str], type_cache: dict) -> dict[str, float]:
    mult = {t: 1.0 for t in TYPE_PT}
    for t in types:
        rel = type_cache[t]["damage_relations"]
        for x in rel["double_damage_from"]:
            mult[x["name"]] *= 2
        for x in rel["half_damage_from"]:
            mult[x["name"]] *= 0.5
        for x in rel["no_damage_from"]:
            mult[x["name"]] *= 0
    return mult


def fetch_pokemon(i: int):
    p = get(f"{POKEAPI}/pokemon/{i}")
    s = get(f"{POKEAPI}/pokemon-species/{i}")
    return i, p, s


def main() -> None:
    for d in (RAW, MODEL_DIR, IMG_ART, IMG_SPRITE):
        d.mkdir(parents=True, exist_ok=True)

    # ---------------- Modelo ----------------
    print("• Baixando modelo (Hugging Face RogerKoala/gen1-pokemon-classifier)...")
    download(HF_MODEL, MODEL_DIR / "pokedex.safetensors")
    labels_txt = session.get(HF_LABELS, timeout=60).text
    (MODEL_DIR / "Pokemons.txt").write_text(labels_txt, encoding="utf-8")
    labels = [l.strip() for l in labels_txt.splitlines() if l.strip()]
    assert len(labels) == 151, f"esperava 151 classes, veio {len(labels)}"

    stats = load_gist_stats()
    for n, s in load_pokemondb().items():  # PokémonDB tem prioridade (dados atuais)
        stats[n] = {**stats.get(n, {}), **s}
    kaggle = load_kaggle()

    # ---------------- PokeAPI ----------------
    print("• Consultando PokeAPI (151 Pokémon)...")
    with ThreadPoolExecutor(max_workers=8) as ex:
        results = dict((i, (p, s)) for i, p, s in ex.map(fetch_pokemon, range(1, 152)))

    type_cache = {t: get(f"{POKEAPI}/type/{t}") for t in TYPE_PT}

    chain_cache: dict[str, dict] = {}
    ability_cache: dict[str, dict] = {}

    pokemons = []
    for i in range(1, 152):
        p, s = results[i]
        chain_url = s["evolution_chain"]["url"]
        if chain_url not in chain_cache:
            chain_cache[chain_url] = get(chain_url)
        stages = [[x for x in st if x <= 151] for st in chain_stages(chain_cache[chain_url]["chain"])]
        stages = [st for st in stages if st]

        abilities = []
        for a in p["abilities"]:
            name = a["ability"]["name"]
            if name not in ability_cache:
                ability_cache[name] = get(a["ability"]["url"])
            ad = ability_cache[name]
            label, _ = pick_text(ad["names"], key="name")
            desc, _ = pick_text(ad.get("flavor_text_entries", []))
            abilities.append({"name": label or name, "hidden": a["is_hidden"], "description": desc})

        desc, desc_lang = pick_text(s["flavor_text_entries"])
        genus, _ = pick_text(s["genera"], key="genus")
        types = [t["type"]["name"] for t in sorted(p["types"], key=lambda t: t["slot"])]
        eff = type_effectiveness(types, type_cache)

        art_url = p["sprites"]["other"]["official-artwork"]["front_default"]
        sprite_url = p["sprites"]["front_default"]
        anim_url = (p["sprites"]["other"].get("showdown") or {}).get("front_default")

        base_stats = {x["stat"]["name"]: x["base_stat"] for x in p["stats"]}
        st = stats.get(i) or {
            "hp": base_stats["hp"], "attack": base_stats["attack"], "defense": base_stats["defense"],
            "sp_attack": base_stats["special-attack"], "sp_defense": base_stats["special-defense"],
            "speed": base_stats["speed"], "total": sum(base_stats.values()), "legendary": s["is_legendary"],
        }

        pokemons.append({
            "id": i,
            "name": s["names"] and next((n["name"] for n in s["names"] if n["language"]["name"] == "en"), p["name"]),
            "slug": p["name"],
            "genus": genus,
            "types": types,
            "types_pt": [TYPE_PT[t] for t in types],
            "height_m": p["height"] / 10,
            "weight_kg": p["weight"] / 10,
            "base_experience": p["base_experience"],
            "abilities": abilities,
            "stats": st,
            "description": desc,
            "description_lang": desc_lang,
            "capture_rate": s["capture_rate"],
            "base_happiness": s["base_happiness"],
            "habitat": (s.get("habitat") or {}).get("name"),
            "color": s["color"]["name"],
            "is_legendary": s["is_legendary"],
            "is_mythical": s["is_mythical"],
            "evolution": stages,
            "weaknesses": sorted([t for t, m in eff.items() if m > 1], key=lambda t: -eff[t]),
            "resistances": [t for t, m in eff.items() if 0 < m < 1],
            "immunities": [t for t, m in eff.items() if m == 0],
            "effectiveness": eff,
            "image": f"img/artwork/{i}.png",
            "sprite": f"img/sprites/{i}.png",
            "animated": anim_url,
            **kaggle.get(i, {}),
            "_art_url": art_url,
            "_sprite_url": sprite_url,
        })
        print(f"  #{i:03d} {pokemons[-1]['name']}")

    # ---------------- Imagens ----------------
    print("• Baixando imagens (artwork oficial + sprites)...")

    def dl(pk):
        if pk["_art_url"]:
            download(pk["_art_url"], IMG_ART / f"{pk['id']}.png")
        if pk["_sprite_url"]:
            download(pk["_sprite_url"], IMG_SPRITE / f"{pk['id']}.png")

    with ThreadPoolExecutor(max_workers=8) as ex:
        list(ex.map(dl, pokemons))
    for pk in pokemons:
        pk.pop("_art_url"), pk.pop("_sprite_url")

    # ---------------- Mapeamento classe -> id ----------------
    by_norm = {norm(pk["slug"]): pk["id"] for pk in pokemons}
    by_norm.update({norm(pk["name"]): pk["id"] for pk in pokemons})
    by_norm["farfetch"] = by_norm["farfetchd"]
    label_to_id = {}
    for lab in labels:
        key = norm(lab)
        if key not in by_norm:
            sys.exit(f"Não consegui mapear a classe '{lab}'")
        label_to_id[lab] = by_norm[key]

    (DATA / "pokemon.json").write_text(json.dumps(pokemons, ensure_ascii=False, indent=1), encoding="utf-8")
    (DATA / "labels.json").write_text(json.dumps({"labels": labels, "label_to_id": label_to_id},
                                                 ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n✔ Pronto! {len(pokemons)} Pokémon salvos em {DATA / 'pokemon.json'}")


if __name__ == "__main__":
    main()
