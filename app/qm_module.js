'use strict';

/* =====================================================================================
   LIGHTSPEED X-SERIES INTEGRATION LAYER  (added by QA build 2026-08-18)
   - Persistence: server (qm-state) + localStorage fallback + artifact storage
   - Users/roles, attribution, audit log
   - Deposits/partial payments -> Lightspeed LAYBY sale (revenue deferred until fully paid)
   - Idempotent sale/payment ids, retry-safe ops, guards on status transitions
   ===================================================================================== */
const LS_CFG = {
  base: 'https://hjcgqxszwqmzirtlaxze.supabase.co/functions/v1',
  anon: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhqY2dxeHN6d3FtemlydGxheHplIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYxMjg5ODgsImV4cCI6MjEwMTcwNDk4OH0.NeeSPn4xcX91-3nyK2o3N0i4XhTIsMe5MGCHvS-htbA',
  storePrefix: 'developerdemoxeqwzt',
  apiVersion: '2026-07',
  genericServiceSku: 'QM-SERVICE',
  build: 'QA-2026-08-18-LS1'
};
const uuid = () => (crypto && crypto.randomUUID) ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const r=Math.random()*16|0;return (c==='x'?r:(r&0x3|0x8)).toString(16);});
const ROLES = { associate:1, advisor:2, manager:3, admin:4 };
const PERMS = {
  take_deposit:'associate', edit_service:'advisor', complete_service:'advisor', refund:'manager', cancel:'manager', void:'manager',
  override_restriction:'manager', settings:'manager', users:'admin', delete_docs:'manager', reopen:'admin'
};
const LS_STATUS_LABEL = (ls)=>{ if(!ls||!ls.saleId) return '—'; if(ls.state==='voided') return 'Voided'; if(ls.state==='closed') return (ls.attrs||[]).includes('layby')?'Layaway – completed':'Completed'; if(ls.state==='pending') return 'Layaway (open)'; return ls.state||'?'; };

/* ---------- current user / roles ---------- */
function curUser(){
  const us = (db.settings.users||[]);
  let id = state.userId || localStorage.getItem('qm-current-user');
  let u = us.find(x=>x.id===id) || us[0] || {id:'u-local', name: db.settings.user||'User', role:'admin'};
  state.userId = u.id; return u;
}
function can(perm){ const u=curUser(); const need = ROLES[PERMS[perm]||'admin']||4; return (ROLES[u.role]||1) >= need; }
function requirePerm(perm, what){ if(can(perm)) return true; toast('Not permitted: '+(what||perm)+' requires '+(PERMS[perm]||'admin')+' role (you are '+curUser().role+')'); audit('denied', what||perm, null, 'role '+curUser().role); return false; }
function audit(action, entity, entityId, detail){
  db.audit = db.audit||[];
  const u = curUser();
  db.audit.push({id:uid(), at:Date.now(), userId:u.id, userName:u.name, action, entity, entityId:entityId||null, detail: detail==null?null:(typeof detail==='string'?detail:JSON.stringify(detail)).slice(0,2000)});
  if(db.audit.length>5000) db.audit = db.audit.slice(-4000);
}

/* ---------- migration of older documents ---------- */
function migrateDB(d){
  d.settings = d.settings||{};
  const s = d.settings;
  if(!Array.isArray(s.locations)) s.locations=[];
  // locations stay a string[] (original app contract); Lightspeed/tax mapping lives in settings.locationMap keyed by name
  s.locations = s.locations.map(l=>typeof l==='string'?l:(l&&l.name)).filter(Boolean);
  if(!s.locations.length || (s.locations.length===2&&s.locations[0]==='Mississauga'&&s.locations[1]==='Toronto')){
    const remap={'Mississauga':'Cambridge','Toronto':'Waterloo'};
    ['quotes','orders','invoices'].forEach(k=>(d[k]||[]).forEach(x=>{ if(remap[x.loc]) x.loc=remap[x.loc]; }));
    s.locations=['Cambridge','Waterloo','Montréal – TUDOR Royalmount'];
  }
  s.locationMap = s.locationMap||{};
  const TAXDEF={'Cambridge':{taxName:'HST',taxRate:13},'Waterloo':{taxName:'HST',taxRate:13},'Montréal – TUDOR Royalmount':{taxName:'GST+QST',taxRate:14.975},'Montréal – Rolex Boutique':{taxName:'GST+QST',taxRate:14.975}};
  s.locations.forEach(n=>{ s.locationMap[n]=Object.assign({lsOutletId:null,lsRegisterId:null,taxId:null,taxRate:null,taxName:null,allowedBrands:null}, TAXDEF[n]||{}, s.locationMap[n]||{}); });
  if(!s.users||!s.users.length) s.users=[{id:'u-al', name: s.user||'Al Sukara', role:'admin', pin:'1111', lsUserId:null}];
  s.ls = Object.assign({connected:false, store:null, retailerName:null, lastSync:null, ref:{outlets:[],registers:[],users:[],taxes:[],paymentTypes:[]}, paymentMap:{}, genericServiceProductId:null, noTaxId:null}, s.ls||{});
  if(!s.paymentMethods||!s.paymentMethods.length) s.paymentMethods=['Cash','Credit Card','Debit Card','E-transfer','Wire','Cheque','Gift Card','Other'];
  d.audit = d.audit||[];
  (d.orders||[]).forEach(o=>{
    o.createdBy = o.createdBy||null; o.createdAt = o.createdAt||(o.date?T(o.date+'T09:00'):Date.now()); o.assignedTo=o.assignedTo||null;
    o.ownership = o.ownership||'customer'; o.customerItem = o.customerItem||{brand:'',model:'',reference:'',serial:'',description:'',condition:'',accessories:'',warranty:'',notes:'',photos:[]};
    o.ls = o.ls||{saleId:null, receipt:null, state:null, attrs:[], lastSyncAt:null, error:null};
    o.completedAt=o.completedAt||null; o.completedBy=o.completedBy||null; o.cancelledAt=o.cancelledAt||null;
    o.items.forEach(it=>{ if(it.taxable===undefined) it.taxable=true; });
  });
  (d.invoices||[]).forEach(i=>{ i.orderId=i.orderId||null; i.ls=i.ls||{saleId:null,state:null,attrs:[]}; i.createdBy=i.createdBy||null; });
  (d.payments||[]).forEach(p=>{ p.kind=p.kind||'payment'; p.orderId=p.orderId||null; p.userId=p.userId||null; p.userName=p.userName||null; p.sync=p.sync||(p.lsPaymentId?'posted':'local'); p.lsPaymentId=p.lsPaymentId||null; p.opId=p.opId||null; });
  (d.contacts||[]).forEach(c=>{ c.lsCustomerId=c.lsCustomerId||null; });
  (d.products||[]).forEach(p=>{ p.lsProductId=p.lsProductId||null; p.storeOwned=!!p.storeOwned; p.brand=p.brand||''; });
  d.counters = Object.assign({quote:1,order:1,invoice:1,payment:1}, d.counters||{});
  d.v = 1; d.build = LS_CFG.build;
  return d;
}

/* ---------- persistence: server (shared) + localStorage + artifact storage ---------- */
const LOCAL_KEY = 'quotemachine-db-v1';
let serverVersion = 0, serverOK = false, saveInFlight = false, saveQueued = false;
async function sbFetch(path, opt={}){
  const headers = Object.assign({'Content-Type':'application/json','Authorization':'Bearer '+LS_CFG.anon,'apikey':LS_CFG.anon}, opt.headers||{});
  const r = await fetch(LS_CFG.base+path, Object.assign({}, opt, {headers}));
  const t = await r.text(); let j=null; try{ j=JSON.parse(t); }catch(e){ j={raw:t}; }
  return {status:r.status, ok:r.ok, j};
}
loadDB = async function(){
  // 1) server
  try{
    const r = await sbFetch('/qm-state');
    if(r.ok && r.j && r.j.exists && r.j.doc && r.j.doc.v===1){ serverVersion=r.j.version||0; serverOK=true; return r.j.doc; }
    if(r.ok){ serverOK=true; serverVersion=r.j.version||0; }
  }catch(e){ console.warn('server state unavailable', e); }
  // 2) artifact storage
  if(hasStore){ try{ const r=await window.storage.get(KEY); if(r&&r.value){ const d=JSON.parse(r.value); if(d&&d.v===1) return d; } }catch(e){} }
  // 3) localStorage
  try{ const raw=localStorage.getItem(LOCAL_KEY); if(raw){ const d=JSON.parse(raw); if(d&&d.v===1) return d; } }catch(e){}
  return null;
};
async function pushServer(){
  if(!serverOK) return;
  if(saveInFlight){ saveQueued=true; return; }
  saveInFlight=true;
  try{
    const r = await sbFetch('/qm-state',{method:'PUT', body: JSON.stringify({doc:db, base_version:serverVersion, user:curUser().name})});
    if(r.status===409 && r.j && r.j.conflict){
      // another user saved first: adopt server copy, re-render, surface conflict
      serverVersion = r.j.version||serverVersion;
      if(r.j.doc && r.j.doc.v===1){ db = migrateDB(r.j.doc); render(); }
      toast('Updated by '+(r.j.updated_by||'another user')+' — screen refreshed with latest data');
      audit('conflict','db',null,'server version '+serverVersion+' adopted; local changes since last sync were discarded');
    }else if(r.ok){ serverVersion = r.j.version||serverVersion; }
    else { console.warn('server save failed', r.status, r.j); }
  }catch(e){ console.warn('server save error', e); }
  finally{ saveInFlight=false; if(saveQueued){ saveQueued=false; pushServer(); } }
}
commit = function(){
  clearTimeout(saveT);
  saveT = setTimeout(async()=>{
    try{ localStorage.setItem(LOCAL_KEY, JSON.stringify(db)); }catch(e){ console.warn('localStorage save failed', e); }
    if(hasStore){ try{ await window.storage.set(KEY, JSON.stringify(db)); }catch(e){} }
    pushServer();
  },250);
};
bannerHTML = function(){
  if(serverOK||hasStore) return '';
  return '<div class="banner no-print"><i class="fa-solid fa-triangle-exclamation"></i><span>Shared server storage is unreachable — data is being kept in this browser only (localStorage). Changes made here are not visible to other users until the server is back.</span></div>';
};

/* ---------- tax per location ---------- */
function locOf(name){ const m=(db.settings.locationMap||{})[name]; return m?Object.assign({name},m):null; }
function locTaxRate(name){ const l=locOf(name); return (l&&l.taxRate!=null)?+l.taxRate:(+db.settings.taxRate||0); }
function locTaxName(name){ const l=locOf(name); return (l&&l.taxName)?l.taxName:(db.settings.taxName||'Tax'); }
totals = function(d){
  const rate = d&&d.loc ? locTaxRate(d.loc) : (+db.settings.taxRate||0);
  const sub=d.items.reduce((s,i)=>s+r2((+i.qty||0)*(+i.price||0)),0);
  const disc=r2(sub*((+d.discountPct||0)/100));
  const taxBase=d.items.reduce((s,i)=>s+(i.taxable?r2((+i.qty||0)*(+i.price||0)):0),0)*(1-((+d.discountPct||0)/100));
  const tax=r2(taxBase*(rate/100));
  return{sub:r2(sub),disc,tax,total:r2(sub-disc+tax),rate};
};
/* deposits ledger helpers (orders) */
const orderPays = o => db.payments.filter(p=>p.orderId===o.id);
const orderPaid = o => r2(orderPays(o).reduce((s,p)=>s+(+p.amount||0),0));
const orderBalance = o => r2(totals(o).total-orderPaid(o));
const orderLocked = {}; // in-flight lock per order (double-click / double-submit protection)

