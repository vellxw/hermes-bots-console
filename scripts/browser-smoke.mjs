// Real Chromium rendering smoke against a fixture Hermes SDK.
// Does NOT make network calls to, or certify, an authenticated Hermes gateway.
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dashboardDir = join(root, 'dashboard');
const mime = {'.js':'application/javascript','.mjs':'application/javascript','.css':'text/css','.json':'application/json'};
const fixture = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/dashboard-plugins/hermes-bots-console/style-v054.css">
</head><body style="margin:0"><div id="root"></div>
<script src="/vendor/react.js"></script><script src="/vendor/react-dom.js"></script>
<script>
  const profiles = [
    {name:'default',display_name:'Chief',is_default:true,description:'Demo profile'},
    {name:'researcher',display_name:'Researcher',is_default:false,description:'Research profile'}
  ];
  const api = new Proxy({
    getProfiles: async () => ({profiles}),
    getSessions: async () => ({sessions:[]}),
    getModelOptions: async () => ({providers:[],models:[]}),
    getSkills: async () => [],
    getToolsets: async () => []
  },{get(target,key){ return target[key] || (async () => ({})); }});
  const roomEvents = [1,2,3].map(seq => ({
    event_id:'fixture-' + seq, seq, kind:'message.member',
    payload:{text:'initial fixture message ' + seq},
    actor:{kind:'member',id:'researcher',display_name:'Researcher'}, created_at:1700000000+seq
  }));
  const roomFixture = {
    room_id:'hermes-bots-default-research',name:'Research',
    members:[{member_id:'default',profile:'default',display_name:'Chief'},
      {member_id:'researcher',profile:'researcher',display_name:'Researcher'}]
  };
  window.__groupFixture={requests:[],room:null,events:roomEvents,failNextSend:false};
  class FixtureWebSocket {
    static OPEN=1;
    constructor(url) {
      this.url=url; this.readyState=0;
      setTimeout(()=>{this.readyState=1;this.onopen?.();},0);
    }
    send(raw) {
      const frame=JSON.parse(raw);
      window.__groupFixture.requests.push({method:frame.method,params:frame.params});
      const state=window.__groupFixture;
      const params=frame.params||{};
      let result={}; let error=null;
      switch(frame.method) {
        case 'groups.capabilities':
          result={driver:true,methods:['groups.send','groups.create','groups.list','groups.log','groups.state'],max_log_limit:2};break;
        case 'groups.list':
          result={rooms:state.room?[state.room]:[],next_offset:null};break;
        case 'groups.create':
          state.room={...roomFixture,room_id:params.room_id,name:params.name,members:params.members};
          result={room:state.room};break;
        case 'groups.log': {
          const since=Number(params.since_seq||0);
          const found=state.events.filter(item=>item.seq>since).slice(0,2);
          const cursor=found.length?found[found.length-1].seq:since;
          const latest_seq=state.events.length?state.events[state.events.length-1].seq:0;
          result={events:found,cursor,latest_seq,has_more:cursor<latest_seq};break;
        }
        case 'groups.state':
          result={room:state.room,driver_status:{working:false,pending_actions:[]}};break;
        case 'groups.send': {
          if(state.failNextSend){
            state.failNextSend=false;
            error={code:5000,message:'Fixture: simulated Gateway send failure'};
          }else {
            const seq=state.events.length+1;
            state.events.push({event_id:'fixture-'+seq,seq,kind:'message.user',
              actor:{kind:'user',id:'fixture'},payload:{text:params.payload?.text||''},created_at:1700000000+seq});
            result={accepted:true};
          }break;
        }
      }
      setTimeout(()=>{
        if(this.readyState!==1)return;
        this.onmessage?.({data:JSON.stringify(error
          ? {jsonrpc:'2.0',id:frame.id,error}
          : {jsonrpc:'2.0',id:frame.id,result})});
      },0);
    }
    close(){if(this.readyState===3)return;this.readyState=3;this.onclose?.();}
  }
  window.WebSocket=FixtureWebSocket;
  window.__HERMES_PLUGIN_SDK__ = {
    React, hooks:React, api, buildWsUrl:()=>'/api/ws',
    fetchJSON:async (url) => {
      if(url.includes('/diagnostics')) return {checks:[{id:'plugin_backend',label:'Plugin',required:true,status:'ok',detail:'Fixture only'}]};
      if(url.includes('/groups')) return {groups:[{id:'research',name:'Research',members:['default','researcher'],skills:[]}]};
      if(url.includes('/sessions')) return {sessions:[]};
      return {};
    }
  };
  window.__HERMES_PLUGINS__ = {
    register:(_id,component)=>{window.HermesFixturePage=component;},
    registerSlot:()=>{}
  };
