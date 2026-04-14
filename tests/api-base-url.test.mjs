import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveApiBaseUrl, resolveDefaultApiBaseUrl } from '../packages/domain/src/index.js';

test('resolveDefaultApiBaseUrl returns local gateway for localhost', () => {
  assert.equal(
    resolveDefaultApiBaseUrl({ hostname: 'localhost', origin: 'http://localhost:4173', protocol: 'http:' }),
    'http://127.0.0.1:4000'
  );

  assert.equal(
    resolveDefaultApiBaseUrl({ hostname: '127.0.0.1', origin: 'http://127.0.0.1:4173', protocol: 'http:' }),
    'http://127.0.0.1:4000'
  );
});

test('resolveDefaultApiBaseUrl keeps public gateway for known static web hosts', () => {
  assert.equal(
    resolveDefaultApiBaseUrl({ hostname: 'octop-mobile.pages.dev', origin: 'https://octop-mobile.pages.dev', protocol: 'https:' }),
    'https://octop.ilycode.app'
  );

  assert.equal(
    resolveDefaultApiBaseUrl({ hostname: 'octop-m.turtlelab.app', origin: 'https://octop-m.turtlelab.app', protocol: 'https:' }),
    'https://octop.ilycode.app'
  );
});

test('resolveDefaultApiBaseUrl prefers same origin for integrated or custom deployments', () => {
  assert.equal(
    resolveDefaultApiBaseUrl({ hostname: 'octop.ilycode.app', origin: 'https://octop.ilycode.app', protocol: 'https:' }),
    'https://octop.ilycode.app'
  );

  assert.equal(
    resolveDefaultApiBaseUrl({ hostname: 'mobile.example.com', origin: 'https://mobile.example.com', protocol: 'https:' }),
    'https://mobile.example.com'
  );
});

test('resolveApiBaseUrl prioritizes configured base url', () => {
  assert.equal(
    resolveApiBaseUrl('https://api.example.com/', { hostname: 'octop-mobile.pages.dev', origin: 'https://octop-mobile.pages.dev', protocol: 'https:' }),
    'https://api.example.com'
  );
});
