# 秒聘服务 (miaopin-service)

招聘流程**确定性编排**服务：飞书表驱动 + 秒回触达。**除简历 OCR 外全程无模型、无幻觉。**

## 组合拳架构
```
飞书应用(App身份读写表)  →  秒聘服务(本服务·纯规则大脑)  →  秒回(加好友触达) / 秒懂(仅必要处)
```

## 两条确定性规则
- **规则①**：AI HR招聘表【HR评估】=约面 → 写入招聘进度管理表（字段死映射 + 抽联系方式）
- **规则②**：进度表【一面时间】+【一面面试官】都非空 → 招聘企微加好友 + 结果写【备忘录】

联系方式抽取顺序：表字段 → 简历 pdftotext → 图片简历 tesseract OCR；一律过正则 `1[3-9]\d{9}` 校验，取不到就标「需人工」，**绝不编造**。

## 运行前置（在飞书开放平台配一次）
1. 自建应用开权限：`bitable:app`（多维表格读写）、`im:message`（如需发消息）
2. 把应用加为**两张多维表格的协作者**（否则 App 身份读不了表）
3. 拿 `app_secret` 填入环境变量（不进代码）

## 启动
```bash
cp .env.example .env   # 填 FEISHU_APP_SECRET / MIAOHUI_GROUP_TOKEN
npm install
npm run build && npm run start:prod
# 默认 DRY_RUN=true（不真写表/不真加好友）；确认后设 DRY_RUN=false
```

## 依赖工具
- pdftotext / pdftoppm (poppler) · tesseract (chi_sim) —— 简历 OCR
