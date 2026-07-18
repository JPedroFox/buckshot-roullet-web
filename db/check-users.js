'use strict';

/**
 * Script utilitário: lista os usuários cadastrados, sem precisar do
 * cliente psql instalado. Usa a mesma conexão configurada em server/db.js.
 *
 * Uso:
 *   node db/check-users.js            -> olha o banco de dev (buckshot)
 *   NODE_ENV=test node db/check-users.js  -> olha o banco de teste
 */

const { pool } = require('../server/db');

async function main() {
  try {
    const result = await pool.query(
      'SELECT id, username, created_at FROM users ORDER BY created_at DESC'
    );

    console.log(`\nConectado em: ${pool.options.connectionString || '(via DATABASE_URL)'}\n`);

    if (result.rows.length === 0) {
      console.log('Nenhum usuário encontrado nesse banco.');
    } else {
      console.log(`${result.rows.length} usuário(s) encontrado(s):\n`);
      result.rows.forEach((row) => {
        console.log(`  #${row.id}  ${row.username}  (criado em ${row.created_at.toISOString()})`);
      });
    }
  } catch (err) {
    console.error('Erro ao consultar o banco:', err.message);
    console.error('\nIsso geralmente significa: Postgres não está rodando, ou a');
    console.error('string de conexão (DATABASE_URL / server/db.js) está errada.');
  } finally {
    await pool.end();
  }
}

main();
