# Derek Dashboard 动态生成规则

## 概述

`public/derek/` 目录下存放的是 Derek 平台的静态 HTML Deal Memo 页面，每个页面对应一家公司的交易备忘录（Deal Memo）或信贷备忘录（Credit Memo）。这些页面目前完全硬编码，需要由 LLM 根据公司财务数据动态生成。

---

## 页面类型

### 类型 A：M&A Deal Memo（并购交易备忘录）
**示例文件：** `dealmemo-cci.html`、`dealmemo-cciv1.1.html`、`dealmemo-cciv1.2.html`

适用场景：私募股权/并购中介为潜在买方准备的卖方公司财务分析文档。

### 类型 B：Credit Memo（信贷备忘录）
**示例文件：** `dealmemo-mobilemind.html`、`dealmemo-sagacity.html`、`dealmemo-shoreless.html`、`dealmemo-valkre.html`

适用场景：贷款机构对借款方进行信用评估的内部文件，含合规条款、借款基础和 AI 问答面板。

---

## 页面结构总览

### 类型 A（Deal Memo）页面结构

```
1. Passcode Gate（密码门）
2. Top Bar（顶部导航栏）
3. Deal Header（交易头部）
4. KPI Cards（关键指标卡片，4 个）
5. Detailed Income Statement（多年详细损益表）
6. P&L Summary + EBITDA Bridge（利润摘要 + EBITDA 调整瀑布图）
7. Cash Flow + Balance Sheet（现金流 + 资产负债表）
8. Revenue & EBITDA Trend（收入趋势图）
9. YTD Performance + Expense Breakdown（年初至今 + 费用分解）
10. Ownership Structure + Top Customers（股权结构 + 前客户）
11. Investment Thesis + Seller Notes（投资逻辑 + 卖方备注）
12. Growth Opportunities + Deal Structure（增长机遇 + 交易结构）
13. Revenue Concentration Visual（收入集中度可视化）
14. Footer + JS Scripts
```

### 类型 B（Credit Memo）页面结构

```
1. Passcode Gate（密码门）
2. Top Bar（含 Logo 图片、Deal Memo 下拉导航）
3. Left Sidebar Nav（左侧导航）
4. Hero Section（公司概况 + 5 个 KPI 卡片）
5. KPI Row（4 个卡片）
6. Facility Terms（贷款条款）
7. Covenants（财务条款监测）
8. Borrowing Base Certificate（借款基础证书）
9. Annual P&L（年度损益）
10. Monthly Financial Table（月度财务表格）
11. Balance Sheet（资产负债表）
12. Projections（财务预测）
13. Collateral / UCC（抵押品 / 统一商法典）
14. Cap Table（股权结构）
15. Risk Assessment（风险评估）
16. Business Overview（业务概述）
17. Top Customers（主要客户）
18. Management（管理团队）
19. AI Panel（右侧 AI 问答面板）
```

---

## 各模块动态生成规则

### 1. Passcode Gate（密码门）

| 字段 | 说明 |
|------|------|
| `gate-logo` 图标 | 根据行业选择 FontAwesome 图标（如 `fa-fire` 代表燃气/管道，`fa-brain` 代表科技/教育，`fa-golf-ball` 代表体育） |
| `gate-title` | 固定为 `Derek` |
| `gate-sub` | `{公司名称} — {文档类型}` + 换行 + `Enter passcode to access` |
| `gate-badge`（信贷类） | `CONFIDENTIAL — LENDER USE ONLY` |
| `gate-esapiens` | 固定：`Powered by eSapiens.AI`，链接 `https://esapiens.ai` |
| PASSCODE（JS） | 每个 memo 独立密码（如 `stm2026`） |
| sessionStorage key | 固定 `derek_unlocked` |

**M&A 类 Logo 区域：** 使用纯色图标框（`gate-logo`），颜色根据主题色变化
**信贷类 Logo 区域（可选）：** 显示贷款机构 Logo 图片（如 `golden-section-logo.png`），用 `<img>` 标签

---

### 2. Top Bar（顶部导航栏）

**M&A 类（dark 主题）：**

| 字段 | 说明 |
|------|------|
| 背景色 | `linear-gradient(90deg,#1e293b,#334155)` |
| 左侧图标 | `fa-chart-line`（固定） |
| Dropdown 触发点颜色 | 当前 memo 版本的主题色（active = `#06b6d4`，inactive = `#64748b`） |
| Dropdown 标题 | 当前 memo 名称（如 `Clean Combustion, Inc. 1.1`） |
| Dropdown 菜单项 | 同一公司所有版本的链接（如 v1.0、v1.1、v1.2），active 项高亮 |
| PDF 按钮 | `Export PDF`，调用 `exportCCIPDF()` |
| 右侧文字 | `CONFIDENTIAL — Derek` |

