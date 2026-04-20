import { useState } from 'react';
import { Send, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { supportService } from '../../services/supportService';

export const SupportForm = () => {
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    subject: '',
    message: ''
  });

  const [status, setStatus] = useState('idle'); // idle | loading | success | error
  const [errors, setErrors] = useState({});

  const validate = () => {
    const newErrors = {};
    if (!formData.name.trim()) newErrors.name = 'Name is required';
    if (!formData.email.trim()) {
      newErrors.email = 'Email is required';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      newErrors.email = 'Invalid email format';
    }
    if (!formData.subject.trim()) newErrors.subject = 'Subject is required';
    if (!formData.message.trim()) newErrors.message = 'Message is required';
    
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
    // Clear error when user starts typing
    if (errors[name]) {
      setErrors(prev => ({ ...prev, [name]: '' }));
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!validate()) return;

    setStatus('loading');

    try {
      await supportService.submitTicket(formData);
      setStatus('success');
      setFormData({ name: '', email: '', subject: '', message: '' });
    } catch (err) {
      console.error('Support submission error:', err);
      setStatus('error');
    }
  };

  if (status === 'success') {
    return (
      <div className="bg-green-50/50 border border-green-200 rounded-2xl p-8 text-center animate-in fade-in zoom-in duration-300">
        <div className="flex justify-center mb-4">
          <CheckCircle2 className="h-16 w-16 text-green-500" />
        </div>
        <h3 className="text-2xl font-bold text-green-900 mb-2">Message Sent Successfully!</h3>
        <p className="text-green-700/80 mb-6">
          Thank you for reaching out. Our support team will review your request and get back to you within 24 hours.
        </p>
        <button
          onClick={() => setStatus('idle')}
          className="px-6 py-2.5 bg-green-600 text-white rounded-lg font-semibold hover:bg-green-700 transition-colors"
        >
          Send Another Message
        </button>
      </div>
    );
  }

  return (
    <div className="bg-bg-card rounded-2xl border border-border/50 shadow-sm overflow-hidden p-6 lg:p-8">
      <h3 className="text-xl font-bold text-secondary mb-1">Get in Touch</h3>
      <p className="text-secondary/60 text-sm mb-8">Can't find what you're looking for? Send us a message.</p>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-1.5">
            <label htmlFor="name" className="text-sm font-semibold text-secondary/80 ml-1">Full Name</label>
            <input
              type="text"
              id="name"
              name="name"
              value={formData.name}
              onChange={handleChange}
              placeholder="John Doe"
              className={`w-full px-4 py-3 rounded-xl border bg-bg-page focus:outline-none focus:ring-2 transition-all ${
                errors.name ? 'border-destructive/50 ring-destructive/10' : 'border-border focus:border-primary/50 focus:ring-primary/10'
              }`}
            />
            {errors.name && (
              <span className="text-xs text-destructive flex items-center gap-1 mt-1 ml-1">
                <AlertCircle className="h-3 w-3" /> {errors.name}
              </span>
            )}
          </div>

          <div className="space-y-1.5">
            <label htmlFor="email" className="text-sm font-semibold text-secondary/80 ml-1">Email Address</label>
            <input
              type="email"
              id="email"
              name="email"
              value={formData.email}
              onChange={handleChange}
              placeholder="john@example.com"
              className={`w-full px-4 py-3 rounded-xl border bg-bg-page focus:outline-none focus:ring-2 transition-all ${
                errors.email ? 'border-destructive/50 ring-destructive/10' : 'border-border focus:border-primary/50 focus:ring-primary/10'
              }`}
            />
            {errors.email && (
              <span className="text-xs text-destructive flex items-center gap-1 mt-1 ml-1">
                <AlertCircle className="h-3 w-3" /> {errors.email}
              </span>
            )}
          </div>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="subject" className="text-sm font-semibold text-secondary/80 ml-1">Subject</label>
          <input
            type="text"
            id="subject"
            name="subject"
            value={formData.subject}
            onChange={handleChange}
            placeholder="How can we help?"
            className={`w-full px-4 py-3 rounded-xl border bg-bg-page focus:outline-none focus:ring-2 transition-all ${
              errors.subject ? 'border-destructive/50 ring-destructive/10' : 'border-border focus:border-primary/50 focus:ring-primary/10'
            }`}
          />
          {errors.subject && (
            <span className="text-xs text-destructive flex items-center gap-1 mt-1 ml-1">
              <AlertCircle className="h-3 w-3" /> {errors.subject}
            </span>
          )}
        </div>

        <div className="space-y-1.5">
          <label htmlFor="message" className="text-sm font-semibold text-secondary/80 ml-1">Message</label>
          <textarea
            id="message"
            name="message"
            value={formData.message}
            onChange={handleChange}
            rows={5}
            placeholder="Describe your issue or question in detail..."
            className={`w-full px-4 py-3 rounded-xl border bg-bg-page focus:outline-none focus:ring-2 transition-all resize-none ${
              errors.message ? 'border-destructive/50 ring-destructive/10' : 'border-border focus:border-primary/50 focus:ring-primary/10'
            }`}
          />
          {errors.message && (
            <span className="text-xs text-destructive flex items-center gap-1 mt-1 ml-1">
              <AlertCircle className="h-3 w-3" /> {errors.message}
            </span>
          )}
        </div>

        <button
          type="submit"
          disabled={status === 'loading'}
          className="w-full flex items-center justify-center gap-2 px-8 py-4 bg-primary text-white rounded-xl font-bold shadow-lg shadow-primary/20 hover:bg-primary/90 hover:shadow-xl hover:shadow-primary/30 transition-all disabled:opacity-70 disabled:cursor-not-allowed group"
        >
          {status === 'loading' ? (
            <>
              <Loader2 className="h-5 w-5 animate-spin" />
              Sending Message...
            </>
          ) : (
            <>
              Send Message
              <Send className="h-5 w-5 transition-transform group-hover:translate-x-1 group-hover:-translate-y-1" />
            </>
          )}
        </button>

        {status === 'error' && (
          <div className="mt-4 p-4 bg-destructive/10 border border-destructive/20 rounded-xl flex items-center gap-3 text-destructive">
            <AlertCircle className="h-5 w-5" />
            <p className="text-sm font-medium">Something went wrong. Please try again later.</p>
          </div>
        )}
      </form>
    </div>
  );
};
