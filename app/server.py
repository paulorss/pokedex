"""
Servidor local da Pokédex com Ensemble Inteligente (CLIP ViT + kNN + DenseNet121).
"""
from __future__ import annotations

import io
import json
import os
import threading
from contextlib import asynccontextmanager
from pathlib import Path

os.environ.setdefault("KERAS_BACKEND", "torch")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image

from app.recognizer import Recognizer

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
MODEL_DIR = ROOT / "model"
WEB = ROOT / "web"
USER_SAMPLES = DATA / "user_samples"

if not (DATA / "pokemon.json").exists() or not (MODEL_DIR / "pokedex.safetensors").exists():
    raise SystemExit("Base local não encontrada. Rode primeiro:  python scripts/build_data.py")

POKEMON = json.loads((DATA / "pokemon.json").read_text(encoding="utf-8"))
POKEMON_BY_ID = {p["id"]: p for p in POKEMON}
_lab = json.loads((DATA / "labels.json").read_text(encoding="utf-8"))
LABELS: list[str] = _lab["labels"]
LABEL_TO_ID: dict[str, int] = _lab["label_to_id"]

_recognizer = None
_rec_lock = threading.Lock()


def get_recognizer() -> Recognizer:
    global _recognizer
    if _recognizer is None:
        with _rec_lock:
            if _recognizer is None:
                print("• Inicializando Reconhecedor Inteligente (CLIP + kNN + DenseNet)...")
                ids = [p["id"] for p in POKEMON]
                names = [p["name"] for p in POKEMON]
                dn_ids = [LABEL_TO_ID[l] for l in LABELS]
                _recognizer = Recognizer(ids=ids, names=names, dn_label_ids=dn_ids)
                print("• Reconhecedor pronto!")
    return _recognizer


@asynccontextmanager
async def lifespan(_app):
    threading.Thread(target=get_recognizer, daemon=True).start()
    yield


app = FastAPI(title="Pokédex Local", lifespan=lifespan)


@app.get("/api/health")
def health():
    return {
        "ok": True,
        "model_loaded": _recognizer is not None,
        "pokemon": len(POKEMON),
        "has_clip": _recognizer.clip is not None if _recognizer else False,
        "index_vectors": len(_recognizer.index_cls) if _recognizer and _recognizer.index_cls is not None else 0,
    }


@app.get("/api/pokemon")
def list_pokemon():
    return [{k: p[k] for k in ("id", "name", "types", "types_pt", "sprite", "image")} for p in POKEMON]


@app.get("/api/pokemon/{pid}")
def get_pokemon(pid: int):
    if pid not in POKEMON_BY_ID:
        raise HTTPException(404, "Pokémon não encontrado")
    return POKEMON_BY_ID[pid]


@app.post("/api/predict")
async def api_predict(file: UploadFile = File(...)):
    try:
        img = Image.open(io.BytesIO(await file.read()))
        img.load()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(400, f"Imagem inválida: {exc}") from exc

    rec = get_recognizer()
    results = rec.predict(img, top_k=5)

    out = []
    for r in results:
        p = POKEMON_BY_ID[r["id"]]
        out.append({
            "label": p["name"],
            "confidence": r["confidence"],
            "scores": r["scores"],
            "pokemon": p,
        })
    return {"results": out}


@app.post("/api/feedback")
async def api_feedback(pokemon_id: int = Form(...), file: UploadFile = File(...)):
    """Permite ao usuário ensinar/confirmar o Pokémon correto de uma foto."""
    if pokemon_id not in POKEMON_BY_ID:
        raise HTTPException(404, "Pokémon inválido")
    try:
        data = await file.read()
        img = Image.open(io.BytesIO(data))
        img.load()
    except Exception as exc:
        raise HTTPException(400, f"Imagem inválida: {exc}") from exc

    dest_dir = USER_SAMPLES / str(pokemon_id)
    dest_dir.mkdir(parents=True, exist_ok=True)
    idx = len(list(dest_dir.glob("*.jpg"))) + 1
    (dest_dir / f"sample_{idx}.jpg").write_bytes(data)

    # Atualiza o índice em memória se o recognizer já estiver ativo
    rec = get_recognizer()
    rec.add_new_pokemon(pokemon_id, POKEMON_BY_ID[pokemon_id]["name"], img)
    rec.save_index()

    return {"ok": True, "message": f"Amostra adicionada para #{pokemon_id:03d} {POKEMON_BY_ID[pokemon_id]['name']}!"}


