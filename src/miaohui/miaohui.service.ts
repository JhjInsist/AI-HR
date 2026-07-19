import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { ConfigService } from '../config/config.service';

/**
 * 秒回触达：招聘企微「加好友」。
 * 固定话术模板，不用任何模型生成。
 */
@Injectable()
export class MiaohuiService {
  private readonly logger = new Logger(MiaohuiService.name);
  private readonly base = process.env.MIAOHUI_OPENAPI_BASE || 'https://test-aa-api.ddregion.com';

  constructor(private readonly config: ConfigService) {}

  /** 通过手机号加好友（小组级开放接口）。返回 {ok, code}。
   *  opts.extraInfo：透传业务标识（触达编排用 taskId，同号首次固定）。
   *  opts.userId：IM员工Id（如 jiahongjia），指定发起加好友的托管账号；不填则秒回随机选号。
   *  opts.corpId：企业主体Id，仅当同一 userId 跨多企业时用于区分。 */
  async addFriendByPhone(
    phone: string,
    helloMsg: string,
    opts?: { extraInfo?: string; userId?: string; corpId?: string },
  ): Promise<{ ok: boolean; code: number; raw?: any }> {
    const token = this.config.get('MIAOHUI_GROUP_TOKEN');
    if (!token) return { ok: false, code: -99, raw: '缺 MIAOHUI_GROUP_TOKEN' };
    try {
      const body: Record<string, any> = {
        token,
        phoneNum: phone,
        // 秒回加好友按 userId(IM员工Id，如 jiahongjia)指定托管账号，不填则随机；
        // ⚠️不是账号ID(6a5c...)。传错字段名(如 botId)秒回不认→当没传→随机换号。
        userId: opts?.userId || '',
        helloMsg,
        instant: true,
        isEncrypt: false,
      };
      // corpId 仅当同一 userId 在多个企业都有账号时才需要区分；由调用方按 HR 名录传入。
      // ⚠️不全局写死(不同面试官分属不同企业主体，写死会张冠李戴)。
      if (opts?.corpId) body.corpId = opts.corpId;
      if (opts?.extraInfo) body.extraInfo = opts.extraInfo;
      this.logger.log(`[加好友·请求] ${this.base}/addFriend/send body=${JSON.stringify({ ...body, token: '***' })}`);
      const { data } = await axios.post(`${this.base}/addFriend/send`, body, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000,
      });
      this.logger.log(`[加好友·响应] phone=${phone} userId=${body.userId} → ${JSON.stringify(data)}`);
      return { ok: data?.code === 0, code: data?.code, raw: data };
    } catch (e: any) {
      const detail = e?.response?.data ? JSON.stringify(e.response.data) : (e?.code || e?.message);
      this.logger.error(`[加好友·异常] phone=${phone} botId=${opts?.userId || ''} status=${e?.response?.status} err=${detail}`);
      return { ok: false, code: -98, raw: detail?.slice?.(0, 200) || detail };
    }
  }

  /** 给指定会话发文本消息（小组级开放接口 POST /message/send，messageType=0 纯文本）。
   *  chatId 来自好友通过/消息回调。返回 {ok, code}。 */
  async sendText(chatId: string, text: string): Promise<{ ok: boolean; code: number; raw?: any }> {
    const token = this.config.get('MIAOHUI_GROUP_TOKEN');
    if (!token) return { ok: false, code: -99, raw: '缺 MIAOHUI_GROUP_TOKEN' };
    if (!chatId) return { ok: false, code: -97, raw: '缺 chatId' };
    try {
      const { data } = await axios.post(
        `${this.base}/message/send`,
        { token, chatId, messageType: 0, payload: { text } },
        { headers: { 'Content-Type': 'application/json' }, timeout: 30000 },
      );
      return { ok: data?.code === 0, code: data?.code, raw: data };
    } catch (e: any) {
      return { ok: false, code: -98, raw: e?.message?.slice(0, 120) };
    }
  }
}
