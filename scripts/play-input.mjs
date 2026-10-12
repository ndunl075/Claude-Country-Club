import { expect } from 'playwright/test';
export async function observePointerInput(page){
  await page.evaluate(()=>{
    window.__dragEvidence=[];
    for(const type of ['pointerdown','pointermove','pointerup','pointercancel','gotpointercapture','lostpointercapture','keydown','keyup','focusin','focusout','visibilitychange']){
      document.addEventListener(type,event=>{
        const canvas=document.querySelector('canvas');
        if(window.__dragEvidence.length>=80)window.__dragEvidence.shift();
        window.__dragEvidence.push({type,time:performance.now(),wallTime:Date.now(),x:event.clientX,y:event.clientY,
          id:event.pointerId,button:event.button,target:event.target?.tagName,trusted:event.isTrusted,
          buttons:event.buttons,key:event.key,repeat:event.repeat,
          visibility:document.visibilityState,focused:document.hasFocus(),scroll:{x:scrollX,y:scrollY},
          disabled:canvas?.getAttribute('aria-disabled'),aim:canvas?.getAttribute('aria-description'),
          bounds:canvas?.getBoundingClientRect().toJSON()});
      },true);
    }
  });
}
// Drive the real pointer gesture through the renderer's inverse camera transform.
export async function pullAim(page,{angle=180,power=45,ball}={}){
  const canvas=page.getByRole('application');await expect(canvas).toHaveAttribute('aria-disabled','false');
  await canvas.scrollIntoViewIfNeeded();
  const saved=await page.evaluate(()=>window.countryClub.loadRound());
  ball??=saved?.state?.ball??{x:760,y:300};
  const bounds=await canvas.boundingBox();
  const px=x=>bounds.x+(72+x*.84)/900*bounds.width;
  const py=y=>bounds.y+(48+y*.84)/600*bounds.height;
  const radians=angle*Math.PI/180,distance=power*1.8;
  await page.mouse.move(px(ball.x),py(ball.y));await page.mouse.down();
  await page.mouse.move(px(ball.x-Math.cos(radians)*distance),py(ball.y-Math.sin(radians)*distance),{steps:6});
}
export async function dragShot(page,options){await pullAim(page,options);await page.mouse.up();}
