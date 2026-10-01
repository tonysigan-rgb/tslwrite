const assert=require('node:assert/strict');
const {before,after,test}=require('node:test');
const fs=require('node:fs/promises');
const path=require('node:path');
const http=require('node:http');
const {chromium}=require('playwright');
let browser,server,origin;
before(async()=>{
  server=http.createServer(async(req,res)=>{const file=new URL(req.url,'http://localhost').pathname.slice(1);if(!['dashboard.html','collaboration.js'].includes(file))return res.writeHead(404).end();res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':'text/html'});res.end(await fs.readFile(path.join(__dirname,'..',file)));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'msedge'}:{})});
});
after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});
async function open(t, options={}){
  const context=await browser.newContext();t.after(()=>context.close());
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.fulfill({status:200,body:''}));
  await context.addInitScript(options=>{
    window.calls=[];window.writes=[];
    const own={id:'own-script',title:'My screenplay',format:'screenplay',blocks:[{type:'action',text:'Private draft'}],revision:3,collaborationEnabled:true,collaborationGeneration:'owned-generation'};
    const shared={id:'shared-script',title:'Invited screenplay',format:'screenplay',blocks:[{type:'action',text:'Shared draft'}],revision:7,collaborationEnabled:true,collaborationGeneration:'generation1'};
    const values={'users/owner-user/projects/own-script':own,'users/other-owner/projects/shared-script':shared};
    const projectInvites=[];
    const user={uid:'owner-user',email:'owner@example.test',displayName:'Writer',emailVerified:options.verified!==false,async reload(){if(window.mockVerified)this.emailVerified=true;},async getIdToken(){},async sendEmailVerification(){window.verificationSent=true;}};
    class Ref{
      constructor(path=''){this.path=path;this.id=path.split('/').pop();}
      collection(name){return new Ref(this.path?this.path+'/'+name:name)}
      doc(id){return new Ref(this.path+'/'+id)}
      async get(){
        if(this.path==='users/owner-user/projects')return {docs:[{id:own.id,data:()=>own}]};
        if(this.path==='users/owner-user/sharedProjects')return {docs:options.shared===false?[]:[{id:'pointer',data:()=>({ownerUid:'other-owner',projectId:shared.id,role:'viewer'})}]};
        if(this.path.endsWith('/folders'))return {docs:[]};
        return {id:this.id,exists:!!values[this.path],data:()=>({...values[this.path]})};
      }
      async set(value){writes.push({path:this.path,value});values[this.path]=value;}
      async delete(){writes.push({path:this.path,deleted:true});}
    }
    const db=new Ref();
    db.runTransaction=async fn=>fn({async get(ref){const doc=await ref.get();if(options.conflict&&doc.exists){const data=doc.data();data.revision++;return {...doc,data:()=>data};}return doc;},set(ref,payload){writes.push({path:ref.path,value:payload});values[ref.path]={...values[ref.path],...payload};}});
    const firestore=()=>db;firestore.FieldValue={serverTimestamp:()=>123456};
    const functions=()=>({httpsCallable:name=>async data=>{
      calls.push({name,data});
      if(name==='sendProjectInvitation'){
        if(options.sendError)throw {code:'functions/unavailable'};
        projectInvites.push({id:'b'.repeat(48),email:data.email,role:data.role,status:'pending',deliveryStatus:'sent'});
        return {data:{invitationId:'b'.repeat(48),deliveryStatus:'sent'}};
      }
      if(name==='listProjectAccess')return {data:{invitations:projectInvites}};
      if(name==='listMyInvitations')return {data:{invitations:[{id:'c'.repeat(48),title:'New invitation',ownerName:'Another writer',role:'editor',status:'pending'}]}};
      if(name==='revokeProjectAccess'){projectInvites[0].status='revoked';return {data:{status:'revoked'}};}
      return {data:{}};
    }});
    window.firebase={initializeApp(){},auth:()=>({onAuthStateChanged(callback){setTimeout(()=>callback(user),0);},async signOut(){}}),firestore,functions,app:()=>({functions})};
    if(options.legacy)localStorage.setItem('scriptwriter_v2',JSON.stringify({projects:[{id:'legacy-draft',title:'Local draft',blocks:[],revision:19,updatedAt:123,collaborationEnabled:true,collaborationGeneration:'old-generation',_conflict:true,_cloudKnown:true}]}));
    if(options.cachedOwn){localStorage.setItem('tslwrite_cache_uid',user.uid);localStorage.setItem('scriptwriter_v2',JSON.stringify({projects:[{...own,...options.cachedOwn}],currentProjectId:own.id}));}
    if(options.cacheFailure){localStorage.setItem('tslwrite_cache_uid','previous-user');localStorage.setItem('scriptwriter_v2',JSON.stringify({projects:[own]}));const originalSet=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key==='tslwrite_cache_uid'&&value===user.uid)throw new DOMException('Quota exceeded','QuotaExceededError');return originalSet.call(this,key,value);};}
  },options);
  const page=await context.newPage();await page.goto(origin+'/dashboard.html');
  if(options.cacheFailure){await page.getByRole('alert').waitFor();return page;}
  await page.locator('.script-library-card').first().waitFor();
  if(options.shared!==false)await page.getByRole('heading',{name:'Invited screenplay'}).waitFor();
  return page;
}
test('send invitation calls server, reports actual delivery, and supports revocation',async t=>{
  const page=await open(t);
  await page.getByRole('button',{name:'Share',exact:true}).click();
  await page.locator('#share-email').fill('New.Writer@example.test');
  await page.locator('#share-role').selectOption('editor');
  await page.locator('#send-invite').click();
  await page.waitForFunction(()=>document.getElementById('share-status').textContent.includes('Email invitation sent'));
  assert.deepEqual(await page.evaluate(()=>calls.find(c=>c.name==='sendProjectInvitation').data),{projectId:'own-script',email:'new.writer@example.test',role:'editor'});
  assert.match(await page.locator('#project-access-details').textContent(),/pending.*Email sent/);
  assert.equal(await page.evaluate(()=>localStorage.getItem('tslwrite_share_preferences')),null);
  await page.getByRole('button',{name:'Revoke',exact:true}).click();
  await page.waitForFunction(()=>document.getElementById('project-access-details').textContent.includes('revoked'));
  assert.equal(await page.evaluate(()=>calls.filter(c=>c.name==='revokeProjectAccess').length),1);
});
test('delivery failure stays in modal and does not claim success',async t=>{
  const page=await open(t,{sendError:true});
  await page.getByRole('button',{name:'Share',exact:true}).click();
  await page.locator('#share-email').fill('recipient@example.test');
  await page.locator('#send-invite').click();
  await page.waitForFunction(()=>document.getElementById('share-status').textContent.includes('No invitation was confirmed'));
  assert.equal(await page.locator('#share-modal').isVisible(),true);
  assert.equal(await page.locator('#send-invite').isEnabled(),true);
  assert.doesNotMatch(await page.locator('#share-status').textContent(),/Email invitation sent/);
});
test('unverified senders receive verification actions and cannot send invitations',async t=>{
  const page=await open(t,{verified:false});
  await page.getByRole('button',{name:'Share',exact:true}).click();
  assert.equal(await page.locator('#send-invite').isEnabled(),false);
  await page.locator('#share-verification').getByRole('button',{name:'Send verification email'}).click();
  assert.equal(await page.evaluate(()=>window.verificationSent),true);
  assert.equal(await page.evaluate(()=>calls.filter(c=>c.name==='sendProjectInvitation').length),0);
  await page.evaluate(()=>window.mockVerified=true);
  await page.locator('#share-verification').getByRole('button',{name:'I verified my email'}).click();
  assert.equal(await page.locator('#send-invite').isEnabled(),true);
});
test('shared projects open the owner project and never enter private cache or management controls',async t=>{
  const page=await open(t);
  const card=page.locator('.script-library-card').filter({has:page.getByRole('heading',{name:'Invited screenplay'})});
  assert.equal(await card.getByRole('button',{name:'Share',exact:true}).count(),0);
  assert.equal(await card.getByRole('button',{name:'Project options'}).count(),0);
  await page.evaluate(()=>persistProjects());
  assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('scriptwriter_v2')).projects.map(p=>p.id)),['own-script']);
  const written=await page.evaluate(async()=>{const shared=projects.find(p=>p._sharedOwner);return await syncProject(shared);});
  assert.equal(written,false);
  await page.route('**/scriptwriter.html?*',route=>route.fulfill({status:200,body:'Shared writer'}));
  await card.getByRole('button',{name:'Open script'}).click();
  await page.waitForURL('**/scriptwriter.html?project=shared-script&owner=other-owner');
});
test('in-app inbox links to explicit invitation review',async t=>{
  const page=await open(t);
  await page.locator('#invitation-bell').click();
  await page.getByRole('link',{name:'Review invitation'}).waitFor();
  assert.equal(await page.getByRole('link',{name:'Review invitation'}).getAttribute('href'),'invitation.html?invite='+'c'.repeat(48));
});
test('dashboard refuses stale revisions instead of overwriting another collaborator',async t=>{
  const page=await open(t,{conflict:true});
  const result=await page.evaluate(async()=>syncProject(projects.find(p=>p.id==='own-script')));
  assert.equal(result,false);assert.deepEqual(await page.evaluate(()=>writes),[]);
  assert.match(await page.locator('#toast').textContent(),/changed elsewhere/);
});
test('dashboard revisions advance transactionally without replacing server collaboration metadata',async t=>{
  const page=await open(t);
  const result=await page.evaluate(async()=>{const project=projects.find(p=>p.id==='own-script');project.title='Revised title';project._baseline='local-signature';project.revisions=[{label:'Local revision'}];return syncProject(project);});
  assert.equal(result,true);
  const [write]=await page.evaluate(()=>writes);
  assert.equal(write.path,'users/owner-user/projects/own-script');
  assert.equal(write.value.revision,4);
  assert.equal(write.value.title,'Revised title');
  assert.equal(write.value.updatedAt,123456);
  assert.equal(Object.hasOwn(write.value,'collaborationGeneration'),false);
  assert.equal(Object.hasOwn(write.value,'collaborationEnabled'),false);
  assert.equal(Object.keys(write.value).some(key=>key.startsWith('_')),false);
  assert.equal(Object.hasOwn(write.value,'revisions'),false);
  assert.equal(await page.evaluate(()=>projects.find(p=>p.id==='own-script').revision),4);
});
test('legacy drafts require explicit recovery and preserve a backup',async t=>{
  const page=await open(t,{legacy:true});
  await page.getByRole('button',{name:'Restore my local drafts'}).waitFor();
  assert.equal(await page.getByRole('heading',{name:'Local draft',exact:true}).count(),0);
  await page.getByRole('button',{name:'Restore my local drafts'}).click();
  await page.getByRole('heading',{name:'Local draft',exact:true}).waitFor();
  assert.ok(await page.evaluate(()=>localStorage.getItem('scriptwriter_v2_unclaimed_backup')));
  const restored=await page.evaluate(()=>projects.find(p=>p.title==='Local draft'));
  assert.notEqual(restored.id,'legacy-draft');
  assert.equal(restored._dirty,true);
  for(const key of ['revision','updatedAt','collaborationEnabled','collaborationGeneration','_conflict','_cloudKnown'])assert.equal(Object.hasOwn(restored,key),false);
});
test('visiting dashboard preserves an unsynced draft instead of replacing it with the cloud version',async t=>{
  const page=await open(t,{cachedOwn:{_dirty:true,blocks:[{type:'action',text:'Offline writing not yet uploaded'}]}});
  const result=await page.evaluate(()=>({project:projects.find(p=>p.id==='own-script'),cache:JSON.parse(localStorage.getItem('scriptwriter_v2')).projects.find(p=>p.id==='own-script')}));
  assert.equal(result.project.blocks[0].text,'Offline writing not yet uploaded');
  assert.equal(result.cache.blocks[0].text,'Offline writing not yet uploaded');
  assert.equal(result.cache._dirty,true);
  assert.equal(result.project._conflict,undefined);
});
test('dashboard flags conflicting offline drafts and refuses metadata saves until writer recovery',async t=>{
  const page=await open(t,{cachedOwn:{_dirty:true,revision:2,blocks:[{type:'action',text:'Conflicting offline writing'}]}});
  assert.equal(await page.evaluate(()=>projects.find(p=>p.id==='own-script')._conflict),true);
  const result=await page.evaluate(async()=>syncProject(projects.find(p=>p.id==='own-script')));
  assert.equal(result,false);
  assert.deepEqual(await page.evaluate(()=>writes),[]);
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('scriptwriter_v2')).projects.find(p=>p.id==='own-script').blocks[0].text),'Conflicting offline writing');
  await page.evaluate(()=>openProjectSettings('own-script'));
  assert.equal(await page.locator('#project-settings-modal').count(),0);
  assert.match(await page.locator('#toast').textContent(),/resolve.*conflicting/);
});
test('account-cache failure shows a visible recovery message instead of a hidden dashboard',async t=>{
  const page=await open(t,{cacheFailure:true});
  assert.equal(await page.evaluate(()=>document.body.classList.contains('auth-pending')),false);
  assert.match(await page.getByRole('alert').textContent(),/original local drafts are preserved/);
  assert.equal(await page.locator('.script-library-card').count(),0);
  assert.equal(await page.evaluate(()=>localStorage.getItem('tslwrite_cache_uid')),'previous-user');
  assert.deepEqual(await page.evaluate(()=>writes),[]);
});
