// Run: node --test tests/test_vhf_browser_bounds.cjs
// Exercise the actual spectrum.js prototype methods without creating a DOM.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'html', 'spectrum.js'), 'utf8');
const sandbox = { window: {}, console };
vm.runInNewContext(source, sandbox, { filename: 'spectrum.js' });
const Spectrum = sandbox.Spectrum;

function fakeSpectrum(options = {}) {
  const s = Object.create(Spectrum.prototype);
  Object.assign(s, { input_samprate: 20000000, centerHz: 10000000,
                     spanHz: 2000000, frequency: 10000000 }, options);
  s.updateAxes = () => {};
  s.saveSettings = () => {};
  return s;
}

test('direct sampling HF fallback remains valid', () => {
  const s = fakeSpectrum();
  assert.equal(s.checkFrequencyIsValid(7019000), true);
  assert.equal(s.checkFrequencyIsValid(10000000), true);
  assert.equal(s.checkFrequencyIsValid(156600000), false);
  s.setSpanHz(1000000);
  s.setCenterHz(7019000);
  assert.equal(s.centerHz, 7019000);
});

test('RX888 MkII high-side LO yields the real VHF RF window', () => {
  const s = fakeSpectrum({
    frontendLoHz: 163570007,
    frontendLowIfHz: -9400000,
    frontendHighIfHz: -15000,
    centerHz: 158569927,
    frequency: 156600000,
    spanHz: 8799840
  });
  const bounds = s.getRfBounds();
  assert.equal(bounds.minHz, 154170007);
  assert.equal(bounds.maxHz, 163555007);
  assert.equal(s.checkFrequencyIsValid(156600000), true);
  assert.equal(s.checkFrequencyIsValid(7019000), false);
  assert.equal(s.checkFrequencyIsValid(163600000), false);
  s.setCenterHz(158569927);
  assert.equal(s.centerHz, 158569927, 'server RF centre must not clamp to HF');
  assert.equal(s.centerHz - s.spanHz / 2, 154170007);
  assert.equal(s.centerHz + s.spanHz / 2, 162969847);
});

test('VHF span and centre clamp to LO/IF coverage, not ADC Nyquist', () => {
  const s = fakeSpectrum({
    frontendLoHz: 163570007,
    frontendLowIfHz: -9400000,
    frontendHighIfHz: -15000,
    centerHz: 158569927,
    frequency: 156600000
  });
  s.setSpanHz(20000000);
  assert.equal(s.spanHz, 9385000);
  assert.equal(s.centerHz, 158862507);
  s.setSpanHz(1000000);
  s.setCenterHz(10000000);
  assert.equal(s.centerHz, 154670007);
  s.setCenterHz(200000000);
  assert.equal(s.centerHz, 163055007);
});

test('real-sampling UHF tuner supports negative-only IF', () => {
  const s = fakeSpectrum({
    frontendLoHz: 440000000,
    frontendLowIfHz: -9400000,
    frontendHighIfHz: -600000
  });
  assert.equal(s.checkFrequencyIsValid(433500000), true);
  assert.equal(s.checkFrequencyIsValid(441000000), false);
  const b = s.getRfBounds();
  assert.equal(b.minHz, 430600000);
  assert.equal(b.maxHz, 439400000);
});
