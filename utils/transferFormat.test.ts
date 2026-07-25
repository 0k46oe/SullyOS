import { describe, it, expect } from 'vitest';
import { parseTransferAmount, formatTransferAmount, extractTransferCommands } from './transferFormat';

describe('parseTransferAmount', () => {
    it('纯数字', () => {
        expect(parseTransferAmount('1999')).toBe(1999);
        expect(parseTransferAmount('520')).toBe(520);
    });

    it('带单位 / 币种符号', () => {
        expect(parseTransferAmount('520元')).toBe(520);
        expect(parseTransferAmount('520块')).toBe(520);
        expect(parseTransferAmount('520块钱')).toBe(520);
        expect(parseTransferAmount('¥520')).toBe(520);
        expect(parseTransferAmount('￥520元')).toBe(520);
        expect(parseTransferAmount('520 RMB')).toBe(520);
    });

    it('千分位 / 小数 / 全角 / 多余空白', () => {
        expect(parseTransferAmount('1,999')).toBe(1999);
        expect(parseTransferAmount('1，999')).toBe(1999);
        expect(parseTransferAmount('520.00')).toBe(520);
        expect(parseTransferAmount('520.5')).toBe(520.5);
        expect(parseTransferAmount('５２０')).toBe(520);
        expect(parseTransferAmount('  520  ')).toBe(520);
    });

    it('非法值一律 null（0 / 负数 / 非数字 / 空）', () => {
        expect(parseTransferAmount('0')).toBeNull();
        expect(parseTransferAmount('-520')).toBeNull();
        expect(parseTransferAmount('很多')).toBeNull();
        expect(parseTransferAmount('')).toBeNull();
        expect(parseTransferAmount(undefined)).toBeNull();
        expect(parseTransferAmount(NaN)).toBeNull();
        expect(parseTransferAmount(Infinity)).toBeNull();
    });

    it('上限不设 —— 人设引导出的天价由用户自己负责', () => {
        expect(parseTransferAmount('999999999')).toBe(999999999);
    });
});

describe('formatTransferAmount', () => {
    it('整数去小数点，非整数保留两位', () => {
        expect(formatTransferAmount(520)).toBe('520');
        expect(formatTransferAmount(520.5)).toBe('520.5');
        expect(formatTransferAmount(520.456)).toBe('520.46');
    });
});

describe('extractTransferCommands — 规范标签', () => {
    it('基础形态', () => {
        const r = extractTransferCommands('给你[[ACTION:TRANSFER:1999]]拿去买喝的');
        expect(r.events).toEqual([{ kind: 'send', amount: '1999' }]);
        expect(r.text).toBe('给你拿去买喝的');
    });

    it('冒号后多空格 / 带单位 / 千分位（老正则会漏，漏了就静默消失）', () => {
        expect(extractTransferCommands('[[ACTION:TRANSFER: 520]]').events)
            .toEqual([{ kind: 'send', amount: '520' }]);
        expect(extractTransferCommands('[[ACTION:TRANSFER:520元]]').events)
            .toEqual([{ kind: 'send', amount: '520' }]);
        expect(extractTransferCommands('[[ACTION:TRANSFER:1,999]]').events)
            .toEqual([{ kind: 'send', amount: '1999' }]);
        expect(extractTransferCommands('[[ACTION:TRANSFER:520.00]]').events)
            .toEqual([{ kind: 'send', amount: '520' }]);
    });

    it('一条回复里多笔全部保留，不设数量上限（老实现只认第一个，第二笔静默丢失）', () => {
        const r = extractTransferCommands('[[ACTION:TRANSFER:520]]吃饭\n[[ACTION:TRANSFER:1314]]打车');
        expect(r.events).toEqual([
            { kind: 'send', amount: '520' },
            { kind: 'send', amount: '1314' },
        ]);
        expect(r.text).toBe('吃饭\n打车');
    });

    it('金额非法 → 剥掉保正文，不产生事件', () => {
        const r = extractTransferCommands('[[ACTION:TRANSFER:很多]]随便花');
        expect(r.events).toEqual([]);
        expect(r.text).toBe('随便花');
        expect(r.consumed).toBe(1);
    });

    it('ACCEPT / RETURN 不会被 TRANSFER 正则误吃', () => {
        expect(extractTransferCommands('[[ACTION:TRANSFER_ACCEPT]]谢谢你').events)
            .toEqual([{ kind: 'accept' }]);
        expect(extractTransferCommands('[[ACTION:TRANSFER_RETURN]]我不能要').events)
            .toEqual([{ kind: 'return' }]);
    });

    it('按出现顺序返回，保住角色的语序意图', () => {
        const r = extractTransferCommands('[[ACTION:TRANSFER_ACCEPT]]收下了\n[[ACTION:TRANSFER:520]]这个还你');
        expect(r.events).toEqual([{ kind: 'accept' }, { kind: 'send', amount: '520' }]);
    });
});

