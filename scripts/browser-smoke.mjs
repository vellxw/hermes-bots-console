// Real Chromium rendering smoke against a fixture Hermes SDK.
// Does NOT make network calls to, or certify, an authenticated Hermes gateway.
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

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
  await page.setViewportSize({width:1280,height:800});
  await page.goto(`http://127.0.0.1:${port}/bots`,{waitUntil:'domcontentloaded'});
  await page.locator('.hb-desktop-workspace').waitFor({state:'visible',timeout:20000});
  await page.screenshot({path:join(root,'dist/browser-smoke-desktop.png'),fullPage:true});
  if(errors.length) throw new Error(`Browser rendering errors: ${errors.join('; ')}`);
  console.log('Chromium fixture UI smoke passed (mobile, groups, desktop). Gateway untested.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
