# buckshot-roullet-web — Documento de Design

Projeto pessoal para estudo e portfólio.
Inspirado em **Buckshot Roulette** (inspiração informada no README e no portfólio).

---

## 1. Objetivo

Jogo 3D no navegador onde dois jogadores (ou jogador contra IA) se enfrentam
usando uma arma carregada com munições aleatórias. Objetivo: eliminar o
adversário antes de morrer.

---

## 2. Tecnologias

| Camada | Tecnologia |
|---|---|
| Interface | HTML + CSS |
| Cliente | JavaScript |
| Gráficos 3D | Babylon.js |
| Backend | Node.js + Express (render.com) |
| Multiplayer | Socket.io |
| Banco de dados | PostgreSQL |

**Arquitetura:** servidor autoritativo. O cliente só envia ações; todo o
cálculo da partida (munição, dano, itens, resultado do tiro) acontece no
servidor. O cliente nunca decide resultados.

---

## 3. Modos de jogo

### PvP
- 2 jogadores online, 1 fase, 6 vidas cada.
- 4 itens distribuídos a cada recarga da arma.
- Ordem de turno: aleatória no início da partida; depois segue a alternância
  normal (não é resorteada a cada recarga).

### PvE
| Fase | Vidas | Itens por recarga (toda recarga dentro da fase) |
|---|---|---|
| 1 | 2 | 0 |
| 2 | 4 | 2 |
| 3 | 6 | 4 |

- Ordem de turno: o jogador humano **sempre começa** — tanto no início da
  fase quanto em toda recarga dentro da mesma fase.
- Ao iniciar uma nova fase: vida volta ao máximo, jogador começa a fase,
  inventário é esvaziado, efeitos ativos são cancelados.

---

## 4. Turno

Durante seu turno, o jogador pode:
1. Usar quantos itens quiser.
2. Pegar a arma.
3. Escolher: atirar em si, ou atirar no adversário.

Depois de pegar a arma, não é mais possível usar itens.

**Tempo de turno:** 1 minuto para decidir e agir (ver seção 8 — Timers).

---

## 5. Munição

- Cada recarga sorteia entre **2 e 8 balas**.
- Garantia mínima: pelo menos **1 bala real e 1 bala vazia**.
- As balas além dessas 2 garantidas seguem distribuição **30% real / 70%
  vazia**.
- A composição final (ex: "5 balas: 2 reais, 3 vazias") é **fixa e conhecida
  em contagem por todos os jogadores** assim que a recarga acontece — não é
  um sorteio novo a cada bala disparada. Cada bala disparada ou removida sai
  desse total sem reposição (ex: pente de 2 reais e 3 vazias, saem 1 real e
  1 vazia → restam exatamente 1 real e 2 vazias, nunca uma probabilidade
  solta de 30/70 recalculada do zero).

---

## 6. Resultado do tiro

**Bala real:**
- 1 ponto de dano (2 pontos se "Dano dobrado" estiver ativo).
- Turno termina.

**Bala vazia:**
- Atirar em si → joga um turno novo.
- Atirar no adversário → turno termina.

Quando todas as balas do pente acabam, a arma é recarregada (ver seção 5).

---

## 7. Itens

Distribuição: **aleatória e uniforme entre os 5 tipos** (mesma chance para
cada um, podem repetir). Regras gerais: máximo 8 itens no inventário, todos
consumíveis, podem ser usados vários no mesmo turno, visível para os dois
jogadores, itens usados desaparecem. No PvE o inventário zera ao trocar de
fase.

| Item | Efeito |
|---|---|
| 1. Ver munição | Revela a bala atual (real/vazia) só para quem usou. Não remove a bala. |
| 2. Retirar munição | Remove a bala atual. Todos veem se era real ou vazia. |
| 3. Travar adversário | Adversário perde o próximo turno. Não acumula. |
| 4. Curar | Recupera 1 ponto de vida, sem ultrapassar o máximo. |
| 5. Dano dobrado | Dobra o dano do próximo disparo (1 → 2). Vale para qualquer alvo. Termina após o tiro. |

**Regra do item 3 (Travar) — balanceamento intencional:** o efeito é
cancelado se houver troca de fase (PvE) ou recarga da arma (PvP) antes de
ele disparar. Funciona como contra-jogada natural do sistema.

---

## 8. Inteligência artificial (PvE)

Abordagem: **árvore de decisão com pesos**. A IA joga "cega" como um jogador
humano jogaria — só usa informação pública (composição conhecida do pente,
balas já reveladas/removidas, itens no próprio inventário).

