import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('静态陪伴与视频快照 Umami 埋点', () => {
  const appearance = readFileSync(path.resolve(__dirname, '../apps/Appearance.tsx'), 'utf8');
  const companion = readFileSync(path.resolve(__dirname, '../components/os/CompanionHome.tsx'), 'utf8');
  const call = readFileSync(path.resolve(__dirname, '../apps/CallApp.tsx'), 'utf8');

  it('覆盖静态形象和桌面触碰功能', () => {
    for (const eventName of [
      '切换桌面陪伴形象来源',
      '导入桌面静态形象',
      '切换桌面见面立绘衣服',
      '移除桌面静态形象',
    ]) {
      expect(appearance).toContain(`trackEvent('${eventName}'`);
    }
    expect(companion).toContain("trackEvent('生成桌面触碰反馈'");
    expect(companion).toContain("trackEvent('切换桌面见面立绘衣服'");
  });

  it('覆盖快照选择、留存和通话结束', () => {
    for (const eventName of [
      '选择用户摄像头模式',
      '保存视频通话单帧快照',
      '淘汰旧视频通话快照',
      '结束一通通话',
    ]) {
      expect(call).toContain(`trackEvent('${eventName}'`);
    }
  });

  it('埋点参数不包含文本、角色名、文件名或 Blob 引用', () => {
    const analyticsLines = [appearance, companion, call]
      .flatMap(source => source.split('\n'))
      .filter(line => line.includes('trackEvent(') || line.includes('来源:') || line.includes('形象:') || line.includes('模式:'));
    const payload = analyticsLines.join('\n');
    expect(payload).not.toMatch(/character\.name|selectedChar\.name|file\.name|imageRef|snapshot\.ref|\binput\b|assistantText/);
  });
});
