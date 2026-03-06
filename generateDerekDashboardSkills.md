# Derek Dashboard 生成工作流 Skills

## 概述

本文档定义从「用户上传原始文件」到「生成完整 Derek Dashboard HTML 页面」的完整工作流。
用户上传数百个文件（QuickBooks 导出、财务报表、合同、尽职调查文件等），LLM 全程负责解析、提取、分析、生成。

**参考规则文档：** `generateDerekDashboard.md`

---

## 工作流总览

```
┌─────────────────────────────────────────────────────────────────┐
│  STAGE 1: 文件接收与分类                                          │
│  Input: 用户上传的原始文件（PDF/Excel/CSV/图片等）                  │
│  Output: 按类型归类的文件清单 + 处理优先级                           │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│  STAGE 2: 文档解析与数据提取                                       │
│  Input: 分类后的文件                                               │
│  Output: 结构化原始数据（per-file JSON）                            │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│  STAGE 3: 数据整合与规范化                                         │
│  Input: 多份文件的结构化数据                                        │
│  Output: 单一标准化 DealMemoInput JSON                             │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│  STAGE 4: 财务计算与指标推导                                       │
│  Input: DealMemoInput JSON                                       │
│  Output: 完整计算结果（EBITDA、Add-backs、估值、KPI 等）             │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│  STAGE 5: 叙述内容生成                                             │
│  Input: 计算结果 + 规则文档                                        │
│  Output: 投资逻辑、卖方备注、风险评估等文字内容                       │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│  STAGE 6: HTML 页面生成                                           │
│  Input: DealMemoInput + 叙述内容                                  │
│  Output: 完整 HTML 文件                                            │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│  STAGE 7: 校验与输出                                               │
│  Input: 生成的 HTML                                               │
│  Output: 通过校验的 HTML 文件 → 写入 public/derek/                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## STAGE 1：文件接收与分类

### 目标
识别上传的每个文件的类型和内容，确定数据提取策略和优先级。

### 输入
用户上传的原始文件，数量可达数百个，格式包括：
- `.pdf`（财务报表、税表、合同、贷款协议）
- `.xlsx` / `.xls`（QuickBooks 导出、Excel 财务模型、Add-back 明细）
- `.csv`（QuickBooks 报告、客户收入明细）
- `.png` / `.jpg`（扫描版财务文件、图片化报表）
- `.docx`（法律文件、描述性文件）

### LLM 调用：文件分类器

**Prompt 模板：**
```
你是一名专业的财务尽职调查分析师。请分析以下文件，判断其类型和包含的数据类别。

文件名：{filename}
文件内容（前500字）：{content_preview}

请返回 JSON：
{
  "file_type": "income_statement" | "balance_sheet" | "cash_flow" | "customer_revenue"
               | "addback_schedule" | "ownership_cap_table" | "loan_agreement"
               | "tax_return" | "bank_statement" | "contract_msa" | "description" | "unknown",
  "years_covered": ["2022", "2023", ...],  // 文件涵盖的年份
  "company_name": "...",                    // 识别到的公司名称
  "accounting_basis": "accrual" | "cash" | "unknown",
  "data_quality": "high" | "medium" | "low",  // 数据完整性评估
  "priority": 1-5,                          // 1=核心财务数据, 5=辅助参考
  "notes": "..."                            // 特殊说明
}
```

### 分类优先级定义

| Priority | 文件类型 | 说明 |
|---------|---------|------|
| 1 | 多年损益表 | 核心财务数据，必须提取 |
| 1 | 资产负债表 | 必须提取 |
| 1 | Add-back 明细 / Excel 调整表 | 估值计算关键 |
| 2 | 客户收入明细 | Top Customer 分析 |
| 2 | 现金流量表 | 辅助验证 |
| 3 | 股权结构 / Cap Table | Ownership 模块 |
| 3 | 贷款协议 / 合同条款 | Credit Memo 专用 |
| 4 | 税表 | 辅助验证，非主要来源 |
| 5 | 描述性文件、邮件等 | 背景信息 |

### 输出
```json
{
  "files": [
    {
      "filename": "CCI_P&L_2022-2025.xlsx",
      "file_type": "income_statement",
      "years_covered": ["2022", "2023", "2024", "2025"],
      "company_name": "Clean Combustion, Inc.",
      "accounting_basis": "accrual",
      "data_quality": "high",
      "priority": 1,
      "notes": "多年合并报表，含月度明细"
    },
    ...
  ],
  "company_name_confirmed": "Clean Combustion, Inc.",
  "memo_type_suggested": "ma",  // 或 "credit"
  "years_available": ["2022", "2023", "2024", "2025"],
  "missing_data_warnings": ["未找到现金流量表", "股权结构文件缺失"]
}
```

### 判断 Memo 类型

| 条件 | 判断结果 |
|------|---------|
| 存在贷款协议、Covenant 条款、借款基础文件 | Credit Memo |
| 存在 Add-back 明细、估值模型、买方分析 | M&A Deal Memo |
| 两者都有 / 不确定 | 提示用户确认 |

---

## STAGE 2：文档解析与数据提取

### 目标
从每个已分类的文件中提取结构化的原始财务数据。每种文件类型使用专属提取 Prompt。

### 2A：损益表提取

**Prompt 模板：**
```
你是专业财务分析师，请从以下财务报表中提取损益表数据。

