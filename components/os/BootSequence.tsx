import React, { useEffect, useState } from 'react';
import type { OSTheme } from '../../types';
import ClassicBootSequence from './ClassicBootSequence';

interface Props {
  dataReady: boolean;
  wallpaper?: string;
  style?: OSTheme['bootAnimationStyle'];
  onDone: () => void;
}
export default function BootSequence({dataReady, wallpaper, onDone}: Props) {
  const wp = wallpaper?.trim() || '';
  const isImage = /^(https?:|data:|blob:|\.?\/)/i.test(wp);
  const [preparedWallpaper, setPreparedWallpaper] = useState<string | null>(null);
  const wallpaperReady = !isImage || preparedWallpaper === wp;

  useEffect(() => {
    if (!isImage) return;
    let active = true;
    const image = new Image();
    const finish = () => {
      if (!active) return;
      active = false;
      clearTimeout(timeout);
      image.onload = image.onerror = null;
      setPreparedWallpaper(wp);
    };
    // 外链失败或一直无响应时仍可进入系统；不让一张壁纸永久阻塞启动。
    const timeout = setTimeout(finish, 8000);
    image.onload = () => {
      // URL 可用不等于像素已可绘制；本地大图也需要解码。
      if (typeof image.decode === 'function') void image.decode().then(finish, finish);
      else finish();
    };
    image.onerror = finish;
    image.src = wp;
    return () => {
      active = false;
      clearTimeout(timeout);
      image.onload = image.onerror = null;
    };
  }, [wp, isImage]);

  return <>
    {/* 欢迎画面淡出时先露出已准备好的实际壁纸，避免先看到空底再挂载锁屏。 */}
    <div aria-hidden="true" className="fixed inset-0 z-[9998] pointer-events-none" style={{
      background: isImage ? `#0f1115 url(${JSON.stringify(wp)}) center / cover no-repeat` : wp || '#0f1115',
    }} />
    <ClassicBootSequence dataReady={dataReady && wallpaperReady} wallpaper={wallpaper} onDone={onDone} />
  </>;
}
