import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';

/**
 * Reusable Accordion Item Component
 * @param {Object} props
 * @param {string} props.question - The question/title of the accordion
 * @param {string|React.ReactNode} props.answer - The answer/content
 * @param {boolean} props.isOpen - Controlled state for openness
 * @param {Function} props.onClick - Toggle handler
 */
export const FAQAccordionItem = ({ question, answer, isOpen, onClick }) => {
  return (
    <div className="border-b border-border/40 last:border-0">
      <button
        onClick={onClick}
        className="flex w-full items-center justify-between py-5 text-left transition-all hover:text-primary group"
        aria-expanded={isOpen}
      >
        <span className={`text-lg font-medium transition-colors ${isOpen ? 'text-primary' : 'text-secondary'}`}>
          {question}
        </span>
        <div className={`p-2 rounded-full transition-all ${isOpen ? 'bg-primary/10 text-primary rotate-180' : 'bg-secondary/5 text-secondary group-hover:bg-secondary/10'}`}>
          <ChevronDown className="h-5 w-5" />
        </div>
      </button>
      
      <div 
        className={`grid transition-all duration-300 ease-in-out ${
          isOpen ? 'grid-rows-[1fr] pb-6 opacity-100' : 'grid-rows-[0fr] opacity-0'
        }`}
      >
        <div className="overflow-hidden">
          <p className="text-secondary/70 leading-relaxed text-base">
            {answer}
          </p>
        </div>
      </div>
    </div>
  );
};

export const FAQAccordion = ({ items }) => {
  const [openId, setOpenId] = useState(null);

  const toggle = (id) => {
    setOpenId(prev => (prev === id ? null : id));
  };

  if (!items || items.length === 0) {
    return (
      <div className="py-12 text-center text-secondary/50 italic bg-secondary/5 rounded-2xl border border-dashed border-border">
        No questions found for this category or search.
      </div>
    );
  }

  return (
    <div className="bg-bg-card rounded-2xl border border-border/50 shadow-sm overflow-hidden px-6 lg:px-8">
      {items.map((item) => (
        <FAQAccordionItem
          key={item.id}
          question={item.question}
          answer={item.answer}
          isOpen={openId === item.id}
          onClick={() => toggle(item.id)}
        />
      ))}
    </div>
  );
};
