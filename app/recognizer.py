"""
Reconhecimento de Pokémon por ENSEMBLE de 3 métodos:

  1. CLIP zero-shot   – compara a imagem com descrições de texto ("a toy figure of
                         the pokemon Venusaur", "a pokemon card of ..."). Muito robusto
                         a fotos reais (brinquedos, cartas, pelúcias, telas).
  2. CLIP kNN         – compara a imagem com TODAS as imagens da base de dados
                         (dataset RogerKoala/gen1-pokemon-images + artes oficiais).
  3. DenseNet121      – classificador RogerKoala/gen1-pokemon-classifier (ótimo em artes).

As probabilidades são combinadas por média ponderada.
"""
from __future__ import annotations

import os
import threading
from pathlib import Path

os.environ.setdefault("KERAS_BACKEND", "torch")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

import numpy as np
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parent.parent
MODEL_DIR = ROOT / "model"
DATA = ROOT / "data"
INDEX_FILE = DATA / "clip_index.npz"

CLIP_MODEL = os.environ.get("POKEDEX_CLIP", "openai/clip-vit-large-patch14")

TEMPLATES = [
    "a photo of {}, a pokemon.",
    "a photo of a {} pokemon toy figure.",
    "a plastic figurine of the pokemon {}.",
    "a plush toy of the pokemon {}.",
    "a pokemon trading card of {}.",
    "a drawing of the pokemon {}.",
    "official artwork of the pokemon {}.",
    "a screenshot of {} from the pokemon anime.",
    "a pixel art sprite of the pokemon {}.",
    "a blurry photo of the pokemon {}.",
]

# pesos do ensemble (ajustados em scripts/evaluate.py)
WEIGHTS = {"zeroshot": 0.45, "knn": 0.35, "densenet": 0.20}
ZS_SCALE = 100.0   # temperatura do CLIP
KNN_SCALE = 60.0   # temperatura do kNN


def prompt_name(name: str) -> str:
    return name.replace("♀", " female").replace("♂", " male")


def to_rgb(img: Image.Image) -> Image.Image:
    img = ImageOps.exif_transpose(img)
    if img.mode in ("RGBA", "LA", "P"):
        img = img.convert("RGBA")
        bg = Image.new("RGBA", img.size, (255, 255, 255, 255))
        img = Image.alpha_composite(bg, img)
    return img.convert("RGB")


