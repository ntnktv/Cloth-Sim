import {transformPoint} from './scene.mjs';
export function flagBounds(flag){
  let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity;
  for(let i=0;i<flag.cloth.p.length;i+=3){const [x,y]=transformPoint(flag,...flag.cloth.p.subarray(i,i+3));left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);}
  return {left,top,right,bottom};
}
export function beginResize(flag,corner,point){
  const b=flagBounds(flag),right=corner.includes('e'),bottom=corner.includes('s');
  const anchor={x:right?b.left:b.right,y:bottom?b.top:b.bottom};
  const dx=(right?b.right:b.left)-anchor.x,dy=(bottom?b.bottom:b.top)-anchor.y;
  return {anchor,dx,dy,point,width:flag.width,x:flag.x,y:flag.y};
}
export function resizeFromPointer(start,point){
  const {anchor,dx,dy}=start,den=dx*dx+dy*dy;
  const raw=den>1e-12?1+((point.x-start.point.x)*dx+(point.y-start.point.y)*dy)/den:1;
  const scale=Math.max(1/start.width,Math.min(100000/start.width,raw));
  return {width:start.width*scale,x:anchor.x+(start.x-anchor.x)*scale,y:anchor.y+(start.y-anchor.y)*scale};
}
