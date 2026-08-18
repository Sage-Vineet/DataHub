CENTURIUUM
Feature Specification

| Feature ID | QE - 0008 |
|---|---|
| Feature Name | CIM Comparison |
| Module | QE - QoE |
| Status | Draft |
| Related / Recycled IDs | Structural pattern recycled from QE - 0001 (Tax Reconciliation) |
| Author | Josh Tonnesen |
| Date | August 15, 2026 |

1. Purpose & Business Context
This feature gives the QoE reviewer a structured way to compare what the company advertised in the CIM/SIM (Confidential/Selling Information Memorandum) against the recalculated financial statements and add-back population produced by the QoE workpapers. It exists to surface credibility gaps between marketed numbers and diligence-supported numbers before a deal reaches buyers, and mirrors the existing Tax Reconciliation (QE-0001) bridge pattern: full line-item financial statement comparison down through Net Income, followed by a separate, line-by-line comparison of the full add-back population (advertised vs. accepted/denied) with variance and a reviewer-editable narrative summary.
2. User Stories
- As a QoE reviewer, I want to compare the advertised CIM/SIM P&L against the recalculated financial statement down to the GL account level, so that I can identify where advertised figures diverge from diligence-supported figures.
- As a QoE reviewer, I want to compare the full population of CIM-advertised add-backs against the full population of QoE-accepted/denied add-backs line by line, so that I can identify unsupported, missing, or mismatched add-backs.
- As a QoE reviewer, I want the system to auto-match CIM add-back labels to QoE add-back labels using fuzzy/AI matching, so that I don't have to manually map every line when naming conventions differ (e.g., "Owner's Health" vs. "Health Insurance").
- As a QoE reviewer, I want to manually override, re-map, or unmatch any auto-matched add-back pair, so that mismatches don't distort the variance summary.
- As a QoE reviewer, I want an AI-generated narrative summary of the comparison that I can edit, so that I can deliver a polished explanation without drafting it from scratch.
- As a QoE reviewer, I want to link variance line items to existing Q&A entries or trigger new Q&A questions, so that unexplained gaps get resolved with the company.
- As a broker, I want to view a read-only summary of the CIM comparison, so that I understand valuation credibility gaps before continuing to advertise the deal.
3. Functional Requirements
- The system shall provide a CIM Comparison tab within the QE module, scoped to a single deal.
- On load, the system shall check whether a CIM/SIM was built for the deal in the CM module; if found, the system shall auto-populate advertised figures from that CM module data.
- If no CM-module CIM/SIM exists for the deal, the system shall allow the user to manually enter advertised P&L and add-back figures, or upload a CIM/SIM document for AI/OCR-assisted extraction.
- The system shall maintain only a single current advertised data set per deal; a new manual entry or upload shall replace the prior advertised data set rather than retaining multiple versions.
- The system shall display a full line-item comparison of Sales, Cost of Goods Sold/Gross Profit, Operating Expenses (to GL account level), EBITDA Adjustments, and Net Income — advertised vs. recalculated — following the same structural pattern as the Tax Reconciliation tab (QE-0001).
- The system shall calculate and display dollar and percentage variance for each P&L line item.
- Below Net Income, the system shall separately list (a) the full population of add-backs advertised in the CIM/SIM, and (b) the full population of add-backs from the QoE SDE/EBITDA workpaper (QE-0004), each carrying its Accepted/Denied status as determined in QE-0004.
- The system shall auto-match CIM add-back line items to QoE add-back line items using fuzzy/AI text matching.
- The system shall allow the reviewer to manually override, re-map, split, or unmatch any auto-matched add-back pair.
- The system shall persist manual mapping overrides for the current comparison for the life of the deal, and shall re-apply them if the same advertised or QoE add-back labels recur after a re-upload or re-entry.
- Any advertised add-back with no matched QoE add-back shall be displayed unmatched, tagged "Not Recognized," and included in the variance total at full value.
- Any QoE add-back with no matched advertised add-back shall be displayed unmatched, tagged "Not Advertised," and included in the variance total at full value.
- The system shall calculate and display line-by-line dollar and percentage variance for all matched add-back pairs.
- The system shall calculate and display a summary total comparing total advertised add-backs to total QoE-accepted add-backs, with net variance.
- The system shall generate an AI-drafted narrative summary of the P&L and add-back comparison.
- The system shall allow the reviewer to edit the AI-generated narrative prior to finalizing.
- All narrative text shall refer to "the company," never "the seller," consistent with house terminology convention.
- The system shall support inline citation links from any variance line item to related Q&A entries.
- The system shall support triggering a new Q&A question via the Q&A Generator (QE-0015) directly from an unexplained variance line item.
- The system shall support inclusion of this tab in Workbook Export (QE-0013).
4. Data Requirements

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| Advertised P&L line items | Read | CM module (CIM/SIM Builder) or manual entry/upload extraction |
| Recalculated P&L line items | Read | RP-0001 Dynamic P&L / DB module GL data (DB-0003 COA) |
| Advertised add-back population | Read/Write | CM module or manual entry/upload; user-editable labels |
| QoE add-back population (Accepted/Denied) | Read | QE-0004 SDE/EBITDA Tab |
| Add-back mapping overrides | Read/Write | New table: CIM–QoE Add-Back Mapping (deal-scoped) |
| Variance calculations ($/%) | Read | Computed from advertised vs. recalculated/accepted data |
| Narrative summary text | Read/Write | New table: QE-0008 Narrative (AI-drafted, reviewer-editable) |
| Q&A citations | Read | QA-0001 / QA-0002 Q&A module |