文件内容：
{file_content}

提取规则：
1. 识别所有年份列（通常为 2022/2023/2024/2025）和 YTD 列
2. 识别收入细项、COGS 细项、OpEx 细项、其他收支
3. 负数统一用负数表示（不用括号），方便后续计算
4. 若某行某年为空/零，返回 null
5. 识别并标注异常项（一次性事件、负数薪资、异常大额等）

返回 JSON 格式：
{
  "years": ["2022", "2023", "2024", "2025"],
  "ytd": { "period": "Jan 1 – Feb 26, 2026", "days": 57 },
  "revenue": [
    { "label": "Sales – Services", "values": [9880898, 10628487, 10170640, 11839046, 1174499], "is_ytd_included": true }
  ],
  "cogs": [
    { "label": "Materials", "values": [-249479, -15648, -15831, -44098, -2764] }
  ],
  "opex": [
    {
      "label": "Salaries",
      "values": [-3036094, -5948337, -3095445, -3442786, -53938],
      "anomalies": ["2023年薪资异常偏高，疑似一次性奖金"]
    }
  ],
  "other_income": [
    { "label": "Interest Earned", "values": [42243, 123347, 125670, 54149, 5858] }
  ],
  "depreciation": [754156, 600000, 480000, 480000, null],
  "notes": ["2023年薪资包含约$2.8M一次性土地购买奖金"]
}
```

### 2B：Add-back 明细提取

**Prompt 模板：**
```
请从以下 Add-back 调整表中提取 EBITDA 调整项。

文件内容：
{file_content}

提取规则：
1. 识别每一条 Add-back 的名称、金额、说明
2. 区分"加回"（正向调整）和"减去"（负向调整，如非经营性收入）
3. 标注是否为已确认项（Confirmed）还是待确认（TBD/Pending QoE）
4. 若有按人员分列的薪资 Add-back，提取每人姓名和金额

返回 JSON：
{
  "addbacks": [
    {
      "label": "Family / Non-Op. Salaries",
      "detail": "Jessica H., Carmen H., Kaitlyn H., Jessica S., Mike N.",
      "amount": 106000,
      "direction": "add",
      "status": "confirmed"
    },
    {
      "label": "Officer Life Insurance (net premium)",
      "detail": "Non-cash / personal benefit",
      "amount": 202848,
      "direction": "add",
      "status": "confirmed"
    },
    {
      "label": "Total Other Income",
      "detail": "Interest, gain on asset sales — non-operating",
      "amount": 303029,
      "direction": "subtract",
      "status": "confirmed"
    },
    {
      "label": "Donations",
      "detail": "Pending QoE confirmation",
      "amount": null,
      "direction": "add",
      "status": "tbd"
    }
  ]
}
```

### 2C：客户收入明细提取

**Prompt 模板：**
```
请从以下客户收入明细中提取各客户的年度收入数据。

文件内容：
{file_content}

提取规则：
1. 识别每个客户名称
2. 提取各年收入金额（与损益表年份对齐）
3. 标注首次出现年份（用于判断是否为新客户）
4. 计算各客户占最新年 Total Revenue 的百分比
5. 若客户名称在多行出现（子公司/关联方），合并处理并注明

