CENTURIUUM
Feature Specification

| Feature ID | CM - 0002 |
|---|---|
| Feature Name | CIM Template |
| Module | CM - CIM |
| Status | Draft |
| Related / Recycled IDs | CM - 0001 (CIM Helper) — this feature delivers the reusable template capability deferred in that spec |
| Author | Valentin Secchi |
| Date | August 17, 2026 |

# 1. Purpose & Business Context
CM-0001 gives a broker a CIM builder, but every broker starts from the same default outline and rebuilds the same firm boilerplate, the same section order, and the same financial exhibit selection on every deal. CM-0002 makes that work reusable. A broker refines a CIM once, saves it as a template, and every subsequent deal starts from that structure; a firm administrator publishes one template that the whole office inherits; and Centuriuum ships a set of style-matched starting templates so a broker joining from a large brokerage network recognizes the structure of their house CIM on day one. The template layer deliberately carries no deal data — only structure, financial exhibit configuration, presentation conventions, and text explicitly marked as firm boilerplate — which is what allows a firm-scoped, reusable object to exist inside a platform whose default rule is strict per-deal isolation. Business value is adoption and consistency: a 12-broker office produces recognizably consistent CIMs without anyone maintaining a PowerPoint master, and a new broker's first CIM does not look like a first CIM.
This spec supersedes the deferral recorded in CM-0001 Section 8 (“Broker-savable custom CIM templates and cross-deal content or template reuse”). It also requires an amendment to CM-0001 — a content class attribute on qualitative slide content blocks — without which the boilerplate-versus-deal-content distinction this feature depends on cannot be enforced. Both items are logged in Section 9.
# 2. User Stories
One story per user type that touches this feature. Format: "As a [role], I want to [action], so that [benefit]."
- As a broker, I want to save a CIM I have refined as a reusable template, so that my next deal starts from my own proven structure instead of the generic default outline.
- As a broker, I want to choose a template when I create a CIM and preview it before committing, so that I can see what I am getting rather than guessing from a name.
- As a broker joining from a large brokerage network, I want a starting template that matches the structure of the CIM format I already know, so that I can produce a familiar-looking document without configuring anything.
- As a firm administrator, I want to publish one firm template that everyone in my office inherits by default, so that our CIMs are consistent without me policing each broker's deck.
- As a firm administrator, I want to promote a good template a broker built into the firm library, so that the office standard improves from real work rather than from a committee.
- As a broker, I want confidence that saving a client's CIM as a template cannot carry that client's narrative, customers, or figures into another deal, so that reuse never becomes a confidentiality incident.
- As a platform administrator, I want template creation, promotion, and application logged, so that we can trace which template a given CIM was built from and who changed the office standard.
# 3. Functional Requirements
Numbered, testable statements the dev team can build against directly. Avoid prose — each line should be independently verifiable.
- The system shall support exactly three template scopes: System (maintained by Centuriuum), Firm (visible to all users of a single firm), and User (private to one user).
- A user shall see, in any template list or gallery, only System templates, templates belonging to their own firm, and their own User templates. No user shall be able to view, apply, or discover another firm's or another user's templates.
- Each template record shall carry: name, description, scope, owning user or firm, optional industry tag, status (Draft / Published / Archived), version number, created-by and created-at, last-updated-at, and an internal reference to the CIM it was derived from.
- A template shall contain: an ordered slide manifest with slide type per slide; the financial exhibit selection and each exhibit's configured parameters; deck-level presentation conventions (currency units, decimal places, negative-number format, default period type); and content blocks classified as Firm boilerplate.
- A template shall not contain branding elements (logo, palette, typeface, cover layout) — these are inherited at render time from the CM-0001 firm theme and are not duplicated in template records.
- A template shall not contain any deal or company data: no financial figures, no rendered exhibit snapshots, no customer names, no anonymization label map, no questionnaire responses, and no content blocks classified as Deal content.
- Template records shall carry no deal or company foreign key of any kind.
- The system shall ship a set of style-matched System templates at launch that reproduce the structure and general presentation approach common to large brokerage networks, named generically, and containing no third-party firm name, logo, trademark, or other brand asset.
- A broker shall be able to save an existing CIM as a new User template.
- Save-as-template shall copy the source CIM's slide manifest, slide types, financial exhibit selection and parameters, deck-level presentation conventions, and every content block classified as Firm boilerplate.
- Save-as-template shall strip, and shall not persist into the template: all financial figures and rendered exhibit output; all content blocks classified as Deal content; all deal-sourced images; the company name and anonymous descriptor; the anonymization label map; and all questionnaire responses.
- Stripping shall be enforced server-side at the point the template record is written, not by client-side filtering of what is displayed.
- Before a template is created, the system shall present a review screen enumerating every slide and every content block in the source CIM, indicating for each whether it will be carried into the template or stripped, and shall require explicit user confirmation to proceed.
- Qualitative slide content blocks in CM-0001 shall carry a content class attribute with the value Deal content or Firm boilerplate, settable by the block's author.
- The content class attribute shall default to Deal content. A block shall only be eligible to carry into a template if it has been explicitly set to Firm boilerplate.
- A content block classified as Firm boilerplate shall reference only firm-level assets. Where a Firm boilerplate image block references a deal-scoped asset, the block shall be stripped rather than carried with a broken or deal-scoped reference.
- Any user shall be able to clone a System or Firm template into their own User templates and modify the clone. Cloning shall not alter the source template.
- A firm administrator shall be able to promote a User template belonging to a user in their firm to Firm scope.
- Only a firm administrator shall be able to create, update, publish, or archive a Firm template.
- Only a Centuriuum internal administrator shall be able to create, update, or archive a System template.
- Updating an existing template shall be performed by saving a CIM over that template, which shall create a new template version and retain the prior version record. Template metadata (name, description, industry tag) shall be editable directly without creating a new version.
- Archiving a template shall remove it from all galleries and prevent new use, while retaining the record and having no effect on any CIM previously created from it.
- Templates shall be soft-deleted only; a deleted template's record shall be retained for audit and traceability.
- On CIM creation, the system shall present a template gallery offering: Blank CIM, System templates, Firm templates, and My templates.
- A firm administrator shall be able to designate one Firm template as the firm default, which shall be preselected on CIM creation for every user in that firm.
- The user shall be able to select any template visible to them, or Blank CIM, regardless of the firm default.
- Applying a template shall copy its slide manifest, exhibit configuration, presentation conventions, and Firm boilerplate blocks into the new CIM once, at creation.
- A CIM created from a template shall retain no live link to that template. Subsequent edits, new versions, archiving, or deletion of the template shall have no effect on any existing CIM.
- The CIM record shall store the source template ID and version for traceability. This shall be visible to internal users only and shall not appear on any rendered or exported output.
- The broker shall be able to modify, reorder, or remove any slide, exhibit, or block a template contributed. No template element shall be locked or mandatory in v1.
- A template shall be applicable only at CIM creation. The system shall not support applying a template to an existing CIM.
- Where a template references a financial exhibit type that is no longer available, or whose required parameters have changed, the system shall create the CIM omitting that exhibit and shall present a warning naming each omitted exhibit, rather than failing template application.
- Where a template references a Firm boilerplate asset not available to the applying user's firm, the corresponding block shall be created empty with a visible placeholder note identifying what is missing.
- Applying a template shall grant the applying user no access of any kind to the deal, company, or data of the CIM from which that template was derived.
- Each template in the gallery shall display: name, description, scope badge (System / Firm / Mine), slide count, the list of financial exhibits it includes, industry tag where set, and a cover thumbnail.
- The user shall be able to open a read-only preview of a template's full slide sequence before applying it.
- The gallery shall support filtering and text search by scope, name, and industry tag.
- The system shall log to the Activity & Audit Log (SY-0003): template created, template version saved, template cloned, template promoted to Firm scope, template archived or deleted, firm default template changed, and template applied to a CIM (recording template ID and version).
- The template-created log entry shall record the count of content blocks carried into the template and the count stripped, so a confidentiality review can confirm stripping behaved as specified.
# 4. Data Requirements
What tables/fields does this feature read from or write to? Reference the relevant Database module table blocks (DB-0001 through DB-0010) wherever applicable so every feature traces back to the reconciled data structure.

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| Template record (name, description, scope, owner, industry tag, status, version, source CIM ref) | Write | New CM-module table block — DB-0001 to DB-0010 are financial data blocks and none is reserved for CIM or template content (see Open Questions) |
| Template slide manifest (ordered slide list, slide type per slide) | Write | New CM-module table block |
| Template financial exhibit configuration (exhibit type, parameters, period type, units/decimals/negative format) | Write | New CM-module table block; exhibit types defined by CM-0001 |
| Firm boilerplate content blocks carried into templates | Write | New CM-module table block |
| CIM document, slides, and content blocks | Read / Write | CM-0001 — read when saving a CIM as a template; written when a template is applied at CIM creation |
| Content block class attribute (Deal content / Firm boilerplate) | Read | CM-0001 slide content block — new attribute required by this feature (see Open Questions) |
| Source template ID and version stamp on a CIM | Write | CM-0001 CIM record; internal traceability only, never rendered |
| Firm CIM theme (logo, palette, typeface, cover layout) | Read | Brokerage/firm settings owned by the admin console — read at render time, never copied into a template |
| Firm membership and firm administrator role | Read | Firm/user account structure and role assignment — owned by the admin console (cross-cutting gap) |
| Firm-level image and brand assets referenced by boilerplate blocks | Read | Source unresolved — no firm-level asset store is known to exist; DR-0001 assets are deal-scoped and therefore not usable here (see Open Questions) |
| Deal and company identifiers | Not stored | Deliberately absent — template records carry no deal or company reference, which is what preserves deal isolation for a firm-scoped object |
| Template lifecycle and application events | Write | SY-0003 — Activity & Audit Log, including carried/stripped block counts on creation |