**信贷类（light 主题）：**

| 字段 | 说明 |
|------|------|
| 背景色 | `#ffffff`，底部 `1px border` |
| 左侧图标框 | 渐变色（`#0e7490` → `#22d3ee`），图标根据行业 |
| 标题 | `{公司名称} — {文档类型}` |
| 状态标签 | `Active`（绿色）、`Revenue-Based Term Loan`（橙色）等 |
| 机构 Logo | 贷款机构图片（如 `golden-section-logo.png`） |
| Deal Memo 下拉 | 列出同系列所有 memo 链接 |
| 日期标签 | `Mar 28, 2025 — Novated Note` 等关键日期 |

---

### 3. Deal Header（M&A 专用）

```
公司名称（h1）
副标题：Project {代号} · Prepared by Derek · {准备月份}
Badges：[行业标签] [城市, 州] [Founded 年份] [法律结构] [股东数量] [会计基础]
右侧：最新年度 Adj. EBITDA 数字（大字）
      Est. valuation range: ${低}M – ${高}M
```

**Badge 生成规则：**
- 行业 badge：加粗，带图标，使用 `deal-badge highlight` 样式
- 其他 badge：普通文字信息
- 常见字段：城市/州、成立年份、法律实体（S-Corp/C-Corp/LLC）、债务状况、股东数量、会计基础（Accrual/Cash）

---

### 4. KPI Cards（4 张卡片）

**M&A 类固定结构（4 张）：**

| 卡片 | kpi-label | kpi-value | kpi-sub |
|------|-----------|-----------|---------|
| 1 | `{最新年} Revenue` | `$XXM` | `▲/▼ XX%` vs 上一年 |
| 2 | `{最新年} Gross Margin` | `XX%` | 业务模式说明 |
| 3 | `{最新年} EBITDA` | `$XXM` | `XX% margin · Adj. EBITDA $XXM` |
| 4 | `Balance Sheet` | `$0 Debt` / `$XXM Debt` | `Equity $XXM · Cash $XXM` |

**信贷类 Hero KPIs（5 个，嵌在 hero 深色背景中）：**
- Outstanding Balance、TTM Revenue、Interest Rate、Maturity Date、Borrowing Base Cap 等贷款关键指标

**信贷类 KPI Row（4 张卡片，带颜色边框）：**
- 颜色类：`green`、`amber`、`blue`、`teal`、`red`
- 包含 `kpi-badge`（up/down/neutral）显示趋势

---

### 5. Detailed Income Statement（详细损益表）

**列头：** Line Item | 各年份（通常 4 年）| YTD（当前年）

**分区（带折叠 Toggle 按钮）：**

```
REVENUE（绿色图标）
  - 各收入细项（按产品/服务分类）
  - Total Revenue（highlight-row）
  - YoY Growth %

COST OF GOODS SOLD（橙色图标）
  - 各 COGS 细项
  - Total COGS（subtotal）
  - Gross Profit（highlight-row）
  - Gross Margin %

OPERATING EXPENSES（红色图标）
  - 各 OpEx 细项（薪资、保险、维修、租金、差旅、燃油、折旧等）
  - 小计行（subtotal）
  - Net Ordinary Income（highlight-row）

OTHER INCOME / EXPENSE（紫色图标）
  - 利息收入、资产出售收益、其他收入
  - 各项税费

NET INCOME（高亮行，带 Net Margin %）
```

**格式规则：**
- 负数用括号表示：`(249,479)`，带 `neg`（红色）样式
- 正数不加括号，带 `pos`（绿色）样式
- 所有数字使用 `JetBrains Mono` 字体（`.num` 类）
- YTD 列用蓝色 `#0369a1`
- 无数据显示 `—`（灰色）
- 特殊项目加 `.note-badge`（黄色小标注，如 `AB`=Add-back, `†`=注意事项）
- footnote 区域说明各标注含义

---

### 6. P&L Summary（利润摘要，4 年对比）

简化的损益表，包含：
- Revenue
- Total COGS
- Gross Profit + Gross Margin %
- Total OpEx
- Net Ordinary Income
- Depreciation（加回）
- **EBITDA + EBITDA Margin %**
- Net Income

---

### 7. EBITDA Bridge（调整 EBITDA 瀑布图）

结构：
```
Reported EBITDA: $X,XXX,XXX
+ [Add-back 项目名称]    [描述说明]    + $XXX,XXX
  ...
= Adjusted EBITDA: $X,XXX,XXX（XX% of {年份} revenue）
```

