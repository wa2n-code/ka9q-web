'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const src=fs.readFileSync(path.join(__dirname,'..','html','fm-squelch.js'),'utf8');
const root={};
vm.runInNewContext(src,{window:root},{filename:'fm-squelch.js'});
const {calculate,valid}=root.Ka9qFmSquelch;
const plain=x=>JSON.parse(JSON.stringify(x));

test('KA9Q compressed float TLVs include valid zero-length 0 dB',()=>{
  const decode=root.Ka9qFmSquelch.decodeStatusFloat;
  const empty=new DataView(new ArrayBuffer(0));
  assert.equal(decode(empty,0,0),0);
  // Encode the float32 wire bytes exactly as KA9Q encode_float does:
  // leading zero bytes are removed; all-zero payload has length zero.
  for(const expected of [0,0.1,3.9,4,-3.9,-500,1e-40]){
    const bytes=Buffer.alloc(4);
    bytes.writeFloatBE(expected,0);
    let offset=0;
    while(offset<4 && bytes[offset]===0)offset++;
    const view=new DataView(bytes.buffer,bytes.byteOffset+offset,4-offset);
    const actual=decode(view,0,view.byteLength);
    assert.ok(Math.abs(actual-Math.fround(expected))<=
      Math.max(1e-43,Math.abs(Math.fround(expected))*1e-6),
      `compressed float ${expected}: got ${actual}`);
  }
  assert.equal(decode(empty,0,5),null);
  assert.equal(decode(empty,1,0),null);
});

test('FM squelch confirms Open 4.0 and zero-length Close 0.0 readback',()=>{
  const {nodes,commands,ui}=setup();
  ui.onStatus(1,4.1,0.1);
  nodes.fmSqOpen.value='4.0';
  nodes.fmSqOpen.fire('input');
  assert.equal(nodes.fmSqClose.value,'0');
  nodes.fmSqApply.fire('click');
  assert.match(commands[0][1],/^Q:4\.0:0\.0:/);
  const zero=ui.decodeStatusFloat(new DataView(new ArrayBuffer(0)),0,0);
  ui.onStatus(1,4,zero);
  assert.match(nodes.fmSqStatus.textContent,/confirmed by radiod/);
  assert.equal(nodes.fmSqOpen.value,'4.0');
  assert.equal(nodes.fmSqClose.value,'0.0');
});