# 5. Access & Security
Confirm roles and deal isolation explicitly on every spec — never assume it.
- Roles with access: Broker — may create, edit, clone, and soft-delete their own User templates, clone System and Firm templates, and apply any template visible to them. Firm administrator — all broker rights, plus create, edit, publish, and archive Firm templates, promote a User template to Firm scope, and set the firm default template. Centuriuum internal administrator — maintains System templates.
- Roles explicitly excluded: Company / Seller user — no access to template creation, management, or the gallery; templates are a broker-side production tool. Buyer — no access under any circumstance. Bank — no access. Accountant / QoE preparer — no template management rights; their CM-0001 read access to financial exhibits does not extend to the template layer.
- The firm administrator role required by this feature does not yet exist in the platform and is owned by the admin console cross-cutting gap. This feature must not introduce a local, one-off notion of firm administrator (see Open Questions).
- Deal isolation confirmed: templates are the platform's one deliberate exception to per-deal scoping, and the exception is bounded by construction rather than by policy. Template records carry no deal or company foreign key, no financial figures, no customer names, no questionnaire responses, and no Deal content blocks — only structure, exhibit configuration, presentation conventions, and blocks explicitly classified as Firm boilerplate. Stripping is enforced server-side at write time. Visibility is limited to System scope, the user's own firm, and the user's own private templates, with no cross-firm or cross-user discovery. Applying a template grants no access to the deal it was derived from, and no CIM, deal, or company data is reachable through any template surface.
- Because saving a CIM as a template is the only mechanism by which content can move between deals, the confirmation review screen and the audited carried/stripped block counts are treated as security controls, not conveniences.
# 6. UI / UX Notes
Layout, interaction notes, or wireframe reference. State platform scope explicitly per feature.
- Platform: Web only. Template creation, management, promotion, and application are web-only. There is no template management or template selection on mobile in v1.
- Wireframe reference: N/A
Template selection appears as a gallery step in CIM creation, with Blank CIM as an always-present first option and the firm default template visibly badged and preselected. Cards should carry enough information to choose without opening a preview — slide count, included financial exhibits, scope badge — because a broker choosing a template is deciding how much work they avoid, and a name alone does not convey that.
The save-as-template confirmation screen is the most important surface in this feature. It should read as an inventory, not a dialog: every slide listed, every content block shown with its classification, and a clear visual split between what carries over and what is being stripped. A broker should finish that screen understanding that their client's narrative is not travelling with the template. Anything ambiguous here becomes a confidentiality problem later.
The Deal content / Firm boilerplate control lives on each text and image block inside the CM-0001 editor, defaulting to Deal content, and should be low-friction enough that a broker marking their standard disclaimer as boilerplate does so in one click. Where a block is marked Firm boilerplate, the editor should indicate that its content is reusable across deals so the classification is never made casually.
Where template application omits an exhibit or leaves a boilerplate asset unresolved, the resulting CIM should surface those items in the CM-0001 pre-publish deck health panel rather than as a transient message the broker can dismiss and forget.
# 7. Dependencies
Upstream features that must exist first. This is the single most valuable section for sequencing the build.

