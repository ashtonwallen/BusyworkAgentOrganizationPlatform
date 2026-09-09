const storageKey='busywork.dismissed-failures';
let dismissed;try{dismissed=new Set(JSON.parse(localStorage.getItem(storageKey)||'[]'));}catch{dismissed=new Set();}
const key=t=>JSON.stringify([t.id,t.status,t.attempts,t.error]);
export const failureDismissed=t=>!!t&&dismissed.has(key(t));
export function dismissFailures(tasks){
 for(const t of tasks)if(['FAILED','EXPIRED'].includes(t.status))dismissed.add(key(t));
 dismissed=new Set([...dismissed].slice(-200));
 try{localStorage.setItem(storageKey,JSON.stringify([...dismissed]));}catch{}
}