**常见 Add-back 类型（M&A）：**
- 家庭成员/非运营薪资（Family / Non-Op. Salaries）
- 个人用途资产（Hunting camp, Personal residence utilities）
- 个人旅行（Personal Travel）
- 高管人寿保险净保费（Officer Life Insurance net premium）
- 一次性奖金（One-time bonus）
- 非运营其他收入（减项）

**估值倍数展示（多倍数网格）：**

| Floor（如 5.0×） | Mid（如 6.0×） | Ceiling（如 7.0×） |
|-----------------|---------------|-------------------|
| $XX.XM          | $XX.XM        | $XX.XM            |

---

### 8. Cash Flow Summary（现金流摘要）

4 年对比表，含：
- Operating CF
- Investing CF
- Financing CF
- Net Cash Change（subtotal）
- Cash — End of Year
- Owner Distributions（sub-item）

---

### 9. Balance Sheet Snapshot

资产端：
- Cash & Equivalents
- Accounts Receivable
- Prepaid & Other Current
- Total Current Assets（subtotal）
- Net Fixed Assets
- 非流动资产（Life Insurance CSV、Notes Receivable 等）
- Total Assets（highlight）

负债及权益：
- Total Liabilities
- Total Equity
- Debt（零债务用绿色高亮）

---

### 10. Revenue & EBITDA Trend（趋势图）

使用纯 CSS 高度模拟柱状图（无图表库，M&A 类）或 Chart.js（信贷类）。

**M&A 类（纯 CSS）：**
- 每年 3 根柱子：Revenue（灰色）、Reported EBITDA（绿色）、Adj. EBITDA（青色）
- 柱子高度按比例计算：`value / max_revenue × 120px`
- 特殊年份标注（如一次性事件）

**信贷类：** 使用 `Chart.js` 绘制折线图 / 柱状图，数据从 JS 变量注入

---

### 11. YTD Performance（年初至今）

- YTD 时段说明（如 Jan 1 – Feb 26，57 天）
- 蓝色背景 YTD Revenue 大数字
- 年化推算（Annualized）
- YTD 损益简表
- 注意事项（季节性、数据不完整说明）

---

### 12. Expense Breakdown（费用分解）

表格：Category | Amount | % of Revenue

常见类别：薪资 & 工资税、保险（各类）、维修保养、租金、差旅餐饮、燃油、折旧、合同服务等

---

### 13. Ownership Structure（股权结构）

- 彩色堆叠进度条（占比可视化）
- 每位股东：姓名、职位、持股比例
- 若第一大股东持股 > 50%，显示 **Key Man Risk** 警告框（黄色）
- 内容：建议 earnout / 留任协议

---

### 14. Top Customers（主要客户）

多年对比表（通常 3 年），含：
- 排名、客户名称
- 各年收入
- % of 最新年收入
- NEW 标签（新增客户高亮绿色）

表格下方说明：
- 特别说明增长最快的客户
- 新增 MSA 合同
- 集中度百分比（如 Top 3 = 47% of revenue）

---

### 15. Investment Thesis（投资逻辑）

4-5 条，每条包含：
- 彩色图标框（`thesis-icon`，颜色各异）
- 加粗标题（`thesis-title`）
- 描述文字（`thesis-desc`，包含具体数字）

常见主题：财务表现、资产负债表强度、客户质量、商业模式护城河、Add-back 支撑

---

### 16. Seller Notes & Deal Considerations（卖方备注）

黄色背景框（`notes-box`），每条含图标：
- `fa-check-circle`：确认事项
- `fa-exclamation-circle`：需关注项
- `fa-piggy-bank`：现金/分配事项
- `fa-file-invoice-dollar`：应收款/票据
- `fa-umbrella`：保险事项
- `fa-map-marker-alt`：资产位置
- `fa-user-tie`：管理层留任

---

### 17. Growth Opportunities（增长机遇）

2-3 条，与 Investment Thesis 相同结构，重点描述：
- 产品扩展机会
- 地域扩张（含具体目标市场）
- 新合同/MSA 势头

---

### 18. Deal Structure Considerations（交易结构考量）

Checklist 格式，每项包含：
- 彩色图标框（绿色=优势，黄色=注意，紫色=需处理，红色=风险）
- 粗体标题
- 说明文字

常见项目：无债务清洁交割、关键人留任、关联方租约、个人资产剥离、营运资金基准、非经营性资产处置

---

### 19. Revenue Concentration Visual（收入集中度）

左侧：客户条形图
- 每个客户：名称（右对齐金额+百分比）+ 灰色背景条 + 彩色填充条（宽度 = 占比%）

右侧：两个信息框
- 客户亮点（蓝色背景）：emoji + 文字
- 集中度风险（黄色背景）：风险说明

---

### 20. Credit Memo 专有模块

