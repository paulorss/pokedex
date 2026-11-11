"""Popula cadeias evolutivas completas (Gens 1-9, IDs 1..1025) em data/pokemon.json via PokeAPI."""
from __future__ import annotations

import json
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
POKEMON_JSON = ROOT / "data" / "pokemon.json"


def fetch_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "PokedexBot/1.0"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode("utf-8"))


def species_id_from_url(url: str) -> int:
    return int(url.rstrip("/").split("/")[-1])


def extract_stages(chain_node: dict, max_id: int = 1025) -> list[list[int]]:
    stages: list[list[int]] = []

    def walk(node: dict, depth: int) -> None:
        sid = species_id_from_url(node["species"]["url"])
        if 1 <= sid <= max_id:
            while len(stages) <= depth:
                stages.append([])
            if sid not in stages[depth]:
                stages[depth].append(sid)
        for nxt in node.get("evolves_to") or []:
            walk(nxt, depth + 1)

    walk(chain_node, 0)
    return [sorted(s) for s in stages if s]


def main() -> None:
    data = json.loads(POKEMON_JSON.read_text(encoding="utf-8"))
    by_id = {p["id"]: p for p in data}
    max_id = max(by_id)

    index = fetch_json("https://pokeapi.co/api/v2/evolution-chain?limit=1000")
    urls = [item["url"] for item in index.get("results", [])]
    print(f"Buscando {len(urls)} cadeias evolutivas...")

    updated = 0
    errors = 0
    with ThreadPoolExecutor(max_workers=16) as pool:
        futures = {pool.submit(fetch_json, url): url for url in urls}
        for fut in as_completed(futures):
            try:
                chain_data = fut.result()
                stages = extract_stages(chain_data["chain"], max_id=max_id)
                if not stages:
                    continue
                for stage in stages:
                    for pid in stage:
                        if pid in by_id:
                            by_id[pid]["evolution"] = stages
                            updated += 1
            except Exception as exc:  # noqa: BLE001
                errors += 1
                print(f"Aviso ao baixar {futures[fut]}: {exc}")

    POKEMON_JSON.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    multi = sum(1 for p in data if len(p.get("evolution") or []) > 1)
    print(f"Atualizados: {updated} | Erros: {errors} | Pokemon com evolucao multi-estagio: {multi}/{len(data)}")


if __name__ == "__main__":
    main()
