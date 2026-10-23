import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIni } from '../server/config.js';

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