TYPE_PT_MAP = {
    "normal": "Normal", "fire": "Fogo", "water": "Água", "grass": "Planta",
    "electric": "Elétrico", "ice": "Gelo", "fighting": "Lutador", "poison": "Venenoso",
    "ground": "Terrestre", "flying": "Voador", "psychic": "Psíquico", "bug": "Inseto",
    "rock": "Pedra", "ghost": "Fantasma", "dragon": "Dragão", "dark": "Sombrio",
    "steel": "Aço", "fairy": "Fada",
}


@app.post("/api/register_custom")
async def api_register_custom(
    name: str = Form(...),
    type1: str = Form(...),
    type2: str = Form(""),
    genus: str = Form(""),
    description: str = Form(""),
    file: UploadFile = File(...),
):
    """Registra manualmente um novo Pokémon na base local com a foto fornecida."""
    name = name.strip()
    if not name:
        raise HTTPException(400, "O nome do Pokémon é obrigatório.")

    try:
        data = await file.read()
        img = Image.open(io.BytesIO(data))
        img.load()
    except Exception as exc:
        raise HTTPException(400, f"Imagem inválida: {exc}") from exc

    # Define novo ID sequencial
    new_id = max(p["id"] for p in POKEMON) + 1 if POKEMON else 1
    types = [type1.lower().strip()]
    if type2 and type2.lower().strip():
        types.append(type2.lower().strip())

    types_pt = [TYPE_PT_MAP.get(t, t.capitalize()) for t in types]

    # Salva imagem como artwork e sprite
    art_path = WEB / "img" / "artwork" / f"{new_id}.png"
    sprite_path = WEB / "img" / "sprites" / f"{new_id}.png"
    art_path.parent.mkdir(parents=True, exist_ok=True)
    sprite_path.parent.mkdir(parents=True, exist_ok=True)

    img.convert("RGBA").save(art_path, "PNG")
    img.resize((96, 96), Image.Resampling.LANCZOS).convert("RGBA").save(sprite_path, "PNG")

    # Salva também como amostra de treino
    dest_dir = USER_SAMPLES / str(new_id)
    dest_dir.mkdir(parents=True, exist_ok=True)
    (dest_dir / "sample_1.jpg").write_bytes(data)

    new_pokemon = {
        "id": new_id,
        "name": name,
        "slug": name.lower().replace(" ", "-"),
        "genus": genus.strip() or "Pokémon Desconhecido",
        "types": types,
        "types_pt": types_pt,
        "height_m": 1.0,
        "weight_kg": 20.0,
        "base_experience": 100,
        "abilities": [{"name": "Especial", "hidden": False, "description": "Habilidade registrada manualmente."}],
        "stats": {
            "hp": 70, "attack": 75, "defense": 70,
            "sp_attack": 75, "sp_defense": 70, "speed": 70,
            "total": 430, "legendary": False
        },
        "description": description.strip() or f"Pokémon #{new_id:03d} registrado manualmente pelo usuário.",
        "description_lang": "pt-br",
        "capture_rate": 45,
        "base_happiness": 70,
        "habitat": "rare",
        "color": "custom",
        "is_legendary": False,
        "is_mythical": False,
        "evolution": [[new_id]],
        "weaknesses": [],
        "resistances": [],
        "immunities": [],
        "effectiveness": {},
        "image": f"img/artwork/{new_id}.png",
        "sprite": f"img/sprites/{new_id}.png",
        "animated": None,
    }

    POKEMON.append(new_pokemon)
    POKEMON_BY_ID[new_id] = new_pokemon
    (DATA / "pokemon.json").write_text(json.dumps(POKEMON, ensure_ascii=False, indent=1), encoding="utf-8")

    # Atualiza modelo inteligente em tempo real
    rec = get_recognizer()
    rec.add_new_pokemon(new_id, name, img)
    rec.save_index()

    print(f"✔ Novo Pokémon cadastrado: #{new_id:03d} {name} (Tipos: {types})")
    return {"ok": True, "message": f"#{new_id:03d} {name} cadastrado com sucesso!", "pokemon": new_pokemon}


@app.get("/")
def index():
    return FileResponse(WEB / "index.html")


ds_folder = DATA / "dataset" / "dataset"
if ds_folder.exists():
    app.mount("/dataset", StaticFiles(directory=ds_folder), name="dataset")

app.mount("/", StaticFiles(directory=WEB), name="web")
