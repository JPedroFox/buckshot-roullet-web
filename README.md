# Jogo 3D no Navegador — Inspirado em Buckshot Roulette

Projeto pessoal de estudo e portfólio: um jogo 3D multiplayer no navegador em que dois jogadores (ou um jogador contra a IA) se enfrentam com uma arma carregada com munições aleatórias. Objetivo: eliminar o adversário antes de morrer.

> Status: mecânica, arquitetura de servidor, IA e schema de banco totalmente definidos. Único ponto em aberto é a direção de arte visual (ver seção "Roadmap").

---

## Sumário

- [Stack](#stack)
- [Arquitetura](#arquitetura)
- [Modos de jogo](#modos-de-jogo)
- [Turno](#turno)
- [Munição](#munição)
- [Resultado do tiro](#resultado-do-tiro)
- [Itens](#itens)
- [Inteligência artificial (PvE)](#inteligência-artificial-pve)
- [Timers e reconexão](#timers-e-reconexão)
- [Ranking](#ranking)
- [Banco de dados](#banco-de-dados)
- [Arquitetura de eventos (Socket.io)](#arquitetura-de-eventos-socketio)
- [Estrutura do site](#estrutura-do-site)
- [Roadmap](#roadmap)
- [Ordem de desenvolvimento sugerida](#ordem-de-desenvolvimento-sugerida)

---

## Stack

| Camada          | Tecnologia            |
|-----------------|------------------------|
| Interface       | HTML + CSS             |
| Cliente         | JavaScript             |
| Gráficos 3D     | Babylon.js             |
| Backend         | Node.js + Express (render.com) |
| Multiplayer     | Socket.io              |
| Banco de dados  | PostgreSQL             |

## Arquitetura

- **Servidor autoritativo**: todo o cálculo da partida acontece no backend.
- O cliente apenas envia ações; nunca decide resultados.
- Informações sigilosas (ex.: resultado de "Ver munição") nunca são transmitidas para toda a sala — apenas para o jogador que tem direito a elas (detalhes na seção [Arquitetura de eventos](#arquitetura-de-eventos-socketio)).

## Modos de jogo

### PvP

- 2 jogadores online, 1 fase única.
- 6 vidas para cada jogador.
- 4 itens distribuídos a cada recarga da arma.
- Ordem de turno sorteada apenas no início da partida; a partir daí segue alternância normal (não é resorteada a cada recarga).

### PvE

| Fase | Vidas | Itens por recarga |
|------|-------|--------------------|
| 1    | 2     | 0                  |
| 2    | 4     | 2                  |
| 3    | 6     | 4                  |

- O jogador humano sempre começa — no início da fase e em toda recarga dentro da mesma fase.
- Ao iniciar uma nova fase: vida volta ao máximo, jogador começa a fase, inventário é esvaziado e efeitos ativos são cancelados.

## Turno

Durante seu turno, o jogador pode:

1. Usar quantos itens quiser.
2. Pegar a arma.
3. Escolher entre atirar em si mesmo ou no adversário.

Depois de pegar a arma, não é mais possível usar itens. O turno tem 1 minuto para decisão e ação (ver [Timers](#timers-e-reconexão)).

## Munição

- A arma é recarregada com **2 a 8 balas** (quantidade aleatória a cada recarga).
- Garantia mínima: ao menos 1 bala real e 1 bala vazia por recarga.
- As balas restantes seguem distribuição de **70% real / 30% vazia**.
- A composição final (ex.: "5 balas: 4 reais, 1 vazia") é fixa e conhecida em contagem por todos os jogadores assim que a recarga acontece — não há novo sorteio a cada disparo. Cada bala disparada ou removida sai desse total sem reposição.
- No cliente de teste manual, a composição é exibida como preview estático por 5 segundos logo após a recarga e depois some por completo (inclusive o total de balas restantes), para manter a tensão. Essa é uma escolha de UX do cliente de teste — o servidor sempre tem a contagem completa, já que ela é pública por definição.

> **Nota de design:** a proporção 70/30 (originalmente 30/70) foi invertida para acelerar o ritmo de jogo, que estava lento demais. Essa mudança reduz o valor estratégico de "atirar em si mesmo" e enfraquece itens de informação como "Ver munição" e "Retirar munição". É uma troca consciente entre partidas mais rápidas/brutais e profundidade de decisão — ainda não validada como ponto ótimo, sujeita a revisão após mais playtesting.

## Resultado do tiro

**Bala real**
- Causa 1 ponto de dano (2 se "Dano dobrado" estiver ativo).
- Jogador perde vida.
- Turno termina.

**Bala vazia**
- Se atirar em si mesmo: joga um turno novo.
- Se atirar no adversário: turno termina.

Quando todas as munições acabam, a arma é recarregada.

## Itens

Distribuição aleatória e uniforme entre os 5 tipos (mesma chance para cada um, podendo repetir).

Regras gerais: máximo de 8 itens no inventário, todos consumíveis, podem ser usados em conjunto no mesmo turno, visíveis para ambos os jogadores, desaparecem após o uso. No PvE, o inventário é zerado ao trocar de fase.

| Item | Efeito |
|------|--------|
| Ver munição | Revela apenas para quem usou se a bala atual é real ou vazia. Não remove a bala. |
| Retirar munição | Remove a bala atual da câmara. Todos sabem se era real ou vazia. |
| Travar adversário | Adversário perde o próximo turno. Não acumula. Efeito é cancelado se houver troca de fase (PvE) ou recarga da arma (PvP) antes de ser aplicado. |
| Curar | Recupera 1 ponto de vida, sem ultrapassar o máximo. |
| Dano dobrado | Dobra o dano do próximo disparo (1 → 2). Funciona em qualquer alvo. Termina após o tiro. |

## Inteligência artificial (PvE)

Abordagem: **árvore de decisão com pesos (heurística)**. A IA joga "cega", como um jogador humano jogaria — usa apenas informação pública (composição conhecida do pente, balas já reveladas/removidas, próprio inventário e histórico de ações do turno).

**Estado observado no início do turno:**
- `vida_ia`, `vida_oponente`, `vida_maxima_da_fase`
- `balas_restantes`, `reais_restantes`, `vazias_restantes`
- `p_real = reais_restantes / balas_restantes`, `p_vazia = 1 - p_real`
- inventário da IA

**Passo 0 — Thresholds** (calculados com a vida do início do turno, antes de qualquer cura)
- `modo_cauteloso = vida_ia <= 3` (a Fase 1 vive sempre nesse modo)
- `threshold_vazia_segura` = 85% se cauteloso, senão 50%
- `threshold_real_dano_dobrado` = 85%

**Passo 1 — Curar**: se disponível e `vida_ia <= vida_maxima_da_fase / 2`, usa Curar.

**Passo 2 — Ver munição**: se disponível e ainda há incerteza real (`0 < p_real < 1`), usa o item e recalcula as probabilidades. Nunca usado se a bala já é dedutível por eliminação.

**Passo 3 — Calcula alvo pretendido**: se `p_vazia >= threshold_vazia_segura`, alvo = si mesmo; senão, alvo = oponente.

**Passo 4 — Itens condicionados ao alvo:**
- Alvo = si mesmo: usa Retirar munição se disponível e `p_real > (1 - threshold_vazia_segura)`, depois recalcula e volta ao Passo 3.
- Alvo = oponente: nunca usa Retirar munição; usa Dano dobrado se disponível e `p_real >= 85%`.
- Travar adversário: usado se disponível e `balas_restantes >= 2` (heurística simplificada e intencional).

**Passo 5 — Reavaliação final**: recalcula o alvo pretendido com toda a informação acumulada no turno e dispara.

## Timers e reconexão

- **Timer de turno**: 1 minuto. Se esgotado, fallback automático (atira no oponente).
- **Timer de reconexão**: 2 minutos para o jogador desconectado voltar.
- Os dois timers são independentes, nunca somados.

| Cenário | Comportamento |
|---------|----------------|
| Cai durante o próprio turno | Timer de turno pausa; timer de reconexão (2 min) inicia. Ao reconectar, o timer de turno retoma de onde parou. |
| Cai durante o turno do oponente (PvP) | Nada acontece de imediato; o oponente segue jogando. O timer de reconexão só começa quando chegar a vez de quem caiu. |
| Timer de reconexão esgota (PvP) | Derrota automática do jogador desconectado. |
| Timer de reconexão esgota (PvE) | Partida cancelada, sem vitória nem derrota registrada. |

## Ranking

- Fórmula: **+1 ponto por vitória, −0.5 ponto por derrota**.
- Escopo: apenas partidas **PvP** contam para o ranking. Partidas PvE são salvas no histórico pessoal, mas não entram na pontuação nem no piso de classificação.
- Piso de classificação: mínimo de 10 partidas PvP jogadas. Abaixo disso, o jogador aparece como "não classificado", com contador de partidas faltantes.
- Temporadas: reset a cada 3 meses. O reset zera todos para "não classificado"; o histórico da temporada anterior não é mantido.

## Banco de dados

PostgreSQL. Estrutura principal:

- **users** — dados de conta, pontuação e histórico agregado da temporada e vitalício.
- **matches** — cada partida, com modo (`pvp`/`pve`), fase alcançada (PvE) e status.
- **match_players** — participantes de cada partida (humano ou IA), vidas finais e resultado.
- **match_player_items** — itens usados por jogador, por recarga.
- **match_events** — log granular de eventos (tiros, itens, recargas, desconexões, troca de fase), com payload em `JSONB`.

**Retenção de dados:**
- `matches` e `match_players` (resultado agregado) persistem indefinidamente — alimentam ranking e histórico pessoal.
- `match_player_items` e `match_events` (log granular) expiram 7 dias após o fim da partida.

**Notas específicas do Postgres:**
- Enums são tipos nativos (`CREATE TYPE ... AS ENUM`), criados antes das tabelas que os usam.
- Campos de payload usam `JSONB` (indexável e consultável via `@>`, `->>`, etc.).
- Uso de `TIMESTAMPTZ` para evitar ambiguidade de fuso horário entre backend e banco, relevante para os timers de turno/reconexão.

## Arquitetura de eventos (Socket.io)

Regra central: **informação sigilosa nunca é transmitida para a sala inteira.**

- "Ver munição": o resultado é enviado via evento privado, apenas para o socket de quem usou o item. Os demais jogadores recebem só a confirmação de que o item foi usado, sem o conteúdo.
- Qualquer item que revele informação exclusiva ao usuário segue a mesma regra. Broadcast normal fica reservado a eventos públicos (turno passou, item usado sem revelar conteúdo, resultado de tiro, recarga, etc.).

## Estrutura do site

- Login / Cadastro
- Lobby
- Jogo
- Ranking

## Roadmap

- **Direção de arte visual** (cores, estilo, tema, animações do tiro) — adiada deliberadamente para depois do jogo estar funcional.

## Ordem de desenvolvimento sugerida

1. Lógica do jogo em JavaScript (mecânica core: munição, turnos, itens).
2. Backend: Node.js + Socket.io + PostgreSQL.
3. Árvore de decisão da IA.
4. Integração cliente-servidor, respeitando a arquitetura de eventos.
5. Visual 3D com Babylon.js.
6. Ranking, reconexão e modo PvE completo.
7. Direção de arte.

---

Jogo de estratégia, risco e probabilidade inspirado em Buckshot Roulette, com modos PvP online e PvE, usando arquitetura de servidor autoritativo para impedir trapaças.