</script>
<script src="/dashboard-plugins/hermes-bots-console/index-v055.js"></script>
<script>
  if (!window.HermesFixturePage) throw Error('Dashboard plugin did not register');
  ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(window.HermesFixturePage));
</script></body></html>`;

const server = createServer(async (request,response) => {
  try {
    const path = new URL(request.url || '/', 'http://localhost').pathname;
    if (path === '/' || path === '/bots') {
      response.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
      response.end(fixture); return;
    }
    const vendors = new Map([
      ['/vendor/react.js',join(root,'node_modules/react/umd/react.development.js')],
      ['/vendor/react-dom.js',join(root,'node_modules/react-dom/umd/react-dom.development.js')],
    ]);
    let source = vendors.get(path);
    if (!source && path.startsWith('/dashboard-plugins/hermes-bots-console/')) {
      const file = path.slice('/dashboard-plugins/hermes-bots-console/'.length);
      if (/^[a-zA-Z0-9_.-]+\.(?:js|css|mjs|json)$/.test(file)) source = join(dashboardDir,file);
    }
    if (!source) {response.writeHead(404);response.end();return;}
    const data = await readFile(source);
    response.writeHead(200,{'content-type':mime[extname(source)]||'application/octet-stream','cache-control':'no-store'});
    response.end(data);
  } catch(error) {
    response.writeHead(500); response.end(String(error?.message||error));
  }
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const port=server.address().port;
let browser;
try {
  browser = await chromium.launch({headless:true});
  const errors=[];
  const page = await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:1});
  page.on('pageerror',error=>errors.push(String(error?.message||error)));
  await page.goto(`http://127.0.0.1:${port}/bots`,{waitUntil:'domcontentloaded'});
  await page.locator('.hb-roster-screen').waitFor({state:'visible',timeout:20000});
  await page.getByText('Researcher',{exact:false}).first().waitFor({state:'visible'});
  await mkdir(join(root,'dist'),{recursive:true});
  await page.screenshot({path:join(root,'dist/browser-smoke-mobile.png'),fullPage:true});
  await page.goto(`http://127.0.0.1:${port}/bots?view=groups&profile=default`,{waitUntil:'domcontentloaded'});
  await page.locator('.hb-groups-view').waitFor({state:'visible',timeout:20000});
  await page.getByText('Research',{exact:true}).first().waitFor({state:'visible'});
  // Use the real GroupRoomView + RpcClient against a narrow JSON-RPC fixture,
  // including multi-page log replay, send and an explicit failed-send recovery.
  await page.goto(`http://127.0.0.1:${port}/bots?view=group&profile=default&group=research`,{waitUntil:'domcontentloaded'});
  await page.locator('.hb-group-message p').filter({hasText:'initial fixture message 3'}).waitFor({state:'visible',timeout:20000});
  const firstLog=await page.locator('.hb-group-message p').allTextContents();
  assert.deepEqual(firstLog,[
    'initial fixture message 1','initial fixture message 2','initial fixture message 3',
  ]);
  const requests=await page.evaluate(()=>window.__groupFixture.requests
    .filter(call=>call.method==='groups.log').map(call=>call.params.since_seq));
  assert.deepEqual(requests.slice(0,2),[0,2]);
  const composer=page.getByRole('textbox',{name:'Mensaje para el grupo'});
  await composer.fill('Fixture accepted message');
  await page.getByRole('button',{name:'Enviar al grupo'}).click();
  await page.locator('.hb-group-message p').filter({hasText:'Fixture accepted message'}).waitFor({state:'visible',timeout:20000});
  await page.evaluate(()=>{window.__groupFixture.failNextSend=true;});
  await composer.fill('Fixture unsent draft');
  await page.getByRole('button',{name:'Enviar al grupo'}).click();
  await page.locator('.hb-error').filter({hasText:'simulated Gateway send failure'}).waitFor({state:'visible',timeout:20000});
  assert.equal(await composer.inputValue(),'Fixture unsent draft');
  await page.screenshot({path:join(root,'dist/browser-smoke-group-interactions.png'),fullPage:true});
  await page.setViewportSize({width:1280,height:800});
  await page.goto(`http://127.0.0.1:${port}/bots`,{waitUntil:'domcontentloaded'});
  await page.locator('.hb-desktop-workspace').waitFor({state:'visible',timeout:20000});
  await page.screenshot({path:join(root,'dist/browser-smoke-desktop.png'),fullPage:true});
  if(errors.length) throw new Error(`Browser rendering errors: ${errors.join('; ')}`);
  console.log('Chromium fixture UI smoke passed (mobile, paginated native-group RPC, send/error recovery, desktop). Authenticated Gateway untested.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
