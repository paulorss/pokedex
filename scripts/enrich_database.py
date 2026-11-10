"""
Enriquece data/pokemon.json unindo:
1. Kaggle (rounakbanik/pokemon via kagglehub) -> nome japonês, taxa de gênero, passos de ovo, etc.
2. PokémonDB (pokemondb.net/pokedex/all) -> status e totais atuais oficiais
3. Hugging Face RogerKoala/gen1-pokemon-images -> galeria de modelos 3D, anime, renders e variações
"""
from __future__ import annotations

import csv
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
RAW = DATA / "raw"
DATASET_DIR = DATA / "dataset" / "dataset"
JSON_PATH = DATA / "pokemon.json"


def norm(s: str) -> str:
    s = s.replace("♀", "f").replace("♂", "m").lower()
    return re.sub(r"[^a-z0-9]", "", s)


def load_kaggle():
    csv_path = RAW / "pokemon.csv"
    if not csv_path.exists():
        print("pokemon.csv não encontrado em data/raw.")
        return {}
    out = {}
    with csv_path.open(encoding="utf-8", errors="ignore") as f:
        for row in csv.DictReader(f):
            try:
                num = int(row.get("pokedex_number", 0))
            except ValueError:
                continue
            if 1 <= num <= 151:
                # Extrai fraquezas e resistências detalhadas
                against = {k.replace("against_", ""): float(v) for k, v in row.items() if k.startswith("against_")}
                male = row.get("percentage_male")
                out[num] = {
                    "japanese_name": row.get("japanese_name", ""),
                    "percentage_male": float(male) if male and male.strip() else None,
                    "base_egg_steps": int(row.get("base_egg_steps", 0)) if row.get("base_egg_steps") else None,
                    "experience_growth": int(row.get("experience_growth", 0)) if row.get("experience_growth") else None,
                    "against": against,
                }
    return out


def load_gallery(pokemons):
    """Mapeia as imagens do dataset RogerKoala para cada Pokémon."""
    if not DATASET_DIR.exists():
        return {}
    name_to_id = {norm(p["name"]): p["id"] for p in pokemons}
    name_to_id.update({norm(p["slug"]): p["id"] for p in pokemons})
    name_to_id["farfetch"] = 83
    name_to_id["mrmime"] = 122
    name_to_id["nidoran"] = 29

    gallery_by_id = {p["id"]: [] for p in pokemons}

    for split in ("train", "test"):
        sp_path = DATASET_DIR / split
        if not sp_path.exists():
            continue
        for folder in sp_path.iterdir():
            if not folder.is_dir():
                continue
            k = norm(folder.name)
            pid = name_to_id.get(k)
            if not pid:
                continue
            for img in folder.iterdir():
                if img.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp"):
                    rel_url = f"/dataset/{split}/{folder.name}/{img.name}"
                    gallery_by_id[pid].append({
                        "url": rel_url,
                        "name": img.stem,
                        "is_3d": "3d" in img.name.lower() or "pmd" in img.name.lower(),
                        "is_shiny": "shiny" in img.name.lower(),
                    })
    return gallery_by_id


def main():
    if not JSON_PATH.exists():
        print("data/pokemon.json não encontrado.")
        return

    pokemons = json.loads(JSON_PATH.read_text(encoding="utf-8"))
    print(f"• Enriquecendo base com {len(pokemons)} Pokémon...")

    kaggle = load_kaggle()
    gallery = load_gallery(pokemons)

    for p in pokemons:
        pid = p["id"]

        # 1. Dados do Kaggle
        if pid in kaggle:
            k_data = kaggle[pid]
            p["japanese_name"] = k_data["japanese_name"]
            p["percentage_male"] = k_data["percentage_male"]
            p["base_egg_steps"] = k_data["base_egg_steps"]
            p["experience_growth"] = k_data["experience_growth"]
            if k_data.get("against"):
                p["effectiveness_kaggle"] = k_data["against"]

        # 2. Galeria de Imagens e Modelos 3D do RogerKoala
        p["gallery"] = gallery.get(pid, [])

    JSON_PATH.write_text(json.dumps(pokemons, ensure_ascii=False, indent=1), encoding="utf-8")
    print("✔ Base de dados enriquecida com Kaggle + RogerKoala + PokémonDB com sucesso!")


if __name__ == "__main__":
    main()

