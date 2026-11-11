# ⚡ Pokédex Local

Pokédex web que roda **100% localmente**: aponte a câmera para um Pokémon (desenho, carta, brinquedo, tela) e ela reconhece qual é (1ª geração, 151 Pokémon), mostrando a imagem e as características.

## Como rodar

```bat
start.bat            REM Windows  (instala tudo na 1ª vez, baixa a base e inicia)
```
```bash
./start.sh           # Linux / macOS / Raspberry Pi
```

Abra **http://localhost:8000** no navegador.

### Usar a câmera do celular (mesma rede Wi-Fi)
Navegadores só liberam a câmera em `localhost` ou em **HTTPS**. Então:

```bat
start.bat --https
```
Abra `https://<IP-do-PC>:8443` no celular (o endereço aparece no terminal) e aceite o aviso de certificado autoassinado.

## Como funciona

```
Navegador (câmera / upload)  ──POST /api/predict──▶  FastAPI + Keras 3 (PyTorch, CPU)
        ▲                                               │ DenseNet121 ajustada (151 classes)
        └──────── top-5 + dados do Pokémon ◀────────────┘ data/pokemon.json (base local)
```

| Fonte | Uso |
|---|---|
| [RogerKoala/gen1-pokemon-classifier](https://huggingface.co/RogerKoala/gen1-pokemon-classifier) | Pesos do modelo (96% no conjunto de teste) |
| [RogerKoala/gen1-pokemon-images](https://huggingface.co/datasets/RogerKoala/gen1-pokemon-images) | Dataset usado no treino do modelo |
| [PokeAPI](https://pokeapi.co/) | Tipos, altura, peso, habilidades, descrição, evolução, imagens |
| [PokémonDB](https://pokemondb.net/pokedex/all) | Status base (prioridade) |
| [Gist armgilles](https://gist.github.com/armgilles/194bcff35001e7eb53a2a8b441e8b2c6) | Status base (reserva) |
| [Kaggle rounakbanik/pokemon](https://www.kaggle.com/datasets/rounakbanik/pokemon) | Opcional: salve `pokemon.csv` em `data/raw/` e rode `python scripts/build_data.py` de novo (adiciona nome japonês etc.) |
| [cam-hm/pokedex-ai](https://github.com/cam-hm/pokedex-ai) | Inspiração da interface (status, fraquezas, evolução) |

## Deploy no Dokploy (Docker)

Esta aplicação está 100% pronta para deploy com 1 clique no **[Dokploy](https://dokploy.com)**:

### Opção A: Via Git Repository no Dokploy (Recomendado)
1. No painel do Dokploy, crie uma nova **Application**.
2. Conecte ao GitHub e selecione o repositório `paulorss/pokedex` (branch `main`).
3. Em **Build Type**, selecione **Dockerfile** (ou **Docker Compose**).
4. Em **Port**, defina `8000`.
5. Em **Domains**, aponte seu domínio (o Dokploy gera certificado SSL automático com Let's Encrypt, liberando a câmera em qualquer celular ou dispositivo!).
6. Clique em **Deploy**!

### Opção B: Via Docker Compose
```bash
docker compose up -d --build
```

---

## Estrutura
```
app/server.py          API + carregamento do modelo
scripts/build_data.py  baixa modelo, dados e imagens (rodar 1 vez)
web/                   interface (HTML/CSS/JS)
run.py                 inicia o servidor (--https opcional)
```

## Dicas para reconhecer melhor
- Centralize o Pokémon dentro da mira e preencha bem o quadro.
- Boa iluminação, fundo limpo.
- O modelo foi treinado com artes oficiais/anime: funciona melhor com desenhos, cartas e telas.
- Também dá para **enviar uma foto** ou **colar uma imagem (Ctrl+V)**.


---

## Duelo dos Encantados (aba "Duelo")

Jogo original de duelos por rodadas, com criaturas, elementos e regras próprios.

- **Trio e orçamento:** escolha 3 dos 20 Encantados gastando até 10 pontos (draft de 60 s).
- **Rodadas simultâneas:** a cada rodada (20 s) os dois jogadores escolhem em segredo entre **Golpe**, **Técnica** (3 de Foco, com efeito próprio), **Guarda** e **Trocar**; o servidor resolve e o cliente anima evento por evento.
- **Cinco elementos:** Brasa, Mata, Maré, Pedra e Vento; cada um leva vantagem sobre dois e desvantagem contra dois.
- **Modos:** treino contra a IA, desafio a outro treinador conectado ou ao "eco" (IA) de um treinador desconectado. Ranking e histórico em SQLite (`data/battle.db`).
- **Arena 3D:** `web/battle3d.js` usa Three.js r128 (carregado do cdnjs) com criaturas procedurais e shaders próprios. Sem WebGL ou sem acesso ao CDN, a arena cai automaticamente para uma versão 2D em SVG.

| Arquivo | Papel |
|---|---|
| `app/battle_engine.py` | Elenco, regras, resolução de rodada e IA |
| `app/battle_server.py` | REST (`/api/battle/*`) e WebSocket (`/ws/battle`) |
| `web/battle.js` | Salão, draft, HUD, narração e notificações |
| `web/battle3d.js` | Cena, modelos, partículas e efeitos |
