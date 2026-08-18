# SDE / ADJUSTED EBITDA NARRATIVE GUIDE

## PURPOSE
When /sde-narrative is called, produce a narrative that
explains why the company's SDE or Adjusted EBITDA has
changed over the review periods in terms of both dollars
and margin. The goal is to tell the story behind the
numbers, not to restate them. Output should be copy-paste
ready for the director.

---

## KEY PRINCIPLE
The narrative explains changes in normalized earnings.
Addbacks are excluded from the discussion entirely because
they are neutralized in the calculation. A change in
officer compensation, personal expenses, or any other
addback item has zero impact on SDE or Adjusted EBITDA
and should never be cited as a reason for earnings
movement. Net income is equally irrelevant and should
not be discussed. Focus exclusively on the underlying
operational drivers that remain after addbacks are removed.

The same logic applies to presentation-only revenue
reclassifications. If a fee that was previously reported
as a separate line item is rolled into service pricing,
or if a discount previously netted against revenue is
reclassified, these changes wash out at the total revenue
line and have no effect on normalized earnings. Do not
discuss presentation-only reclassifications as revenue
drivers. They add no analytical value and create
confusion for the reader. Only discuss revenue changes
that represent a real shift in volume, pricing, or mix
at the total revenue level.

---

## PRE-WRITING REVIEW
Before writing, review the following in order:

1. Recalculated SDE or Recalculated Adjusted EBITDA tab —
   identify the metric being used, the time periods covered,
   the dollar values and margins for each period, and all
   addback line items. Note every addback so they can be
   mentally excluded when reviewing the P&L.

2. P&L tab — review revenue and each expense category
   across all periods. For each meaningful change, mentally
   back out any portion attributable to addbacks. What
   remains is the operational change that needs to be
   explained.

3. Q&A tab — review all responses for commentary relevant
   to revenue or expense changes. For each question that
   will be cited in the narrative:
   - Read the full answer text, not just the question
   - Confirm the Q number is correct by reading the
     question text alongside the number before writing
   - Confirm that the narrative accurately reflects what
     the company actually said
   - If the company provided a substantive answer, the
     narrative must reflect that answer — do not
     characterize the response as missing or insufficient
     when a real answer was given
   - If the company's answer was vague or unhelpful,
     paraphrase enough of it to show why it was
     insufficient
   - Never cite a Q number without having read the
     full answer text for that question

4. Executive Summary tab — note the industry and business
   type for context on whether changes are consistent with
   industry norms or seasonal patterns.

If key tabs appear unpopulated or the data does not make
sense, flag this to the director before proceeding.

---

## Q NUMBER VERIFICATION
The Q&A tab uses hardcoded question numbers in the question
number column. Do not derive Q numbers by counting rows.
Instead, read the number directly from the cell for each
question. Before writing any narrative, confirm at least
three Q numbers by reading the question text alongside
the number to verify the mapping is correct. A row
counting error will shift every Q reference in the
narrative and is difficult to catch after the fact.

---

## ANALYTICAL FRAMEWORK

### Step 1 — Identify the periods
Review the SDE or Adjusted EBITDA tab to confirm the time
periods. Typically the last three full calendar years plus
a trailing twelve month period.

TTM logic: The TTM period is compared against the most
recent full fiscal year. The change between the two is
driven entirely by the difference between the current
year to date performance and the equivalent prior year
to date period. For example, if the TTM period ends
April 2026, the difference versus full year FY25 is
explained by April 2026 YTD performance versus April
2025 YTD performance. Commentary on TTM movement should
be framed this way — explain why the current year to
date is stronger or weaker than the same period last year,
not how the trailing twelve months compares to the full
prior year in absolute terms.

### Step 2 — Calculate normalized expense base
For each period:
- Start with total revenue
- Subtract SDE or Adjusted EBITDA
- The result is the normalized expense base
- Compare normalized expense bases across periods to
  identify where costs are actually moving after
  addbacks are removed

### Step 3 — Identify material drivers
For each year over year change in SDE or Adjusted EBITDA,
identify the primary drivers by working through:
- Revenue changes (volume, pricing, mix, new or lost
  customers, seasonality)
- Normalized expense changes after mentally removing
  addback items from each expense category
- Whether each change is explained by Q&A commentary

### Step 4 — Flag gaps
If a meaningful change in revenue or normalized expenses
exists and the company either was not asked about it or
could not provide a satisfactory explanation, flag it
in the chat response to the director — not in the
narrative body. The narrative should omit the unexplained
item entirely or note only that data for the period was
limited, without any language suggesting the narrative
is incomplete or requires confirmation.

---

## OUTPUT STRUCTURE
Two sections. Keep each concise. Include all material
items but avoid unnecessary words. If things were
consistent, say so briefly and move on.

