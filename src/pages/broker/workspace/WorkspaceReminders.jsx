import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  createRequestReminder,
  getCompanyRequest,
  listCompanyReminders,
  skipNextRequestReminder,
} from '../../../lib/api';
import { useToast } from '../../../context/ToastContext';
import ReminderCenter from '../../../components/reminders/ReminderCenter';

export default function WorkspaceReminders() {
  const { showToast } = useToast();
  const { clientId } = useParams();
  const [company, setCompany] = useState(null);
  const [reminders, setReminders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sendingId, setSendingId] = useState('');
  const [skippingId, setSkippingId] = useState('');

  const loadReminders = useCallback(async () => {
    if (!clientId) return;
    setLoading(true);
    setError('');
    try {
      const [companyPayload, reminderPayload] = await Promise.all([
        getCompanyRequest(clientId).catch(() => null),
        listCompanyReminders(clientId),
      ]);
      setCompany(companyPayload);
      setReminders(reminderPayload || []);
    } catch (err) {
      setError(err.message || 'Unable to load reminders.');
    } finally {
      setLoading(false);
    }
  }, [clientId]);

  useEffect(() => {
    loadReminders();
  }, [loadReminders]);

  const sendReminderNow = async (reminder) => {
    if (!reminder?.request_id) return;
    setSendingId(reminder.request_id);
    setError('');
    try {
      await createRequestReminder(reminder.request_id, { sent_at: new Date().toISOString() });
      await loadReminders();
      showToast({ type: 'success', title: 'Reminder sent', message: `A reminder has been sent for "${reminder.title}".` });
    } catch (err) {
      setError(err.message || 'Unable to send reminder.');
    } finally {
      setSendingId('');
    }
  };

  const skipNextReminder = async (reminder) => {
    if (!reminder?.request_id) return;
    setSkippingId(reminder.request_id);
    setError('');
    try {
      await skipNextRequestReminder(reminder.request_id);
      await loadReminders();
      showToast({ type: 'success', title: 'Next reminder skipped', message: `The next reminder was skipped for "${reminder.title}".` });
    } catch (err) {
      setError(err.message || 'Unable to skip reminder.');
    } finally {
      setSkippingId('');
    }
  };

  return (
    <ReminderCenter
      title="Reminders"
      reminders={reminders}
      loading={loading}
      error={error}
      emptyMessage="No request reminders yet."
      audience="broker"
      contactFallback={company}
      sendingId={sendingId}
      skippingId={skippingId}
      onSendNow={sendReminderNow}
      onSkipNext={skipNextReminder}
      onRefresh={loadReminders}
    />
  );
}
