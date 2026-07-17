import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { ConfigService } from '../config/config.service';

/**
 * 秒懂客户端。两条独立流水线（都在句子秒懂页面可见）：
 *  · 意图 bot（INTENT_BOT_ID）——只做"分类"，输出结构化标签
 *    TIME/RESCHEDULE/REJECT/QUESTION/OTHER，供秒聘服务死规则路由。
 *  · 对话 bot（CHAT_BOT_ID）——结合公司知识库生成有依据的应答（欢迎/闲聊/答疑）。
 * 模型只用在"分类"和"知识库问答"两处，路由与副作用全是确定性代码。
 */
@Injectable()
export class MiaodongService {
  private readonly logger = new Logger(MiaodongService.name);
  private readonly base = process.env.INSIGHT_BASE || 'https://test-aa-insight.ddregion.com/api';
  private readonly org = process.env.INSIGHT_ORG || 'aab99626-d471-4d3e-966b-2b447b909bf8';
  private get intentBot() { return this.config.get('INTENT_BOT_ID', '2700b931-0e09-4407-bff4-a05be91e2fc3'); }
  private get chatBot() { return this.config.get('CHAT_BOT_ID', '0dbcbe30-8060-45ba-b206-b6da62e48144'); }
  private readonly jwt = process.env.INSIGHT_TOKEN || '';
  private at = { token: '', exp: 0 };

  constructor(private readonly config: ConfigService) {}

  private async accessToken(): Promise<string> {
    if (this.at.token && Date.now() < this.at.exp) return this.at.token;
    const cfg = await axios.get(`${this.base}/openapi/config?orgId=${this.org}`, { headers: { Authorization: `Bearer ${this.jwt}` } });
    const { accessKeyId, accessKeySecret } = cfg.data.data;
    const tk = await axios.post(`${this.base}/openapi/get-access-token`, { accessKeyId, accessKeySecret });
    this.at = { token: tk.data.data.accessToken, exp: Date.now() + 110 * 60 * 1000 };
    return this.at.token;
  }

  private async ask(botId: string, text: string, sessionId: string): Promise<string> {
    const at = await this.accessToken();
    const r = await axios.post(`${this.base}/openapi/bot/message`,
      { botId, sessionId, message: { type: 'text', text }, stream: false },
      { headers: { Authorization: `Bearer ${at}` }, timeout: 40000 });
    return (r.data?.data?.message || '').trim();
  }

  /** 分类候选人回复 → {type, value}（value 为原文里抽到的时间，确定性抽取） */
  async classify(text: string, sessionId = 'intent'): Promise<{ type: string; value?: string; raw: string }> {
    const raw = (await this.ask(this.intentBot, text, `${sessionId}-${Date.now()}`))
      .replace(/^\s*\[[^\]]*\]\s*/, '').trim();
    const type = (raw.split('|')[0] || 'OTHER').trim().toUpperCase();
    const known = ['TIME', 'RESCHEDULE', 'REJECT', 'QUESTION', 'OTHER'];
    return { type: known.includes(type) ? type : 'OTHER', value: extractTime(text), raw };
  }

  /** 结合公司知识库回答候选人问题（有依据）。兜底剥离模型偶发拼接的 JSON 尾巴 */
  async chat(text: string, sessionId = 'chat'): Promise<string> {
    const raw = await this.ask(this.chatBot, text, `${sessionId}-${Date.now()}`);
    return stripJson(raw);
  }
}

/** 剥离模型偶尔拼接的 {"reply":...,"intent":...} 尾巴，只留纯对话 */
export function stripJson(s: string): string {
  let out = (s || '').replace(/\{\s*"reply"[\s\S]*$/i, '').trim();
  try {
    const m = (s || '').match(/\{\s*"reply"\s*:\s*"([^"]*)"/i);
    if (!out && m) out = m[1];
  } catch {}
  return out || s;
}

const CN = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 } as Record<string, number>;

/** 从候选人原文里确定性抽取时间短语（不让模型编时间），中文/阿拉伯数字都支持 */
export function extractTime(text: string): string | undefined {
  const t = (text || '').replace(/\s+/g, '');
  const m = t.match(
    /(周[一二三四五六日天]|礼拜[一二三四五六日天]|今天|明天|后天|大后天|下周[一二三四五六日天]?|\d{1,2}月\d{1,2}[日号])?(上午|下午|中午|晚上|早上)?((\d{1,2}|十[一二]?|[一二两三四五六七八九])\s*[:：点时](半|\d{0,2}分?)?)/,
  );
  if (!m) return undefined;
  let out = m[0];
  // 中文数字小时转阿拉伯，便于后续对齐
  out = out.replace(/(十[一二]?|[一二两三四五六七八九])(?=[点时])/, (h) => String(CN[h] ?? h));
  return out;
}
