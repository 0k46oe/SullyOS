import {expect,it} from 'vitest';
import {makeWorkshopPreset,projectWorkshopPreset,replaceWorkshopCss,checkWorkshopCss} from './decorationWorkshop';
import {decorationPatches} from './chatDecoration';
import {decorationCategories} from './beautyCategories';

it('category makers export only their own content and never clear unrelated CSS',async()=>{
 const preset=makeWorkshopPreset('background');preset.parts.css='.sully-chat-header{color:red}';
 const isolated=projectWorkshopPreset(preset,'background');
 expect(isolated.parts.css).toBeUndefined();expect(decorationCategories(isolated)).toEqual(['chat','background']);
 const patch=await decorationPatches(isolated,['background'],'character',{id:'a',chromeCustomCss:'keep'} as any,{} as any);
 expect(patch.character.chromeCustomCss).toBeUndefined();
});
it('applying an avatar frame preserves the existing whitebox and background CSS',async()=>{
 const old=replaceWorkshopCss('.sully-chat-header{color:red}','background','.sully-chat-root{background:pink}');
 const preset=makeWorkshopPreset('avatar');preset.parts.css=replaceWorkshopCss('','avatar','.sully-chat-avatar-wrap::after{border:1px solid red}');
 expect(decorationCategories(preset)).toEqual(['chat','avatar']);
 const patch=await decorationPatches(preset,['css'],'character',{id:'a',chromeCustomCss:old} as any,{} as any);
 expect(patch.character.chromeCustomCss).toContain('.sully-chat-header');expect(patch.character.chromeCustomCss).toContain('background:pink');expect(patch.character.chromeCustomCss).toContain('avatar-wrap::after');
 expect(patch.character.chatDecorationCssIsolated).toBeUndefined();
 expect(()=>checkWorkshopCss('psyche','.sully-chat-header{color:red}')).toThrow();
 expect(()=>checkWorkshopCss('psyche','.sully-psyche-card{color:red}')).not.toThrow();
});
