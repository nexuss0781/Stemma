// Android-only account-photo response validation. Bytes remain transient in memory;
// only bounded MIME/length/format/dimension metadata is observable by diagnostics.
export function installPhotoResponseValidation(root = window) {
  const MAX_BYTES = 1024 * 1024, MAX_SIDE = 8192, MAX_PIXELS = 16777216;
  const types = { PNG:'image/png', JPEG:'image/jpeg', WebP:'image/webp' };
  const token = /^[a-z0-9!#$&^_.+\-]+\/[a-z0-9!#$&^_.+\-]+$/;
  function normalizeMime(value) {
    if (value == null || String(value).trim() === '') return 'missing';
    const text = String(value).toLowerCase();
    if (text.length > 1024 || /[\r\n\x00-\x1f\x7f]/.test(text)) return 'invalid';
    const entries = text.split(',').map(part => part.split(';',1)[0].trim());
    const result = entries.join(', ');
    return entries.length <= 4 && result.length <= 127 && entries.every(part => token.test(part)) ? result : 'invalid';
  }
  function normalizeLength(value) {
    if (value == null || value === '') return 'missing';
    return /^\d{1,12}$/.test(String(value)) ? Number(value) : 'invalid';
  }
  function error(category, phase) {
    const e = new Error('Account photo validation failed.');
    e.name = 'PhotoValidationError'; e.photoCategory = category; e.photoPhase = phase;
    return e;
  }
  function checkAbort(signal, phase) { if (signal?.aborted) throw error('aborted',phase); }
  function magic(bytes) {
    if (bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((n,i)=>bytes[i]===n)) return 'PNG';
    if (bytes.length >= 3 && bytes[0]===255 && bytes[1]===216 && bytes[2]===255) return 'JPEG';
    if (bytes.length >= 16 && bytes[0]===82 && bytes[1]===73 && bytes[2]===70 && bytes[3]===70 &&
        bytes[8]===87 && bytes[9]===69 && bytes[10]===66 && bytes[11]===80 &&
        bytes[12]===86 && bytes[13]===80 && bytes[14]===56 && [32,76,88].includes(bytes[15])) return 'WebP';
    if (bytes.length >= 6 && bytes[0]===71 && bytes[1]===73 && bytes[2]===70 && bytes[3]===56 && [55,57].includes(bytes[4]) && bytes[5]===97) return 'GIF';
    return 'unknown';
  }
  function dimensions(bytes, format) {
    const v = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    if (format==='PNG' && bytes.length>=24 && bytes[12]===73 && bytes[13]===72 && bytes[14]===68 && bytes[15]===82) return [v.getUint32(16),v.getUint32(20)];
    if (format==='WebP') {
      if(bytes[15]===88 && bytes.length>=30) return [1+bytes[24]+(bytes[25]<<8)+(bytes[26]<<16),1+bytes[27]+(bytes[28]<<8)+(bytes[29]<<16)];
      if(bytes[15]===76 && bytes.length>=25 && bytes[20]===47){const bits=v.getUint32(21,true);return [1+(bits&16383),1+((bits>>>14)&16383)];}
      if(bytes[15]===32 && bytes.length>=30 && bytes[23]===157 && bytes[24]===1 && bytes[25]===42) return [v.getUint16(26,true)&16383,v.getUint16(28,true)&16383];
    }
    if(format==='JPEG') {
      let offset=2;
      while(offset+3<bytes.length){
        if(bytes[offset++]!==255)return null;
        while(offset<bytes.length && bytes[offset]===255)offset++;
        if(offset>=bytes.length)return null;
        const marker=bytes[offset++];
        if(marker===217 || marker===218)return null;
        if(marker===1 || (marker>=208 && marker<=215))continue;
        if(offset+2>bytes.length)return null;
        const length=v.getUint16(offset);
        if(length<2 || offset+length>bytes.length)return null;
        if(marker>=192 && marker<=207 && ![196,200,204].includes(marker) && length>=7)return [v.getUint16(offset+5),v.getUint16(offset+3)];
        offset+=length;
      }
    }
    return null;
  }
  function checkDimensions(size) {
    if (!size) return;
    const [w,h]=size;
    if (!w || !h) throw error('corrupt-image','image-decode');
    if(w>MAX_SIDE || h>MAX_SIDE || w*h>MAX_PIXELS) throw error('image-dimensions','image-decode');
  }
  async function readBytes(response, signal, observe) {
    const reader=response.body && typeof response.body.getReader==='function' ? response.body.getReader() : null;
    // Target WebViews support streams. Fail closed rather than buffering an
    // unbounded, untrusted body on a streamless implementation.
    if(!reader)throw error('body-read','body-read');
    const chunks=[];let size=0;
    const cancel=()=>{try{Promise.resolve(reader.cancel()).catch(()=>{});}catch{}};
    signal?.addEventListener('abort',cancel,{once:true});
    try {
      while(true){
        checkAbort(signal,'body-read');
        let entry;try{entry=await reader.read();}catch{checkAbort(signal,'body-read');throw error('body-read','body-read');}
        checkAbort(signal,'body-read');
        if(entry.done)break;
        const value=entry.value;
        if(!(value instanceof Uint8Array))throw error('body-read','body-read');
        size+=value.byteLength;observe({phase:'body-read',byteLength:size});
        if(size>MAX_BYTES)throw error('body-size','body-read');
        chunks.push(value);
      }
      if(!size)throw error('empty-body','body-read');
      const bytes=new Uint8Array(size);let offset=0;
      for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
      return bytes;
    } catch(e) { cancel();throw e; }
    finally {signal?.removeEventListener('abort',cancel);try{reader.releaseLock();}catch{}}
  }
  async function decode(blob, signal) {
    checkAbort(signal,'image-decode');
    return new Promise((resolve,reject)=>{
      let url, image, settled=false, timer;
      const finish=(err,size)=>{
        if(settled)return;settled=true;
        root.clearTimeout(timer);signal?.removeEventListener('abort',abort);
        if(image){image.onload=null;image.onerror=null;image.removeAttribute('src');}
        if(url)root.URL.revokeObjectURL(url);
        if(err)reject(err);else resolve(size);
      };
      const abort=()=>finish(error('aborted','image-decode'));
      try{
        image=new root.Image();url=root.URL.createObjectURL(blob);
        image.onerror=()=>finish(error('corrupt-image','image-decode'));
        image.onload=async()=>{
          try{
            if(typeof image.decode==='function')await image.decode();
            checkAbort(signal,'image-decode');
            const size=[image.naturalWidth,image.naturalHeight];checkDimensions(size);
            finish(null,size);
          }catch(e){finish(e?.photoCategory?e:error('corrupt-image','image-decode'));}
        };
        timer=root.setTimeout(()=>finish(error('timeout','image-decode')),5000);
        signal?.addEventListener('abort',abort,{once:true});
        if(signal?.aborted){abort();return;}
        image.src=url;
      }catch{finish(error('corrupt-image','image-decode'));}
    });
  }
  async function read(response,{signal,observe:observer}={}) {
    const observe=fields=>{try{if(typeof observer==='function')observer(fields);}catch{}};
    checkAbort(signal,'response-validation');
    const declaredByteLength=normalizeLength(response.headers?.get?.('content-length'));
    observe({phase:'response-validation',responseMime:normalizeMime(response.headers?.get?.('content-type')),declaredByteLength});
    if(declaredByteLength!=='missing' && (declaredByteLength==='invalid' || declaredByteLength<=0 || declaredByteLength>MAX_BYTES)){
      try{await response.body?.cancel();}catch{}
      throw error('content-length','response-validation');
    }
    observe({phase:'body-read'});
    const bytes=await readBytes(response,signal,observe);checkAbort(signal,'signature-validation');
    const magicType=magic(bytes), normalizedMime=types[magicType]||null;
    observe({phase:'signature-validation',magicType,normalizedMime});
    if(magicType==='unknown')throw error('non-image','signature-validation');
    if(!normalizedMime)throw error('mime','signature-validation');
    const blob=new root.Blob([bytes],{type:normalizedMime});
    observe({phase:'image-decode'});
    try{
      const headerDimensions=dimensions(bytes,magicType);
      if(!headerDimensions)throw error('corrupt-image','image-decode');
      checkDimensions(headerDimensions);
      const [width,height]=await decode(blob,signal);
      observe({phase:'image-decode',decode:{ok:true,width,height}});
    }catch(e){observe({phase:'image-decode',decode:{ok:false,width:null,height:null}});throw e;}
    return blob;
  }
  const api=Object.freeze({read,normalizeMime,normalizeLength,limits:Object.freeze({maxBytes:MAX_BYTES,maxSide:MAX_SIDE,maxPixels:MAX_PIXELS})});
  root.StemmaAndroidPhotoResponse=api;
  return api;
}
