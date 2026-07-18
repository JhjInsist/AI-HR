import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as fs from 'fs';
import * as path from 'path';
import { AppConfigItem, AppConfigDocument } from './config.schema';

/**
 * 运行时配置：持久化到 MongoDB（app_config），启动载入内存缓存。
 * get() 保持同步（读缓存），让表格/Agent/触达/秒回等参数可在配置台热改，不用重新部署。
 * 覆盖优先级：Mongo(缓存) > 环境变量 > 默认值。
 */
@Injectable()
export class ConfigService implements OnModuleInit {
  private readonly logger = new Logger(ConfigService.name);
  private readonly legacyFile = path.join(process.cwd(), 'data', 'config.json');
  private cache: Record<string, string> = {};

  /** 配置台可编辑的键 */
  static readonly KEYS = [
    'AIHR_APP_TOKEN', 'AIHR_TABLE_ID', 'PROG_APP_TOKEN', 'PROG_TABLE_ID',
    'INTENT_BOT_ID', 'CHAT_BOT_ID', 'MODEL',
    'DRY_RUN', 'INTERVIEW_LINK', 'HELLO_MSG', 'POLL_INTERVAL_SEC',
    'MIAOHUI_GROUP_TOKEN', 'MIAOHUI_CORP_ID', 'MIAOHUI_BOT_USERID', 'FEISHU_BOT_NAME',
    'HR_NOTIFY_CHAT', 'HR_EMAIL',
  ];

  constructor(
    @InjectModel(AppConfigItem.name) private readonly model: Model<AppConfigDocument>,
  ) {}

  async onModuleInit() {
    await this.reload();
    // 首启迁移：Mongo 为空且存在旧 data/config.json → 导入一次，避免丢失既有配置
    if (Object.keys(this.cache).length === 0 && fs.existsSync(this.legacyFile)) {
      try {
        const legacy = JSON.parse(fs.readFileSync(this.legacyFile, 'utf8'));
        const patch: Record<string, string> = {};
        for (const k of ConfigService.KEYS) {
          if (legacy[k] != null && legacy[k] !== '') patch[k] = String(legacy[k]);
        }
        if (Object.keys(patch).length) {
          await this.save(patch);
          this.logger.log(`已从 config.json 迁移 ${Object.keys(patch).length} 项配置到 MongoDB`);
        }
      } catch (e: any) {
        this.logger.warn(`迁移 config.json 失败: ${e?.message}`);
      }
    }
  }

  /** 从 Mongo 重载缓存 */
  private async reload() {
    try {
      const docs = await this.model.find().exec();
      const c: Record<string, string> = {};
      for (const d of docs) c[d.key] = d.value;
      this.cache = c;
    } catch (e: any) {
      this.logger.error(`加载配置失败（暂用环境变量兜底）: ${e?.message}`);
    }
  }

  /** 运行时取值（同步读缓存）：Mongo 覆盖优先，回退环境变量 */
  get(key: string, dflt = ''): string {
    const v = this.cache[key];
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

  /** 保存部分配置（只接受白名单键）：写 Mongo + 更新缓存，返回合并后的全量 */
  async save(patch: Record<string, any>): Promise<Record<string, string>> {
    const ops: Promise<any>[] = [];
    const saved: string[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (!ConfigService.KEYS.includes(k)) continue;
      const val = v == null ? '' : String(v);
      this.cache[k] = val;
      saved.push(k);
      ops.push(this.model.updateOne({ key: k }, { $set: { value: val } }, { upsert: true }).exec());
    }
    await Promise.all(ops);
    this.logger.log(`配置已保存: ${saved.join(', ')}`);
    return this.all();
  }
}
