-- Schema inicial: só "users", a parte que autenticação já consome de
-- verdade. matches / match_players / match_player_items / match_events
-- (seção 11 completa) entram quando o servidor começar a persistir
-- resultado de partida -- não faz sentido criar essas tabelas agora
-- sem nada que escreva nelas.

CREATE TABLE IF NOT EXISTS users (
  id              BIGSERIAL PRIMARY KEY,
  username        VARCHAR(255) UNIQUE NOT NULL,
  password_hash   TEXT NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT now(),
  season_wins     INTEGER DEFAULT 0,
  season_losses   INTEGER DEFAULT 0,
  season_points   NUMERIC(6,1) DEFAULT 0,
  total_wins      INTEGER DEFAULT 0,
  total_losses    INTEGER DEFAULT 0
);

-- username é case-insensitive na prática (ver server/db.js), mas o
-- UNIQUE acima é case-sensitive por padrão no Postgres -- normalizamos
-- pra lowercase antes de inserir/consultar, então a constraint já
-- basta sem precisar de um índice funcional extra.