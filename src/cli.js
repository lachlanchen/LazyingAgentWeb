#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { loadServiceConfig } from './service-config.js';
import {
  checkStandaloneServiceConfiguration,
  createStandaloneService
} from './service.js';

function parseArguments(argv, env) {
  if (!Array.isArray(argv) || (argv.length !== 1 && argv.length !== 3)) {
    throw new TypeError('usage: lazying-agent-web <serve|config-check> [--config ABSOLUTE_PATH]');
  }
  const command = argv[0];
  if (command !== 'serve' && command !== 'config-check') {
    throw new TypeError('only serve and config-check commands are supported');
  }
  let configPath;
  if (argv.length === 3) {
    if (argv[1] !== '--config' || typeof argv[2] !== 'string' || !argv[2]) {
      throw new TypeError('the only supported option is --config ABSOLUTE_PATH');
    }
    configPath = argv[2];
  } else {
    configPath = env.LAZYING_AGENT_CONFIG;
  }
  if (typeof configPath !== 'string' || !configPath) {
    throw new TypeError('a config path is required');
  }
  if (typeof env.CREDENTIALS_DIRECTORY !== 'string' || !env.CREDENTIALS_DIRECTORY) {
    throw new TypeError('CREDENTIALS_DIRECTORY is required');
  }
  return Object.freeze({ command, configPath, credentialsDirectory: env.CREDENTIALS_DIRECTORY });
}

function writeJson(stream, value) {
  if (!stream || typeof stream.write !== 'function') throw new TypeError('output stream must provide write()');
  stream.write(`${JSON.stringify(value)}\n`);
}

function waitForTermination(service) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      process.removeListener('SIGINT', finish);
      process.removeListener('SIGTERM', finish);
      service.server.removeListener('close', finish);
      resolve();
    };
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
    service.server.once('close', finish);
  });
}

export async function runCli({
  argv = process.argv.slice(2),
  env = process.env,
  stdout = process.stdout,
  configLoader = loadServiceConfig,
  configChecker = checkStandaloneServiceConfiguration,
  serviceFactory = createStandaloneService,
  terminationWaiter = waitForTermination
} = {}) {
  if (typeof configLoader !== 'function' || typeof configChecker !== 'function'
      || typeof serviceFactory !== 'function' || typeof terminationWaiter !== 'function') {
    throw new TypeError('CLI dependencies must be functions');
  }
  const command = parseArguments(argv, env);
  const loadedConfig = configLoader({
    configPath: command.configPath,
    credentialsDirectory: command.credentialsDirectory
  });
  if (command.command === 'config-check') {
    const report = await configChecker(loadedConfig);
    writeJson(stdout, { ok: true, command: 'config-check', ...report });
    return 0;
  }

  const service = await serviceFactory({ loadedConfig });
  try {
    const endpoint = await service.start();
    writeJson(stdout, {
      ok: true,
      command: 'serve',
      status: 'listening',
      address: endpoint.address,
      port: endpoint.port,
      publicOrigin: service.publicOrigin,
      releaseId: service.releaseId,
      agentEnabled: false
    });
    await terminationWaiter(service);
    return 0;
  } finally {
    await service.shutdown();
  }
}

export async function main() {
  try {
    const code = await runCli();
    process.exitCode = code;
  } catch {
    // Deliberately do not print exception messages: configuration and credential
    // failures must not turn secret material into service-manager logs.
    writeJson(process.stderr, { ok: false, error: 'standalone_service_command_failed' });
    process.exitCode = 1;
  }
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entry === import.meta.url) await main();