#### Facility Terms（贷款条款）

两列布局，字段包括：
- Lender / Borrower
- Original Commitment / Novated Principal
- Facility Type（Revolving LOC、Term Loan、Revenue-Based 等）
- Original Close / Novation Date / Maturity Date
- Interest Rate / Revenue Share
- Prepayment / Default provisions
- Allonge / Assignment

#### Covenants（财务条款）

网格卡片，每张含：
- 条款名称
- 状态徽章（`pass` 绿色 / `warn` 黄色 / `fail` 红色 / `na` 灰色）
- Required vs Actual 对比
- 进度条可视化

常见条款：DSCR、Minimum Cash、Revenue Growth、Gross Margin、ARR Minimum

#### Borrowing Base Certificate（借款基础证书）

计算公式展示：
- Eligible Receivables
- Advance Rate
- = Borrowing Base
- vs Outstanding Balance
- = Availability

#### Monthly Financial Table（月度数据）

横向多列（12 个月），含 Revenue、Gross Profit、OpEx、Net Income

#### AI Panel（AI 问答面板）

右侧固定面板（宽约 325px），包含：
- 头部：Derek AI 标识 + "Context-Aware" 标签
- Chip 快捷问题（3-5 个，针对当前 memo 的关键问题）
- 消息区（idle 状态显示建议问题，active 显示对话）
- 输入框 + 发送按钮
- 打字动画

**Chip 问题应根据公司情况动态生成，例如：**
- "What is the DSCR trend?"
- "Explain the revenue concentration risk"
- "What are the key covenant concerns?"

#### Risk Assessment（风险评估）

列表形式，每项含：
- 风险等级徽章（`high`/`medium`/`low`）
- 风险标题 + 说明文字

---

### 21. 版本管理（同一公司多版本）

同一公司可以有多个版本（如 CCI v1.0、v1.1、v1.2），通常用于不同估值假设：

| 版本 | 差异点 |
|------|--------|
| v1.0 | 基准估值范围（如 `$25M – $36M`），严格 Add-back |
| v1.1 | 更高估值范围（如 `$27M – $38M`），增加 TBD Add-back 提示 |
| v1.2 | 进一步调整（如捐赠项 Add-back 确认后） |

所有版本共享相同财务数据，仅估值假设和叙述性语言不同。Top Bar Dropdown 列出所有版本，当前版本为 active 状态（且有不同颜色 dot）。

---

## 样式与技术规范

### 字体
- 正文：`Inter`（weights: 300/400/500/600/700/800/900）
- 数字/代码：`JetBrains Mono`（weights: 400/500/600）

### 色彩系统

**M&A 类（深色主题 topbar）：**
- Navy: `#0f172a`, `#1e293b`, `#334155`
- Slate accent: `#64748b`, `#475569`
- Green: `#10b981`（正数/增长）
- Red: `#ef4444`（负数/风险）
- Amber: `#f59e0b`（警告）
- Cyan: `#06b6d4`（最新/高亮版本）
- Blue: `#2563eb`（链接/特殊）

**信贷类（浅色主题）：**
- Navy: `#0c2340`
- Teal: `#0e7490`（主题色）
- Cyan: `#22d3ee`（accent）
- 使用 CSS `:root` 变量统一管理

### 依赖库（CDN 引入）
- Google Fonts（Inter + JetBrains Mono）
- FontAwesome 6.4.0（图标）
- Chart.js 4.4.0（信贷类图表，M&A 类不需要）
- html2canvas 1.4.1（PDF 截图）
- jsPDF 2.5.1（PDF 生成）
- 本地 CSS：`/derek/app.css`（共享基础样式）

### PDF 导出
- M&A 类：jsPDF 纯矢量文字（不用 html2canvas），手动绘制表格和文字
- 信贷类：可能使用 html2canvas 截图方式
- PDF 包含页眉（公司名 + Confidential + 章节）、页脚（页码 + 日期 + eSapiens.AI）

### 路由
- 文件名格式：`/derek/dealmemo-{slug}` → 对应 `public/derek/dealmemo-{slug}.html`
- 服务器 (`src/index.tsx`)：Hono 框架，仅处理少量重定向，静态文件由 Cloudflare Pages 直接提供

---

## LLM 生成输入数据结构（建议）

LLM 生成页面时，应接收以下结构化输入：

