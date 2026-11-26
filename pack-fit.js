/* Trim only visible margins on the TV, never the original sheet image. */
(() => {
  const bounds = new Map();
  const getBounds = (ctx,w,h) => {
    const pixels = ctx.getImageData(0,0,w,h).data;
    const pale = i => pixels[i]>246 && pixels[i+1]>246 && pixels[i+2]>246;
    const whitePaper = [0,(w-1)*4,(h-1)*w*4,(w*h-1)*4].every(i=>pixels[i+3]>=250 && pale(i));
    let x0=w,y0=h,x1=-1,y1=-1;
    for(let y=0,i=0;y<h;y++) for(let x=0;x<w;x++,i+=4){
      if(pixels[i+3]<12 || (whitePaper && pale(i))) continue;
      if(x<x0)x0=x;if(x>x1)x1=x;if(y<y0)y0=y;if(y>y1)y1=y;
    }
    if(x1<x0 || y1<y0) return [0,0,w,h];
    x0=Math.max(0,x0-1);y0=Math.max(0,y0-1);x1=Math.min(w-1,x1+1);y1=Math.min(h-1,y1+1);
    return [x0,y0,x1-x0+1,y1-y0+1];
  };
  let frame=0;
  function sizePacks(){
    if(frame)return;
    frame=requestAnimationFrame(()=>{
      frame=0;
      const grid=document.getElementById('productGrid'); if(!grid)return;
      const bays=Array.from(grid.querySelectorAll('.lt-bay')); if(!bays.length)return;
      let height=Infinity;
      for(const bay of bays){
        const pack=bay.querySelector('.lt-pack');if(!pack)continue;
        const ratio=Number(pack.dataset.ratio)||0.75;
        height=Math.min(height,bay.clientHeight-parseFloat(getComputedStyle(bay).paddingTop), bay.clientWidth*.90/ratio);
      }
      if(Number.isFinite(height)&&height>0)grid.style.setProperty('--lt-pack-height',Math.floor(height)+'px');
    });
  }
  function loaded(img){
    if(!img.isConnected)return;
    img.dataset.ratio=img.naturalWidth/img.naturalHeight;
    if(!img.crossOrigin){sizePacks();return;}
    try {
      const w=img.naturalWidth,h=img.naturalHeight;if(!w||!h||w*h>2e6){sizePacks();return;}
      const scratch=document.createElement('canvas');let rect=bounds.get(img.currentSrc);
      if(!rect){
        scratch.width=w;scratch.height=h;const ctx=scratch.getContext('2d',{willReadFrequently:true});ctx.drawImage(img,0,0);
        rect=getBounds(ctx,w,h);if(bounds.size>=240)bounds.delete(bounds.keys().next().value);bounds.set(img.currentSrc,rect);
      }
      const [x,y,cw,ch]=rect;scratch.width=cw;scratch.height=ch;
      scratch.getContext('2d').drawImage(img,x,y,cw,ch,0,0,cw,ch);scratch.className='lt-pack';scratch.dataset.ratio=cw/ch;
      scratch.setAttribute('role','img');scratch.setAttribute('aria-label',img.alt);img.replaceWith(scratch);
    } catch { /* CORS or limited canvas: keep the original product visible. */ }
    sizePacks();
  }
  function failed(img){
    if(img.dataset.original){const src=img.dataset.original;delete img.dataset.original;img.removeAttribute('crossorigin');img.src=src;return;}
    img.replaceWith(Object.assign(document.createElement('div'),{className:'lt-missing',textContent:'ไม่มีรูป'}));sizePacks();
  }
  function source(url){
    try{const u=new URL(url),id=u.searchParams.get('id'),sz=u.searchParams.get('sz');
      if(u.hostname==='drive.google.com' && u.pathname==='/thumbnail' && /^[a-zA-Z0-9_-]+$/.test(id||'') && /^w\d{2,4}$/.test(sz||''))return `https://lh3.googleusercontent.com/d/${id}=${sz}`;
    }catch{}return '';
  }
  window.packFit={source,loaded,failed,refresh:sizePacks};window.addEventListener('resize',sizePacks);
})();
