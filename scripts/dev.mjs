import { spawnSync, spawn } from 'node:child_process';
import electron from 'electron';
const build=spawnSync(process.execPath,['scripts/build.mjs'],{stdio:'inherit'});
if(build.status!==0)process.exit(build.status??1);
const child=spawn(electron,['.'],{stdio:'inherit',windowsHide:false});
child.on('exit',code=>process.exit(code??0));
