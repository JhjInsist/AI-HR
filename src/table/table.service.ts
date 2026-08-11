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

  /** 只读接口的共享 token(表格服务 /candidate 要求 X-AIHR-Token)。 */
  private authHeaders(): Record<string, string> {
    const tok = this.config.get('AIHR_TABLE_TOKEN');
    return tok ? { 'X-AIHR-Token': tok } : {};
  }

  /**
   * 查候选人进度表字段(纯读)→ 表格服务 GET /candidate。
   * 供聚合聊天侧边栏卡片补充 mongo 里没有的字段(候选人身份/岗位大类/渠道/简历筛选/备忘录/简历附件)。
   * 读路径超时比写短(侧边栏是用户同步等待,表格服务无响应不能让卡片卡住);失败返回 null 不抛。
   */
  async getCandidate(p: { dataId?: string; phone?: string }): Promise<Record<string, any> | null> {
    const base = this.base();
    if (!base) { this.logger.log(`[表格服务未配置] getCandidate ${p.dataId || p.phone || ''}`); return null; }
    try {
      const { data } = await axios.get(`${base}/candidate`, {
        params: { dataId: p.dataId || '', phone: p.phone || '' },
        headers: this.authHeaders(),
        timeout: 5000,
      });
      return data?.found ? data : null;
    } catch (e: any) {
      this.logger.error(`查候选人字段失败 ${p.dataId || p.phone || ''}: ${e?.message}`);
      return null;
    }
  }

  /** 取简历附件原始字节 → 表格服务 GET /candidate/resume。失败返回 null 不抛。 */
  async getResume(p: { dataId?: string; phone?: string }): Promise<{ data: Buffer; name: string } | null> {
    const base = this.base();
    if (!base) { this.logger.log(`[表格服务未配置] getResume ${p.dataId || p.phone || ''}`); return null; }
    try {
      const res = await axios.get(`${base}/candidate/resume`, {
        params: { dataId: p.dataId || '', phone: p.phone || '' },
        headers: this.authHeaders(),
        timeout: 20000,           // 附件下载,比字段查询宽松
        responseType: 'arraybuffer',
      });
      const cd = String(res.headers?.['content-disposition'] || '');
      const m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
      return { data: Buffer.from(res.data), name: m ? decodeURIComponent(m[1]) : '简历.pdf' };
    } catch (e: any) {
      this.logger.error(`取简历附件失败 ${p.dataId || p.phone || ''}: ${e?.message}`);
      return null;
    }
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
