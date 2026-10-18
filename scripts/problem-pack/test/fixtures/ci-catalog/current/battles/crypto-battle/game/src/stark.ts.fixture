/** Trace -> AIR divisibility -> one FRI fold over F7.
 * This arithmetic model has no Merkle commitment, random queries or ZK mask;
 * it is not a full STARK proof system. Coefficients are constant-first. */
export type StarkTrace = readonly [number, number, number];
export interface StarkTask {
  readonly kind: 'stark-trace';
  readonly trace: StarkTrace;
  readonly beta: number;
}
const mod = (n:number)=>((n%7)+7)%7;
export function starkEvaluate(coefficients:readonly number[],x:number):number {
  return coefficients.reduceRight((sum,c)=>mod(sum*x+c),0);
}
/** Lagrange bases at 1,2,4 are [5,5,5], [5,6,3], [5,3,6]. */
export function starkPolynomials(task:StarkTask){
  const [a,b,c]=task.trace;
  const trace=[mod(5*a+5*b+5*c),mod(5*a+6*b+3*c),mod(5*a+3*b+6*c)];
  // C(X)=T(2X)-T(X)^2. Only transitions 1 -> 2 and 2 -> 4 are required.
  const constraint=Array<number>(5).fill(0);
  for(let i=0;i<3;i++){
    constraint[i]=mod(constraint[i]!+trace[i]!*2**i);
    for(let j=0;j<3;j++)constraint[i+j]=mod(constraint[i+j]!-trace[i]!*trace[j]!);
  }
  const divisor=[2,4,1]; // (X-1)(X-2); last row does not wrap back to the first.
  const remainder=[...constraint],quotient=Array<number>(3).fill(0);
  for(let degree=4;degree>=2;degree--){
    const coefficient=remainder[degree]!;quotient[degree-2]=coefficient;
    for(let j=0;j<3;j++)remainder[degree-2+j]=mod(remainder[degree-2+j]!-coefficient*divisor[j]!);
  }
  const folded=[mod(quotient[0]!+task.beta*quotient[1]!),quotient[2]!];
  return {trace,constraint,divisor,quotient,remainder:remainder.slice(0,2),folded};
}
/** Check both transitions separately, then compute the constant of Q's fold.
 * A fold alone is not evidence that the original trace satisfied its AIR. */
export function starkAnswer(task:StarkTask):readonly number[]{
  const [a,b,c]=task.trace,p=starkPolynomials(task);
  return [mod(b-a*a),mod(c-b*b),p.remainder[0]!,p.folded[0]!];
}
export function starkTask(bytes:readonly number[]):StarkTask{
  if(bytes.length<4)throw new Error('starkTask requires four bytes');
  const a=bytes[0]!%7;
  const b=mod(a*a+(bytes[3]!%4===0?0:bytes[1]!%7));
  const c=mod(b*b+(bytes[3]!%4===0?0:bytes[2]!%7));
  return {kind:'stark-trace',trace:[a,b,c],beta:1+bytes[3]!%6};
}
export function parseStarkAnswer(answer:unknown):readonly number[]|undefined{
  return typeof answer==='string'&&/^[0-6]( [0-6]){3}$/.test(answer)?answer.split(' ').map(Number):undefined;
}
