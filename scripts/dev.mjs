#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { loadEnvFile } from 'node:process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const inheritedEnvironment = { ...process.env };

try {
  loadEnvFile(join(repositoryRoot, 'backend/.env'));
} catch (error) {
  if (error?.code !== 'ENOENT') {
    throw error;
  }
}

const backendEnvironment = { ...process.env };
const stripeSecretKey = backendEnvironment.STRIPE_SECRET_KEY?.trim() ?? '';
const stripePriceId = backendEnvironment.STRIPE_PRICE_ID?.trim() ?? '';
const configuredWebhookSecret =
  backendEnvironment.STRIPE_WEBHOOK_SECRET?.trim() ?? '';
const hasAnyStripeConfiguration = Boolean(
  stripeSecretKey || stripePriceId || configuredWebhookSecret,
);

if (hasAnyStripeConfiguration && (!stripeSecretKey || !stripePriceId)) {
  console.error(
    'Local Stripe billing needs both STRIPE_SECRET_KEY and STRIPE_PRICE_ID in backend/.env. ' +
      'Remove every Stripe value to disable billing locally.',
  );
  process.exit(1);
}

const sensitiveValuePattern =
  /(?:whsec|sk_test|rk_test|sk_live|rk_live)_[A-Za-z0-9_]+/g;
const redactSecrets = (line) => line.replace(sensitiveValuePattern, '[redacted]');
const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const children = [];
let shuttingDown = false;

function pipeOutput(child, name) {
  for (const [stream, write] of [
    [child.stdout, console.log],
    [child.stderr, console.error],
  ]) {
    if (!stream) continue;

    createInterface({ input: stream }).on('line', (line) => {
      write(`[${name}] ${redactSecrets(line)}`);
    });
  }
}

function stopChild(child, signal) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;

  try {
    if (process.platform === 'win32') {
      child.kill(signal);
    } else {
      process.kill(-child.pid, signal);
    }
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

function shutdown(exitCode, signal = 'SIGTERM') {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const child of children) stopChild(child, signal);

  const forceTimer = setTimeout(() => {
    for (const child of children) stopChild(child, 'SIGKILL');
  }, 3_000);
  forceTimer.unref();

  const pendingChildren = children.map(
    (child) =>
      new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        child.once('close', resolve);
      }),
  );

  Promise.allSettled(pendingChildren).then(() => process.exit(exitCode));
}

function startProcess(name, command, args, environment) {
  const child = spawn(command, args, {
    cwd: repositoryRoot,
    env: environment,
    detached: process.platform !== 'win32',
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  children.push(child);
  pipeOutput(child, name);

  child.on('error', (error) => {
    console.error(`[${name}] ${redactSecrets(error.message)}`);
    shutdown(1);
  });

  child.on('close', (code, signal) => {
    if (shuttingDown) return;

    const reason = signal ? `signal ${signal}` : `exit code ${code ?? 1}`;
    console.error(`[${name}] stopped unexpectedly (${reason}).`);
    shutdown(code && code > 0 ? code : 1);
  });

  return child;
}

let listenerSecret = '';

if (stripeSecretKey && stripePriceId) {
  const stripeEnvironment = {
    ...inheritedEnvironment,
    STRIPE_API_KEY: stripeSecretKey,
  };
  const secretResult = spawnSync(
    'stripe',
    ['listen', '--print-secret', '--skip-update'],
    {
      cwd: repositoryRoot,
      env: stripeEnvironment,
      encoding: 'utf8',
    },
  );

  listenerSecret = secretResult.stdout?.trim() ?? '';

  if (
    secretResult.error ||
    secretResult.status !== 0 ||
    !/^whsec_[A-Za-z0-9_]+$/.test(listenerSecret)
  ) {
    const detail = redactSecrets(
      secretResult.error?.message || secretResult.stderr?.trim() || 'unknown error',
    );
    console.error(
      `Could not start automatic Stripe webhook forwarding: ${detail}\n` +
        'Install the Stripe CLI and ensure STRIPE_SECRET_KEY can use `stripe listen`, ' +
        'or remove all Stripe values to run without billing.',
    );
    process.exit(1);
  }

  startProcess(
    'stripe',
    'stripe',
    [
      'listen',
      '--skip-update',
      '--forward-to',
      'localhost:4000/api/webhooks/stripe',
    ],
    stripeEnvironment,
  );
}

startProcess(
  'api',
  npmExecutable,
  ['run', 'dev', '-w', 'backend'],
  listenerSecret
    ? { ...backendEnvironment, STRIPE_WEBHOOK_SECRET: listenerSecret }
    : backendEnvironment,
);
startProcess(
  'web',
  npmExecutable,
  ['run', 'dev', '-w', 'frontend'],
  inheritedEnvironment,
);

process.on('SIGINT', () => shutdown(0, 'SIGINT'));
process.on('SIGTERM', () => shutdown(0, 'SIGTERM'));
