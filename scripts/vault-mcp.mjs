#!/usr/bin/env node
// Read-only MCP server over the vault. Usage:
//   node scripts/vault-mcp.mjs --port <n> [--host <addr>] [--token-file <path>]
// The token comes from --token-file, else $CREDENTIALS_DIRECTORY/vault-mcp-token, never from env.
import { DatabaseSync } from 'node:sqlite';
import { CARD } from './lib/lexical.mjs';
import { readToken, startServer } from './lib/vault-mcp.mjs';

/** @param {string} dbFile */
function readCards(dbFile) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    return /** @type {import('./lib/vault-mcp.mjs').Card[]} */ (
      /** @type {unknown} */ (
        db.prepare('SELECT note, layer, text FROM chunks WHERE heading = ?').all(CARD)
      )
    );
  } finally {
    db.close();
  }
}

const argv = process.argv.slice(2);
const val = (/** @type {string} */ n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};

const port = Number(val('--port'));
if (val('--port') === undefined || !Number.isInteger(port) || port < 0 || port > 65535) {
  console.error('usage: vault-mcp --port <n> [--host <addr>] [--token-file <path>]');
  process.exit(2);
}
let token;
try {
  token = readToken({
    tokenFile: val('--token-file'),
    credentialsDir: process.env.CREDENTIALS_DIRECTORY,
  });
} catch (e) {
  console.error(`vault-mcp: ${/** @type {Error} */ (e).message}`);
  process.exit(1);
}
const host = val('--host') ?? '127.0.0.1';
const server = startServer({ host, port, token, readCards });
server.on('listening', () => console.error(`vault-mcp listening on ${host}:${port}`));
server.on('error', (e) => {
  console.error(`vault-mcp: ${e.message}`);
  process.exit(1);
});
