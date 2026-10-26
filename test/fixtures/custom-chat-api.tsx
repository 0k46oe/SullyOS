import React from 'react';
import { createRoot } from 'react-dom/client';
import { OSProvider, useOS } from '../../context/OSContext';
import { AppID } from '../../types';
import NavigationBall from '../../components/os/NavigationBall';
import NavigationBallSettings from '../../components/settings/NavigationBallSettings';
import CharacterApiPanel from '../../components/character/CharacterApiPanel';
import { setNavigationBallEnabled } from '../../utils/navigationBall';

function Preview() {
  const os = useOS();
  const character = os.characters.find(item => item.id === os.activeCharacterId) || os.characters[0];
  const seed = () => {
    os.updateApiConfig({ baseUrl: 'https://openai.example/v1', apiKey: 'demo-only-key', model: 'demo-openai', protocol: 'openai', stream: false });
    os.apiPresets.filter(preset => preset.name.startsWith('验收 · ')).forEach(preset => os.removeApiPreset(preset.id));
    os.addApiPreset('验收 · OpenAI', { baseUrl: 'https://openai.example/v1', apiKey: 'demo-only-key', model: 'demo-openai', protocol: 'openai' }, '普通聊天');
    os.addApiPreset('验收 · Anthropic', { baseUrl: 'https://anthropic.example', apiKey: 'demo-only-key', model: 'demo-claude', protocol: 'anthropic' }, '普通聊天');
    if (character) os.setActiveCharacterId(character.id);
    os.openApp(AppID.Chat); os.unlock(); setNavigationBallEnabled(true);
  };
  return <div className="relative mx-auto flex h-full max-w-md flex-col bg-slate-50">
    <header className="shrink-0 border-b border-slate-200 bg-white p-4">
      <h1 className="text-base font-semibold text-slate-700">普通聊天 API 与悬浮球验收</h1>
      <p className="mt-2 text-xs leading-relaxed text-slate-400">此页仅写入本预览站点的虚构配置，不调用模型。</p>
      <button disabled={!os.isDataLoaded} onClick={seed} className="mt-3 rounded-xl bg-violet-500 px-4 py-2 text-xs text-white disabled:opacity-50">加载演示配置</button>
    </header>
    <main className="min-h-0 flex-1 space-y-4 overflow-auto p-3">
      <NavigationBallSettings characters={os.characters} />
      {character && <CharacterApiPanel character={character} onChange={dialogueApi => os.updateCharacter(character.id, { dialogueApi })} />}
      <p data-testid="effective-api" className="break-all text-xs text-slate-500">角色协议：{character?.dialogueApi?.protocol || '跟随全局'}；全局协议：{os.apiConfig.protocol || 'openai'}</p>
    </main>
    <NavigationBall />
  </div>;
}
createRoot(document.getElementById('root')!).render(<OSProvider><Preview /></OSProvider>);
