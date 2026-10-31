import React from 'react';
import { createRoot } from 'react-dom/client';
import { OSProvider, useOS } from '../../context/OSContext';
import { MusicProvider } from '../../context/MusicContext';
import Appearance from '../../apps/Appearance';
import Settings from '../../apps/Settings';
import Chat from '../../apps/Chat';
import { DB } from '../../utils/db';
import { AppID } from '../../types';

function App() {
    const os = useOS();
    (window as any).backupQA = { os, DB };
    if (os.activeApp === AppID.Settings) return <Settings/>;
    if (os.activeApp === AppID.Chat) return <Chat/>;
    return <Appearance/>;
}
createRoot(document.getElementById('root')!).render(<OSProvider><MusicProvider><App/></MusicProvider></OSProvider>);
