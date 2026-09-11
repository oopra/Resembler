/* remember.js — keeping the photos on this device, if you ask it to.

   THIS IS OFF BY DEFAULT, AND THAT IS NOT A FORMALITY. Everywhere else this app says, plainly,
   that your photographs are not stored: not uploaded, not kept, nowhere to keep them. Remembering
   them is the one feature that changes that sentence, so it is opt-in, it says exactly what it
   keeps and where, and there is a button that erases the lot.

   WHAT CHANGES AND WHAT DOES NOT. What changes: a copy of each photo lives in this browser's
   storage on this device, so the app can put it back when you return. What does not change: nothing
   is uploaded, nothing is shared, and no other site can read it — browser storage is walled off per
   origin. The photographs are already in this phone's camera roll; this is a second copy in the
   same place, not a new exposure. The real risk is the ordinary one: anyone who can unlock this
   device and open this app will see the photos sitting there.

   WHAT IT KEEPS. A downscaled copy of each picture (long side 1600px — far more than the 448px the
   measuring actually uses, and a tenth the size of the original), the crop you framed, the name you
   typed, and which tick boxes you set. Enough to come back to exactly where you left off.

   IndexedDB rather than localStorage: localStorage holds strings, caps out around 5 MB, and is
   synchronous — the wrong tool for a handful of photographs.

   One caveat worth knowing: iOS clears this kind of storage for sites you have not opened in about
   seven days. If you come back after a fortnight and the photos have gone, that is Safari, not a
   bug here. Installing the app to the home screen makes it much less likely. */

var RX_DB_NAME = 'resembler';
var RX_DB_STORE = 'people';
var RX_DB_VERSION = 1;
var RX_REMEMBER_KEY = 'rx.remember';
var RX_STORE_MAX_PX = 1600;      // long side of the stored copy
var RX_STORE_QUALITY = 0.82;

/* The switch itself lives in localStorage — it is one boolean, and it has to be readable before the
   database is opened, to decide whether to open it at all. */
function rxRememberOn(){
  try{ return localStorage.getItem(RX_REMEMBER_KEY) === '1'; }catch(e){ return false; }
}
function rxSetRemember(on){
  try{ localStorage.setItem(RX_REMEMBER_KEY, on ? '1' : '0'); }catch(e){ /* private mode: just don't */ }
}

function rxOpenDB(){
  return new Promise(function(resolve, reject){
    if(!self.indexedDB) return reject(new Error('This browser has no storage available.'));
    var req = indexedDB.open(RX_DB_NAME, RX_DB_VERSION);
    req.onupgradeneeded = function(){
      var db = req.result;
      if(!db.objectStoreNames.contains(RX_DB_STORE)) db.createObjectStore(RX_DB_STORE, { keyPath: 'id' });
    };
    req.onsuccess = function(){ resolve(req.result); };
    req.onerror = function(){ reject(req.error || new Error('Storage could not be opened.')); };
  });
}
function rxTx(db, mode, fn){
  return new Promise(function(resolve, reject){
    var tx = db.transaction(RX_DB_STORE, mode);
    var out = fn(tx.objectStore(RX_DB_STORE));
    tx.oncomplete = function(){ resolve(out && out.result !== undefined ? out.result : out); };
    tx.onerror = function(){ reject(tx.error); };
    tx.onabort = function(){ reject(tx.error); };
  });
}

/* A picked file → a smaller JPEG blob to keep. Downscaling here rather than storing the original is
   what keeps six family photographs to a couple of megabytes instead of thirty. */
async function rxShrinkForStore(src){
  var d = rxDims(src);
  var scale = Math.min(1, RX_STORE_MAX_PX / Math.max(d.w, d.h));
  var c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(d.w * scale));
  c.height = Math.max(1, Math.round(d.h * scale));
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return await new Promise(function(res){ c.toBlob(res, 'image/jpeg', RX_STORE_QUALITY); });
}

async function rxRememberPut(record){
  if(!rxRememberOn()) return;
  var db = await rxOpenDB();
  try{ await rxTx(db, 'readwrite', function(store){ store.put(record); }); }
  finally{ db.close(); }
}
async function rxRememberAll(){
  var db = await rxOpenDB();
  try{
    return await new Promise(function(resolve, reject){
      var tx = db.transaction(RX_DB_STORE, 'readonly');
      var req = tx.objectStore(RX_DB_STORE).getAll();
      req.onsuccess = function(){ resolve(req.result || []); };
      req.onerror = function(){ reject(req.error); };
    });
  }finally{ db.close(); }
}
async function rxRememberDelete(id){
  var db = await rxOpenDB();
  try{ await rxTx(db, 'readwrite', function(store){ store.delete(id); }); }
  finally{ db.close(); }
}
/* Erase everything. Used by the Forget button, and run automatically when the switch is turned off —
   turning it off has to mean the photographs are gone, not merely that no more are added. */
async function rxForgetAll(){
  var db = await rxOpenDB();
  try{ await rxTx(db, 'readwrite', function(store){ store.clear(); }); }
  finally{ db.close(); }
}
async function rxRememberCount(){
  try{ return (await rxRememberAll()).length; }catch(e){ return 0; }
}

if(typeof module !== 'undefined' && module.exports){
  module.exports = { RX_DB_NAME: RX_DB_NAME, RX_DB_STORE: RX_DB_STORE, RX_REMEMBER_KEY: RX_REMEMBER_KEY,
    RX_STORE_MAX_PX: RX_STORE_MAX_PX };
}
