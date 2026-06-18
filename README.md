# 上桌 PokerLife PWA MVP

上桌 PokerLife 是一个以现实任务为入口、以扑克牌结算为奖励机制、以积分余额约束现实开销的个人行动 PWA。

这个仓库当前保存的是 MVP 初始可运行版本，适合作为未来迭代前的基线快照。

## 代码结构

```text
index.html          页面入口与脚本加载顺序
app.js              应用状态协调、业务流程、页面渲染与事件
js/core.js          日期边界、牌组、牌型评分与推荐算法
js/analytics.js     余额与趋势统计聚合
js/storage.js       默认状态、本地存储与备份恢复
styles.css          全局视觉与响应式样式
sw.js               PWA 离线缓存
```

## 当前功能

- 首次使用初始化余额
- 任务添加、完成、编辑、删除
- 完成任务获得抽牌机会
- 抽 1 张 / 全部抽完
- 未结算牌堆展示与整理
- 5 张牌结算与系统推荐最高分牌组
- “以小博大”：每日可放弃普通结算，保留 4 张牌到次日
- 每日 00:30 强制收盘：自动抽完未使用机会并按推荐连续结算
- 大王、小王作为万能牌参与结算
- 积分收入、支出抵扣、余额调整
- 最近 7 天 / 30 天趋势统计
- 历史记录归档
- 本地存储
- 导出 / 导入备份
- 重置数据
- PWA manifest 与 service worker 基础配置

## 运行方式

这是一个零依赖静态版本，所有核心代码都在同一目录中。

在电脑上可以直接打开：

```text
index.html
```

如果需要测试 PWA 安装、离线缓存或手机端添加到主屏幕，建议通过 HTTPS 静态站点访问，例如 GitHub Pages、Cloudflare Pages、Netlify 或 Vercel。

## 需要发布的文件

```text
index.html
app.js
js/core.js
js/analytics.js
js/storage.js
styles.css
manifest.webmanifest
sw.js
icon.svg
icon-192.png
icon-512.png
card-back-ui.png
README.md
.gitignore
PWA-MVP产品规格.md
MVP规格文档.md
产品文档.md
```

## 数据说明

第一版使用浏览器本地存储保存数据，不包含账号系统和云同步。

重要数据请定期在设置中使用“导出备份”。导入备份会恢复完整应用状态。

## 建议版本标签

初始可运行版本建议标记为：

```text
v0.1.0
```