def pad_square(img: Image.Image, fill=(255, 255, 255)) -> Image.Image:
    w, h = img.size
    s = max(w, h)
    out = Image.new("RGB", (s, s), fill)
    out.paste(img, ((s - w) // 2, (s - h) // 2))
    return out


def center_crop(img: Image.Image, frac: float) -> Image.Image:
    w, h = img.size
    s = int(min(w, h) * frac)
    l, t = (w - s) // 2, (h - s) // 2
    return img.crop((l, t, l + s, t + s))


def softmax(x: np.ndarray) -> np.ndarray:
    x = x - x.max(axis=-1, keepdims=True)
    e = np.exp(x)
    return e / e.sum(axis=-1, keepdims=True)


# ---------------------------------------------------------------------------
class ClipEncoder:
    def __init__(self, model_id: str = CLIP_MODEL):
        import torch
        from transformers import CLIPModel, CLIPProcessor

        self.torch = torch
        self.model_id = model_id
        self.model = CLIPModel.from_pretrained(model_id).eval()
        self.proc = CLIPProcessor.from_pretrained(model_id)

    def _norm(self, e):
        e = e if self.torch.is_tensor(e) else e.pooler_output
        return self.torch.nn.functional.normalize(e, dim=-1).cpu().numpy().astype("float32")

    def images(self, imgs: list[Image.Image], batch: int = 16) -> np.ndarray:
        out = []
        with self.torch.no_grad():
            for i in range(0, len(imgs), batch):
                inp = self.proc(images=imgs[i:i + batch], return_tensors="pt")
                out.append(self._norm(self.model.get_image_features(**inp)))
        return np.concatenate(out)

    def class_text(self, names: list[str], batch: int = 128) -> np.ndarray:
        embs = []
        with self.torch.no_grad():
            for tpl in TEMPLATES:
                tpl_embs = []
                for i in range(0, len(names), batch):
                    prompts = [tpl.format(prompt_name(n)) for n in names[i:i + batch]]
                    inp = self.proc(text=prompts, return_tensors="pt", padding=True)
                    tpl_embs.append(self._norm(self.model.get_text_features(**inp)))
                embs.append(np.concatenate(tpl_embs, axis=0))
        m = np.mean(embs, axis=0)
        return m / np.linalg.norm(m, axis=1, keepdims=True)


class DenseNetClassifier:
    """Arquitetura idêntica ao Space RogerKoala/Pokedex."""

    def __init__(self):
        import keras
        from keras import layers
        from keras.applications import DenseNet121
        from safetensors.numpy import load_file

        base = DenseNet121(include_top=False, weights=None, input_shape=(224, 224, 3))
        self.model = keras.Sequential([
            keras.Input(shape=(224, 224, 3)), base,
            layers.GlobalAveragePooling2D(),
            layers.Dense(128, activation="relu"), layers.Dropout(0.5),
            layers.Dense(151, activation="softmax"),
        ])
        t = load_file(str(MODEL_DIR / "pokedex.safetensors"))
        self.model.set_weights([t[f"weight_{i}"] for i in range(len(t))])

    def predict(self, imgs: list[Image.Image]) -> np.ndarray:
        """Retorna probabilidades (n, 151) na ordem alfabética de Pokemons.txt."""
        from keras.applications.densenet import preprocess_input

        x = np.stack([np.asarray(i.resize((224, 224), Image.BILINEAR), dtype="float32") for i in imgs])
        x = np.concatenate([x, x[:, :, ::-1, :]])  # + espelhadas
        p = np.asarray(self.model.predict(preprocess_input(x), verbose=0))
        n = len(imgs)
        return (p[:n] + p[n:]) / 2


# ---------------------------------------------------------------------------
class Recognizer:
    """
    ids:      lista de ids da Pokédex (1..151) – ordem das classes do ensemble
    dn_order: para cada label do DenseNet (ordem alfabética), o id correspondente
    """

    def __init__(self, ids: list[int], names: list[str], dn_label_ids: list[int]):
        self.ids = ids
        self.names = names
        self.pos = {pid: k for k, pid in enumerate(ids)}
        self.dn_map = np.array([self.pos[i] for i in dn_label_ids])

        self.densenet = DenseNetClassifier()
        self.clip = None
        self.text = None
        self.index_emb = None
        self.index_cls = None
        try:
            self.clip = ClipEncoder()
            if INDEX_FILE.exists():
                z = np.load(INDEX_FILE, allow_pickle=False)
                if str(z["model_id"]) == self.clip.model_id:
                    valid_mask = [int(i) in self.pos for i in z["ids"]]
                    if any(valid_mask):
                        self.index_emb = z["emb"][valid_mask].astype("float32")
                        self.index_cls = np.array([self.pos[int(i)] for i, ok in zip(z["ids"], valid_mask) if ok])
                    if z["text"].shape[0] == len(names):
                        self.text = z["text"].astype("float32")
            text_cache = DATA / "clip_text_cache.npz"
            if self.text is None and text_cache.exists():
                tc = np.load(text_cache, allow_pickle=False)
                if str(tc["model_id"]) == self.clip.model_id and tc["text"].shape[0] == len(names):
                    self.text = tc["text"].astype("float32")
            if self.text is None:
                print(f"Gerando embeddings de texto CLIP para {len(names)} Pokémon...")
                self.text = self.clip.class_text(names).astype("float32")
                try:
                    np.savez_compressed(text_cache, model_id=self.clip.model_id, text=self.text)
                except Exception:  # noqa: BLE001
                    pass
        except Exception as exc:  # noqa: BLE001
            print(f"[aviso] CLIP indisponível ({exc}); usando só o DenseNet.")
            self.clip = None

    # -- componentes -----------------------------------------------------
    def densenet_probs(self, views: list[Image.Image]) -> np.ndarray:
        p = self.densenet.predict(views).mean(axis=0)
        out = np.zeros(len(self.ids), dtype="float32")
        if len(self.dn_map) == len(p):
            out[self.dn_map] = p
        return out

    def zeroshot_probs(self, q: np.ndarray) -> np.ndarray:
        return softmax(ZS_SCALE * q @ self.text.T).mean(axis=0)

    def knn_probs(self, q: np.ndarray, k: int = 3) -> np.ndarray:
        sims = q @ self.index_emb.T  # (views, N)
        n_cls = len(self.ids)
        scores = np.full((len(q), n_cls), -1.0, dtype="float32")
        for c in range(n_cls):
            s = sims[:, self.index_cls == c]
            if s.shape[1]:
                kk = min(k, s.shape[1])
                scores[:, c] = np.sort(s, axis=1)[:, -kk:].mean(axis=1)  # média dos k mais parecidos
        return softmax(KNN_SCALE * scores).mean(axis=0)

    # -- API ---------------------------------------------------------------
    def views(self, img: Image.Image) -> list[Image.Image]:
        img = to_rgb(img)
        sq = pad_square(img)
        v = [sq]
        if min(img.size) > 160:
            v.append(center_crop(img, 0.8))
        return v

    def predict(self, img: Image.Image, top_k: int = 5, weights: dict | None = None):
        w = dict(weights or WEIGHTS)
        views = self.views(img)
        parts = {"densenet": self.densenet_probs(views)}
        if self.clip is not None:
            q = self.clip.images(views)
            parts["zeroshot"] = self.zeroshot_probs(q)
            if self.index_emb is not None:
                parts["knn"] = self.knn_probs(q)
        total_w = sum(w[k] for k in parts)
        final = sum(w[k] * parts[k] for k in parts) / total_w
        idx = np.argsort(final)[::-1][:top_k]
        return [{
            "id": self.ids[i],
            "confidence": float(final[i]),
            "scores": {k: float(v[i]) for k, v in parts.items()},
        } for i in idx]


    def add_new_pokemon(self, pid: int, name: str, img: Image.Image | None = None):
        """Adiciona ou calibra um Pokémon dinamicamente em tempo real."""
        if pid in self.pos:
            c_idx = self.pos[pid]
        else:
            self.ids.append(pid)
            self.names.append(name)
            c_idx = len(self.ids) - 1
            self.pos[pid] = c_idx
            if self.clip is not None:
                new_text = self.clip.class_text([name])
                if self.text is not None:
                    self.text = np.vstack([self.text, new_text.astype(np.float32)])
                else:
                    self.text = new_text.astype(np.float32)

        if img is not None and self.clip is not None:
            views = self.views(img)
            emb = self.clip.images(views).mean(axis=0, keepdims=True)
            if self.index_emb is not None:
                self.index_emb = np.vstack([self.index_emb, emb.astype(np.float32)])
                self.index_cls = np.append(self.index_cls, c_idx)
            else:
                self.index_emb = emb.astype(np.float32)
                self.index_cls = np.array([c_idx])

    def save_index(self):
        """Persiste o índice vetorial atualizado em disco."""
        if self.text is not None and self.index_emb is not None:
            np.savez_compressed(
                INDEX_FILE,
                model_id=self.clip.model_id if self.clip else "",
                text=self.text.astype(np.float32),
                emb=self.index_emb.astype(np.float32),
                ids=np.array([self.ids[c] for c in self.index_cls], dtype=np.int32),
            )

