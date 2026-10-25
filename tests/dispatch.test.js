"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const {JSDOM}=require("jsdom"),css=require("css-tree");
const source=name=>fs.readFileSync(path.join(__dirname,"..",name),"utf8");
const settle=()=>new Promise(resolve=>setTimeout(resolve,0));
function fixture(){
 const dom=new JSDOM(source("admin.html"),{url:"https://store.example/admin.html?view=dispatch",runScripts:"outside-only"});
 const win=dom.window,state={requests:0,assigned:[],paired:[],revoked:[],changes:[],locked:false,error:null,delay:null};
 const data={ok:true,gps_access:true,server_time:new Date().toISOString(),fresh_seconds:90,privacy_message:null,riders:[{id:"R1",name:'Andrew <script>',phone:"+256700111222",status:"Available",vehicle:"Motorbike",zone:"Kampala",active_jobs:0,tracking:{state:"live",device_label:"Paired Android",point:{latitude:.313,longitude:32.58,accuracy_m:15,age_seconds:2,fix_at:new Date().toISOString()}}},{id:"R2",name:"Paused partner",phone:"+256700000001",status:"Available",vehicle:"Van",zone:"Central",active_jobs:1,tracking:{state:"paused",point:null}}],orders:[{id:"O1",customer_name:'Sarah <img src=x onerror=alert(1)>',address:"Makerere",total:25000,paid:true,rider_id:null}],events:[]};
 win.confirm=()=>true;win.PosAccess={canUse:()=>!state.locked};
 win.DB={getDispatchBoard:async signal=>{state.requests++;if(state.delay)return state.delay;if(state.error)throw new Error(state.error);return structuredClone(data);},pairRiderPhone:async id=>{state.paired.push(id);return {rider:data.riders[0],code:"ABCDE-F2345",expires_at:new Date(Date.now()+600000).toISOString()};},deliveryAppCode:async id=>{state.appCodes=(state.appCodes||[]).concat(id);return {rider:data.riders[0],code:"APPCO-DEMO1",expires_at:new Date(Date.now()+600000).toISOString()};},assignRiderToOrder:async(id,rider)=>{state.assigned.push({id,rider});data.orders[0].rider_id=rider;data.orders[0].rider_name=data.riders.find(r=>r.id===rider).name;},updateRider:async(id,patch)=>{state.changes.push({id,patch});},revokeRiderPhone:async id=>state.revoked.push(id),removeRider:async()=>{}};
 win.eval(source("js/dispatch-center.js"));
 return{win,doc:win.document,data,state,close:()=>win.close()};
}
(async()=>{
 const f=fixture();
 try{
  f.win.DispatchCenter.activate();await settle();
  assert.equal(f.state.requests,1);assert.equal(f.doc.querySelectorAll(".dc-rider").length,2);assert.equal(f.doc.querySelector("#dcCount-live").textContent,"1");
  assert.equal(f.doc.querySelectorAll("#riderList script,#dispatchOrders img").length,0,"rider/customer names remain literal text");
  f.doc.querySelector('[data-locate-rider="R1"]').click();assert.match(f.doc.querySelector("#dispatchStatus").textContent,/accuracy ±15 m/);
  const choose=f.doc.querySelector('[data-dispatch-choice="O1"]');choose.value="R1";choose.dispatchEvent(new f.win.Event("change",{bubbles:true}));
  await f.win.DispatchCenter.refresh();assert.equal(f.doc.querySelector('[data-dispatch-choice="O1"]').value,"R1","refresh does not silently change a selected rider");
  f.doc.querySelector('[data-dispatch-assign="O1"]').click();await settle();await settle();assert.deepEqual(f.state.assigned,[{id:"O1",rider:"R1"}]);
  f.doc.querySelector('[data-pair-rider="R1"]').click();await settle();await settle();
  assert.equal(f.doc.querySelector("#dispatchPairCard").hidden,false);assert.equal(f.doc.querySelector("#dispatchPairCode").textContent,"ABCDE-F2345");
  assert.match(f.doc.querySelector("#dispatchPairExpiry").textContent,/does not start GPS/);
  const appCodeBtn=f.doc.querySelector('[data-app-code-rider="R1"]');
  assert.ok(appCodeBtn,"dispatch can issue a job-inbox-only Adonai Delivery code");
  appCodeBtn.click();await settle();await settle();await settle();
  assert.equal(f.doc.querySelector("#dispatchPairCode").textContent,"APPCO-DEMO1");
  assert.match(f.doc.querySelector("#dispatchPairKicker").textContent,/ADONAI DELIVERY/);
  assert.match(f.doc.querySelector("#dispatchPairHelp").textContent,/never enables GPS/);
  assert.match(f.doc.querySelector("#dispatchPairExpiry").textContent,/does not start GPS/);
  f.state.error="Server offline";await f.win.DispatchCenter.refresh();assert.equal(f.doc.querySelector("#dcCount-live").textContent,"0");assert.equal(f.win.DispatchCenter.locationState(f.data.riders[0]),"stale");
  assert.equal(f.doc.querySelectorAll(".dc-rider").length,2,"offline retains marked last-known information");
  f.state.locked=true;f.win.dispatchEvent(new f.win.Event("pos-access-change"));assert.equal(f.doc.querySelector("#riderList").textContent,"");assert.equal(f.doc.querySelector("#dispatchPairCode").textContent,"");
  console.log("✓ real dispatch controls, literal rider/customer text, fresh/stale GPS, preserved assignment choice, pairing consent instructions and scope-lock cleanup");
 }finally{f.close();}
 const late=fixture();
 try{
  let resolve;late.state.delay=new Promise(done=>{resolve=done;});late.win.DispatchCenter.activate();late.win.DispatchCenter.deactivate();resolve(late.data);await settle();assert.equal(late.doc.querySelectorAll(".dc-rider").length,0);
  console.log("✓ stale/late server responses cannot refill a hidden or locked location panel");
 }finally{late.close();}
 const browser=new JSDOM(source("rider.html"),{url:"https://store.example/rider.html",runScripts:"outside-only"});
 try{browser.window.eval(source("js/rider-app.js"));assert.equal(browser.window.document.querySelector("#riderStart").disabled,true);assert.match(browser.window.document.querySelector("#riderPlatformNotice").textContent,/location is not being read/);assert.equal(browser.window.localStorage.length,0);console.log("✓ honest browser/old-APK limitation: no false background GPS, no rider tokens or staff caches in browser storage");}finally{browser.window.close();}
 const native=new JSDOM(source("rider.html"),{url:"https://appassets.androidplatform.net/assets/public/rider.html",runScripts:"outside-only"});
 try{
  const win=native.window,doc=win.document;let started=0,stopped=0,paired=false,progressCalls=[];
  win.Android={riderTrackingState:()=>JSON.stringify({paired,rider_name:"Authorized rider",running:false,state:"stopped",message:"GPS is off"}),pairRiderPhone:(id,base,code,label)=>{paired=true;queueMicrotask(()=>win.__adonaiRiderResult(id,JSON.stringify({ok:true,rider:{name:"Authorized rider"}})));return true;},riderCommand:(id,action,payload)=>{if(action==="progress")progressCalls.push(JSON.parse(payload));queueMicrotask(()=>win.__adonaiRiderResult(id,JSON.stringify({ok:true,orders:[{id:"O1",customer_name:"Customer",address:"Kibuli",customer_phone:"+256700000000",progress:{stage:"assigned"}}]})));return true;},startRiderTracking:()=>{started++;},stopRiderTracking:()=>{stopped++;}};
  win.eval(source("js/rider-app.js"));doc.querySelector("#riderPairInput").value="ABCDE-F2345";doc.querySelector("#riderPairForm").dispatchEvent(new win.Event("submit",{bubbles:true,cancelable:true}));await settle();await settle();
  assert.equal(started,0,"pairing must never automatically start tracking");assert.equal(doc.querySelector("#riderPairInput").value,"");assert.equal(doc.querySelectorAll(".ra-job").length,1);
  doc.querySelector("#riderStart").click();assert.equal(started,1);doc.querySelector("#riderStop").click();assert.equal(stopped,1);
  assert.equal(win.localStorage.length,0);assert.equal(win.sessionStorage.length,0);
  console.log("✓ paired Android rider portal gets only assigned deliveries, requires explicit Start and Stop, and never stores native session secrets in JavaScript");
 }finally{native.window.close();}
 for(const file of ["css/dispatch.css","css/rider.css"])css.parse(source(file),{onParseError(error){throw error;}});
 const java=source("android/app/src/main/java/com/adonaithrift/pos/RiderTrackingService.java"),bridge=source("android/app/src/main/java/com/adonaithrift/pos/MainActivity.java"),manifest=source("android/app/src/main/AndroidManifest.xml");
 assert.match(manifest,/foregroundServiceType="location"/);assert.match(manifest,/android:name="\.RiderTrackingService" android:exported="false"/);assert.doesNotMatch(manifest,/READ_PHONE_STATE|READ_PRIVILEGED_PHONE_STATE|ACCESS_BACKGROUND_LOCATION|RECEIVE_BOOT_COMPLETED/);
 assert.match(java,/SystemClock.elapsedRealtime\(\)/);assert.match(java,/getImportance\(\)!=NotificationManager.IMPORTANCE_NONE/);assert.match(java,/answer.optBoolean\("ignored",false\)/);assert.match(bridge,/stopService\(new Intent\(MainActivity.this,RiderTrackingService.class\)\)/);
 assert.match(java,/START_NOT_STICKY/);assert.match(java,/Stop sharing/);assert.match(java,/removeUpdates\(this\)/);assert.match(java,/No route history|no route history/i);assert.match(bridge,/trustedRiderPage/);assert.match(bridge,/answer.remove\("session_token"\)/);
 assert.match(source("android/app/src/main/java/com/adonaithrift/pos/RiderApi.java"),/setInstanceFollowRedirects\(false\)/);
 assert.match(source("serve.py"),/https:\/\/tile.openstreetmap.org/);assert.match(source("js/dispatch-center.js"),/OpenStreetMap/);
 console.log("✓ responsive map/rider layouts, local Leaflet provenance, optional attributed street tiles, trusted HTTPS-only native service with notification/Stop and no serial/boot/covert background permissions");
})().catch(error=>{console.error(error);process.exitCode=1;});