/* ---------- Lightspeed API client (via backend proxy; test store locked server-side) ---------- */
const LS = {
  async call(method, path, body, opts={}){
    const payload = {method, path, body, op_id: opts.opId||undefined, qm_user: curUser().name, meta: opts.meta||undefined};
    let lastErr=null;
    const tries = opts.retries!=null ? opts.retries : (method==='GET'||opts.opId ? 3 : 1); // mutating calls retry ONLY when idempotent (opId or client ids)
    for(let i=0;i<tries;i++){
      try{
        const r = await sbFetch('/lightspeed-api',{method:'POST', body:JSON.stringify(payload)});
        if(r.status===409 && r.j && r.j.error==='not_connected'){ const e=new Error('Lightspeed is not connected'); e.code='not_connected'; throw e; }
        if(r.status===502){ lastErr=new Error(r.j&&r.j.error||'network error at proxy'); await new Promise(res=>setTimeout(res,400*(i+1))); continue; }
        if(!r.ok){ const e=new Error('proxy '+r.status+': '+JSON.stringify(r.j).slice(0,200)); e.code='proxy'; throw e; }
        const out = r.j; // {status, data, replayed}
        if(out.status===429){ lastErr=new Error('rate limited'); await new Promise(res=>setTimeout(res,1000*(i+1))); continue; }
        return out;
      }catch(e){ if(e.code==='not_connected'||e.code==='proxy') throw e; lastErr=e; await new Promise(res=>setTimeout(res,400*(i+1))); }
    }
    throw lastErr||new Error('Lightspeed call failed');
  },
  connected(){ return !!(db.settings.ls&&db.settings.ls.connected); },
  async status(){
    try{ const r = await sbFetch('/lightspeed-oauth/status'); if(r.ok){ const c=r.j.connection; db.settings.ls.connected=!!r.j.connected; db.settings.ls.store=c?c.domain_prefix:null; db.settings.ls.retailerName=c?c.retailer_name:null; db.settings.ls.secretConfigured=!!r.j.secret_configured; db.settings.ls.scopes=c?c.scopes:null; db.settings.ls.tokenExpires=c?c.token_expires_at:null; return r.j; } }catch(e){}
    return null;
  },
  connectUrl(){ const ret = location.href.split('?')[0].split('#')[0]; return LS_CFG.base+'/lightspeed-oauth/start?return_to='+encodeURIComponent(ret); },
  /* reference data */
  async syncRef(){
    const s = db.settings.ls; const ref = s.ref;
    const g = async p => { const r = await LS.call('GET', p); if(r.status!==200) throw new Error('GET '+p+' -> '+r.status); return r.data.data||r.data; };
    ref.outlets = (await g('/api/2.0/outlets')).map(o=>({id:o.id,name:o.name,default_tax_id:o.default_tax_id,display_prices:o.display_prices}));
    ref.registers = (await g('/api/2.0/registers')).map(r=>({id:r.id,name:r.name,outlet_id:r.outlet_id,is_open:r.is_open}));
    ref.users = (await g('/api/2.0/users')).map(u=>({id:u.id,name:u.display_name||u.username,type:u.account_type,email:u.email}));
    ref.taxes = (await g('/api/2.0/taxes')).map(t=>({id:t.id,name:t.name,rate:(t.rates&&t.rates[0]?t.rates[0].rate:(t.rate||0)),is_default:t.is_default}));
    ref.paymentTypes = (await g('/api/2.0/payment_types')).filter(p=>!p.deleted_at&&!p.disabled).map(p=>({id:p.id,name:p.name,type_id:p.type_id,internal:p.internal}));
    const noTax = ref.taxes.find(t=>/no tax/i.test(t.name)); s.noTaxId = noTax?noTax.id:null;
    // auto-map locations by name
    db.settings.locations.forEach(n=>{
      const l = db.settings.locationMap[n] = db.settings.locationMap[n]||{};
      const o = ref.outlets.find(x=>x.name.trim().toLowerCase()===n.trim().toLowerCase());
      if(o&&!l.lsOutletId) l.lsOutletId=o.id;
      if(l.lsOutletId&&!l.lsRegisterId){ const rg=ref.registers.find(r=>r.outlet_id===l.lsOutletId); if(rg) l.lsRegisterId=rg.id; }
      if(!l.taxId){
        const want = l.taxRate!=null ? ref.taxes.find(t=>Math.abs(t.rate*100-(+l.taxRate))<0.001) : null;
        const t = want || ref.taxes.find(t=>t.id===(o&&o.default_tax_id)) || ref.taxes.find(t=>t.is_default);
        if(t){ l.taxId=t.id; if(l.taxRate==null) l.taxRate=r2(t.rate*100); if(!l.taxName) l.taxName=t.name; }
      }
    });
    // auto-map payment methods by name.
    // BUGFIX (T-SO-1): never auto-map a tender to Lightspeed "Store Credit" — the old /credit/i pattern
    // matched "Store Credit" before "Credit Card", so card deposits posted as store-credit redemptions and
    // Lightspeed 400'd the whole sale ("ensuring store credit customer") for customers with no credit account.
    const pm = s.paymentMap||{};
    const isStoreCredit = p => /store\s*credit/i.test(p.name);
    const scIds = ref.paymentTypes.filter(isStoreCredit).map(p=>p.id);
    const pool = ref.paymentTypes.filter(p=>!isStoreCredit(p));
    const find = re => pool.find(p=>re.test(p.name));
    const exact = n => pool.find(p=>p.name.trim().toLowerCase()===n.trim().toLowerCase());
    const defaults = {
      'Cash': exact('Cash')||find(/^cash$/i),
      'Credit Card': exact('Credit Card')||find(/credit\s*card/i)||find(/\bcredit\b/i)||find(/card/i),
      'Debit Card': exact('Debit Card')||find(/debit/i)||find(/card/i),
      'E-transfer': exact('E-transfer')||find(/e-?transfer|interac/i)||find(/^cash$/i),
      'Wire': exact('Wire')||find(/wire|e-?transfer/i)||find(/^cash$/i),
      'Cheque': exact('Cheque')||find(/cheque|check/i)||find(/^cash$/i),
      'Gift Card': exact('Gift Card')||find(/gift/i)||find(/^cash$/i),
      'Other': find(/other|manual/i)||find(/^cash$/i)||pool[0]
    };
    const validIds = new Set(ref.paymentTypes.map(p=>p.id));
    Object.keys(defaults).forEach(k=>{
      const cur = pm[k];
      const poisoned = cur && scIds.indexOf(cur)>=0;   // auto-poisoned by the old matcher — heal it
      const stale = cur && !validIds.has(cur);         // type deleted/disabled in Lightspeed
      if((!cur || poisoned || stale) && defaults[k]) pm[k]=defaults[k].id;
    });
    s.paymentMap = pm;
    // users: link by name/email
    (db.settings.users||[]).forEach(u=>{ if(!u.lsUserId){ const m=ref.users.find(x=>x.name&&u.name&&x.name.trim().toLowerCase()===u.name.trim().toLowerCase()); if(m) u.lsUserId=m.id; } });
    // ensure generic service product
    await LS.ensureGenericService();
    s.lastSync = Date.now(); commit(); return ref;
  },
  async ensureGenericService(){
    const s = db.settings.ls;
    if(s.genericServiceProductId) return s.genericServiceProductId;
    const r = await LS.call('GET','/api/2.0/search?type=products&sku='+encodeURIComponent(LS_CFG.genericServiceSku));
    const hit = r.status===200 && r.data.data && r.data.data[0];
    if(hit){ s.genericServiceProductId=hit.id; return hit.id; }
    const c = await LS.call('POST','/api/'+LS_CFG.apiVersion+'/products',{name:'Service / labour (QuoteMachine line)', sku:LS_CFG.genericServiceSku, price_excluding_tax:0, supply_price:0, description:'Generic service/labour line used by the Quotes & Invoicing app. Price is set per sale line.'},{opId:'ensure-generic-'+LS_CFG.genericServiceSku});
    if(c.status>=200&&c.status<300){ const id=(c.data.data&&c.data.data[0])||(c.data.data&&c.data.data.id); s.genericServiceProductId=id; commit(); return id; }
    throw new Error('could not create generic service product: '+c.status);
  },
  /* customers */
  async ensureCustomer(contact){
    if(!contact) throw new Error('A contact is required before taking a deposit (Lightspeed laybys need a customer)');
    if(contact.lsCustomerId) return contact.lsCustomerId;
    // 1) email match
    if(contact.email){ const r = await LS.call('GET','/api/2.0/search?type=customers&email='+encodeURIComponent(contact.email)); const hit=r.status===200&&r.data.data&&r.data.data.find(c=>(c.email||'').toLowerCase()===contact.email.toLowerCase()); if(hit){ contact.lsCustomerId=hit.id; audit('ls.customer.linked','contact',contact.id,{lsCustomerId:hit.id,by:'email'}); commit(); return hit.id; } }
    // 2) customer_code match (QM-<id>)
    { const r = await LS.call('GET','/api/2.0/search?type=customers&customer_code='+encodeURIComponent('QM-'+contact.id)); const hit=r.status===200&&r.data.data&&r.data.data[0]; if(hit){ contact.lsCustomerId=hit.id; commit(); return hit.id; } }
    // 3) create (idempotent by op id)
    const parts=(contact.name||'').trim().split(/\s+/); const first=parts.shift()||contact.name||'Customer'; const last=parts.join(' ')||'';
    const body={first_name:first,last_name:last,email:contact.email||undefined,phone:contact.phone||undefined,company_name:contact.company||undefined,customer_code:'QM-'+contact.id,note:(contact.notes||'').slice(0,500)||undefined};
    const r = await LS.call('POST','/api/2.0/customers',body,{opId:'customer-create-'+contact.id});
    if(r.status===201||r.status===200){ const id=r.data.data.id; contact.lsCustomerId=id; audit('ls.customer.created','contact',contact.id,{lsCustomerId:id}); commit(); return id; }
    if(r.status===409||r.status===400){ // maybe duplicate code/email -> search again
      const rr = await LS.call('GET','/api/2.0/search?type=customers&customer_code='+encodeURIComponent('QM-'+contact.id)); const hit=rr.status===200&&rr.data.data&&rr.data.data[0]; if(hit){ contact.lsCustomerId=hit.id; commit(); return hit.id; }
    }
    throw new Error('Lightspeed customer create failed: '+r.status+' '+JSON.stringify(r.data).slice(0,200));
  },
  /* products for lines */
  async ensureLineProduct(it){
    if(it.lsProductId) return it.lsProductId;
    if(it.sku){ const r=await LS.call('GET','/api/2.0/search?type=products&sku='+encodeURIComponent(it.sku)); const hit=r.status===200&&r.data.data&&r.data.data.find(p=>(p.sku||'').toLowerCase()===String(it.sku).toLowerCase()); if(hit){ it.lsProductId=hit.id; return hit.id; } }
    return await LS.ensureGenericService();
  },
  /* inventory lookup for store-owned lines */
  async stockFor(productId){ const r=await LS.call('GET','/api/2.0/products/'+productId+'/inventory'); return r.status===200?(r.data.data||[]):[]; },
  async searchProducts(q){ const r=await LS.call('GET','/api/2.0/search?type=products&page_size=20&'+(/^[A-Za-z0-9-]+$/.test(q)?'sku='+encodeURIComponent(q)+'&':'')+'name='+encodeURIComponent(q)); let list=r.status===200?(r.data.data||[]):[]; if(!list.length){ const r2=await LS.call('GET','/api/2.0/search?type=products&page_size=20&name='+encodeURIComponent(q)); list=r2.status===200?(r2.data.data||[]):[]; } return list; },
  /* sale payload (LAYBY) */
  async buildSale(o, state, overrideLines){
    const loc = locOf(o.loc)||{}; const s=db.settings.ls;
    if(!loc.lsOutletId||!loc.lsRegisterId) throw new Error('Location "'+o.loc+'" is not mapped to a Lightspeed outlet/register (Settings → Lightspeed)');
    const contact = C(o.contactId); const customerId = await LS.ensureCustomer(contact);
    const u = curUser(); const authorId = u.lsUserId || (db.settings.users.find(x=>x.lsUserId)||{}).lsUserId || null;
    if(!authorId) throw new Error('Current user is not mapped to a Lightspeed user (Settings → Users)');
    const creator = db.settings.users.find(x=>x.id===o.createdBy);
    const salespersonId = creator&&creator.lsUserId ? creator.lsUserId : null;
    const rate = locTaxRate(o.loc)/100; const taxId = loc.taxId; const noTax = s.noTaxId;
    const items = overrideLines || o.items;
    const lines=[];
    for(const it of items){
      const pid = await LS.ensureLineProduct(it);
      const qty=+it.qty||0, price=r2(+it.price||0); const disc=(+o.discountPct||0)/100;
      const unitAfterDisc = r2(price*(1-disc));
      const taxable = !!it.taxable && rate>0 && taxId;
      const taxAmt = taxable ? r2(unitAfterDisc*rate) : 0;
      const li = {product:{id:pid}, quantity:qty, pricing:{price:String(unitAfterDisc)}, tax:{id: taxable?taxId:(noTax||taxId), amount:String(taxAmt)}, note:((it.name||'')+(it.desc?' — '+it.desc:'')).slice(0,255)};
      if(it.lsLineId) li.id=it.lsLineId; if(salespersonId) li.salesperson_id=salespersonId;
      lines.push(li);
    }
    const payments = orderPays(o).filter(p=>p.sync!=='failed_permanent').map(p=>({id:p.lsPaymentId||p.id, type:{config_id: p.lsTypeConfigId||s.paymentMap[p.method]||s.paymentMap['Other']}, amount:String(r2(+p.amount)), date: (p.date && p.date!==todayISO()) ? new Date(p.date+'T12:00:00').toISOString() : new Date(p.at||Date.now()).toISOString()}));
    // attributes: 'layby' only. Adding 'service' makes the Lightspeed register demand completion of a
    // service job that doesn't exist (this app is the service system), which dead-locks "Continue sale"
    // at the counter. Layby alone enforces the accounting rule and continues cleanly in Lightspeed.
    return {id:o.ls.saleId, state, attributes:['layby'], source:{author_id:authorId, register_id:loc.lsRegisterId}, customer_id:customerId, note:(o.number+' — '+(o.serviceTitle||'service order')+' | QuoteMachine').slice(0,255), line_items:lines, payments};
  },
  async postSale(o, state, opts={}){
    if(!o.ls.saleId){ o.ls.saleId = uuid(); commit(); }
    const body = await LS.buildSale(o, state, opts.lines);
    const method = o.ls.created ? 'PUT' : 'POST';
    const path = '/api/'+LS_CFG.apiVersion+'/sales'+(method==='PUT'?'/'+o.ls.saleId:'');
    const r = await LS.call(method, path, body, {opId:(opts.opId||('sale-'+o.ls.saleId+'-'+Date.now())), meta:{op:opts.op||'sale', source_id:o.id, order_number:o.number}});
    if(r.status>=200&&r.status<300){ const d=r.data.data; o.ls.created=true; o.ls.state=d.state; o.ls.attrs=d.attributes||[]; o.ls.receipt=d.invoice_number; o.ls.lastSyncAt=Date.now(); o.ls.error=null; o.ls.totals=d.totals; o.ls.paid=(d.payments||[]).reduce((a,p)=>a+(+p.amount||0),0);
      // remember line ids
      (d.line_items||[]).forEach((li,i)=>{ if(o.items[i]&&!opts.lines) o.items[i].lsLineId=li.id; });
      // mark payments posted
      const ids=new Set((d.payments||[]).map(p=>p.id)); orderPays(o).forEach(p=>{ if(ids.has(p.lsPaymentId||p.id)){ p.lsPaymentId=p.lsPaymentId||p.id; p.sync='posted'; p.error=null; } });
      commit(); return d; }
    if(r.status===404 && method==='PUT'){ o.ls.created=false; commit(); return LS.postSale(o,state,opts); }
    if(method==='POST' && (r.status===409||r.status===400||r.status===422) && /exist|duplicate|already/i.test(JSON.stringify(r.data))){ o.ls.created=true; commit(); return LS.postSale(o,state,opts); }
    const msg='Lightspeed '+r.status+': '+JSON.stringify(r.data).slice(0,300); o.ls.error=msg; commit(); throw new Error(msg);
  },
  async refreshSale(o){ if(!o.ls.saleId) return null; const r=await LS.call('GET','/api/'+LS_CFG.apiVersion+'/sales/'+o.ls.saleId); if(r.status===200){ const d=r.data.data; o.ls.state=d.state; o.ls.attrs=d.attributes||[]; o.ls.receipt=d.invoice_number; o.ls.totals=d.totals; o.ls.paid=(d.payments||[]).reduce((a,p)=>a+(+p.amount||0),0); o.ls.lastSyncAt=Date.now(); o.ls.created=true; try{ if(typeof importLsPayments==='function') importLsPayments(o,d); }catch(e){ console.warn('register import failed', e); } commit(); return d; } if(r.status===404){ o.ls.created=false; } return null; }
};

