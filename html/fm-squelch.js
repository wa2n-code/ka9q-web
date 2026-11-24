/* FM squelch and Monitor controls, scoped to this browser's audio SSRC.
 * radiod has Open and Close thresholds in dB SNR. Hysteresis = Open - Close.
 * The explicit Monitor command is Q:MONITOR, and the backend converts finite
 * -500 dB to an internal zero threshold (the FM always-open condition).
 */
(function(root) {
  'use strict';
  const $ = id => root.document && root.document.getElementById(id);
  const state = {actual:null, lastNormal:null, demod:null, dirty:false, pending:null};
  const round = n => Math.round(n * 10) / 10;
  const normalDefault = {open:8,close:7,hysteresis:1};
  const MONITOR_DB = -500;
  let requestId = 0;

  // KA9Q TLV encode_float() suppresses leading zero bits and represents
  // the float +0.0 as a zero-length payload. getFloat32() alone therefore
  // loses valid 0 dB readbacks (e.g., Open 4.0 / Close 0.0).
  function decodeStatusFloat(view,offset,length) {
    if(!view || !Number.isInteger(offset) || !Number.isInteger(length) ||
       offset<0 || length<0 || length>4 || offset+length>view.byteLength)
      return null;
    if(length===0)return 0;
    let bits=0;
    for(let j=0;j<length;j++)
      bits=((bits*256)+view.getUint8(offset+j))>>>0;
    const scratch=new DataView(new ArrayBuffer(4));
    scratch.setUint32(0,bits,false);
    const result=scratch.getFloat32(0,false);
    return Number.isFinite(result)?result:null;
  }

  function calculate(open,close,hysteresis,changed) {
    open=Number(open);close=Number(close);hysteresis=Number(hysteresis);
    if (changed==='open' || changed==='hysteresis') close=round(open-hysteresis);
    else if (changed==='close') hysteresis=round(open-close);
    return {open:round(open),close:round(close),hysteresis:round(hysteresis)};
  }
  function valid(x) {
    return [x.open,x.close,x.hysteresis].every(Number.isFinite) &&
      [x.open,x.close,x.hysteresis].every(v => Math.abs(v*10-Math.round(v*10))<0.00001) &&
      x.open>=-30 && x.open<=40 && x.close>=-30 &&
      x.close<=40 && x.close<=x.open &&
      x.hysteresis>=0 && x.hysteresis<=30 &&
      Math.abs(x.hysteresis-(x.open-x.close))<0.11;
  }
  function values() {
    // Validate exactly what was typed, not a rounded value that could turn
    // 0.05 into an implicitly accepted +0.1 dB; zero itself is valid.
    const get = id => {
      const v = $(id).value.trim();
      return v === '' ? NaN : Number(v);
    };
    return {open:get('fmSqOpen'),close:get('fmSqClose'),
            hysteresis:get('fmSqHysteresis')};
  }
  function writeValues(x) {
    $('fmSqOpen').value=x.open.toFixed(1);
    $('fmSqClose').value=x.close.toFixed(1);
    $('fmSqHysteresis').value=x.hysteresis.toFixed(1);
  }
  function message(msg) {const el=$('fmSqStatus');if(el)el.textContent=msg;}
  function fmSelected() {const el=$('mode');return !!el && ['fm','wfm'].includes((el.value||'').toLowerCase());}
  function backendFm() {return state.demod===1 || state.demod===2;}
  function refreshMode() {
    const group=$('fmSquelchControls'),btn=$('fmSqApply'),toggle=$('fmSqMonitor');
    if(!group || !btn || !toggle)return;
    const visible=fmSelected(),ready=visible && backendFm() && !!state.actual;
    group.hidden=!visible;
    group.style.display=visible?'block':'none';
    const displayedMonitor=state.pending ? state.pending.monitor : !!state.actual?.monitor;
    toggle.disabled=!ready || !!state.pending;
    if(!state.pending)toggle.checked=!!state.actual?.monitor;
    for(const name of ['fmSqOpen','fmSqClose','fmSqHysteresis']) {
      const el=$(name);if(el)el.disabled=!ready || displayedMonitor || !!state.pending;
    }
    btn.disabled=!ready || displayedMonitor || !!state.pending || !state.dirty || !valid(values());
    if(visible && !backendFm())message('Waiting for FM demodulator status');
  }
  function invalidMessage(x) {
    if (Number.isFinite(x.open) && x.open < -30)
      return 'Open must be at least -30.0 dB. Use Monitor for squelch OFF.';
    return 'Invalid squelch threshold combination';
  }
  function edit(changed) {
    if(state.pending || state.actual?.monitor)return;
    const result=calculate($('fmSqOpen').value,$('fmSqClose').value,
                           $('fmSqHysteresis').value,changed);
    if(changed!=='open')$('fmSqOpen').value=String(result.open);
    if(changed!=='close')$('fmSqClose').value=String(result.close);
    if(changed!=='hysteresis')$('fmSqHysteresis').value=String(result.hysteresis);
    state.dirty=true;
    message(valid(result)?'Edited — press Apply':invalidMessage(result));
    refreshMode();
  }
  function issue(messageText,want) {
    if (typeof root.sendControl!=='function') {message('WebSocket control unavailable');return;}
    const pending={...want,since:Date.now(),id:++requestId};
    state.pending=pending;
    state.dirty=false;
    message('Requested — awaiting radiod readback');
    // Suffix prevents the WebSocket coalescer from dropping a repeated Q
    // request. The C handler intentionally reads just the first two values.
    const command=messageText+':'+pending.id;
    try {root.sendControl('squelch',command,undefined,true);}
    catch(e) {state.pending=null;state.dirty=true;message('WebSocket send failed: '+String(e));}
    refreshMode();
    if(state.pending===pending && typeof root.setTimeout==='function') {
      root.setTimeout(() => {
        if(state.pending!==pending)return;
        state.pending=null;
        state.dirty=true;
        message('No matching radiod readback within 8 s — check server log');
        refreshMode();
      },8000);
    }
  }
  function apply() {
    const x=values();
    if(!valid(x) || !fmSelected() || !backendFm() || !state.actual || state.pending || state.actual.monitor) {
      message(!valid(x) ? invalidMessage(x) :
              'Cannot apply: check mode, backend status and threshold values');return;
    }
    issue('Q:'+x.open.toFixed(1)+':'+x.close.toFixed(1),
          {monitor:false,open:x.open,close:x.close});
  }
  function toggleMonitor() {
    const toggle=$('fmSqMonitor');
    if(!toggle || !fmSelected() || !backendFm() || !state.actual || state.pending)return;
    if(toggle.checked) {
      if(!state.actual.monitor && valid(values()))state.lastNormal=values();
      issue('Q:MONITOR',{monitor:true});
    } else {
      const x=state.lastNormal || normalDefault;
      issue('Q:'+x.open.toFixed(1)+':'+x.close.toFixed(1),
            {monitor:false,open:x.open,close:x.close});
    }
  }
  function onStatus(demod,open,close) {
    if(Number.isInteger(demod))state.demod=demod;
    const monitor=Number.isFinite(open) && Number.isFinite(close) &&
                  open<=-100 && close<=-100;
    const normal=Number.isFinite(open) && Number.isFinite(close) &&
                 open>=-30 && open<=40 && close>=-30 && close<=40 && close<=open;
    if(monitor || normal) {
      const actual=monitor?{monitor:true}: {...calculate(open,close,open-close,'close'),monitor:false};
      state.actual=actual;
      if(normal)state.lastNormal=actual;
      if(state.pending) {
        const p=state.pending;
        const match=p.monitor===actual.monitor &&
          (p.monitor || (Math.abs(p.open-actual.open)<0.15 &&
                         Math.abs(p.close-actual.close)<0.15));
        if(match) {
          state.pending=null;
          message('Applied — confirmed by radiod'+(actual.monitor?' (Monitor ON)':''));
        }
      }
      if(!state.pending && !state.dirty) {
        if(!actual.monitor)writeValues(actual);
        else if(state.lastNormal)writeValues(state.lastNormal);
        const s=$('fmSqStatus')?.textContent || '';
        if(!s.startsWith('Applied') && !s.startsWith('No matching'))
          message(actual.monitor?'Monitor active — FM squelch OFF':
                  'Radiod: Open '+actual.open.toFixed(1)+' / Close '+actual.close.toFixed(1)+' dB');
      }
    }
    refreshMode();
  }
  function reset() {
    state.actual=null;state.demod=null;state.pending=null;state.dirty=false;
    const toggle=$('fmSqMonitor');if(toggle)toggle.checked=false;
    message('Waiting for FM status');
    refreshMode();
  }
  function error(s) {
    state.pending=null;state.dirty=true;
    message('Receiver: '+s);refreshMode();
  }
  function init() {
    const btn=$('fmSqApply'),toggle=$('fmSqMonitor');
    if(!btn || !toggle)return;
    for(const k of ['open','close','hysteresis']){
      const el=$({open:'fmSqOpen',close:'fmSqClose',hysteresis:'fmSqHysteresis'}[k]);
      if(el)el.addEventListener('input',()=>edit(k));
    }
    btn.addEventListener('click',apply);
    toggle.addEventListener('change',toggleMonitor);
    const mode=$('mode');if(mode)mode.addEventListener('change',refreshMode);
    refreshMode();
  }
  root.Ka9qFmSquelch={calculate,valid,decodeStatusFloat,onStatus,refreshMode,reset,error};
  if(root.document){
    if(root.document.readyState==='loading')
      root.document.addEventListener('DOMContentLoaded',init,{once:true});
    else init();
  }
})(typeof window !== 'undefined'?window:{});
