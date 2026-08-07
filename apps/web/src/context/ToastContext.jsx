import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';

const ToastContext = createContext(null);

const TOAST_STYLES = {
  error: {
    icon: AlertCircle,
    border: 'border-red-100',
    bg: 'bg-white',
    iconBg: 'bg-red-50',
    iconColor: 'text-[#C62026]',
    titleColor: 'text-[#050505]',
    bodyColor: 'text-[#6D6E71]',
  },
  success: {
    icon: CheckCircle2,
    border: 'border-green-100',
    bg: 'bg-white',
    iconBg: 'bg-green-50',
    iconColor: 'text-green-700',
    titleColor: 'text-[#050505]',
    bodyColor: 'text-[#6D6E71]',
  },
  info: {
    icon: Info,
    border: 'border-blue-100',
    bg: 'bg-white',
    iconBg: 'bg-blue-50',
    iconColor: 'text-[#00648F]',
    titleColor: 'text-[#050505]',
    bodyColor: 'text-[#6D6E71]',
  },
};

function ToastViewport({ toasts, dismissToast }) {
  return (
    <div className="pointer-events-none fixed right-4 top-4 z-[100] flex w-full max-w-sm flex-col gap-3">
      {toasts.map((toast) => {
        const style = TOAST_STYLES[toast.type] || TOAST_STYLES.info;
        const Icon = style.icon;

        return (
          <div
            key={toast.id}
            className={`pointer-events-auto rounded-2xl border ${style.border} ${style.bg} p-4 shadow-card animate-fadeIn`}
          >
            <div className="flex items-start gap-3">
              <div className={`mt-0.5 flex h-9 w-9 items-center justify-center rounded-xl ${style.iconBg}`}>
                <Icon size={18} className={style.iconColor} />
              </div>
              <div className="min-w-0 flex-1">
                <p className={`text-sm font-semibold ${style.titleColor}`}>{toast.title}</p>
                {toast.message && <p className={`mt-1 text-sm ${style.bodyColor}`}>{toast.message}</p>}
              </div>
              <button
                onClick={() => dismissToast(toast.id)}
                className="rounded-md p-1 text-text-muted transition-colors hover:bg-bg-page hover:text-text-primary"
              >
                <X size={15} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const dismissToast = useCallback((id) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const showToast = useCallback(({ type = 'info', title, message, duration = 3500 }) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setToasts((current) => [...current, { id, type, title, message }]);

    if (duration > 0) {
      window.setTimeout(() => {
        dismissToast(id);
      }, duration);
    }

    return id;
  }, [dismissToast]);

  const value = useMemo(() => ({
    showToast,
    dismissToast,
  }), [dismissToast, showToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} dismissToast={dismissToast} />
    </ToastContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useToast() {
  return useContext(ToastContext);
}
