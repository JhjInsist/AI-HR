import { Controller, Get, Post, Body, Query } from '@nestjs/common';
import { FeishuService } from '../feishu/feishu.service';
import { ConfigService } from '../config/config.service';
import { ConverseService } from '../recruit/converse.service';
import { MiaohuiService } from '../miaohui/miaohui.service';

/** 薪酬/福利/待遇相关问题的确定性识别（预处理，词库可扩充，不用模型避免误判） */
const SALARY_RE = new RegExp(
  [
    // 薪酬本体
    '薪资', '工资', '薪水', '薪酬', '待遇', '工钱', '底薪', '月薪', '年薪', '日薪', '时薪', '基本工资', '税前', '税后',
    'base', 'package', 'offer', 'salary',
    // 金额问法
    '多少钱', '开多少', '给多少', '能给', '多少工资', '工资多少', '薪资多少', '什么价', '预算',
    // 福利
    '福利', '五险', '一金', '公积金', '社保', '年终奖', '奖金', '提成', '绩效', '分红', '股票', '股权', '期权',
    '补贴', '报销', '餐补', '房补', '交通补', '话补', '过节费', '十三薪', '十四薪', '十三', '过节',
    // 工时/假期（钱相关）
    '加班费', '加班补', '调休', '双休', '大小周', '年假', '带薪',
    // 调薪
    '涨薪', '调薪', '加薪', '涨工资', '调整薪资',
  ].join('|'),
  'i',
);
export function isSalaryRelated(text: string): boolean {
  return SALARY_RE.test(text || '');
}

function cellText(v: any): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === 'object' ? x.text ?? x.name ?? '' : String(x))).join('');
  if (typeof v === 'object') return v.text ?? v.name ?? '';
  return String(v);
}

/**
 * 逻辑层 API（供秒懂画布 plugin 调用）。
 * 只做确定性运算、返回结构化数据 + 可直接回复的文本，不碰消息收发。
 * 这是「秒懂管收发、服务只做逻辑」架构的样板接口。
 */
@Controller('logic')
export class LogicController {
  constructor(
    private readonly feishu: FeishuService,
    private readonly config: ConfigService,
    private readonly converse: ConverseService,
    private readonly miaohui: MiaohuiService,
  ) {}

  /** 发起触达（加好友）：POST /logic/reach  body {phone, name?, helloMsg?}
   *  供「表格管理服务」在候选人面试信息就绪后调用，用招聘企微加好友。
   *  纯执行加好友，不涉及表格逻辑。返回 {ok, code}。 */
  @Post('reach')
  async reach(@Body() body: { phone?: string; name?: string; helloMsg?: string }) {
    const phone = (body?.phone || '').trim();
    if (!/^1[3-9]\d{9}$/.test(phone)) return { ok: false, code: -1, msg: '缺少或非法手机号 phone' };
    const hello = body?.helloMsg || this.config.get('HELLO_MSG', '你好，我是句子互动招聘助理，看到你投递的岗位，想跟你约一次面试~');
    const res = await this.miaohui.addFriendByPhone(phone, hello);
    return { ok: res.ok, code: res.code, name: body?.name || '', phone };
  }

  /** 薪资等问题通知HR：GET /logic/notify-hr?question=候选人问题[&candidate=姓名]
   *  用飞书应用把问询同步到 HR（HR_NOTIFY_CHAT 配置的飞书会话），返回给候选人的过渡话术 */
  @Get('notify-hr')
  async notifyHr(@Query('question') question: string, @Query('candidate') candidate?: string) {
    const chat = this.config.get('HR_NOTIFY_CHAT');
    const who = candidate ? `候选人【${candidate}】` : '一位候选人';
    const q = (question || '').slice(0, 100);
    const text = `💰【薪资问询待跟进】\n${who}在面试沟通中问到薪资/待遇：\n「${q}」\n请 HR 及时跟进沟通。`;
    let notified = false;
    if (chat) {
      try { await this.feishu.sendText(chat, text); notified = true; }
      catch (e: any) { /* 通知失败不阻断对候选人的回复 */ }
    }
    return { notified, reply: '您关于薪资待遇的问题，我已经同步给我们 HR 啦~ 稍后 HR 会直接和您详细沟通，请稍等一下哈。' };
  }

