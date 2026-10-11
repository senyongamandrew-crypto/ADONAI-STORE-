/* Rider-only portal. Credentials/GPS live in app-private Android code, not JS. */
(function(global){
  "use strict";
  const $=id=>document.getElementById(id), android=global.Android;
  const supported=!!(android && typeof android.pairRiderPhone==="function" && typeof android.riderCommand==="function" && typeof android.startRiderTracking==="function");
  const esc=value=>String(value==null?"":value).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const instance=Array.from(global.crypto.getRandomValues(new Uint8Array(8)),n=>n.toString(16).padStart(2,"0")).join("");
  let next=0,requests=new Map(),loading=false,busy=false,online=false,orders=[],progress=null;
  function message(value,error=false){$("riderMessage").hidden=!value;$("riderMessage").textContent=value;$("riderMessage").classList.toggle("is-error",error);}
  function state(){try{return supported?JSON.parse(android.riderTrackingState()):{};}catch(_){return {};}}
  function paintState(){
    const current=state();$("riderIdentity").textContent=current.rider_name || "Connect to dispatch";$("riderPairState").textContent=current.paired?"PAIRED PHONE":"NOT PAIRED";
    $("riderSharingState").textContent=current.running?(current.state==="sharing"?"Sharing with dispatch":"Duty active · waiting / retrying"):"Not sharing";
    $("riderSharingMessage").textContent=current.message || "Pair this phone before starting a delivery duty.";
    $("riderSharingDot").classList.toggle("is-active",current.running===true);
    $("riderStart").disabled=!supported || !current.paired || current.running===true;$("riderStop").disabled=!supported || !current.paired;
    $("riderPairSubmit").disabled=!supported || busy || current.running===true;$("riderRefresh").disabled=!supported || !current.paired || loading;
    if(current.base && document.activeElement!==$("riderServer"))$("riderServer").value=current.base;
  }
  function request(invoke){
    if(!supported)return Promise.reject(new Error("Install the updated Android APK to pair this phone and use background GPS."));
    const id=instance+"-"+String(++next);return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{requests.delete(id);reject(new Error("Dispatch took too long. Check connection and refresh before retrying."));},24000);
      requests.set(id,{resolve,reject,timer});
      try{if(invoke(id)===false)throw new Error("This app could not start the request. Check pairing or update the APK.");}
      catch(error){clearTimeout(timer);requests.delete(id);reject(error);}
    });
  }
  global.__adonaiRiderResult=(id,json)=>{
    const pending=requests.get(id);if(!pending)return;requests.delete(id);clearTimeout(pending.timer);
    try{const data=JSON.parse(json);if(!data.ok)throw new Error(data.error || "Could not reach dispatch.");pending.resolve(data);}
    catch(error){pending.reject(error);}
  };
  function command(action,body={}){return request(id=>android.riderCommand(id,action,JSON.stringify(body)));}
  function renderOrders(){
    $("riderJobCount").textContent=orders.length;
    $("riderJobs").innerHTML=orders.map(order=>{
      const step=order.progress?.stage || "assigned",phone=String(order.customer_phone || "").replace(/[^+0-9]/g,"");
      const nextStage=({assigned:"accepted",accepted:"collected",collected:"arrived",arrived:"delivered",issue:"accepted"})[step];
      const label=({accepted:"Accept delivery",collected:"Collected from store",arrived:"Arrived at destination",delivered:"Confirm received delivery"})[nextStage];
      const query=order.address || order.area;
      return `<article class="ra-job"><div class="ra-job-top"><strong>${esc(order.id)}</strong><span>${esc(step)}</span></div><h3>${esc(order.customer_name)}</h3><p>${esc(query || "Confirm the customer address with dispatch")}</p>${order.notes?`<p class="ra-job-note">${esc(order.notes)}</p>`:""}<div class="ra-job-links">${phone?`<a href="tel:${esc(phone)}">Call customer ↗</a>`:""}${query?`<a href="https://www.google.com/maps/search/?api=1&amp;query=${encodeURIComponent(query)}" target="_blank" rel="noopener noreferrer">Open destination map ↗</a>`:""}</div><div class="ra-job-actions">${nextStage?`<button class="ra-button primary" type="button" data-rider-progress="${esc(order.id)}" data-stage="${esc(nextStage)}" ${busy || !online?"disabled":""}>${label}</button>`:""}<button class="ra-button" type="button" data-rider-progress="${esc(order.id)}" data-stage="issue" ${busy || !online?"disabled":""}>Report a problem</button></div></article>`;
    }).join("") || '<div class="ra-empty">No active deliveries assigned to this paired rider. Dispatch will allocate prepared, paid customer orders here.</div>';
  }
  async function refresh(){
    if(!supported || !state().paired || loading || busy)return;loading=true;paintState();
    try{const data=await command("me");online=true;if($("riderMessage").classList.contains("is-error"))message("");orders=data.orders || [];renderOrders();}
    catch(error){online=false;message(error.message,true);renderOrders();}
    finally{loading=false;paintState();}
  }
  $("riderPairForm").addEventListener("submit",async event=>{
    event.preventDefault();if(busy)return;busy=true;paintState();message("Pairing this phone; GPS remains off…");
    try{
      const base=$("riderServer").value.trim().replace(/\/$/,"");
      await request(id=>android.pairRiderPhone(id,base,$("riderPairInput").value.trim(),$("riderDeviceName").value.trim()));
      $("riderPairInput").value="";orders=[];message("Phone paired. Start sharing only when you are ready to begin delivery duty.");
    }catch(error){message(error.message,true);}finally{busy=false;paintState();await refresh();}
  });
  $("riderStart").addEventListener("click",()=>{if(!supported)return;android.startRiderTracking();message("Review the Android GPS-sharing confirmation and allow Location + notifications. Pairing alone never starts sharing.");});
  $("riderStop").addEventListener("click",()=>{if(!supported)return;android.stopRiderTracking();message("Stop requested on this phone. If offline, dispatch sees the old fix as stale until the stop is confirmed.");});
  $("riderRefresh").addEventListener("click",()=>{message("");refresh();});
  $("riderJobs").addEventListener("click",event=>{
    const button=event.target.closest("[data-rider-progress]");if(!button || busy)return;
    progress={order_id:button.dataset.riderProgress,stage:button.dataset.stage};
    $("riderProgressOrder").textContent=progress.order_id;$("riderProgressTitle").textContent=button.textContent;
    $("riderRecipient").value="";$("riderRecipient").required=progress.stage==="delivered";$("riderProgressNote").value="";$("riderProgressNote").required=progress.stage==="issue";
    $("riderProgressDialog").showModal();
  });
  $("riderCancelProgress").addEventListener("click",()=>$("riderProgressDialog").close());
  $("riderProgressForm").addEventListener("submit",async event=>{
    event.preventDefault();if(busy || !progress)return;busy=true;$("riderConfirmProgress").disabled=true;
    try{
      await command("progress",{...progress,received_by:$("riderRecipient").value.trim(),note:$("riderProgressNote").value.trim()});
      $("riderProgressDialog").close();message("Delivery update saved to dispatch. This does not charge the customer or change stock.");
    }catch(error){message(error.message,true);$("riderProgressDialog").close();}
    finally{busy=false;$("riderConfirmProgress").disabled=false;progress=null;await refresh();}
  });
  if(!supported){$("riderPlatformNotice").hidden=false;$("riderPlatformNotice").textContent="This is the rider-app interface. Android screen-lock GPS requires the updated, installed APK. A phone browser or older APK cannot start this native foreground service. Your location is not being read here.";}
  paintState();refresh();const timer=setInterval(()=>{paintState();if(!document.hidden)refresh();},12000);
  document.addEventListener("visibilitychange",()=>{if(!document.hidden){paintState();refresh();}});
  global.addEventListener("pagehide",()=>{clearInterval(timer);requests.forEach(p=>{clearTimeout(p.timer);p.reject(new Error("Rider page closed."));});requests.clear();});
  // Page close does NOT stop native duty: screen-lock/background tracking is
  // explicitly controlled by the ongoing notification/app Stop action instead.
})(window);