```typescript
interface DealMemoInput {
  // 基础信息
  type: 'ma' | 'credit';          // 页面类型
  slug: string;                   // URL slug（如 'cci', 'cciv1.1'）
  passcode: string;               // 访问密码
  version?: string;               // 版本标识（如 'v1.1'）
  siblings?: { slug: string; label: string }[];  // 同公司其他版本

  // 公司信息
  company: {
    name: string;                 // 公司全名
    projectCode: string;          // 代号（如 'CCI'）
    industry: string;             // 行业描述
    icon: string;                 // FontAwesome 图标名（如 'fire'）
    location: string;             // 城市, 州
    founded: string;              // 成立年份
    legalStructure: string;       // 法律实体
    accountingBasis: string;      // 会计基础
    preparedDate: string;         // 准备日期（如 'February 2026'）
    themeColor?: string;          // 主题色（hex）
  };

  // M&A 专有
  ma?: {
    adjEBITDA: number;            // Adj. EBITDA
    valuationRange: { low: number; high: number };
    ebitdaMultiples: { floor: number; mid: number; ceiling: number };
    addBacks: { label: string; detail?: string; amount: number }[];
    ownershipStructure: { name: string; title: string; pct: number }[];
    investmentThesis: { title: string; desc: string; iconBg: string; icon: string; iconColor: string }[];
    sellerNotes: { icon: string; html: string }[];
    growthOpportunities: { title: string; desc: string }[];
    dealStructure: { type: 'check'|'warn'|'issue'|'info'; title: string; desc: string }[];
  };

  // 信贷专有
  credit?: {
    lender: string;
    outstandingBalance: number;
    interestRate: string;
    facilityType: string;
    maturityDate: string;
    borrowingBase: string;
    covenants: { name: string; status: 'pass'|'warn'|'fail'|'na'; required: string; actual: string }[];
    aiChips: string[];            // 快捷问题
    lenderLogo?: string;          // Logo 图片路径
  };

  // 财务数据
  financials: {
    years: string[];              // 历史年份（如 ['2022','2023','2024','2025']）
    ytdPeriod?: string;           // 如 'Jan 1–Feb 26, 2026 (57 days)'
    revenue: { label: string; values: (number|null)[] }[];
    cogs: { label: string; values: (number|null)[]; isAddback?: boolean }[];
    opex: { label: string; values: (number|null)[]; isAddback?: boolean; notes?: string[] }[];
    otherIncome: { label: string; values: (number|null)[] }[];
    cashFlow?: { label: string; values: (number|null)[] }[];
    balanceSheet?: {
      date: string;
      assets: { label: string; value: number; isSubtotal?: boolean }[];
      liabilities: { label: string; value: number }[];
      equity: number;
      debt: number;
    };
  };

  // 客户数据
  customers: {
    rank: number;
    name: string;
    values: (number|null)[];      // 与 financials.years 对齐
    pctLatest: number;
    isNew?: boolean;
    newLabel?: string;
  }[];
}
```

---

## 生成注意事项

1. **数字格式**：所有金融数字使用千位分隔符（`1,234,567`），负数用括号（`(234,567)`）而非负号
2. **百分比**：保留 1 位小数（如 `33.5%`），YoY 增长用 `+15.8%` / `–3.6%`
3. **YTD 数据**：标注期间天数，数字用蓝色（`#0369a1`），注明为不完整期间
4. **Add-back 标注**：加 `.note-badge` 标签，footnote 区域说明
5. **版本间差异**：同公司多版本时，仅估值假设和部分叙述文字不同，财务数据保持一致
6. **密码**：每个 memo 应有独立密码，存储在 JS 变量 `PASSCODE` 中
7. **PDF 功能**：M&A 类使用 jsPDF 纯矢量方式，页眉需包含公司名、章节标题、页码
8. **响应式**：所有页面在 <900px 宽度下网格折叠为单列
9. **AI Panel**（仅信贷类）：Chip 问题应基于公司实际数据定制，不应生成通用问题
10. **Passcode sessionStorage**：解锁后存储到 `sessionStorage('derek_unlocked', '1')`，刷新页面不需重新输入

---

## 通用生成规则

以下规则适用于所有 memo 类型（M&A 和 Credit），是 LLM 生成任何页面时必须遵守的基础逻辑。

---

### 一、固定内容 vs 动态内容

#### 永远固定（逐字复用，不得修改）

| 内容 | 固定值 |
|------|--------|
| eSapiens 链接文字 | `Powered by eSapiens.AI` |
| eSapiens 链接地址 | `https://esapiens.ai` |
| Gate 标题 | `Derek` |
| sessionStorage key | `derek_unlocked` |
| sessionStorage value | `'1'` |
| 字体引入 | Inter + JetBrains Mono（Google Fonts CDN） |
| FontAwesome 版本 | `6.4.0`（jsdelivr CDN） |
| jsPDF 版本 | `2.5.1`（cdnjs CDN） |
| html2canvas 版本 | `1.4.1`（cdnjs CDN） |
| Chart.js 版本 | `4.4.0`（jsdelivr CDN，仅信贷类） |
| 共享样式表 | `/derek/app.css` |
| Footer 保密声明 | `CONFIDENTIAL — For Discussion Purposes Only` |
| Footer 工具署名 | `Prepared by Derek · eSapiens.AI` |

