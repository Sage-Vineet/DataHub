import { useState } from "react";
import { Bot, X, Send } from "lucide-react";
import { sendChatbotMessage } from "../../../lib/api";

export default function Chatbot({ getContextData }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([
    { role: "bot", text: "Hi 👋 I'm your DataHub Assistant. Ask me anything about how to use the platform's financial, tax, or valuation features!" },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  const sendMessage = async () => {
    if (!input.trim()) return;

    const userMessage = { role: "user", text: input };
    setMessages((prev) => [...prev, userMessage]);
    setLoading(true);

    try {
      const data = await sendChatbotMessage({
        message: input,
      });

      setMessages((prev) => [
        ...prev,
        { role: "bot", text: data.reply || "No response" },
      ]);
    } catch (err) {
      console.error("Chatbot error:", err);
      setMessages((prev) => [
        ...prev,
        { role: "bot", text: `Error: ${err.message || "Failed to connect to AI"}` },
      ]);
    }

    setInput("");
    setLoading(false);
  };

  return (
    <div className="relative">
      {/* Topbar Button */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`group relative flex h-10 w-10 items-center justify-center rounded-md border border-border transition-all ${open ? "bg-bg-page text-primary" : "bg-bg-card text-text-muted hover:bg-bg-page"}`}
      >
        <Bot size={18} className="transition-colors group-hover:text-primary" />
      </button>

      {/* Chat Window */}
      {open && (
        <div 
          className="absolute right-0 top-12 z-50 w-[350px] overflow-hidden rounded-[var(--radius-card)] border border-border bg-white animate-fadeIn"
          style={{ boxShadow: 'var(--shadow-dropdown)' }}
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <p className="text-[14px] font-semibold text-text-primary">AI Assistant</p>
            <button type="button" onClick={() => setOpen(false)} className="text-text-muted transition-colors hover:text-text-primary">
              <X size={15} />
            </button>
          </div>

          <div className="h-[300px] overflow-y-auto p-4 space-y-3 bg-[#FAFAFA]">
            {messages.map((msg, i) => (
              <div
                key={i}
                className={`flex ${
                  msg.role === "user" ? "justify-end" : "justify-start"
                }`}
              >
                <div className={`max-w-[85%] px-3 py-2 text-[13px] rounded-lg ${
                  msg.role === "user" 
                    ? "bg-primary text-white rounded-tr-none" 
                    : "bg-white border border-border text-text-primary shadow-sm rounded-tl-none"
                }`}>
                  {msg.text}
                </div>
              </div>
            ))}
            {loading && (
              <div className="flex justify-start">
                <div className="px-3 py-2 text-[13px] rounded-lg bg-white border border-border text-text-muted shadow-sm rounded-tl-none flex items-center gap-1">
                  <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce"></span>
                  <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></span>
                  <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0.4s' }}></span>
                </div>
              </div>
            )}
          </div>

          <div className="p-3 border-t border-border bg-white">
            <div className="flex items-center gap-2">
              <input
                className="flex-1 rounded-md border border-border px-3 py-2 text-[13px] outline-none transition-colors focus:border-primary"
                placeholder="Ask me anything..."
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && sendMessage()}
              />
              <button 
                className="flex h-9 w-9 items-center justify-center rounded-md bg-primary text-white transition-colors hover:bg-primary-dark disabled:opacity-50" 
                onClick={sendMessage}
                disabled={!input.trim() || loading}
              >
                <Send size={15} />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
