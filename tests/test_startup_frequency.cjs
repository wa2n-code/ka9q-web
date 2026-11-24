'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const root = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'..','html','startup-frequency.js'),'utf8'),
  {window:root}, {filename:'startup-frequency.js'});
const choose = root.Ka9qStartupFrequency.choose;
const vhf = [163570007,-9400000,-15000], hf = [0,15000,30456000];
test('wait for complete frontend limits', () => {
  assert.equal(choose(10000000,0,NaN,-9400000,-15000),null);
  assert.equal(choose(10000000,0,163570007,NaN,-15000),null);
});
test('invalid HF saved frequency cannot retune VHF receiver', () => {
  assert.equal(choose(10000000,0,...vhf).frequencyHz,158862507);
});
test('saved marine channel restored when in band', () => {
  const v=choose(156600000,158000000,...vhf);
  assert.equal(v.source,'requested');
  assert.equal(v.frequencyHz,156600000);
});
test('valid backend frequency preferred over invalid HF saved frequency', () => {
  assert.equal(choose(10000000,156800000,...vhf).frequencyHz,156800000);
});
test('HF default of 10 MHz remains valid', () => {
  assert.equal(choose(10000000,14100000,...hf).frequencyHz,10000000);
});
test('invalid explicit tune falls back inside the RF coverage', () => {
  const v=choose(200000000,0,...vhf);
  assert.equal(v.source,'coverage-center');
  assert.ok(v.frequencyHz >= v.lowHz && v.frequencyHz <= v.highHz);
});
test('startup sequencing guards early RF commands', () => {
  const s=fs.readFileSync(path.join(__dirname,'..','html','radio.js'),'utf8');
  assert.match(s,/startupFrequencyPending = true/);
  assert.match(s,/resolveStartupFrequencyFromFrontend\(\);/);
  assert.match(s,/frontendLoHz = NaN/);
  assert.doesNotThrow(() => new Function(s));
});
