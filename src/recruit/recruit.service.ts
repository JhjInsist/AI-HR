import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { FeishuService } from '../feishu/feishu.service';
import { MiaohuiService } from '../miaohui/miaohui.service';
import { ContactService } from './contact.service';
import { ConfigService } from '../config/config.service';

/** 多维表格 cell → 纯文本（确定性，无推断） */
function cellText(v: any): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === 'object' ? x.text ?? x.name ?? x.en_name ?? '' : String(x))).join('');
  if (typeof v === 'object') return v.text ?? v.name ?? '';
  return String(v);
}

const HELLO_DEFAULT = '你好，我是句子互动招聘助理，看到你投递的岗位，想跟你约一次面试~';

@Injectable()
export class RecruitService {
  private readonly logger = new Logger(RecruitService.name);
  private readonly statePath = path.join(process.cwd(), 'state', 'recruit-state.json');

  private get dry() { return this.config.getBool('DRY_RUN', true); }
  private get AIHR_APP() { return this.config.get('AIHR_APP_TOKEN'); }
  private get AIHR_TBL() { return this.config.get('AIHR_TABLE_ID'); }
  private get PROG_APP() { return this.config.get('PROG_APP_TOKEN'); }
  private get PROG_TBL() { return this.config.get('PROG_TABLE_ID'); }
  private get HELLO() { return this.config.get('HELLO_MSG', HELLO_DEFAULT); }

  constructor(
    private readonly feishu: FeishuService,
    private readonly miaohui: MiaohuiService,
    private readonly contact: ContactService,
    private readonly config: ConfigService,
  ) {}

  private loadState(): { copied: Record<string, string>; reached: Record<string, any>; notified: Record<string, boolean> } {
    try {
      const s = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      return { copied: s.copied || {}, reached: s.reached || {}, notified: s.notified || {} };
    } catch { return { copied: {}, reached: {}, notified: {} }; }
  }
  private saveState(s: any) {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    fs.writeFileSync(this.statePath, JSON.stringify(s, null, 1));
  }

  /** 规则①：AI HR招聘表【HR评估=约面】→ 写入招聘进度管理表 */
  async rule1_intakeToProgress() {
    const st = this.loadState();
    const rows = await this.feishu.listRecords(this.AIHR_APP, this.AIHR_TBL);
    const todo = rows.filter((r) => cellText(r.fields['HR评估']) === '约面' && !st.copied[this.keyOf(r)]);
    this.logger.log(`[规则①] 约面待处理 ${todo.length} 人 (dry=${this.dry})`);
    for (const r of todo) {
      const name = cellText(r.fields['姓名']);
      const info = await this.contact.extract(
        cellText(r.fields['联系方式']), this.AIHR_APP, this.AIHR_TBL, r.record_id,
      );
      const phone = info.phone || info.wechat || '';
      const fields: Record<string, any> = {
        '姓名': name,
        '岗位': cellText(r.fields['岗位']),
        '渠道': cellText(r.fields['简历来源']),
        '面试评价': cellText(r.fields['面评']),
        '联系方式': phone,
        '备忘录': `从AI HR表约面带入 · 联系方式=${phone || '⚠️未找到，需人工'}(${info.source})`,
      };
      this.logger.log(`  · ${name} 联系方式=${phone || '未找到'}(${info.source}) → 进度表`);
      if (!this.dry) {
        const res = await this.feishu.createRecord(this.PROG_APP, this.PROG_TBL, fields);
        st.copied[this.keyOf(r)] = res?.record?.record_id || '1';
        this.saveState(st);
      }
    }
  }

  /** 规则②：进度表【一面时间】+【一面面试官】都非空 → 招聘企微加好友触达 + 写备忘录。
   *  opts.live=true 时本次强制真跑（覆盖全局 DRY_RUN，供手动运维接口小范围验证）。 */
  async rule2_reachOut(opts?: { live?: boolean; onlyName?: string }) {
    const live = opts?.live ?? !this.dry;
    const dry = !live;
    const st = this.loadState();
    const rows = await this.feishu.listRecords(this.PROG_APP, this.PROG_TBL);
    const filled = (r: any, f: string) => !!cellText(r.fields[f]).trim();
    let todo = rows.filter((r) => filled(r, '一面时间') && filled(r, '一面面试官') && !st.reached[r.record_id]);
    if (opts?.onlyName) todo = todo.filter((r) => cellText(r.fields['姓名']) === opts.onlyName);
    this.logger.log(`[规则②] 面试信息就绪待触达 ${todo.length} 人 (dry=${dry}${opts?.onlyName ? ` onlyName=${opts.onlyName}` : ''})`);
    const results: any[] = [];
    for (const r of todo) {
      const name = cellText(r.fields['姓名']);
      let phone = cellText(r.fields['联系方式']).trim();
      if (!phone) {
        const info = await this.contact.extract('', this.PROG_APP, this.PROG_TBL, r.record_id);
        phone = info.phone || info.wechat || '';
      }
      const prev = cellText(r.fields['备忘录']);
      if (!phone) {
        // 无联系方式：只提醒一次 HR 补录，不锁定 reached——HR 在表格补上微信后，下一轮会自动触达
        const note = '⚠️暂无联系方式，请HR在【联系方式】填微信/手机号，补上后助手自动触达（勿漏，避免流失）';
        this.logger.warn(`  · ${name} 无联系方式，${st.notified[r.record_id] ? '已提醒过' : '提醒HR补录'}`);
        results.push({ name, phone: '', ok: false, note: '待HR补联系方式' });
        if (!dry && !st.notified[r.record_id]) {
          await this.feishu.updateRecord(this.PROG_APP, this.PROG_TBL, r.record_id, { '备忘录': `${prev} | ${note}`.slice(0, 900) });
          st.notified[r.record_id] = true; this.saveState(st);
        }
        continue;
      }
      this.logger.log(`  · ${name} 招聘企微加好友 ${phone} (dry=${dry})`);
      if (!dry) {
        const res = await this.miaohui.addFriendByPhone(phone, this.HELLO);
        const note = `[助手 触达] 加好友 ${phone}：${res.ok ? '✓已发起，等对方通过' : '✕失败 code=' + res.code}`;
        await this.feishu.updateRecord(this.PROG_APP, this.PROG_TBL, r.record_id, { '备忘录': `${prev} | ${note}`.slice(0, 900) });
        st.reached[r.record_id] = { ok: res.ok, code: res.code }; this.saveState(st);
        results.push({ name, phone, ok: res.ok, code: res.code });
      } else {
        results.push({ name, phone, dry: true });
      }
    }
    return { todo: todo.length, dry, results };
  }

  private keyOf(r: any): string {
    return cellText(r.fields['AIHR候选人ID']) || r.record_id;
  }
}
