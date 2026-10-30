# 小米空净米网缺货日报 → 飞书

每天早上自动巡检 **33 个**面向消费者的全球小米官网（mi.com），检查「空气净化器」品类里**主机（整机）**有没有缺货，做成一张飞书卡片推到指定飞书群。

> 只巡检**空气净化器主机**：滤芯、滤芯套装（如「4 Lite + Filter」）、捆绑套装（如「净化器 + 吸尘器」）、净水器等非主机商品会自动剔除，不进看板。

不需要自己开电脑、不需要服务器、不需要数据库，跑在 GitHub 白送的机器上。

## 看板长什么样

- 蓝色标题栏：`🌬️ 小米空净米网缺货日报 · 日期`
- 开头一行 **TOP3 缺货品类数量**：缺货款数最多的 3 个国家
- 按区域分组，每国一行状态（含**该国缺货率 X%** = 缺货主机数 / 上架主机数）：
  - 🟢 有货
  - 🔴 缺货（并展开列出**具体缺货的型号**）
  - ⚪ 无空气净化器品类 / 无商品
  - ⚫ 查询失败（接口没应答时如实报失败，不会假装有货）
  - 「仅精选 N 款」→ 该国全量索引拿不到时的兜底数据，只含官网精选的几款，不代表全部
- 底部注明数据来源

## 覆盖的国家（33 个）

| 区域 | 国家 |
|---|---|
| 东亚 | 中国香港、日本、韩国、澳大利亚 |
| 东南亚 | 马来西亚、菲律宾、新加坡、泰国、越南 |
| 印度尼西亚 | 印度尼西亚 |
| 西欧 | 英国、德国、法国、意大利、西班牙、荷兰、比利时、奥地利 |
| 东北欧 | 捷克、匈牙利、波兰、罗马尼亚、塞尔维亚、瑞典 |
| 独联体 | 哈萨克斯坦 |
| 中东 | 土耳其、阿联酋、沙特阿拉伯 |
| 非洲 | 摩洛哥 |
| 拉美 | 墨西哥、哥伦比亚、智利、秘鲁 |

> 说明：只统计有空气净化器品类的市场；台湾、俄罗斯当前官网没有该品类，已从清单移除。

## 技术原理（怎么判断缺货）

小米各地官网是纯 JS 渲染的 SPA，抓 HTML 拿不到商品。但它前端有一套统一的商品接口：

1. `https://{域名}/v2/item/category/nav` → 拿分类树，按 `category_tag === "air-purifier"` 动态查到该国的品类 id（各国 id 不同，不写死）
2. `https://{域名}/search/product-list?cat_id=...&page_index=0&page_size=100&type=2&version=v4&cacheable=1` → 拿该品类**全量**商品（优先用这个）
3. 兜底：`https://{域名}/v2/cms/category/navigation/products?cate_id=...` → 个别站点全量索引为空时回退到这个**品类导航精选接口**，它只有官网精选的几款，结果会标注「仅精选 N 款」，不冒充全量

每个商品的 `has_store` 字段：`1` = 有货，`0` = 缺货（按 `has_store !== 1` 判缺货，宁可多报不漏报）。接口没应答时该国显示 ⚫ 查询失败，**不会**装作有货或无货。

> 各国接口域名不同，已逐个探测写进 `countries.json` 的 `domain` 字段。注意部分站点的接口路径带语言后缀（如 `be-fr`/`kz-ru`/`ae-en`/`sa-ar`/`ma-fr`），写错成无后缀旧路径（`be`/`kz`/`ae`/`sa`/`ma`）会导致全量索引为空。

## 密钥配置

只要一个密钥：飞书的群机器人 webhook。

| 密钥 | 哪来的 | 存在哪 |
|---|---|---|
| FEISHU_WEBHOOK | 飞书群 → 设置 → 群机器人 → 添加自定义机器人 | 本地 `config.local.json` + GitHub Secrets |

读取优先级：**环境变量 > config.local.json**。

- GitHub 上跑 → Secrets 注入成环境变量
- 本地跑 → 读 `config.local.json`（已在 `.gitignore`，不提交）

## 怎么跑

### 本地

需要 **Node.js ≥ 18**（用到全局 fetch），无需 npm install。

```bash
cd 项目目录
node mi-purifier-bot.js --dry-run          # 只打印，不发飞书
node mi-purifier-bot.js                    # 真正发送
node mi-purifier-bot.js --only=uk,de,jp    # 只巡检指定国家（调试，代码见 countries.json 的 cc 字段）
```

### GitHub Actions 定时

1. 把项目推到 GitHub 私有仓库
2. Settings → Secrets and variables → Actions → 新建 `FEISHU_WEBHOOK`
3. 定时分两层（因为 GitHub 自带 schedule 不靠谱）：
   - **主力**：cron-job.org 每天北京时间 09:00 调 GitHub API 触发 `workflow_dispatch`
   - **兜底**：workflow 里 4 个 cron（09:07 / 09:27 / 09:47 / 10:17）
   - **去重**：guard 步骤查当天有没有成功发过，发过就跳过，一天最多一条
4. 手动触发：仓库 → Actions → 小米空气净化器缺货日报 → Run workflow（勾 `force` 可强制重发）

## 文件说明

| 文件 | 干嘛的 |
|---|---|
| mi-purifier-bot.js | 主程序，不用改 |
| countries.json | 国家清单（含各国接口域名），想增删国家改这里 |
| .github/workflows/mi-purifier.yml | 推送任务：兜底定时、去重、force 开关 |
| config.local.json | 你的 webhook，不要给别人看，已在 .gitignore |
| config.local.example.json | 配置模板 |

## 常见问题

- 飞书报 `code=19024` → 你开了「自定义关键词」，但消息里没有那个词。检查关键词是不是「空气净化器」或「缺货」（卡片标题里一定有）。
- 飞书报 `code=9499` → JSON 格式不对，一般是 webhook 地址粘错了。
- 某国显示「无净化器品类」→ 该站当前确实没这个品类，不是报错。
- 某国显示「查询失败」→ 一般是该站接口临时改版或网络抖动，下一天会重试。
