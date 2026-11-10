"""
Gera o índice vetorial CLIP para busca visual por similaridade (kNN)
e o embedding de texto calibrado para todos os 151 Pokémon.

Fontes de imagens indexadas:
1. web/img/artwork (arte oficial em alta resolução)
2. web/img/sprites (sprites de jogos)
3. data/dataset/dataset (todas as 2.700+ imagens do RogerKoala/gen1-pokemon-images)
4. data/user_samples (fotos reais adicionadas pelo usuário para afinar o reconhecimento)
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

import numpy as np
import torch
from PIL import Image, ImageOps
from transformers import CLIPModel, CLIPProcessor

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
WEB = ROOT / "web"
INDEX_FILE = DATA / "clip_index.npz"

CLIP_MODEL = os.environ.get("POKEDEX_CLIP", "openai/clip-vit-large-patch14")

TEMPLATES = [
    "a photo of {}, a pokemon.",
    "a photo of a {} pokemon toy figure.",
    "a toy figure of the pokemon {}.",
    "a plastic figurine of the pokemon {}.",
    "a miniature model of the pokemon {}.",
    "a plush toy of the pokemon {}.",
    "a 3d figure of {}, pokemon.",
    "a pokemon trading card of {}.",
    "official artwork of the pokemon {}.",
    "the pokemon {}.",
]


def norm_name(s: str) -> str:
    s = s.replace("♀", " female").replace("♂", " male").lower()
    return re.sub(r"[^a-z0-9]", "", s)


def load_img(path: Path) -> Image.Image | None:
    try:
        img = Image.open(path)
        img = ImageOps.exif_transpose(img)
        if img.mode in ("RGBA", "LA", "P"):
            img = img.convert("RGBA")
            bg = Image.new("RGBA", img.size, (255, 255, 255, 255))
            img = Image.alpha_composite(bg, img)
        return img.convert("RGB")
    except Exception as exc:
        print(f"Erro abrindo {path}: {exc}")
        return None


def main():
    print(f"• Carregando modelo CLIP ({CLIP_MODEL})...")
    model = CLIPModel.from_pretrained(CLIP_MODEL).eval()
    proc = CLIPProcessor.from_pretrained(CLIP_MODEL)

    pokemons = json.loads((DATA / "pokemon.json").read_text(encoding="utf-8"))
    id_by_name = {norm_name(p["name"]): p["id"] for p in pokemons}
    id_by_name.update({norm_name(p["slug"]): p["id"] for p in pokemons})
    id_by_name["farfetch"] = 83
    id_by_name["mr-mime"] = 122
    id_by_name["nidoran"] = 29

    # 1. Embeddings de texto das classes
    print("• Computando embeddings de texto das 151 classes...")
    text_embs = []
    with torch.no_grad():
        for tpl in TEMPLATES:
            prompts = [tpl.format(p["name"].replace("♀", " female").replace("♂", " male")) for p in pokemons]
            inp = proc(text=prompts, return_tensors="pt", padding=True)
            e = model.get_text_features(**inp)
            e = e if torch.is_tensor(e) else e.pooler_output
            e = torch.nn.functional.normalize(e, dim=-1)
            text_embs.append(e.cpu().numpy())
    class_text = np.mean(text_embs, axis=0)
    class_text = class_text / np.linalg.norm(class_text, axis=1, keepdims=True)

    # 2. Coletar imagens para indexação
    items: list[tuple[Path, int]] = []

    # Artworks oficiais
    for p in pokemons:
        art = WEB / p["image"]
        if art.exists():
            items.append((art, p["id"]))
        sp = WEB / p["sprite"]
        if sp.exists():
            items.append((sp, p["id"]))

    # Dataset RogerKoala
    ds_dir = DATA / "dataset" / "dataset"
    if ds_dir.exists():
        for split in ("train", "test"):
            sp_path = ds_dir / split
            if not sp_path.exists():
                continue
            for folder in sp_path.iterdir():
                if not folder.is_dir():
                    continue
                k = norm_name(folder.name)
                pid = id_by_name.get(k)
                if not pid:
                    continue
                for img_file in folder.iterdir():
                    if img_file.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp"):
                        items.append((img_file, pid))

    # Amostras do usuário (fotos reais para calibrar)
    user_dir = DATA / "user_samples"
    if user_dir.exists():
        for folder in user_dir.iterdir():
            if folder.is_dir() and folder.name.isdigit():
                pid = int(folder.name)
                for f in folder.iterdir():
                    if f.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp"):
                        items.append((f, pid))

    print(f"• Total de imagens coletadas para indexação: {len(items)}")

    # 3. Gerar embeddings das imagens em lotes
    BATCH = 32
    img_embs = []
    img_ids = []
    with torch.no_grad():
        for i in range(0, len(items), BATCH):
            batch = items[i:i + BATCH]
            loaded = []
            valid_ids = []
            for path, pid in batch:
                im = load_img(path)
                if im is not None:
                    loaded.append(im)
                    valid_ids.append(pid)
            if not loaded:
                continue
            inp = proc(images=loaded, return_tensors="pt")
            e = model.get_image_features(**inp)
            e = e if torch.is_tensor(e) else e.pooler_output
            e = torch.nn.functional.normalize(e, dim=-1)
            img_embs.append(e.cpu().numpy())
            img_ids.extend(valid_ids)
            if (i // BATCH) % 10 == 0:
                print(f"  Processadas {i + len(loaded)}/{len(items)} imagens...")

    all_embs = np.concatenate(img_embs, axis=0).astype(np.float32)
    all_ids = np.array(img_ids, dtype=np.int32)

    print(f"• Salvando índice em {INDEX_FILE} ({all_embs.shape[0]} vetores)...")
    np.savez_compressed(
        INDEX_FILE,
        model_id=CLIP_MODEL,
        text=class_text.astype(np.float32),
        emb=all_embs,
        ids=all_ids,
    )
    print("✔ Índice gerado com sucesso!")


if __name__ == "__main__":
    main()