/* ---------- order (service) view: intake, attribution, deposits ledger, Lightspeed status ---------- */
const OB2={open:['b-blue','Open'],in_progress:['b-gold','In progress'],ready:['b-gold','Ready for pickup'],completed:['b-green','Completed'],cancelled:['b-red','Cancelled']};
Object.assign(OB, OB2);
const ALLOWED_NEXT={open:['in_progress','ready'],in_progress:['open','ready'],ready:['in_progress','open'],completed:[],cancelled:[]};
function userName(id){ const u=(db.settings.users||[]).find(x=>x.id===id); return u?u.name:'—'; }
function usersSelect(sel, attr){ return '<select '+attr+'><option value="">— none —</option>'+(db.settings.users||[]).map(u=>'<option value="'+u.id+'"'+(sel===u.id?' selected':'')+'>'+esc(u.name)+' ('+u.role+')</option>').join('')+'</select>'; }
function pmSelect(id){ return '<select id="'+id+'">'+(db.settings.paymentMethods||[]).map(m=>'<option'+(m==='Cash'?' selected':'')+'>'+esc(m)+'</option>').join('')+'</select>'; }
function syncBadge(p){ const m={posted:['b-green','Posted'],pending:['b-gold','Sync pending'],failed:['b-red','Sync failed'],local:['b-gray','Local']}; const v=m[p.sync]||['b-gray',p.sync||'—']; return '<span class="badge '+v[0]+'" title="'+esc(p.error||'')+'">'+v[1]+'</span>'; }
VIEWS.order=function(){
  const o=O(state.id);
  if(!o){go('orders');return'';}
  const q=o.quoteId?Q(o.quoteId):null; const inv=db.invoices.find(i=>i.orderId===o.id);
  const t=totals(o), paid=orderPaid(o), bal=orderBalance(o), pays=orderPays(o).sort((a,b)=>a.at-b.at);
  const terminal = o.status==='completed'||o.status==='cancelled';
  const ci=o.customerItem||{};
  const msgs=o.messages.map(m=>'<div class="msg '+(m.me?'me':'them')+'"><div class="who">'+esc(m.from)+' · '+esc(fmtLong(m.at))+'</div>'+esc(m.text)+'</div>').join('')||'<p class="mut sm">No messages yet.</p>';
  const statusSel = '<select class="select" data-chg="orderStatus"'+(terminal?' disabled':'')+'>'+['open','in_progress','ready','completed','cancelled'].map(s=>'<option value="'+s+'"'+(o.status===s?' selected':'')+((s==='completed'||s==='cancelled')&&o.status!==s?' disabled':'')+'>'+OB[s][1]+'</option>').join('')+'</select>';
  const lsBadge = o.ls&&o.ls.saleId ? '<span class="badge '+(o.ls.state==='closed'?'b-green':o.ls.state==='voided'?'b-red':'b-gold')+'">LS: '+esc(LS_STATUS_LABEL(o.ls))+(o.ls.receipt?' #'+esc(o.ls.receipt):'')+'</span>' : '<span class="badge b-gray">LS: not posted</span>';
  const acts=[];
  if(!terminal){
    acts.push('<button class="b2 g" data-act="takeDeposit" data-id="'+o.id+'"'+(bal<=0?' disabled':'')+'><i class="fa-solid fa-dollar-sign"></i> Take deposit / payment</button>');
    acts.push('<button class="b2 p" data-act="completeOrder" data-id="'+o.id+'"><i class="fa-solid fa-check"></i> Complete &amp; close</button>');
    if(paid>0) acts.push('<button class="b2 o" data-act="refundDeposit" data-id="'+o.id+'"><i class="fa-solid fa-rotate-left"></i> Refund</button>');
    acts.push('<button class="b2 d" data-act="cancelOrder" data-id="'+o.id+'"><i class="fa-solid fa-ban"></i> Cancel service</button>');
  }
  if(o.ls&&o.ls.saleId) acts.push('<button class="b2 o" data-act="syncOrder" data-id="'+o.id+'"><i class="fa-solid fa-arrows-rotate"></i> Sync with Lightspeed</button>');
  if(inv) acts.push('<button class="b2 o" data-act="open" data-type="invoice" data-id="'+inv.id+'"><i class="fa-solid fa-file-invoice"></i> '+esc(inv.number)+'</button>');
  if(!terminal) acts.push('<button class="b2 o" data-act="addLsItem" data-id="'+o.id+'"><i class="fa-solid fa-box"></i> Add part / store item</button>');
  acts.push('<button class="b2 o" data-act="printOrder" data-id="'+o.id+'"><i class="fa-solid fa-print"></i> Print</button>');
  if(!o.ls.saleId && !pays.length) acts.push('<button class="b2 d" data-act="delOrder" data-id="'+o.id+'"><i class="fa-solid fa-trash"></i> Delete</button>');
  const payRows=pays.map(p=>'<tr><td class="num">'+esc(p.number)+'</td><td>'+esc(fmtLong(p.at))+'</td><td>'+esc(p.kind)+'</td><td>'+esc(p.method)+'</td><td>'+esc(p.userName||'—')+'</td><td>'+syncBadge(p)+(p.sync==='failed'?' <button class="b2 o" data-act="retrySync" data-id="'+o.id+'">Retry</button>':'')+'</td><td class="r">'+money(p.amount)+'</td></tr>').join('');
  const editable = !terminal;
  const inp=(f,v,ph)=>'<input data-ci="'+f+'" value="'+esc(v||'')+'" placeholder="'+esc(ph||'')+'"'+(editable?'':' disabled')+'>';
  const photos=(ci.photos||[]).map((p,i)=>'<span style="display:inline-block;position:relative;margin:4px"><img src="'+p.data+'" alt="photo" style="height:72px;border-radius:6px;border:1px solid var(--border)">'+(editable?'<button class="li-rm" data-act="rmPhoto" data-id="'+o.id+'" data-i="'+i+'" style="position:absolute;top:-6px;right:-6px">×</button>':'')+'</span>').join('');
  return'<div class="page-head"><h1 class="page-title">'+esc(o.number)+' '+badge(OB,o.status)+' '+lsBadge+'</h1>'+
  '<div class="actrow">'+statusSel+acts.join('')+'</div></div>'+
  '<div class="card" style="margin-bottom:22px"><div class="panel"><h3>Service order details</h3><div class="fgrid">'+
    '<div class="fld"><label>Customer</label><div><a data-act="open" data-type="contact" data-id="'+esc(o.contactId||'')+'">'+esc(cname(o.contactId))+'</a>'+(C(o.contactId)&&C(o.contactId).lsCustomerId?' <span class="badge b-green">LS customer</span>':'')+'</div></div>'+
    '<div class="fld"><label>Date</label><div>'+fmtD(o.date)+'</div></div>'+
    '<div class="fld"><label>From estimate</label><div>'+(q?'<a data-act="open" data-type="quote-doc" data-id="'+q.id+'">'+esc(q.number)+'</a>':'—')+'</div></div>'+
    '<div class="fld"><label>Location</label><div>'+esc(o.loc||'—')+'</div></div>'+
    '<div class="fld"><label>Created by (original salesperson)</label><div>'+esc(userName(o.createdBy))+'</div></div>'+
    '<div class="fld"><label>Assigned to (servicing)</label>'+usersSelect(o.assignedTo,'data-chg="orderAssign"'+(editable?'':' disabled'))+'</div>'+
    '<div class="fld"><label>Completed by</label><div>'+(o.completedBy?esc(userName(o.completedBy))+' · '+esc(fmtLong(o.completedAt)):'—')+'</div></div>'+
    '<div class="fld"><label>Lightspeed sale</label><div>'+(o.ls.saleId?'<code style="font-size:11px">'+esc(o.ls.saleId)+'</code><br>'+esc(LS_STATUS_LABEL(o.ls))+(o.ls.lastSyncAt?' · synced '+esc(fmtLong(o.ls.lastSyncAt)):''):'not created yet (created when first deposit is taken)')+(o.ls.error?'<div class="mut sm" style="color:var(--red)">'+esc(o.ls.error)+'</div>':'')+'</div></div>'+
  '</div></div>'+
  '<div class="panel"><h3>Customer item (intake)</h3><div class="fgrid">'+
    '<div class="fld"><label>Ownership</label><select data-chg="ownership"'+(editable?'':' disabled')+'><option value="customer"'+(o.ownership==='customer'?' selected':'')+'>Customer-owned property (not inventory)</option><option value="store"'+(o.ownership==='store'?' selected':'')+'>Raffi-owned merchandise</option></select></div>'+
    '<div class="fld"><label>Brand</label>'+inp('brand',ci.brand,'e.g. Rolex')+'</div>'+
    '<div class="fld"><label>Model</label>'+inp('model',ci.model,'e.g. Datejust 36')+'</div>'+
    '<div class="fld"><label>Reference</label>'+inp('reference',ci.reference,'e.g. 126234')+'</div>'+
    '<div class="fld"><label>Serial number</label>'+inp('serial',ci.serial,'')+'</div>'+
    '<div class="fld"><label>Warranty</label>'+inp('warranty',ci.warranty,'e.g. In warranty until 2027-03')+'</div>'+
    '<div class="fld wide"><label>Customer description</label>'+inp('description',ci.description,'')+'</div>'+
    '<div class="fld wide"><label>Condition at intake</label>'+inp('condition',ci.condition,'')+'</div>'+
    '<div class="fld wide"><label>Accessories received</label>'+inp('accessories',ci.accessories,'box, papers, links…')+'</div>'+
    '<div class="fld wide"><label>Service notes (internal)</label><textarea data-ci="notes"'+(editable?'':' disabled')+'>'+esc(ci.notes||'')+'</textarea></div>'+
    '<div class="fld wide"><label>Photos ('+(ci.photos||[]).length+'/6)</label><div>'+photos+'</div>'+(editable?'<label class="b2 o" style="cursor:pointer;display:inline-block;margin-top:6px"><i class="fa-solid fa-camera"></i> Add photo<input type="file" accept="image/*" multiple data-chg="addPhoto" style="display:none"></label>':'')+'</div>'+
  '</div></div>'+
  '<table class="tbl"><thead><tr><th>Item</th><th class="r">Qty</th><th class="r">Price</th><th class="r">Tax</th><th class="r">Amount</th>'+(editable?'<th></th>':'')+'</tr></thead><tbody>'+
  o.items.map((it,i)=>'<tr><td>'+esc(it.name)+(it.desc?'<div class="mut sm">'+esc(it.desc)+'</div>':'')+(it.storeOwned?' <span class="badge b-blue">store stock'+(it.sku?' · '+esc(it.sku):'')+'</span>':'')+(it.lsProductId&&!it.storeOwned?' <span class="badge b-gray">catalogue</span>':'')+'</td><td class="r">'+(+it.qty||0)+'</td><td class="r">'+money(it.price)+'</td><td class="r">'+(it.taxable?esc(locTaxName(o.loc)):'—')+'</td><td class="r">'+money((+it.qty||0)*(+it.price||0))+'</td>'+(editable?'<td class="r"><button class="li-rm" data-act="rmOrderLine" data-id="'+o.id+'" data-i="'+i+'" aria-label="Remove"><i class="fa-solid fa-xmark"></i></button></td>':'')+'</tr>').join('')+
  '<tr><td colspan="'+(editable?5:4)+'" class="r mut">Subtotal</td><td class="r">'+money(t.sub)+'</td></tr>'+(t.disc>0?'<tr><td colspan="'+(editable?5:4)+'" class="r mut">Discount</td><td class="r">−'+money(t.disc)+'</td></tr>':'')+
  '<tr><td colspan="'+(editable?5:4)+'" class="r mut">'+esc(locTaxName(o.loc))+' ('+t.rate+'%)</td><td class="r">'+money(t.tax)+'</td></tr>'+
  '<tr><td colspan="'+(editable?5:4)+'" class="r" style="font-weight:700">Service value (total)</td><td class="r" style="font-weight:700">'+money(t.total)+'</td></tr>'+
  '<tr><td colspan="'+(editable?5:4)+'" class="r mut">Deposits / payments received (net)</td><td class="r">'+money(paid)+'</td></tr>'+
  '<tr><td colspan="'+(editable?5:4)+'" class="r" style="font-weight:700;border-bottom:none">Remaining balance</td><td class="r" style="font-weight:700;border-bottom:none">'+money(bal)+'</td></tr></tbody></table>'+
  (editable?'<div class="panel"><div class="actrow"><button class="b2 o" data-act="addOrderLine" data-id="'+o.id+'"><i class="fa-solid fa-plus"></i> Add service / labour line</button><span class="mut sm">Adding or removing lines after a deposit re-syncs the open Lightspeed layaway (allowed while open).</span></div></div>':'')+
  '</div>'+
  '<div class="card" style="margin-bottom:22px"><div class="panel"><h3>Deposits &amp; payments ledger ('+pays.length+')</h3>'+
  (pays.length?'<div style="overflow-x:auto"><table class="tbl"><thead><tr><th>#</th><th>When</th><th>Kind</th><th>Method</th><th>Processed by</th><th>Lightspeed</th><th class="r">Amount</th></tr></thead><tbody>'+payRows+'</tbody></table></div>':'<p class="mut sm">No deposits yet. Deposits post to Lightspeed as a <b>layaway</b> payment — they are held as unearned revenue and are <b>not</b> counted as sales until the service is completed and paid in full.</p>')+
  '</div></div>'+
  '<div class="card"><div class="panel"><h3>Chat with '+esc(cname(o.contactId))+'</h3><div class="chat">'+msgs+'</div>'+
  '<div class="chat-in"><input id="chatmsg" placeholder="Write a message…"><button class="b2 p" data-act="sendMsg" data-id="'+o.id+'"><i class="fa-solid fa-paper-plane"></i> Send</button></div></div></div>';
};

