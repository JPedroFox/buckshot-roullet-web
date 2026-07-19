'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const gameManager = require('./gameManager');
const pveManager = require('./pveManager');
const timers = require('./timers');
const authRoutes = require('./authRoutes');
const rankingRoutes = require('./rankingRoutes');
const { verifyToken } = require('./auth');
const { saveMatchResult, hasCompletedPveMatch } = require('./matchRepository');
const { applyAction, currentPlayerId, ACTION_USE_ITEM, ACTION_SHOOT } = require('../src/core/turn');
const { applyHumanActionOnly, runAiTurnsIfNeeded, advancePhase, PVE_PHASES } = require('../src/core/pve');

const PVP_CONFIG = { maxLives: 6, itemsPerReload: 4, mode: 'pvp' };

function createServer() {
  const app = express();
  const httpServer = http.createServer(app);
  const io = new Server(httpServer, { cors: { origin: '*' } });

  app.use(express.json());
  app.use('/auth', authRoutes);
  app.use('/ranking', rankingRoutes);
  app.use(express.static(require('path').join(__dirname, '..', 'public')));

  /**
   * Middleware de autenticação do Socket.io: TODA conexão precisa de um
   * JWT válido no handshake (`socket.handshake.auth.token`). A partir
   * daqui, `socket.data.username` é a identidade VERIFICADA do jogador
   * -- não é mais um campo que o cliente pode simplesmente declarar.
   * Isso fecha o bug de impersonation reportado (A conseguia "entrar"
   * como B só digitando o nome dele).
   */
  io.use((socket, next) => {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    if (!token) {
      return next(new Error('unauthorized: token ausente'));
    }
    try {
      const payload = verifyToken(token);
      socket.data.username = payload.username;
      socket.data.userId = payload.sub;
      next();
    } catch (err) {
      next(new Error('unauthorized: token inválido ou expirado'));
    }
  });

  // Fila de matchmaking ingênua: 1 jogador esperando por vez.
  // TODO v2: fila real, cancelamento de busca, timeout de matchmaking.
  let waitingSocket = null;

  function roomName(matchId) {
    return `match:${matchId}`;
  }

  function broadcastPublic(matchId, event, payload) {
    io.to(roomName(matchId)).emit(event, payload);
  }

  function sendPrivate(match, playerId, event, payload) {
    const socketId = match.sockets[playerId];
    if (socketId) {
      io.to(socketId).emit(event, payload);
    }
    // se socketId for null (desconectado), a informação privada simplesmente
    // não é entregue agora — não há fila de replay de eventos privados em v1.
  }

  function publicStateSnapshot(match) {
    // Snapshot seguro pra mandar pro cliente: NUNCA inclui a sequência
    // completa do chamber (seção 12) — só a contagem, que já é pública
    // por definição (seção 5: composição é conhecida em contagem por
    // todos assim que a recarga acontece).
    const { state } = match;
    const seq = state.chamber.sequencia;
    return {
      players: Object.fromEntries(
        Object.entries(state.players).map(([id, p]) => [
          id,
          { life: p.life, inventoryCount: p.inventory.length, skipNextTurn: p.skipNextTurn },
        ])
      ),
      chamberTotal: seq.length,
      chamberReal: seq.filter((b) => b === 'real').length,
      chamberVazia: seq.filter((b) => b === 'vazia').length,
      currentTurnPlayerId: currentPlayerId(state),
      gameOver: state.gameOver,
      winnerId: state.winnerId,
      reloadCount: state.reloadCount,
    };
  }

  function privateInventory(match, playerId) {
    return match.state.players[playerId].inventory;
  }

  /**
   * Manda pra CADA jogador da partida o snapshot atual e completo do
   * PRÓPRIO inventário, de forma privada. Sem isso, o cliente só sabe
   * quais itens tinha no match_found e nunca fica sabendo dos itens
   * novos distribuídos numa recarga (bug reportado: inventário aumenta
   * mas os itens novos não aparecem pra usar).
   */
  function syncInventories(matchId, match) {
    match.state.turnOrder.forEach((id) => {
      sendPrivate(match, id, 'inventory_update', { inventory: privateInventory(match, id) });
    });
  }

  /**
   * Snapshot seguro do estado de uma partida PvE, pro client. Mesma
   * regra de nunca vazar a sequência completa do chamber (seção 12) --
   * só contagens, que já são públicas por definição (seção 5). Como
   * PvE é 1 jogador só, não precisa distinguir "público" de "privado"
   * do jeito que PvP precisa -- tudo aqui já é só do próprio jogador.
   */
  function pveStateSnapshot(entry) {
    const { match } = entry;
    const seq = match.state.chamber.sequencia;
    return {
      phaseIndex: match.phaseIndex,
      totalPhases: PVE_PHASES.length,
      humanLife: match.state.players[match.humanId].life,
      aiLife: match.state.players[match.aiId].life,
      maxLives: match.state.maxLives,
      currentTurnPlayerId: currentPlayerId(match.state),
      humanId: match.humanId,
      chamberTotal: seq.length,
      chamberReal: seq.filter((b) => b === 'real').length,
      chamberVazia: seq.length - seq.filter((b) => b === 'real').length,
      reloadCount: match.state.reloadCount,
      phaseOver: match.state.gameOver, // a FASE atual terminou (pode ter mais fases)
      finished: match.finished, // a PARTIDA de PvE inteira terminou (todas as fases)
      result: match.result, // 'victory' | 'defeat' | null
    };
  }

  function scheduleTurnTimer(matchId, match) {
    timers.startTurnTimer(match, () => handleTurnTimeout(matchId));
    broadcastPublic(matchId, 'turn_timer_started', {
      playerId: currentPlayerId(match.state),
      deadline: timers.getTurnTimerDeadline(match),
    });
  }

  /**
   * Comportamento de fallback quando o timer de turno esgota com o
   * jogador CONECTADO. O documento de design não define essa regra
   * explicitamente (seção 9 só cobre timer de reconexão) — decisão
   * assumida aqui: dispara automaticamente no oponente. PRECISA ser
   * validada/confirmada; troque essa função se a regra real for outra
   * (ex: derrota automática, passar o turno sem ação, etc).
   */
  function handleTurnTimeout(matchId) {
    const match = gameManager.getMatch(matchId);
    if (!match || match.state.gameOver) return;

    const playerId = currentPlayerId(match.state);
    try {
      const { publicEvent, privateEvent } = applyAction(match.state, {
        type: ACTION_SHOOT,
        playerId,
        target: 'opponent',
      });
      broadcastPublic(matchId, 'shot_resolved', publicEvent);
      if (privateEvent) sendPrivate(match, playerId, 'item_result', privateEvent);
      syncInventories(matchId, match);
      afterAction(matchId, match);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('handleTurnTimeout error:', err);
    }
  }

  /**
   * Salva o resultado no banco (seção 11) quando a partida termina.
   * `match.persisted` é marcado de forma SÍNCRONA antes de qualquer
   * await, pra evitar salvar duas vezes se essa função for chamada mais
   * de uma vez (defensivo -- não deveria acontecer no fluxo normal).
   * Falha ao persistir NÃO derruba o jogo: os jogadores já viram o
   * resultado via 'match_ended', a falha fica só logada no servidor.
   */
  function persistMatchIfNeeded(matchId, match, status) {
    if (match.persisted) return;
    match.persisted = true;

    const players = match.state.turnOrder.map((playerId) => ({
      userId: match.userIds[playerId],
      finalLives: match.state.players[playerId].life,
      result: playerId === match.state.winnerId ? 'win' : 'loss',
    }));

    saveMatchResult({ mode: 'pvp', status, players }).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`falha ao persistir resultado da partida ${matchId}:`, err);
    });
  }

  function scheduleReconnectTimer(matchId, match, playerId) {
    timers.startReconnectTimer(match, () => handleReconnectTimeout(matchId));
    broadcastPublic(matchId, 'reconnect_timer_started', {
      playerId,
      deadline: timers.getReconnectTimerDeadline(match),
    });
  }

  function afterAction(matchId, match) {
    broadcastPublic(matchId, 'state_update', publicStateSnapshot(match));

    if (match.state.gameOver) {
      timers.clearTurnTimer(match);
      timers.clearReconnectTimer(match);
      persistMatchIfNeeded(matchId, match, 'finished');
      broadcastPublic(matchId, 'match_ended', {
        winnerId: match.state.winnerId,
        reason: 'victory',
      });
      return;
    }

    const nextPlayerId = currentPlayerId(match.state);
    const nextSocketId = match.sockets[nextPlayerId];

    if (!nextSocketId) {
      // é a vez de quem está desconectado — começa o timer de reconexão
      // (seção 9: "só começa quando chegar a vez de quem caiu")
      scheduleReconnectTimer(matchId, match, nextPlayerId);
    } else {
      scheduleTurnTimer(matchId, match);
    }
  }

  function handleReconnectTimeout(matchId) {
    const match = gameManager.getMatch(matchId);
    if (!match || match.state.gameOver) return;

    const disconnectedPlayerId = currentPlayerId(match.state);
    const winnerId = Object.keys(match.state.players).find((id) => id !== disconnectedPlayerId);

    match.state.gameOver = true;
    match.state.winnerId = winnerId;
    timers.clearTurnTimer(match);
    timers.clearReconnectTimer(match);
    persistMatchIfNeeded(matchId, match, 'abandoned');

    broadcastPublic(matchId, 'match_ended', {
      winnerId,
      reason: 'opponent_disconnected',
    });
  }

  function doRejoin(socket, matchId, match, playerId) {
    gameManager.setSocket(matchId, playerId, socket.id);
    socket.join(roomName(matchId));
    timers.clearReconnectTimer(match);

    socket.emit('rejoined', {
      matchId,
      yourPlayerId: playerId,
      inventory: privateInventory(match, playerId),
      state: publicStateSnapshot(match),
      // Cobre o caso de reconectar no meio do turno do OPONENTE: sem
      // isso, o timer já rodando só aparece pro reconectado na próxima
      // troca de turno, porque o broadcast normal só dispara quando o
      // timer é (re)iniciado, não quando alguém entra depois.
      activeTurnTimerDeadline: timers.getTurnTimerDeadline(match),
      activeTurnTimerPlayerId: currentPlayerId(match.state),
    });
    broadcastPublic(matchId, 'opponent_reconnected', { playerId });

    if (currentPlayerId(match.state) === playerId) {
      // retoma o timer de turno de onde parou (seção 9)
      timers.resumeTurnTimer(match, () => handleTurnTimeout(matchId));
      broadcastPublic(matchId, 'turn_timer_started', {
        playerId,
        deadline: timers.getTurnTimerDeadline(match),
      });
    }
  }

  io.on('connection', (socket) => {
    socket.on('find_match', async () => {
      // playerId NUNCA vem do payload do cliente -- vem só do token
      // verificado no handshake (io.use acima). É isso que impede o
      // bug de impersonation reportado.
      const playerId = socket.data.username;

      // Caso 1: esse usuário já está numa partida em andamento -> reconexão,
      // não matchmaking novo. Resolve o bug de "recarreguei a página e
      // não voltei pra minha partida". Reconectar sempre é permitido,
      // mesmo que o tutorial de PvE não tenha sido completado (não faz
      // sentido travar quem já está no meio de uma partida).
      const active = gameManager.findActiveMatchByPlayerId(playerId);
      if (active) {
        return doRejoin(socket, active.matchId, active.match, playerId);
      }

      // Bloqueio de tutorial: só libera matchmaking NOVO depois de VENCER
      // pelo menos 1 partida de PvE (as 3 fases, não basta jogar e
      // perder). Verificação no SERVIDOR, não só no client -- senão
      // é só chamar o evento direto pelo console do navegador.
      const pveDone = await hasCompletedPveMatch(socket.data.userId);
      if (!pveDone) {
        return socket.emit(
          'error_msg',
          'Vença uma partida de PvE (as 3 fases) primeiro antes de jogar PvP.'
        );
      }

      // Caso 2: o MESMO usuário autenticado já está na fila esperando
      // (ex: abriu duas abas) -> rejeita a segunda tentativa.
      if (waitingSocket && waitingSocket.playerId === playerId) {
        return socket.emit('error_msg', 'Você já está esperando por uma partida em outra aba/conexão.');
      }

      if (!waitingSocket) {
        waitingSocket = { socket, playerId, userId: socket.data.userId };
        socket.emit('waiting_for_opponent');
        return;
      }

      // Emparelha com quem já estava esperando.
      const p1 = waitingSocket;
      const p2 = { socket, playerId, userId: socket.data.userId };
      waitingSocket = null;

      const matchId = gameManager.createMatch(PVP_CONFIG, [p1.playerId, p2.playerId]);
      const match = gameManager.getMatch(matchId);

      gameManager.setSocket(matchId, p1.playerId, p1.socket.id);
      gameManager.setSocket(matchId, p2.playerId, p2.socket.id);
      gameManager.setUserId(matchId, p1.playerId, p1.userId);
      gameManager.setUserId(matchId, p2.playerId, p2.userId);

      p1.socket.join(roomName(matchId));
      p2.socket.join(roomName(matchId));

      [p1, p2].forEach(({ socket: s, playerId: id }) => {
        s.emit('match_found', {
          matchId,
          yourPlayerId: id,
          inventory: privateInventory(match, id),
        });
      });

      broadcastPublic(matchId, 'state_update', publicStateSnapshot(match));
      scheduleTurnTimer(matchId, match);
    });

    socket.on('use_item', ({ matchId, itemType }) => {
      const playerId = socket.data.username; // identidade verificada, não vem do payload
      const match = gameManager.getMatch(matchId);
      if (!match) return socket.emit('error_msg', 'partida não encontrada');

      try {
        const { publicEvent, privateEvent } = applyAction(match.state, {
          type: ACTION_USE_ITEM,
          playerId,
          itemType,
        });
        broadcastPublic(matchId, 'item_used', publicEvent);
        if (privateEvent) sendPrivate(match, playerId, 'item_result', privateEvent);
        syncInventories(matchId, match); // cobre recarga disparada por "Retirar munição"
        broadcastPublic(matchId, 'state_update', publicStateSnapshot(match));
        // use_item não passa o turno nem mexe nos timers (seção 4).
      } catch (err) {
        socket.emit('error_msg', err.message);
      }
    });

    socket.on('shoot', ({ matchId, target }) => {
      const playerId = socket.data.username; // identidade verificada, não vem do payload
      const match = gameManager.getMatch(matchId);
      if (!match) return socket.emit('error_msg', 'partida não encontrada');

      try {
        timers.clearTurnTimer(match); // jogador agiu a tempo
        const { publicEvent, privateEvent } = applyAction(match.state, {
          type: ACTION_SHOOT,
          playerId,
          target,
        });
        broadcastPublic(matchId, 'shot_resolved', publicEvent);
        if (privateEvent) sendPrivate(match, playerId, 'item_result', privateEvent);
        syncInventories(matchId, match); // cobre recarga disparada por chamber vazio
        afterAction(matchId, match);
      } catch (err) {
        socket.emit('error_msg', err.message);
      }
    });

    socket.on('rejoin_match', ({ matchId }) => {
      const playerId = socket.data.username; // identidade verificada, não vem do payload
      const match = gameManager.getMatch(matchId);
      if (!match) return socket.emit('error_msg', 'partida não encontrada');
      if (!(playerId in match.sockets)) return socket.emit('error_msg', 'você não pertence a essa partida');
      doRejoin(socket, matchId, match, playerId);
    });

    // -----------------------------------------------------------------
    // PVE -- eventos separados dos de PvP, mesmo prefixo "pve_" pra não
    // ter dúvida nenhuma no client sobre qual modo cada evento é.
    // -----------------------------------------------------------------

    // Pausa proposital entre "a fase acabou" e "a fase nova está de pé",
    // pra dar tempo do jogador perceber a virada (vida zerada de quem
    // perdeu, recarga acontecendo) antes da tela pular pro estado novo.
    const PHASE_TRANSITION_DELAY_MS = 2500;
    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function schedulePveTurnTimer(matchId, entry) {
      timers.startTurnTimer(entry, () => handlePveTurnTimeout(matchId, entry));
      io.to(entry.socketId).emit('pve_turn_timer_started', {
        deadline: timers.getTurnTimerDeadline(entry),
      });
    }

    function handlePveTurnTimeout(matchId, entry) {
      if (entry.match.finished || entry.match.state.gameOver) return;
      if (currentPlayerId(entry.match.state) !== entry.humanId) return; // segurança, não deveria acontecer
      handlePveAction(matchId, entry, { type: ACTION_SHOOT, target: 'opponent' }).catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`erro no timeout de turno PvE ${matchId}:`, err);
      });
    }

    /**
     * Salva o resultado no banco quando a partida de PvE termina (por
     * vitória/derrota) ou é cancelada (desconexão). `entry.persisted`
     * evita salvar duas vezes. Nunca mexe em season_wins/season_losses/
     * total_wins/total_losses de users
     * -- PvE não conta pro ranking (seção 10).
     */
    function pvePersistIfNeeded(matchId, entry, status) {
      if (entry.persisted) return;
      entry.persisted = true;

      const { match } = entry;
      const humanLife = match.state.players[match.humanId].life;
      const aiLife = match.state.players[match.aiId].life;
      const phaseReached = match.phaseIndex + 1;

      let humanResult = 'none';
      let aiResult = 'none';
      if (status === 'finished') {
        humanResult = match.result === 'victory' ? 'win' : 'loss';
        aiResult = match.result === 'victory' ? 'loss' : 'win';
      }

      saveMatchResult({
        mode: 'pve',
        status,
        phaseReached,
        players: [
          { userId: entry.userId, finalLives: humanLife, result: humanResult, isAi: false },
          { userId: null, finalLives: aiLife, result: aiResult, isAi: true },
        ],
      }).catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`falha ao persistir resultado da partida PvE ${matchId}:`, err);
      });
    }

    socket.on('pve_start', () => {
      const humanId = socket.data.username; // identidade verificada, não vem do payload
      const userId = socket.data.userId;

      const active = pveManager.findActiveMatchByHumanId(humanId);
      if (active) {
        pveManager.setSocketId(active.matchId, socket.id);
        socket.emit('pve_started', {
          matchId: active.matchId,
          inventory: active.entry.match.state.players[humanId].inventory,
          snapshot: pveStateSnapshot(active.entry),
        });
        if (currentPlayerId(active.entry.match.state) === humanId) {
          schedulePveTurnTimer(active.matchId, active.entry);
        }
        return;
      }

      const matchId = pveManager.createMatch(humanId, userId, socket.id);
      const entry = pveManager.getMatch(matchId);
      socket.emit('pve_started', {
        matchId,
        inventory: entry.match.state.players[humanId].inventory,
        snapshot: pveStateSnapshot(entry),
      });
      schedulePveTurnTimer(matchId, entry); // humano sempre começa (seção 3)
    });

    /**
     * Compartilhado entre pve_use_item, pve_shoot e o timeout de turno.
     * Emite a ação do humano IMEDIATAMENTE (feedback instantâneo pro
     * próprio jogador), e só depois deixa a IA "pensar" e agir -- cada
     * ação dela chega ao vivo via 'pve_ai_event', com as pausas
     * simuladas em ai.js, em vez de tudo aparecer de uma vez no final
     * do turno.
     *
     * Se a fase terminar (por ação do humano OU da IA), NÃO avança pra
     * fase seguinte na hora -- espera PHASE_TRANSITION_DELAY_MS com o
     * estado "congelado" no fim da fase, só então chama advancePhase()
     * e manda o snapshot da fase nova (ou do fim de partida). Se a
     * partida de PvE inteira terminar, persiste o resultado.
     */
    async function handlePveAction(matchId, entry, action) {
      const humanId = entry.humanId;
      timers.clearTurnTimer(entry); // o jogador agiu a tempo

      const { result, phaseIndexBefore } = applyHumanActionOnly(entry.match, action);

      io.to(entry.socketId).emit('pve_human_event', {
        humanEvent: result.publicEvent,
        humanPrivateEvent: result.privateEvent,
        inventory: entry.match.state.players[humanId].inventory,
        snapshot: pveStateSnapshot(entry),
      });

      let aiEvents = [];
      if (!entry.match.state.gameOver) {
        aiEvents = await runAiTurnsIfNeeded(entry.match, (aiEvent) => {
          io.to(entry.socketId).emit('pve_ai_event', {
            event: aiEvent,
            inventory: entry.match.state.players[humanId].inventory,
            snapshot: pveStateSnapshot(entry),
          });
        });
      }

      if (entry.match.state.gameOver) {
        // fase (ou partida inteira) terminou -- segura aqui, com o
        // snapshot ainda mostrando o estado de FIM DE FASE (vida
        // zerada de quem perdeu), antes de avançar de verdade.
        await sleep(PHASE_TRANSITION_DELAY_MS);
        advancePhase(entry.match);
        if (entry.match.finished) {
          pvePersistIfNeeded(matchId, entry, 'finished');
        }
      }

      io.to(entry.socketId).emit('pve_update', {
        aiEvents,
        phaseChanged: entry.match.phaseIndex !== phaseIndexBefore,
        inventory: entry.match.finished ? [] : entry.match.state.players[humanId].inventory,
        snapshot: pveStateSnapshot(entry),
      });

      const isHumanTurnNow =
        !entry.match.finished &&
        !entry.match.state.gameOver &&
        currentPlayerId(entry.match.state) === humanId;
      if (isHumanTurnNow) {
        schedulePveTurnTimer(matchId, entry);
      }
    }

    socket.on('pve_use_item', async ({ matchId, itemType }) => {
      const humanId = socket.data.username;
      const entry = pveManager.getMatch(matchId);
      if (!entry) return socket.emit('error_msg', 'partida não encontrada');
      if (entry.humanId !== humanId) return socket.emit('error_msg', 'você não pertence a essa partida');

      try {
        await handlePveAction(matchId, entry, { type: ACTION_USE_ITEM, itemType });
      } catch (err) {
        socket.emit('error_msg', err.message);
      }
    });

    socket.on('pve_shoot', async ({ matchId, target }) => {
      const humanId = socket.data.username;
      const entry = pveManager.getMatch(matchId);
      if (!entry) return socket.emit('error_msg', 'partida não encontrada');
      if (entry.humanId !== humanId) return socket.emit('error_msg', 'você não pertence a essa partida');

      try {
        await handlePveAction(matchId, entry, { type: ACTION_SHOOT, target });
      } catch (err) {
        socket.emit('error_msg', err.message);
      }
    });

    socket.on('disconnect', () => {
      if (waitingSocket && waitingSocket.socket.id === socket.id) {
        waitingSocket = null;
        return;
      }

      const found = gameManager.findBySocketId(socket.id);
      if (found) {
        const { matchId, playerId, match } = found;
        if (!match.state.gameOver) {
          match.sockets[playerId] = null;
          broadcastPublic(matchId, 'opponent_disconnected', { playerId });

          const isTheirTurn = currentPlayerId(match.state) === playerId;
          if (isTheirTurn) {
            // caiu no PRÓPRIO turno: pausa timer de turno, inicia reconexão
            timers.pauseTurnTimer(match);
            scheduleReconnectTimer(matchId, match, playerId);
          }
          // caiu no turno do oponente: não faz nada agora (seção 9) —
          // o timer de reconexão só começa quando chegar a vez dele,
          // isso é tratado em afterAction().
        }
        return;
      }

      // PvE: cair (ou sair, já que navegar pra outra página também
      // derruba o socket) cancela a fase NA HORA, sem espera de
      // reconexão -- diferente de PvP. Seção 9 original previa isso
      // pro timeout de reconexão de PvE; aqui simplificamos pra não
      // ter timeout nenhum: sair já cancela direto.
      const foundPve = pveManager.findBySocketId(socket.id);
      if (foundPve) {
        const { matchId, entry } = foundPve;
        if (!entry.match.finished) {
          timers.clearTurnTimer(entry);
          entry.match.finished = true; // trava a partida, ninguém mais pode agir nela
          pvePersistIfNeeded(matchId, entry, 'cancelled');
        }
      }
    });
  });

  return { app, httpServer, io };
}

if (require.main === module) {
  const { httpServer } = createServer();
  const PORT = process.env.PORT || 3000;
  httpServer.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Servidor rodando na porta ${PORT}`);
  });
}

module.exports = { createServer };
