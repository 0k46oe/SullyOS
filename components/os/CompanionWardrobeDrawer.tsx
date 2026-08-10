import React from 'react';
import { Check, Crop, Gear, Play, TShirt, X } from '@phosphor-icons/react';
import type { Live2DAction } from '../../utils/live2dModelStore';
import type { CompanionFrameStyleId } from './companionFrameStyles';
import './CompanionWardrobeDrawer.css';

type CompanionWardrobeDrawerProps = {
  open: boolean;
  styleId: CompanionFrameStyleId;
  characterName: string;
  wardrobeActions: Live2DAction[];
  activeActionId?: string;
  onSelect: (action: Live2DAction) => void;
  onOpenComposition: () => void;
  onManageActions: () => void;
  onClose: () => void;
};

const CompanionWardrobeDrawer: React.FC<CompanionWardrobeDrawerProps> = ({
  open,
  styleId,
  characterName,
  wardrobeActions,
  activeActionId,
  onSelect,
  onOpenComposition,
  onManageActions,
  onClose,
}) => {
  if (!open) return null;
  return (
    <div className="companion-wardrobe-layer absolute inset-0 z-[70]" data-wardrobe-style={styleId} data-testid="companion-real-wardrobe">
      <button type="button" className="companion-wardrobe-scrim absolute inset-0" onClick={onClose} aria-label="关闭衣橱" />
      <section className="companion-wardrobe-drawer absolute inset-y-0 right-0 flex w-[78%] max-w-[31rem] flex-col">
        <header className="companion-wardrobe-header">
          <div><small>MANUAL WARDROBE</small><h2><TShirt weight="fill" /> {characterName} 的衣橱</h2></div>
          <button type="button" onClick={onClose} aria-label="关闭"><X weight="bold" /></button>
        </header>

        <div className="companion-wardrobe-tabs">
          <span className="is-active"><TShirt weight="fill" /> 服装</span>
          <button type="button" onClick={onOpenComposition}><Crop weight="bold" /> 构图</button>
        </div>

        <p className="companion-wardrobe-note">这里的动作只能由你手动切换。AI 无法读取、选择或替换服装。</p>

        <div className="companion-wardrobe-list">
          {wardrobeActions.length ? wardrobeActions.map((action, index) => {
            const active = activeActionId === action.id;
            return (
              <button
                key={action.id}
                type="button"
                className={active ? 'is-active' : ''}
                onClick={() => onSelect(action)}
                data-wardrobe-action={action.id}
              >
                <span className="companion-wardrobe-index">{String(index + 1).padStart(2, '0')}</span>
                <span className="companion-wardrobe-copy"><strong>{action.name}</strong><small>{action.hotkey ? `原按键 ${action.hotkey}` : action.kind === 'motion' ? '服装动作' : action.kind === 'params' ? '服装参数组' : '服装表情'}</small></span>
                <span className="companion-wardrobe-play">{active ? <Check weight="bold" /> : <Play weight="fill" />}</span>
              </button>
            );
          }) : (
            <div className="companion-wardrobe-empty">
              <TShirt weight="duotone" />
              <strong>还没有标记服装动作</strong>
              <span>去动作库预览模型按键，把会换装的动作加入衣橱。</span>
            </div>
          )}
        </div>

        <footer className="companion-wardrobe-footer">
          <button type="button" onClick={onManageActions}><Gear weight="bold" /> 管理服装动作</button>
          <small>WARDROBE ACTIONS · USER ONLY</small>
        </footer>
      </section>
    </div>
  );
};

export default CompanionWardrobeDrawer;
