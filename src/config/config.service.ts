import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 运行时配置：config.json（持久化到挂载卷）覆盖优先，回退环境变量。
 * 让表格/Agent/触达/秒回等参数可在配置台热改，不用重新部署。
 */
@Injectable()
export class ConfigService {
  private readonly logger = new Logger(ConfigService.name);
  private readonly file = path.join(process.cwd(), 'data', 'config.json');

  /** 配置台可编辑的键（附默认来源说明用于展示） */
  static readonly KEYS = [
    'AIHR_APP_TOKEN', 'AIHR_TABLE_ID', 'PROG_APP_TOKEN', 'PROG_TABLE_ID',
    'INTENT_BOT_ID', 'CHAT_BOT_ID', 'MODEL',
    'DRY_RUN', 'INTERVIEW_LINK', 'HELLO_MSG', 'POLL_INTERVAL_SEC',
    'MIAOHUI_GROUP_TOKEN', 'MIAOHUI_CORP_ID', 'MIAOHUI_BOT_USERID', 'FEISHU_BOT_NAME',
    'HR_NOTIFY_CHAT', 'HR_EMAIL',
  ];

  private read(): Record<string, string> {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return {}; }
  }

  /** 运行时取值：config.json 覆盖优先，回退环境变量 */
  get(key: string, dflt = ''): string {
    const v = this.read()[key];
    if (v !== undefined && v !== '') return String(v);
    return process.env[key] ?? dflt;
  }

  getBool(key: string, dflt: boolean): boolean {
    const v = this.get(key, dflt ? 'true' : 'false');
    return v === 'true' || v === '1';
  }

  getNum(key: string, dflt: number): number {
    const n = parseInt(this.get(key, String(dflt)), 10);
    return isNaN(n) ? dflt : n;
  }

  /** 全部可编辑键的当前生效值（供配置台展示） */
  all(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const k of ConfigService.KEYS) out[k] = this.get(k);
    return out;
  }

  /** 保存部分配置（只接受白名单键），返回合并后的全量 */
  save(patch: Record<string, any>): Record<string, string> {
    const cur = this.read();
    for (const [k, v] of Object.entries(patch)) {
      if (ConfigService.KEYS.includes(k)) cur[k] = v == null ? '' : String(v);
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(cur, null, 2));
    this.logger.log(`配置已保存: ${Object.keys(patch).filter((k) => ConfigService.KEYS.includes(k)).join(', ')}`);
    return this.all();
  }
}
