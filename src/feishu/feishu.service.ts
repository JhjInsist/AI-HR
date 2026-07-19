import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

/**
 * 飞书 OpenAPI 客户端（服务以「应用身份」运行，tenant_access_token）。
 * 只做确定性的数据读写，不含任何模型/推断。
 */
@Injectable()
export class FeishuService {
  private readonly logger = new Logger(FeishuService.name);
  private readonly base = process.env.FEISHU_BASE || 'https://open.feishu.cn';
  private token: string | null = null;
  private tokenExp = 0;

  private async tenantToken(): Promise<string> {
    const now = Date.now();
    if (this.token && now < this.tokenExp) return this.token;
    const { data } = await axios.post(
      `${this.base}/open-apis/auth/v3/tenant_access_token/internal`,
      { app_id: process.env.FEISHU_APP_ID, app_secret: process.env.FEISHU_APP_SECRET },
    );
    if (data.code !== 0) throw new Error(`tenant_access_token 失败: ${data.code} ${data.msg}`);
    this.token = data.tenant_access_token;
    this.tokenExp = now + (data.expire - 300) * 1000; // 提前 5 分钟刷新
    return this.token;
  }

  private async req(method: string, path: string, body?: any, params?: any) {
    const token = await this.tenantToken();
    const { data } = await axios.request({
      method,
      url: `${this.base}${path}`,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: body,
      params,
    });
    if (data.code !== 0) throw new Error(`${path} 失败: ${data.code} ${data.msg}`);
    return data.data;
  }

  /** 列出一张表全部记录（自动翻页），返回 [{record_id, fields}] */
  async listRecords(appToken: string, tableId: string): Promise<any[]> {
    const out: any[] = [];
    let pageToken: string | undefined;
    do {
      const d = await this.req(
        'GET',
        `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
        undefined,
        { page_size: 500, page_token: pageToken },
      );
      out.push(...(d.items || []));
      pageToken = d.has_more ? d.page_token : undefined;
    } while (pageToken);
    return out;
  }

  /** 新建一条记录 */
  async createRecord(appToken: string, tableId: string, fields: Record<string, any>) {
    return this.req(
      'POST',
      `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
      { fields },
    );
  }

  /** 更新一条记录 */
  async updateRecord(appToken: string, tableId: string, recordId: string, fields: Record<string, any>) {
    return this.req(
      'PUT',
      `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`,
      { fields },
    );
  }

  /** 机器人向群/会话发文本消息（应用身份） */
  async sendText(chatId: string, text: string) {
    return this.req(
      'POST',
      `/open-apis/im/v1/messages`,
      { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) },
      { receive_id_type: 'chat_id' },
    );
  }

  /** 应用主日历 ID（应用身份下 primary 返回应用自身日历，用于承载面试日程并邀请 HR） */
  private async appPrimaryCalendarId(): Promise<string> {
    const d = await this.req('POST', `/open-apis/calendar/v4/calendars/primary`);
    const id = d?.calendars?.[0]?.calendar?.calendar_id;
    if (!id) throw new Error('未取到应用主日历 calendar_id');
    return id;
  }

  /** 邮箱 → open_id；失败返回空串，调用方回退为外部邮箱参会人 */
  private async openIdByEmail(email: string): Promise<string> {
    try {
      const d = await this.req(
        'POST',
        `/open-apis/contact/v3/users/batch_get_id`,
        { emails: [email] },
        { user_id_type: 'open_id' },
      );
      return (d?.user_list || []).find((u: any) => u?.user_id)?.user_id || '';
    } catch (e: any) {
      this.logger.warn(`邮箱换 open_id 失败 ${email}: ${e?.message}`);
      return '';
    }
  }