test('Open/Close and hysteresis are linked',()=>{
  assert.deepEqual(plain(calculate(10,6,4,'close')),{open:10,close:6,hysteresis:4});
  assert.deepEqual(plain(calculate(12,6,4,'open')),{open:12,close:8,hysteresis:4});
  assert.deepEqual(plain(calculate(10,7,4,'close')),{open:10,close:7,hysteresis:3});
  assert.deepEqual(plain(calculate(10,6,6,'hysteresis')),{open:10,close:4,hysteresis:6});
});
test('normal Open permits -30 through +40 dB but rejects out-of-range values',()=>{
  assert.equal(valid(plain(calculate(-30,-30,0,'close'))),true);
  assert.equal(valid(plain(calculate(-3,-7,4,'close'))),true);
  assert.equal(valid(plain(calculate(-0.1,-4.1,4,'close'))),true);
  assert.equal(valid(plain(calculate(0,-4,4,'close'))),true);
  assert.equal(valid(plain(calculate(0,0,0,'close'))),true);
  assert.equal(valid(plain(calculate(0.1,-3.9,4,'close'))),true);
  assert.equal(valid(plain(calculate(-30.1,-30.1,0,'close'))),false);
  assert.equal(valid(plain(calculate(-30,-30.1,0.1,'close'))),false);
  assert.equal(valid(plain(calculate(-3,-7,31,'hysteresis'))),false);
  assert.equal(valid({open:0.05,close:-3.95,hysteresis:4}),false);
  assert.equal(valid({open:0.15,close:-3.85,hysteresis:4}),false);
});
test('invalid combinations rejected',()=>{
  assert.equal(valid(plain(calculate(5,7,4,'close'))),false);
  assert.equal(valid(plain(calculate(41,6,4,'open'))),false);
});
function setup(){
  function node(value=''){
    return {value,checked:false,disabled:false,hidden:false,textContent:'',style:{},handlers:{},
      addEventListener(k,fn){this.handlers[k]=fn},fire(k){this.handlers[k]?.()}};
  }
  const nodes={mode:node('fm'),fmSquelchControls:node(),fmSqOpen:node(),
    fmSqClose:node(),fmSqHysteresis:node(),fmSqApply:node(),
    fmSqMonitor:node(),fmSqStatus:node()};
  const commands=[],timers=[];
  const client={document:{readyState:'complete',getElementById:id=>nodes[id]||null},
    sendControl(...args){commands.push(args)},
    setTimeout(fn,delay){timers.push({fn,delay})}};
  vm.runInNewContext(src,{window:client,Date},{filename:'fm-squelch.js'});
  return {nodes,commands,timers,ui:client.Ka9qFmSquelch};
}
test('normal Open 0.0/-4.0 and 0.1/-3.9 confirm',()=>{
  const {nodes,commands,ui}=setup();
  ui.onStatus(1,10,6);
  nodes.fmSqOpen.value='0';
  nodes.fmSqOpen.fire('input');
  assert.equal(nodes.fmSqClose.value,'-4');
  assert.equal(nodes.fmSqApply.disabled,false);
  nodes.fmSqApply.fire('click');
  assert.match(commands[0][1],/^Q:0\.0:-4\.0:/);
  const zero=ui.decodeStatusFloat(new DataView(new ArrayBuffer(0)),0,0);
  ui.onStatus(1,zero,-4);
  assert.match(nodes.fmSqStatus.textContent,/confirmed by radiod/);
  assert.equal(nodes.fmSqOpen.value,'0.0');

  nodes.fmSqOpen.value='0.1';
  nodes.fmSqOpen.fire('input');
  assert.equal(nodes.fmSqClose.value,'-3.9');
  assert.equal(nodes.fmSqApply.disabled,false);
  nodes.fmSqApply.fire('click');
  assert.match(commands[1][1],/^Q:0\.1:-3\.9:/);
  assert.match(nodes.fmSqStatus.textContent,/awaiting radiod readback/);
  ui.onStatus(1,0.1,-3.9);
  assert.match(nodes.fmSqStatus.textContent,/confirmed by radiod/);
});
test('negative Open -3.0 dB and -30.0 boundary confirm as normal squelch',()=>{
  const {nodes,commands,ui}=setup();
  ui.onStatus(1,10,6);
  nodes.fmSqOpen.value='-30.1';
  nodes.fmSqOpen.fire('input');
  assert.equal(nodes.fmSqApply.disabled,true);
  assert.match(nodes.fmSqStatus.textContent,/at least -30\.0 dB/);
  nodes.fmSqApply.fire('click');
  assert.equal(commands.length,0);

  nodes.fmSqOpen.value='-3';
  nodes.fmSqOpen.fire('input');
  assert.equal(nodes.fmSqClose.value,'-7');
  assert.equal(nodes.fmSqApply.disabled,false);
  nodes.fmSqApply.fire('click');
  assert.match(commands[0][1],/^Q:-3\.0:-7\.0:/);
  ui.onStatus(1,-3,-7);
  assert.match(nodes.fmSqStatus.textContent,/confirmed by radiod/);
  assert.equal(nodes.fmSqMonitor.checked,false);
  assert.equal(nodes.fmSqOpen.value,'-3.0');

  nodes.fmSqHysteresis.value='0';
  nodes.fmSqHysteresis.fire('input');
  nodes.fmSqOpen.value='-30';
  nodes.fmSqOpen.fire('input');
  assert.equal(nodes.fmSqClose.value,'-30');
  assert.equal(nodes.fmSqApply.disabled,false);
  nodes.fmSqApply.fire('click');
  assert.match(commands[1][1],/^Q:-30\.0:-30\.0:/);
  ui.onStatus(1,-30,-30);
  assert.match(nodes.fmSqStatus.textContent,/confirmed by radiod/);
  assert.equal(nodes.fmSqMonitor.checked,false);
});
test('Monitor restores last negative normal Open and Close values',()=>{
  const {nodes,commands,ui}=setup();
  ui.onStatus(1,-3,-7);
  nodes.fmSqMonitor.checked=true;
  nodes.fmSqMonitor.fire('change');
  assert.match(commands[0][1],/^Q:MONITOR:/);
  ui.onStatus(1,-500,-500);
  assert.match(nodes.fmSqStatus.textContent,/confirmed by radiod/);
  nodes.fmSqMonitor.checked=false;
  nodes.fmSqMonitor.fire('change');
  assert.match(commands[1][1],/^Q:-3\.0:-7\.0:/);
  ui.onStatus(1,-3,-7);
  assert.match(nodes.fmSqStatus.textContent,/confirmed by radiod/);
  assert.equal(nodes.fmSqMonitor.checked,false);
});
test('Monitor command, receiver confirmation and restore of previous thresholds',()=>{
  const {nodes,commands,ui}=setup();
  ui.onStatus(1,10,6);
  nodes.fmSqMonitor.checked=true;
  nodes.fmSqMonitor.fire('change');
  assert.match(commands[0][1],/^Q:MONITOR:/);
  assert.match(nodes.fmSqStatus.textContent,/awaiting radiod readback/);
  ui.onStatus(1,-500,-500);
  assert.equal(nodes.fmSqMonitor.checked,true);
  assert.equal(nodes.fmSqOpen.disabled,true);
  assert.match(nodes.fmSqStatus.textContent,/confirmed by radiod/);
  nodes.fmSqMonitor.checked=false;
  nodes.fmSqMonitor.fire('change');
  assert.match(commands[1][1],/^Q:10\.0:6\.0:/);
  ui.onStatus(1,10,6);
  assert.equal(nodes.fmSqMonitor.checked,false);
  assert.equal(nodes.fmSqOpen.disabled,false);
});
test('No status readback times out and does not claim success',()=>{
  const {nodes,timers,ui}=setup();
  ui.onStatus(1,10,6);
  nodes.fmSqOpen.value='0.5';
  nodes.fmSqOpen.fire('input');
  nodes.fmSqApply.fire('click');
  assert.equal(timers.length,1);
  assert.equal(timers[0].delay,8000);
  timers[0].fn();
  assert.match(nodes.fmSqStatus.textContent,/No matching radiod readback/);
});
test('controls hidden in USB mode and cannot Apply',()=>{
  const {nodes,ui}=setup();
  ui.onStatus(1,10,6);
  nodes.mode.value='usb';
  nodes.mode.fire('change');
  assert.equal(nodes.fmSquelchControls.hidden,true);
  assert.equal(nodes.fmSqApply.disabled,true);
});
