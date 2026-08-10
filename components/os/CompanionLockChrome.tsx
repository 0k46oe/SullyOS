import React from 'react';
import { Cat, ChatCircleDots, LockSimple, PawPrint } from '@phosphor-icons/react';
import type { CharacterProfile } from '../../types';
import './CompanionLockChrome.css';

type CompanionLockChromeProps = {
  variant: 'otome' | 'cat';
  hours: number;
  minutes: number;
  activeCharacter?: CharacterProfile | null;
  unreadCharacter?: CharacterProfile | null;
  unreadCount: number;
  preserveWallpaper?: boolean;
};

const CompanionLockChrome: React.FC<CompanionLockChromeProps> = ({
  variant,
  hours,
  minutes,
  activeCharacter,
  unreadCharacter,
  unreadCount,
  preserveWallpaper = false,
}) => {
  const date = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date());
  const time = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;

  return (
    <div
      className={`companion-themed-lock companion-themed-lock--${variant}`}
      style={{ '--lock-theme-opacity': preserveWallpaper ? 0.58 : 1 } as React.CSSProperties}
      data-testid={`companion-${variant}-lockscreen`}
    >
      <div className="companion-lock-atmosphere" aria-hidden>
        <i /><i /><i />
      </div>

      {variant === 'otome' ? (
        <>
          <header className="companion-lock-daybook">
            <span>DAYBOOK · LOCK</span>
            <strong>{activeCharacter?.name || 'Sully'}</strong>
            <small>{date}</small>
          </header>
          <div className="companion-lock-time companion-lock-time--otome"><strong>{time}</strong><span>晴庭仍为你留着灯</span></div>
        </>
      ) : (
        <>
          <header className="companion-lock-cat-mark"><Cat weight="fill" /><span>NIGHT COMPANION</span></header>
          <div className="companion-lock-time companion-lock-time--cat">
            <span className="companion-lock-cat-ears" aria-hidden />
            <strong>{time}</strong><span>{date} · {activeCharacter?.name || 'Sully'} 正在夜巡</span>
          </div>
        </>
      )}

      {unreadCount > 0 && (
        <section className="companion-lock-notice">
          <span className="companion-lock-notice-icon">{variant === 'cat' ? <PawPrint weight="fill" /> : <ChatCircleDots weight="fill" />}</span>
          <span><strong>{unreadCharacter?.name || 'Message'}</strong><small>{unreadCount > 1 ? `${unreadCount} 条新消息` : '发来了一条新消息'}</small></span>
          <em>刚刚</em>
        </section>
      )}

      <div className="companion-lock-unlock">
        <LockSimple weight="bold" />
        <span>轻触进入</span>
        <i aria-hidden />
      </div>
    </div>
  );
};

export default CompanionLockChrome;