返回 JSON：
{
  "customers": [
    {
      "name": "Enterprise Products",
      "values": [null, 531137, 1209677, 3089980],
      "first_year": "2023",
      "is_new": false,
      "pct_latest": 0.228,
      "notes": "2025年大幅增长 +156% YoY，晋升第一大客户"
    }
  ],
  "total_by_year": [12241182, 11799583, 11717758, 13577438]
}
```

### 2D：股权结构提取

**Prompt 模板：**
```
请从以下文件中提取公司股权结构信息。

文件内容：
{file_content}

返回 JSON：
{
  "as_of_date": "January 2026",
  "shareholders": [
    { "name": "Brian Harless", "title": "President", "pct": 0.7103 },
    { "name": "Eddie Walters", "title": "Technical Manager", "pct": 0.2252 },
    { "name": "Jeremy Stringer", "title": "Sales Manager", "pct": 0.0645 }
  ],
  "total_shares": null,
  "notes": "S-Corp，3名股东"
}
```

### 2E：贷款协议提取（Credit Memo 专用）

**Prompt 模板：**
```
请从以下贷款协议中提取关键条款。

文件内容：
{file_content}

返回 JSON：
{
  "lender": "Founder Funding, LLC",
  "borrower": "MobileMind Technologies, Inc.",
  "original_commitment": 1500000,
  "novated_principal": 1355499.40,
  "facility_type": "Revenue-Based Term Loan",
  "original_close": "May 18, 2023",
  "novation_date": "March 28, 2025",
  "maturity_date": "May 22, 2026",
  "interest_rate": "14.75%",
  "revenue_share": "0.50%",
  "borrowing_base_formula": "40% of trailing 3-month annualized revenue",
  "covenants": [
    { "name": "Minimum DSCR", "threshold": "1.25x", "frequency": "quarterly" },
    { "name": "Minimum Cash", "threshold": "$150,000", "frequency": "monthly" }
  ],
  "collateral": "All assets, senior secured",
  "allonge": "First Financial Bank, N.A.",
  "special_terms": ["Prepayment allowed without penalty after Month 12"]
}
```

---

## STAGE 3：数据整合与规范化

### 目标
将多个文件的提取结果合并成单一、无冲突的 `DealMemoInput` JSON。

### LLM 调用：数据整合器

**Prompt 模板：**
```
你是财务数据整合专家。以下是从多个文件中提取的原始数据，可能存在重复、冲突或缺失。

原始数据集：
{extracted_data_array}

整合规则：
1. 冲突解决优先级：Priority 1 文件 > Priority 2 > 其他；会计师出具报告 > QuickBooks 导出 > 内部表格
2. 若同一指标存在两个不同数值，选择更可信来源，并在 data_conflicts 中记录
3. 缺失年份数据标为 null，不得估算或填充
4. 公司名称统一使用最官方的版本（如营业执照或合同抬头）
5. 所有金额统一为整数（美元，四舍五入）

请返回标准 DealMemoInput JSON（格式见 generateDerekDashboard.md）。

同时返回：
{
  "data_quality_report": {
    "coverage": "2022-2025 完整，2026 YTD 57天",
    "data_conflicts": [
      {
        "field": "2024 Total Revenue",
        "value_a": { "source": "P&L_2024.pdf", "value": 11717758 },
        "value_b": { "source": "QuickBooks_export.csv", "value": 11715000 },
        "resolution": "采用 P&L_2024.pdf（会计师审计版）"
      }
    ],
    "missing_fields": ["2022年现金流量表缺失", "月度数据仅有2023年"],
    "confidence": "high" | "medium" | "low"
  }
}
```

### 整合冲突处理规则

| 冲突类型 | 处理方式 |
|---------|---------|
| 两个来源数值相差 < 1% | 取较大来源值，记录差异 |
| 两个来源数值相差 1%~5% | 取审计/会计师版，提示用户复核 |
| 两个来源数值相差 > 5% | 暂停，要求用户确认正确版本 |
| 某年数据完全缺失 | 标注 null，不估算，在 missing_fields 中列出 |
| 公司名称不一致 | 取合同/注册文件中的官方名称 |

---

## STAGE 4：财务计算与指标推导

### 目标
基于整合后的数据，严格按公式计算所有派生指标，确保跨模块数字一致性。

### 计算流程（按顺序执行，不得跳过）

```javascript
// Step 1: 收入汇总
totalRevenue[year] = sum(revenue[*].values[year])

// Step 2: 毛利计算
totalCOGS[year] = sum(cogs[*].values[year])  // 均为负数
grossProfit[year] = totalRevenue[year] + totalCOGS[year]
grossMarginPct[year] = grossProfit[year] / totalRevenue[year]

