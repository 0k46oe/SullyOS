import React, { useEffect, useState } from 'react';
import Modal from '../os/Modal';
import {
  ActiveMsg2CharacterConfig,
  ActiveMsg2ExpirePolicy,
  ActiveMsg2Mode,
  ActiveMsg2Recurrence,
  ActiveMsg2TaskRecord,
  APIConfig,
  CharacterProfile,
  GroupProfile,
  RealtimeConfig,
  UserProfile,
} from '../../types';
import { ActiveMsgClient, getDefaultActiveMsgFirstSendTime } from '../../utils/activeMsgClient';
import {
  isPendingTask,
  normalizeActiveMsg2Config,
  pruneStaleTasks,
  shortTaskId,
  toDatetimeLocalValue,
} from '../../utils/amsg2Tasks';

interface ActiveMsg2SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  char: CharacterProfile;
  apiConfig: APIConfig;
  userProfile: UserProfile;
  groups: GroupProfile[];
  realtimeConfig: RealtimeConfig;
  onSave: (config: NonNullable<CharacterProfile['activeMsg2Config']>) => void;
  addToast: (message: string, type?: 'success' | 'error' | 'info') => void;
}

const MODE_OPTIONS = [
  { id: 'fixed', label: '固定', desc: '到点直接发你写好的内容' },
  { id: 'auto', label: '自动', desc: '用当前角色设定和聊天快照自己生成' },
  { id: 'prompted', label: '提示词', desc: '围绕你写的方向生成主动消息' },
] as const;

const RECURRENCE_OPTIONS = [
  { id: 'none', label: '一次' },
  { id: 'daily', label: '每天' },
  { id: 'weekly', label: '每周' },
] as const;

