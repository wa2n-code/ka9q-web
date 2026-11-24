/* Select a receiver-legal frequency only after its LO/IF coverage is known.
 * Priority: explicit URL/restored tuning, valid backend tuning, RF midpoint.
 */
(function(root) {
  'use strict';
  function choose(requestedHz, backendHz, loHz, lowIfHz, highIfHz) {
    if (![loHz,lowIfHz,highIfHz].every(Number.isFinite) ||
        highIfHz <= lowIfHz) return null;
    const low = loHz + lowIfHz, high = loHz + highIfHz;
    if (!Number.isFinite(low) || !Number.isFinite(high) ||
        low < 0 || high <= low || high > 0xFFFFFFFF) return null;
    const valid = hz => Number.isFinite(hz) && hz >= low && hz <= high;
    if (valid(requestedHz))
      return {frequencyHz: Math.round(requestedHz), source:'requested', lowHz:low, highHz:high};
    if (valid(backendHz))
      return {frequencyHz: Math.round(backendHz), source:'backend', lowHz:low, highHz:high};
    return {frequencyHz: Math.round((low+high)/2), source:'coverage-center', lowHz:low, highHz:high};
  }
  root.Ka9qStartupFrequency = {choose};
})(typeof window !== 'undefined' ? window : {});
