import type { BlockRecord } from "./ports.js";

/**
 * The default section outline (`CM - 0001` §3).
 *
 * Eleven sections, each with one qualitative slide and the blocks a broker
 * actually fills. Deliberately data rather than a migration seed: a new deck's
 * shape is a product decision that changes, and changing it should not require a
 * schema change or leave existing decks inconsistent with new ones.
 *
 * `blockKey` follows the SPA's existing field-id convention (`<slide>:<name>`),
 * so a block created here and a block imported from the legacy JSON blob are the
 * same kind of thing.
 */
export interface OutlineSlide {
  layoutKey: string;
  slideNo: number;
  blocks: ReadonlyArray<{ blockKey: string; label: string | null; kind: BlockRecord["kind"] }>;
}

export interface OutlineSection {
  sectionKey: string;
  title: string;
  slides: ReadonlyArray<OutlineSlide>;
}

const text = (slideNo: number, name: string, label: string) => ({
  blockKey: `${slideNo}:${name}`,
  label,
  kind: "text" as const,
});

export const DEFAULT_OUTLINE: ReadonlyArray<OutlineSection> = [
  {
    sectionKey: "executive-summary",
    title: "Executive Summary",
    slides: [
      {
        layoutKey: "source-slide-02",
        slideNo: 2,
        blocks: [
          text(2, "headline", "In one sentence, what is this business?"),
          text(2, "investment_highlights", "What are the three strongest reasons to buy it?"),
          text(2, "transaction_rationale", "Why is the owner selling now?"),
        ],
      },
    ],
  },
  {
    sectionKey: "business-overview",
    title: "Business Overview",
    slides: [
      {
        layoutKey: "source-slide-04",
        slideNo: 4,
        blocks: [
          text(4, "history", "When was the company founded, and how has it evolved?"),
          text(4, "what_we_do", "What does the business actually do, day to day?"),
          text(4, "differentiation", "What can this business do that competitors cannot?"),
        ],
      },
    ],
  },
  {
    sectionKey: "products-services",
    title: "Products & Services",
    slides: [
      {
        layoutKey: "source-slide-07",
        slideNo: 7,
        blocks: [
          text(7, "product_lines", "What are the main product or service lines?"),
          text(7, "pricing_model", "How is the work priced and billed?"),
          text(7, "recurring_revenue", "How much of the revenue recurs, and under what terms?"),
        ],
      },
    ],
  },
  {
    sectionKey: "market-competition",
    title: "Market & Competition",
    slides: [
      {
        layoutKey: "source-slide-10",
        slideNo: 10,
        blocks: [
          text(10, "market_size", "How large is the addressable market, and how fast is it growing?"),
          text(10, "competitors", "Who are the main competitors, and how do you win against them?"),
          text(10, "barriers", "What makes it hard for a new entrant to take this business?"),
        ],
      },
    ],
  },
  {
    sectionKey: "customers",
    title: "Customers",
    slides: [
      {
        layoutKey: "source-slide-13",
        slideNo: 13,
        blocks: [
          text(13, "customer_profile", "Who buys from you, and why do they choose you?"),
          text(13, "concentration_commentary", "How would you explain the customer concentration?"),
          text(13, "retention", "How long does a typical customer stay, and why do any leave?"),
        ],
      },
    ],
  },
  {
    sectionKey: "operations",
    title: "Operations & Facilities",
    slides: [
      {
        layoutKey: "source-slide-16",
        slideNo: 16,
        blocks: [
          text(16, "facilities", "What facilities does the business operate from?"),
          text(16, "supply_chain", "Who are the critical suppliers, and how replaceable are they?"),
          text(16, "systems", "What systems and technology does the business run on?"),
        ],
      },
    ],
  },
  {
    sectionKey: "management",
    title: "Management & Employees",
    slides: [
      {
        layoutKey: "source-slide-19",
        slideNo: 19,
        blocks: [
          text(19, "leadership", "Who runs the business, and what does each of them own?"),
          text(19, "owner_dependence", "What happens to the business the day the owner leaves?"),
          text(19, "headcount", "How is the workforce made up, and how is turnover?"),
        ],
      },
    ],
  },
  {
    sectionKey: "growth",
    title: "Growth Opportunities",
    slides: [
      {
        layoutKey: "source-slide-22",
        slideNo: 22,
        blocks: [
          text(22, "organic_growth", "What could a new owner grow without spending capital?"),
          text(22, "investment_growth", "What would you do with capital you have not had?"),
          text(22, "adjacencies", "What adjacent markets or products are within reach?"),
        ],
      },
    ],
  },
  {
    sectionKey: "financial-summary",
    title: "Financial Summary",
    slides: [
      {
        layoutKey: "source-slide-25",
        slideNo: 25,
        blocks: [
          text(25, "performance_commentary", "How would you explain the last three years of results?"),
          text(25, "addback_rationale", "What costs would not continue under a new owner?"),
        ],
      },
    ],
  },
  {
    sectionKey: "transaction",
    title: "Transaction Overview",
    slides: [
      {
        layoutKey: "source-slide-28",
        slideNo: 28,
        blocks: [
          text(28, "structure", "What transaction structure is the seller looking for?"),
          text(28, "transition", "What transition support is the owner willing to provide?"),
        ],
      },
    ],
  },
  {
    sectionKey: "appendix",
    title: "Appendix",
    slides: [
      {
        layoutKey: "source-slide-31",
        slideNo: 31,
        blocks: [text(31, "notes", "Anything else a buyer should know?")],
      },
    ],
  },
];