**Estado observado no início do turno** (antes de qualquer item):
`vida_ia`, `vida_oponente`, `vida_maxima_da_fase`, `balas_restantes`,
`reais_restantes`, `vazias_restantes`, `p_real = reais_restantes / balas_restantes`,
`p_vazia = 1 - p_real`, inventário da IA.

**Passo 0 — Thresholds** (calculados com a vida do início do turno, antes de
qualquer cura nesse turno, para não deixar a cura mudar a regra no meio da
mesma decisão):
- `modo_cauteloso = vida_ia <= 3` (Fase 1 vive sempre nesse modo, pois a
  vida máxima da fase é 2 — decisão intencional: IA mais previsível na fase
  de aprendizado)
- `threshold_vazia_segura = 85%` se cauteloso, senão `50%`
- `threshold_real_dano_dobrado = 85%` (simetria proposital: errar ao
  arriscar a própria vida e errar ao desperdiçar o item mais valioso do jogo
  são tratados como igualmente custosos)

**Passo 1 — Curar:** se disponível e `vida_ia <= vida_maxima_da_fase / 2`,
usa. (Não recalcula o Passo 0, que já está travado.)

**Passo 2 — Ver munição:** se disponível e ainda há incerteza real
(`0 < p_real < 1`), usa e recalcula `p_real`/`p_vazia`. Nunca usa se a bala
já é dedutível por eliminação (evita desperdiçar item em informação que já
tem).

**Passo 3 — Calcula alvo pretendido:**
`p_vazia >= threshold_vazia_segura` → alvo = **si mesmo**. Senão → alvo =
**oponente**.

**Passo 4 — Itens condicionados ao alvo:**
- Alvo = si mesmo: usa Retirar munição se disponível e
  `p_real > (1 - threshold_vazia_segura)`; recalcula e volta ao Passo 3.
- Alvo = oponente: **nunca** usa Retirar munição (jogaria fora dano
  potencial); usa Dano dobrado se disponível e `p_real >= 85%`.
- Travar adversário: usa se disponível e `balas_restantes >= 2` — heurística
  declarada (ver nota).

**Passo 5 — Reavaliação final:** recalcula o alvo com toda informação
acumulada no turno e dispara.

**Nota sobre Travar:** calcular com exatidão a chance do efeito sobreviver
até a próxima recarga exigiria simular o comportamento futuro do jogador
humano (imprevisível por definição). A heurística `balas_restantes >= 2` é
uma simplificação intencional, não uma limitação não percebida.

---

## 9. Timers (turno e reconexão)

- **Timer de turno:** 1 minuto para o jogador conectado decidir e agir.
- **Timer de reconexão:** 2 minutos para um jogador que caiu da conexão
  voltar.
- Os dois são **timers independentes**, nunca somados.

**Comportamento por cenário:**

| Cenário | Comportamento |
|---|---|
| Jogador cai durante o **próprio turno** | Timer de turno pausa; timer de reconexão (2 min) começa. Ao reconectar, o timer de turno retoma de onde parou. |
| Jogador cai durante o turno do **oponente** (PvP) | Nada acontece imediatamente — o jogo mostra que ele desconectou, mas o oponente segue jogando normalmente. O timer de reconexão só começa quando chegar a vez de quem caiu (se ele ainda não tiver voltado). |
| Timer de reconexão esgota — **PvP** | Derrota automática de quem está desconectado. |
| Timer de reconexão esgota — **PvE** | Partida é **cancelada, sem vitória nem derrota** registrada — não há oponente humano sendo prejudicado pela espera. |

---

## 10. Ranking

