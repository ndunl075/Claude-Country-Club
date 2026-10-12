import { _electron as electron, expect } from 'playwright/test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
assert(process.env.CCC_EXECUTABLE, 'Set CCC_EXECUTABLE to the packaged application');
const artifacts=path.resolve('work/private-preview');await mkdir(artifacts,{recursive:true});
const profile=await mkdtemp(path.join(artifacts,'profile-')),data=path.join(profile,'data'),home=path.join(profile,'home');
const env={...process.env,CCC_TEST_MODE:'1',CCC_DATA_DIR:data,CCC_TEST_HOME:home};delete env.ELECTRON_RUN_AS_NODE;
const fixtures=new Map(),checks=[];let app;
for(const provider of ['claude','codex']){
  const file=path.join(home,provider==='claude'?'.claude':'.codex',provider==='claude'?'settings.json':'hooks.json');
  const obj={privateToken:`fixture-secret-${provider}`,largeUnrelatedSetting:'x'.repeat(400000),hooks:{UserPromptSubmit:[{hooks:[{type:'command',command:`third-party-private-${provider}`,timeout:3}]}]}};
  const bytes=JSON.stringify(obj);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,bytes);fixtures.set(provider,{file,obj,bytes});
}
try{
  app=await electron.launch({executablePath:process.env.CCC_EXECUTABLE,env,timeout:30000});const page=await app.firstWindow();
  await page.getByRole('button',{name:'Connections',exact:true}).click();
  for(const [provider,{file,obj,bytes}] of fixtures){
    const card=page.locator('.provider-card').filter({has:page.getByRole('heading',{name:provider==='claude'?'Claude Code':'Codex CLI',exact:true})});
    const preview=await page.evaluate(p=>window.countryClub.previewIntegration(p),provider);
    const serialized=JSON.stringify(preview);assert(serialized.length<20000);
    for(const hidden of [obj.privateToken,obj.largeUnrelatedSetting,obj.hooks.UserPromptSubmit[0].hooks[0].command])assert(!serialized.includes(hidden));
    await card.getByRole('button',{name:'Review connection',exact:true}).click();
    const dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();
    const shown=await dialog.innerText();assert(shown.includes('Only Country Club hook entries'));assert(shown.includes('may contain sensitive user settings'));
    assert(!shown.includes(obj.privateToken));assert(!shown.includes('third-party-private-'));
    await dialog.getByRole('button',{name:'Keep as is',exact:true}).click();assert.equal(await readFile(file,'utf8'),bytes);
    await card.getByRole('button',{name:'Review connection',exact:true}).click();
    await dialog.getByRole('button',{name:'Confirm connection',exact:true}).click();await expect(dialog).toHaveCount(0);
    const applied=JSON.parse(await readFile(file,'utf8'));assert.equal(applied.privateToken,obj.privateToken);assert.equal(applied.largeUnrelatedSetting,obj.largeUnrelatedSetting);
    assert.deepEqual(applied.hooks.UserPromptSubmit[0],obj.hooks.UserPromptSubmit[0]);assert.equal(applied.hooks.UserPromptSubmit.length,2);
    const ledgerText=await readFile(path.join(data,'config-patches.json'),'utf8'),ledger=JSON.parse(ledgerText);
    assert.equal(await readFile(ledger[provider].backupPath,'utf8'),bytes);assert(!ledgerText.includes(obj.privateToken));
    const host=JSON.stringify(await page.evaluate(()=>window.countryClub.getState()));assert(!host.includes(obj.privateToken));
    const stale=await page.evaluate(p=>window.countryClub.previewIntegration(p),provider);
    const changed={...applied,privateToken:`changed-${provider}`};await writeFile(file,JSON.stringify(changed));
    const refusal=await page.evaluate(async p=>{try{await window.countryClub.applyIntegration(p);return false;}catch{return true;}},stale);
    assert(refusal);assert.deepEqual(JSON.parse(await readFile(file,'utf8')),changed);
    await card.getByRole('button',{name:'Review disconnection',exact:true}).click();
    await dialog.getByRole('button',{name:'Confirm disconnection',exact:true}).click();await expect(dialog).toHaveCount(0);
    assert.deepEqual(JSON.parse(await readFile(file,'utf8')),{...obj,privateToken:`changed-${provider}`});
    checks.push(`${provider}: large private settings stay outside preview/renderer; cancel is byte-preserving, UI confirmation merges hooks, full backup is exact, hidden-field changes reject stale preview, UI removal preserves third-party settings`);
  }
  await writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:true,packaged:true,checks,limitations:['Isolated fixture configurations only; complete local rollback backups intentionally contain the original settings. No live client trust or signed-in lifecycle certification.']},null,2));
  console.log('Packaged private preview acceptance passed.');
}catch(error){await writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:false,error:String(error),checks},null,2));throw error;}
finally{await app?.close().catch(()=>{});}
