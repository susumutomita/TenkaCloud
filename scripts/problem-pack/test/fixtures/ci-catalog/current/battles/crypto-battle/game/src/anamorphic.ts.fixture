/** Section 5.1 rejection-sampling teaching model. Tiny ElGamal arithmetic
 * and a six-entry balanced secret lookup replace IND-CPA security and a PRF.
 * This finite, one-message model is not secure reusable anamorphic encryption. */
export type AnamorphicCipher = readonly [number,number];
const mod=(n:number)=>((n%7)+7)%7;
export function anamorphicPower(base:number,exponent:number):number{
 let result=1;for(let i=0;i<exponent;i++)result=mod(result*base);return result;
}
export function anamorphicEncrypt(message:number,key:number,randomness:number):AnamorphicCipher{
 return [anamorphicPower(3,randomness),mod(message*anamorphicPower(anamorphicPower(3,key),randomness))];
}
export function anamorphicDecrypt(cipher:AnamorphicCipher,key:number):number{
 const mask=anamorphicPower(cipher[0],key);
 const inverse=[1,2,3,4,5,6].find(n=>n*mask%7===1);
 if(inverse===undefined)throw new Error('invalid multiplicative ciphertext');
 return mod(cipher[1]*inverse);
}
export const ANAMORPHIC_LOOKUPS:readonly (readonly number[])[]=Array.from({length:64},(_,n)=>Array.from({length:6},(_,i)=>(n>>i)&1)).filter(row=>row.reduce((a,b)=>a+b,0)===3);
export interface AnamorphicTask{
 readonly kind:'anamorphic-rejection';
 /** Missing only on persisted legacy combined worksheets. */
 readonly exercise?: 'encrypt' | 'decrypt' | 'probability';
 readonly ordinaryKey:number;
 readonly candidates:readonly AnamorphicCipher[];
 /** The participant acts as sender/receiver; this additional table is NOT in the monitor's view. */
 readonly secretBits:readonly number[];
 readonly targetBit:number;
 /** Changed randomness for the transfer question: copies of each trial ticket. */
 readonly tickets:readonly number[];
}
export function anamorphicAnswer(task:AnamorphicTask):readonly number[]{
 if(task.exercise==='encrypt')return [task.secretBits.indexOf(task.targetBit)+1];
 if(task.exercise==='decrypt')return [anamorphicDecrypt(task.candidates[0]!,task.ordinaryKey)];
 if(task.exercise==='probability')return [task.tickets.reduce((sum,count,i)=>sum+(task.secretBits[i]===task.targetBit?count:0),0)];
 const selected=task.secretBits.indexOf(task.targetBit);
 if(selected<0)throw new Error('no matching candidate');
 return [selected+1,anamorphicDecrypt(task.candidates[selected]!,task.ordinaryKey),task.tickets.reduce((sum,count,i)=>sum+(task.secretBits[i]===task.targetBit?count:0),0)];
}
/** Reject the incomplete tail so every result has exactly the same number of byte preimages. */
export function anamorphicUniformIndex(nextByte:()=>number,bound:number):number{
 if(!Number.isInteger(bound)||bound<1||bound>256)throw new Error('invalid random bound');
 const limit=256-256%bound;
 for(;;){
  const byte=nextByte();
  if(!Number.isInteger(byte)||byte<0||byte>255)throw new Error('invalid random byte');
  if(byte<limit)return byte%bound;
 }
}
export function anamorphicTask(nextByte:()=>number):AnamorphicTask{
 const pick=(bound:number)=>anamorphicUniformIndex(nextByte,bound);
 const ordinaryKey=1+pick(5),message=1+pick(6);
 const lookup=ANAMORPHIC_LOOKUPS[pick(20)]!,targetBit=pick(2);
 const trials=[0,1,2,3,4,5];
 for(let i=5;i>0;i--){const j=pick(i+1);[trials[i],trials[j]]=[trials[j]!,trials[i]!];}
 return {kind:'anamorphic-rejection',ordinaryKey,candidates:trials.map(r=>anamorphicEncrypt(message,ordinaryKey,r)),secretBits:trials.map(r=>lookup[r]!),targetBit,tickets:trials.map(()=>1+pick(3))};
}
export function parseAnamorphicAnswer(answer:unknown,task?:AnamorphicTask):readonly number[]|undefined{
 if(task?.exercise){const pattern=task.exercise==='probability'?/^[3-9]$/:/^[1-6]$/;return typeof answer==='string'&&pattern.test(answer)?[Number(answer)]:undefined;}
 return typeof answer==='string'&&/^[1-6] [1-6] [3-9]$/.test(answer)?answer.split(' ').map(Number):undefined;
}
