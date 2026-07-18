import React, { useEffect, useState } from 'react';
import Modal from '../os/Modal';
import { ActiveMsg2GlobalConfig } from '../../types';
import { ActiveMsgClient, ActiveMsg2PushStatus } from '../../utils/activeMsgClient';
import { ActiveMsgStore, maskActiveMsgUserId } from '../../utils/activeMsgStore';
import { buildCloudflareDashboardUrl } from '../../utils/instantPushClient';
import { generateClientToken } from '../../utils/vapidGen';

// 满血链路吃满这些 worker 特性（amsg-server 2.6.0-next.4+）。探测不到端点（老部署
// 404 → null）或缺任何一项，就亮「重新部署」提示——worker 是粘贴部署的，不会自动更新。
const REQUIRED_WORKER_FEATURES = [
  'client-state',
  'client-state-chunking',
  'agentic-hooks',
  'agentic-scratch',
];

interface ActiveMsgGlobalSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  addToast: (message: string, type?: 'success' | 'error' | 'info') => void;
  /** 由 Settings 注入：点「去推送凭据面板」时打开顶层 PushVapidSettingsModal */
  onOpenVapid?: () => void;
}

const ActiveMsgGlobalSettingsModal: React.FC<ActiveMsgGlobalSettingsModalProps> = ({
  isOpen,
  onClose,
  addToast,
  onOpenVapid,
}) => {
  const [config, setConfig] = useState<ActiveMsg2GlobalConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [deployOpen, setDeployOpen] = useState(false);
  const [pushStatus, setPushStatus] = useState<ActiveMsg2PushStatus | null>(null);
  // 「生成 Master Key」只在本次打开期间展示，前端不落盘——它是 worker 侧密钥，粘进 CF env 即可。
  const [generatedMasterKey, setGeneratedMasterKey] = useState('');

  const [workerOutdated, setWorkerOutdated] = useState(false);

  // 特性探测：确认「过老」（端点 404 → null，或缺关键特性）才亮牌；
  // 探测本身失败（断网 / 密钥不对 / 没填地址）不亮，避免误报。
  const probeWorkerCaps = async () => {
    try {
      const caps = await ActiveMsgClient.getCapabilities();
      setWorkerOutdated(!caps || REQUIRED_WORKER_FEATURES.some((f) => !caps.features.includes(f)));
    } catch {
      setWorkerOutdated(false);
    }
  };

  const refresh = async () => {
    const nextConfig = await ActiveMsgClient.getGlobalConfig();
    const nextPushStatus = await ActiveMsgClient.getPushStatus();
    setConfig(nextConfig);
    setPushStatus(nextPushStatus);
    void probeWorkerCaps();
  };

  useEffect(() => {
    if (!isOpen) return;
    setAdvancedOpen(false);
    setDeployOpen(false);
    setGeneratedMasterKey('');
    void refresh();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !config) return;
    void ActiveMsgStore.saveGlobalConfig({
      workerUrl: config.workerUrl,
      serverToken: config.serverToken,
    });
  }, [config?.workerUrl, config?.serverToken, isOpen]);

  const patchConfig = (updates: Partial<ActiveMsg2GlobalConfig>) => {
    setConfig((prev) => ({
      ...(prev || { userId: '', workerUrl: '' }),
      ...updates,
    }));
  };

  const handleCreateSubscription = async () => {
    setLoading(true);
    try {
      await ActiveMsgClient.ensurePushSubscription();
      await refresh();
      addToast('通知权限和推送订阅已准备完成。', 'success');
    } catch (error: any) {
      addToast(error?.message || '创建推送订阅失败。', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleConnect = async () => {
    if (!config?.workerUrl.trim()) {
      addToast('先把你部署的 Worker 地址填进来。', 'error');
      return;
    }

    setLoading(true);
    try {
      await ActiveMsgClient.connect();
      await refresh();
      addToast('已连接成功，主动消息 2.0 可以用了。', 'success');
    } catch (error: any) {
      addToast(error?.message || '连接失败。', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleCopyWorkerBundle = async () => {
    try {
      await ActiveMsgClient.copyWorkerBundleToClipboard();
      addToast('Worker 代码已复制，去 CF 后台的 Edit code 里粘贴覆盖。', 'success');
    } catch (error: any) {
      addToast(`复制失败（${error?.message || error}）。也可以从仓库 worker/amsg/worker.bundle.js 获取。`, 'error');
    }
  };

  const handleGenerateMasterKey = async () => {
    const key = ActiveMsgClient.generateMasterKey();
    setGeneratedMasterKey(key);
    try {
      await navigator.clipboard.writeText(key);
      addToast('已生成并复制，粘进 Worker 环境变量 AMSG_MASTER_KEY。', 'success');
    } catch {
      addToast('已生成，请手动从下方复制。', 'info');
    }
  };

  const handleClearClientState = async () => {
    if (!confirm('确定清空云端状态？Worker D1 里同步的角色上下文（fire_pack）会全部删除。已排程任务不受影响——到点会退回使用排程时冻结的提示词，下次聊天后会重新同步。')) return;
    setLoading(true);
    try {
      const { deleted } = await ActiveMsgClient.clearClientState();
      addToast(`已清空云端状态（${deleted} 条）。`, 'success');
    } catch (error: any) {
      addToast(error?.message || '清除云端状态失败。', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleGenerateServerToken = () => {
    patchConfig({ serverToken: generateClientToken() });
    addToast('已生成共享密钥，记得把同样的值填进 Worker 环境变量 AMSG_SERVER_TOKEN。', 'info');
  };

  if (!config) return null;

  const isConnected = Boolean(config.initializedAt);

  return (
    <Modal
      isOpen={isOpen}
      title="主动消息 2.0"
      onClose={onClose}
      footer={(
        <button
          onClick={onClose}
          className="flex-1 py-3 bg-slate-100 text-slate-500 font-bold rounded-2xl active:scale-95 transition-transform"
        >
          关闭
        </button>
      )}
    >
      <div className="space-y-4 text-sm text-slate-600">
        <div className="bg-violet-50 border border-violet-100 rounded-2xl p-4 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <span className="font-bold text-slate-700">连接方式</span>
            <span className="px-3 py-1 rounded-full bg-violet-500 text-white text-xs font-bold">自部署 Worker</span>
          </div>
          <p className="text-xs leading-relaxed text-violet-700">
            角色到点自动给你发消息，App 关着也能收。你自己部署一个 Cloudflare Worker（自带 D1 数据库 + 定时触发），把地址填在下面即可。
          </p>
          <p className="text-[11px] leading-relaxed text-violet-600/80">
            和「Instant Push」不同：Instant 是你发消息才即时回；这个是到点主动推。
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-4 space-y-3">
          <button
            type="button"
            onClick={() => setDeployOpen((prev) => !prev)}
            className="w-full flex items-center justify-between text-left"
          >
            <span className="font-bold text-slate-700">部署 Worker（第一次用先做这个）</span>
            <span className="text-xs font-bold text-slate-400">{deployOpen ? '收起' : '展开'}</span>
          </button>

          {deployOpen ? (
            <div className="space-y-3">
              <ol className="text-xs leading-relaxed text-slate-500 space-y-1.5 list-decimal list-outside pl-4">
                <li>
                  点下面「复制 Worker 代码」，去 CF 后台 Create → Worker 建一个空 Worker，
                  进 <strong>Edit code</strong> 全选粘贴覆盖，点 Deploy。全程不用命令行。
                </li>
                <li>
                  Worker 的 Settings → Bindings 加一个 <strong>D1 database</strong>，
                  变量名必须是 <code className="font-mono">DB</code>。库没有就现场新建一个空库；
                  表不用建，下面点「连接」时会自动建好。
                </li>
                <li>
                  Settings → Trigger Events 加 <strong>Cron Trigger</strong>：
                  <code className="font-mono"> * * * * * </code>（每分钟检查一次到点任务）。
                </li>
                <li>Settings → Variables and Secrets 按下面的清单填环境变量，然后重新 Deploy 一次。</li>
              </ol>

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => void handleCopyWorkerBundle()}
                  className="py-2.5 rounded-xl text-xs font-bold bg-violet-500 text-white active:scale-95 transition-transform"
                >
                  复制 Worker 代码
                </button>
                <a
                  href={buildCloudflareDashboardUrl(config.workerUrl.trim() || undefined)}
                  target="_blank"
                  rel="noreferrer"
                  className="py-2.5 rounded-xl text-xs font-bold bg-white border border-slate-200 text-slate-600 text-center active:scale-95 transition-transform"
                >
                  ↗ CF Dashboard
                </a>
              </div>

              <div className="bg-slate-50 border border-slate-200 rounded-2xl p-3 space-y-2.5 text-xs">
                <p className="font-bold text-slate-700">环境变量清单</p>

                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <code className="font-mono text-[11px] text-slate-600">AMSG_MASTER_KEY</code>
                    <button
                      type="button"
                      onClick={() => void handleGenerateMasterKey()}
                      className="shrink-0 px-3 py-1.5 text-[11px] rounded-xl font-bold bg-white border border-slate-200 text-slate-600 active:scale-95 transition-transform"
                    >
                      生成并复制
                    </button>
                  </div>
                  {generatedMasterKey ? (
                    <p className="font-mono text-[10px] leading-relaxed text-slate-500 break-all bg-white border border-slate-200 rounded-xl px-2 py-1.5">
                      {generatedMasterKey}
                    </p>
                  ) : (
                    <p className="text-[11px] text-slate-400">加密任务内容用的密钥，只存在 Worker 侧。生成后粘进去即可，本页不保存。</p>
                  )}
                </div>

                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <code className="font-mono text-[11px] text-slate-600">VAPID_EMAIL / PUBLIC_KEY / PRIVATE_KEY</code>
                    {onOpenVapid ? (
                      <button
                        type="button"
                        onClick={onOpenVapid}
                        className="shrink-0 px-3 py-1.5 text-[11px] rounded-xl font-bold bg-white border border-slate-200 text-slate-600 active:scale-95 transition-transform"
                      >
                        去推送凭据面板
                      </button>
                    ) : null}
                  </div>
                  <p className="text-[11px] text-slate-400">
                    必须和「推送凭据 (VAPID)」面板里的是<strong>同一对</strong>（和 Instant Push 共用）——
                    整个站点只有一个浏览器推送订阅，Worker 用别的密钥对签推送会 403。
                  </p>
                </div>

                <div className="space-y-1">
                  <code className="font-mono text-[11px] text-slate-600">AMSG_SERVER_TOKEN（可选）</code>
                  <p className="text-[11px] text-slate-400">
                    防止别人滥用你的 Worker。值 = 下面「共享密钥」填的那串，两边一致即可；不配则端点全开。
                  </p>
                </div>
              </div>
            </div>
          ) : null}
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <span className="font-bold text-slate-700">当前状态</span>
            <span className={`text-xs font-bold ${isConnected ? 'text-emerald-600' : 'text-amber-600'}`}>
              {isConnected ? '已连接' : '未连接'}
            </span>
          </div>

          {workerOutdated ? (
            <div className="bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3 text-xs leading-relaxed text-amber-700">
              Worker 上跑的还是旧版代码，缺少新特性（大上下文云端存储、服务端工具循环等）。
              去下方「部署 Worker」重新「复制 Worker 代码」，到 CF 后台粘贴覆盖并 Deploy 即可，已有数据和任务不受影响。
            </div>
          ) : null}

          <div>
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">
              Worker 地址
            </label>
            <input
              type="text"
              value={config.workerUrl}
              onChange={(event) => patchConfig({ workerUrl: event.target.value })}
              placeholder="https://amsg.你的账号.workers.dev"
              className="w-full bg-white/70 border border-slate-200 rounded-2xl px-4 py-3 text-xs font-mono"
            />
          </div>

          <div>
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">
              共享密钥（可选）
            </label>
            <div className="flex gap-2">
              <input
                type="password"
                value={config.serverToken || ''}
                onChange={(event) => patchConfig({ serverToken: event.target.value })}
                placeholder="worker 配了 AMSG_SERVER_TOKEN 才需要填"
                className="flex-1 bg-white/70 border border-slate-200 rounded-2xl px-4 py-3 text-sm"
              />
              <button
                type="button"
                onClick={handleGenerateServerToken}
                className="shrink-0 px-3 py-3 text-xs rounded-2xl font-bold bg-white border border-slate-200 text-slate-600 active:scale-95 transition-transform"
              >
                随机
              </button>
            </div>
          </div>

          <button
            onClick={handleConnect}
            disabled={loading}
            className="w-full py-3 bg-slate-900 text-white font-bold rounded-2xl active:scale-95 transition-transform disabled:opacity-50"
          >
            {loading ? '处理中...' : isConnected ? '重新连接并验证' : '连接并启用'}
          </button>

          <p className="text-xs leading-relaxed text-slate-500">
            「连接」会自动在你的 D1 里把表建好（幂等，重复点没关系），不用手动执行 SQL。
          </p>
        </div>

        <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <span className="font-bold text-slate-700">通知权限</span>
            <span className={`text-xs font-bold ${pushStatus?.hasSubscription ? 'text-emerald-600' : 'text-amber-600'}`}>
              {pushStatus?.hasSubscription ? '已开启' : '未开启'}
            </span>
          </div>
          <p className="text-xs leading-relaxed text-slate-500">
            这是第二步。只有你真的想让角色在后台主动推送消息时，才需要点。
          </p>
          {pushStatus?.detail ? (
            <p className="text-xs leading-relaxed text-amber-600">{pushStatus.detail}</p>
          ) : null}
          <button
            onClick={handleCreateSubscription}
            disabled={loading}
            className="w-full py-3 bg-violet-500 text-white font-bold rounded-2xl active:scale-95 transition-transform disabled:opacity-50"
          >
            {loading ? '处理中...' : '开启通知与推送'}
          </button>
        </div>

        <div className="bg-amber-50 border border-amber-100 rounded-2xl p-4 text-xs leading-relaxed text-amber-700 space-y-2">
          <div className="font-bold text-amber-800">风险说明</div>
          <p>开了 2.0 以后，主动消息内容、提示词、相关配置，都会进入你自己部署的 Worker 及其 D1 数据库。</p>
          <p>这是你自己的 Worker、你自己的库，项目不会额外接一个中心服务器。但只要数据进库，能碰到这台 Worker / 数据库的人（也就是你自己）就能看到这些内容。</p>
          <p>如果你不接受把私密提示词、API Key 放进自己部署的服务，就不要开 2.0。</p>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-4 space-y-3">
          <button
            type="button"
            onClick={() => setAdvancedOpen((prev) => !prev)}
            className="w-full flex items-center justify-between text-left"
          >
            <span className="font-bold text-slate-700">高级信息</span>
            <span className="text-xs font-bold text-slate-400">{advancedOpen ? '收起' : '展开'}</span>
          </button>

          {advancedOpen ? (
            <div className="space-y-3 text-xs">
              <div className="bg-violet-50 border border-violet-100 rounded-2xl p-3 space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-semibold text-slate-700">X-User-Id</span>
                  <span className="font-mono text-violet-600">{maskActiveMsgUserId(config.userId)}</span>
                </div>
              </div>
              <p className="text-[11px] leading-relaxed text-slate-500">
                Worker 侧的环境变量清单见上面「部署 Worker」一节。站点发布的 Worker 代码默认 CORS 全开
                （<code className="font-mono">origin: '*'</code>），想收紧就在粘贴前把它改成自己站点的域名。
              </p>
              <div className="bg-rose-50 border border-rose-100 rounded-2xl p-3 space-y-2">
                <div className="font-semibold text-rose-700">清除云端状态</div>
                <p className="text-[11px] leading-relaxed text-rose-600">
                  删除 Worker D1 里同步的角色上下文（角色卡、最近聊天窗口等）。已排程任务不受影响，
                  到点退回排程时冻结的提示词；下次聊天后会自动重新同步。
                </p>
                <button
                  onClick={() => void handleClearClientState()}
                  disabled={loading}
                  className="w-full py-2.5 bg-rose-500 text-white font-bold rounded-2xl active:scale-95 transition-transform disabled:opacity-50"
                >
                  {loading ? '处理中...' : '清除云端状态'}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </Modal>
  );
};

export default React.memo(ActiveMsgGlobalSettingsModal);
