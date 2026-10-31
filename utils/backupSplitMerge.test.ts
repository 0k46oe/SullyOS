import { beforeEach, expect, it } from 'vitest';
import { DB, openDB } from './db';
import { mergeMediaOnly, mergeTextMedia, stripSplitMetadata } from './backupSplitMerge';
const picture = 'data:image/png;base64,AA==';
async function clear() {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['characters','messages','assets','user_profile','daily_schedule','bank_data'], 'readwrite');
        for (const name of ['characters','messages','assets','user_profile','daily_schedule','bank_data']) tx.objectStore(name).clear();
        tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    });
}
beforeEach(clear);
const text = () => ({ collaborationBackupMode: 'text_only', characters: [{id:'one',name:'新名字',systemPrompt:'新人物设定',avatar:'',chatBackground:''}], messages: [{id:1,charId:'one',role:'user',type:'text',content:'新正文',timestamp:100,metadata:{cameraSnapshotRef:''}},{id:2,charId:'one',role:'assistant',type:'image',content:'',timestamp:200}], bankState:{balance:300,image:''},userProfile:{name:'新用户',bio:'新用户设定',avatar:''} } as any);
const media = () => ({ collaborationBackupMode:'media_only', mediaAssets:[{charId:'one',avatar:picture,backgrounds:{chat:picture}}],messages:[{id:1,charId:'one',role:'user',type:'text',content:'旧正文',timestamp:1,metadata:{cameraSnapshotRef:'blobref:camera'}},{id:2,charId:'one',role:'assistant',type:'image',content:picture,timestamp:2}],bankState:{balance:100,image:picture},userProfile:{name:'旧用户',bio:'旧设定',avatar:picture},dailySchedules:[{id:'day',text:'过期日程'}] } as any);
for(const order of ['text-first','media-first']) it(`${order}: cold restore preserves text, character images, camera references and user avatar`,async()=>{
    for (const data of order==='text-first'?[text(),media()]:[media(),text()]) await DB.importFullData(data);
    const [character]=await DB.getRawStoreData('characters');
    expect(character).toMatchObject({name:'新名字',systemPrompt:'新人物设定',avatar:picture,chatBackground:picture});
    const rows=await DB.getRawStoreData('messages');
    expect(rows.find(r=>r.id===1)).toMatchObject({content:'新正文',timestamp:100,metadata:{cameraSnapshotRef:'blobref:camera'}});
    expect(rows.find(r=>r.id===2).content).toBe(picture);
    expect((await DB.getRawStoreData('bank_data')).find(r=>r.id==='main_state')).toMatchObject({balance:300,image:picture});
    expect(await DB.getUserProfile()).toMatchObject({name:'新用户',bio:'新用户设定',avatar:picture});
    expect(await DB.getRawStoreData('daily_schedule')).toEqual([]);
});
it('media patch keeps newer text and metadata, stable ID matching survives reordered arrays',()=>{
    const old={name:'新文本',rows:[{id:'a',label:'新A',image:picture},{id:'b',label:'新B',image:''}]};
    const patch={name:'旧文本',rows:[{id:'b',label:'旧B',image:'blobref:b'},{id:'a',label:'旧A',image:'blobref:a'}]};
    expect(mergeMediaOnly(old,patch)).toEqual({name:'新文本',rows:[{id:'a',label:'新A',image:'blobref:a'},{id:'b',label:'新B',image:'blobref:b'}]});
    expect(mergeTextMedia(old,{rows:[{id:'a',label:'更新A',image:''}]})).toEqual({rows:[{id:'a',label:'更新A',image:picture}]});
});
it('old text metadata cannot clear themes, icons, presets or desktop images',()=>{
    const data:any={collaborationBackupMode:'text_only',theme:{wallpaper:''},customIcons:{chat:''},appearancePresets:[],roomCustomAssets:[],characters:[]};
    stripSplitMetadata(data);expect(data).toEqual({collaborationBackupMode:'text_only',characters:[]});
});
it('text restores a complete message snapshot while borrowing old picture bytes',async()=>{
    await DB.importFullData({characters:[{id:'one',name:'旧'}],messages:[{id:2,charId:'one',role:'assistant',type:'image',content:picture},{id:999,charId:'one',role:'user',type:'text',content:'应被替换'}]} as any);
    await DB.importFullData(text());
    expect((await DB.getRawStoreData('messages')).map(m=>m.id)).toEqual([1,2]);
    expect((await DB.getRawStoreData('messages')).find(m=>m.id===2).content).toBe(picture);
});

it('restored camera pixels override the expired text placeholder',()=>{
    const text={cameraSnapshotExpired:true};
    const media={cameraSnapshotRef:'blobref:camera'};
    expect(mergeMediaOnly(text,media)).toEqual({...media,cameraSnapshotExpired:false});
    expect(mergeTextMedia(media,text)).toEqual({...media,cameraSnapshotExpired:false});
});
it('a full restore invalidates pending media from an earlier split restore',async()=>{
    await DB.importFullData(media());
    await DB.importFullData({characters:[{id:'one',name:'full',avatar:'data:image/png;base64,BB=='}]} as any);
    expect(await DB.getAssetRaw('sully_split_character_media_v1')).toBeNull();
    await DB.importFullData(text());
    expect((await DB.getRawStoreData('characters'))[0].avatar).toBe('data:image/png;base64,BB==');
});

it('split import uses each actual store key path, including emoji names and theater preset keys',async()=>{
    await DB.importFullData({collaborationBackupMode:'media_only',savedEmojis:[{name:'打招呼',url:picture}],savedJournalStickers:[{name:'贴纸',url:picture}]} as any);
    expect((await DB.getRawStoreData('emojis')).find(r=>r.name==='打招呼')?.url).toBe(picture);
    await DB.importFullData({collaborationBackupMode:'text_only',vrPresets:[{key:'preset',content:'新预设正文'}]} as any);
    expect((await DB.getRawStoreData('vr_presets')).find(r=>r.key==='preset')?.content).toBe('新预设正文');
});

it('media matching preserves API base URLs while accepting image URLs',()=>{
    expect(mergeMediaOnly({baseUrl:'https://current.test',avatar:''},{baseUrl:'https://old.test',avatar:'https://image.test/a.png'})).toEqual({baseUrl:'https://current.test',avatar:'https://image.test/a.png'});
});
