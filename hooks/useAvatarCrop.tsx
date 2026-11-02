import React, {useCallback, useEffect, useRef, useState} from 'react';
import AvatarCropDialog from '../components/user/AvatarCropDialog';

type Pending = { id: number; file: File; resolve: (value: string | null) => void };

/** Selection is temporary: cancel/unmount never writes an avatar or a blob asset. */
export function useAvatarCrop() {
    const pending = useRef<Pending | null>(null);
    const [selection, setSelection] = useState<Pending | null>(null);
    const sequence = useRef(0);
    const chooseAvatar = useCallback((next: File) => new Promise<string | null>(resolve => {
        pending.current?.resolve(null);
        pending.current = {id: ++sequence.current, file: next, resolve};
        setSelection(pending.current);
    }), []);
    const finish = useCallback((id: number, value: string | null) => {
        const request = pending.current;
        if (request?.id !== id) return;
        pending.current = null;
        setSelection(null);
        request?.resolve(value);
    }, []);
    useEffect(() => () => {pending.current?.resolve(null); pending.current = null;}, []);
    const avatarCropDialog = selection ? <AvatarCropDialog key={selection.id} file={selection.file} onComplete={value => finish(selection.id, value)}/> : null;
    return {chooseAvatar, avatarCropDialog};
}
