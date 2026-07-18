'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const gameManager = require('./gameManager');
const timers = require('./timers');
const authRoutes = require('./authRoutes');
const { verifyToken } = require('./auth');
const { applyAction, currentPlayerId, ACTION_USE_ITEM, ACTION_SHOOT } = require('../src/core/turn');

const PVP_CONFIG = { maxLives: 6, itemsPerReload: 4, mode: 'pvp' };

function createServer() {
  const app = express();
  const httpServer = http.createServer(app);
  const io = new Server(httpServer, { cors: { origin: '*' } });

  app.use(express.json());
  app.use('/auth', authRoutes);
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

  function scheduleTurnTimer(matchId, match) {
    timers.startTurnTimer(match, () => handleTurnTimeout(matchId));
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

  function afterAction(matchId, match) {
    broadcastPublic(matchId, 'state_update', publicStateSnapshot(match));

    if (match.state.gameOver) {
      timers.clearTurnTimer(match);
      timers.clearReconnectTimer(match);
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
      timers.startReconnectTimer(match, () => handleReconnectTimeout(matchId));
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
    });
    broadcastPublic(matchId, 'opponent_reconnected', { playerId });

    if (currentPlayerId(match.state) === playerId) {
      // retoma o timer de turno de onde parou (seção 9)
      timers.resumeTurnTimer(match, () => handleTurnTimeout(matchId));
    }
  }

  io.on('connection', (socket) => {
    socket.on('find_match', () => {
      // playerId NUNCA vem do payload do cliente -- vem só do token
      // verificado no handshake (io.use acima). É isso que impede o
      // bug de impersonation reportado.
      const playerId = socket.data.username;

      // Caso 1: esse usuário já está numa partida em andamento -> reconexão,
      // não matchmaking novo. Resolve o bug de "recarreguei a página e
      // não voltei pra minha partida".
      const active = gameManager.findActiveMatchByPlayerId(playerId);
      if (active) {
        return doRejoin(socket, active.matchId, active.match, playerId);
      }

      // Caso 2: o MESMO usuário autenticado já está na fila esperando
      // (ex: abriu duas abas) -> rejeita a segunda tentativa.
      if (waitingSocket && waitingSocket.playerId === playerId) {
        return socket.emit('error_msg', 'Você já está esperando por uma partida em outra aba/conexão.');
      }

      if (!waitingSocket) {
        waitingSocket = { socket, playerId };
        socket.emit('waiting_for_opponent');
        return;
      }

      // Emparelha com quem já estava esperando.
      const p1 = waitingSocket;
      const p2 = { socket, playerId };
      waitingSocket = null;

      const matchId = gameManager.createMatch(PVP_CONFIG, [p1.playerId, p2.playerId]);
      const match = gameManager.getMatch(matchId);

      gameManager.setSocket(matchId, p1.playerId, p1.socket.id);
      gameManager.setSocket(matchId, p2.playerId, p2.socket.id);

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

    socket.on('disconnect', () => {
      if (waitingSocket && waitingSocket.socket.id === socket.id) {
        waitingSocket = null;
        return;
      }

      const found = gameManager.findBySocketId(socket.id);
      if (!found) return;
      const { matchId, playerId, match } = found;
      if (match.state.gameOver) return;

      match.sockets[playerId] = null;
      broadcastPublic(matchId, 'opponent_disconnected', { playerId });

      const isTheirTurn = currentPlayerId(match.state) === playerId;
      if (isTheirTurn) {
        // caiu no PRÓPRIO turno: pausa timer de turno, inicia reconexão
        timers.pauseTurnTimer(match);
        timers.startReconnectTimer(match, () => handleReconnectTimeout(matchId));
      }
      // caiu no turno do oponente: não faz nada agora (seção 9) —
      // o timer de reconexão só começa quando chegar a vez dele,
      // isso é tratado em afterAction().
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
