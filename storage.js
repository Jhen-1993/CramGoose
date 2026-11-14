/* Durable browser-local storage. Planner metadata and note text can be committed
   together. Migration is one transaction and never removes legacy data. */
(() => {
  let database;
  const open = new Promise((resolve, reject) => {
    const request = indexedDB.open('cramgoose-library-v2', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('records');
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('請關閉其他溫書鵝分頁，再重新開啟。'));
    request.onsuccess = () => {
      database = request.result;
      database.onversionchange = () => database.close();
      const transaction = database.transaction('records', 'readwrite');
      const records = transaction.objectStore('records');
      const marker = records.get('_migrated');
      marker.onsuccess = () => {
        if (marker.result) return;
        try {
          for (let i=0; i<localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key === 'sg:planner-state' || key.startsWith('sg:note-text:')) {
              records.put(localStorage.getItem(key), key.slice(3));
            }
          }
          records.put('yes', '_migrated');
        } catch(error) { transaction.abort(); }
      };
      transaction.oncomplete = () => resolve(database);
      transaction.onabort = () => reject(transaction.error || new Error('舊資料搬移未完成，原資料仍保留。'));
      transaction.onerror = () => {};
    };
  });
  async function batch(entries={}, deletions=[]) {
    const db=await open;
    return new Promise((resolve,reject) => {
      const tx=db.transaction('records','readwrite'), store=tx.objectStore('records');
      for(const key of deletions) store.delete(key);
      for(const [key,value] of Object.entries(entries)) store.put(value,key);
      tx.oncomplete=()=>resolve(true);
      tx.onabort=()=>reject(tx.error || new Error('儲存未完成'));
      tx.onerror=()=>{};
    });
  }
  window.storage={
    ready:open, batch,
    async get(key) {
      const db=await open;
      return new Promise((resolve,reject)=>{
        const r=db.transaction('records').objectStore('records').get(key);
        r.onsuccess=()=>resolve(r.result===undefined?null:{key,value:r.result,shared:false});
        r.onerror=()=>reject(r.error);
      });
    },
    async set(key,value){await batch({[key]:value});return {key,value,shared:false};},
    async delete(key){await batch({},[key]);return {key,deleted:true};},
    async list(prefix=''){
      const db=await open;
      return new Promise((resolve,reject)=>{
        const r=db.transaction('records').objectStore('records').getAllKeys();
        r.onsuccess=()=>resolve({keys:r.result.filter(k=>k.startsWith(prefix))});
        r.onerror=()=>reject(r.error);
      });
    }
  };
  open.catch(()=>{ const banner=document.getElementById('storageErrorBanner'); if(banner) banner.style.display='block'; });
})();
