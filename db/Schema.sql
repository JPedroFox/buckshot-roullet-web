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

-- ---------------------------------------------------------------------
-- A partir daqui: tabelas que passam a ter consumidor real assim que o
-- servidor persiste resultado de partida (seção 11 do design).
-- match_player_items e match_events (log granular) ficam pra depois --
-- ainda não há nada gravando neles.
-- ---------------------------------------------------------------------

-- Postgres não tem "CREATE TYPE IF NOT EXISTS" nativo -- o bloco DO
-- abaixo é o jeito idiomático de tornar a criação do enum idempotente
-- (não quebra se você rodar esse arquivo de novo por engano).
DO $$ BEGIN
  CREATE TYPE matches_mode AS ENUM ('pvp', 'pve');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE matches_status AS ENUM ('in_progress', 'finished', 'abandoned', 'cancelled');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE match_result AS ENUM ('win', 'loss', 'none');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS matches (
  id              BIGSERIAL PRIMARY KEY,
  mode            matches_mode NOT NULL,
  phase_reached   INTEGER NULL,          -- só PvE, sempre NULL por enquanto
  status          matches_status NOT NULL DEFAULT 'in_progress',
  started_at      TIMESTAMPTZ DEFAULT now(),
  ended_at        TIMESTAMPTZ NULL
);

CREATE TABLE IF NOT EXISTS match_players (
  id              BIGSERIAL PRIMARY KEY,
  match_id        BIGINT REFERENCES matches(id),
  user_id         BIGINT REFERENCES users(id) NULL, -- NULL se for IA (PvE, futuro)
  is_ai           BOOLEAN DEFAULT false,
  final_lives     INTEGER,
  result          match_result NOT NULL DEFAULT 'none'
);

-- Tabela genérica de configuração da aplicação -- por enquanto só
-- guarda quando a temporada atual de ranking começou (seção 10), pra
-- eventualmente dar suporte a reset automático a cada 3 meses. Hoje o
-- reset é manual (ver server/rankingRoutes.js), então essa data só
-- serve pra referência/exibição.
CREATE TABLE IF NOT EXISTS app_settings (
  key     TEXT PRIMARY KEY,
  value   TEXT
);

INSERT INTO app_settings (key, value)
VALUES ('season_started_at', now()::text)
ON CONFLICT (key) DO NOTHING;


