# AI-HR 招聘触达服务（miaopin-service）

AI 招聘自动化系统的**触达服务**：负责候选人的加好友触达、对话应答（约面/答疑/薪资转人工）、飞书通知 HR。基于 NestJS。

> 系统由两个服务组成：
> - **触达服务（本仓库）**：加好友、对话大脑、通知 HR。
> - **表格管理服务（独立仓库，另一同事维护）**：AI-HR 表 → 进度表数据同步、字段监听、简历 OCR、定时轮询。检测到"该触达"时 HTTP 调本服务的 `POST /logic/reach`。

---

## 架构：秒懂画布管对话，服务只做确定性逻辑

```
候选人企微消息
  → 秒回(IM平台) 路由到 → 秒懂画布(招聘触达对话)
     画布内: JS判薪资 → rule-center分支 → LLM意图/知识库答疑 → send回复 / handover转人工
                                    ↓ 需外部能力时 plugin 调本服务
  → 本服务(触达服务): /logic/* 逻辑API(查进度/通知HR) + 加好友
```

**核心原则**：判断、路由、话术、转人工都在**秒懂画布**里；本服务只做画布/秒回搞不定的**外部任务**（飞书发消息、读写多维表、秒回加好友）。模型只用于意图分类和知识库问答。

- 秒懂画布 bot：`6778189a-fa43-4854-b3e7-f5b44e08b16c`「招聘触达对话」
- 已在秒回绑定托管账号 `6a57ce85665a14787a7a5b59`（招聘企微号），开「智能体自动回复」

---

## HTTP 接口

### 逻辑 API（`/logic/*`，给秒懂画布 plugin 或表格服务调）
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/logic/reach` | **发起加好友触达**。body `{phone, name?, helloMsg?}` → 招聘企微加好友，返回 `{ok, code, name, phone}`。**表格管理服务在候选人面试信息就绪后调这个** |
| GET | `/logic/progress?name=` | 查候选人进度（读进度表），返回结构化字段 + summary 文本 |
| GET | `/logic/converse?text=&candidate=` | 触达对话：意图分类 + 死规则路由 + 知识库答疑，返回 `{reply, intent, action, time}` |
| GET | `/logic/notify-hr?question=&candidate=` | 薪资问询用飞书应用通知 HR（发到 `HR_NOTIFY_CHAT`），返回过渡话术 |

### 飞书 & 运维
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/feishu/webhook` | 飞书事件回调（@机器人消息 → 群运维助手） |
| GET | `/feishu/health` | 健康检查 |
| GET | `/feishu/intent?text=` | 测试意图分类 |
| GET | `/feishu/converse?text=&candidate=` | 测试触达对话全链路 |
| GET | `/admin` | 配置台（可视化改表格/Agent/触达/秒回配置，热生效） |

### `POST /logic/reach` 示例（表格服务发起触达）
```bash
curl -X POST http://ai-hr.juzibot.com/logic/reach \
  -H 'Content-Type: application/json' \
  -d '{"phone":"138xxxxxxxx","name":"张三"}'
# → {"ok":true,"code":0,"name":"张三","phone":"138xxxxxxxx"}
```
> `phone` 走正则 `1[3-9]\d{9}` 校验，非法直接返回 `{ok:false}`；`helloMsg` 不传则用配置的 `HELLO_MSG`。

---

## 模块

| 目录 | 职责 |
|---|---|
| `logic/` | 逻辑层 API（reach/progress/converse/notify-hr），被秒懂画布 plugin 或表格服务调 |
| `recruit/converse.service.ts` | 触达对话大脑：意图分类 + 死规则路由 + 抽时间 + 知识库答疑 |
| `miaodong/` | 秒懂调用封装（意图 bot / 对话 bot） |
| `miaohui/` | 秒回加好友（招聘企微，小组级 token） |
| `feishu/` | 飞书事件回调 + 多维表读写 + 发消息封装 |
| `bot/` | 飞书群运维助手（@机器人查进度/加微信/看列表） |
| `admin/` | 配置台（config.json 热改）+ 秒懂画布模型切换 |
| `config/` | 运行时配置（config.json 覆盖 + env 回退） |

> 表格管理（规则①②同步、简历 OCR、定时轮询）已拆分为独立服务，不在本仓库。

---

## 配置

运行时从 `config.json`（挂载卷 `/opt/miaopin-service/data` 持久化）读，回退环境变量。可在配置台 `http://ai-hr.juzibot.com/admin` 可视化热改。

关键项：`AIHR_APP_TOKEN`/`AIHR_TABLE_ID`、`PROG_APP_TOKEN`/`PROG_TABLE_ID`、`INTENT_BOT_ID`、`CHAT_BOT_ID`、`MODEL`、`DRY_RUN`、`HELLO_MSG`、`INTERVIEW_LINK`、`MIAOHUI_GROUP_TOKEN`、`MIAOHUI_CORP_ID`、`MIAOHUI_BOT_USERID`、`HR_NOTIFY_CHAT`、`FEISHU_BOT_NAME`。

密钥（`FEISHU_APP_SECRET`、`INSIGHT_TOKEN`、`MIAOHUI_GROUP_TOKEN`）放服务器 `.env`，**不进 git**（见 `.gitignore`）。

---

## 本地开发

```bash
npm install
npm run build          # 编译 TS → dist
npm run start:dev      # 本地热重载
```

---

## 部署

服务器 `101.126.100.251`，Docker 容器 `miaopin`，域名 `http://ai-hr.juzibot.com`。

```bash
npm run build                                                    # 本地编译
rsync -az ./dist/ root@101.126.100.251:/opt/miaopin-service/dist/
ssh root@101.126.100.251 'cd /opt/miaopin-service && \
  docker build -t miaopin-service . && \
  docker rm -f miaopin ; \
  docker run -d --name miaopin --restart unless-stopped \
    -p 80:80 -v /opt/miaopin-service/data:/app/data --env-file .env miaopin-service'
```

- Dockerfile 用 `COPY dist ./dist`（用预编译产物，不在镜像里 build）→ **改代码必须先 `npm run build` 再 rsync dist**
- `.env`（密钥）和 `data/`（配置）在服务器，不经过 git/CI

---

## 依赖的外部系统

- **秒懂**（AI 平台，`test-aa-insight.ddregion.com`）：画布 bot、意图/对话、知识库
- **秒回**（IM 平台，`test-aa-api.ddregion.com`）：招聘企微加好友、候选人消息路由
- **飞书开放平台**：应用 `cli_aad38fd84da1dbb3`，多维表读写 + 发消息