/* ---------- handlers: deposits / payments ---------- */
function payModal(o, kind){
  const bal=orderBalance(o), paid=orderPaid(o);
  const isRefund = kind==='refund';
  const title = isRefund ? 'Refund deposit — '+o.number : 'Take deposit / payment — '+o.number;
  const max = isRefund ? paid : bal;
  openModal(title,
    '<div class="fgrid">'+
    '<div class="fld"><label>'+(isRefund?'Refund amount (max '+money(paid)+')':'Amount (balance '+money(bal)+')')+'</label><input id="pay-amt" type="number" min="0.01" step="0.01" max="'+max+'" value="'+(isRefund?'':bal)+'"></div>'+
    '<div class="fld"><label>Method</label>'+pmSelect('pay-method')+'</div>'+
    '<div class="fld"><label>Processed by</label><div style="padding-top:9px">'+esc(curUser().name)+' ('+curUser().role+')</div></div>'+
    '<div class="fld"><label>Date</label><input id="pay-date" type="date" value="'+todayISO()+'"></div>'+
    '<div class="fld wide"><label>Reference / note</label><input id="pay-note" placeholder="Terminal ref, cheque #, reason…"></div>'+
    (isRefund?'':'<div class="fld wide"><label style="display:flex;align-items:center;gap:8px;cursor:pointer" onclick="event.stopPropagation()"><input type="checkbox" id="pay-complete" style="width:auto;flex:none"'+(o.status==='ready'?' checked':'')+'> Complete service &amp; close sale if this pays the balance in full</label></div>')+
    '<div class="fld wide mut sm">'+(isRefund?'Refunds post to Lightspeed as a negative layaway payment on the same sale (audit trail retained).':'Recommended: <b>Create layaway — take at register</b> pushes the sale into Lightspeed so the rep collects the money at the register (terminal / cash drawer); the payment flows back here automatically and is held as unearned revenue. Use <b>Record payment</b> only for money already collected outside the register (e-transfer, wire, phone). Revenue is recognised only when the service is completed and the balance is $0.')+'</div>'+
    '</div>',
    '<button class="b2 o" data-act="closeModal">Cancel</button>'+(isRefund
      ?'<button class="b2 d" id="pay-submit" data-act="doRefund" data-id="'+o.id+'"><i class="fa-solid fa-check"></i> Record refund</button>'
      :'<button class="b2 o" data-act="doDeposit" data-id="'+o.id+'">Record payment (outside register)</button><button class="b2 g" id="pay-submit" data-act="toRegister" data-id="'+o.id+'"><i class="fa-solid fa-cash-register"></i> Create layaway — take at register</button>'));
}
function newPayment(o, kind, amt, method, date, note){
  const u=curUser();
  const p={id:uuid(), number:'PAY-'+pad4(db.counters.payment++), kind, orderId:o.id, invoiceId:(db.invoices.find(i=>i.orderId===o.id)||{}).id||null, contactId:o.contactId, amount:r2(amt), method, date:date||todayISO(), note:(note||'').trim(), at:Date.now(), userId:u.id, userName:u.name, opId:uuid(), lsPaymentId:null, sync:'local', error:null};
  db.payments.push(p); return p;
}
async function postOrderSale(o, state, opts={}){
  if(!LS.connected()){ orderPays(o).forEach(p=>{ if(p.sync==='local'||p.sync==='pending') p.sync='pending'; }); o.ls.error='Lightspeed not connected — will post when connected'; commit(); return null; }
  const d = await LS.postSale(o, state, opts);
  return d;
}
async function withLock(o, fn){
  if(orderLocked[o.id]){ toast('Please wait — a payment is already being processed for '+o.number); return; }
  orderLocked[o.id]=true; const btn=$('#pay-submit'); if(btn){ btn.disabled=true; btn.textContent='Processing…'; }
  try{ await fn(); } finally{ delete orderLocked[o.id]; }
}
ACT.takeDeposit=d=>{ const o=O(d.id); if(!o) return; if(!requirePerm('take_deposit','take a deposit')) return; if(o.status==='completed'||o.status==='cancelled'){ toast('Order is '+o.status); return; } if(!o.contactId||!C(o.contactId)){ toast('Select a customer on the order (estimate) first — Lightspeed laybys require a customer.'); return; } if(orderBalance(o)<=0){ toast('Balance is already $0'); return; } payModal(o,'deposit'); };
ACT.refundDeposit=d=>{ const o=O(d.id); if(!o) return; if(!requirePerm('refund','refund a deposit')) return; if(orderPaid(o)<=0){ toast('Nothing to refund'); return; } payModal(o,'refund'); };
ACT.doDeposit=async d=>{
  const o=O(d.id); if(!o) return;
  const amt=r2(+$('#pay-amt').value), method=$('#pay-method').value, date=$('#pay-date').value, note=$('#pay-note').value, wantComplete=$('#pay-complete')&&$('#pay-complete').checked;
  const bal=orderBalance(o);
  if(!(amt>0)){ toast('Enter an amount'); return; }
  if(amt>bal+0.004){ toast('Amount exceeds the remaining balance ('+money(bal)+'). Overpayment is blocked.'); return; }
  await withLock(o, async()=>{
    const kind = Math.abs(bal-amt)<0.005 ? 'final' : 'deposit';
    const p=newPayment(o, kind, amt, method, date, note);
    audit('payment.recorded','order',o.id,{number:p.number,kind,amount:amt,method});
    commit();
    const closeNow = kind==='final' && wantComplete;
    try{
      p.sync='pending'; commit();
      const dd = await postOrderSale(o, closeNow?'closed':'pending', {opId:p.opId, op:closeNow?'final+close':'deposit'});
      if(dd && closeNow){ o.status='completed'; o.completedAt=Date.now(); o.completedBy=curUser().id; ensureInvoiceForOrder(o); logAct('check',curUser().name,[{t:curUser().name+' completed '},{l:o.number,v:'order',id:o.id},{t:' (paid in full, Lightspeed sale closed)'}],null); audit('order.completed','order',o.id,{via:'final payment'}); }
      logAct('dollar-sign',curUser().name,[{l:cname(o.contactId),v:'contact',id:o.contactId},{t:' paid '+money(amt)+' ('+kind+', '+method+') on '},{l:o.number,v:'order',id:o.id}],p.note||null);
      closeModal(); commit(); render(); toast(p.number+' recorded — balance '+money(orderBalance(o))+(o.ls.receipt?' · LS receipt #'+o.ls.receipt:''));
    }catch(e){
      p.sync='failed'; p.error=String(e.message||e); audit('payment.sync_failed','order',o.id,{number:p.number,error:p.error}); commit(); closeModal(); render();
      toast('Payment recorded locally but Lightspeed sync failed: '+p.error.slice(0,120)+' — use Retry');
    }
  });
};
ACT.doRefund=async d=>{
  const o=O(d.id); if(!o) return;
  const amt=r2(+$('#pay-amt').value), method=$('#pay-method').value, date=$('#pay-date').value, note=$('#pay-note').value;
  const paid=orderPaid(o);
  if(!(amt>0)){ toast('Enter an amount'); return; }
  if(amt>paid+0.004){ toast('Refund exceeds deposits held ('+money(paid)+')'); return; }
  await withLock(o, async()=>{
    const p=newPayment(o,'refund',-amt,method,date,note); audit('payment.refund','order',o.id,{number:p.number,amount:-amt,method}); commit();
    try{ p.sync='pending'; commit(); await postOrderSale(o,'pending',{opId:p.opId,op:'refund'}); closeModal(); commit(); render(); toast(p.number+' refund recorded — deposits held now '+money(orderPaid(o))); }
    catch(e){ p.sync='failed'; p.error=String(e.message||e); commit(); closeModal(); render(); toast('Refund recorded locally; Lightspeed sync failed: '+p.error.slice(0,120)); }
  });
};
ACT.retrySync=async d=>{ const o=O(d.id); if(!o) return; await withLock(o, async()=>{ try{ const st = o.status==='completed'?'closed':(o.status==='cancelled'?'voided':'pending'); await postOrderSale(o, st, {opId:'retry-'+o.id+'-'+Date.now(), op:'retry'}); render(); toast('Synced with Lightspeed'); }catch(e){ render(); toast('Sync failed: '+String(e.message||e).slice(0,140)); } }); };
ACT.syncOrder=async d=>{ const o=O(d.id); if(!o) return; try{ const s=await LS.refreshSale(o); render(); toast(s?'Lightspeed: '+LS_STATUS_LABEL(o.ls)+' · paid '+money(o.ls.paid||0):'Sale not found in Lightspeed'); }catch(e){ toast('Sync failed: '+e.message); } };
function ensureInvoiceForOrder(o){
  let inv=db.invoices.find(i=>i.orderId===o.id);
  if(!inv){ inv=makeInvoice(o.contactId,null); inv.orderId=o.id; inv.quoteId=o.quoteId||null; inv.items=clone(o.items); inv.discountPct=o.discountPct||0; inv.loc=o.loc; inv.notes=o.notes||''; inv.createdBy=curUser().id; inv.ls={saleId:o.ls.saleId,state:o.ls.state,attrs:o.ls.attrs}; orderPays(o).forEach(p=>{ p.invoiceId=inv.id; }); const q=o.quoteId?Q(o.quoteId):null; if(q) q.invoiceId=inv.id; commit(); }
  return inv;
}
ACT.completeOrder=d=>{
  const o=O(d.id); if(!o) return; if(!requirePerm('complete_service','complete a service')) return;
  const bal=orderBalance(o);
  if(bal>0.004){ toast('Balance '+money(bal)+' is still due — take the final payment first (a service cannot be closed with an outstanding balance).'); return; }
  const unsynced=orderPays(o).filter(p=>p.sync!=='posted');
  if(LS.connected()&&unsynced.length){ toast(unsynced.length+' payment(s) not yet posted to Lightspeed — retry sync before completing.'); return; }
  ask('Mark '+o.number+' as completed / picked up and close the Lightspeed sale (revenue recognised now)?', async()=>{
    await withLock(o, async()=>{
      try{ await postOrderSale(o,'closed',{opId:'close-'+o.id,op:'close'}); o.status='completed'; o.completedAt=Date.now(); o.completedBy=curUser().id; ensureInvoiceForOrder(o); audit('order.completed','order',o.id,null); logAct('check',curUser().name,[{t:curUser().name+' marked '},{l:o.number,v:'order',id:o.id},{t:' as completed'}],null); commit(); render(); toast(o.number+' completed — Lightspeed sale closed'); }
      catch(e){ render(); toast('Could not close in Lightspeed: '+String(e.message||e).slice(0,140)); }
    });
  },'Complete');
};
ACT.cancelOrder=d=>{
  const o=O(d.id); if(!o) return; if(!requirePerm('cancel','cancel a service')) return;
  const paid=orderPaid(o);
  openModal('Cancel service — '+o.number,
    '<div class="fgrid"><div class="fld wide"><p class="sm">Deposits held: <b>'+money(paid)+'</b>.</p></div>'+
    (paid>0?'<div class="fld"><label>Refund to customer</label><input id="cx-refund" type="number" min="0" step="0.01" max="'+paid+'" value="'+paid+'"></div><div class="fld"><label>Refund method</label>'+pmSelect('cx-method')+'</div><div class="fld wide mut sm">Any amount not refunded is retained as a cancellation fee and recognised as revenue when the sale closes.</div>':'<div class="fld wide mut sm">No deposits — the Lightspeed layaway (if any) will be voided; nothing is recognised.</div>')+
    '<div class="fld wide"><label>Reason</label><input id="cx-reason" placeholder="Reason for cancellation"></div></div>',
    '<button class="b2 o" data-act="closeModal">Back</button><button class="b2 d" id="pay-submit" data-act="doCancel" data-id="'+o.id+'">Cancel service</button>');
};
ACT.doCancel=async d=>{
  const o=O(d.id); if(!o) return;
  const paid=orderPaid(o); const refund=paid>0?r2(+$('#cx-refund').value||0):0; const method=paid>0?$('#cx-method').value:'Cash'; const reason=($('#cx-reason').value||'').trim();
  if(refund>paid+0.004){ toast('Refund exceeds deposits held'); return; }
  await withLock(o, async()=>{
    try{
      if(refund>0){ const p=newPayment(o,'refund',-refund,method,todayISO(),'Cancellation refund'+(reason?' — '+reason:'')); p.sync='pending'; commit(); }
      const fee=r2(paid-refund);
      if(o.ls.saleId && LS.connected()){
        if(fee>0.004){ // close at fee value: replace lines with a single cancellation-fee line
          await LS.postSale(o,'closed',{opId:'cancel-'+o.id+'-'+Date.now(), op:'cancel_fee', lines:[{name:'Cancellation fee — '+o.number+(reason?' ('+reason+')':''), qty:1, price:fee, taxable:false}]});
        } else if(paid>0){ // refunded in full: record refund then close at $0 (keeps cash-out in today's closure)
          await LS.postSale(o,'closed',{opId:'cancel-'+o.id+'-'+Date.now(), op:'cancel_refund', lines:[{name:'Service cancelled — deposit refunded in full', qty:1, price:0, taxable:false}]});
        } else { await LS.postSale(o,'voided',{opId:'cancel-'+o.id+'-'+Date.now(), op:'cancel_void'}); }
      } else if(refund>0){ orderPays(o).forEach(p=>{ if(p.sync==='pending') p.sync='local'; }); }
      o.status='cancelled'; o.cancelledAt=Date.now(); o.cancelReason=reason; o.cancelFee=fee; audit('order.cancelled','order',o.id,{refund,fee,reason}); logAct('ban',curUser().name,[{t:curUser().name+' cancelled '},{l:o.number,v:'order',id:o.id},{t:refund>0?' (refunded '+money(refund)+(fee>0?', fee '+money(fee):'')+')':''}],reason||null);
      closeModal(); commit(); render(); toast(o.number+' cancelled'+(fee>0?' — fee '+money(fee)+' recognised':''));
    }catch(e){ closeModal(); commit(); render(); toast('Cancellation failed at Lightspeed: '+String(e.message||e).slice(0,140)+' — order left unchanged'); }
  });
};
/* status guard */
CHG.orderStatus=el=>{
  const o=O(state.id); if(!o) return; const next=el.value;
  if(o.status==='completed'||o.status==='cancelled'){ el.value=o.status; toast(o.status+' is final'+(can('reopen')?' — reopening is not supported in this build':'')); return; }
  if(next==='completed'){ el.value=o.status; ACT.completeOrder({id:o.id}); return; }
  if(next==='cancelled'){ el.value=o.status; ACT.cancelOrder({id:o.id}); return; }
  if(!(ALLOWED_NEXT[o.status]||[]).includes(next)){ el.value=o.status; toast('Transition '+o.status+' → '+next+' is not allowed'); return; }
  if(!requirePerm('edit_service','change service status')){ el.value=o.status; return; }
  const prev=o.status; o.status=next; audit('order.status','order',o.id,{from:prev,to:next}); commit(); render(); toast('Status: '+OB[next][1]);
};
CHG.orderAssign=el=>{ const o=O(state.id); if(!o) return; if(!requirePerm('edit_service','reassign')){ render(); return; } const prev=o.assignedTo; o.assignedTo=el.value||null; audit('order.assign','order',o.id,{from:prev,to:o.assignedTo}); commit(); toast('Assigned to '+userName(o.assignedTo)); };
CHG.ownership=el=>{ const o=O(state.id); if(!o) return; o.ownership=el.value; audit('order.ownership','order',o.id,el.value); commit(); render(); };
CHG.addPhoto=el=>{
  const o=O(state.id); if(!o) return; const files=Array.from(el.files||[]); const ci=o.customerItem;
  files.forEach(f=>{ if((ci.photos||[]).length>=6){ toast('Max 6 photos'); return; } const img=new Image(); const url=URL.createObjectURL(f); img.onload=()=>{ const max=900; const sc=Math.min(1,max/Math.max(img.width,img.height)); const cv=document.createElement('canvas'); cv.width=Math.round(img.width*sc); cv.height=Math.round(img.height*sc); cv.getContext('2d').drawImage(img,0,0,cv.width,cv.height); ci.photos=ci.photos||[]; ci.photos.push({data:cv.toDataURL('image/jpeg',0.82), at:Date.now(), by:curUser().name, name:f.name}); URL.revokeObjectURL(url); audit('order.photo_added','order',o.id,f.name); commit(); render(); }; img.src=url; });
};
ACT.rmPhoto=d=>{ const o=O(d.id); if(!o) return; o.customerItem.photos.splice(+d.i,1); commit(); render(); };
document.addEventListener('input',e=>{ const el=e.target.closest('[data-ci]'); if(!el) return; const o=O(state.id); if(!o) return; o.customerItem=o.customerItem||{}; o.customerItem[el.dataset.ci]=el.value; commit(); });
document.addEventListener('change',e=>{ const el=e.target.closest('[data-ci]'); if(!el) return; const o=O(state.id); if(!o) return; audit('order.item_edit','order',o.id,el.dataset.ci+'='+String(el.value).slice(0,80)); });
ACT.addOrderLine=d=>{ const o=O(d.id); if(!o) return; if(!requirePerm('edit_service','edit lines')) return;
  openModal('Add service / labour line',
    '<div class="fgrid"><div class="fld wide"><label>Description</label><input id="ol-name" placeholder="e.g. Movement overhaul"></div><div class="fld"><label>Qty</label><input id="ol-qty" type="number" value="1" min="1"></div><div class="fld"><label>Price</label><input id="ol-price" type="number" step="0.01" min="0" value="0"></div><div class="fld"><label>'+esc(locTaxName(o.loc))+'</label><label class="sm"><input type="checkbox" id="ol-tax" checked> Taxable</label></div>'+
    '<div class="fld"><label>From products</label><select id="ol-prod"><option value="">—</option>'+db.products.map(p=>'<option value="'+p.id+'">'+esc(p.name)+' — '+money(p.price)+'</option>').join('')+'</select></div></div>',
    '<button class="b2 o" data-act="closeModal">Cancel</button><button class="b2 p" data-act="saveOrderLine" data-id="'+o.id+'">Add line</button>');
  setTimeout(()=>{ const sel=$('#ol-prod'); if(sel) sel.addEventListener('change',()=>{ const p=P(sel.value); if(p){ $('#ol-name').value=p.name; $('#ol-price').value=p.price; $('#ol-tax').checked=!!p.taxable; } }); },0);
};
ACT.saveOrderLine=async d=>{ const o=O(d.id); if(!o) return; const name=$('#ol-name').value.trim(); if(!name){ toast('Description required'); return; } const prod=P($('#ol-prod').value); o.items.push({name, desc:'', qty:+$('#ol-qty').value||1, price:r2(+$('#ol-price').value||0), taxable:$('#ol-tax').checked, sku:prod?prod.sku:undefined, lsProductId:prod?prod.lsProductId:undefined}); audit('order.line_added','order',o.id,name); closeModal(); commit(); render(); if(o.ls.saleId&&LS.connected()){ try{ await postOrderSale(o,'pending',{opId:'lines-'+o.id+'-'+Date.now(),op:'lines'}); render(); toast('Line added and layaway updated'); }catch(e){ toast('Line added locally; Lightspeed update failed: '+e.message); } } };
ACT.rmOrderLine=async d=>{ const o=O(d.id); if(!o) return; if(!requirePerm('edit_service','edit lines')) return; if(o.items.length<=1){ toast('An order needs at least one line'); return; } const it=o.items[+d.i]; if(orderPaid(o)>totals({items:o.items.filter((x,i)=>i!==+d.i),discountPct:o.discountPct,loc:o.loc}).total+0.004){ toast('Removing this line would make deposits exceed the service value — refund first'); return; } o.items.splice(+d.i,1); audit('order.line_removed','order',o.id,it&&it.name); commit(); render(); if(o.ls.saleId&&LS.connected()){ try{ await postOrderSale(o,'pending',{opId:'lines-'+o.id+'-'+Date.now(),op:'lines'}); render(); }catch(e){ toast('Lightspeed update failed: '+e.message); } } };
/* inventory picker (store-owned items / parts) with hard blocks */
ACT.addLsItem=d=>{ const o=O(d.id); if(!o) return; if(!LS.connected()){ toast('Connect Lightspeed first'); return; }
  openModal('Add part / store-owned item from Lightspeed',
    '<div class="fgrid"><div class="fld wide"><label>Search catalogue (name or SKU)</label><input id="lsq" placeholder="e.g. QA-PART-001"></div></div><div id="lsres" class="mut sm">Type and press Enter…</div><p class="mut sm" style="margin-top:8px">Only items with stock at <b>'+esc(o.loc)+'</b> can be added. Brand/location restrictions are enforced (blocked, not warned).</p>',
    '<button class="b2 o" data-act="closeModal">Close</button>');
  setTimeout(()=>{ const q=$('#lsq'); if(q){ q.focus(); q.addEventListener('keydown',async e=>{ if(e.key!=='Enter') return; e.preventDefault(); const term=q.value.trim(); if(!term) return; $('#lsres').innerHTML='Searching…'; try{ const list=await LS.searchProducts(term); const loc=locOf(o.loc)||{}; const rows=[]; for(const p of list.slice(0,12)){ const inv=await LS.stockFor(p.id); const here=inv.find(x=>x.outlet_id===loc.lsOutletId); const qty=here?(+here.current_amount||0):0; const brand=(p.brand&&p.brand.name)||''; const block=restrictionFor(o.loc,brand,qty,p); rows.push('<tr><td>'+esc(p.name)+'<div class="mut sm">'+esc(p.sku||'')+(brand?' · '+esc(brand):'')+'</div></td><td class="r">'+money(p.price_excluding_tax||0)+'</td><td class="r">'+qty+'</td><td class="r">'+(block?'<span class="badge b-red" title="'+esc(block)+'">Blocked</span><div class="mut sm">'+esc(block)+'</div>':'<button class="b2 g" data-act="pickLsItem" data-id="'+o.id+'" data-pid="'+p.id+'" data-name="'+esc(p.name)+'" data-sku="'+esc(p.sku||'')+'" data-price="'+(p.price_excluding_tax||0)+'" data-brand="'+esc(brand)+'">Add</button>')+'</td></tr>'); } $('#lsres').innerHTML=rows.length?'<table class="tbl"><thead><tr><th>Item</th><th class="r">Price</th><th class="r">Stock @ '+esc(o.loc)+'</th><th></th></tr></thead><tbody>'+rows.join('')+'</tbody></table>':'No results'; }catch(err){ $('#lsres').innerHTML='Search failed: '+esc(err.message); } }); } },0);
};
function restrictionFor(locName, brand, qty, p){
  const loc=locOf(locName)||{};
  if(p&&p.has_inventory!==false&&qty<=0) return 'Out of stock / not available at '+locName+' (qty '+qty+') — transfer required';
  if(loc.allowedBrands&&loc.allowedBrands.length&&brand&&!loc.allowedBrands.map(b=>b.toLowerCase()).includes(brand.toLowerCase())) return 'Brand "'+brand+'" is not authorised for sale at '+locName;
  const rule=(db.settings.brandRules||[]).find(r=>r.brand.toLowerCase()===(brand||'').toLowerCase()); if(rule&&rule.locations&&rule.locations.length&&!rule.locations.includes(locName)) return 'Brand "'+brand+'" may only be sold at: '+rule.locations.join(', ');
  return null;
}
ACT.pickLsItem=async d=>{ const o=O(d.id); if(!o) return; const already=o.items.find(it=>it.lsProductId===d.pid&&it.storeOwned); if(already){ toast('This unit is already on this order'); return; } // double allocation guard (same order); cross-order guard below
  const other=db.orders.find(x=>x.id!==o.id&&x.status!=='cancelled'&&x.status!=='completed'&&x.items.some(it=>it.lsProductId===d.pid&&it.storeOwned&&it.serialized));
  o.items.push({name:d.name, desc:'', qty:1, price:r2(+d.price||0), taxable:true, sku:d.sku||undefined, lsProductId:d.pid, storeOwned:true, brand:d.brand||'', serialized:/watch|rolex|tudor|serial/i.test(d.name+' '+d.sku)});
  if(other) { toast('Note: this serialized unit is also on open order '+other.number+' — allocation blocked'); o.items.pop(); return; }
  audit('order.store_item_added','order',o.id,{pid:d.pid,sku:d.sku}); closeModal(); commit(); render(); if(o.ls.saleId&&LS.connected()){ try{ await postOrderSale(o,'pending',{opId:'lines-'+o.id+'-'+Date.now(),op:'lines'}); render(); toast('Item added — inventory is committed by the Lightspeed layaway'); }catch(e){ toast('Added locally; Lightspeed update failed: '+e.message); } } };
