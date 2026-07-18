import { Controller, Get, Post, Body, Res, UseInterceptors, UploadedFile } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import * as XLSX from 'xlsx';
import { ConfigService } from '../config/config.service';
import { InsightAdminService, MODEL_GROUPS } from './insight-admin.service';
import { HrService } from '../hr/hr.service';
import { ADMIN_HTML } from './admin.page';

/**
 * 配置台：可视化配置表格/Agent/触达/秒回 + 面试官 HR 名录，无需重新部署。
 * 暂不鉴权（内部用），后续接飞书登录。
 */
@Controller('admin')
export class AdminController {
  constructor(
    private readonly config: ConfigService,
    private readonly insight: InsightAdminService,
    private readonly hr: HrService,
  ) {}

  @Get()
  page(@Res() res: Response) {
    // 禁用缓存：配置台页面随代码迭代，避免浏览器用旧 JS（曾导致相对 fetch 路径 bug 复现）
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.type('html').send(ADMIN_HTML);
  }

  @Get('config')
  getConfig() {
    return { config: this.config.all(), models: MODEL_GROUPS };
  }

  @Post('config')
  async save(@Body() body: Record<string, any>) {
    return { ok: true, config: await this.config.save(body || {}) };
  }

  /** 上传 Excel 导入知识库：第一列=问、第二列=答，自动跳表头，存入 KNOWLEDGE_BASE */
  @Post('knowledge/upload')
  @UseInterceptors(FileInterceptor('file'))
  async uploadKnowledge(@UploadedFile() file: any) {
    if (!file?.buffer) return { ok: false, msg: '没有收到文件' };
    try {
      const wb = XLSX.read(file.buffer, { type: 'buffer' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
      const qa: string[] = [];
      for (const r of rows) {
        const q = String(r?.[0] ?? '').trim();
        const a = String(r?.[1] ?? '').trim();
        if (!q || !a) continue;
        if (/^(问题?|question)$/i.test(q) && /^(答案?|回答|answer)$/i.test(a)) continue; // 跳表头
        qa.push(`Q：${q}\nA：${a}`);
      }
      if (!qa.length) return { ok: false, msg: '没解析到问答（确认第一列是问、第二列是答）' };
      const kb = qa.join('\n');
      await this.config.save({ KNOWLEDGE_BASE: kb });
      return { ok: true, count: qa.length, kb };
    } catch (e: any) {
      return { ok: false, msg: `解析失败：${e?.message}` };
    }
  }

  // ── 面试官 HR 名录：姓名 ↔ 飞书邮箱，约面按面试官选人建日程 ──
  @Get('hr')
  listHr() {
    return this.hr.list();
  }

  @Post('hr')
  async saveHr(@Body() body: { name?: string; email?: string; openId?: string; note?: string }) {
    try {
      return { ok: true, list: await this.hr.upsert(body || {}) };
    } catch (e: any) {
      return { ok: false, msg: e?.message || '保存失败' };
    }
  }

  @Post('hr/delete')
  async deleteHr(@Body() body: { name?: string }) {
    return { ok: true, list: await this.hr.remove(body?.name || '') };
  }

  /** 切换 Agent 模型：重建意图+对话两个秒懂画布 */
  @Post('model')
  async setModel(@Body() body: { model?: string }) {
    if (!body?.model) return { ok: false, msg: '缺 model' };
    try {
      const r = await this.insight.setModel(body.model);
      return { ok: true, msg: `已切换到 ${body.model}`, ...r };
    } catch (e: any) {
      return { ok: false, msg: e?.message || '切换失败' };
    }
  }
}
