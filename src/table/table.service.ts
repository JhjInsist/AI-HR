import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { ConfigService } from '../config/config.service';

/**
 * 表格服务 client。触达服务去表格化后，一切「回填进度 / 标记转人工」都调表格服务接口，
 * 触达服务本身不再直接读写飞书多维表格。TABLE_SERVICE_URL 未配置时只记日志（不阻断）。
 */
@Injectable()
export class TableService {
  private readonly logger = new Logger(TableService.name);
  constructor(private readonly config: ConfigService) {}

  private base(): string {
    return (this.config.get('TABLE_SERVICE_URL') || process.env.TABLE_SERVICE_URL || '').replace(/\/$/, '');
  }

  /** 回填进度/备忘录 → 表格服务 POST /progress/backfill */
  async backfill(p: {
    dataId?: string; phone: string; event: string; note: string;
    status?: string; interviewTime?: string; meetingLink?: string; expectTime?: string; round?: string;
  }): Promise<{ ok: boolean }> {
    const base = this.base();
    if (!base) { this.logger.log(`[表格服务未配置] backfill ${p.phone} [${p.event}] ${p.note}`); return { ok: false }; }
    try {
      const { data } = await axios.post(`${base}/progress/backfill`, p, { timeout: 30000 });
      return { ok: data?.ok !== false };
    } catch (e: any) {
      this.logger.error(`回填表格服务失败 ${p.phone}: ${e?.message}`);
      return { ok: false };
    }
  }

  /** 转人工 → 表格服务 POST /progress/handover（表格服务把进度表「转人工」置为「是」） */
  async handover(p: {
    dataId?: string; phone: string; reason: string; reasonText: string; candidateReply?: string;
  }): Promise<{ ok: boolean }> {
    const base = this.base();
    if (!base) { this.logger.log(`[表格服务未配置] handover ${p.phone} [${p.reason}] ${p.reasonText}`); return { ok: false }; }
    try {
      const { data } = await axios.post(`${base}/progress/handover`, p, { timeout: 30000 });
      return { ok: data?.ok !== false };
    } catch (e: any) {
      this.logger.error(`转人工通知表格服务失败 ${p.phone}: ${e?.message}`);
      return { ok: false };
    }
  }
}