const ActiveMsg2SettingsModal: React.FC<ActiveMsg2SettingsModalProps> = ({
  isOpen,
  onClose,
  char,
  apiConfig,
  userProfile,
  groups,
  realtimeConfig,
  onSave,
  addToast,
}) => {
  const saved = normalizeActiveMsg2Config(char.activeMsg2Config);
  const tasks = saved?.tasks ?? [];

  const [enabled, setEnabled] = useState(saved?.enabled ?? false);
  const [mode, setMode] = useState<ActiveMsg2Mode>('auto');
  const [firstSendTime, setFirstSendTime] = useState(getDefaultActiveMsgFirstSendTime());
  const [recurrenceType, setRecurrenceType] = useState<ActiveMsg2Recurrence>('none');
  const [userMessage, setUserMessage] = useState('');
  const [promptHint, setPromptHint] = useState('');
  const [maxTokens, setMaxTokens] = useState(String(saved?.maxTokens ?? ''));
  const [useSecondaryApi, setUseSecondaryApi] = useState(saved?.useSecondaryApi ?? false);
  const [secUrl, setSecUrl] = useState(saved?.secondaryApi?.baseUrl ?? '');
  const [secKey, setSecKey] = useState(saved?.secondaryApi?.apiKey ?? '');
  const [secModel, setSecModel] = useState(saved?.secondaryApi?.model ?? '');
  const [globalReady, setGlobalReady] = useState(false);
  const [pushSummary, setPushSummary] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  // editingTaskUuid=null → 新建；非 null → 编辑该任务（保存时 replaceTaskUuid）。
  const [editingTaskUuid, setEditingTaskUuid] = useState<string | null>(null);
  const [expirePolicy, setExpirePolicy] = useState<ActiveMsg2ExpirePolicy>('expire');
  // 远端对账：打开面板时拉一次全量任务，只留归属本角色的 uuid。null = 没对上账（读失败/未拉完），
  // 此时不显示「远端不存在」徽标，免得半个清单误伤。
  const [remoteUuids, setRemoteUuids] = useState<Set<string> | null>(null);

  // 表单值重置：面板打开或切换编辑对象时，用被编辑任务的字段填表单（新建则填默认值）。
  // 角色级共享设置（maxTokens / 单独 API）始终跟随保存值。
  useEffect(() => {
    if (!isOpen) return;

    const config = normalizeActiveMsg2Config(char.activeMsg2Config);
    const list = config?.tasks ?? [];
    setEnabled(config?.enabled ?? false);
    setMaxTokens(config?.maxTokens ? String(config.maxTokens) : '');
    setUseSecondaryApi(config?.useSecondaryApi ?? false);
    setSecUrl(config?.secondaryApi?.baseUrl ?? '');
    setSecKey(config?.secondaryApi?.apiKey ?? '');
    setSecModel(config?.secondaryApi?.model ?? '');

    const editing = editingTaskUuid ? list.find((t) => t.taskUuid === editingTaskUuid) : undefined;
    if (editing) {
      setMode(editing.mode);
      setFirstSendTime(toDatetimeLocalValue(editing.firstSendTime));
      setRecurrenceType(editing.recurrenceType);
      setUserMessage(editing.userMessage ?? '');
      setPromptHint(editing.promptHint ?? '');
      setExpirePolicy(editing.mode === 'fixed' ? 'force' : (editing.expirePolicy ?? 'expire'));
    } else {
      setMode('auto');
      setFirstSendTime(getDefaultActiveMsgFirstSendTime());
      setRecurrenceType('none');
      setUserMessage('');
      setPromptHint('');
      setExpirePolicy('expire');
    }
  }, [isOpen, char.id, char.activeMsg2Config, editingTaskUuid]);

  // 打开面板时的 push 状态检查 + 远端对账（只随 isOpen / 角色变化跑，不随编辑对象重复请求）。
  useEffect(() => {
    if (!isOpen) return;
    setRemoteUuids(null);

    void (async () => {
      const globalConfig = await ActiveMsgClient.getGlobalConfig();
      const pushStatus = await ActiveMsgClient.getPushStatus();
      setGlobalReady(Boolean(globalConfig.workerUrl));
      setPushSummary(pushStatus.supported
        ? `权限：${pushStatus.permission} / 订阅：${pushStatus.hasSubscription ? '已就绪' : '未创建'}`
        : '当前环境不支持 Web Push');
    })();

    void (async () => {
      try {
        const remote = await ActiveMsgClient.listAllTasks();
        setRemoteUuids(new Set(
          remote
            .filter((t: any) => t?.charId === char.id && t?.uuid)
            .map((t: any) => t.uuid as string),
        ));
      } catch {
        // 对账失败不打扰：null 让「远端不存在」徽标整体不显示。
        setRemoteUuids(null);
      }
    })();
  }, [isOpen, char.id]);

  // 角色级共享设置（所有任务共用），每次落盘都从当前表单值重建。
  const charLevelConfig = (): ActiveMsg2CharacterConfig => ({
    enabled: true,
    tasks,
    maxTokens: maxTokens.trim() ? Number(maxTokens) : undefined,
    useSecondaryApi: useSecondaryApi && !!secUrl,
    secondaryApi: useSecondaryApi && secUrl
      ? { baseUrl: secUrl.trim(), apiKey: secKey.trim(), model: secModel.trim() }
      : undefined,
    lastSyncedAt: saved?.lastSyncedAt,
  });

  const handleCancelTask = async (t: ActiveMsg2TaskRecord) => {
    try {
      await ActiveMsgClient.cancelTask(t.taskUuid);
    } catch (e) {
      // 远端取消失败不移除本地记录（Codex #4）——否则远端照发、面板却看不见了。
      console.warn('[ActiveMsg2Modal] 远端取消失败（保留记录待重试）', e);
      onSave({
        ...charLevelConfig(),
        tasks: tasks.map((x) => x.taskUuid === t.taskUuid ? { ...x, lastError: '远端取消失败，可重试' } : x),
      });
      addToast(`任务 [${shortTaskId(t.taskUuid)}] 取消失败（远端未确认），稍后重试。`, 'error');
      return;
    }
    if (editingTaskUuid === t.taskUuid) setEditingTaskUuid(null);
    onSave({ ...charLevelConfig(), tasks: tasks.filter((x) => x.taskUuid !== t.taskUuid), lastSyncedAt: Date.now() });
    addToast(`任务 [${shortTaskId(t.taskUuid)}] 已取消。`, 'info');
  };

  const handleSubmit = async () => {
    setIsSubmitting(true);
    try {
      if (!enabled) {
        // 关闭 2.0 = 取消该角色全部远端任务。以远端 listAllTasks 为准（Codex #4：本地
        // pending 派生会漏掉「已过点但 Cron 还没消费」的一次性任务）；远端读不到时
        // 退回本地全量清单。取消失败的保留在本地清单里，下次重开面板可重试。
        let targets: string[];
        try {
          const remote = await ActiveMsgClient.listAllTasks();
          targets = remote
            .filter((t: any) => t?.charId === char.id && t?.uuid)
            .map((t: any) => t.uuid as string);
          // 上游身份投影不可用时只退回本地清单；禁止用 contactName 匹配，角色可重名。
          if (!targets.length && tasks.length) targets = tasks.map((t) => t.taskUuid);
        } catch {
          targets = tasks.map((t) => t.taskUuid);
        }
        const failed = new Set<string>();
        for (const uuid of targets) {
          try { await ActiveMsgClient.cancelTask(uuid); } catch { failed.add(uuid); }
        }
        onSave({
          ...charLevelConfig(),
          enabled: false,
          tasks: tasks.filter((t) => failed.has(t.taskUuid))
            .map((t) => ({ ...t, lastError: '关闭时远端取消失败，可重试' })),
          lastSyncedAt: Date.now(),
        });
        addToast(failed.size
          ? `主动消息 2.0 已关闭，但有 ${failed.size} 个任务远端取消失败，请稍后重开面板重试。`
          : '主动消息 2.0 已关闭，全部任务已取消。', failed.size ? 'error' : 'info');
        onClose();
        return;
      }

      if (!globalReady) throw new Error('请先去系统设置里完成“主动消息 2.0”的全局配置。');

      const config = charLevelConfig();
      const result = await ActiveMsgClient.scheduleCharacterTask({
        char, config,
        task: {
          mode, firstSendTime, recurrenceType,
          promptHint: promptHint.trim() || undefined,
          userMessage: userMessage.trim() || undefined,
          expirePolicy,
        },
        replaceTaskUuid: editingTaskUuid ?? undefined,
        userProfile, groups, realtimeConfig, apiConfig,
      });

      const record: ActiveMsg2TaskRecord = {
        taskUuid: result.uuid,
        clientTaskId: result.clientTaskId,
        mode, firstSendTime, recurrenceType,
        promptHint: promptHint.trim() || undefined,
        userMessage: userMessage.trim() || undefined,
        expirePolicy: mode === 'fixed' ? 'force' : expirePolicy,
        anchorLastUserMsgAt: result.anchorMs,
        source: 'user',
        status: 'scheduled',
        createdAt: Date.now(),
      };
      // 和工具路径一致：替换后旧任务取消失败时，旧记录必须保留并标错，
      // 否则远端新旧并存、面板只显示新的，幽灵任务又回来了。
      const rest = result.replacedCancelFailed
        ? tasks.map((t) => t.taskUuid === editingTaskUuid
          ? { ...t, lastError: '替换时远端取消失败，任务可能仍会触发，可再次取消' }
          : t)
        : tasks.filter((t) => t.taskUuid !== editingTaskUuid);
      onSave({ ...config, tasks: pruneStaleTasks([...rest, record], Date.now()), lastSyncedAt: Date.now() });
      setEditingTaskUuid(null);
      addToast(result.replacedCancelFailed
        ? '新任务已创建，但旧任务取消失败，请稍后重试。'
        : (editingTaskUuid ? '任务已更新。' : `任务已创建 [${shortTaskId(result.uuid)}]。`),
      result.replacedCancelFailed ? 'error' : 'success');
    } catch (error: any) {
      const message = error?.message || '主动消息 2.0 保存失败。';
      onSave({ ...charLevelConfig(), lastError: message });
      addToast(message, 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      title="主动消息 2.0"
      onClose={onClose}
      footer={(
        <>
          <button onClick={onClose} className="flex-1 py-3 bg-slate-100 text-slate-500 font-bold rounded-2xl active:scale-95 transition-transform">
            取消
          </button>
          <button onClick={handleSubmit} disabled={isSubmitting} className="flex-1 py-3 bg-fuchsia-500 text-white font-bold rounded-2xl active:scale-95 transition-transform disabled:opacity-50">
            {isSubmitting ? '保存中...' : !enabled ? '关闭 2.0' : (editingTaskUuid ? '保存修改' : '新建任务')}
          </button>
        </>
      )}
    >
      <div className="space-y-4 text-sm text-slate-600">
        <p className="text-xs leading-relaxed text-slate-500">
          这是新的云端主动消息入口。它会把当前角色设定、最近聊天快照和推送订阅一起提交到主动消息标准服务里。长周期循环任务建议在剧情变化后重新保存一次，避免使用过旧的上下文。
        </p>

        <div className="flex items-center justify-between bg-fuchsia-50 border border-fuchsia-100 rounded-2xl p-4">
          <div>
            <div className="font-bold text-slate-700">启用主动消息 2.0</div>
            <div className="text-xs text-fuchsia-600 mt-1">{pushSummary || '正在检查 Push 状态...'}</div>
          </div>
          <button
            onClick={() => setEnabled(!enabled)}
            className={`w-12 h-7 rounded-full transition-colors relative ${enabled ? 'bg-fuchsia-500' : 'bg-slate-200'}`}
          >
            <span className={`absolute top-0.5 left-0.5 w-6 h-6 bg-white rounded-full shadow transition-all duration-200 ${enabled ? 'translate-x-5' : 'translate-x-0'}`} />
          </button>
        </div>

        {enabled && tasks.length > 0 ? (
          <div>
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block pl-1">
              任务列表（{tasks.length}）
            </label>
            <div className="space-y-2">
              {tasks.map((t) => {
                const pending = isPendingTask(t, Date.now());
                const recurrence = t.recurrenceType === 'daily' ? '每天' : t.recurrenceType === 'weekly' ? '每周' : '一次';
                const what = t.mode === 'fixed' ? '固定消息' : t.mode === 'prompted' ? (t.promptHint || '提示词') : '自动';
                const missingRemote = remoteUuids !== null && pending && !remoteUuids.has(t.taskUuid);
                return (
                  <div key={t.taskUuid} className={`rounded-2xl border px-4 py-3 text-xs ${editingTaskUuid === t.taskUuid ? 'border-fuchsia-400 bg-fuchsia-50' : 'border-slate-200 bg-white'}`}>
                    <div className="flex items-center justify-between">
                      <div className="min-w-0">
                        <div className="font-bold text-slate-700 truncate">
                          [{shortTaskId(t.taskUuid)}] {new Date(t.firstSendTime).toLocaleString('zh-CN', { hour12: false })} · {recurrence}
                        </div>
                        <div className="text-slate-400 mt-0.5 truncate">
                          {what} · {(t.expirePolicy ?? 'expire') === 'force' ? '强制发送' : '遇忙作废'}
                          · {t.source === 'character' ? '角色创建' : '手动创建'} · {pending ? '待触发' : '已到点'}
                        </div>
                        {missingRemote ? (
                          <div className="text-slate-400 mt-1 text-[11px]">⚠ 远端不存在（可能已发送或在别处取消）</div>
                        ) : null}
                        {t.lastError ? (
                          <div className="text-red-500 mt-1 text-[11px]">{t.lastError}</div>
                        ) : null}
                      </div>
                      <div className="flex gap-2 shrink-0 ml-2">
                        <button onClick={() => setEditingTaskUuid(t.taskUuid)} className="px-2.5 py-1.5 rounded-lg bg-slate-100 text-slate-600 font-bold">编辑</button>
                        <button onClick={() => void handleCancelTask(t)} className="px-2.5 py-1.5 rounded-lg bg-red-50 text-red-500 font-bold">取消</button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            {editingTaskUuid ? (
              <button onClick={() => setEditingTaskUuid(null)} className="mt-2 text-xs text-fuchsia-500 font-bold pl-1">
                ＋ 放弃编辑，改为新建任务
              </button>
            ) : null}
          </div>
        ) : null}

        {enabled ? (
          <>
            <div>
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block pl-1">
                {editingTaskUuid ? '编辑任务' : '新建任务'}
              </label>
              <div className="space-y-2">
                {MODE_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    onClick={() => {
                      setMode(option.id);
                      // fixed 进不了 worker 闸（taskNeedsLlm=false），策略统一钉成 force。
                      if (option.id === 'fixed') setExpirePolicy('force');
                    }}
                    className={`w-full text-left rounded-2xl border px-4 py-3 transition-all ${mode === option.id ? 'bg-fuchsia-500 text-white border-fuchsia-500' : 'bg-white border-slate-200 text-slate-600'}`}
                  >
                    <div className="font-bold">{option.label}</div>
                    <div className={`text-xs mt-1 ${mode === option.id ? 'text-fuchsia-50' : 'text-slate-400'}`}>{option.desc}</div>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">首次发送时间</label>
              <input
                type="datetime-local"
                value={firstSendTime}
                onChange={(event) => setFirstSendTime(event.target.value)}
                className="w-full bg-white border border-slate-200 rounded-2xl px-4 py-3 text-sm"
              />
            </div>

            <div>
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block pl-1">重复方式</label>
              <div className="grid grid-cols-3 gap-2">
                {RECURRENCE_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    onClick={() => setRecurrenceType(option.id)}
                    className={`py-2.5 rounded-xl text-xs font-bold border transition-all ${recurrenceType === option.id ? 'bg-fuchsia-500 text-white border-fuchsia-500' : 'bg-white border-slate-200 text-slate-600'}`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <div className="text-[11px] text-slate-400 mt-2 pl-1">
                2.0 标准版目前只支持：一次 / 每天 / 每周。30 分钟、1 小时、2 小时这类间隔暂时不支持。
              </div>
            </div>

            {mode !== 'fixed' ? (
              <div>
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block pl-1">到点时用户正在聊天</label>
                <div className="grid grid-cols-2 gap-2">
                  {([
                    { id: 'expire', label: '自动作废', desc: '转为对话里自然带出' },
                    { id: 'force', label: '强制发送', desc: '闹钟型，照发' },
                  ] as const).map((option) => (
                    <button
                      key={option.id}
                      onClick={() => setExpirePolicy(option.id)}
                      className={`py-2.5 rounded-xl text-xs font-bold border transition-all ${expirePolicy === option.id ? 'bg-fuchsia-500 text-white border-fuchsia-500' : 'bg-white border-slate-200 text-slate-600'}`}
                    >
                      {option.label}
                      <div className={`font-normal mt-0.5 ${expirePolicy === option.id ? 'text-fuchsia-100' : 'text-slate-400'}`}>{option.desc}</div>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {mode === 'fixed' ? (
              <div>
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">固定消息内容</label>
                <textarea
                  value={userMessage}
                  onChange={(event) => setUserMessage(event.target.value)}
                  placeholder="到点后直接推送这段消息"
                  className="w-full h-28 bg-white border border-slate-200 rounded-2xl px-4 py-3 text-sm resize-none"
                />
              </div>
            ) : (
              <>
                <div>
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">
                    {mode === 'prompted' ? '额外提示词' : '补充灵感 (可选)'}
                  </label>
                  <textarea
                    value={promptHint}
                    onChange={(event) => setPromptHint(event.target.value)}
                    placeholder={mode === 'prompted' ? '例如：晚安前撒娇一下，但别太油' : '例如：今天下雨、想找我聊一点轻松的'}
                    className="w-full h-24 bg-white border border-slate-200 rounded-2xl px-4 py-3 text-sm resize-none"
                  />
                </div>

                <div>
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">maxTokens (可选)</label>
                  <input
                    type="number"
                    min={1}
                    value={maxTokens}
                    onChange={(event) => setMaxTokens(event.target.value)}
                    placeholder="例如 120"
                    className="w-full bg-white border border-slate-200 rounded-2xl px-4 py-3 text-sm"
                  />
                </div>
              </>
            )}

            <div className="pt-1 border-t border-slate-100">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <div className="font-bold text-slate-700">使用单独 API</div>
                  <div className="text-xs text-slate-400 mt-1">不开启则复用当前聊天主 API。</div>
                </div>
                <button
                  onClick={() => setUseSecondaryApi(!useSecondaryApi)}
                  className={`w-12 h-7 rounded-full transition-colors relative ${useSecondaryApi ? 'bg-fuchsia-500' : 'bg-slate-200'}`}
                >
                  <span className={`absolute top-0.5 left-0.5 w-6 h-6 bg-white rounded-full shadow transition-all duration-200 ${useSecondaryApi ? 'translate-x-5' : 'translate-x-0'}`} />
                </button>
              </div>

              {useSecondaryApi ? (
                <div className="space-y-3 bg-slate-50 rounded-2xl p-3">
                  <input value={secUrl} onChange={(event) => setSecUrl(event.target.value)} placeholder="API URL" className="w-full px-3 py-2 bg-white rounded-xl text-sm border border-slate-200" />
                  <input type="password" value={secKey} onChange={(event) => setSecKey(event.target.value)} placeholder="API Key" className="w-full px-3 py-2 bg-white rounded-xl text-sm border border-slate-200" />
                  <input value={secModel} onChange={(event) => setSecModel(event.target.value)} placeholder="Model" className="w-full px-3 py-2 bg-white rounded-xl text-sm border border-slate-200" />
                </div>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </Modal>
  );
};

export default React.memo(ActiveMsg2SettingsModal);
