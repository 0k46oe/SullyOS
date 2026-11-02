import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { OSProvider, useOS } from '../../context/OSContext';
import Appearance from '../../apps/Appearance';
import Character from '../../apps/Character';
import Worldbook from '../../apps/WorldbookApp';
import Memory from '../../apps/MemoryPalaceApp';
import Settings from '../../apps/Settings';
import ChatModals from '../../components/chat/ChatModals';
import '../../styles/paper-ui.css';

function Preview() {
  const os = useOS();
  const [page, setPage] = useState('appearance');
  const [modalType, setModalType] = useState('message-options');
  const [xhsEnabled, setXhs] = useState(true);
  const [htmlModeEnabled, setHtml] = useState(true);
  (window as any).paperQA = { os, setPage, setModalType };
  const char = os.characters[0] || { id: 'paper-qa', name: 'Sully', avatar: '', systemPrompt: '' };
  const chat = {
    modalType, setModalType, activeCharacter: char, selectedMessage: { id: 1, role: 'assistant', type: 'text', content: '保留原本的聊天装扮', timestamp: 1 }, messages: [],
    onToggleMessageFavorite: () => {}, onDeleteMessage: () => {}, onSaveSettings: () => {},
    settingsContextLimit: 30, settingsContextRangeMode: 'auto', settingsInputPreferences: {}, settingsHideSysLogs: false,
    contextSuiteAnyEnabled: true, contextSuiteAllEnabled: true,
    onToggleContextSuite: () => {}, archivePrompts: [], editingPrompt: null,
    xhsEnabled, htmlModeEnabled, onToggleXhs: () => setXhs(value => !value), onToggleHtmlMode: () => setHtml(value => !value),
  } as any;
  return <div className="h-full flex flex-col">
    <nav className="flex gap-3 p-2 text-xs shrink-0 overflow-x-auto">{['appearance','character','worldbook','memory','settings','chat'].map(name => <button key={name} onClick={() => setPage(name)}>{name}</button>)}</nav>
    <main className="min-h-0 flex-1 relative" data-paper-ui={page === 'chat' ? undefined : page}>
      {page === 'appearance' ? <Appearance /> : page === 'character' ? <Character /> : page === 'worldbook' ? <Worldbook /> : page === 'memory' ? <Memory /> : page === 'settings' ? <Settings /> : <ChatModals {...chat} />}
    </main>
    <div id="paper-untouched" style={{position:'fixed',bottom:0,right:0,pointerEvents:'none'}}>
      <span className="bg-violet-500 text-white" style={{display:'none'}}>原聊天气泡</span>
    </div>
  </div>;
}
createRoot(document.getElementById('root')!).render(<OSProvider><Preview /></OSProvider>);
