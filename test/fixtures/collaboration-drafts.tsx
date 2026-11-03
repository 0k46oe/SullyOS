import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import CollaborationWindow from '../../features/collaboration/CollaborationWindow';
import { PRESET_THEMES } from '../../components/chat/ChatConstants';
import { CollaborationStore } from '../../features/collaboration/store';
import { DEFAULT_COLLABORATION_SETTINGS } from '../../features/collaboration/types';
import { DB } from '../../utils/db';
import type { APIConfig, CharacterProfile } from '../../types';

// Local browser fixture only; the matching test intercepts both API routes.
const avatar = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="20" fill="#708a7b"/><circle cx="32" cy="25" r="11" fill="#f3eddb"/><path d="M12 60a20 23 0 0 1 40 0" fill="#f3eddb"/></svg>');
const sticker = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="20" fill="#fff4d1"/><path d="M20 45V20l19 14h22l19-14v25c10 40-70 40-60 0" fill="#d8c29c"/><circle cx="38" cy="50" r="4" fill="#4e6048"/><circle cx="63" cy="50" r="4" fill="#4e6048"/><text x="50" y="93" font-size="16" text-anchor="middle" fill="#4e6048">贴贴</text></svg>');
const character = { id: 'qa-collaboration-drafts', name: '林间', avatar, systemPrompt: '陪用户一起整理笔记。', memories: [] } as CharacterProfile;
const profile = { baseUrl: location.origin + '/qa-chat/v1', apiKey: 'qa-only', model: 'qa-only', temperature: .7, stream: false, source: 'custom' as const };
await DB.saveCharacter(character);
await DB.saveEmoji('小猫贴贴', sticker);
await CollaborationStore.saveSettings({ ...DEFAULT_COLLABORATION_SETTINGS, recentChatContextCount: 0, focused: profile, immersive: profile });
function Preview() {
  const [vision, setVision] = useState(false);
  const [notice, setNotice] = useState('');
  (window as any).collaborationQA = { setVision, DB, CollaborationStore };
  return <div className="relative h-full"><CollaborationWindow open character={character} user={{name:'读者',avatar,bio:''}} theme={PRESET_THEMES.default}
    chatApi={{...profile, visionApi:{enabled:vision,baseUrl:location.origin+'/qa-vision/v1',apiKey:'qa-only',model:'qa-vision'}} as APIConfig}
    apiPresets={[]} availableModels={[]} characters={[character]} groups={[]} emojis={[{name:'小猫贴贴',url:sticker}]} emojiCategories={[]} recentChatMessages={[]}
    chatCollaborationEnabled={false} onClose={()=>setNotice('已关闭')} onSendToChat={async()=>{}} onInstallArtifact={async()=>''} onArchiveToMemory={async()=>''} onToggleChatCollaboration={()=>{}} notify={setNotice}/>
    <output className="pointer-events-none fixed left-4 top-20 z-[200] max-w-[90%] rounded-xl bg-white/95 px-3 py-2 text-[11px] text-slate-500">{notice}</output></div>;
}
createRoot(document.getElementById('root')!).render(<Preview />);
