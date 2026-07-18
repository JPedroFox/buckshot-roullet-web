'use strict';

const { Pool } = require('pg');

// Em teste, usa um banco separado (buckshot_test) pra nunca sujar/depender
// dos dados de desenvolvimento. Isso é convenção simples de env var, não
// framework de configuração -- se crescer, migrar pra algo tipo dotenv.
const defaultUrl =
  process.env.NODE_ENV === 'test'
    ? 'postgresql://postgres:postgres@localhost:5432/buckshot_test'
    : 'postgresql://postgres:postgres@localhost:5432/buckshot';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || defaultUrl,
});

module.exports = { pool };
