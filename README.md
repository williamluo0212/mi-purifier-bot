# 小米全球空气净化器缺货日报 → 飞书

每天早上自动巡检 **37 个**面向消费者的全球小米官网（mi.com），检查「空气净化器」品类里**整机 + 滤芯等配件**有没有缺货，做成一张飞书卡片推到指定飞书群。

不需要自己开电脑、不需要服务器、不需要数据库，跑在 GitHub 白送的机器上。

## 看板长什么样

- 蓝色标题栏：`🌬️ 小米空气净化器缺货日报 · 日期`
- 开头一行总结：缺货 X 国 · 有货 Y 国
- 按区域分组，每国一行状态：
  - 🟢 有货
  - 🔴 缺货（并展开列出**具体缺货的型号**，含滤芯/配件）
  - ⚪ 无空气净化器品类（如台湾/俄罗斯当前没有该品类）
  - ⚫ 查询失败
- 底部注明数据来源

## 覆盖的国家（37 个）

| 区域 | 国家 |
|---|---|
| 东亚 | 中国香港、中国台湾、日本、韩国、澳大利亚 |
| 东南亚 | 马来西亚、菲律宾、新加坡、泰国、越南 |
| 印度尼西亚 | 印度尼西亚 |
| 南亚 | 印度 |
| 西欧 | 英国、德国、法国、意大利、西班牙、荷兰、比利时、奥地利 |
| 东北欧 | 捷克、匈牙利、波兰、罗马尼亚、塞尔维亚、瑞典、希腊、乌克兰 |
| 独联体 | 俄罗斯、哈萨克斯坦 |
| 中东 | 土耳其、沙特阿拉伯 |
| 非洲 | 摩洛哥 |
| 拉美 | 墨西哥、哥伦比亚、智利、秘鲁 |

> 说明：台湾、俄罗斯当前官网分类树里**没有空气净化器品类**，脚本会自动跳过并标记 ⚪，不会报错。小米日后上架时会自动纳入。

## 技术原理（怎么判断缺货）

小米各地官网是纯 JS 渲染的 SPA，抓 HTML 拿不到商品。但它前端有一套统一的商品接口：

1. `https://{域名}/v2/item/category/nav` → 拿分类树，按 `category_tag === "air-purifier"` 动态查到该国的品类 id（各国 id 不同，不写死）
2. `https://{域名}/search/product-list?cat_id=...&page_index=0&page_size=100&type=2&version=v4&cacheable=1` → 拿该品类全部商品

每个商品的 `has_store` 字段：`1` = 有货，`0` = 缺货。

> 各国接口域名不同，已逐个探测写进 `countries.json` 的 `domain` 字段（主要三套：`ams-go.buy.mi.com/xx`、`go.buy.mi.com/xx`、以及印度/印尼/俄罗斯的独立域名）。

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

```bash
cd 项目目录
node mi-purifier-bot.js --dry-run          # 只打印，不发飞书
node mi-purifier-bot.js                    # 真正发送
node mi-purifier-bot.js --only=uk,de,in    # 只巡检指定国家（调试）
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
