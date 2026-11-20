// Production Chat and storage in a fresh browser context; no real accounts or API requests.
import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { OSProvider, useOS } from '../../context/OSContext';
import { MusicProvider } from '../../context/MusicContext';
import Chat from '../../apps/Chat';
import { DB } from '../../utils/db';
import { AppID } from '../../types';
import '../../styles/paper-ui.css';
import { saveLibraryDecoration } from '../../utils/decorationLibrary';

const characterId = 'qa-chat-entrypoints';
const image = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#dce5cd"/></svg>');
function Preview() {
  const os = useOS();
  useEffect(() => { os.openApp(AppID.Chat); }, []);
  return os.characters.some(character => character.id === characterId) ? <Chat /> : <p>等待角色载入</p>;
}
async function start() {
  localStorage.setItem('sully-beauty-catalog-notice-v1', 'seen');
  localStorage.setItem('sullyos_chat_wardrobe_guide_v2_done', '1');
  localStorage.setItem('os_last_active_char_id', characterId);
  localStorage.setItem('os_theme', JSON.stringify({ skin: 'default', paperUiStyle: 'sage-cream' }));
  localStorage.setItem('sully-chat-input-preferences-v1', JSON.stringify({ autoReply: false }));
  localStorage.setItem('sully-chat-decoration-announcement-v1:chat', '1');
  await DB.saveCharacter({ id: characterId, name: '入口测试角色', avatar: image, systemPrompt: '界面测试角色', memories: [], activeMsg2Config: { enabled: false, tasks: [] } } as any);
  await DB.saveCharacter({ id: 'qa-trial-target', name: '试用目标角色', avatar: image, memories: [] } as any);
  await saveLibraryDecoration({ format: 'sullyos-chat-decoration', version: 1, name: '测试白框', parts: { css: '.sully-chat-header { background-color: rgb(240, 220, 200) !important; }' } }, { kind: 'self' });
  await DB.saveEmojiCategory({ id: 'qa-stickers', name: '测试表情' });
  await DB.saveEmoji('测试贴纸', image, 'qa-stickers');
  if (!(await DB.getMessagesByCharId(characterId)).length) {
    await DB.saveMessage({ charId: characterId, role: 'user', type: 'text', content: '你好' });
    await DB.saveMessage({ charId: characterId, role: 'assistant', type: 'text', content: '点击我的头像查看角色名片。' });
  }
  createRoot(document.getElementById('root')!).render(<OSProvider><MusicProvider><Preview /></MusicProvider></OSProvider>);
}
void start();