| Related Feature | Relationship | Notes |
|---|---|---|
| CM-0001 — CIM Helper | Depends on | Templates are produced from and consumed into CIM structure. Requires an amendment to CM-0001 adding the content block class attribute (Deal content / Firm boilerplate), without which stripping cannot be enforced. Also requires CM-0001's exhibit types, presentation conventions, and creation flow to exist. |
| Admin console / firm settings (cross-cutting gap) | Depends on | Owns the firm administrator role, firm membership, the firm default template setting, and the internal surface for maintaining System templates. This feature cannot ship its permission model without it. |
| Firm-level asset store (unresolved) | Depends on | Firm boilerplate image blocks require assets that are not deal-scoped. No such store is known to exist; DR-0001 assets are deal-scoped and therefore unusable. Either the store is built or images are stripped from templates in v1. |
| DR-0001 — Core Data Room | Related | Source of deal-scoped images in a CIM. Explicitly not a valid source for template content; referenced here to record that boundary. |
| SY-0003 — Activity & Audit Log | Depends on | All template lifecycle, promotion, and application events, plus carried/stripped block counts. Platform-wide audit trail is a known cross-cutting gap. |
| Legal / compliance (cross-cutting gap) | Depends on | Style-matched System templates must be reviewed for trademark and trade-dress exposure before ship, including template naming and visual similarity to named brokerage networks. |
| Notifications hub (cross-cutting gap) | Related | Promotion of a template to Firm scope and changes to the firm default template are events other users in the firm need to learn about. |
| QE-0004 / RP-0001 / DB-0002 | Related | Templates store financial exhibit types and parameters defined by these features. Changes to the exhibit library must remain backward-compatible with stored templates, or template application must degrade gracefully (specified in Section 3). |
| Onboarding (cross-cutting gap) | Related | Template selection is a natural part of first-CIM onboarding for a new broker; sequencing should be reconciled once onboarding is defined. |