ACT.printOrder=()=>window.print();
/* delete guards */
const _delOrder=ACT.delOrder; ACT.delOrder=d=>{ const o=O(d.id); if(!o) return; if(!requirePerm('delete_docs','delete')) return; if(o.ls.saleId||orderPays(o).length){ toast('This service has payments / a Lightspeed sale — cancel it instead of deleting (audit trail).'); return; } audit('order.deleted','order',o.id,o.number); _delOrder(d); };
const _delInvoice=ACT.delInvoice; ACT.delInvoice=d=>{ const inv=I(d.id); if(!inv) return; if(!requirePerm('delete_docs','delete')) return; if(inv.orderId||db.payments.some(p=>p.invoiceId===inv.id&&p.sync==='posted')){ toast('Invoices linked to a service or with posted payments cannot be deleted.'); return; } audit('invoice.deleted','invoice',inv.id,inv.number); _delInvoice(d); };
const _delContact=ACT.delContact; ACT.delContact=d=>{ const c=C(d.id); if(!c) return; if(!requirePerm('delete_docs','delete')) return; if(db.orders.some(o=>o.contactId===c.id)||db.invoices.some(i=>i.contactId===c.id)||c.lsCustomerId){ toast('Contact has documents or a Lightspeed customer link — deletion blocked to preserve history.'); return; } _delContact(d); };
/* invoice payment routing: invoices tied to a service use the service ledger; standalone invoices must be converted to an order first */
ACT.recPay=d=>{ const inv=I(d.id); if(!inv) return; if(inv.orderId){ const o=O(inv.orderId); if(o){ if(o.status==='completed'){ toast('Service is completed and paid.'); return; } go('order',o.id); ACT.takeDeposit({id:o.id}); return; } }
  toast('Payments are taken on the service order so deposits post as layaway (unearned revenue). Creating a service order for this invoice…');
  const o={id:uid(),number:'ORD-'+pad4(db.counters.order++),contactId:inv.contactId,quoteId:inv.quoteId||null,date:todayISO(),loc:inv.loc,status:'open',items:clone(inv.items),discountPct:inv.discountPct||0,notes:inv.notes||'',messages:[],createdBy:curUser().id,createdAt:Date.now(),assignedTo:null,ownership:'customer',customerItem:{brand:'',model:'',reference:'',serial:'',description:'',condition:'',accessories:'',warranty:'',notes:'',photos:[]},ls:{saleId:null,receipt:null,state:null,attrs:[],lastSyncAt:null,error:null},completedAt:null,completedBy:null,serviceTitle:inv.number};
  db.orders.push(o); inv.orderId=o.id; audit('order.created_from_invoice','order',o.id,inv.number); commit(); go('order',o.id); setTimeout(()=>ACT.takeDeposit({id:o.id}),50); };
ACT.savePay=()=>{ toast('Use Take deposit / payment on the service order.'); };
/* quote -> order attribution: override makeOrder so new fields exist before first render */
makeOrder = function(q){
  const n='ORD-'+pad4(db.counters.order++);
  const o={id:uid(),number:n,contactId:q.contactId,quoteId:q.id,date:todayISO(),loc:q.loc,status:'open',
    items:clone(q.items),discountPct:q.discountPct||0,notes:'',messages:[],
    createdBy:curUser().id,createdAt:Date.now(),assignedTo:null,ownership:'customer',
    customerItem:{brand:'',model:'',reference:'',serial:'',description:'',condition:'',accessories:'',warranty:'',notes:'',photos:[]},
    ls:{saleId:null,receipt:null,state:null,attrs:[],lastSyncAt:null,error:null,created:false},completedAt:null,completedBy:null,serviceTitle:(q.items[0]&&q.items[0].name)||''};
  db.orders.push(o);
  logAct('clipboard-list',curUser().name,[{t:curUser().name+' created service order '},{l:n,v:'order',id:o.id},{t:' from '},{l:q.number,v:'quote-doc',id:q.id}],null);
  audit('order.created','order',o.id,{from:q.number});
  commit();return o;
};
const _toInvoice=ACT.toInvoice; ACT.toInvoice=d=>{ const q=Q(d.id); if(!q) return; if(q.orderId&&O(q.orderId)){ toast('This estimate already has a service order — payments are taken there.'); go('order',q.orderId); return; } _toInvoice(d); const inv=I(q.invoiceId); if(inv&&!inv.createdBy){ inv.createdBy=curUser().id; commit(); } };

