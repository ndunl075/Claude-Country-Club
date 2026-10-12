// Acceptance-only solver. Never shipped or available to the game renderer.
import { isMoving, shoot, stepRound } from '../packages/game';
import type { Round } from '../packages/game';

export function planShot(round: Round) {
  const hole=round.holes[round.holeIndex]!;
  const step=20,nx=45,ny=30;
  const free=(x:number,y:number)=>!hole.zones.some(z=>z.kind==='water'&&x>=z.x-10&&x<=z.x+z.width+10&&y>=z.y-10&&y<=z.y+z.height+10)&&!hole.walls.some(w=>{
    const dx=w.b.x-w.a.x,dy=w.b.y-w.a.y,t=Math.max(0,Math.min(1,((x-w.a.x)*dx+(y-w.a.y)*dy)/(dx*dx+dy*dy)));
    return Math.hypot(x-w.a.x-dx*t,y-w.a.y-dy*t)<15;
  });
  const index=(x:number,y:number)=>Math.max(0,Math.min(ny-1,Math.floor(y/step)))*nx+Math.max(0,Math.min(nx-1,Math.floor(x/step)));
  const dist=Array(nx*ny).fill(Infinity),queue=[index(hole.cup.x,hole.cup.y)];dist[queue[0]!]=0;
  for(let i=0;i<queue.length;i++){
    const cell=queue[i]!,x=cell%nx,y=Math.floor(cell/nx);
    for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
      const xx=x+dx!,yy=y+dy!,j=yy*nx+xx;
      if(xx<0||xx>=nx||yy<0||yy>=ny||dist[j]!==Infinity||!free(xx*step+10,yy*step+10))continue;
      dist[j]=dist[cell]+step;queue.push(j);
    }
  }
  const candidates=new Set<string>();
  const add=(angle:number,power:number)=>candidates.add(`${(Math.round(angle)+360)%360},${Math.max(5,Math.min(100,Math.round(power)))}`);
  for(let angle=0;angle<360;angle+=10)for(let power=5;power<=100;power+=10)add(angle,power);
  // Refine the cup direction, including soft shots and overshoots that still capture.
  const direct=Math.atan2(hole.cup.y-round.ball.y,hole.cup.x-round.ball.x)*180/Math.PI;
  for(let offset=-3;offset<=3;offset++)for(let power=5;power<=100;power++)add(direct+offset,power);
  let best:{angle:number,power:number,state:Round,score:number}|undefined;
  for(const key of candidates){
    const [angle,power]=key.split(',').map(Number) as [number,number];
    const radians=angle*Math.PI/180,speed=80+power/100*640;
    let state=shoot(round,{x:Math.cos(radians)*speed,y:Math.sin(radians)*speed});
    for(let tick=0;tick<1400&&isMoving(state);tick++)state=stepRound(state,1/120);
    if(isMoving(state)||state.strokes>round.strokes+1)continue;
    const euclidean=Math.hypot(state.ball.x-hole.cup.x,state.ball.y-hole.cup.y);
    const score=state.status==='holed'?-10000:dist[index(state.ball.x,state.ball.y)]+euclidean*.12;
    if(!best||score<best.score)best={angle,power,state,score};
  }
  if(!best||!Number.isFinite(best.score))throw new Error(`No playable shot for ${hole.id}`);
  return best;
}