# 8. Out of Scope / Deferred
- A dedicated standalone template editor — templates are authored only by saving a CIM as a template, with direct editing limited to metadata.
- Importing an existing PowerPoint (.pptx) deck as a template — deferred; mapping arbitrary slides onto the CM-0001 block model and financial exhibit library is a separate body of work.
- A franchise-network scope tier above Firm — v1 models System, Firm, and User only. A network such as a multi-office brokerage franchise cannot publish one template to all of its offices in v1.
- Locked or mandatory template sections and brand-compliance enforcement — v1 templates are advisory in every respect; a broker may remove anything, including a firm disclaimer slide.
- Linked templates and propagation of template updates to existing CIMs — v1 is copy-on-create only.
- Officially branded brokerage-network templates using third-party firm names, logos, or trademarked assets — v1 ships unbranded, style-matched templates only.
- Cross-firm template sharing, a template marketplace, or template export/import between accounts.
- Industry-specific exhibit logic, benchmark content, or industry-tailored narrative — the industry tag is metadata for filtering only and drives no behavior.
- Templates for document types other than the CIM.
- AI-generated or AI-suggested templates, and recommendation of a template based on deal characteristics.
- Template usage analytics and outcome reporting (for example which templates correlate with closed deals).
- Applying a template to an existing CIM, and bulk restructuring of decks already in progress.
# 9. Open Questions
- Reference file access: the project knowledge files (Centuriuum_Product_List.xlsx, Centuriuum_Spec_Conventions_and_Decisions.docx) could not be read when this spec was drafted. Confirm the CM module label and Feature ID formatting, and confirm nothing here contradicts a locked decision in the conventions doc.
- CM-0001 amendment required: qualitative slide content blocks must gain a content class attribute (Deal content / Firm boilerplate). Without it, this feature cannot distinguish reusable boilerplate from client narrative and the stripping rule is unenforceable. Confirm this change to CM-0001 and who owns updating that document.
- CM-0001 amendment required: CM-0001 Section 8 defers broker-savable templates and Section 5 states there is no cross-deal reuse of CIM content or templates in v1. Both lines need amending to point to CM-0002 and to record the bounded exception described in Section 5 here.
- Firm-level asset store: templates are not deal-scoped, so a Firm boilerplate image block cannot reference a DR-0001 asset. Do we (a) build a small firm-level asset library alongside this feature, or (b) strip all images from templates in v1 and accept text-only boilerplate? Option (b) means a firm's credentials or process-graphic slide cannot be templated.
- Template editing path: with save-from-CIM as the only authoring route, a firm administrator who needs to change one sentence in a boilerplate disclaimer must open a deal, edit a CIM, and re-save over the template. Is that acceptable for v1, or do we add light in-place editing of boilerplate text blocks and slide order?
- No locking was selected, so a firm or franchise cannot guarantee a required compliance disclaimer survives on every CIM. Confirm this is acceptable for v1 and that lockable required slides are logged as a follow-on, as brand-compliance-driven networks are likely to require it.
- Style-matched System templates: how many ship at launch, which market segments do they target, and who performs the trademark/trade-dress review of their names and layouts before release? Recommend counsel review of the shipped set rather than per-template sign-off later.
- Firm administrator role does not yet exist. Interim options: treat the firm's first registered user or a designated senior broker as administrator, or hold Firm-scope templates until the admin console ships and launch with System and User scopes only. This is a sequencing decision.
- Promotion workflow: should a broker be able to submit a User template for promotion to Firm scope (creating a request the administrator approves), or is promotion entirely administrator-initiated? The former needs the notifications gap resolved.
- Limits: is there a cap on the number of User or Firm templates per account, and any storage constraint on boilerplate assets that the design should respect?
- Assumption to confirm: templates carry deck-level presentation conventions (units, decimals, negative format, default period type) but do not carry the Anonymize default, on the basis that anonymization is a deal-by-deal decision. Confirm, or make the Anonymize default templatable.
- Assumption to confirm: a template stores exhibit selection and parameters but never a period's actual dates — a template applied in 2027 resolves its own periods from the new deal. Confirm no template should ever pin absolute dates.
# 10. Acceptance Criteria
- A broker can save an existing CIM as a User template, and the resulting template contains the source CIM's slide order, slide types, financial exhibit selection, exhibit parameters, and presentation conventions.
- A template created from a CIM contains no financial figures, no rendered exhibit output, no customer names, no company name or descriptor, no questionnaire responses, and no content block classified as Deal content.
- A content block defaults to Deal content, and a block left at that default does not appear in a template created from its CIM.
- A content block explicitly marked Firm boilerplate does carry into a template created from its CIM.
- The save-as-template confirmation screen lists every slide and block with its carry-over or strip disposition, and the template is not created until the user confirms.
- Stripping is verified server-side: a request crafted to include Deal content blocks in a template write is rejected, not merely hidden in the UI.
- A user browsing any template gallery sees only System templates, their own firm's templates, and their own User templates, and cannot view or apply another firm's or another user's template by any route including direct reference.
- A firm administrator can publish a Firm template, designate it as the firm default, and that template is preselected for every user in the firm on CIM creation.
- A non-administrator broker cannot create, edit, publish, or archive a Firm template.
- A firm administrator can promote a broker's User template to Firm scope, after which it appears in the firm gallery for all users in that firm.
- Any user can clone a System or Firm template into My templates and modify the clone without altering the source.
- Creating a CIM from a template copies structure, exhibit configuration, conventions, and boilerplate blocks once; subsequently editing, archiving, or deleting the template produces no change in that CIM.
- The CIM record stores the source template ID and version, and that stamp appears nowhere in the rendered PDF or .pptx export.
- A broker can delete or reorder any slide a template contributed, including a firm disclaimer slide, confirming advisory-only behavior.
- Applying a template that references an unavailable financial exhibit creates the CIM successfully, omits that exhibit, and presents a warning naming it.
- Applying a template that references an unresolvable boilerplate asset creates the block empty with a visible placeholder note.
- Archiving a template removes it from every gallery while leaving all previously created CIMs unchanged, and a soft-deleted template's record remains retrievable for audit.
- Template created, version saved, cloned, promoted, archived, deleted, firm default changed, and applied-to-CIM events all appear in the Activity & Audit Log (SY-0003), and the created event records carried and stripped block counts.
- A user without access to the firm or to the template's scope cannot view, apply, or discover that template, and no deal, company, or CIM data is reachable through any template surface.
