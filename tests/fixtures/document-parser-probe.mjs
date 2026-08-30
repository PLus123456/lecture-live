import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import net from 'node:net';

function respond(text) {
  fs.writeFileSync(
    3,
    JSON.stringify({ ok: true, value: { text, truncated: false } }),
    'utf8'
  );
}

for await (const _chunk of process.stdin) {
  // Drain the same raw-byte protocol as the production parser.
}

const mode = process.argv[3];
if (mode === 'test/hang') {
  for (;;) {
    // Deliberately block this child event loop; only an external SIGKILL can stop it.
  }
}

if (mode === 'test/heap-oom') {
  const retained = [];
  for (;;) {
    // Pointer arrays are V8 old-space allocations (not external Buffer memory),
    // so the runner's max-old-space ceiling must terminate this child.
    retained.push(new Array(256 * 1024).fill({ nonce: Math.random() }));
  }
}

if (mode === 'test/network') {
  try {
    net.connect({ host: '127.0.0.1', port: 9 });
    respond('network-allowed');
  } catch (error) {
    respond(String(error?.code ?? 'network-denied'));
  }
} else if (mode === 'test/permissions') {
  const results = {};
  try {
    fs.readFileSync('package.json');
    results.read = 'allowed';
  } catch (error) {
    results.read = String(error?.code ?? 'denied');
  }
  try {
    fs.writeFileSync('/tmp/lecturelive-document-parser-permission-test', 'x');
    results.write = 'allowed';
  } catch (error) {
    results.write = String(error?.code ?? 'denied');
  }
  try {
    spawnSync(process.execPath, ['--version']);
    results.spawn = 'allowed';
  } catch (error) {
    results.spawn = String(error?.code ?? 'denied');
  }
  results.databaseSecret = process.env.DATABASE_URL ?? 'absent';
  results.jwtSecret = process.env.JWT_SECRET ?? 'absent';
  respond(JSON.stringify(results));
} else {
  respond('ok');
}