  /**
   * 在应用主日历创建面试日程（带飞书视频会议 vc），并邀请 HR（其个人日历将出现该日程）。
   * 用应用身份（tenant_access_token），vchat.vc_type=vc 让飞书自动生成会议链接。
   * @param opts.startTime/opts.endTime 为 Unix 毫秒时间戳
   * @returns { eventId, meetingUrl }（meetingUrl 可能为空，调用方按空处理）
   */
  async createInterviewEvent(opts: {
    hrEmail?: string;
    hrOpenId?: string;
    summary: string;
    startTime: number;
    endTime: number;
    description?: string;
  }): Promise<{ eventId: string; meetingUrl: string }> {
    const calendarId = await this.appPrimaryCalendarId();
    const cal = encodeURIComponent(calendarId);
    // 面试官 open_id（用于加为参会人）。
    // ⚠️ 组织者是应用（tenant 身份建日程），飞书禁止机器人组织者设 assign_hosts/owner_id
    //（否则报 400 "organizer is bot, can not set assign_hosts"）。故不指定主持人，
    // 靠 allow_attendees_start=true 让面试官(参会人)也能开会，auto_record 保留自动录制。
    const hostOpenId = opts.hrOpenId || (opts.hrEmail ? await this.openIdByEmail(opts.hrEmail) : '');
    const created = await this.req('POST', `/open-apis/calendar/v4/calendars/${cal}/events`, {
      summary: opts.summary,
      description: opts.description || '',
      start_time: { timestamp: String(Math.floor(opts.startTime / 1000)), timezone: 'Asia/Shanghai' },
      end_time: { timestamp: String(Math.floor(opts.endTime / 1000)), timezone: 'Asia/Shanghai' },
      vchat: {
        vc_type: 'vc',
        meeting_settings: {
          allow_attendees_start: true,
          auto_record: true,
        },
      },
      attendee_ability: 'can_see_others',
      need_notification: true,
      reminders: [{ minutes: 15 }],
    });
    const eventId: string = created?.event?.event_id || '';
    let meetingUrl: string = created?.event?.vchat?.meeting_url || '';

    // 邀请 HR：优先用传入 open_id，其次用邮箱换 open_id，再不行用外部邮箱参会人
    if ((opts.hrOpenId || opts.hrEmail) && eventId) {
      const openId = hostOpenId;
      const attendee = openId
        ? { type: 'user', user_id: openId }
        : { type: 'third_party', third_party_email: opts.hrEmail };
      try {
        await this.req(
          'POST',
          `/open-apis/calendar/v4/calendars/${cal}/events/${eventId}/attendees`,
          { attendees: [attendee], need_notification: true },
        );
      } catch (e: any) {
        this.logger.warn(`邀请 HR 参会失败 ${opts.hrEmail}: ${e?.message}`);
      }
    }

    // 兜底：创建响应未带会议链接时回查一次
    if (!meetingUrl && eventId) {
      try {
        const got = await this.req('GET', `/open-apis/calendar/v4/calendars/${cal}/events/${eventId}`);
        meetingUrl = got?.event?.vchat?.meeting_url || '';
      } catch { /* 回查失败不阻断，返回空链接 */ }
    }
    return { eventId, meetingUrl };
  }

  /** 下载某记录某附件字段的文件到本地目录，返回文件路径数组 */
  async downloadAttachments(appToken: string, tableId: string, recordId: string, field: string, dir: string): Promise<string[]> {
    // 附件 file_token 在记录字段里；下载走 drive media
    const token = await this.tenantToken();
    const recs = await this.listRecords(appToken, tableId);
    const rec = recs.find((r) => r.record_id === recordId);
    const files = (rec?.fields?.[field] || []) as any[];
    const fs = await import('fs');
    const path = await import('path');
    fs.mkdirSync(dir, { recursive: true });
    const paths: string[] = [];
    for (const f of files) {
      const resp = await axios.get(
        `${this.base}/open-apis/drive/v1/medias/${f.file_token}/download`,
        { headers: { Authorization: `Bearer ${token}` }, responseType: 'arraybuffer' },
      );
      const p = path.join(dir, f.name || f.file_token);
      fs.writeFileSync(p, Buffer.from(resp.data));
      paths.push(p);
    }
    return paths;
  }
}