/* ---------- settings: Lightspeed connection, mappings, users, restrictions ---------- */
const _settingsView=VIEWS.settings;
VIEWS.settings=function(){
  const s=db.settings, ls=s.ls, ref=ls.ref||{};
  const opt=(list,sel,fmt)=>'<option value="">—</option>'+(list||[]).map(x=>'<option value="'+x.id+'"'+(sel===x.id?' selected':'')+'>'+esc(fmt?fmt(x):x.name)+'</option>').join('');
  const locRows=(s.locations||[]).map(n=>{ const l=s.locationMap[n]||{}; return '<tr><td class="num">'+esc(n)+'</td>'+
    '<td><select data-lm="lsOutletId" data-n="'+esc(n)+'">'+opt(ref.outlets,l.lsOutletId)+'</select></td>'+
    '<td><select data-lm="lsRegisterId" data-n="'+esc(n)+'">'+opt((ref.registers||[]).filter(r=>!l.lsOutletId||r.outlet_id===l.lsOutletId),l.lsRegisterId)+'</select></td>'+
    '<td><select data-lm="taxId" data-n="'+esc(n)+'">'+opt(ref.taxes,l.taxId,t=>t.name+' ('+r2(t.rate*100)+'%)')+'</select></td>'+
    '<td><input data-lm="allowedBrands" data-n="'+esc(n)+'" value="'+esc((l.allowedBrands||[]).join(', '))+'" placeholder="all brands" style="min-width:140px"></td></tr>'; }).join('');
  const pmRows=(s.paymentMethods||[]).map(m=>'<tr><td class="num">'+esc(m)+'</td><td><select data-pm="'+esc(m)+'">'+opt(ref.paymentTypes,(ls.paymentMap||{})[m])+'</select></td></tr>').join('');
  const userRows=(s.users||[]).map((u,i)=>'<tr><td><input data-um="name" data-i="'+i+'" value="'+esc(u.name)+'"></td><td><select data-um="role" data-i="'+i+'">'+['associate','advisor','manager','admin'].map(r=>'<option'+(u.role===r?' selected':'')+'>'+r+'</option>').join('')+'</select></td><td><select data-um="lsUserId" data-i="'+i+'">'+opt(ref.users,u.lsUserId)+'</select></td><td><input data-um="pin" data-i="'+i+'" value="'+esc(u.pin||'')+'" style="width:70px"></td><td><button class="b2 d" data-act="rmUser" data-i="'+i+'">×</button></td></tr>').join('');
  const brandRows=(s.brandRules||[]).map((r,i)=>'<tr><td><input data-br="brand" data-i="'+i+'" value="'+esc(r.brand)+'"></td><td><input data-br="locations" data-i="'+i+'" value="'+esc((r.locations||[]).join(', '))+'" placeholder="comma-separated locations"></td><td><button class="b2 d" data-act="rmBrandRule" data-i="'+i+'">×</button></td></tr>').join('');
  const conn = ls.connected ? '<span class="badge b-green">Connected</span> '+esc(ls.store||'')+(ls.retailerName?' — '+esc(ls.retailerName):'')+(ls.tokenExpires?' <span class="mut sm">token expires '+esc(fmtLong(ls.tokenExpires))+'</span>':'') : '<span class="badge b-red">Not connected</span>'+(ls.secretConfigured===false?' <span class="mut sm">(backend secret not configured)</span>':'');
  const lsCard='<div class="card" style="margin-bottom:22px"><div class="panel"><h3><i class="fa-solid fa-plug"></i> Lightspeed X-Series (test store: '+LS_CFG.storePrefix+')</h3>'+
    '<p style="margin-bottom:10px">'+conn+'</p>'+
    '<div class="actrow" style="margin-bottom:14px"><a class="b2 p" href="'+LS.connectUrl()+'"><i class="fa-solid fa-link"></i> '+(ls.connected?'Re-authorize':'Connect / install app')+'</a>'+
    '<button class="b2 o" data-act="lsStatus"><i class="fa-solid fa-arrows-rotate"></i> Refresh status</button>'+
    '<button class="b2 o" data-act="lsSync"'+(ls.connected?'':' disabled')+'><i class="fa-solid fa-download"></i> Sync reference data</button>'+
    (ls.lastSync?'<span class="mut sm">last sync '+esc(fmtLong(ls.lastSync))+'</span>':'')+'</div>'+
    '<p class="mut sm" style="margin-bottom:12px">Accounting rule enforced by this app: every deposit/partial payment is posted to Lightspeed as a <b>layaway payment</b> on a layaway sale (unearned revenue); the sale is closed and revenue recognised only when the service is completed and the balance is $0. Generic service product: '+(ls.genericServiceProductId?'<code>'+esc(LS_CFG.genericServiceSku)+'</code>':'<i>not yet created</i>')+'</p>'+
    '<h3 style="margin-top:14px">Locations → outlet / register / tax</h3><div style="overflow-x:auto"><table class="tbl"><thead><tr><th>App location</th><th>Outlet</th><th>Register</th><th>Tax</th><th>Allowed brands (blank = all)</th></tr></thead><tbody>'+locRows+'</tbody></table></div>'+
    '<h3 style="margin-top:14px">Payment methods → Lightspeed payment types</h3><div style="overflow-x:auto"><table class="tbl"><thead><tr><th>App method</th><th>Lightspeed payment type</th></tr></thead><tbody>'+pmRows+'</tbody></table></div>'+
    '<h3 style="margin-top:14px">Brand restrictions (brand may only be sold at these locations)</h3><div style="overflow-x:auto"><table class="tbl"><thead><tr><th>Brand</th><th>Locations</th><th></th></tr></thead><tbody>'+brandRows+'</tbody></table></div><div class="actrow" style="margin-top:8px"><button class="b2 o" data-act="addBrandRule">+ Add brand rule</button></div>'+
    '<div class="actrow" style="margin-top:16px"><button class="b2 p" data-act="saveLsSettings"><i class="fa-solid fa-floppy-disk"></i> Save Lightspeed settings</button></div></div></div>';
  const usersCard='<div class="card" style="margin-bottom:22px"><div class="panel"><h3><i class="fa-solid fa-users-gear"></i> Users &amp; roles</h3><p class="mut sm" style="margin-bottom:10px">Roles: associate (quotes, deposits) · advisor (+ service edits/completion) · manager (+ refunds, cancel, void, overrides, settings) · admin (+ users). Switch user from the top bar (PIN).</p>'+
    '<div style="overflow-x:auto"><table class="tbl"><thead><tr><th>Name</th><th>Role</th><th>Lightspeed user</th><th>PIN</th><th></th></tr></thead><tbody>'+userRows+'</tbody></table></div>'+
    '<div class="actrow" style="margin-top:8px"><button class="b2 o" data-act="addUser">+ Add user</button><button class="b2 p" data-act="saveUsers"><i class="fa-solid fa-floppy-disk"></i> Save users</button></div></div></div>';
  const auditCard='<div class="card" style="margin-bottom:22px"><div class="panel"><h3><i class="fa-solid fa-clipboard-check"></i> Audit log (last 40)</h3><div style="overflow-x:auto"><table class="tbl"><thead><tr><th>When</th><th>User</th><th>Action</th><th>Entity</th><th>Detail</th></tr></thead><tbody>'+(db.audit||[]).slice(-40).reverse().map(a=>'<tr><td>'+esc(fmtLong(a.at))+'</td><td>'+esc(a.userName)+'</td><td>'+esc(a.action)+'</td><td>'+esc(a.entity||'')+'</td><td class="mut sm">'+esc((a.detail||'').slice(0,120))+'</td></tr>').join('')+'</tbody></table></div><div class="actrow" style="margin-top:8px"><button class="b2 o" data-act="csv" data-kind="audit"><i class="fa-solid fa-download"></i> Audit CSV</button></div></div></div>';
  return lsCard+usersCard+_settingsView()+auditCard;
};
const _saveSettings=ACT.saveSettings; ACT.saveSettings=()=>{ if(!requirePerm('settings','change settings')) return; _saveSettings(); const s=db.settings; s.locationMap=s.locationMap||{}; s.locations.forEach(n=>{ s.locationMap[n]=s.locationMap[n]||{lsOutletId:null,lsRegisterId:null,taxId:null,taxRate:null,taxName:null,allowedBrands:null}; }); audit('settings.saved','settings',null,null); commit(); };
ACT.lsStatus=async()=>{ await LS.status(); commit(); render(); toast(LS.connected()?'Connected to '+db.settings.ls.store:'Not connected'); };
ACT.lsSync=async()=>{ try{ toast('Syncing…'); await LS.syncRef(); render(); toast('Reference data synced: '+db.settings.ls.ref.outlets.length+' outlets, '+db.settings.ls.ref.users.length+' users, '+db.settings.ls.ref.paymentTypes.length+' payment types'); }catch(e){ toast('Sync failed: '+e.message); } };
ACT.saveLsSettings=()=>{ if(!requirePerm('settings','change settings')) return; const s=db.settings;
  $$('[data-lm]').forEach(el=>{ const l=s.locationMap[el.dataset.n]=s.locationMap[el.dataset.n]||{}; const f=el.dataset.lm; if(f==='allowedBrands'){ const v=el.value.split(',').map(x=>x.trim()).filter(Boolean); l.allowedBrands=v.length?v:null; } else { l[f]=el.value||null; if(f==='taxId'){ const t=(s.ls.ref.taxes||[]).find(x=>x.id===el.value); if(t){ l.taxRate=r2(t.rate*100); l.taxName=t.name; } } } });
  $$('[data-pm]').forEach(el=>{ s.ls.paymentMap[el.dataset.pm]=el.value||null; });
  $$('[data-br]').forEach(el=>{ const r=(s.brandRules||[])[+el.dataset.i]; if(!r) return; if(el.dataset.br==='locations') r.locations=el.value.split(',').map(x=>x.trim()).filter(Boolean); else r.brand=el.value.trim(); });
  audit('settings.ls_saved','settings',null,null); commit(); render(); toast('Lightspeed settings saved'); };