#### 必须动态生成（每个 memo 独立）

- 公司名称、行业、地点、法律结构、成立年份
- 所有财务数字（收入、利润、资产等）
- 密码（`PASSCODE` 变量）
- 估值范围 / 贷款余额等核心指标
- 投资逻辑、卖方备注、风险评估等叙述内容
- Dropdown 中的 memo 列表（当前版本标 active）
- PDF 页眉中的公司名和章节标题
- 行业图标（FontAwesome icon 名）

---

### 二、颜色语义规则（全局统一）

以下颜色含义在所有模块中保持一致，不因公司或类型而改变：

| 颜色 | Hex | 语义 | 使用场景 |
|------|-----|------|---------|
| 绿色 | `#10b981` / `#059669` | 正面、增长、通过 | 正数、YoY 增长、Covenant pass、零债务高亮、新客户标注 |
| 红色 | `#ef4444` / `#dc2626` | 负面、下降、风险 | 负数、YoY 下降、Covenant fail、高风险标签 |
| 黄色/琥珀 | `#f59e0b` / `#d97706` | 警告、待确认、注意 | Key Man Risk、一次性事件标注、Covenant warn、卖方备注框背景 |
| 蓝色 | `#2563eb` / `#0369a1` | YTD、预测、当前 | YTD 列数字、预测数据、部分高亮 |
| 青色 | `#06b6d4` / `#0e7490` | 信贷类主题、Adj. EBITDA | Adj. EBITDA 柱/折线、信贷类 topbar icon、active 版本 dot |
| 灰色 | `#64748b` / `#94a3b8` | 中性、历史、缺失 | 无数据`—`、次要文字、非 active 版本 dot |
| 紫色 | `#8b5cf6` | 特殊分类 | Other Income/Expense 区段图标 |

**规则：**
- 表格中数字颜色仅由正负决定，不受行业或公司类型影响
- 背景框颜色语义：绿底 = 优势/通过，黄底 = 警告，红底 = 风险，蓝底 = YTD/信息
- 状态 badge 颜色与上表一致，`pass`=绿，`warn`=黄，`fail`=红，`na`=灰

---

### 三、数据推导规则（从数字到内容）

LLM 在生成叙述性文字、警告提示、状态判断时，必须依据以下规则从输入数据推导，不得凭空编写。

#### 3.1 KPI 趋势标注

| 条件 | 显示 |
|------|------|
| YoY Revenue 增长 > 0 | `▲ XX%`，绿色（`.kpi-up`） |
| YoY Revenue 下降 | `▼ XX%`，红色（`.kpi-down`） |
| Gross Margin > 90% | kpi-sub 注明"高毛利/Service-led model" |
| Gross Margin 50%~90% | kpi-sub 注明毛利水平，不加特别描述 |
| Gross Margin < 50% | kpi-sub 需注明原因 |
| Debt = 0 | kpi-value 显示 `$0 Debt`，绿色高亮框 |
| Debt > 0 | kpi-value 显示实际债务金额，无特殊高亮 |

#### 3.2 EBITDA Bridge Add-back 识别规则

以下类型的费用，若在财务数据中被标注为 `isAddback: true`，则必须出现在 EBITDA Bridge 中：

| Add-back 类型 | 判断依据 |
|--------------|---------|
| 家庭成员薪资 | 姓名与股东同姓或输入数据明确标注 |
| 个人资产费用 | 标注为个人娱乐、狩猎、私人住所等 |
| 个人差旅 | 标注为非业务性旅行 |
| 高管人寿保险 | 标注为 Officer Life Insurance，且有对应 CSV 增值 |
| 一次性事件 | 明确标注 one-time，需在 footnote 中说明 |
| 非经营性收入 | Other Income 中的利息、资产出售等需从 Adj. EBITDA 中**减去** |

**Add-back 总额 = 各项加回之和 − 非经营性收入**
**Adj. EBITDA = Reported EBITDA + Add-back 总额**
**Adj. EBITDA Margin = Adj. EBITDA / 最新年 Revenue**

#### 3.3 估值范围计算规则（M&A 类）

```
Floor = Adj. EBITDA × 最低倍数（通常 4.5× ~ 5.0×）
Mid   = Adj. EBITDA × 中间倍数（通常 5.5× ~ 6.0×）
Ceiling = Adj. EBITDA × 最高倍数（通常 6.5× ~ 7.0×）
```

