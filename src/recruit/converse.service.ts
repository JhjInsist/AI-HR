import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../llm/llm.service';
import { extractTime } from '../miaodong/miaodong.service';
import { ConfigService } from '../config/config.service';

export interface ConverseResult {
  intent: string;        // TIME / RESCHEDULE / REJECT / QUESTION / OTHER
  time?: string;         // 从原文确定性抽取的时间
  reply: string;         // 要发回给候选人的话（固定模板 or 知识库应答）
  note: string;          // 进展痕迹（回填交由触达服务调表格服务，不在此写表）
  action: 'confirm' | 'ask_time' | 'close' | 'answer' | 'fallback';
}

/**
 * 触达对话大脑（确定性）：候选人回复 → 大模型意图分类 → 死规则路由 → 固定模板 or 知识库应答。
 * 模型只碰意图分类与知识库问答；路由/时间抽取全是代码。
 * 已去表格化：不再直接读写飞书表格，进度回填由触达服务(ReachService)调表格服务完成。
 */
@Injectable()
export class ConverseService {
  private readonly logger = new Logger(ConverseService.name);
  private get LINK() { return this.config.get('INTERVIEW_LINK'); }

  constructor(
    private readonly llm: LlmService,
    private readonly config: ConfigService,
  ) {}

  /** 处理候选人一条回复，返回意图 + 话术 + 进展痕迹（不落库）。 */
  async handle(text: string): Promise<ConverseResult> {
    const type = await this.llm.classifyIntent(text);
    const value = extractTime(text);
    const linkLine = this.LINK ? `\n面试链接：${this.LINK}` : '';

    switch (type) {
      case 'TIME':
        return value
          ? {
              intent: type, time: value, action: 'confirm',
              reply: `好的，那就约在【${value}】~ 面试是线上视频形式，到时我会把面试链接发给您，点开进入即可。${linkLine}\n如需调整时间随时跟我说~`,
              note: `候选人确认面试时间【${value}】`,
            }
          : {
              intent: type, action: 'ask_time',
              reply: '好呀~ 您方便哪天、上午还是下午呢？把具体时间告诉我，我这就帮您和面试官约上。',
              note: '候选人想约面试，待其提供具体时间',
            };
      case 'RESCHEDULE':
        return {
          intent: type, action: 'ask_time',
          reply: '没问题~ 您方便的时间段是？告诉我大致的日期和上午/下午，我帮您协调面试官时间。',
          note: '候选人想改期，待HR协调新时间',
        };
      case 'REJECT':
        return {
          intent: type, action: 'close',
          reply: '好的，完全理解~ 感谢您的关注，后续如果有更合适的机会，我再和您联系。祝一切顺利！',
          note: '候选人婉拒，本次流程关闭',
        };
      case 'QUESTION': {
        const answer = await this.llm.answer(text);
        return { intent: type, action: 'answer', reply: answer, note: `候选人提问：${text.slice(0, 30)}` };
      }
      default: {
        const answer = await this.llm.answer(text);
        return { intent: 'OTHER', action: 'fallback', reply: answer, note: '' };
      }
    }
  }
}
