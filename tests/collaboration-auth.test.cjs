const assert = require('node:assert/strict');
const {before, after, test} = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const {chromium} = require('playwright');
let browser, server, origin;
const invite = 'a'.repeat(48);
before(async () => {
  server = http.createServer(async (req,res) => {
    const file = new URL(req.url,'http://localhost').pathname.slice(1);
    if (!['index.html','invitation.html','dashboard.html','scriptwriter.html','collaboration.js'].includes(file)) return res.writeHead(404).end();
    res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':'text/html'});
    res.end(await fs.readFile(path.join(__dirname,'..',file)));
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'msedge'}:{})});
});
after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});
async function open(t, url, options={}) {
  const context=await browser.newContext();t.after(()=>context.close());
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.fulfill({status:200,body:''}));
  await context.addInitScript(options=>{
    window.calls=[];
    let state = sessionStorage.getItem('mock-initialized') ? JSON.parse(sessionStorage.getItem('mock-user') || 'null') : (options.user ? {uid:'recipient',email:'recipient@example.test',emailVerified:options.verified!==false,...options.user}:null);
    sessionStorage.setItem('mock-initialized','yes');
    if(state)sessionStorage.setItem('mock-user',JSON.stringify(state));
    const callbacks=[];
    const hydrate = data=>data && Object.assign(data,{
      async updateProfile(value){Object.assign(state,value);sessionStorage.setItem('mock-user',JSON.stringify(state));},
      async sendEmailVerification(){sessionStorage.setItem('verification-sent','yes');},
      async reload(){if(window.mockVerified){state.emailVerified=true;sessionStorage.setItem('mock-user',JSON.stringify(state));}},
      async getIdToken(){return 'test-token';}
    });
    const auth={get currentUser(){return hydrate(state);},onAuthStateChanged(cb){callbacks.push(cb);setTimeout(()=>cb(hydrate(state)),0);},async signOut(){state=null;sessionStorage.removeItem('mock-user');callbacks.forEach(cb=>cb(null));},async createUserWithEmailAndPassword(email){state={uid:'recipient',email,emailVerified:false};hydrate(state);sessionStorage.setItem('mock-user',JSON.stringify(state));callbacks.forEach(cb=>cb(state));return {user:state};},async signInWithEmailAndPassword(email){state={uid:'recipient',email,emailVerified:true};hydrate(state);sessionStorage.setItem('mock-user',JSON.stringify(state));callbacks.forEach(cb=>cb(state));return {user:state};}};
    const functions=()=>({httpsCallable:name=>async data=>{
      calls.push({name,data});
      if(options.denied)throw {code:'functions/permission-denied'};
      if(name==='getProjectInvitation')return {data:{title:'Shared screenplay',ownerName:'Owner',role:'editor',status:options.status||'pending'}};
      if(name==='acceptProjectInvitation')return {data:{ownerUid:'owner',projectId:'script',role:'editor'}};
      return {data:{invitations:[]}};
    }});
    window.firebase={initializeApp(){},auth:()=>auth,functions,app:()=>({functions}),firestore:()=>({collection(){return this},doc(){return this},async get(){return {docs:[]}}})};
  },options);
  const page=await context.newPage();await page.goto(origin+url);return page;
}
test('new recipients see registration and retain invitation through account creation and verification',async t=>{
  const page=await open(t,`/index.html?invite=${invite}&mode=register`);
  await page.locator('#register-form').waitFor({state:'visible'});
  await page.locator('#reg-name').fill('Invited Writer');
  await page.locator('#reg-email').fill('recipient@example.test');
  await page.locator('#reg-password').fill('test-only-password');
  await page.locator('#btn-register').click();
  await page.waitForURL(`**/invitation.html?invite=${invite}`);
  await page.locator('#verify-actions').waitFor({state:'visible'});
  assert.match(await page.locator('#status').textContent(),/verification email was sent/i);
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('verification-sent')),'yes');
  assert.equal(await page.locator('#accept-button').isVisible(),false);
  assert.deepEqual(await page.evaluate(()=>calls),[]);
  await page.evaluate(()=>window.mockVerified=true);
  await page.locator('#verify-refresh').click();
  await page.locator('#accept-button').waitFor({state:'visible'});
  assert.equal(await page.locator('#title').textContent(),'Shared screenplay');
});
test('registered recipients retain invitation through sign-in and must explicitly accept',async t=>{
  const page=await open(t,`/index.html?invite=${invite}&mode=login`);
  await page.locator('#login-email').fill('recipient@example.test');
  await page.locator('#login-password').fill('test-password');
  await page.locator('#btn-signin').click();
  await page.waitForURL('**/invitation.html?invite=*');
  await page.locator('#accept-button').waitFor({state:'visible'});
  assert.deepEqual(await page.evaluate(()=>calls.map(c=>c.name)),['getProjectInvitation']);
  await page.route('**/scriptwriter.html?*',route=>route.fulfill({status:200,body:'Shared writer opened'}));
  await page.locator('#accept-button').click();
  await page.waitForURL('**/scriptwriter.html?project=script&owner=owner');
});
test('wrong-account invitations show a clear switch-account action without accepting',async t=>{
  const page=await open(t,`/invitation.html?invite=${invite}`,{user:{},denied:true});
  await page.waitForFunction(()=>document.getElementById('status').textContent.includes('cannot access'));
  assert.equal(await page.locator('#accept-button').isVisible(),false);
  await page.locator('#switch-account').click();
  await page.waitForURL(`**/index.html?invite=${invite}&mode=login`);
  await page.locator('#invite-notice').waitFor({state:'visible'});
  assert.equal(await page.locator('#invite-notice').isVisible(),true);
});
test('expired invitation does not offer acceptance',async t=>{
  const page=await open(t,`/invitation.html?invite=${invite}`,{user:{},status:'expired'});
  await page.waitForFunction(()=>document.getElementById('status').textContent.includes('no longer active'));
  assert.equal(await page.locator('#accept-button').isVisible(),false);
});
test('account cache switches isolate users and retain a recoverable legacy backup',async t=>{
  const page=await open(t,'/index.html');
  const result=await page.evaluate(()=>{
    localStorage.setItem('scriptwriter_v2',JSON.stringify({projects:[{id:'legacy'}]}));
    TSLInvite.prepareAccountCache('first');
    const quarantined=JSON.parse(localStorage.getItem('scriptwriter_v2_unclaimed')).projects[0].id;
    const firstEmpty=localStorage.getItem('scriptwriter_v2');
    localStorage.setItem('scriptwriter_v2',JSON.stringify({projects:[{id:'first-private'}]}));
    TSLInvite.prepareAccountCache('second');
    const secondEmpty=localStorage.getItem('scriptwriter_v2');
    TSLInvite.prepareAccountCache('first');
    return {quarantined,firstEmpty,secondEmpty,restored:JSON.parse(localStorage.getItem('scriptwriter_v2')).projects[0].id};
  });
  assert.deepEqual(result,{quarantined:'legacy',firstEmpty:null,secondEmpty:null,restored:'first-private'});
});
test('account cache moves large drafts under quota without duplicating active data',async t=>{
  const page=await open(t,'/index.html');
  const result=await page.evaluate(()=>{
    const first=JSON.stringify({projects:[{id:'first',text:'a'.repeat(2000)}]});
    const second=JSON.stringify({projects:[{id:'second',text:'b'.repeat(2000)}]});
    localStorage.setItem('tslwrite_cache_uid','first');localStorage.setItem('scriptwriter_v2',first);localStorage.setItem('scriptwriter_v2_account_second',second);
    const used=()=>Object.keys(localStorage).reduce((sum,key)=>sum+key.length+localStorage.getItem(key).length,0);
    const limit=used()+80,originalSet=Storage.prototype.setItem;
    Storage.prototype.setItem=function(key,value){const current=this.getItem(key),growth=String(key).length+String(value).length-(current===null?0:String(key).length+current.length);if(this===localStorage&&used()+growth>limit)throw new DOMException('Quota exceeded','QuotaExceededError');return originalSet.call(this,key,value);};
    try{TSLInvite.prepareAccountCache('second');return {uid:localStorage.getItem('tslwrite_cache_uid'),active:JSON.parse(localStorage.getItem('scriptwriter_v2')).projects[0].id,archived:JSON.parse(localStorage.getItem('scriptwriter_v2_account_first')).projects[0].id,duplicate:localStorage.getItem('scriptwriter_v2_account_second')};}
    finally{Storage.prototype.setItem=originalSet;}
  });
  assert.deepEqual(result,{uid:'second',active:'second',archived:'first',duplicate:null});
});
test('a failed account-cache move restores the original drafts and account marker',async t=>{
  const page=await open(t,'/index.html');
  const result=await page.evaluate(()=>{
    localStorage.setItem('tslwrite_cache_uid','first');localStorage.setItem('scriptwriter_v2','first-private');localStorage.setItem('scriptwriter_v2_account_second','second-private');
    const originalSet=Storage.prototype.setItem;
    Storage.prototype.setItem=function(key,value){if(this===localStorage&&key==='tslwrite_cache_uid'&&value==='second')throw new DOMException('Quota exceeded','QuotaExceededError');return originalSet.call(this,key,value);};
    let error='';try{TSLInvite.prepareAccountCache('second');}catch(caught){error=caught.message;}finally{Storage.prototype.setItem=originalSet;}
    return {error,uid:localStorage.getItem('tslwrite_cache_uid'),active:localStorage.getItem('scriptwriter_v2'),second:localStorage.getItem('scriptwriter_v2_account_second'),partialArchive:localStorage.getItem('scriptwriter_v2_account_first')};
  });
  assert.match(result.error,/original local drafts are preserved/);
  assert.equal(result.uid,'first');assert.equal(result.active,'first-private');assert.equal(result.second,'second-private');assert.equal(result.partialArchive,null);
});