ACT.addBrandRule=()=>{ db.settings.brandRules=db.settings.brandRules||[]; db.settings.brandRules.push({brand:'',locations:[]}); render(); };
ACT.rmBrandRule=d=>{ db.settings.brandRules.splice(+d.i,1); commit(); render(); };
ACT.addUser=()=>{ if(!requirePerm('users','manage users')) return; db.settings.users.push({id:'u-'+uid(),name:'New user',role:'associate',pin:'0000',lsUserId:null}); render(); };
ACT.rmUser=d=>{ if(!requirePerm('users','manage users')) return; if(db.settings.users.length<=1){ toast('Keep at least one user'); return; } db.settings.users.splice(+d.i,1); commit(); render(); };
ACT.saveUsers=()=>{ if(!requirePerm('users','manage users')) return; $$('[data-um]').forEach(el=>{ const u=db.settings.users[+el.dataset.i]; if(u) u[el.dataset.um]=el.value; }); audit('settings.users_saved','settings',null,db.settings.users.map(u=>u.name+':'+u.role).join(',')); commit(); render(); toast('Users saved'); };
/* top bar: current user switcher */
function mountUserSwitch(){
  const tu=$('#topUser'); if(!tu) return; const u=curUser(); tu.textContent=shortName(u.name)+' · '+u.role;
  if(!$('#userSwitch')){ const sel=document.createElement('select'); sel.id='userSwitch'; sel.className='select'; sel.style.marginLeft='8px'; sel.setAttribute('aria-label','Switch user'); sel.addEventListener('change',()=>{ const target=db.settings.users.find(x=>x.id===sel.value); if(!target) return; if(target.pin){ openModal('Switch user — '+target.name,'<div class="fld"><label>PIN</label><input id="pin-input" type="password" inputmode="numeric" autocomplete="off"></div>','<button class="b2 o" data-act="pinCancel">Cancel</button><button class="b2 p" data-act="pinConfirm" data-id="'+target.id+'">Switch</button>'); setTimeout(()=>{ const i=$('#pin-input'); if(i) i.focus(); },0); return; } switchUser(target); }); tu.parentNode.insertBefore(sel, tu.nextSibling); }
  const sel=$('#userSwitch'); sel.innerHTML=(db.settings.users||[]).map(x=>'<option value="'+x.id+'"'+(x.id===u.id?' selected':'')+'>'+esc(x.name)+'</option>').join('');
}
function switchUser(target){ state.userId=target.id; localStorage.setItem('qm-current-user',target.id); db.settings.user=target.name; audit('user.switched','user',target.id,target.name); commit(); render(); toast('Now working as '+target.name+' ('+target.role+')'); }
ACT.pinCancel=()=>{ closeModal(); const sel=$('#userSwitch'); if(sel) sel.value=curUser().id; };
ACT.pinConfirm=d=>{ const target=db.settings.users.find(x=>x.id===d.id); const pin=($('#pin-input')||{}).value||''; if(!target) return; if(pin!==String(target.pin)){ toast('Wrong PIN'); audit('user.pin_failed','user',target.id,null); return; } closeModal(); switchUser(target); };
document.addEventListener('keydown',e=>{ if(e.key==='Enter'&&e.target&&e.target.id==='pin-input'){ e.preventDefault(); const b=document.querySelector('[data-act="pinConfirm"]'); if(b) b.click(); } });
/* expanded sidebar: open by default with visible titles (labels from data-tip) */
function expandSidebar(){
  if(!document.getElementById('qm-sidebar-expand')){
    const st=document.createElement('style'); st.id='qm-sidebar-expand';
    st.textContent='.sidebar{width:212px;align-items:stretch;padding:8px 12px 14px}'+
      '.logo{width:52px;margin:12px auto 18px}'+
      '.nav{align-items:stretch;gap:3px}'+
      '.nav-item{width:100%;height:40px;justify-content:flex-start;gap:12px;padding:0 12px;font-size:16px}'+
      '.nav-item .nav-label{font-family:var(--sans);font-size:13.5px;font-weight:600;letter-spacing:.25px;white-space:nowrap}'+
      '.nav-item[data-tip]:hover:after{display:none}'+
      '.nav-item.active::before{left:-12px}'+
      '.nav-divider{width:100%}'+
      '.nav-add{margin-top:8px;align-self:center}'+
      '.shell{margin-left:212px}'+
      '@media(max-width:900px){.sidebar{width:65px;align-items:center;padding:8px 0 12px}.shell{margin-left:65px}.nav{align-items:center}.nav-item{width:44px;justify-content:center;padding:0;gap:0}.nav-item .nav-label{display:none}.nav-item[data-tip]:hover:after{display:block}.nav-item.active::before{left:-8px}.nav-divider{width:30px}.logo{width:46px}}';
    document.head.appendChild(st);
  }
  document.querySelectorAll('.sidebar .nav-item').forEach(el=>{
    if(!el.querySelector('.nav-label')){ const t=el.getAttribute('data-tip'); if(t){ const s=document.createElement('span'); s.className='nav-label'; s.textContent=t; el.appendChild(s); } }
  });
}
const _render=render; render=function(){ _render(); mountUserSwitch(); expandSidebar(); };
/* dashboard: unearned revenue card */
const _dash=VIEWS.dashboard; VIEWS.dashboard=function(){
  const html=_dash();
  const open=db.orders.filter(o=>o.status!=='completed'&&o.status!=='cancelled');
  const held=r2(open.reduce((s,o)=>s+orderPaid(o),0)); const outstanding=r2(open.reduce((s,o)=>s+Math.max(0,orderBalance(o)),0));
  const recog=r2(db.orders.filter(o=>o.status==='completed').reduce((s,o)=>s+totals(o).total,0)+db.orders.filter(o=>o.status==='cancelled').reduce((s,o)=>s+(+o.cancelFee||0),0));
  const card='<section class="metrics" style="margin-top:-8px"><div class="metric" data-act="go" data-view="orders"><div class="label">Deposits held — unearned revenue (liability) <span>('+open.length+' open)</span></div><div class="value v-gold">'+money(held)+'</div></div>'+
  '<div class="metric" data-act="go" data-view="orders"><div class="label">Open service balances</div><div class="value v-blue">'+money(outstanding)+'</div></div>'+
  '<div class="metric" data-act="go" data-view="payments"><div class="label">Recognised service revenue (completed)</div><div class="value v-green" style="color:var(--green)">'+money(recog)+'</div></div>'+
  '<div class="metric" data-act="go" data-view="settings"><div class="label">Lightspeed</div><div class="value" style="font-size:16px">'+(LS.connected()?'Connected · '+esc(db.settings.ls.store):'Not connected')+'</div></div></section>';
  return html.replace('<section class="actions">', card+'<section class="actions">');
};
/* payments view: reconciliation table */
const _payView=VIEWS.payments; VIEWS.payments=function(){
  const html=_payView();
  const rows=db.orders.slice().sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)).map(o=>{ const t=totals(o).total; const ps=orderPays(o); const dep=r2(ps.filter(p=>p.kind==='deposit').reduce((s,p)=>s+p.amount,0)); const fin=r2(ps.filter(p=>p.kind==='final').reduce((s,p)=>s+p.amount,0)); const ref=r2(ps.filter(p=>p.kind==='refund').reduce((s,p)=>s+p.amount,0)); const cash=r2(dep+fin+ref); const recog=o.status==='completed'?t:(o.status==='cancelled'?(+o.cancelFee||0):0); const liab=(o.status==='completed'||o.status==='cancelled')?0:cash; const bal=o.status==='cancelled'?0:r2(t-cash);
    return {o,t,dep,fin,ref,cash,recog,liab,bal}; });
  const tot=rows.reduce((a,r)=>{a.t+=r.t;a.dep+=r.dep;a.fin+=r.fin;a.ref+=r.ref;a.cash+=r.cash;a.recog+=r.recog;a.liab+=r.liab;a.bal+=r.bal;return a;},{t:0,dep:0,fin:0,ref:0,cash:0,recog:0,liab:0,bal:0});
  const tbl='<div class="card" style="margin-top:22px"><div class="panel"><h3>Service deposit reconciliation</h3><p class="mut sm" style="margin-bottom:10px">Per service order: value, deposits, final payment, refunds, cash received, recognised sales (only completed / cancellation fees), unearned-revenue liability (deposits held on open services) and remaining balance. Must reconcile: cash = recognised + liability + refunds-netted.</p>'+
  '<div style="overflow-x:auto"><table class="tbl"><thead><tr><th>Order</th><th>Status</th><th>Lightspeed</th><th class="r">Service value</th><th class="r">Deposits</th><th class="r">Final</th><th class="r">Refunds</th><th class="r">Cash received</th><th class="r">Recognised</th><th class="r">Liability</th><th class="r">Balance</th></tr></thead><tbody>'+
  rows.map(r=>'<tr class="rowlink" data-act="open" data-type="order" data-id="'+r.o.id+'"><td class="num">'+esc(r.o.number)+'</td><td>'+badge(OB,r.o.status)+'</td><td>'+esc(LS_STATUS_LABEL(r.o.ls))+(r.o.ls.receipt?' #'+esc(r.o.ls.receipt):'')+'</td><td class="r">'+money(r.t)+'</td><td class="r">'+money(r.dep)+'</td><td class="r">'+money(r.fin)+'</td><td class="r">'+money(r.ref)+'</td><td class="r">'+money(r.cash)+'</td><td class="r">'+money(r.recog)+'</td><td class="r">'+money(r.liab)+'</td><td class="r">'+money(r.bal)+'</td></tr>').join('')+
  '<tr style="font-weight:700"><td colspan="3">Totals</td><td class="r">'+money(tot.t)+'</td><td class="r">'+money(tot.dep)+'</td><td class="r">'+money(tot.fin)+'</td><td class="r">'+money(tot.ref)+'</td><td class="r">'+money(tot.cash)+'</td><td class="r">'+money(tot.recog)+'</td><td class="r">'+money(tot.liab)+'</td><td class="r">'+money(tot.bal)+'</td></tr></tbody></table></div>'+
  '<div class="actrow" style="margin-top:8px"><button class="b2 o" data-act="csv" data-kind="reconciliation"><i class="fa-solid fa-download"></i> Reconciliation CSV</button></div></div></div>';
  return html+tbl;
};
const _csv=ACT.csv; ACT.csv=d=>{ if(d.kind==='reconciliation'){ const rows=[['Order','Status','Lightspeed','Sale id','Service value','Deposits','Final','Refunds','Cash received','Recognised','Liability','Balance']].concat(db.orders.map(o=>{ const t=totals(o).total; const ps=orderPays(o); const dep=r2(ps.filter(p=>p.kind==='deposit').reduce((s,p)=>s+p.amount,0)); const fin=r2(ps.filter(p=>p.kind==='final').reduce((s,p)=>s+p.amount,0)); const ref=r2(ps.filter(p=>p.kind==='refund').reduce((s,p)=>s+p.amount,0)); const cash=r2(dep+fin+ref); const recog=o.status==='completed'?t:(o.status==='cancelled'?(+o.cancelFee||0):0); const liab=(o.status==='completed'||o.status==='cancelled')?0:cash; return [o.number,o.status,LS_STATUS_LABEL(o.ls),o.ls.saleId||'',t,dep,fin,ref,cash,recog,liab,o.status==='cancelled'?0:r2(t-cash)]; })); csvOut('reconciliation-'+todayISO()+'.csv',rows); return; }
  if(d.kind==='audit'){ csvOut('audit-'+todayISO()+'.csv',[['When','User','Action','Entity','EntityId','Detail']].concat((db.audit||[]).map(a=>[new Date(a.at).toISOString(),a.userName,a.action,a.entity,a.entityId,a.detail]))); return; }
  if(d.kind==='payments'){ csvOut('payments-'+todayISO()+'.csv',[['Number','Date','When','Kind','Contact','Order','Invoice','Method','Amount','Processed by','Lightspeed sync','LS payment id']].concat(db.payments.map(p=>{ const o=p.orderId?O(p.orderId):null; const inv=p.invoiceId?I(p.invoiceId):null; return [p.number,p.date,new Date(p.at).toISOString(),p.kind,cname(p.contactId),o?o.number:'',inv?inv.number:'',p.method,p.amount,p.userName||'',p.sync||'',p.lsPaymentId||'']; }))); return; }
  _csv(d); };
/* orders list: show LS + balance columns */
VIEWS.orders=function(){
  const list=db.orders.filter(o=>matches(o.number+' '+cname(o.contactId))).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
  const rows=list.map(o=>'<tr class="rowlink" data-act="open" data-type="order" data-id="'+o.id+'"><td class="num">'+esc(o.number)+'</td><td>'+esc(cname(o.contactId))+'</td><td>'+esc(o.loc||'')+'</td><td>'+fmtD(o.date)+'</td><td>'+badge(OB,o.status)+'</td><td>'+esc(LS_STATUS_LABEL(o.ls))+'</td><td class="r">'+money(totals(o).total)+'</td><td class="r">'+money(orderPaid(o))+'</td><td class="r">'+money(orderBalance(o))+'</td></tr>').join('')||'<tr><td colspan="9"><div class="empty"><i class="fa-solid fa-clipboard-list"></i>No service orders yet. Accept an estimate, then convert it to an order.</div></td></tr>';
  return'<div class="page-head"><h1 class="page-title">Service orders</h1></div>'+
  '<div class="toolbar"><div class="left"><span class="search"><i class="fa-solid fa-magnifying-glass"></i><input data-srch placeholder="Search orders…" value="'+esc(state.q)+'"></span></div>'+
  '<div class="actrow"><button class="b2 o" data-act="csv" data-kind="orders"><i class="fa-solid fa-download"></i> CSV</button></div></div>'+
  '<div class="card"><table class="tbl"><thead><tr><th>Number</th><th>Customer</th><th>Location</th><th>Date</th><th>Status</th><th>Lightspeed</th><th class="r">Value</th><th class="r">Paid</th><th class="r">Balance</th></tr></thead><tbody id="rows">'+rows+'</tbody></table></div>';
};
/* boot hook: migrate + LS status after data loads */
async function lsBoot(){
  db = migrateDB(db);
  curUser();
  const u=new URL(location.href);
  if(u.searchParams.get('ls_connected')==='1'){ toast('Lightspeed connected: '+(u.searchParams.get('store')||'')); history.replaceState({},'',location.pathname); }
  await LS.status();
  if(LS.connected() && (!db.settings.ls.lastSync || !db.settings.ls.genericServiceProductId)){ try{ await LS.syncRef(); }catch(e){ console.warn('ref sync failed', e); } }
  commit(); render();
}

/* ---------- SPECIAL ORDERS: dedicated section — deposits or full prepayment stay an open
   layaway (pending · layby,service); the sale is recognised only at pickup/fulfilment ---------- */
