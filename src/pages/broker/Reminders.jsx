import { useCallback, useEffect, useState } from 'react';
import {
  createRequestReminder,
  listCompaniesRequest,
  listCompanyReminders,
  skipNextRequestReminder,
} from '../../lib/api';
import { useToast } from '../../context/ToastContext';
import ReminderCenter from '../../components/reminders/ReminderCenter';

export default function BrokerReminders() {
  const { showToast } = useToast();
  const [reminders, setReminders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sendingId, setSendingId] = useState('');
  const [skippingId, setSkippingId] = useState('');

  const loadReminders = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const companies = await listCompaniesRequest();
      const reminderGroups = await Promise.all(
        (companies || []).map((company) => listCompanyReminders(company.id).catch(() => [])),
      );
      setReminders(reminderGroups.flat());
    } catch (err) {
      setError(err.message || 'Unable to load reminders.');
    } finally {
      setLoading(false);
    }
  }, []);

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
      title="Broker Reminders"
      reminders={reminders}
      loading={loading}
      error={error}
      emptyMessage="No reminders available yet."
      showCompany
      audience="broker"
      sendingId={sendingId}
      skippingId={skippingId}
      onSendNow={sendReminderNow}
      onSkipNext={skipNextReminder}
      onRefresh={loadReminders}
    />
  );
}
