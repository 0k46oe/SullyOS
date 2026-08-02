import { describe, it, expect } from 'vitest';
import { formatTaskTime, fromDatetimeLocalValue, toDatetimeLocalValue } from './amsg2Tasks';
import { buildAmsg2TaskContextText } from './amsg2TaskContext';
import { formatFireTimeShort } from './amsgFirePack';
import { resolveSendAtMs } from './amsgFireSchedule';
import type { ActiveMsg2TaskRecord } from '../types';

// 回归守卫：同一条任务，角色在聊天里看到的时间和到点生成时看到的时间必须是同一个钟。
//
// 以前不是：聊天侧（排程现状块 / schedule、list 工具的回话）用 toLocaleString 不带
// timeZone，吃的是**设备**时区；fire 侧一律按 fire_pack.tzId 也就是**角色**时区渲染。
// 设备在中国、角色在纽约时，同一条任务两边差整整 12 小时——角色刚说「我 21:00 找你」，
// 下一轮的排程清单里那条写着 09:00。

const CHAR_TZ = 'America/New_York';
const DEVICE_TZ = 'Asia/Shanghai';
const AT = Date.UTC(2026, 7, 2, 13, 0);   // 上海 21:00 / 纽约 09:00

const task = (over: Partial<ActiveMsg2TaskRecord> = {}): ActiveMsg2TaskRecord => ({
    taskUuid: 'aabbccdd-0000-0000-0000-000000000000',
    clientTaskId: 'c1',
    mode: 'auto',
    firstSendTime: new Date(AT).toISOString(),
    recurrenceType: 'none',
    expirePolicy: 'expire',
    ...over,
} as ActiveMsg2TaskRecord);

describe('给角色看的时间跟 fire 侧同一个钟', () => {
    it('排程现状块按角色时区写，不吃设备时区', () => {
        const text = buildAmsg2TaskContextText([task()], [], AT - 60_000, CHAR_TZ)!;
        // 纽约角色看到的是自己的 09:00
        expect(text).toContain('09:00');
        expect(text).not.toContain('21:00');
    });

    it('跟 worker 到点渲染的那份对得上', () => {
        const chatSide = formatTaskTime(AT, CHAR_TZ);
        const fireSide = formatFireTimeShort(AT, { tzId: CHAR_TZ });
        // 格式不同（一个带年、一个短格式），但小时分钟必须是同一个
        expect(chatSide).toContain('09:00');
        expect(fireSide).toContain('09:00');
    });

    it('不传时区仍跟着设备走——设置面板上的任务卡是给用户自己看的', () => {
        // 这条钉的是「面板别被顺手改成角色时区」：用户看的是自己桌上的钟。
        const forUser = formatTaskTime(AT);
        const forChar = formatTaskTime(AT, CHAR_TZ);
        expect(forUser).not.toBe(forChar);
    });
});

describe('角色写的 send_at 按它自己的钟解析', () => {
    it('裸墙钟按角色时区还原，跟 worker 同一份规则', () => {
        // 纽约角色说「明早九点」写成 2026-08-03T09:00:00。
        const raw = '2026-08-03T09:00:00';
        expect(resolveSendAtMs(raw, { tzId: CHAR_TZ })).toBe(Date.UTC(2026, 7, 3, 13, 0));
        // 按设备（上海）解释的话会算成 UTC 01:00 —— 差整整 12 小时。
        expect(resolveSendAtMs(raw, { tzId: DEVICE_TZ })).toBe(Date.UTC(2026, 7, 3, 1, 0));
    });

    it('带显式偏移的照标注解析（模型硬要写也不算错）', () => {
        expect(resolveSendAtMs('2026-08-03T09:00:00+08:00', { tzId: CHAR_TZ }))
            .toBe(Date.UTC(2026, 7, 3, 1, 0));
    });
});

// 上面那条规则只对「角色自己排程」成立。设置面板的时间框是给用户填的，填的是用户桌上
// 的钟——同一个裸墙钟交给排程接口，就会被当成角色那边的墙钟。角色在纽约、用户在中国时，
// 用户填 15:26 会排到次日 03:26：面板一开始还按设备钟倒计时，等远端对完账才跳成 03:26，
// 用户看到的是「填的时间过点了不响，列表里时间还自己变了」。
// 面板因此在交出去之前先折成绝对时刻，让后面所有环节只认这一刻。
describe('面板填的时间按用户的钟落地', () => {
    const PANEL_VALUE = '2026-08-03T09:00';   // 用户在 datetime-local 里填的

    it('折成绝对时刻后，按谁的时区解析都是同一刻', () => {
        const handed = fromDatetimeLocalValue(PANEL_VALUE);
        expect(resolveSendAtMs(handed, { tzId: CHAR_TZ }))
            .toBe(resolveSendAtMs(handed, { tzId: DEVICE_TZ }));
        // 而且就是用户填的那一刻（按设备时区还原）
        expect(resolveSendAtMs(handed, { tzId: CHAR_TZ })).toBe(new Date(PANEL_VALUE).getTime());
    });

    it('裸墙钟直接交出去会被角色时区挪走——这是修掉的那条路', () => {
        expect(resolveSendAtMs(PANEL_VALUE, { tzId: CHAR_TZ }))
            .not.toBe(resolveSendAtMs(PANEL_VALUE, { tzId: DEVICE_TZ }));
    });

    it('折过去再折回来，编辑时时间框里还是用户填的那个值', () => {
        expect(toDatetimeLocalValue(fromDatetimeLocalValue(PANEL_VALUE))).toBe(PANEL_VALUE);
    });

    it('空值 / 坏值原样返回，由下游报错', () => {
        expect(fromDatetimeLocalValue('')).toBe('');
        expect(fromDatetimeLocalValue('不是时间')).toBe('不是时间');
    });
});