### SECTION ONE — REVENUE CHANGES
Explain what drove revenue movement across the review
periods. Pull from Q&A commentary where available and
cite question numbers.

Focus on:
- Volume, pricing, and mix changes
- New or lost customer relationships
- Seasonal or weather-related factors
- One-time or non-recurring revenue items
- For TTM: explain why current YTD is stronger or weaker
  than prior year same period

### SECTION TWO — MARGIN CHANGES
Explain what drove SDE or Adjusted EBITDA margin movement.
Work through the normalized expense base after mentally
removing all addback items.

Focus on:
- Changes in direct costs as a percentage of revenue
- Changes in normalized operating expenses
- Whether expense changes are proportional to revenue
  or represent a real shift in cost structure
- Any expense category that moved meaningfully without
  a clear explanation

Do not discuss addback items as margin drivers. Do not
discuss net income.

---

## FLAGGING MISSING COMMENTARY
If a material change exists and the company could not
provide a satisfactory explanation, surface it to the
director in the chat response only — never in the
narrative body. The copy-paste narrative must never
contain language indicating it is incomplete, requires
confirmation, or is pending follow-up. That language
is not appropriate for client-facing output.

All gap flags belong in the chat above or below the
narrative, clearly separated from it. Use this format
in the chat response:

If the company was asked but could not explain:
"Director flag: [Category] [changed in the following
way] during [period]. The company was asked (Q[X])
but could not provide a specific explanation. Confirm
before the narrative is finalized."

If no question was asked at all:
"Director flag: [Category] [changed in the following
way] during [period]. No question was asked about
this item. Confirm the driver and update the narrative
before finalizing."

In the narrative itself, either omit the unexplained
item or note only that commentary on the period was
limited — without any language that signals an open
item or unresolved finding to the reader.

---

## EXAMPLE OUTPUT

The following is a sanitized example based on a
landscaping and maintenance business with three full
fiscal years plus a trailing twelve month period.

---

Revenue Changes:

Revenue increased modestly in FY23 and more meaningfully
in FY25, with the FY25 growth driven primarily by an
increase in landscaping project work including a
significant single-customer engagement totaling
approximately $478K (Q9). FY24 revenue was relatively
flat compared to FY23, with no specific commentary
provided by the company to explain the composition of
that year. The April 2026 TTM period reflects continued
growth, with April 2026 YTD running ahead of April 2025
YTD, which the company attributed to a warm early spring
allowing crews to begin project work earlier than normal
(Q16).

---

Margin Changes:

SDE margins were consistent at 40 to 42% in FY23, FY25,
and the TTM period, representing the normalized earnings
range for the business. The FY24 decline to 34.5% was
an expense-side outlier driven by a combination of items
that outpaced the modest 3% revenue growth that year.
Supplies costs increased approximately $85K (from 16.5%
to 20.1% of revenue) and insurance increased
approximately $11K. When asked about expense and margin
variability, the company's responses generally attributed
changes to job mix and the nature of project work (Q21,
Q18), but did not provide specific insight into the
drivers of individual cost increases. This is consistent
with a business that operates without formal job-level
cost tracking, making it difficult to pinpoint margin
changes to specific periods or projects with precision.

---

## NONRELIANCE LANGUAGE
This is a quality of earnings engagement conducted under a nonreliance letter. Never phrase any part of the narrative, or any chat commentary around it, as advising the client or director to "rely on" this workbook, its recalculated figures, or its analysis, including in comparison to the CIM or any other source material. Where a figure or analysis is better supported than another source, describe it as such (for example, "supported by a transaction level review of the general ledger") without characterizing it as something the client or director may rely upon.

## FILE-SPECIFIC RULES
- Never cite addback items as drivers of earnings change
- Never discuss presentation-only revenue reclassifications
  (e.g., a fee rolled into service pricing, a discount
  policy change that nets to zero at the total revenue
  line) as revenue drivers. These have no effect on
  normalized earnings and clutter the narrative
- Never discuss net income
- TTM commentary explains current YTD versus prior year
  same YTD, not TTM versus full prior year in absolute
  terms
- All gap flags (missing commentary, unexplained changes,
  items requiring director confirmation) belong in the
  chat response only, clearly separated from the
  narrative. Never embed flag language, open-item
  language, or "confirm before finalizing" language
  in the copy-paste narrative output
- Do not use dashes — use parentheses, commas, or
  restructured sentences instead
- Never cite a Q number without having read the full
  answer text for that question and confirmed the number
  is correct by reading the question text directly from
  the tab
- Only attribute revenue or expense changes to causes
  explicitly stated by the company in Q&A or directly
  visible in the financial data. Do not infer business
  drivers (such as customer growth, pricing changes, or
  operational decisions) that are not supported by a
  specific workbook source. If a material change exists
  but the cause is not stated, flag it for the director
  rather than supplying a plausible-sounding explanation