- **Fórmula:** +1 ponto por vitória, −0.5 ponto por derrota.
- **Escopo:** conta **somente partidas PvP**. Partidas PvE são salvas
  normalmente no banco (histórico pessoal do jogador, ex: "vitórias na Fase
  3"), mas não entram na fórmula de pontos nem no piso de classificação.
- **Piso de classificação:** mínimo de 10 partidas PvP jogadas para entrar
  no ranking oficial. Abaixo disso, jogador aparece como "não classificado",
  com um contador visível de quantas partidas faltam.
- **Temporadas:** reset a cada 3 meses. Reset zerado — todos voltam a "não
  classificado" e precisam cumprir o piso de novo. Histórico da temporada
  anterior **não é mantido** (sobrescrito, sem tabela de snapshot).

---

## 11. Banco de dados

```
users
- id                SERIAL / BIGSERIAL (PK)
- username          VARCHAR(255) UNIQUE NOT NULL
- password_hash     TEXT NOT NULL
- created_at        TIMESTAMPTZ DEFAULT now()
- season_wins       INTEGER DEFAULT 0
- season_losses     INTEGER DEFAULT 0
- season_points     NUMERIC(6,1) DEFAULT 0   -- resetados a cada 3
  meses, só PvP (NUMERIC por causa do -0.5 por derrota, seção 10)
- total_wins        INTEGER DEFAULT 0        -- histórico vitalício
  (opcional)
- total_losses      INTEGER DEFAULT 0

matches
- id                SERIAL / BIGSERIAL (PK)
- mode              matches_mode ENUM (pvp | pve)
- phase_reached     INTEGER NULL             -- só PvE
- status            matches_status ENUM (in_progress | finished |
  abandoned | cancelled)
- started_at        TIMESTAMPTZ DEFAULT now()
- ended_at          TIMESTAMPTZ NULL

match_players
- id                SERIAL / BIGSERIAL (PK)
- match_id          BIGINT REFERENCES matches(id)
- user_id           BIGINT REFERENCES users(id) NULL -- null se for IA
- is_ai             BOOLEAN DEFAULT false
- final_lives       INTEGER
- result            match_result ENUM (win | loss | none)
  -- 'none' cobre PvE cancelado por timeout

match_player_items
- id                SERIAL / BIGSERIAL (PK)
- match_player_id   BIGINT REFERENCES match_players(id)
- item_type         item_type ENUM (ver_municao | retirar_municao |
  travar_adversario | curar | dano_dobrado)
- reload_number     INTEGER
- used_at           TIMESTAMPTZ NULL

match_events
- id                SERIAL / BIGSERIAL (PK)
- match_id          BIGINT REFERENCES matches(id)
- match_player_id   BIGINT REFERENCES match_players(id)
- event_type        event_type ENUM (shot_self | shot_opponent |
  use_item | reload | disconnect | reconnect | phase_change)
- payload           JSONB
- turn_number       INTEGER
- created_at        TIMESTAMPTZ DEFAULT now()
```
**Notas específicas do Postgres:**
- ENUMs viram tipos nativos (CREATE TYPE ... AS ENUM), não string
  solta como no MySQL — precisa criar o tipo antes de criar a tabela
  que o usa.
- payload passa de JSON pra JSONB: mesma função, mas indexável e
  consultável com operadores nativos (@>, ->>, etc), útil se algum dia
  precisar investigar disputa/bug filtrando por conteúdo do evento.
- TIMESTAMPTZ em vez de TIMESTAMP/DATETIME: guarda timezone, evita
  ambiguidade se o backend e o banco não estiverem no mesmo fuso
  (relevante pro timer de turno/reconexão da seção 9).

**Retenção de dados:**
- matches e match_players (resultado agregado) PERSISTEM
  INDEFINIDAMENTE — alimentam ranking (PvP) e histórico pessoal (PvE).
- match_player_items e match_events (log granular) EXPIRAM APÓS 7 DIAS
  da partida terminar. Em Postgres isso normalmente vira um job
  agendado (pg_cron ou cron externo rodando DELETE), já que não existe
  TTL nativo por linha como em alguns outros bancos — vale decidir
  isso quando chegar a hora de implementar, não é urgente agora.

---

## 12. Arquitetura de eventos (Socket.io)

Regra central: **informação sigilosa nunca é broadcast para a sala.**

- **Ver munição:** o resultado (real/vazia) é enviado via evento **privado**,
  só para o socket do jogador que usou o item. Os demais jogadores da sala
  recebem apenas a confirmação de que o item foi usado, sem o conteúdo.
- Qualquer item que revele informação só para quem usou segue essa mesma
  regra — broadcast normal é reservado para eventos públicos (turno passou,
  item usado sem revelar conteúdo, resultado de tiro, recarga, etc).

---

## 13. Estrutura do site

- Login / Cadastro
- Lobby
- Jogo
- Ranking

---

## 14. Ainda não decidido (por escolha consciente, não esquecimento)

- **Direção de arte visual** (cores, estilo, tema, animações do tiro) —
  adiado deliberadamente para depois do jogo estar funcional.

---

## 15. Ordem de desenvolvimento sugerida

1. Lógica do jogo em JavaScript (mecânica core da seção 5-7).
2. Backend: Node.js + Socket.io + PostgreSQL (schema da seção 11).
3. Árvore de decisão da IA (seção 8).
4. Integração cliente-servidor, respeitando a arquitetura de eventos
   (seção 12).
5. Visual 3D com Babylon.js.
6. Ranking, reconexão, modo PvE completo.
7. Direção de arte (seção 14).

---

## Resumo

Jogo 3D de estratégia, risco e probabilidade inspirado em Buckshot Roulette,
com modos PvP online e PvE, utilizando arquitetura de servidor autoritativo
para impedir trapaças.