5. Access & Security
- Roles with access: Accountant/QoE Reviewer (full edit — mapping, narrative, Q&A linking).
- Roles with read-only access: Broker (summary view of comparison and narrative).
- Roles explicitly excluded: Company (no direct edit access to internal comparison workpaper); Bank; Buyer (pending resolution — see Open Questions).
- Deal isolation confirmed: this feature is scoped to a single company/deal only. No cross-deal or cross-company visibility of data, documents, or search results.
6. UI / UX Notes
- Platform: Web only.
- Wireframe reference: N/A
Layout follows the Tax Reconciliation (QE-0001) bridge pattern: advertised column, recalculated column, and variance column ($/%) for each P&L line item through Net Income. The add-back section below uses a two-population side-by-side list (advertised vs. QoE Accepted/Denied) with a visual match indicator; reviewers can drag or use a dropdown to remap an item, and unmatched items are visually flagged ("Not Recognized" / "Not Advertised"). A summary card at the top or bottom of the tab surfaces total variance and the AI-generated narrative, styled consistently with the QE-0005 Executive Summary/Tracker.
7. Dependencies

| Related Feature | Relationship | Notes |
|---|---|---|
| QE-0001 | Related pattern | Structural comparison/bridge layout precedent |
| QE-0004 | Depends on | Source of QoE add-back population and Accepted/Denied status |
| CM (CIM/SIM Builder) | Depends on | Source of advertised CIM/SIM data when built in Centuriuum |
| RP-0001 | Depends on | Source of recalculated financial statement line items |
| DB-0003 | Depends on | Chart of Accounts hierarchy backing line-item comparison |
| QA-0001 / QA-0002 | Depends on | Citation linking for variance explanations |
| QE-0015 | Depends on | Auto-flagging and generation of variance-driven Q&A questions |
| QE-0013 | Blocks (consumed by) | Export of this tab as part of full Workbook Export |
| Notifications Hub (gap) | Depends on | Notifying reviewer when a linked Q&A item is answered or a variance needs attention |

8. Out of Scope / Deferred
- OCR/AI extraction logic for uploaded CIM/SIM documents — this spec assumes extracted data is available; the extraction pipeline itself belongs to the Data Room OCR pipeline (see DR module conventions).
- Building or editing of the CIM/SIM document itself — owned by the CM module.
- Multi-version CIM/SIM comparison — deferred; this feature compares against a single current advertised data set only.
- PowerPoint/slide export of this comparison — owned by QE-0014.
9. Open Questions
- Should the Buyer role ever receive read access to this comparison at a later deal stage, and if so, at what stage of the deal?
- What confidence threshold should trigger automatic acceptance of a fuzzy/AI add-back match versus flagging it for mandatory manual review?
- Should add-back mapping overrides be savable as a reusable template per firm/reviewer to reduce re-mapping of common naming patterns across deals, or remain strictly deal-scoped as currently specced?
- What extraction service/process handles CIM/SIM document uploads (confidence handling, manual correction flow) when no CM-module CIM exists — needs its own resolution, consistent with DB-0007/DR-0007 patterns.
- Should unmatched ("Not Recognized" / "Not Advertised") items require explicit reviewer disposition before being included in the finalized narrative and export, or do they auto-populate into the summary as soon as detected?
10. Acceptance Criteria
- Given a deal with a CIM/SIM built in the CM module, when the reviewer opens the CIM Comparison tab, then advertised figures auto-populate without manual entry.
- Given a deal without a CM-module CIM/SIM, when the reviewer opens the tab, then they can manually enter or upload advertised figures.
- Given advertised and recalculated P&L data, the system displays line-by-line dollar and percentage variance down to the GL account level.
- Given advertised and QoE add-back populations, the system auto-matches items by fuzzy/AI matching and the reviewer can override any match.
- Given an unmatched advertised add-back, the system tags it "Not Recognized" and includes it in the variance total.
- Given an unmatched QoE add-back, the system tags it "Not Advertised" and includes it in the variance total.
- Given a completed comparison, the system generates an editable AI narrative summary that the reviewer can revise before finalizing.
- Given a flagged variance, the reviewer can link to an existing Q&A entry or trigger a new Q&A question via QE-0015.
