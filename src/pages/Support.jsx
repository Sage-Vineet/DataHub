import React, { useState, useMemo } from 'react';
import { 
  Search, 
  HelpCircle, 
  LifeBuoy, 
  MessageSquare, 
  Mail, 
  Phone, 
  ArrowRight,
  TrendingUp,
  Layout,
  User,
  CreditCard,
  Settings
} from 'lucide-react';
import { FAQAccordion } from '../components/support/FAQAccordion';
import { SupportForm } from '../components/support/SupportForm';
import faqData from '../data/support_faq.json';

const Support = () => {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState('All');

  const categories = useMemo(() => {
    return ['All', ...faqData.map(cat => cat.category)];
  }, []);

  const filteredFAQs = useMemo(() => {
    let results = [];
    
    // Flatten or category filter
    if (activeCategory === 'All') {
      results = faqData.flatMap(cat => cat.items);
    } else {
      const category = faqData.find(cat => cat.category === activeCategory);
      results = category ? [...category.items] : [];
    }

    // Search filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      results = results.filter(item => 
        item.question.toLowerCase().includes(query) || 
        item.answer.toLowerCase().includes(query)
      );
    }

    return results;
  }, [activeCategory, searchQuery]);

  const popularQuestions = [
    "How do I reset my password?",
    "What payment methods do you accept?",
    "Can I add multiple users to my workspace?",
    "How secure is my data on DataHub?"
  ];

  const getCategoryIcon = (category) => {
    switch (category) {
      case 'General': return <Layout className="h-5 w-5" />;
      case 'Account': return <User className="h-5 w-5" />;
      case 'Billing': return <CreditCard className="h-5 w-5" />;
      case 'Technical Issues': return <Settings className="h-5 w-5" />;
      default: return <HelpCircle className="h-5 w-5" />;
    }
  };

  return (
    <div className="min-h-screen bg-bg-page pb-20 overflow-x-hidden">
      {/* Hero Section */}
      <section className="relative pt-12 pb-20 px-6 lg:px-8 bg-gradient-to-b from-primary/5 to-transparent">
        <div className="max-w-4xl mx-auto text-center space-y-6">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 text-primary text-xs font-bold uppercase tracking-wider mb-2 animate-bounce">
            <LifeBuoy className="h-3 w-3" />
            Help Center
          </div>
          <h1 className="text-4xl lg:text-5xl font-extrabold text-secondary tracking-tight">
            How can we <span className="text-primary italic">help</span> you today?
          </h1>
          <p className="text-secondary/60 text-lg max-w-2xl mx-auto">
            Search our knowledge base or get in touch with our team. We're here to help you get the most out of DataHub.
          </p>
          
          {/* Search Bar */}
          <div className="relative max-w-2xl mx-auto mt-10 group">
            <div className="absolute inset-y-0 left-0 pl-5 flex items-center pointer-events-none">
              <Search className="h-6 w-6 text-secondary/30 group-focus-within:text-primary transition-colors" />
            </div>
            <input
              type="text"
              placeholder="Search for questions, keywords, or topics..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="block w-full pl-14 pr-6 py-5 bg-bg-card border border-border/50 rounded-2xl shadow-xl shadow-secondary/5 focus:outline-none focus:ring-4 focus:ring-primary/10 focus:border-primary/50 transition-all text-secondary placeholder:text-secondary/30"
            />
            {searchQuery && (
              <button 
                onClick={() => setSearchQuery('')}
                className="absolute inset-y-0 right-0 pr-5 flex items-center text-secondary/30 hover:text-secondary transition-colors"
              >
                Clear
              </button>
            )}
          </div>

          {/* Popular Questions Chips */}
          <div className="flex flex-wrap items-center justify-center gap-3 mt-8">
            <span className="text-sm font-semibold text-secondary/40 flex items-center gap-1">
              <TrendingUp className="h-4 w-4" /> Popular:
            </span>
            {popularQuestions.map((q, i) => (
              <button
                key={i}
                onClick={() => setSearchQuery(q)}
                className="px-4 py-1.5 rounded-full bg-secondary/5 border border-border/30 text-sm text-secondary/60 hover:bg-primary/10 hover:border-primary/30 hover:text-primary transition-all"
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      </section>

      <div className="max-w-7xl mx-auto px-6 lg:px-8 grid grid-cols-1 lg:grid-cols-12 gap-12">
        {/* Left Column: FAQ Section */}
        <div className="lg:col-span-8 space-y-10">
          <div className="flex flex-col space-y-8">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <h2 className="text-2xl font-bold text-secondary flex items-center gap-3">
                <HelpCircle className="h-7 w-7 text-primary" />
                Frequently Asked Questions
              </h2>
              
              {/* Category Tabs */}
              <div className="flex items-center gap-1 p-1 bg-secondary/5 rounded-xl border border-border/20 overflow-x-auto max-w-full">
                {categories.map((cat) => (
                  <button
                    key={cat}
                    onClick={() => setActiveCategory(cat)}
                    className={`px-4 py-2 rounded-lg text-sm font-semibold whitespace-nowrap transition-all ${
                      activeCategory === cat 
                        ? 'bg-bg-card text-primary shadow-sm' 
                        : 'text-secondary/50 hover:text-secondary'
                    }`}
                  >
                    {cat}
                  </button>
                ))}
              </div>
            </div>

            <FAQAccordion items={filteredFAQs} />
          </div>

          {/* Contact Cards Section */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 pt-8">
            <div className="p-6 bg-primary/5 border border-primary/10 rounded-2xl group hover:bg-primary/10 transition-colors">
              <Mail className="h-8 w-8 text-primary mb-4" />
              <h4 className="font-bold text-secondary mb-1">Email Support</h4>
              <p className="text-sm text-secondary/60 mb-4">Response within 24 hours</p>
              <a href="mailto:support@datahub.com" className="text-primary text-sm font-bold flex items-center gap-1 group-hover:gap-2 transition-all">
                support@datahub.com <ArrowRight className="h-4 w-4" />
              </a>
            </div>
            <div className="p-6 bg-blue-50/50 border border-blue-100 rounded-2xl group hover:bg-blue-100/50 transition-colors">
              <MessageSquare className="h-8 w-8 text-blue-500 mb-4" />
              <h4 className="font-bold text-secondary mb-1">Live Chat</h4>
              <p className="text-sm text-secondary/60 mb-4">Available Mon-Fri, 9-5</p>
              <button className="text-blue-500 text-sm font-bold flex items-center gap-1 group-hover:gap-2 transition-all">
                Start Chatting <ArrowRight className="h-4 w-4" />
              </button>
            </div>
            <div className="p-6 bg-indigo-50/50 border border-indigo-100 rounded-2xl group hover:bg-indigo-100/50 transition-colors">
              <Phone className="h-8 w-8 text-indigo-500 mb-4" />
              <h4 className="font-bold text-secondary mb-1">Call Center</h4>
              <p className="text-sm text-secondary/60 mb-4">Priority for Enterprise</p>
              <a href="tel:+1234567890" className="text-indigo-500 text-sm font-bold flex items-center gap-1 group-hover:gap-2 transition-all">
                +1 (234) 567-890 <ArrowRight className="h-4 w-4" />
              </a>
            </div>
          </div>
        </div>

        {/* Right Column: Support Form */}
        <div className="lg:col-span-4 lg:sticky lg:top-8 h-fit">
          <SupportForm />
          
          {/* Status Tracker Mock */}
          <div className="mt-6 p-6 bg-bg-card border border-border/50 rounded-2xl">
            <h4 className="font-bold text-secondary mb-4">Already have a ticket?</h4>
            <div className="space-y-4">
              <input 
                type="text" 
                placeholder="Enter Ticket ID (e.g. #DH-1234)" 
                className="w-full px-4 py-2 text-sm bg-bg-page border border-border rounded-lg focus:outline-none focus:border-primary/50"
              />
              <button className="w-full py-2 bg-secondary text-white rounded-lg text-sm font-bold hover:opacity-90 transition-opacity">
                Check Status
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Support;
