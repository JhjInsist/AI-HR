// 秒懂 canvas 节点模板（从已验证可用的画布导出，供切换模型时重建）
export const NODE_TPL: any = {
  "send-text-message": {
    "id": "eada810b-5aaa-42e0-b79a-b3d382fa2b83",
    "data": {
      "name": "发送文本消息",
      "type": "send-text-message",
      "category": "action",
      "isSelected": false,
      "nodePayload": {
        "inputs": [
          {
            "name": "",
            "valueType": "reference"
          }
        ],
        "template": "第二批豆包2",
        "enableMention": false,
        "mentionUserIds": {
          "name": "mentionUserIds",
          "type": {
            "type": "array"
          },
          "valueType": "reference"
        },
        "quoteMessageId": {
          "name": "quoteMessageId",
          "valueType": "reference"
        }
      },
      "isEditComplete": true
    },
    "size": {
      "width": 350,
      "height": 100
    },
    "view": "react-shape-view",
    "ports": {
      "items": [
        {
          "id": "219c74a5-8646-48f1-83a7-555ecc130ae7",
          "attrs": {
            "fo": {
              "x": -5,
              "y": -5,
              "width": 10,
              "height": 10,
              "magnet": true,
              "random": 0.9955227984063647
            }
          },
          "group": "left"
        },
        {
          "id": "78ed8db3-a428-44c5-b8bc-50172d22531b",
          "attrs": {
            "fo": {
              "x": -5,
              "y": -5,
              "width": 10,
              "height": 10,
              "magnet": true,
              "random": 0.5201267996368644,
              "allowConnect": false
            }
          },
          "group": "right"
        }
      ],
      "groups": {
        "left": {
          "attrs": {
            "fo": {
              "x": -5,
              "y": -5,
              "width": 10,
              "height": 10,
              "magnet": true
            },
            "circle": {
              "r": 5,
              "fill": "#1F6DFF",
              "magnet": true,
              "stroke": "#1F6DFF"
            }
          },
          "position": "left"
        },
        "right": {
          "attrs": {
            "fo": {
              "x": -5,
              "y": -5,
              "width": 10,
              "height": 10,
              "magnet": true,
              "allowConnect": false
            }
          },
          "position": "right"
        }
      }
    },
    "shape": "send-text-message",
    "zIndex": 55,
    "position": {
      "x": -2049,
      "y": -116
    },
    "portMarkup": [
      {
        "tagName": "foreignObject",
        "children": [
          {
            "ns": "http://www.w3.org/1999/xhtml",
            "attrs": {
              "xmlns": "http://www.w3.org/1999/xhtml"
            },
            "style": {
              "width": "100%",
              "height": "100%",
              "background": "transparent"
            },
            "tagName": "body",
            "children": [
              {
                "style": {
                  "width": "100%",
                  "height": "100%"
                },
                "tagName": "div",
                "selector": "foContent"
              }
            ],
            "selector": "foBody"
          }
        ],
        "selector": "fo"
      }
    ]
  },
  "receive-text-message": {
    "id": "89a428bd-bf59-49dc-a303-048313ce310b",
    "data": {
      "name": "接收文本消息",
      "type": "receive-text-message",
      "onlyOne": true,
      "category": "trigger",
      "isSelected": false,
      "outputTypes": [
        {
          "name": "roomId",
          "type": {
            "type": "string",
            "isRequired": false
          }
        },
        {
          "name": "contactId",
          "type": {
            "type": "string",
            "isRequired": true
          }
        },
        {
          "name": "receiverId",
          "type": {
            "type": "string",
            "isRequired": true
          }
        },
        {
          "name": "text",
          "type": {
            "type": "string",
            "isRequired": true
          }
        },
        {
          "name": "messageId",
          "type": {
            "type": "string",
            "isRequired": true
          }
        },
        {
          "name": "isCoworker",
          "type": {
            "type": "boolean",
            "isRequired": false
          }
        },
        {
          "name": "mentionSelf",
          "type": {
            "type": "boolean",
            "isRequired": false
          }
        },
        {
          "name": "mentionCoworker",
          "type": {
            "type": "boolean",
            "isRequired": false
          }
        },
        {
          "name": "mentionCustomer",
          "type": {
            "type": "boolean",
            "isRequired": false
          }
        },
        {
          "name": "isMentionAll",
          "type": {
            "type": "boolean",
            "isRequired": false
          }
        },
        {
          "name": "contactTags",
          "type": {
            "type": "tag",
            "isRequired": false
          }
        },
        {
          "name": "senderName",
          "type": {
            "type": "string",
            "isRequired": false
          }
        },
        {
          "name": "quoteMessageId",
          "type": {
            "type": "string",
            "isRequired": false
          }
        }
      ],
      "isEditComplete": true
    },
    "size": {
      "width": 350,
      "height": 100
    },
    "view": "react-shape-view",
    "ports": {
      "items": [
        {
          "id": "f2d7493e-46cb-4f6b-99d2-1ab00746a0f9",
          "attrs": {
            "fo": {
              "x": -5,
              "y": -5,
              "width": 10,
              "height": 10,
              "magnet": true,
              "random": 0.5160196445005387,
              "allowConnect": false
            }
          },
          "group": "right"
        }
      ],
      "groups": {
        "right": {
          "attrs": {
            "fo": {
              "x": -5,
              "y": -5,
              "width": 10,
              "height": 10,
              "magnet": true,
              "allowConnect": false
            }
          },
          "position": "right"
        }
      }
    },
    "shape": "receive-text-message",
    "zIndex": 57,
    "position": {
      "x": -3421,
      "y": -374
    },
    "portMarkup": [
      {
        "tagName": "foreignObject",
        "children": [
          {
            "ns": "http://www.w3.org/1999/xhtml",
            "attrs": {
              "xmlns": "http://www.w3.org/1999/xhtml"
            },
            "style": {
              "width": "100%",
              "height": "100%",
              "background": "transparent"
            },
            "tagName": "body",
            "children": [
              {
                "style": {
                  "width": "100%",
                  "height": "100%"
                },
                "tagName": "div",
                "selector": "foContent"
              }
            ],
            "selector": "foBody"
          }
        ],
        "selector": "fo"
      }
    ]
  },
  "llm-completion": {
    "id": "95c7b736-05fc-49ef-9a25-e27f56e42810",
    "data": {
      "name": "大模型生成",
      "type": "llm-completion",
      "output": [
        {
          "name": "message",
          "type": {
            "type": "string",
            "isRequired": true
          }
        }
      ],
      "category": "calculation",
      "isSelected": false,
      "nodePayload": {
        "inputs": [
          {
            "name": "test",
            "type": {
              "type": "string",
              "isRequired": true
            },
            "dataPath": "message",
            "valueType": "reference",
            "referenceNodeId": "5acef59e-2c5c-4f66-8b91-6d20af134f90"
          }
        ],
        "chatMode": true,
        "modelType": "doubao-pro-32k",
        "jsonOutput": false,
        "userPrompt": "# 输入内容\n{{msg}}\n{{text}}\n\n# 注意 \n1. 模块撰写的时候时长一定要对齐\n2. 时长和实际的字数要对齐，一分钟一般对应的是150字一定要输出结果",
        "temperature": 0.8,
        "maxToolCalls": 5,
        "systemPrompt": "## 一、任务定义\n\n你是一名顶级直播带货专家，将对用户提供的直播间内容进行分析，帮助用户提升直播技巧。\n\n语言要求：简体中文\n\n---\n\n## 二、将用户输入的内容结构化\n1. 认真分析用户输入的文稿\n2. 重点区分出开始时间、结束时间、内容三部分内容\n3。 整理后的结果提供给下面的模块进行使用，不进行输出\n\n---\n\n## 三、分析流程\n\n### 1: 提取典型“讲解与促销循环”\n- 任务定义：\n从用户提供的内容中，识别并拆分出每个“讲解与促销循环”的时间段，并进行总结。\n- 循环定义与识别标准：\n* 引入商品（过渡到商品推荐）\n* 产品介绍（卖点、构成、痛点解决方案）\n* 促单（价格、福利、紧迫性）\n* 购买与售后指引\n\n- 判断依据：\n话术结构、内容逻辑、推广完整性。\n\n- 输出表格（示例）：\n\n| 讲解商品名称 | 一轮典型讲解时长 | 关键信息      |\n| ------ | ------- | --------- |\n| 商品1    | 3分24秒   | 核心卖点、促单方式 |\n| 商品2    | 1分30秒   | 用户痛点、价格促销 |\n\n---\n\n### 2: 直播策略分析\n\n（1）直播定位与目标受众分析\n\n* 直播间定位\n* 目标受众画像\n* 具体分析依据\n\n（2）内容策略分析\n整体性阐述（优缺点分别列出）：\n\n* 开场与吸引力法则（信任感建立、福利预告、留人技巧）\n* 产品卖点深度讲解与场景化呈现（痛点解决方案、核心卖点量化、情绪调动）\n* 促单与转化引导（催单话术、稀缺性强调、购买流程、追加销售）\n\n（3）主播表现与互动技巧\n整体性阐述（优缺点分别列出）：\n\n* 人设打造\n* 互动技巧\n* 语言风格\n* 危机处理\n\n---\n\n### 3: 商品分析\n\n针对每个商品，输出以下内容：\n\n（1）标准话术结构与时长\n\n（2）商品讲解技巧详细总结\n分别阐述优点与缺点，按标准模块输出（缺失则不输出）：\n\n* 主播介绍\n* 产品介绍（设计理念、主要内容、功能）\n* 客户痛点分析\n* 价值传递（政策解读、环境分析、事实分享）\n* 价格和促销\n* 购买指导\n* 权威背书\n* 效果承诺\n* 互动引导\n* 答疑解惑\n* 成功案例\n* 知识讲解\n* 其他内容\n\n（3） 金句词典：按话术目标划分，为每个目标提取出5-10句最值得学习的话术。 \n\n-提高停留时长的话术（在直播间停留的时间）\n-提高购物袋点击率的话术（了解商品详情）\n-提高商品下单率的话术（最终成交转化率）\n-提高转发量的话术（转发直播间）\n-提高互动的话术（点赞/评论）\n-提高涨粉量的话术（关注主播/直播间）\n### 金句提取规则：\n1阅读脚本/文档，按照内容表达的意思截取片段。\n-一个片段要表达完整的意思，可以是一句话也可以是多句话。\n\n2根据五项原则评选，把符合全部五项标准的片段筛选出来，数量不限。\n（1）明确击中用户痛点/需求，引起共鸣\t\n（2）含数字、场景、参数等具体信息，拒绝空话、废话、行业黑话\n（3）简洁且生动的表达，使用类比、举例、故事等手法让难懂的信息，直击人心\n（4）强烈情绪感染力或 触发FOMO \n(5)\t不夸大、不违规、不踩广告法红线\n\n3 将筛选出来的候选片段，再次筛选。\n对每个候选句，快速自问 3 句话：\nQ1：如果我是用户，听到这句会立刻想了解更多或下单吗？\nQ2：一句话能否脱离上下文仍然含义完整、易于理解？\nQ3：换作类似的商品，是否只替换少量关键词就能复用？\n\n4 如果筛出的片段因为转写、口语化等问题出现错字、病句，修复后再输出\n\n\n\n# 审核\n- **违规筛查**：是否出现{黑词库}中词汇（如“绝对有效”“根治”）。  \n- **示例（若存在违规）**：  \n  不建议话术：“这款减肥茶7天必瘦10斤”（违反广告法极限词）。  \n  改进示例：“多位用户反馈1个月平均减重5斤，具体效果因人而异”（数据弱化+免责声明）。  \n- \"虚假/夸大宣传：以“无门槛、轻松赚钱、月入过万”为噱头，诱导用户购买课程。\n- \"称呼观众：需要兼顾专业性与亲和力，符合观众的身份。\n推荐使用：称呼观众及直播主播表述需要符合教育直播间风格，同时避免非视频号外其他直播平台的专属表述：朋友们、家长们、同学；\n避免使用：小伙伴、亲、宝宝、姐妹；\n\n直播间引导话术避免非视频号的其他直播平台专属表述，如【小黄车】（抖音的购物车功能），应表达为【购物袋】【x号链接】这种\"\n\n# 输出提示\n1. 均采用markdown语法，不使用html语法，注意换行，所有符号采用英文符号，不使用加粗*，禁止使用<br>\n2. 所有内容均要符合中国广告法\n3. 在涉及到生成文稿这种环节，记得一分钟对应的文稿字数至少在150字，别写少了\n4. 输出的时候注意编号顺序，注意输出的完成性\n5. 把认为写的最吸引人的部分加粗 \n# 警告\n关于字数，必须每分钟的内容达到240个中文字以上，否则使用该文稿的主播将会失业，会没有钱吃饭，连他养的可爱小猫都只能去流浪了。请你一定要尽全力生成，确保每分钟的文稿大于240字。\n",
        "reasoningEffort": "high",
        "enableUserPrompt": true,
        "historyMessageRole": false,
        "historyMessageTime": false,
        "historyMessageCount": 10
      },
      "outputTypes": [
        {
          "name": "message",
          "type": {
            "type": "string",
            "isRequired": true
          }
        }
      ],
      "isEditComplete": true
    },
    "size": {
      "width": 350,
      "height": 344
    },
    "view": "react-shape-view",
    "ports": {
      "items": [
        {
          "id": "b8681199-24ea-4247-8095-4271c3db997a",
          "attrs": {
            "fo": {
              "random": 0.9204668808909957
            }
          },
          "group": "left"
        },
        {
          "id": "f6e87b8e-9aaa-4124-95a9-7bb9c010198c",
          "attrs": {
            "fo": {
              "random": 0.2115639910857403
            }
          },
          "group": "right"
        }
      ],
      "groups": {
        "left": {
          "attrs": {
            "fo": {
              "x": -5,
              "y": -5,
              "width": 10,
              "height": 10,
              "magnet": true
            },
            "circle": {
              "r": 5,
              "fill": "#1F6DFF",
              "magnet": true,
              "stroke": "#1F6DFF"
            }
          },
          "position": "left"
        },
        "right": {
          "attrs": {
            "fo": {
              "x": -5,
              "y": -5,
              "width": 10,
              "height": 10,
              "magnet": true,
              "allowConnect": false
            }
          },
          "position": "right"
        }
      }
    },
    "shape": "llm-completion",
    "zIndex": 78,
    "position": {
      "x": -2503,
      "y": -857
    },
    "portMarkup": [
      {
        "tagName": "foreignObject",
        "children": [
          {
            "ns": "http://www.w3.org/1999/xhtml",
            "attrs": {
              "xmlns": "http://www.w3.org/1999/xhtml"
            },
            "style": {
              "width": "100%",
              "height": "100%",
              "background": "transparent"
            },
            "tagName": "body",
            "children": [
              {
                "style": {
                  "width": "100%",
                  "height": "100%"
                },
                "tagName": "div",
                "selector": "foContent"
              }
            ],
            "selector": "foBody"
          }
        ],
        "selector": "fo"
      }
    ]
  }
};
