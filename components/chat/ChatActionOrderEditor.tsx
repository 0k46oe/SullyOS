import React, { useEffect, useRef, useState } from 'react';
import { moveChatAction, normalizeChatActionOrder } from '../../utils/chatActionOrder';
import ChatToolDialog from './ChatToolDialog';

export interface ChatActionOrderItem { id: string; label: string; content: React.ReactNode }

export default function ChatActionOrderEditor({ items, initialOrder, onSave, onClose }: {
    items: ChatActionOrderItem[]; initialOrder: string[]; onSave: (order: string[]) => void; onClose: () => void;
}) {
    const defaults = items.map(item => item.id);
    const [order, setOrder] = useState(() => normalizeChatActionOrder(initialOrder, defaults));
    const [dragging, setDragging] = useState<string | null>(null);
    const [notice, setNotice] = useState('');
    const drag = useRef<{ id: string; pointer: number } | null>(null);
    const point = useRef<{ x: number; y: number } | null>(null);
    const scrollFrame = useRef<number | null>(null);
    const scroller = useRef<HTMLDivElement>(null);
    const byId = new Map(items.map(item => [item.id, item]));
    const stopDrag = () => {
        drag.current = null; point.current = null; setDragging(null);
        if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
        scrollFrame.current = null;
    };
    useEffect(() => () => { if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current); }, []);
    const moveAtPoint = () => {
        const active = drag.current, position = point.current;
        if (!active || !position) return;
        const target = document.elementFromPoint(position.x, position.y)?.closest<HTMLElement>('[data-tool-id]');
        if (target && scroller.current?.contains(target) && target.dataset.toolId !== active.id) {
            setOrder(current => moveChatAction(current, active.id, target.dataset.toolId!));
        }
    };
    const autoScroll = () => {
        const element = scroller.current, position = point.current;
        if (!drag.current || !element || !position) return;
        const bounds = element.getBoundingClientRect();
        if (position.y < bounds.top + 40 || position.y > bounds.bottom - 40) {
            element.scrollTop += position.y < bounds.top + 40 ? -8 : 8;
            moveAtPoint();
        }
        scrollFrame.current = requestAnimationFrame(autoScroll);
    };

    return <ChatToolDialog title="整理工具" onClose={onClose} footer={<>
        <button type="button" onClick={() => { setOrder(defaults); setNotice('已恢复默认排列，点完成后保存'); }} className="flex-1 rounded-xl bg-slate-100 py-3 text-sm font-bold text-slate-600">恢复默认</button>
        <button type="button" onClick={() => onSave(order)} className="flex-1 rounded-xl bg-primary py-3 text-sm font-bold text-white">完成</button>
    </>}>
        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
            <p className="mb-4 text-xs leading-relaxed text-slate-500">拖动每项右上角的手柄调整顺序，每 8 项为一页。所有私聊共用本机排列，点返回放弃修改。</p>
            <div className="grid grid-cols-4 gap-x-2 gap-y-4" role="list" aria-label="工具排列">
                {order.map((id, index) => {
                    const item = byId.get(id)!;
                    return <div key={id} data-tool-id={id} role="listitem" className={`relative min-w-0 rounded-xl py-3 ${dragging === id ? 'bg-indigo-50 ring-2 ring-indigo-300' : 'bg-slate-50'}`}>
                        <div className="pointer-events-none flex flex-col items-center gap-2 text-slate-600" aria-hidden="true">{item.content}</div>
                        <span className="mt-2 block text-center text-[10px] text-slate-400">{index + 1} · 第 {Math.floor(index / 8) + 1} 页</span>
                        <button type="button" aria-label={`移动${item.label}`} aria-pressed={dragging === id}
                            title="拖动排序，也可用方向键移动" className="absolute -right-1 -top-1 flex h-8 w-8 cursor-grab items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 shadow-sm active:cursor-grabbing"
                            style={{ touchAction: 'none' }}
                            onPointerDown={event => {
                                if (event.button !== 0) return;
                                drag.current = { id, pointer: event.pointerId }; setDragging(id);
                                point.current = { x: event.clientX, y: event.clientY };
                                event.currentTarget.setPointerCapture(event.pointerId);
                                scrollFrame.current = requestAnimationFrame(autoScroll);
                            }}
                            onPointerMove={event => {
                                if (drag.current?.pointer !== event.pointerId) return;
                                point.current = { x: event.clientX, y: event.clientY };
                                moveAtPoint();
                            }}
                            onPointerUp={() => { stopDrag(); setNotice('排列已调整，点完成后保存'); }}
                            onPointerCancel={stopDrag}
                            onLostPointerCapture={stopDrag}
                            onKeyDown={event => {
                                const offset = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -4, ArrowDown: 4 } as Record<string, number>)[event.key];
                                if (!offset) return;
                                event.preventDefault();
                                const target = order[index + offset];
                                if (target) { setOrder(current => moveChatAction(current, id, target)); setNotice(`${item.label}已移到第 ${index + offset + 1} 项`); }
                            }}>⠿</button>
                    </div>;
                })}
            </div>
            <p role="status" className="mt-4 text-xs text-slate-500">{notice}</p>
        </div>
    </ChatToolDialog>;
}