倍数选择依据：
- 服务型、高毛利（>90%）、无债务 → 倍数区间上浮（5×~7×）
- SaaS / 软件类 → 倍数区间更高（6×~10×，基于 ARR 倍数）
- 重资产、制造类 → 倍数区间下调（3×~5×）
- 客户集中度高（top 3 > 50%）→ 倍数区间下调 0.5×
- 关键人风险（单一股东 > 70%）→ 倍数区间下调 0.5×

版本差异规则：
- v1.0：基准倍数，Add-back 仅含已确认项
- v1.1：倍数上调 0.5×~1×，Add-back 加入"TBD"待确认项
- v1.2：Add-back 全部确认后，重新计算估值区间

#### 3.4 风险与警告触发规则

以下条件自动触发对应提示，LLM 不需人工判断：

| 触发条件 | 提示类型 | 位置 |
|---------|---------|------|
| 最大股东持股 > 50% | Key Man Risk 黄色警告框 | Ownership 模块 |
| Top 3 客户 > 50% 收入 | 集中度风险黄色框 | Revenue Concentration 模块 |
| 单一客户 > 25% 收入 | 在该客户行加高亮，footnote 说明风险 | Top Customers 表格 |
| 某年出现一次性事件（奖金/坏账/资产出售）| 该年加 note-badge，footnote 说明 | 损益表 |
| YTD 数据不完整（< 6 个月）| 蓝色提示框 + "incomplete period" 注明 | YTD 模块 |
| Debt > 0 | Deal Structure 中列出偿债/担保安排 | Deal Structure 模块 |
| 存在关联方交易（租约/贷款等）| Seller Notes 中单独列出 | Seller Notes 模块 |
| Covenant fail（信贷类）| 红色 fail badge + 在 Risk Assessment 中列为 high | Covenants 模块 |

#### 3.5 Investment Thesis 生成规则

按以下优先级选取 4~5 条，每条须包含具体数字：

| 优先级 | 条件 | 标题方向 |
|-------|------|---------|
| 1 | 最新年 Revenue YoY > 10% | "强劲收入增长" |
| 2 | Gross Margin > 90% | "超高毛利/Asset-light 模式" |
| 3 | Debt = 0，Equity > 0 | "无债务、强健资产负债表" |
| 4 | 所有主要客户为投资级 / 世界500强 | "蓝筹客户群体，粘性强" |
| 5 | Adj. EBITDA Margin > 30% | "卓越盈利能力" |
| 6 | Add-back 总额 > $300K | "显著 Add-back 支撑估值" |
| 7 | 新客户/新合同 | "MSA/合同管线持续扩张" |
| 8 | 多年稳定分红/现金流 | "强劲、可预期现金回报" |

每条描述必须引用具体数字，如：
> "Revenue grew **15.8% YoY** to $13.6M — strongest year on record. Gross margin consistently >97%."

不得写模糊表述，如：
> ~~"The company has strong revenue growth and good margins."~~

#### 3.6 Seller Notes 生成规则

Seller Notes 内容来源于输入数据中的特殊标注，LLM 应将以下类型的数据转化为具体备注：

| 数据类型 | 对应 Seller Note 内容 |
|---------|----------------------|
| Add-back 已确认金额 | "Add-backs estimated at ~$XXX,XXX (within ±5% accuracy)" |
| 一次性重大事件 | 单独列出，说明年份和金额，注明"must be normalized" |
| 现金/货币市场账户 | 说明卖方用途（偿债/保留），以及交易中的营运资金基准 |
| 票据应收款（Note Receivable）| 说明为非经营性资产，建议在交易结构中排除 |
| 人寿保险 CSV | 说明归属股东，建议交割前处理 |
| 关联方资产（租约/土地）| 说明性质，建议尽职调查确认 |
| 管理层留任需求 | 若 Key Man Risk 触发，自动加入 earnout/retention 建议 |

---

### 四、行业适配规则

LLM 应根据公司所属行业，选择对应的图标、颜色偏好和叙述角度：

| 行业类型 | Gate/Hero 图标 | 主题强调色 | 投资逻辑角度 |
|---------|--------------|----------|------------|
| 管道/燃气/工业服务 | `fa-fire` / `fa-industry` | `#64748b`（钢铁灰）| 蓝筹客户、合同稳定性、地理扩张 |
| SaaS / 软件 | `fa-brain` / `fa-code` | `#0e7490`（青色）| ARR、Net Revenue Retention、客户扩张 |
| 教育科技（EdTech）| `fa-graduation-cap` | `#0e7490` | 学区客户、续约率、政府拨款 |
| 体育/高尔夫/消费 | `fa-golf-ball` / `fa-trophy` | `#059669`（绿）| 会员经济、季节性、品牌价值 |
| 制造业 | `fa-cogs` / `fa-tools` | `#475569` | 产能利用率、原材料成本、客户集中度 |
| 金融科技 | `fa-chart-line` | `#2563eb`（蓝）| 交易量、合规、监管风险 |
| 医疗健康 | `fa-heartbeat` | `#dc2626`（红）| 报销比例、监管合规、患者留存 |
| 物流/运输 | `fa-truck` | `#d97706`（橙）| 路线效率、燃油成本、合同稳定性 |

