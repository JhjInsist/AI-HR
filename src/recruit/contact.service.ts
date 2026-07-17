import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FeishuService } from '../feishu/feishu.service';

const execFileP = promisify(execFile);

/**
 * 从简历里取联系方式——确定性优先，最大程度避免幻觉：
 *  1) 优先用表【联系方式】字段（若有）
 *  2) 简历为文本 PDF：pdftotext 抽取
 *  3) 简历为图片 PDF(BOSS常见)：pdftoppm + tesseract OCR（识别，非生成）
 *  4) 一律用正则 `1[3-9]\d{9}` 校验；匹配不到就返回空 → 上层标「需人工」，绝不编造号码
 */
@Injectable()
export class ContactService {
  private readonly logger = new Logger(ContactService.name);
  private readonly PHONE = /(?<!\d)(1[3-9]\d{9})(?!\d)/;
  private readonly WECHAT = /(?:微信|wechat|weixin|微信号)[:：\s]*([A-Za-z][-_A-Za-z0-9]{5,19})/i;

  constructor(private readonly feishu: FeishuService) {}

  /** 返回 {phone?, wechat?, source} ；都取不到返回 {source:'none'} */
  async extract(fieldValue: string, appToken: string, tableId: string, recordId: string, resumeField = '简历'): Promise<{ phone?: string; wechat?: string; source: string }> {
    const fv = (fieldValue || '').trim();
    const mPhone = fv.match(this.PHONE);
    if (mPhone) return { phone: mPhone[1], source: 'field' };
    if (fv && /^[A-Za-z][-_A-Za-z0-9]{5,19}$/.test(fv)) return { wechat: fv, source: 'field' };

    // 简历文件抽取
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-'));
    try {
      const files = await this.feishu.downloadAttachments(appToken, tableId, recordId, resumeField, dir);
      const pdf = files.find((f) => f.toLowerCase().endsWith('.pdf')) || files[0];
      if (!pdf) return { source: 'none' };
      const text = await this.pdfText(pdf);
      const p = text.match(this.PHONE);
      if (p) return { phone: p[1], source: 'resume-ocr' };
      const w = text.match(this.WECHAT);
      if (w) return { wechat: w[1], source: 'resume-ocr' };
      return { source: 'resume-unreadable' };
    } catch (e: any) {
      this.logger.warn(`简历抽取失败 ${recordId}: ${e?.message}`);
      return { source: 'error' };
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }

  private async pdfText(pdf: string): Promise<string> {
    // 文本层
    try {
      const { stdout } = await execFileP('pdftotext', ['-layout', pdf, '-'], { timeout: 60000 });
      if (stdout && stdout.trim().length > 20) return stdout;
    } catch {}
    // 图片型 → OCR
    try {
      const outBase = pdf + '.pg';
      await execFileP('pdftoppm', ['-png', '-r', '200', pdf, outBase], { timeout: 120000 });
      const dir = path.dirname(pdf);
      const pngs = fs.readdirSync(dir).filter((f) => f.startsWith(path.basename(outBase))).slice(0, 3);
      let all = '';
      for (const png of pngs) {
        const { stdout } = await execFileP('tesseract', [path.join(dir, png), '-', '-l', 'chi_sim+eng'], { timeout: 120000 });
        all += '\n' + stdout;
      }
      return all;
    } catch {
      return '';
    }
  }
}
