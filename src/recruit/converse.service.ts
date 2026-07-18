import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../llm/llm.service';
import { extractTime } from '../miaodong/miaodong.service';
import { FeishuService } from '../feishu/feishu.service';
import { ConfigService } from '../config/config.service';

function cellText(v: any): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === 'object' ? x.text ?? x.name ?? '' : String(x))).join('');
  if (typeof v === 'object') return v.text ?? v.name ?? '';
  return String(v);
}

export interface ConverseResult {
  intent: string;        // TIME / RESCHEDULE / REJECT / QUESTION / OTHER
  time?: string;         // 从原文确定性抽取的时间
  reply: string;         // 要发回给候选人的话（固定模板 or 知识库应答）
  note: string;          // 要写进进度表备忘录的痕迹
  action: 'confirm' | 'ask_time' | 'close' | 'answer' | 'fallback';
}

/**
 * 触达对话编排（秒聘服务的确定性大脑）。
 * 候选人回复 → 大模型意图分类 → 死规则路由 → 固定模板 or 知识库应答。
 * 模型只碰两件事：意图分类、知识库问答。路由/时间抽取/写表全是代码，杜绝幻觉。
 * （已从秒懂画布切换为直连大模型 LlmService。）
 */
@Injectable()
export class ConverseService {
  private readonly logger = new Logger(ConverseService.name);
  private get dry() { return this.config.getBool('DRY_RUN', true); }
  private get PROG_APP() { return this.config.get('PROG_APP_TOKEN'); }
  private get PROG_TBL() { return this.config.get('PROG_TABLE_ID'); }
  private get LINK() { return this.config.get('INTERVIEW_LINK'); }

  constructor(
    private readonly llm: LlmService,
    private readonly feishu: FeishuService,
    private readonly config: ConfigService,
  ) {}

  /** 处理候选人一条回复。candidate 传姓名可写回进度表；不传则只返回话术不落库。 */
  async handle(text: string, candidate?: string): Promise<ConverseResult> {
    const type = await this.llm.classifyIntent(text);
    const value = extractTime(text);
    const linkLine = this.LINK ? `\n面试链接：${this.LINK}` : '';
    let res: ConverseResult;

    switch (type) {
      case 'TIME':
        if (value) {
          res = {
            intent: type, time: value, action: 'confirm',
            reply: `好的，那就约在【${value}】~ 面试是线上视频形式，到时我会把面试链接发给您，点开进入即可。${linkLine}\n如需调整时间随时跟我说~`,
            note: `候选人确认面试时间【${value}】${this.LINK ? '，已发面试链接' : '，待发面试链接'}`,
          };
        } else {
          res = {
            intent: type, action: 'ask_time',
            reply: '好呀~ 您方便哪天、上午还是下午呢？把具体时间告诉我，我这就帮您和面试官约上。',
            note: '候选人想约面试，待其提供具体时间',
          };
        }
        break;
      case 'RESCHEDULE':
        res = {
          intent: type, action: 'ask_time',
          reply: '没问题~ 您方便的时间段是？告诉我大致的日期和上午/下午，我帮您协调面试官时间。',
          note: '候选人想改期，待HR协调新时间',
        };
        break;
      case 'REJECT':
        res = {
          intent: type, action: 'close',
          reply: '好的，完全理解~ 感谢您的关注，后续如果有更合适的机会，我再和您联系。祝一切顺利！',
          note: '候选人婉拒，本次流程关闭',
        };
        break;
      case 'QUESTION': {
        const answer = await this.llm.answer(text);
        res = { intent: type, action: 'answer', reply: answer, note: `候选人提问：${text.slice(0, 30)}` };
        break;
      }
      default: {
        const answer = await this.llm.answer(text);
        res = { intent: 'OTHER', action: 'fallback', reply: answer, note: '' };
      }
    }

    if (candidate) await this.writeNote(candidate, res);
    return res;
  }

  /** 把进展确定性追加到进度表备忘录 */
  private async writeNote(candidate: string, res: ConverseResult) {
    if (!res.note) return;
    if (this.dry) { this.logger.log(`[DRY] ${candidate} 备忘录 += ${res.note}`); return; }
    try {
      const rows = await this.feishu.listRecords(this.PROG_APP, this.PROG_TBL);
      const rec = rows.find((r) => cellText(r.fields['姓名']) === candidate);
      if (!rec) { this.logger.warn(`进度表未找到候选人 ${candidate}，跳过写备忘录`); return; }
      const prev = cellText(rec.fields['备忘录']);
      const stamp = new Date().toISOString().slice(5, 16).replace('T', ' ');
      const line = `[对话 ${stamp}] ${res.note}`;
      await this.feishu.updateRecord(this.PROG_APP, this.PROG_TBL, rec.record_id, {
        '备忘录': `${prev} | ${line}`.slice(0, 900),
      });
      this.logger.log(`${candidate} 备忘录已更新：${res.note}`);
    } catch (e: any) {
      this.logger.error(`写备忘录失败 ${candidate}: ${e?.message}`);
    }
  }
}
