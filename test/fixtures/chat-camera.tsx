import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import ChatCamera from '../../components/chat/ChatCamera';
import ChatImage from '../../components/chat/ChatImage';
import { createBuiltinSullyLive2DConfig } from '../../utils/builtinSullyLive2D';
import type { CharacterProfile } from '../../types';
import chibi from '../../assets/sar/caian-chibi.png';

const character = { id: 'qa', name: 'QA', vrState: { chibi: { img: chibi } }, sprites: { chibi, normal: chibi, happy: chibi }, dateSkinSets: [{ id: 'coat', name: '冬装', sprites: { sad: chibi } }], chibiStudio: { like520: { img: chibi } }, videoAvatar: createBuiltinSullyLive2DConfig() } as unknown as CharacterProfile;
function Fixture() {
    const [open, setOpen] = useState(true), [result, setResult] = useState('');
    return <><button onClick={() => setOpen(true)}>相册</button><output>{result ? '已接收照片' : ''}</output>{result && <><img alt="已发送照片" src={result} /><ChatImage value={result} selectionMode={false} /></>}{open && <ChatCamera character={character} onClose={() => setOpen(false)} onGallery={() => { setResult(''); setOpen(false); }} onCapture={file => { const reader = new FileReader(); reader.onload = () => setResult(String(reader.result)); reader.readAsDataURL(file); }} />}</>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
