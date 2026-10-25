/* Consensual rider dispatch: SQL roster/jobs + scoped latest-point GPS map. */
(function (global) {
  "use strict";
  const $ = selector => document.querySelector(selector);
  const esc = value => String(value == null ? "" : value).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const money = value => "UGX " + Number(value || 0).toLocaleString("en-UG");
  let active=false, data=null, receivedAt=0, online=false, timer=null, controller=null, generation=0, pending=null, busy=false;
  let map=null, markers=null, tiles=null, fitted=false, selected="";
  const selections=new Map();
  const stateLabels={live:"Live GPS",stale:"Stale / last known",waiting:"Waiting for GPS",paused:"Sharing paused",unpaired:"Phone not paired",protected:"GPS protected",simulated:"Simulated GPS"};
  function pointOf(rider) {
    const p=rider.tracking?.point;
    return p && Number.isFinite(p.latitude) && Number.isFinite(p.longitude) && Math.abs(p.latitude)<=90 && Math.abs(p.longitude)<=180 ? p:null;
  }
  function locationState(rider) {
    const tracking=rider.tracking || {}, p=pointOf(rider);
    if (tracking.state!=="live") return tracking.state || "unpaired";
    if (!online || !p || p.age_seconds + Math.max(0,(Date.now()-receivedAt)/1000) > (data?.fresh_seconds || 90)) return "stale";
    return "live";
  }
  function age(p) {
    if (!p) return "No GPS fix yet";
    const seconds=Math.max(0,Math.floor((p.age_seconds || 0)+(Date.now()-receivedAt)/1000));
    return seconds<60 ? `${seconds}s ago` : seconds<3600 ? `${Math.floor(seconds/60)}m ago` : `${Math.floor(seconds/3600)}h ago`;
  }
  function status(message,error=false) {
    const node=$("#dispatchStatus"); if (node) {node.textContent=message;node.classList.toggle("is-error",error);node.hidden=!message;}
  }
  function pairCopy(kicker,help) {
    const k=$("#dispatchPairKicker"),h=$("#dispatchPairHelp");
    if(k)k.textContent=kicker;if(h)h.textContent=help;
  }
  function createMap() {
    if (map || !$("#dispatchMap") || !global.L) return;
    map=L.map("dispatchMap",{scrollWheelZoom:false,attributionControl:true}).setView([0.3136,32.5811],12);
    map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener noreferrer">Leaflet</a>');
    markers=L.layerGroup().addTo(map);L.control.scale({imperial:false}).addTo(map);
    map.on("click",()=>map.scrollWheelZoom.enable());
  }
  function renderMap() {
    createMap(); if (!map) return;
    map.invalidateSize();markers.clearLayers();
    const riders=(data?.riders || []).filter(r=>pointOf(r)), bounds=[];
    const overlay=$("#dispatchMapEmpty");
    if (overlay) {overlay.hidden=riders.length>0;overlay.textContent=data && !data.gps_access ? "GPS is private. Configure dispatch access to pair rider phones." : "No shared GPS positions yet. Pair a rider's Android phone and ask them to start duty.";}
    riders.forEach(rider=>{
      const p=pointOf(rider), state=locationState(rider), tone=state==="live"?"#15803d":state==="simulated"?"#9a6700":"#64748b";
      const marker=L.circleMarker([p.latitude,p.longitude],{radius:selected===rider.id?13:9,weight:3,color:"#fff",fillColor:tone,fillOpacity:1}).addTo(markers);
      const tooltip=document.createElement("div");tooltip.textContent=`${rider.name} · ${stateLabels[state]} · ${age(p)} · ±${Math.round(p.accuracy_m || 0)} m`;
      marker.bindTooltip(tooltip,{direction:"top"});marker.on("click",()=>selectRider(rider.id,false));bounds.push([p.latitude,p.longitude]);
      if (selected===rider.id) L.circle([p.latitude,p.longitude],{radius:Math.max(1,p.accuracy_m || 0),weight:1,color:tone,fillOpacity:.07}).addTo(markers);
    });
    if (!fitted && bounds.length) {map.fitBounds(bounds,{maxZoom:15,padding:[38,38]});fitted=true;}
  }
  function renderRiders() {
    const node=$("#riderList"); if (!node) return;
    const list=data?.riders || [];
    node.innerHTML=list.map(rider=>{
      const state=locationState(rider), p=pointOf(rider), phone=String(rider.phone || "").replace(/[^+0-9]/g,"");
      return `<article class="dc-rider ${selected===rider.id?"is-selected":""}">
        <div class="dc-rider-head"><span class="dc-avatar">${esc(rider.name.slice(0,1).toUpperCase())}</span><div><h3>${esc(rider.name)}</h3><p>${esc(rider.vehicle)}${rider.plate?` · ${esc(rider.plate)}`:""}</p></div><span class="dc-workload">${rider.active_jobs || 0}<small>active jobs</small></span></div>
        <div class="dc-rider-zone">${esc(rider.zone || "Service zone not set")}${phone?`<a href="tel:${esc(phone)}">Call rider ↗</a>`:""}</div>
        <div class="dc-state-row"><span class="dc-gps dc-gps-${esc(state)}">${esc(stateLabels[state] || state)}</span><span class="dc-availability">${esc(rider.status)}</span></div>
        <div class="dc-location"><strong>${p?`${p.latitude.toFixed(5)}, ${p.longitude.toFixed(5)}`:"Location not shared"}</strong><span>${age(p)}${p?` · accuracy ±${Math.round(p.accuracy_m)} m`:""}</span><small>${esc(rider.tracking?.device_label || "No device label")}</small></div>
        <div class="dc-rider-actions"><button class="btn sm" type="button" data-locate-rider="${esc(rider.id)}" ${p?"":"disabled"}>Locate</button><button class="btn sm" type="button" data-edit-rider="${esc(rider.id)}">Edit</button><button class="btn sm" type="button" data-app-code-rider="${esc(rider.id)}" ${busy?"disabled":""}>App code</button><button class="btn sm" type="button" data-pair-rider="${esc(rider.id)}" ${data.gps_access && !busy?"":"disabled"}>Pair phone</button></div>
        <div class="dc-rider-footer"><select aria-label="Availability for ${esc(rider.name)}" data-rider-availability="${esc(rider.id)}">${["Available","On delivery","Offline"].map(value=>`<option ${value===rider.status?"selected":""}>${value}</option>`).join("")}</select>${data.gps_access && !["unpaired","protected"].includes(state)?`<button type="button" class="dc-text-button" data-revoke-rider="${esc(rider.id)}">Revoke phone</button>`:""}<button type="button" class="dc-text-button" data-archive-rider="${esc(rider.id)}">Archive</button></div>
      </article>`;
    }).join("") || `<div class="dc-empty"><strong>Your rider roster starts here</strong><p>Add an authorized delivery partner, then pair their Android phone. No demonstration locations or riders are inserted into your store.</p><button class="btn primary" type="button" data-add-rider>Add delivery partner</button></div>`;
  }
  function renderOrders() {
    const node=$("#dispatchOrders"); if (!node) return;
    const jobs=data?.orders || [], riders=(data?.riders || []).filter(r=>r.status!=="Offline");
    node.innerHTML=jobs.map(order=>`<article class="dc-order"><div class="dc-order-top"><strong>${esc(order.id)}</strong><span class="dc-stage">${esc(order.progress?.stage || (order.rider_id?"assigned":"Ready to assign"))}</span></div><h3>${esc(order.customer_name)}</h3><p>${esc(order.address || order.area || "Confirm delivery address with customer")}</p>${order.notes?`<p class="dc-order-notes">${esc(order.notes)}</p>`:""}<div class="dc-order-meta"><span>${money(order.total)} · paid</span><button class="dc-text-button" type="button" data-open-order="${esc(order.id)}">Order details</button></div>${order.rider_id?`<p class="dc-order-rider">Assigned to <strong>${esc(order.rider_name)}</strong>${order.rider_wa_link?` · <a class="dc-text-button" href="${esc(order.rider_wa_link)}" target="_blank" rel="noopener noreferrer">Message rider on WhatsApp ↗</a>`:""}</p>`:""}<div class="dc-assign"><select aria-label="Choose rider for ${esc(order.id)}" data-dispatch-choice="${esc(order.id)}"><option value="">Choose delivery partner</option>${riders.map(r=>{const current=(selections.get(order.id) || order.rider_id)===r.id, off=r.status==="Offline"&&!current;return `<option value="${esc(r.id)}" ${current?"selected":""} ${off?"disabled":""}>${esc(r.name)} · ${r.active_jobs} jobs · ${esc(off?"offline":stateLabels[locationState(r)])}</option>`;}).join("")}</select><button class="btn primary" type="button" data-dispatch-assign="${esc(order.id)}" ${busy?"disabled":""}>${order.rider_id?"Reassign":"Assign & dispatch"}</button></div></article>`).join("") || '<div class="dc-empty compact"><strong>No deliveries waiting here</strong><p>Paid delivery orders appear after staff move them to In Assembly. Pickup, unpaid, cancelled and completed orders are not dispatched.</p><button type="button" class="btn" data-goto="sales">Open fulfillment & orders</button></div>';
    const count=$("#dispatchOrderCount");if(count)count.textContent=jobs.length;
  }
  function renderEvents() {
    const node=$("#dispatchEvents");if(!node)return;
    node.innerHTML=(data?.events || []).slice(0,8).map(event=>`<li><span class="dc-event-dot"></span><div><strong>${esc(event.order_id)} · ${esc(event.stage)}</strong><p>${esc(event.received_by?`Received by ${event.received_by}`:event.note || "Delivery update recorded")}</p><small>${esc(new Intl.DateTimeFormat("en-GB",{timeZone:"Africa/Kampala",day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"}).format(new Date(event.created_at)))} EAT</small></div></li>`).join("") || '<li class="dc-no-events">Assignments and rider-reported delivery steps will appear here.</li>';
  }
  function render() {
    if (!active) return;
    const riders=data?.riders || [], stats={partners:riders.length,live:riders.filter(r=>locationState(r)==="live").length,jobs:(data?.orders || []).filter(o=>o.rider_id).length,attention:riders.filter(r=>["stale","waiting","simulated"].includes(locationState(r))).length};
    Object.entries(stats).forEach(([key,value])=>{const el=$("#dcCount-"+key);if(el)el.textContent=value;});
    const privacy=$("#dispatchPrivacy");if(privacy){privacy.hidden=!data?.privacy_message;privacy.textContent=data?.privacy_message || "";}
    const sync=$("#dispatchSync");if(sync)sync.textContent=data?`${online?"Server connected":"Showing last saved response"} · ${new Intl.DateTimeFormat("en-GB",{timeZone:"Africa/Kampala",hour:"2-digit",minute:"2-digit",second:"2-digit"}).format(new Date(data.server_time))} EAT · refresh every 12s`:"Connecting to saved dispatch records…";
    renderRiders();renderOrders();renderEvents();renderMap();
  }
  async function refresh() {
    if (!active || pending) return pending;
    const request=generation, abort=new AbortController();controller=abort;
    const button=$("#btnRefreshDispatch");if(button)button.disabled=true;
    pending=(async()=>{
      try {
        const result=await DB.getDispatchBoard(abort.signal);
        if(request!==generation || abort.signal.aborted)return;
        data=result;receivedAt=Date.now();online=true;
        if($("#dispatchStatus")?.classList.contains("is-error"))status("");render();
      } catch(error) {
        if(request!==generation || abort.signal.aborted)return;
        online=false;status(error.message || "Dispatch could not refresh. GPS freshness is not confirmed.",true);render();
      } finally {if(request===generation){pending=null;controller=null;if(button)button.disabled=false;}}
    })();return pending;
  }
  function activate() {
    if (active) return;
    active=true;generation++;data=null;receivedAt=0;online=false;fitted=false;selected="";
    status("");render();refresh();timer=setInterval(()=>{renderMap();refresh();},12000);
  }
  function deactivate() {
    active=false;generation++;clearInterval(timer);timer=null;
    if(controller)controller.abort();controller=null;pending=null;data=null;online=false;selections.clear();selected="";
    if(markers)markers.clearLayers();["#riderList","#dispatchOrders","#dispatchEvents"].forEach(id=>{if($(id))$(id).innerHTML="";});
    const pair=$("#dispatchPairCard");if(pair)pair.hidden=true;
    ["#dispatchPairCode","#dispatchPairName","#dispatchPairExpiry"].forEach(id=>{if($(id))$(id).textContent="";});
    if (tiles && map) {map.removeLayer(tiles);tiles=null;const button=$("#btnDispatchStreetMap");if(button)button.textContent="Load street map";}
  }
  function selectRider(id,pan=true) {
    const rider=data?.riders.find(r=>r.id===id);if(!rider)return;
    selected=id;renderRiders();renderMap();
    const p=pointOf(rider);if(p && map && pan)map.setView([p.latitude,p.longitude],15);
    if(p)status(`${rider.name}: ${stateLabels[locationState(rider)]}. ${age(p)}; accuracy ±${Math.round(p.accuracy_m)} m. This is a reported GPS estimate, not an exact guarantee.`);
  }
  function assignedMessage(name,result){
    const notice=result&&result.rider_notice, first=Array.isArray(notice)?notice[0]:notice;
    if(!first) return `Delivery assigned to ${name}.`;
    return first.status==="sent" ? `Delivery assigned to ${name}. WhatsApp sent to the rider.` : `Delivery assigned to ${name}. WhatsApp was not sent automatically — use "Message rider on WhatsApp" on the order.`;
  }
  async function mutate(action,message) {
    if(busy)return;busy=true;const request=generation;
    try {const result=await action(request);if(request!==generation)return;status(typeof message==="function"?message(result):message);await refresh();}
    catch(error){if(request===generation)status(error.message,true);}
    finally {busy=false;if(active)render();}
  }
  document.addEventListener("click",event=>{
    if(!active)return;
    const target=event.target.closest("button");if(!target)return;
    if(target.matches("#btnRefreshDispatch")) {status("");return void refresh();}
    if(target.matches("#btnFitDispatch")){fitted=false;return renderMap();}
    if(target.matches("#btnDispatchStreetMap")) {
      createMap();if(!map)return status("Map could not open; rider coordinates remain available.",true);
      if(tiles){map.removeLayer(tiles);tiles=null;target.textContent="Load street map";return;}
      tiles=L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,attribution:'© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors'}).addTo(map);
      tiles.on("tileerror",()=>status("Street tiles could not load. GPS coordinates/markers still update; check the internet connection.",true));target.textContent="Hide street map";
      return status("Street map enabled. OpenStreetMap receives the viewed tile area, not rider names or phone numbers.");
    }
    if(target.hasAttribute("data-locate-rider"))return selectRider(target.dataset.locateRider);
    if(target.hasAttribute("data-add-rider"))return global.dispatchEvent(new CustomEvent("adonai-add-rider"));
    if(target.hasAttribute("data-pair-rider"))return void mutate(async request=>{
      const result=await DB.pairRiderPhone(target.dataset.pairRider);if(!active || request!==generation)return;
      const card=$("#dispatchPairCard");if(!card)return;card.hidden=false;
      $("#dispatchPairName").textContent=result.rider.name;$("#dispatchPairCode").textContent=result.code;
      $("#dispatchPairExpiry").textContent=`Single-use code · expires ${new Intl.DateTimeFormat("en-GB",{timeZone:"Africa/Kampala",hour:"2-digit",minute:"2-digit"}).format(new Date(result.expires_at))} EAT. Pairing alone does not start GPS.`;
      pairCopy("PAIR AN AUTHORIZED ANDROID PHONE","On the rider's updated Android app: Menu → Rider delivery app → enter this code. The rider then chooses Start sharing and permits Location + the visible tracking notification. A phone serial/IMEI is not required.");
    },"Phone code created. Ask the rider to enter it in the updated Android app and explicitly start duty.");
    if(target.hasAttribute("data-app-code-rider"))return void mutate(async request=>{
      const result=await DB.deliveryAppCode(target.dataset.appCodeRider);if(!active || request!==generation)return;
      const card=$("#dispatchPairCard");if(!card)return;card.hidden=false;
      $("#dispatchPairName").textContent=result.rider.name;$("#dispatchPairCode").textContent=result.code;
      $("#dispatchPairExpiry").textContent=`Single-use code · expires ${new Intl.DateTimeFormat("en-GB",{timeZone:"Africa/Kampala",hour:"2-digit",minute:"2-digit"}).format(new Date(result.expires_at))} EAT. This code does not start GPS.`;
      pairCopy("ADONAI DELIVERY · CONNECTION CODE","The rider signs in to Adonai Delivery (/delivery), checks in for the day with a selfie and signature, then enters this code on the Link step. The code links their account to this roster profile, works once and expires in 10 minutes. The rider sees only jobs assigned to them. Location sharing stays off until they start a duty separately, and this code never enables GPS.");
    },"Connection code ready. It links the rider's Adonai Delivery account only, and GPS stays off.");
    if(target.matches("#btnCloseDispatchPair")) {$("#dispatchPairCard").hidden=true;return;}
    if(target.hasAttribute("data-revoke-rider")) {
      if(global.confirm("Revoke this phone's pairing? New GPS uploads and access to its assigned deliveries will stop."))return void mutate(()=>DB.revokeRiderPhone(target.dataset.revokeRider),"Phone pairing revoked. The rider must pair again.");return;
    }
    if(target.hasAttribute("data-archive-rider")) {
      if(global.confirm("Archive this delivery partner? Historical assignments remain saved. Active jobs must be reassigned first."))return void mutate(()=>DB.removeRider(target.dataset.archiveRider),"Delivery partner archived; past assignments retained.");return;
    }
    if(target.hasAttribute("data-dispatch-assign")) {
      const id=target.dataset.dispatchAssign, choice=selections.get(id) || data.orders.find(o=>o.id===id)?.rider_id;
      if(!choice)return status("Choose a saved delivery partner before assigning.",true);
      const rider=data.riders.find(r=>r.id===choice);
      if(locationState(rider)!=="live" && !global.confirm(`${rider.name} does not have fresh live GPS. Assign anyway and contact the rider directly?`))return;
      return void mutate(()=>DB.assignRiderToOrder(id,choice),result=>assignedMessage(data.riders.find(r=>r.id===choice)?.name || "the rider",result));
    }
  });
  document.addEventListener("change",event=>{
    if(!active)return;
    if(event.target.matches("[data-dispatch-choice]"))selections.set(event.target.dataset.dispatchChoice,event.target.value);
    if(event.target.matches("[data-rider-availability]"))void mutate(()=>DB.updateRider(event.target.dataset.riderAvailability,{status:event.target.value}),"Rider availability saved to the server.");
  });
  global.addEventListener("pos-access-change",()=>{if(global.PosAccess && !PosAccess.canUse("orders"))deactivate();});
  document.addEventListener("visibilitychange",()=>{if(!document.hidden && active)refresh();});
  global.addEventListener("online",()=>{if(active)refresh();});
  global.addEventListener("pagehide",deactivate);
  global.DispatchCenter={activate,deactivate,refresh,render,pointOf,locationState};
})(window);
