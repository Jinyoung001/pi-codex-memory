// Port of utils/string/src/truncate.rs at the pinned commit. The marker is
// additional to the retained byte budget; upstream callers reserve space for it.
export function truncateBytes(text: string, budget: number, tokens = false): string {
  const bytes=Buffer.from(text), max=Math.max(0,Math.floor(budget));
  if(!text || bytes.length<=max)return text;
  let head=Math.floor(max/2),tail=bytes.length-(max-head);
  while(head>0&&(bytes[head]&0xc0)===0x80)head--;
  while(tail<bytes.length&&(bytes[tail]&0xc0)===0x80)tail++;
  const removed=tokens?Math.ceil((bytes.length-max)/4):[...bytes.subarray(head,tail).toString('utf8')].length;
  return bytes.subarray(0,head).toString('utf8')+`…${removed} ${tokens?'tokens':'chars'} truncated…`+bytes.subarray(tail).toString('utf8');
}
export const truncateTokens=(text:string,tokens:number)=>truncateBytes(text,Math.max(0,Math.floor(tokens))*4,true);
