const assert = require('node:assert/strict');
const test = require('node:test');
const { HookEngine } = require('../src/core/hooks');

test('removing an addon removes only its actions and filters', () => {
  const hooks = new HookEngine();
  let coreCalls = 0;
  let addonCalls = 0;
  hooks.addAction('save', () => { coreCalls += 1; }, 10, 'core');
  hooks.addAction('save', () => { addonCalls += 1; }, 10, 'example');
  hooks.addFilter('content', value => value + '-core', 10, 'core');
  hooks.addFilter('content', value => value + '-addon', 10, 'example');

  hooks.removeAddon('example');
  hooks.doAction('save');
  assert.equal(coreCalls, 1);
  assert.equal(addonCalls, 0);
  assert.equal(hooks.applyFilters('content', 'value'), 'value-core');
});

test('an addon can be reloaded without duplicate handlers', () => {
  const hooks = new HookEngine();
  let calls = 0;
  for (let index = 0; index < 3; index += 1) {
    hooks.removeAddon('example');
    hooks.addAction('save', () => { calls += 1; }, 10, 'example');
  }
  hooks.doAction('save');
  assert.equal(calls, 1);
});
