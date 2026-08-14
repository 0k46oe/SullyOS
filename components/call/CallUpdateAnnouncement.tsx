import React from 'react';
import { Gear, Phone, SpeakerHigh, X } from '@phosphor-icons/react';

interface CallUpdateAnnouncementProps {
  accentColor: string;
  onDismiss: () => void;
  onOpenSettings: () => void;
}

const CallUpdateAnnouncement: React.FC<CallUpdateAnnouncementProps> = ({
  accentColor,
  onDismiss,
  onOpenSettings,
}) => (
  <div
    className="absolute inset-0 z-[90] flex items-center justify-center bg-[#05030c]/78 px-6 backdrop-blur-md"
    role="dialog"
    aria-modal="true"
    aria-labelledby="call-update-title"
    data-testid="call-update-announcement"
    onClick={onDismiss}
  >
    <style>{`
      @keyframes sully-call-update-in {
        from { opacity: 0; transform: translateY(16px) scale(.985); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }
      @keyframes sully-call-settings-pulse {
        0%, 100% { opacity: .35; transform: scale(.92); }
        50% { opacity: .9; transform: scale(1.22); }
      }
      .sully-call-update-panel { animation: sully-call-update-in 260ms cubic-bezier(.2,.8,.2,1) both; }
      .sully-call-settings-pulse { animation: sully-call-settings-pulse 1.55s ease-in-out infinite; }
      @media (prefers-reduced-motion: reduce) {
        .sully-call-update-panel, .sully-call-settings-pulse { animation-duration: .01ms; animation-iteration-count: 1; }
      }
    `}</style>

    <section
      className="sully-call-update-panel relative w-full max-w-[20rem] overflow-hidden rounded-[1.8rem] border border-white/12 bg-[#120c22]/95 px-5 pb-5 pt-4 shadow-2xl"
      onClick={event => event.stopPropagation()}
    >
      <button
        type="button"
        onClick={onDismiss}
        className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full text-white/38 transition active:scale-90"
        aria-label="关闭更新提示"
      >
        <X size={14} weight="bold" />
      </button>

      <div className="text-[9px] font-semibold tracking-[0.28em]" style={{ color: `${accentColor}cc` }}>CALL UPDATE</div>
      <h2 id="call-update-title" className="mt-2 pr-8 text-[1.45rem] font-semibold leading-tight text-white/95">通话有些调整</h2>
      <p className="mt-2 text-[11px] leading-5 text-white/45">为了让电话更像真的，我们改了几处。聊天里的语音不受影响。</p>

      <div className="mt-5 divide-y divide-white/8 border-y border-white/8">
        <div className="flex gap-3 py-3">
          <Phone className="mt-0.5 shrink-0" size={17} weight="fill" style={{ color: accentColor }} />
          <div>
            <div className="text-xs font-medium text-white/85">可以设置谁先开口</div>
            <div className="mt-0.5 text-[10px] leading-4 text-white/38">你可以选对方先说，也可以选自己先说。设置在左下角。</div>
          </div>
        </div>
        <div className="flex gap-3 py-3">
          <SpeakerHigh className="mt-0.5 shrink-0" size={17} weight="fill" style={{ color: accentColor }} />
          <div>
            <div className="text-xs font-medium text-white/85">可以关掉自动语音</div>
            <div className="mt-0.5 text-[10px] leading-4 text-white/38">关掉后不会提前生成语音。你点“播放语音”时，才会生成并播放。</div>
          </div>
        </div>
        <div className="flex gap-3 py-3">
          <span className="mt-0.5 flex h-[17px] w-[17px] shrink-0 items-center justify-center text-[10px]" style={{ color: accentColor }}>✦</span>
          <div>
            <div className="text-xs font-medium text-white/85">修了 iPhone 没声音的问题</div>
            <div className="mt-0.5 text-[10px] leading-4 text-white/38">Safari 和 Firefox 的视频通话、重播语音现在应该都能正常出声。</div>
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={onOpenSettings}
        className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl py-3 text-sm font-medium text-white transition active:scale-[.98]"
        style={{ background: accentColor, boxShadow: `0 0 22px ${accentColor}40` }}
      >
        <Gear size={16} weight="fill" /> 去设置
      </button>
      <button type="button" onClick={onDismiss} className="mt-2 w-full py-1.5 text-[11px] text-white/35 transition active:opacity-60">知道了</button>
    </section>

    <div
      className="absolute left-5"
      style={{ bottom: 'max(1.25rem, var(--safe-bottom, 0px))' }}
      data-testid="call-settings-spotlight"
      onClick={event => event.stopPropagation()}
    >
      <div className="absolute bottom-12 left-0 whitespace-nowrap rounded-full border border-white/12 bg-[#120c22] px-3 py-1.5 text-[10px] text-white/70 shadow-xl">
        设置在这里
        <span className="absolute -bottom-1 left-4 h-2 w-2 rotate-45 border-b border-r border-white/12 bg-[#120c22]" />
      </div>
      <span className="sully-call-settings-pulse pointer-events-none absolute -inset-2 rounded-full border" style={{ borderColor: accentColor, boxShadow: `0 0 18px ${accentColor}` }} />
      <button
        type="button"
        onClick={onOpenSettings}
        title="查看通话偏好"
        className="relative flex h-9 w-9 items-center justify-center rounded-full border bg-[#120c22] text-white shadow-2xl transition active:scale-90"
        style={{ borderColor: accentColor, boxShadow: `0 0 18px ${accentColor}88` }}
      >
        <Gear size={16} weight="fill" style={{ color: accentColor }} />
      </button>
    </div>
  </div>
);

export default CallUpdateAnnouncement;
