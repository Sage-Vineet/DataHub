import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { listCompanyReminders } from '../../lib/api';
import ReminderCenter from '../../components/reminders/ReminderCenter';

function resolveCompanyId(user) {
  return (
    user?.company_id ||
    user?.companyId ||
    user?.company_ids?.[0] ||
    user?.companyIds?.[0] ||
    user?.assigned_companies?.[0]?.id ||
    user?.assignedCompanies?.[0]?.id ||
    null
  );
}

export default function ClientReminders() {
  const { user } = useAuth();
  const companyId = resolveCompanyId(user);
  const [reminders, setReminders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadReminders = useCallback(async () => {
    if (!companyId) {
      setReminders([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const data = await listCompanyReminders(companyId);
      setReminders(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err.message || 'Unable to load reminders.');
      setReminders([]);
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    loadReminders();
  }, [loadReminders]);

  return (
    <ReminderCenter
      title="Reminders"
      reminders={reminders}
      loading={loading}
      error={error}
      emptyMessage="No reminders yet."
      audience="client"
      onRefresh={loadReminders}
    />
  );
}
