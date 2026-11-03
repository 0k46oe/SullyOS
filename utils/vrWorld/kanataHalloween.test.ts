import { describe, expect, it } from 'vitest';
import { assignHalloweenCostume, continueHalloweenCatchUp, endHalloweenCatchUp, finishHalloweenDialogue, giveHalloweenCandy, halloweenActive, HALLOWEEN_COSTUMES, shouldOfferHalloweenCatchUpEnd, startHalloweenCatchUp, validateHalloween } from './kanataHalloween';
import { isKanataHalloween } from './halloweenCalendar';
import { addCatchToState, buyListing, createFishingMarketState, createListing, ensureActorAccounts, marketCatchSnapshot, mutateFishingMarket, readFishingMarketState, rollFishingCatch, saveFishingMarketState } from './fishingMarket';
import { collectSARLocalBackup, restoreSARLocalBackup } from './sarBackup';
import { sarCollectionEntries } from './sarCollection';
import { ensureDinosaurGarden } from './dinosaurGarden';
import { halloweenScenes } from '../../apps/vrWorld/KanataHalloween';

const at = new Date(2026, 9, 29, 12).getTime();
const init = () => createFishingMarketState(42);
const storage = () => { const map = new Map<string,string>(); return { getItem: (k:string) => map.get(k) ?? null, setItem: (k:string,v:string) => {map.set(k,v);}, removeItem: (k:string) => {map.delete(k);} }; };
describe('Kanata Halloween', () => {
    it('opens only on the three local calendar dates', () => {
        expect(['2026-10-28','2026-10-29','2026-10-30','2026-10-31','2026-11-01','2027-10-31'].map(isKanataHalloween)).toEqual([false,true,true,true,false,false]);
    });
    it('keeps a costume on reentry, changes to a different one, and respects taking it off', () => {
        let s = assignHalloweenCostume(init(),'char','initial',at,()=>0);
        expect(assignHalloweenCostume(s,'char','initial',at,()=>.9)).toBe(s);
        const before = s.kanataHalloween!.costumes.char;
        s = assignHalloweenCostume(s,'char','change',at,()=>0);
        expect(s.kanataHalloween!.costumes.char).not.toBe(before);
        s = assignHalloweenCostume(s,'char','remove',at);
        expect(assignHalloweenCostume(s,'char','initial',at)).toBe(s);
        expect(s.kanataHalloween!.collectedCostumes).toHaveLength(2);
        for(let i=0;i<HALLOWEEN_COSTUMES.length;i++) expect(assignHalloweenCostume(init(),String(i),'initial',at,()=>i/5).kanataHalloween!.costumes[String(i)]).toBe(HALLOWEEN_COSTUMES[i].id);
    });
    it('withdraws the whole event without deleting gifts or the original figures', () => {
        let s = giveHalloweenCandy(assignHalloweenCostume(init(),'char','initial',at),at,()=>0).state;
        s = finishHalloweenDialogue(s,'caian','小雨',true,at);
        expect(s.kanataHalloween).toMatchObject({disabled:true,costumes:{},candies:{'pumpkin-caramel':1}});
        expect(assignHalloweenCostume(s,'other','initial',at)).toBe(s);
        expect(finishHalloweenDialogue(s,'aiven','小雨',false,at)).toBe(s);
        expect(()=>giveHalloweenCandy(s,at)).toThrow();
    });
    it('grants each NPC reward once, with a usable dinosaur and collection history', () => {
        let s = finishHalloweenDialogue(init(),'caian','小雨',false,at,()=>0);
        expect(finishHalloweenDialogue(s,'caian','小雨',false,at)).toBe(s);
        s = finishHalloweenDialogue(s,'aiven','小雨',false,at);
        expect(finishHalloweenDialogue(s,'aiven','小雨',false,at)).toBe(s);
        expect(s.inventory).toHaveLength(1);
        expect(s.inventory[0]).toMatchObject({speciesId:'halloween-dinosaur',ownerId:'user',origin:{kind:'gift',actorName:'艾文'}});
        const toyState = ensureDinosaurGarden(s, {id:'user',name:'小雨',kind:'user'}, at);
        expect(toyState.dinosaurGarden!.toys[s.inventory[0].id].speciesId).toBe('halloween-dinosaur');
        expect(sarCollectionEntries(s,'user').filter(e=>e.category==='halloween'&&e.collected)).toHaveLength(3);
        expect(sarCollectionEntries(s,'user',false).some(e=>e.id==='halloween-dinosaur'||e.id.startsWith('halloween-memory'))).toBe(false);
    });
    it('keeps candy, costume choices, opt-out and rewards through full backup restoration', () => {
        const src=storage(),dst=storage();
        const s=finishHalloweenDialogue(finishHalloweenDialogue(assignHalloweenCostume(init(),'char','initial',at),'aiven','小雨',false,at),'caian','小雨',true,at);
        saveFishingMarketState(s,src);
        restoreSARLocalBackup(collectSARLocalBackup(src),{replaceMissing:true},dst);
        expect(readFishingMarketState(dst).kanataHalloween).toEqual(s.kanataHalloween);
        expect(readFishingMarketState(dst).inventory).toEqual(s.inventory);
    });
    it('writes fish hats at acquisition and preserves them through trading and snapshots', () => {
        const a={id:'user',name:'我',kind:'user' as const},b={id:'char',name:'角色',kind:'character' as const};
        const w={kind:'clear' as const,label:'晴',detail:'',source:'simulated' as const};
        for(const day of [28,29,30,31,32])expect(rollFishingCatch(a,w,()=>0,new Date(2026,9,day,12).getTime()).halloweenHat).toBe(day>=29&&day<=31);
        const fish=rollFishingCatch(a,w,()=>0,at);
        let s=createListing(addCatchToState(ensureActorAccounts(init(),[a,b]),fish),a,fish,1,'',at);
        expect(marketCatchSnapshot(s,fish).halloweenHat).toBe(true);
        s=buyListing(s,s.listings[0].id,b,at);
        expect(s.inventory[0]).toMatchObject({ownerId:'char',halloweenHat:true});
    });
    it('serializes concurrent rewards and preserves the latest state', async () => {
        const st=storage();saveFishingMarketState(init(),st);
        await Promise.all([1,2,3].map(()=>mutateFishingMarket(s=>finishHalloweenDialogue(s,'aiven','我',false,at),st)));
        expect(readFishingMarketState(st).inventory).toHaveLength(1);
    });
    it('preserves every supplied choice and personalized withdrawal line', () => {
        const c=halloweenScenes('caian','小雨'),a=halloweenScenes('aiven','小雨');
        expect(c.start.choices!.map(c=>c.text)).toEqual(['我不喜欢','好耶！','不给糖就捣蛋！']);
        expect(c.withdraw.lines[0]).toContain('既然小雨不喜欢');
        expect(c.dislike.choices!.map(c=>c.next)).toEqual(['withdraw','end']);
        expect(a.portrait.lines).toEqual(['……………………','据说真正的管理员没有档期','不能再说了']);
    });
    it('requires an explicit catch-up opt-in after the event and keeps original calendar rules', () => {
        const later = new Date(2026, 10, 3, 12).getTime();
        expect(halloweenActive(init(), later)).toBe(false);
        const s = startHalloweenCatchUp(init());
        expect(halloweenActive(s, later)).toBe(true);
        expect(startHalloweenCatchUp(s)).toBe(s);
        const dressed = assignHalloweenCostume(s, 'char', 'initial', later, () => 0);
        expect(dressed.kanataHalloween?.costumes.char).toBe('black-cat');
        expect(giveHalloweenCandy(dressed, later, () => 0).state.kanataHalloween?.candies['pumpkin-caramel']).toBe(1);
        expect(isKanataHalloween('2026-11-03')).toBe(false);
    });
    it('offers an ending after both stories, remembers continuing to collect, and backs it up', () => {
        const later = new Date(2026, 10, 3, 12).getTime();
        let s = finishHalloweenDialogue(startHalloweenCatchUp(init()), 'aiven', '我', false, later);
        expect(shouldOfferHalloweenCatchUpEnd(s.kanataHalloween)).toBe(false);
        s = finishHalloweenDialogue(s, 'caian', '我', false, later);
        expect(shouldOfferHalloweenCatchUpEnd(s.kanataHalloween)).toBe(true);
        s = continueHalloweenCatchUp(s);
        expect(halloweenActive(s, later)).toBe(true);
        expect(shouldOfferHalloweenCatchUpEnd(s.kanataHalloween)).toBe(false);
        const src = storage(), dst = storage();
        saveFishingMarketState(s, src);
        restoreSARLocalBackup(collectSARLocalBackup(src), { replaceMissing: true }, dst);
        expect(readFishingMarketState(dst).kanataHalloween).toEqual(s.kanataHalloween);
        expect(halloweenActive(readFishingMarketState(dst), later)).toBe(true);
    });
    it('ends at any point, removes costumes, retains all rewards and never grants duplicate gifts on reopening', () => {
        const later = new Date(2026, 10, 3, 12).getTime();
        let s = assignHalloweenCostume(startHalloweenCatchUp(init()), 'char', 'initial', later);
        s = finishHalloweenDialogue(s, 'caian', '我', false, later, () => 0);
        s = finishHalloweenDialogue(s, 'aiven', '我', false, later);
        const before = s;
        s = endHalloweenCatchUp(s);
        expect(s.kanataHalloween).toMatchObject({ catchUp: 'ended', disabled: true, costumes: {}, candies: before.kanataHalloween!.candies, completed: ['caian', 'aiven'], collectedCostumes: before.kanataHalloween!.collectedCostumes });
        expect(s.inventory).toEqual(before.inventory);
        expect(halloweenActive(s, later)).toBe(false);
        expect(assignHalloweenCostume(s, 'other', 'initial', later)).toBe(s);
        expect(() => giveHalloweenCandy(s, later)).toThrow();
        const resumed = startHalloweenCatchUp(s);
        expect(finishHalloweenDialogue(resumed, 'caian', '我', false, later)).toBe(resumed);
        expect(finishHalloweenDialogue(resumed, 'aiven', '我', false, later)).toBe(resumed);
        expect(resumed.inventory).toHaveLength(1);
        expect(resumed.kanataHalloween!.candies['pumpkin-caramel']).toBe(1);
    });
    it('preserves the authored withdrawal branch during catch-up and permits deliberate reopening', () => {
        const later = new Date(2026, 10, 3, 12).getTime();
        const withdrawn = finishHalloweenDialogue(startHalloweenCatchUp(init()), 'caian', '我', true, later);
        expect(withdrawn.kanataHalloween).toMatchObject({ catchUp: 'ended', disabled: true, costumes: {} });
        expect(halloweenActive(withdrawn, later)).toBe(false);
        const resumed = startHalloweenCatchUp(withdrawn);
        expect(halloweenActive(resumed, later)).toBe(true);
        expect(finishHalloweenDialogue(resumed, 'aiven', '我', false, later).inventory).toHaveLength(1);
    });
    it('accepts legacy saves and rejects malformed catch-up flags without overwriting them', () => {
        const legacy = assignHalloweenCostume(init(), 'char', 'initial', at);
        expect(() => validateHalloween(legacy.kanataHalloween!)).not.toThrow();
        expect(shouldOfferHalloweenCatchUpEnd(legacy.kanataHalloween)).toBe(false);
        const st = storage();
        const raw = JSON.stringify({ ...legacy, kanataHalloween: { ...legacy.kanataHalloween, catchUp: 'unknown' } });
        st.setItem('vr_fishing_market_v1', raw);
        expect(() => readFishingMarketState(st)).toThrow('万圣节收藏无法读取');
        expect(st.getItem('vr_fishing_market_v1')).toBe(raw);
    });
    it('serializes catch-up rewards together with ending and reopening', async () => {
        const later = new Date(2026, 10, 3, 12).getTime(), st = storage();
        saveFishingMarketState(startHalloweenCatchUp(init()), st);
        await Promise.all([
            mutateFishingMarket(s => finishHalloweenDialogue(s, 'aiven', '我', false, later), st),
            mutateFishingMarket(endHalloweenCatchUp, st),
            mutateFishingMarket(startHalloweenCatchUp, st),
            mutateFishingMarket(s => finishHalloweenDialogue(s, 'aiven', '我', false, later), st),
        ]);
        expect(readFishingMarketState(st).inventory).toHaveLength(1);
        expect(readFishingMarketState(st).kanataHalloween?.completed).toEqual(['aiven']);
    });
});
