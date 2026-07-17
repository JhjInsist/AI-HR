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