// Step 3: 运营费用
totalOpEx[year] = sum(opex[*].values[year])  // 均为负数
netOrdinaryIncome[year] = grossProfit[year] + totalOpEx[year]

// Step 4: EBITDA
depreciation[year] = opex.find(o => o.label.includes('Depreciation')).values[year] ?? 0
EBITDA[year] = netOrdinaryIncome[year] - depreciation[year]  // 加回折旧（折旧为负数）
EBITDAMargin[year] = EBITDA[year] / totalRevenue[year]

// Step 5: 净收入
totalOtherIncome[year] = sum(otherIncome[*].values[year])
netIncome[year] = netOrdinaryIncome[year] + totalOtherIncome[year]
netMarginPct[year] = netIncome[year] / totalRevenue[year]

// Step 6: Adj. EBITDA（仅最新完整年）
latestYear = years[years.length - 1]
confirmedAddbacks = addbacks.filter(a => a.status === 'confirmed')
totalAddback = sum(confirmedAddbacks.filter(a => a.direction === 'add').map(a => a.amount))
totalSubtract = sum(confirmedAddbacks.filter(a => a.direction === 'subtract').map(a => a.amount))
adjEBITDA = EBITDA[latestYear] + totalAddback - totalSubtract
adjEBITDAMargin = adjEBITDA / totalRevenue[latestYear]

// Step 7: 估值范围
valuationLow = round(adjEBITDA * floor_multiple / 500000) * 500000   // 四舍五入到 $0.5M
valuationHigh = round(adjEBITDA * ceiling_multiple / 500000) * 500000

// Step 8: YoY 增长
for (let i = 1; i < years.length; i++) {
  revenueYoY[years[i]] = (totalRevenue[years[i]] - totalRevenue[years[i-1]]) / totalRevenue[years[i-1]]
}

// Step 9: 客户集中度
topNRevenue = sum(customers.slice(0, N).map(c => c.values[latestYearIndex]))
concentrationPct = topNRevenue / totalRevenue[latestYear]

// Step 10: 估值倍数调整（基于风险因素）
baseMidMultiple = 6.0  // 行业基准
adjustments = []
if (grossMarginPct[latestYear] > 0.90) adjustments.push(+0.5)   // 高毛利
if (debt === 0) adjustments.push(+0.25)                          // 无债务
if (concentrationPct_top3 > 0.50) adjustments.push(-0.5)        // 集中度风险
if (maxShareholderPct > 0.70) adjustments.push(-0.25)            // 关键人风险
if (revenueYoY[latestYear] > 0.15) adjustments.push(+0.25)      // 高增长
finalMidMultiple = baseMidMultiple + sum(adjustments)
floorMultiple = finalMidMultiple - 1.0
ceilingMultiple = finalMidMultiple + 1.0
```

### LLM 调用：计算审核

在执行计算后，调用 LLM 进行合理性检验：

**Prompt 模板：**
```
请审核以下财务计算结果的合理性，识别任何异常或疑似错误。

计算结果：{calculation_results}
行业背景：{industry} | 地点：{location} | 成立年份：{founded}

检查项目：
1. EBITDA Margin 是否在行业合理范围内（服务业通常 20%~45%）
2. Gross Margin 与业务模式是否吻合（纯服务业 >90% 正常）
3. 各年 YoY 增长是否有异常波动，是否已有解释
4. Adj. EBITDA 是否超过 Reported EBITDA 25% 以上（若超过，Add-back 需重点审查）
5. 估值倍数是否合理（服务业 4×~8× 通常合理）

返回：
{
  "sanity_check_passed": true/false,
  "warnings": ["2023年 EBITDA Margin 仅 4.7%，但已有一次性奖金解释 — 合理"],
  "errors": [],
  "suggestions": ["建议在 footnote 中特别说明2023年异常，避免买方误判"]
}
```

---

## STAGE 5：叙述内容生成

### 目标
基于计算结果和通用生成规则，生成所有叙述性文字模块。

### 5A：Investment Thesis 生成

**Prompt 模板：**
```
你是资深并购顾问，请为以下公司生成 4~5 条投资逻辑（Investment Thesis）。

公司信息：{company_info}
关键指标：{key_metrics}
行业：{industry}