describe('extractTransferCommands — 模仿历史日志的口语形态', () => {
    it('用户实际反馈的那一条：整块还原成真转账', () => {
        const r = extractTransferCommands('[系统: 你向阿桃转账 1999]拿去花');
        expect(r.events).toEqual([{ kind: 'send', amount: '1999' }]);
        expect(r.text).toBe('拿去花');
    });

    it('措辞变体', () => {
        const cases = [
            '[系统: 你向阿桃转账1999]',
            '[系统：你向阿桃转账 1999]',
            '[系统: 你给阿桃转账 1999]',
            '[系统: 你给阿桃转了1999]',
            '[系统: 你向阿桃转账了 ￥1,999元]',
            '[System: 你向阿桃转账 1999]',
        ];
        for (const c of cases) {
            expect(extractTransferCommands(c).events, c).toEqual([{ kind: 'send', amount: '1999' }]);
        }
    });

    it('群摘要形态 [转账1999]', () => {
        expect(extractTransferCommands('[转账1999]').events).toEqual([{ kind: 'send', amount: '1999' }]);
        expect(extractTransferCommands('[转账 520]').events).toEqual([{ kind: 'send', amount: '520' }]);
    });

    it('回执形态 → accept / return', () => {
        expect(extractTransferCommands('[系统: 你接收了阿桃的转账 520]').events)
            .toEqual([{ kind: 'accept' }]);
        expect(extractTransferCommands('[系统: 你退回了阿桃的转账 520]').events)
            .toEqual([{ kind: 'return' }]);
    });
});

describe('extractTransferCommands — 方向校验（伪造必须拦下，不能渲染）', () => {
    it('用户→角色的转账日志：剥掉，不产生事件', () => {
        const r = extractTransferCommands('[系统: 阿桃向你转账 1999]我收下啦');
        expect(r.events).toEqual([]);
        expect(r.text).toBe('我收下啦');
        expect(r.consumed).toBe(1);
    });

    it('角色替用户签收 / 退回：同样剥掉', () => {
        expect(extractTransferCommands('[系统: 阿桃接收了你的转账 1999]').events).toEqual([]);
        expect(extractTransferCommands('[系统: 阿桃退回了你的转账 1999]').events).toEqual([]);
    });

    it('待处理提示的完整历史行（带尾巴）也算伪造', () => {
        const r = extractTransferCommands('[系统: 阿桃向你转账 1999（待你处理，可收下或退回）]');
        expect(r.events).toEqual([]);
        expect(r.consumed).toBe(1);
    });
});

describe('extractTransferCommands — 不越界', () => {
    it('自由散文不认：叙述不是指令', () => {
        const r = extractTransferCommands('我刚给你转了1999，记得查收');
        expect(r.events).toEqual([]);
        expect(r.consumed).toBe(0);
        expect(r.text).toBe('我刚给你转了1999，记得查收');
    });

    it('非转账的系统日志不消费（留给 sanitize 终线）', () => {
        const r = extractTransferCommands('[系统: 用户戳了你一下]我在呢');
        expect(r.events).toEqual([]);
        expect(r.consumed).toBe(0);
        expect(r.text).toBe('[系统: 用户戳了你一下]我在呢');
    });

    it('空输入 / 无标签', () => {
        expect(extractTransferCommands('')).toEqual({ text: '', events: [], consumed: 0 });
        expect(extractTransferCommands('今天天气不错')).toEqual({
            text: '今天天气不错', events: [], consumed: 0,
        });
    });

    it('正文原样保留，只挖走标签', () => {
        const r = extractTransferCommands('前面[[ACTION:TRANSFER:520]]中间[系统: 你向阿桃转账 1]后面');
        expect(r.events).toEqual([
            { kind: 'send', amount: '520' },
            { kind: 'send', amount: '1' },
        ]);
        expect(r.text).toBe('前面中间后面');
    });
});