---

### 五、布局选择规则

以下规则决定模块的网格布局：

| 内容特征 | 使用布局 |
|---------|---------|
| 两个并列对比模块（如 P&L + EBITDA Bridge） | `section-grid`（1fr 1fr） |
| 三个并列小模块 | `section-grid-3`（1fr 1fr 1fr） |
| 需要宽表格或可视化图表 | `section-full`（全宽） |
| 4 个 KPI 卡片 | `deal-kpis`（repeat(4, 1fr)） |
| 客户 3 列展示 | `customer-grid`（repeat(3, 1fr)） |

**响应式折叠规则（<900px）：**
- 所有 `section-grid`、`section-grid-3` → 单列
- `deal-kpis` → `repeat(2, 1fr)`
- `customer-grid` → `1fr 1fr`
- 信贷类左侧导航隐藏，AI Panel 隐藏

---

### 六、数字一致性规则

同一份 memo 中相同指标必须保持精确一致，LLM 生成前应先计算出所有关键数字，再填入各模块：

```
Total Revenue = sum(各收入细项)
Gross Profit  = Total Revenue − Total COGS
Gross Margin% = Gross Profit / Total Revenue × 100
Total OpEx    = sum(各 OpEx 细项)
Net Ord. Income = Gross Profit − Total OpEx
EBITDA        = Net Ord. Income + Depreciation
Adj. EBITDA   = EBITDA + sum(Add-backs) − Non-Op. Income
Adj. EBITDA % = Adj. EBITDA / Total Revenue × 100
Valuation Low = Adj. EBITDA × floor_multiple
Valuation High = Adj. EBITDA × ceiling_multiple
```

以上数字必须在以下所有位置保持一致：
- Deal Header 右侧大数字 = EBITDA Bridge 底部 Adj. EBITDA
- KPI Card "2025 EBITDA" = P&L Summary 中 EBITDA 行
- KPI Card "Revenue" = 损益表 Total Revenue 行
- 估值范围 = floor 到 ceiling 计算值（四舍五入到 $0.5M）
- Top Customers 合计行 = 各客户金额之和
- 收入集中度百分比 = Top N 客户合计 / Total Revenue

---

### 七、叙述文字质量规则

所有非表格文字（标题、描述、备注）遵循以下规则：

1. **必须具体**：每条描述包含至少一个具体数字，不写模糊定性
2. **保持专业**：使用投资银行/信贷行业标准用语（EBITDA、YoY、LTM、MSA、earnout 等）
3. **英文输出**：所有页面内容（非注释）均为英文，与现有静态页保持一致
4. **长度控制**：`thesis-desc` / `risk-text` 控制在 2~3 句，`kpi-sub` 控制在 1 句
5. **数字格式统一**：文字中引用数字时，百万用 `$X.XM`，千用 `$XXK`，精确数用 `$X,XXX,XXX`
6. **避免重复**：Investment Thesis、Seller Notes、Growth Opportunities 三个模块不应重复同一事实，各有侧重：
   - Investment Thesis → 已有的优势与价值
   - Seller Notes → 需要在交易中特别处理的事项
   - Growth Opportunities → 未来可解锁的增量价值

---

### 八、HTML 结构规则

1. **`<style>` 内嵌**：每个页面的样式写在 `<head>` 内的 `<style>` 标签中，不引用外部私有样式文件（除 `/derek/app.css`）
2. **JS 内嵌**：所有脚本写在页面底部 `<script>` 标签中，包括：passcode 逻辑、dropdown 切换、P&L toggle（M&A 类）、PDF 导出函数
3. **无框架依赖**：页面为纯 HTML/CSS/JS，不使用 React、Vue 等框架
4. **ID 命名规范**：
   - 密码门：`#passcode-gate`（M&A）/ `#gate`（Credit）
   - 主内容区：`#mainPage` 或 `.dash-main`
   - 密码输入框：`#gateInput`
   - 错误提示：`#gateError` / `#gateErr`
   - PDF 按钮：`#pdfBtn`
5. **`display:none` 初始化**：主内容区默认隐藏，密码正确后由 JS 控制显示
6. **`overflow:hidden` on body**（信贷类）：页面为应用式布局，不滚动整页，内容区独立滚动
