'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cli = path.join(path.dirname(require.resolve('firebase-tools/package.json')), 'lib/bin/firebase.js');
const result = spawnSync(process.execPath, [
  cli, 'emulators:exec', '--project', 'demo-tslwrite', '--only', 'firestore',
  'node --test --test-concurrency=1 functions/test/emulator.test.js',
], { cwd: path.resolve(__dirname, '../..'), stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
