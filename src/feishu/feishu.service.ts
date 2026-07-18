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
   * 在应用主日历创建面试日程（带飞书视频会议 vc），并把 HR 以「飞书内部用户」身份邀请为参会人。
   * 用应用身份（tenant_access_token），vchat.vc_type=vc 让飞书自动生成会议链接。
   *
   * 「日程进 HR 日历 + HR 有管理权」的实现（飞书公有云机制）：
   * - tenant_access_token 建的日程本体归属「应用日历」，写不进 HR 主日历本体；
   * - 但用 open_id 邀请飞书内部用户为参会人 → 日程会显示在该 HR 的飞书日历里；
   * - 配合 attendee_ability=can_modify_event → HR 获得改期/增删参会人等完整管理权。
   * - 若只拿到邮箱且换不到 open_id（如非内部账号 / contact 权限未开），回退 third_party_email
   *   只能发邮件通知，**不会进 HR 飞书日历**，此时通过 hrInviteWarn 明确回传告警。
   *
   * @param opts.startTime/opts.endTime 为 Unix 毫秒时间戳
   * @returns { eventId, meetingUrl, hrInvited, hrInviteWarn }
   *   hrInvited=true 表示已以飞书用户身份邀请成功（会进 HR 日历且有管理权）；
   *   hrInviteWarn 非空表示 HR 邀请有问题（未进日历 / API 失败），供上层记录 timeline。
   */
  async createInterviewEvent(opts: {
    hrEmail?: string;
    hrOpenId?: string;
    summary: string;
    startTime: number;
    endTime: number;
    description?: string;
  }): Promise<{ eventId: string; meetingUrl: string; hrInvited: boolean; hrInviteWarn: string }> {
    const calendarId = await this.appPrimaryCalendarId();
    const cal = encodeURIComponent(calendarId);
    const created = await this.req('POST', `/open-apis/calendar/v4/calendars/${cal}/events`, {
      summary: opts.summary,
      description: opts.description || '',
      start_time: { timestamp: String(Math.floor(opts.startTime / 1000)), timezone: 'Asia/Shanghai' },
      end_time: { timestamp: String(Math.floor(opts.endTime / 1000)), timezone: 'Asia/Shanghai' },
      vchat: { vc_type: 'vc', meeting_settings: { allow_attendees_start: true } },
      // 给参会人（HR）完整编辑权：改期、增删参会人、管理会议
      attendee_ability: 'can_modify_event',
      need_notification: true,
      reminders: [{ minutes: 15 }],
    });
    const eventId: string = created?.event?.event_id || '';
    let meetingUrl: string = created?.event?.vchat?.meeting_url || '';

    // 邀请 HR：优先用传入 open_id，其次用邮箱换 open_id；换不到才回退外部邮箱（仅邮件通知，不进日历）
    let hrInvited = false;
    let hrInviteWarn = '';
    if ((opts.hrOpenId || opts.hrEmail) && eventId) {
      const openId = opts.hrOpenId || (opts.hrEmail ? await this.openIdByEmail(opts.hrEmail) : '');
      const asUser = !!openId;
      const attendee = asUser
        ? { type: 'user', user_id: openId }
        : { type: 'third_party', third_party_email: opts.hrEmail };
      if (!asUser) {
        hrInviteWarn = `未换到 HR open_id（邮箱=${opts.hrEmail || '(空)'}），回退外部邮箱邀请，日程不会进 HR 飞书日历——请确认 HR 用飞书内部账号邮箱且已开 contact:user.id:readonly 权限`;
        this.logger.warn(`[约面日程] ${hrInviteWarn}`);
      }
      try {
        await this.req(
          'POST',
          `/open-apis/calendar/v4/calendars/${cal}/events/${eventId}/attendees`,
          { attendees: [attendee], need_notification: true },
        );
        hrInvited = asUser; // 只有以飞书用户身份邀请，才算真正进 HR 日历 + 有管理权
      } catch (e: any) {
        const detail = e?.response?.data ? JSON.stringify(e.response.data) : e?.message;
        hrInviteWarn = `邀请 HR 参会失败：${detail}`;
        this.logger.warn(`[约面日程] 邀请 HR 参会失败 ${opts.hrEmail || opts.hrOpenId}: ${detail}`);
      }
    } else if (eventId) {
      hrInviteWarn = '未提供 HR open_id / 邮箱，未邀请 HR，日程不会进任何 HR 日历';
    }

    // 兜底：创建响应未带会议链接时回查一次
    if (!meetingUrl && eventId) {
      try {
        const got = await this.req('GET', `/open-apis/calendar/v4/calendars/${cal}/events/${eventId}`);
        meetingUrl = got?.event?.vchat?.meeting_url || '';
      } catch { /* 回查失败不阻断，返回空链接 */ }
    }
    return { eventId, meetingUrl, hrInvited, hrInviteWarn };
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
