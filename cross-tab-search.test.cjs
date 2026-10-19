const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const html=fs.readFileSync(__dirname+'/index.html','utf8');
function extract(name){const m='    function '+name+'(';const i=html.indexOf(m);assert.ok(i>=0,name);const j=html.indexOf('\n    function ',i+m.length);return html.slice(i,j<0?undefined:j);}
test('brand query returns visible items from all three tabs',()=>{
const ctx=vm.createContext({data:{sheetPages:['A','B','C']},getProductsForSheetState:n=>({A:[{name:'Yara 15-15-15',price:'600'}],B:[{name:'Yara 16-16-16',price:'550'}],C:[{name:'Yara hidden',status:'hide'},{name:'Other',price:'100'}]})[n],isProductVisible:p=>p.status!=='hide',productMatchesFilter:(p,q)=>p.name.toLowerCase().includes(q.toLowerCase()),sortProductsByPriceAsc:p=>p.sort((x,y)=>Number(x.price)-Number(y.price)),clean:v=>String(v||'').trim()});
vm.runInContext(extract('getAllTabSearchProducts'),ctx);
assert.deepEqual(Array.from(ctx.getAllTabSearchProducts('Yara'),p=>p.sourceSheet),['B','A']);
});
test('search mirrors <=3 results on both screens and normal mode remains separate',()=>{
assert.match(html,/filterActive && WALL_CONFIG.enabled && wallPageProducts.length <= 3/);
assert.match(html,/filterActive \? getAllTabSearchProducts\(productFilterQuery\) : baseViewProducts/);
const start=html.indexOf('    function getProductsForWallSlot(');
const end=html.indexOf('\n    function ',start+12);
assert.ok(!html.slice(start,end).includes('filterActive'),'preload unaffected by search-only variable');
});
