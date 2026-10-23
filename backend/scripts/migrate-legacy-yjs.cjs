#!/usr/bin/env node
'use strict';

const net = require('node:net');
const path = require('node:path');
const readline = require('node:readline/promises');
const Y = require('yjs');
const {
  prepareLegacyMigration,
  activateLegacyMigration,
} = require('../legacyYjsMigration');

const backendDir = path.resolve(__dirname, '..');
const approvalPhrase = 'ACTIVATE SCRIPT.JS AND TEST.JS';

function parseArgs(args) {
  const [action, ...rest] = args;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === '--confirm-backend-stopped') options.confirmBackendStopped = true;
    else if (value === '--port') options.port = Number(rest[++index]);
    else if (value === '--report') options.reportPath = rest[++index];
    else throw new Error(`Unknown option: ${value}`);
  }
  if (!['prepare', 'activate'].includes(action)) throw new Error('Choose either prepare or activate.');
  if (!options.confirmBackendStopped) throw new Error('Pass --confirm-backend-stopped after stopping the backend.');
  if (options.port === undefined) options.port = 3001;
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error('--port must be an integer from 1 to 65535.');
  }
  if (action === 'activate' && !options.reportPath) throw new Error('Activation requires --report <recovery-report.json>.');
  return { action, ...options };
}

function reserveBackendPort(port) {
  return new Promise((resolve, reject) => {
    const reservation = net.createServer();
    reservation.once('error', error => {
      reject(new Error(error.code === 'EADDRINUSE'
        ? `Port ${port} is in use; stop the backend and retry.`
        : `Could not reserve backend port ${port} (${error.code || 'port_check_failed'}).`));
    });
    reservation.listen({ port, host: '::', ipv6Only: false }, () => resolve(reservation));
  });
}

async function confirmActivation() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Activation requires an interactive terminal so the approval phrase can be entered.');
  }
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question(`After reviewing recoveredText in the report, type exactly: ${approvalPhrase}\n> `);
    return answer === approvalPhrase;
  } finally {
    terminal.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const reservation = await reserveBackendPort(options.port);
  try {
    if (options.action === 'prepare') {
      const result = prepareLegacyMigration({ Y, dataDir: backendDir });
      console.log(`Recovery report created: ${result.reportPath}`);
      for (const room of Object.keys(result.report.rooms)) {
        const record = result.report.rooms[room];
        console.log(`${room}: ${record.parsedUpdateCount} updates; validation passed; review recoveredText in the report.`);
      }
      console.log('No active history or manifest was installed.');
      return;
    }

    const reportPath = path.resolve(options.reportPath);
    if (!await confirmActivation()) {
      console.log('Activation cancelled; no active history or manifest was changed.');
      return;
    }
    activateLegacyMigration({ Y, dataDir: backendDir, reportPath });
    console.log(`Migration manifest published: ${path.join(backendDir, 'yjs_db', 'codestudio-legacy-yjs-v1.json')}`);
  } finally {
    await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  }
}

main().catch(error => {
  console.error(`Legacy Yjs migration failed (${error.code || 'migration_failed'}): ${error.message}`);
  process.exitCode = 1;
});
