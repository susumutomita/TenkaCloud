/** PLONK-style arithmetization worksheet, not a succinct or zero-knowledge proof. */
export type GateRow = readonly [number, number, number];
export interface ConstraintTask {
  readonly kind: 'snark-constraints';
  readonly rows: readonly [GateRow, GateRow, GateRow];
}
const mod = (n: number) => ((n % 7) + 7) % 7;
/** Three gate residuals, then the two required output-to-input wire residuals. */
export function constraintResiduals(task: ConstraintTask): readonly number[] {
  const [a, b, c] = task.rows;
  return [mod(a[0] + a[1] - a[2]), mod(b[0] * b[1] - b[2]),
    mod(c[0] + c[1] - c[2]), mod(a[2] - c[0]), mod(b[2] - c[1])];
}
export function constraintTask(bytes: readonly number[]): ConstraintTask {
  const a = bytes[0]! % 7, b = bytes[1]! % 7, c = bytes[2]! % 7, d = bytes[3]! % 7;
  // Each constraint can fail independently, with any remainder. Occasionally
  // issue a consistent table as well; no fixed three-answer retry template.
  const residuals = bytes[4]! % 8 === 0 ? [0,0,0,0,0]
    : bytes.slice(5,10).map(n=>n%7);
  if(residuals.length !== 5) throw new Error('constraintTask requires ten bytes');
  const [r0,r1,r2,r3,r4]=residuals as [number,number,number,number,number];
  const sum=mod(a+b-r0), product=mod(c*d-r1);
  const left=mod(sum-r3), right=mod(product-r4);
  return {kind:'snark-constraints',rows:[[a,b,sum],[c,d,product],[left,right,mod(left+right-r2)]]};
}
export function parseResiduals(answer: unknown): readonly number[] | undefined {
  return typeof answer === 'string' && /^[0-6]( [0-6]){4}$/.test(answer)
    ? answer.split(' ').map(Number) : undefined;
}
