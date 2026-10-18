/** Finite-field curve for hand calculation. Point addition is used by ECDSA,
 * but this exercise is NOT an ECDSA signature or a secure key size. */
export type Point = readonly [number, number] | null;
export const CURVE = {p:7,a:2,b:3} as const;
export const mod7 = (n:number) => ((n%7)+7)%7;
export function onCurve(p:Point):boolean {
 return p===null || (p.length===2 && p.every(n=>Number.isInteger(n)&&n>=0&&n<7) && mod7(p[1]*p[1])===mod7(p[0]**3+2*p[0]+3));
}
export function inverse7(n:number):number {
 const value=mod7(n);
 for(let i=1;i<7;i++)if(mod7(value*i)===1)return i;
 throw new Error("zero has no inverse");
}
export function addPoints(p:Point,q:Point):Point {
 if(!onCurve(p)||!onCurve(q))throw new Error("point is not on this curve");
 if(p===null)return q;if(q===null)return p;
 if(p[0]===q[0]&&mod7(p[1]+q[1])===0)return null;
 const slope=p[0]===q[0]?mod7((3*p[0]**2+2)*inverse7(2*p[1])):mod7((q[1]-p[1])*inverse7(q[0]-p[0]));
 const x=mod7(slope*slope-p[0]-q[0]);
 return [x,mod7(slope*(p[0]-x)-p[1])];
}
export const CURVE_POINTS: readonly Point[] = [null,...Array.from({length:49},(_,i)=>[Math.floor(i/7),i%7] as const).filter(onCurve)];
export function parsePoint(s:unknown):Point|undefined {
 if(s==="O")return null;
 if(typeof s!=="string"||!/^\d \d$/.test(s))return undefined;
 const p=s.split(" ").map(Number) as [number,number];return onCurve(p)?p:undefined;
}
