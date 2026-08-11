import React from 'react';
import { Check, Crop, Gear, Play, Sparkle, TShirt, X } from '@phosphor-icons/react';
import type { Live2DAction } from '../../utils/live2dModelStore';
import type { CompanionFrameStyleId } from './companionFrameStyles';
import { useBlobRefUrl } from '../../utils/blobRef';
import './CompanionWardrobeDrawer.css';

type StaticOutfit = {
  id: string;
  name: string;
  preview?: string;
  expressionCount: number;
};

const StaticOutfitPreview: React.FC<{ value?: string }> = ({ value }) => {
  const url = useBlobRefUrl(value);
  return url ? <img src={url} alt="" className="h-full w-full object-contain" /> : <TShirt weight="duotone" />;
};

type CompanionWardrobeDrawerProps = {
  open: boolean;
  styleId: CompanionFrameStyleId;
  characterName: string;
  wardrobeActions: Live2DAction[];
  activeActionId?: string;
  onSelect: (action: Live2DAction) => void;
  staticOutfits?: StaticOutfit[];
  activeStaticOutfitId?: string;
  onSelectStaticOutfit?: (outfitId: string) => void;
  staticMode?: boolean;
  staticSource?: 'upload' | 'date';
  discoveryHint?: boolean;
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
  staticOutfits = [],
  activeStaticOutfitId,
  onSelectStaticOutfit,
  staticMode = false,
  staticSource,
  discoveryHint = false,
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
          <button type="button" onClick={onOpenComposition}><Crop weight="bold" /> 场景与构图</button>
        </div>

        {discoveryHint && (
          <div className="companion-wardrobe-discovery" data-testid="companion-wardrobe-discovery-tip">
            <Sparkle weight="fill" />
            <p><strong>以后想换场景或衣服，就从这里进。</strong><span>点「场景与构图」可以更换桌面风格、背景和角色位置。</span></p>
          </div>
        )}

        <p className="companion-wardrobe-note">{staticSource === 'date' ? '衣服来自见面模式立绘。桌面拥有独立选择，AI 只负责按台词情绪切换同一套衣服里的表情。' : staticMode ? '单张静态图片没有额外服装动作；仍可从「场景与构图」更换桌面风格和背景。' : '这里的动作只能由你手动切换。AI 无法读取、选择或替换服装。'}</p>

        <div className="companion-wardrobe-list">
          {staticMode && staticOutfits.length ? staticOutfits.map(outfit => {
            const active = activeStaticOutfitId === outfit.id;
            return (
              <button
                key={outfit.id}
                type="button"
                className={active ? 'is-active' : ''}
                onClick={() => onSelectStaticOutfit?.(outfit.id)}
                data-static-outfit={outfit.id}
              >
                <span className="companion-wardrobe-thumb"><StaticOutfitPreview value={outfit.preview} /></span>
                <span className="companion-wardrobe-copy"><strong>{outfit.name}</strong><small>{outfit.expressionCount}/5 个基础表情</small></span>
                <span className="companion-wardrobe-play">{active ? <Check weight="bold" /> : <Play weight="fill" />}</span>
              </button>
            );
          }) : !staticMode && wardrobeActions.length ? wardrobeActions.map((action, index) => {
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
              <strong>{staticSource === 'date' ? '还没有见面衣服' : staticMode ? '单张图片没有额外衣服' : '还没有标记服装动作'}</strong>
              <span>{staticSource === 'date' ? '去见面模式添加默认立绘或新皮肤，每套衣服可以准备五种基础表情。' : staticMode ? '你可以继续使用当前图片，或进入场景与构图调整桌面。' : '去动作库预览模型按键，把会换装的动作加入衣橱。'}</span>
            </div>
          )}
        </div>

        <footer className="companion-wardrobe-footer">
          <button type="button" onClick={onManageActions}><Gear weight="bold" /> {staticSource === 'date' ? '管理见面立绘' : staticMode ? '更换静态图片' : '管理服装动作'}</button>
          <small>{staticSource === 'date' ? 'DATE SPRITES · 5 EXPRESSIONS' : staticMode ? 'STATIC IMAGE · PNG / GIF' : 'WARDROBE ACTIONS · USER ONLY'}</small>
        </footer>
      </section>
    </div>
  );
};

export default CompanionWardrobeDrawer;