生成规则（来自 generateDerekDashboard.md 通用规则 §3.5）：
- 按优先级选取最强的 4~5 条
- 每条必须包含至少一个具体数字
- 英文输出，专业投行语言
- 描述 2~3 句，不超过 50 词
- 每条配一个语义匹配的 FontAwesome 图标和颜色

返回 JSON：
{
  "thesis": [
    {
      "title": "Exceptional 2025 Performance",
      "desc": "Revenue grew 15.8% YoY to $13.6M with EBITDA expanding to $4.6M (33.5%) — strongest year on record. Gross margin consistently >97%.",
      "icon": "fa-chart-line",
      "icon_color": "#16a34a",
      "icon_bg": "#dcfce7"
    }
  ]
}
```

### 5B：Seller Notes 生成

**Prompt 模板：**
```
基于以下数据，生成 Seller Notes & Deal Considerations 内容。

特殊数据项：{special_items}  // Add-back 项、关联方交易、非经营性资产等
风险触发项：{risk_triggers}  // 来自 STAGE 4 风险检测结果

生成规则（来自 generateDerekDashboard.md 通用规则 §3.6）：
- 每条对应一个 FontAwesome 图标
- 英文输出
- 包含具体数字和金额
- 如触发 Key Man Risk，必须包含 earnout/retention 建议

返回 JSON：
{
  "seller_notes": [
    {
      "icon": "fa-check-circle",
      "html": "Add-backs for 2025 estimated at <strong>~$673K</strong> (within ±5% accuracy per seller). Similar add-backs expected going back to 2021."
    }
  ]
}
```

### 5C：Risk Assessment 生成（Credit Memo 专用）

**Prompt 模板：**
```
基于以下信贷数据，生成风险评估列表。

贷款信息：{loan_info}
财务指标：{financial_metrics}
Covenant 状态：{covenant_status}

风险评级规则：
- high：Covenant fail、客户集中度 >60%、收入连续下滑、现金储备 < 3 个月运营费用
- medium：Covenant warn、单一客户 >30%、YoY 收入下滑 <20%、管理层变动
- low：已缓解风险、合同保护、多元化客户

返回 JSON：
{
  "risks": [
    {
      "level": "medium",
      "title": "Revenue Concentration",
      "text": "<strong>Top 3 customers represent 47% of ARR.</strong> Loss of any single district would materially impact repayment capacity. Mitigated by multi-year contracts and high switching costs."
    }
  ]
}
```

### 5D：AI Panel Chips 生成（Credit Memo 专用）

**Prompt 模板：**
```
为以下公司的信贷备忘录生成 4~5 个 AI 快捷问题（AI Panel Chips）。

公司信息：{company_info}
关键风险点：{key_risks}
Covenant 状态：{covenant_status}

要求：
- 问题必须针对该公司的具体情况，不得使用通用问题
- 英文，简洁（<8 词）
- 覆盖：财务健康、合规风险、增长预测、还款能力

返回：["What drives the ARR growth?", "DSCR trend last 3 quarters?", ...]
```

---

## STAGE 6：HTML 页面生成

### 目标
将所有计算结果和叙述内容组装成完整的 HTML 文件。

### 策略：分模块生成 + 组装

由于完整 HTML 文件较大（通常 1500~2000 行），采用「分段生成 → 拼接」策略：

```
Segment 1: <head> + <style> + Passcode Gate
Segment 2: Top Bar + Deal Header（M&A）/ Top Bar + Left Nav + Hero（Credit）
Segment 3: KPI Cards + Income Statement
Segment 4: P&L Summary + EBITDA Bridge（M&A）/ Facility Terms + Covenants（Credit）
Segment 5: Cash Flow + Balance Sheet
Segment 6: Revenue Trend + YTD + Expense Breakdown
Segment 7: Ownership + Top Customers
Segment 8: Investment Thesis + Seller Notes + Growth + Deal Structure（M&A）
           / Risk Assessment + Business Overview + Management（Credit）
Segment 9: Revenue Concentration Visual（M&A）/ AI Panel（Credit）
Segment 10: Footer + <script>（Passcode / Dropdown / PDF Export）
```

### LLM 调用：各 Segment 生成

每个 Segment 独立调用，使用专属 Prompt。以 Segment 3（Income Statement）为例：

**Prompt 模板：**
```
请生成 Derek Dashboard 的损益表 HTML 模块。

输入数据：
{income_statement_data}

