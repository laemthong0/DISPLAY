const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
function extract(name) {
  const marker = '    function ' + name + '(';
  const pos = html.indexOf(marker);
  assert.ok(pos >= 0, 'Missing ' + name);
  const next = html.indexOf('\n    function ', pos + marker.length);
  return html.slice(pos, next < 0 ? undefined : next);
}
test('cross-tab search finds matches from multiple brand tabs, excludes hidden rows', () => {
  const context = vm.createContext({
    data: { sheetPages: ['ปุ๋ย A', 'ปุ๋ย B', 'ปุ๋ย C'] },
    getProductsForSheetState: name => ({
      'ปุ๋ย A': [{name:'15-15-15 A', price:'600'}, {name:'15-15-15 ซ่อน', status:'ซ่อน'}],
      'ปุ๋ย B': [{name:'15-15-15 B', price:'550'}],
      'ปุ๋ย C': [{name:'16-16-16', price:'500'}]
    })[name],
    isProductVisible: item => item.status !== 'ซ่อน',
    productMatchesFilter: (item,q) => item.name.includes(q),
    sortProductsByPriceAsc: rows => [...rows].sort((a,b)=>Number(a.price)-Number(b.price)),
    clean: s => String(s||'').trim()
  });
  vm.runInContext(extract('getCrossTabSearchResults'), context);
  const found = context.getCrossTabSearchResults('15-15-15');
  assert.deepEqual(Array.from(found,x=>x.sourceSheet), ['ปุ๋ย B','ปุ๋ย A']);
});
test('cross-tab results are divided over two screens except a small search mirrored on both', () => {
  const fn = extract('getWallSlice');
  function slice(index, count) {
    const c=vm.createContext({WALL_CONFIG:{enabled:true,screenIndex:index,screen:index+1,screens:2}});
    vm.runInContext(fn,c);
    return c.getWallSlice(count);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(slice(0,6))),{start:0,end:3,singleScreen:false});
  assert.deepEqual(JSON.parse(JSON.stringify(slice(1,6))),{start:3,end:6,singleScreen:false});
  assert.match(html,/filterActive && WALL_CONFIG.enabled && wallPageProducts.length <= 3/);
  assert.match(html,/getCrossTabSearchResults\(productFilterQuery\)/);
});
test('freshness UI always distinguishes cached prices from online prices', () => {
  assert.match(html,/ราคาออฟไลน์ \/ ข้อมูลสำรอง/);
  assert.match(html,/อัปเดตล่าสุด:/);
  assert.match(html,/sheetUsingFallback\[sheetName\] = true/);
  assert.match(html,/id="priceFreshness"/);
});
