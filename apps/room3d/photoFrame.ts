export const photoFrames={landscape:{label:'横幅 16:9',aspect:16/9},cinema:{label:'电影 2.39:1',aspect:2.39},portrait:{label:'竖幅 3:4',aspect:3/4},square:{label:'方形 1:1',aspect:1}};
export type PhotoFrame=keyof typeof photoFrames;
export type PhotoRenderOptions={aspect?:number;quality?:'moving'|'preview'|'export'};
export function photoSize(aspect:number,quality:PhotoRenderOptions['quality']='preview'){
 const ratio=Number.isFinite(aspect)&&aspect>0?Math.max(.4,Math.min(3,aspect)):16/9;
 const edge=quality==='export'?2560:quality==='moving'?768:1280;
 return {width:Math.round(ratio>=1?edge:edge*ratio),height:Math.round(ratio>=1?edge/ratio:edge)};
}
/** Screen deltas transformed back into the temporarily rotated viewfinder. */
export function photoDrag(dx:number,dy:number,rotated:boolean){return rotated?{dx:dy,dy:-dx}:{dx,dy};}
