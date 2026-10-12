import { expect,test } from 'vitest';
import { fitWindowBounds } from '../apps/desktop/src/main/windowBounds';
const primary={x:0,y:0,width:1920,height:1040};
const left={x:-1280,y:-160,width:1280,height:984};
test('preserves valid secondary-monitor location including negative coordinates',()=>{
  const candidate={x:-1000,y:-80,width:620,height:600};
  expect(fitWindowBounds(candidate,[primary,left],primary)).toEqual({bounds:candidate,workArea:left});
});
test('chooses greatest overlap, and primary when saved monitor is absent',()=>{
  expect(fitWindowBounds({x:-500,y:50,width:900,height:600},[primary,left],primary).workArea).toEqual(left);
  expect(fitWindowBounds({x:5000,y:-5000,width:620,height:600},[primary,left],primary).workArea).toEqual(primary);
});
test('clamps all edges and shrinks below normal minimum on small work areas',()=>{
  const area={x:20,y:30,width:400,height:300};
  expect(fitWindowBounds({x:40,y:50,width:620,height:600},[area],area)).toEqual({bounds:{x:20,y:30,width:400,height:300},workArea:area});
  const result=fitWindowBounds({x:1850,y:1000,width:620,height:600},[primary],primary);
  expect(result.bounds).toEqual({x:1300,y:440,width:620,height:600});
});
test.each([null,{}, {x:NaN,y:0,width:620,height:600},{x:0,y:Infinity,width:620,height:600}])('malformed preferences fall back inside primary: %j',candidate=>{
  const {bounds}=fitWindowBounds(candidate,[primary,left],primary);
  expect(bounds.width).toBe(620);expect(bounds.height).toBe(600);
  expect(bounds.x).toBeGreaterThanOrEqual(0);expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x+bounds.width).toBeLessThanOrEqual(primary.width);expect(bounds.y+bounds.height).toBeLessThanOrEqual(primary.height);
});
test('ignores invalid displays and returns usable bounds when display metadata is unavailable',()=>{
  const bad={x:0,y:0,width:0,height:NaN};
  const result=fitWindowBounds(null,[bad],bad);
  expect(Object.values(result.bounds).every(Number.isFinite)).toBe(true);expect(result.bounds.width).toBeGreaterThan(0);expect(result.bounds.height).toBeGreaterThan(0);
});
test('varied valid geometry is integral and fully contained by the selected area',()=>{
  for(let i=0;i<150;i++){
    const area={x:-2000+i*3,y:-300+i,width:200+i*7,height:150+i*5};
    const {bounds,workArea}=fitWindowBounds({x:area.x+20.7,y:area.y-15.2,width:50+i*13.4,height:80+i*11.6},[area],area);
    expect(Object.values(bounds).every(Number.isInteger)).toBe(true);
    expect(bounds.x).toBeGreaterThanOrEqual(workArea.x);expect(bounds.y).toBeGreaterThanOrEqual(workArea.y);
    expect(bounds.x+bounds.width).toBeLessThanOrEqual(workArea.x+workArea.width);expect(bounds.y+bounds.height).toBeLessThanOrEqual(workArea.y+workArea.height);
  }
});
