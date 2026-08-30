'use strict';

// Node 25 enforces network denial under --permission. LectureLive also supports
// Node 24, whose permission model does not yet cover sockets, so keep a narrow
// preload guard for the trusted parser dependency set on that runtime.
const moduleApi = require('node:module');

function denied() {
  const error = new Error('Document parser network access is disabled');
  error.code = 'ERR_DOCUMENT_PARSER_NETWORK_DENIED';
  throw error;
}

function replace(object, key) {
  if (!object || !(key in object)) return;
  try {
    Object.defineProperty(object, key, {
      configurable: false,
      enumerable: object.propertyIsEnumerable(key),
      writable: false,
      value: denied,
    });
  } catch {
    object[key] = denied;
  }
}

const net = require('node:net');
for (const key of ['connect', 'createConnection', 'createServer']) replace(net, key);
replace(net.Socket?.prototype, 'connect');

const tls = require('node:tls');
for (const key of ['connect', 'createServer']) replace(tls, key);
replace(tls.TLSSocket?.prototype, 'connect');

for (const name of ['node:http', 'node:https']) {
  const transport = require(name);
  for (const key of ['request', 'get', 'createServer']) replace(transport, key);
}

const http2 = require('node:http2');
for (const key of ['connect', 'createServer', 'createSecureServer']) replace(http2, key);

const dgram = require('node:dgram');
replace(dgram, 'createSocket');

const dns = require('node:dns');
for (const key of [
  'lookup',
  'lookupService',
  'resolve',
  'resolve4',
  'resolve6',
  'resolveAny',
  'resolveCaa',
  'resolveCname',
  'resolveMx',
  'resolveNaptr',
  'resolveNs',
  'resolvePtr',
  'resolveSoa',
  'resolveSrv',
  'resolveTxt',
  'reverse',
  'setServers',
]) {
  replace(dns, key);
  replace(dns.promises, key);
}

for (const key of ['fetch', 'WebSocket', 'EventSource']) {
  if (key in globalThis) {
    Object.defineProperty(globalThis, key, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: denied,
    });
  }
}

// Keep ESM named exports in sync with the patched CommonJS built-ins.
moduleApi.syncBuiltinESMExports();