  /** 触达对话：GET /logic/converse?text=候选人回复[&candidate=姓名]
   *  服务内部：秒懂意图分类 + 死规则路由 + (传candidate则写进度表) → 返回该回给候选人的话 */
  @Get('converse')
  async converseApi(@Query('text') text: string, @Query('candidate') candidate?: string) {
    const q = (text || '').trim();
    if (!q) return { reply: '在的，请问有什么可以帮您？', intent: 'OTHER', action: 'fallback', time: '' };
    // 薪资/待遇：确定性关键词判断（绝不让模型判，避免误分类）→ 通知HR + 标记转人工
    // 覆盖薪酬/福利/工时/调薪各类表述，涉及"钱和待遇"一律走同一套逻辑，词库可继续扩充
    if (isSalaryRelated(q)) {
      const chat = this.config.get('HR_NOTIFY_CHAT');
      const who = candidate ? `候选人【${candidate}】` : '一位候选人';
      if (chat) {
        try { await this.feishu.sendText(chat, `💰【薪资问询待跟进】\n${who}在面试沟通中问到薪资/待遇：\n「${q.slice(0, 100)}」\n请 HR 及时跟进。`); } catch { /* 通知失败不阻断 */ }
      }
      return { reply: '您关于薪资待遇的问题，我已经同步给我们 HR 啦~ 稍后 HR 会直接和您详细沟通，请稍等一下哈。', intent: 'SALARY', action: 'handover', time: '' };
    }
    const r = await this.converse.handle(q, candidate);
    return { reply: r.reply, intent: r.intent, action: r.action, time: r.time || '' };
  }

  /** 查候选人进度：GET /logic/progress?name=张三 → 结构化字段 + summary 文本 */
  @Get('progress')
  async progress(@Query('name') name: string) {
    const q = (name || '').trim();
    if (!q) return { found: false, summary: '没收到候选人姓名，请说清楚要查谁。' };

    const app = this.config.get('PROG_APP_TOKEN');
    const tbl = this.config.get('PROG_TABLE_ID');
    const rows = await this.feishu.listRecords(app, tbl);

    // 模糊匹配：去掉"测试/候选人"前缀取核心名，消息含核心名或其≥2字子串即命中
    const core = (n: string) => n.replace(/^(测试|候选人)/, '');
    const hit = rows.find((r) => {
      const n = cellText(r.fields['姓名']);
      if (!n) return false;
      const c = core(n);
      if (c.length >= 2 && q.includes(c)) return true;
      for (let i = 0; i + 2 <= c.length; i++) if (q.includes(c.slice(i, i + 2))) return true;
      return false;
    });

    if (!hit) return { found: false, name: q, summary: `进度表里没找到「${q}」这个候选人。` };

    const f = hit.fields;
    const 姓名 = cellText(f['姓名']);
    const 岗位 = cellText(f['岗位']);
    const 一面时间 = cellText(f['一面时间']);
    const 一面面试官 = cellText(f['一面面试官']);
    const 联系方式 = cellText(f['联系方式']);
    const 备忘录 = cellText(f['备忘录']);
    const summary =
      `${姓名}（${岗位 || '岗位未填'}）\n` +
      `· 一面：${一面时间 ? `${一面时间} / ${一面面试官 || '面试官未定'}` : '未约'}\n` +
      `· 联系方式：${联系方式 || '未填'}\n` +
      `· 进展：${备忘录 || '（无）'}`;

    return { found: true, name: 姓名, position: 岗位, interviewTime: 一面时间, interviewer: 一面面试官, contact: 联系方式, memo: 备忘录, summary };
  }
}
