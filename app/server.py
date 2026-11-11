"""
Servidor local da Pokédex com Ensemble Inteligente (CLIP ViT + kNN + DenseNet121).
"""
from __future__ import annotations

import io
import json
import os
import secrets
import threading
import traceback
from contextlib import asynccontextmanager
from pathlib import Path

os.environ.setdefault("KERAS_BACKEND", "torch")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

# Variável de ambiente para proteção por senha (configurada no Dokploy)
APP_PASSWORD = os.environ.get("APP_PASSWORD") or os.environ.get("POKEDEX_PASSWORD") or os.environ.get("ACCESS_CODE") or ""
AUTH_TOKEN = secrets.token_hex(24) if APP_PASSWORD else ""

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image

from app.recognizer import Recognizer
from app.battle_engine import calculate_pokemon_stamina
from app.battle_server import router as battle_router, websocket_battle_endpoint

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
if len(LABELS) != 151 and (MODEL_DIR / "Pokemons.txt").exists():
    _txt = [l.strip() for l in (MODEL_DIR / "Pokemons.txt").read_text(encoding="utf-8").splitlines() if l.strip()]
    _by_norm = {
        p["name"].lower().replace("♀", "-f").replace("♂", "-m").replace("'", "").replace(". ", "-").replace(" ", "-"): p["id"]
        for p in POKEMON if p["id"] <= 151
    }
    _by_norm.update({"nidoranf": 29, "nidoranm": 32, "mr. mime": 122, "farfetch'd": 83})
    LABELS = _txt
    LABEL_TO_ID = {l: _by_norm[l.lower()] for l in _txt if l.lower() in _by_norm}

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


@app.exception_handler(Exception)
async def unhandled_exception_handler(_request: Request, exc: Exception):
    traceback.print_exc()
    return JSONResponse(status_code=500, content={"detail": f"{type(exc).__name__}: {exc}"})


def check_auth(authorization: str | None = Header(None)):
    """Verifica se a aplicação exige senha e valida o token Bearer."""
    if not APP_PASSWORD:
        return True
    if not authorization:
        raise HTTPException(status_code=401, detail="Código de acesso necessário.")
    parts = authorization.split()
    if len(parts) == 2 and parts[0].lower() == "bearer" and secrets.compare_digest(parts[1], AUTH_TOKEN):
        return True
    raise HTTPException(status_code=401, detail="Código de acesso inválido ou expirado.")


@app.get("/api/auth/status")
def auth_status(authorization: str | None = Header(None)):
    if not APP_PASSWORD:
        return {"required": False, "authenticated": True}
    is_authed = False
    if authorization:
        parts = authorization.split()
        if len(parts) == 2 and parts[0].lower() == "bearer" and secrets.compare_digest(parts[1], AUTH_TOKEN):
            is_authed = True
    return {"required": True, "authenticated": is_authed}


@app.post("/api/auth/login")
async def auth_login(password: str = Form(...)):
    if not APP_PASSWORD:
        return {"ok": True, "token": "open"}
    if secrets.compare_digest(password.strip(), APP_PASSWORD.strip()):
        return {"ok": True, "token": AUTH_TOKEN}
    raise HTTPException(status_code=401, detail="Código de acesso incorreto.")


@app.get("/api/health")
def health():
    return {
        "ok": True,
        "model_loaded": _recognizer is not None,
        "pokemon": len(POKEMON),
        "has_clip": _recognizer.clip is not None if _recognizer else False,
        "index_vectors": len(_recognizer.index_cls) if _recognizer and _recognizer.index_cls is not None else 0,
    }


def format_pokemon(p: dict) -> dict:
    """Garante que sprites e artworks tenham URLs funcionais mesmo em ambientes Docker."""
    p_copy = dict(p)
    pid = p.get("id", 1)
    img_rel = p.get("image", "")
    sprite_rel = p.get("sprite", "")

    # Se a imagem local não existir no servidor (ex: Dokploy/Docker limpo), usa CDN oficial
    if not (WEB / img_rel).exists() or not img_rel:
        p_copy["image"] = f"https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/{pid}.png"
    if not (WEB / sprite_rel).exists() or not sprite_rel:
        p_copy["sprite"] = f"https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/{pid}.png"
    return p_copy


@app.get("/api/pokemon", dependencies=[Depends(check_auth)])
def list_pokemon():
    return [{
        "id": p["id"],
        "name": p["name"],
        "types": p["types"],
        "types_pt": p["types_pt"],
        "stamina_cost": calculate_pokemon_stamina(p),
        "sprite": format_pokemon(p)["sprite"],
        "image": format_pokemon(p)["image"],
    } for p in POKEMON]


@app.get("/api/pokemon/{pid}", dependencies=[Depends(check_auth)])
def get_pokemon(pid: int):
    if pid not in POKEMON_BY_ID:
        raise HTTPException(404, "Pokémon não encontrado")
    return format_pokemon(POKEMON_BY_ID[pid])


@app.post("/api/predict", dependencies=[Depends(check_auth)])
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
        p = format_pokemon(POKEMON_BY_ID[r["id"]])
        out.append({
            "label": p["name"],
            "confidence": r["confidence"],
            "scores": r["scores"],
            "pokemon": p,
        })
    return {"results": out}


@app.post("/api/feedback", dependencies=[Depends(check_auth)])
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


@app.post("/api/register_custom", dependencies=[Depends(check_auth)])
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


# Módulo de Batalha Pokémon Online
app.include_router(battle_router)
app.add_api_websocket_route("/ws/battle", websocket_battle_endpoint)


@app.get("/img/{folder}/{filename}")
def serve_pokemon_image(folder: str, filename: str):
    if folder not in ("artwork", "sprites") or Path(filename).name != filename:
        raise HTTPException(404)
    local = WEB / "img" / folder / filename
    if local.exists():
        return FileResponse(local)
    sub = "pokemon/other/official-artwork" if folder == "artwork" else "pokemon"
    return RedirectResponse(f"https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/{sub}/{filename}")


@app.get("/")
def index():
    return FileResponse(WEB / "index.html")


ds_folder = DATA / "dataset" / "dataset"
if ds_folder.exists():
    app.mount("/dataset", StaticFiles(directory=ds_folder), name="dataset")

app.mount("/", StaticFiles(directory=WEB), name="web")