生成规则（严格遵守 generateDerekDashboard.md §5）：
- 使用 <table class="fin-table"> 结构
- 负数加括号 + class="num neg"，正数 class="num pos"
- YTD 列数字加 style="color:#0369a1;"
- 空值显示 <span style="color:#94a3b8;">—</span>
- Add-back 项加 <span class="note-badge">AB</span>
- 一次性项加 <span class="note-badge">†</span>
- 包含 footnote 区域，说明各标注含义
- 包含 Revenue / COGS / OpEx / Other 四个折叠 Toggle 按钮

仅输出该模块的 HTML 片段，不包含 <html>/<head>/<body> 标签。
```

### 数字格式化函数（生成时调用）

```javascript
// LLM 生成时应使用以下规则格式化数字

function formatFinancial(value, isNegative = false) {
  if (value === null || value === undefined) return '—'
  const abs = Math.abs(value)
  const formatted = abs.toLocaleString('en-US')
  if (value < 0 || isNegative) return `(${formatted})`
  return formatted
}

function formatMillions(value) {
  // 用于 KPI 卡片和 Deal Header
  if (Math.abs(value) >= 1000000) return `$${(value/1000000).toFixed(1)}M`
  if (Math.abs(value) >= 1000) return `$${(value/1000).toFixed(0)}K`
  return `$${value.toLocaleString()}`
}

function formatPct(value, decimals = 1) {
  const sign = value >= 0 ? '+' : '–'
  return `${sign}${Math.abs(value * 100).toFixed(decimals)}%`
}
```

### CSS 柱状图高度计算（Revenue Trend 模块）

```javascript
// M&A 类使用纯 CSS 高度模拟柱状图
const MAX_HEIGHT = 120  // px
const maxRevenue = Math.max(...totalRevenue)

function barHeight(value) {
  if (!value) return 4  // 最小高度
  return Math.round((value / maxRevenue) * MAX_HEIGHT)
}
// Revenue 柱高度 = barHeight(revenue)
// EBITDA 柱高度 = barHeight(EBITDA)
// Adj. EBITDA 柱高度 = barHeight(adjEBITDA)
```

---

## STAGE 7：校验与输出

### 目标
在写入文件前，执行一致性校验，确保生成质量。

### 7A：数字一致性自动校验

解析生成的 HTML，提取关键数字并验证：

```
校验项 1: Deal Header 右侧 Adj. EBITDA = EBITDA Bridge 底部值
校验项 2: KPI Card Revenue = 损益表 Total Revenue 行（最新年）
校验项 3: KPI Card EBITDA = P&L Summary EBITDA 行（最新年）
校验项 4: 估值范围 Low = Adj. EBITDA × floor_multiple（±$0.5M 允许误差）
校验项 5: 估值范围 High = Adj. EBITDA × ceiling_multiple（±$0.5M 允许误差）
校验项 6: Top Customers 合计 ≤ Total Revenue（集中度百分比合理）
校验项 7: EBITDA Bridge: EBITDA + sum(add) - sum(subtract) = Adj. EBITDA
校验项 8: Balance Sheet: Total Assets = Total Liabilities + Total Equity
```

### LLM 调用：最终 QA 审核

**Prompt 模板：**
```
请对以下 Derek Dashboard HTML 进行质量审核。

HTML 内容：{generated_html}
预期关键数字：{expected_values}

检查项：
1. 所有必须模块是否存在（参考 generateDerekDashboard.md §页面结构总览）
2. Passcode Gate 是否正确，密码变量是否设置
3. 数字格式：是否所有负数使用括号，正数无括号
4. YTD 列是否标注蓝色
5. 是否存在 "undefined"、"NaN"、"null" 等未处理的占位符
6. eSapiens 链接是否正确
7. 响应式 @media 规则是否存在