const isSpecial=o=>o&&o.kind==='special';
const SOB={open:['b-blue','Ordered'],in_progress:['b-gold','With supplier'],ready:['b-gold','Arrived — awaiting pickup'],completed:['b-green','Picked up'],cancelled:['b-red','Cancelled']};
function mountSpecialNav(){
  const nav=document.querySelector('.sidebar .nav'); if(!nav) return;
  if(nav.querySelector('[data-view="specialorders"]')) return;
  const after=nav.querySelector('[data-view="orders"]');
  const el=document.createElement('div'); el.className='nav-item'; el.setAttribute('data-act','go'); el.setAttribute('data-view','specialorders'); el.setAttribute('data-tip','Special Orders');
  el.innerHTML='<i class="fa-solid fa-gem"></i>';
  if(after&&after.nextSibling) nav.insertBefore(el, after.nextSibling); else nav.appendChild(el);
}
VIEWS.specialorders=function(){
  const list=db.orders.filter(o=>isSpecial(o)&&matches(o.number+' '+cname(o.contactId)+' '+((o.customerItem&&((o.customerItem.brand||'')+' '+(o.customerItem.model||'')+' '+(o.customerItem.reference||'')))||''))).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
  const rows=list.map(o=>{ const ci=o.customerItem||{}; const watch=[ci.brand,ci.model,ci.reference].filter(Boolean).join(' ')||o.serviceTitle||''; return '<tr class="rowlink" data-act="open" data-type="order" data-id="'+o.id+'"><td class="num">'+esc(o.number)+'</td><td>'+esc(cname(o.contactId))+'</td><td>'+esc(watch)+'</td><td>'+(o.specialEta?fmtD(o.specialEta):'—')+'</td><td>'+badge(SOB,o.status)+'</td><td>'+esc(LS_STATUS_LABEL(o.ls))+(o.ls&&o.ls.receipt?' #'+esc(o.ls.receipt):'')+'</td><td class="r">'+money(totals(o).total)+'</td><td class="r">'+money(orderPaid(o))+'</td><td class="r">'+money(orderBalance(o))+'</td></tr>'; }).join('')||'<tr><td colspan="9"><div class="empty"><i class="fa-solid fa-gem"></i>No special orders yet. Create one to take a deposit — it stays a layaway (not a sale) until the piece is picked up.</div></td></tr>';
  return '<div class="page-head"><h1 class="page-title">Special orders</h1><div class="actrow"><button class="b2 p" data-act="newSpecialOrder"><i class="fa-solid fa-plus"></i> New special order</button></div></div>'+
  '<div class="toolbar"><div class="left"><span class="search"><i class="fa-solid fa-magnifying-glass"></i><input data-srch placeholder="Search special orders…" value="'+esc(state.q)+'"></span></div></div>'+
  '<p class="mut sm" style="margin:-6px 0 12px">Deposits — multiple, or even full prepayment — post to Lightspeed as an open layaway (<code>pending · layby,service</code>). The sale is recognised only when the piece arrives and the client picks it up (<b>Complete &amp; close</b>).</p>'+
  '<div class="card"><div style="overflow-x:auto"><table class="tbl"><thead><tr><th>Number</th><th>Customer</th><th>Watch / item</th><th>ETA</th><th>Status</th><th>Lightspeed</th><th class="r">Value</th><th class="r">Paid</th><th class="r">Balance</th></tr></thead><tbody id="rows">'+rows+'</tbody></table></div></div>';
};
ACT.newSpecialOrder=()=>{ if(!requirePerm('take_deposit','create a special order')) return;
  openModal('New special order',
    '<div class="fgrid">'+
    '<div class="fld wide"><label>Customer</label><select id="so-contact"><option value="">— new customer (enter below) —</option>'+db.contacts.map(c=>'<option value="'+c.id+'">'+esc(c.name)+(c.email?' · '+esc(c.email):'')+'</option>').join('')+'</select></div>'+
    '<div class="fld"><label>New customer name</label><input id="so-cname" placeholder="only if none selected"></div>'+
    '<div class="fld"><label>New customer email</label><input id="so-cemail" type="email" placeholder="optional"></div>'+
    '<div class="fld"><label>Brand</label><input id="so-brand" placeholder="e.g. Rolex"></div>'+
    '<div class="fld"><label>Model</label><input id="so-model" placeholder="e.g. GMT-Master II"></div>'+
    '<div class="fld"><label>Reference</label><input id="so-ref" placeholder="e.g. 126710BLRO"></div>'+
    '<div class="fld"><label>Price (before tax)</label><input id="so-price" type="number" min="0" step="0.01"></div>'+
    '<div class="fld"><label>Location</label><select id="so-loc">'+db.settings.locations.map(l=>'<option>'+esc(l)+'</option>').join('')+'</select></div>'+
    '<div class="fld"><label>Expected arrival</label><input id="so-eta" type="date"></div>'+
    '<div class="fld wide"><label>Notes</label><input id="so-notes" placeholder="supplier, allocation notes…"></div>'+
    '<div class="fld wide mut sm">Deposits (multiple allowed) and even full prepayment stay an open Lightspeed layaway — the sale is only recognised at pickup.</div>'+
    '</div>',
    '<button class="b2 o" data-act="closeModal">Cancel</button><button class="b2 p" data-act="createSpecialOrder"><i class="fa-solid fa-check"></i> Create &amp; take deposit</button>');
};
ACT.createSpecialOrder=()=>{
  let contactId=$('#so-contact').value;
  const brand=$('#so-brand').value.trim(), model=$('#so-model').value.trim(), ref=$('#so-ref').value.trim();
  const price=r2(+$('#so-price').value||0), loc=$('#so-loc').value, eta=$('#so-eta').value, notes=$('#so-notes').value.trim();
  if(!contactId){ const nm=$('#so-cname').value.trim(); if(!nm){ toast('Pick a customer or enter a new name'); return; } const c={id:uid(),name:nm,company:'',email:$('#so-cemail').value.trim(),phone:'',tags:'special-order',notes:'',createdAt:Date.now(),lsCustomerId:null}; db.contacts.push(c); contactId=c.id; }
  if(!brand&&!model){ toast('Enter at least a brand or model'); return; }
  if(!(price>0)){ toast('Enter the price'); return; }
  const label=('Special order (placeholder) — '+[brand,model].filter(Boolean).join(' ')+(ref?' Ref. '+ref:'')+' — awaiting arrival').trim();
  const o={id:uid(),number:'SO-'+pad4(db.counters.order++),kind:'special',contactId,quoteId:null,date:todayISO(),loc,status:'open',items:[{name:label,desc:notes,qty:1,price,taxable:true}],discountPct:0,notes,messages:[],createdBy:curUser().id,createdAt:Date.now(),assignedTo:null,ownership:'store',customerItem:{brand,model,reference:ref,serial:'',description:'Special order for client',condition:'',accessories:'',warranty:'',notes,photos:[]},ls:{saleId:null,receipt:null,state:null,attrs:[],lastSyncAt:null,error:null,created:false},completedAt:null,completedBy:null,specialEta:eta||null,serviceTitle:label};
  db.orders.push(o); audit('special.created','order',o.id,{brand,model,ref,price,eta});
  logAct('gem',curUser().name,[{t:curUser().name+' created special order '},{l:o.number,v:'order',id:o.id}],label);
  closeModal(); commit(); go('order',o.id); setTimeout(()=>ACT.takeDeposit({id:o.id}),80);
};
/* orders list shows service work only; special orders live in their own section */
VIEWS.orders=function(){
  const list=db.orders.filter(o=>!isSpecial(o)&&matches(o.number+' '+cname(o.contactId))).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
  const rows=list.map(o=>'<tr class="rowlink" data-act="open" data-type="order" data-id="'+o.id+'"><td class="num">'+esc(o.number)+'</td><td>'+esc(cname(o.contactId))+'</td><td>'+esc(o.loc||'')+'</td><td>'+fmtD(o.date)+'</td><td>'+badge(OB,o.status)+'</td><td>'+esc(LS_STATUS_LABEL(o.ls))+'</td><td class="r">'+money(totals(o).total)+'</td><td class="r">'+money(orderPaid(o))+'</td><td class="r">'+money(orderBalance(o))+'</td></tr>').join('')||'<tr><td colspan="9"><div class="empty"><i class="fa-solid fa-clipboard-list"></i>No service orders yet. Accept an estimate, then convert it to an order.</div></td></tr>';
  return'<div class="page-head"><h1 class="page-title">Service orders</h1></div>'+
  '<div class="toolbar"><div class="left"><span class="search"><i class="fa-solid fa-magnifying-glass"></i><input data-srch placeholder="Search orders…" value="'+esc(state.q)+'"></span></div>'+
  '<div class="actrow"><button class="b2 o" data-act="csv" data-kind="orders"><i class="fa-solid fa-download"></i> CSV</button></div></div>'+
  '<div class="card"><table class="tbl"><thead><tr><th>Number</th><th>Customer</th><th>Location</th><th>Date</th><th>Status</th><th>Lightspeed</th><th class="r">Value</th><th class="r">Paid</th><th class="r">Balance</th></tr></thead><tbody id="rows">'+rows+'</tbody></table></div>';
};
/* order detail: mark special orders and rename the intake panel */
const _orderView2=VIEWS.order; VIEWS.order=function(){
  const o=O(state.id); let h=_orderView2();
  if(o&&isSpecial(o)){
    h=h.replace('page-title">'+o.number,'page-title">'+o.number+' <span class="badge b-gold">Special order</span>');
    h=h.replace('<h3>Customer item (intake)</h3>','<h3>Special-order item (store merchandise'+(o.specialEta?' · ETA '+fmtD(o.specialEta):'')+')</h3>');
  }
  return h;
};
const _render3=render; render=function(){ _render3(); mountSpecialNav(); expandSidebar(); };

/* ---------- self-boot (module is loaded as a separate script after the app) ---------- */
(async function(){
  let n=0; while(typeof db==='undefined'||!db){ await new Promise(r=>setTimeout(r,25)); if(++n>400) break; }
  try{ const loaded=await loadDB(); if(loaded&&loaded.v===1) db=loaded; }catch(e){ console.warn('loadDB failed',e); }
  try{ await lsBoot(); }catch(e){ console.error('lsBoot failed', e); toast('Integration boot error: '+e.message); }
})();

/* ---------- big brand logo above the menu (official Raffi footer wordmark, white) ----------
   When index.html ships the static expanded-sidebar stylesheet (#qm-sidebar-expand-static),
   the logo + labels are correct from first paint and this JS fallback stays out of the way. */
function mountBigLogo(){
  if(document.getElementById('qm-sidebar-expand-static')) return; // static CSS already handles it
  if(!document.getElementById('qm-biglogo-css')){
    const st=document.createElement('style'); st.id='qm-biglogo-css';
    st.textContent='.sidebar .logo{width:112px;margin:14px auto 14px}'+
      '.sidebar .logo img{width:100%;height:auto;display:block}'+
      '@media(max-width:900px){.sidebar .logo{width:46px;margin:10px 0 16px}}';
    document.head.appendChild(st);
  }
  const el=document.querySelector('.sidebar .logo'); if(!el) return;
  const img=el.querySelector('img'); if(!img) return;
  const src='raffi-logo-white.svg'; // hosted in the app folder on GitHub Pages
  if(img.getAttribute('src')!==src){ img.src=src; img.alt='Raffi Jewellers'; }
}
const _expandSidebar=expandSidebar;
expandSidebar=function(){ if(document.getElementById('qm-sidebar-expand-static')) return; _expandSidebar(); };
const _render5=render; render=function(){ _render5(); mountBigLogo(); };
try{ mountBigLogo(); }catch(e){}

/* ---------- special orders: placeholder line in Lightspeed until fulfilment ----------
   On creation the layaway carries a placeholder line ("… — awaiting arrival").
   When the order is fulfilled (Complete & close at pickup), the line switches to
   BRAND + MODEL + Ref. REFERENCE + S/N SERIAL before the closing sync, so the final
   Lightspeed receipt shows the real piece. Serial is required to close a special order. */
function specialFulfilLine(o){
  const ci=o.customerItem||{}; const it=o.items&&o.items[0]; if(!it) return;
  const name=([ci.brand,ci.model].filter(Boolean).join(' ')+(ci.reference?' Ref. '+ci.reference:'')+(ci.serial?' — S/N '+ci.serial:'')).trim();
  if(name && it.name!==name){ it.name=name; it.desc='Special order fulfilled'+(o.specialEta?' (ETA was '+fmtD(o.specialEta)+')':''); audit('special.line_fulfilled','order',o.id,name); commit(); }
}
const _postOrderSale=postOrderSale;
postOrderSale=async function(o, state, opts){
  if(state==='closed' && isSpecial(o) && !(opts&&opts.lines)){
    const ci=o.customerItem||{};
    if(!(ci.serial&&String(ci.serial).trim())){ toast('Enter the watch serial number (Special-order item panel) before closing — the final receipt must show Brand, Model, Reference and S/N.'); throw new Error('Serial number required to fulfil a special order'); }
    specialFulfilLine(o);
  }
  return _postOrderSale(o, state, opts);
};

/* ---------- register-first deposits: the app creates/updates the Lightspeed layaway (the "SO"),
   the rep takes the actual money at the Lightspeed register, and the payment flows back into the
   app ledger automatically — held as unearned revenue until the service/pickup completes. ---------- */
ACT.toRegister=async d=>{ const o=O(d.id); if(!o) return;
  const amt=r2(+(($('#pay-amt')||{}).value)||0);
  await withLock(o, async()=>{
    try{
      const dd=await postOrderSale(o,'pending',{opId:'to-register-'+o.id+'-'+Date.now(), op:'to_register'});
      if(dd){
        o.ls.expectAtRegister={amount:amt||null, at:Date.now()};
        audit('payment.sent_to_register','order',o.id,{amount:amt||null, receipt:o.ls.receipt});
        logAct('cash-register',curUser().name,[{t:curUser().name+' sent '},{l:o.number,v:'order',id:o.id},{t:' to the Lightspeed register'+(amt?' to collect '+money(amt):'')}],null);
        closeModal(); commit(); render();
        toast('Layaway ready in Lightspeed — receipt #'+(o.ls.receipt||'?')+'. At the register: Sales history → Continue sale → take '+(amt?money(amt):'the deposit')+'. The payment will appear here automatically.');
      } else { closeModal(); render(); }
    }catch(e){ render(); toast('Could not create the layaway in Lightspeed: '+String(e.message||e).slice(0,140)); }
  });
};
function importLsPayments(o, d){
  if(!d || !Array.isArray(d.payments) || !d.payments.length) return 0;
  const known=new Set(orderPays(o).map(p=>String(p.lsPaymentId||p.id)));
  let added=0;
  d.payments.forEach(lp=>{
    const lid=String(lp.id||''); if(!lid||known.has(lid)) return;
    const cfg=(lp.type&&(lp.type.config_id||lp.type.id))||null;
    const name=(lp.type&&lp.type.name)||'Register payment';
    const p={id:uuid(), number:'PAY-'+pad4(db.counters.payment++), kind:'deposit', orderId:o.id, invoiceId:(db.invoices.find(i=>i.orderId===o.id)||{}).id||null, contactId:o.contactId, amount:r2(+lp.amount||0), method:name, date:((lp.date||'').slice(0,10))||todayISO(), note:'Taken at the Lightspeed register', at:(lp.date?Date.parse(lp.date):Date.now())||Date.now(), userId:null, userName:'Lightspeed register', opId:null, lsPaymentId:lid, lsTypeConfigId:cfg, sync:'posted', error:null, source:'register'};
    db.payments.push(p); known.add(lid); added++;
    audit('payment.imported_from_register','order',o.id,{number:p.number, amount:p.amount, method:name});
  });
  if(added){
    if(orderBalance(o)<=0.004){ const ps=orderPays(o).filter(p=>p.source==='register'); if(ps.length) ps[ps.length-1].kind='final'; }
    if(o.ls) o.ls.expectAtRegister=null;
    logAct('cash-register','Lightspeed',[{t:added+' register payment(s) imported for '},{l:o.number,v:'order',id:o.id},{t:' — deposits held '+money(orderPaid(o))}],null);
    if(d.state==='closed' && o.status!=='completed' && o.status!=='cancelled'){
      o.status='completed'; o.completedAt=Date.now(); o.completedBy=null; ensureInvoiceForOrder(o);
      audit('order.completed','order',o.id,{via:'register final payment (Lightspeed closed the layaway)'});
      const ci=o.customerItem||{};
      if(isSpecial(o) && !(ci.serial&&String(ci.serial).trim())) toast(o.number+': the register closed this sale before a serial number was recorded — add the serial on the order for your records.');
    }
    commit();
  }
  return added;
}
let __pullBusy=false;
async function maybeAutoPull(id){
  if(__pullBusy) return; const o=O(id); if(!o) return;
  if(!(o.ls&&o.ls.saleId&&o.ls.created)) return;
  if(o.status==='completed'||o.status==='cancelled') return;
  if(!LS.connected()) return;
  const now=Date.now(); if(o.ls.lastAutoPull && now-o.ls.lastAutoPull<20000) return;
  o.ls.lastAutoPull=now; __pullBusy=true;
  try{ const before=orderPays(o).length; await LS.refreshSale(o); if(orderPays(o).length!==before){ render(); toast('Payment taken at the Lightspeed register has been added to '+o.number); } }
  catch(e){ /* quiet */ }
  finally{ __pullBusy=false; }
}
const _render6=render; render=function(){ _render6(); if(state.view==='order'&&state.id){ setTimeout(function(){ maybeAutoPull(state.id); },50); } };
