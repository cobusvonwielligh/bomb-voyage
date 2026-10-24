import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIni, sameSecret } from '../server/config.js';
import { playerName } from '../server/net.js';

test('ini parsing', async t => {
  await t.test('sections, comments, and values with = in them', () => {
    const ini = parseIni(`
      ; a comment
      # another
      [server]
      port = 443
      public_host = bombvoyage.co.za

      [deploy]
      token = abc=def=
      ssh_key = ~/Downloads/key.pem
    `);
    assert.equal(ini.server.port, '443');
    assert.equal(ini.server.public_host, 'bombvoyage.co.za');
    assert.equal(ini.deploy.token, 'abc=def=', 'only the first = separates key from value');
    assert.equal(ini.deploy.ssh_key, '~/Downloads/key.pem');
  });

  await t.test('keys are case-insensitive and blank values survive', () => {
    const ini = parseIni('[Server]\nTLS_Cert =\nPort=8080');
    assert.equal(ini.server.tls_cert, '');
    assert.equal(ini.server.port, '8080');
  });

  await t.test('junk does not throw', () => {
    assert.doesNotThrow(() => parseIni('[unclosed\nno-equals-here\n\n[]\n= orphan'));
  });
});

test('secrets compare only when they match exactly, and blank never matches', () => {
  assert.equal(sameSecret('abc', 'abc'), true);
  assert.equal(sameSecret('abd', 'abc'), false);
  assert.equal(sameSecret('abcd', 'abc'), false, 'a longer guess with the right prefix');
  assert.equal(sameSecret(undefined, 'abc'), false);
  assert.equal(sameSecret('', ''), false, 'an unset key would let everybody in');
  assert.equal(sameSecret(undefined, ''), false);
});

test('a name cannot pass for the server in chat', () => {
  assert.equal(playerName('SERVER'), 'anon');
  assert.equal(playerName(' server '), 'anon');
  assert.equal(playerName('servers'), 'servers');
});