返回：
{
  "passed": true/false,
  "issues": [
    { "severity": "error" | "warning", "location": "EBITDA Bridge", "desc": "Adj. EBITDA 数值与 Deal Header 不一致" }
  ],
  "requires_regeneration": ["Segment 4"]  // 需要重新生成的片段
}
```

### 7B：输出文件

校验通过后，将 HTML 写入：
```
public/derek/dealmemo-{slug}.html
```

同时更新 `src/index.tsx` 中的默认跳转（若为新增公司的第一个 memo）。

---

## 错误处理与重试规则

| 错误类型 | 处理方式 |
|---------|---------|
| 文件解析失败（格式不支持）| 跳过该文件，在 missing_fields 中记录，继续处理其他文件 |
| 数据冲突 > 5% | 暂停流程，向用户展示冲突详情，等待确认 |
| 数字一致性校验失败 | 自动重新生成对应 Segment（最多重试 2 次） |
| 2 次重试后仍失败 | 向用户报告问题，提供手动修正建议 |
| 关键数据缺失（损益表 < 2 年）| 暂停，提示用户补充文件 |
| LLM 输出包含 undefined/NaN | 自动修复为 `—`，记录告警 |
| 估值计算结果异常（<$1M 或 >$1B）| 标记为异常，人工复核 |

---

## 多版本生成规则

当需要为同一公司生成多个版本（v1.0、v1.1、v1.2）时：

```
Step 1: 生成 v1.0（基准版）
  - 仅使用 confirmed add-backs
  - 使用基准倍数

Step 2: 生成 v1.1（上调版）
  - 在 v1.0 基础上，加入 TBD add-backs（标注 pending QoE）
  - 倍数上调 0.5×~1.0×
  - KPI Card EBITDA sub 加入 "(+donations TBD)" 等提示

Step 3: 生成 v1.2（最终确认版）
  - TBD 项全部确认后，用实际数字替换
  - 更新估值区间

版本间共享：所有原始财务数字（P&L、客户、股权）完全相同
版本间差异：估值区间、Adj. EBITDA（含 TBD 项）、叙述中的 hedge 语言

Top Bar Dropdown 自动包含所有同公司版本，当前版本 active 高亮。
```

---

## 完整工作流时序图

```
用户上传文件
     │
     ▼
[STAGE 1] 文件分类器（1次 LLM 批量调用）
     │ 输出：文件清单 + 类型标注
     ▼
[STAGE 2] 并行数据提取（每类文件独立 LLM 调用）
     ├── 2A: 损益表提取
     ├── 2B: Add-back 提取
     ├── 2C: 客户收入提取
     ├── 2D: 股权结构提取
     └── 2E: 贷款协议提取（Credit 类）
     │ 输出：per-file JSON
     ▼
[STAGE 3] 数据整合器（1次 LLM 调用）
     │ 输出：DealMemoInput JSON + 数据质量报告
     ▼
[STAGE 4] 财务计算（纯代码，无 LLM）
     │ + 计算审核（1次 LLM 调用）
     │ 输出：完整计算结果 JSON
     ▼
[STAGE 5] 叙述内容生成（并行 LLM 调用）
     ├── 5A: Investment Thesis
     ├── 5B: Seller Notes
     ├── 5C: Risk Assessment（Credit 类）
     └── 5D: AI Chips（Credit 类）
     │ 输出：叙述内容 JSON
     ▼
[STAGE 6] HTML 分段生成（10段，可并行）
     │ 输出：10 个 HTML 片段
     ▼
[STAGE 7] 校验（数字一致性自动 + LLM QA 审核）
     ├── 通过 → 写入 public/derek/{slug}.html
     └── 失败 → 重新生成问题 Segment（最多2次）
```

---

## LLM 调用汇总

| Stage | 调用次数 | 是否可并行 | 预计 Token 消耗 |
|-------|---------|----------|--------------|
| Stage 1: 文件分类 | 1（批量） | — | ~2K/次 |
| Stage 2: 数据提取 | 5种类型各1次 | 可并行 | ~3K~8K/次 |
| Stage 3: 数据整合 | 1 | — | ~5K |
| Stage 4: 计算审核 | 1 | — | ~2K |
| Stage 5: 叙述生成 | 4次 | 可并行 | ~2K/次 |
| Stage 6: HTML生成 | 10段 | 部分可并行 | ~4K~8K/段 |
| Stage 7: QA审核 | 1 | — | ~5K |
| **合计** | **~24次** | — | **~80K~120K** |

---

## 输出物清单

| 文件 | 路径 | 说明 |
|------|------|------|
| 主 HTML 页面 | `public/derek/dealmemo-{slug}.html` | 可直接访问的完整页面 |
| 数据 JSON | `（内部存储）` | DealMemoInput + 计算结果，用于后续版本生成 |
| 数据质量报告 | `（返回用户）` | 数据冲突、缺失字段、置信度说明 |
| 版本 HTML（可选）| `public/derek/dealmemo-{slug}v1.1.html` 等 | 多版本场景 |
