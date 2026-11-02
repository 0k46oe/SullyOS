import {useEffect,useState} from 'react';

/** Debounce only rendering; callers keep their current draft for save/apply actions. */
export function usePreviewDraft<T>(value:T,editing:boolean,paused=false){
 const [settled,setSettled]=useState(value);
 useEffect(()=>{
  if(!editing){setSettled(value);return;}
  // CSS can contain megabytes of embedded images. Do not rebuild a preview
  // while its textarea owns focus, even when the user pauses between keystrokes.
  if(paused)return;
  const timer=setTimeout(()=>setSettled(value),300);
  return()=>clearTimeout(timer);
 },[value,editing,paused]);
 return editing?settled:value;
}
