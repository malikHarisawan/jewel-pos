import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Form, Input, Modal, Select, Spin, Switch } from 'antd';
import { api } from '../../lib/api.js';
import { useSession } from '../../app/session.js';
import type { z } from 'zod';
import type { UserDTO } from '../../../../shared/contracts/index.js';

type User = z.infer<typeof UserDTO>;

type Role = 'OWNER' | 'MANAGER' | 'SALESMAN';

const ROLE_CLS: Record<string, string> = {
  OWNER: 'tag tag-accent',
  MANAGER: 'tag tag-accent-2',
  SALESMAN: 'tag tag-neutral',
};

/** What each role may do, spelled out — the counter staff read this table to
 * understand why a screen is locked for them. */
const ROLE_CAN: Record<string, string> = {
  OWNER: 'Everything, incl. cost, profit and users',
  MANAGER: 'Everything except users and cost visibility',
  SALESMAN: 'Sell only — no items, stock or rates',
};

/** User management. Only owners reach this panel (the create/activate/reset
 * channels are owner-guarded server-side too). */
export function UsersPanel() {
  const { t } = useTranslation();
  const { session } = useSession();
  const isOwner = session?.role === 'OWNER';
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const [resetUser, setResetUser] = useState<User | null>(null);

  const users = useQuery({ queryKey: ['users'], queryFn: () => api['users.list']({}) });

  const setActive = useMutation({
    mutationFn: (v: { userId: number; active: boolean }) => api['users.setActive'](v),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (e: Error) => message.error(e.message),
  });

  return (
    <div className="jp-panel">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 12,
          gap: 12,
        }}
      >
        <div className="jp-kicker">Users — owner only</div>
        <span className="tag tag-neutral">Sign-in is username + PIN</span>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead>
            <tr>
              <th>{t('settings.user.name')}</th>
              <th>{t('settings.user.username')}</th>
              <th>{t('settings.user.role')}</th>
              <th>Can do</th>
              <th>{t('settings.user.pin')}</th>
              <th>{t('settings.user.active')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(users.data ?? []).map((u: User) => (
              <tr key={u.id}>
                <td style={{ fontWeight: 600 }}>{u.displayName}</td>
                <td className="jp-num" style={{ fontSize: 12.5, opacity: 0.7 }}>
                  {u.username}
                </td>
                <td>
                  <span className={ROLE_CLS[u.role] ?? 'tag tag-neutral'}>{u.role}</span>
                </td>
                <td style={{ fontSize: 12, opacity: 0.65 }}>{ROLE_CAN[u.role] ?? ''}</td>
                <td className="jp-num" style={{ letterSpacing: '.2em' }}>
                  ••••
                </td>
                <td>
                  {isOwner ? (
                    <Switch
                      size="small"
                      checked={u.isActive}
                      onChange={(active) => setActive.mutate({ userId: u.id, active })}
                    />
                  ) : (
                    <span className={u.isActive ? 'tag tag-accent-2' : 'tag tag-outline'}>
                      {u.isActive ? t('settings.user.on') : t('settings.user.off')}
                    </span>
                  )}
                </td>
                <td style={{ textAlign: 'end' }}>
                  {isOwner && (
                    <button
                      className="btn btn-ghost"
                      style={{ fontSize: 12 }}
                      onClick={() => setResetUser(u)}
                    >
                      {t('settings.user.resetPin')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {users.isLoading && (
              <tr>
                <td colSpan={7} style={{ textAlign: 'center', padding: 20 }}>
                  <Spin />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {isOwner && <AddUserRow />}
      <ResetPinModal user={resetUser} onClose={() => setResetUser(null)} />
    </div>
  );
}

/** Adding a user is a one-line job, so it lives inline under the table rather
 * than behind a dialog. */
function AddUserRow() {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const qc = useQueryClient();

  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [role, setRole] = useState<Role>('SALESMAN');
  const [secret, setSecret] = useState('');

  const create = useMutation({
    mutationFn: () => api['users.create']({ username, displayName, secret, role }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['users'] });
      message.success(t('settings.user.created'));
      setDisplayName('');
      setUsername('');
      setSecret('');
      setRole('SALESMAN');
    },
    onError: (e: Error) => message.error(e.message),
  });

  const submit = () => {
    if (!displayName.trim() || !username.trim()) return message.error('Name and username are required.');
    if (secret.length < 4) return message.error('The PIN must be at least 4 digits.');
    create.mutate();
  };

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1.2fr 1fr .9fr .7fr auto',
        gap: 10,
        alignItems: 'end',
        marginTop: 14,
        paddingTop: 14,
        borderTop: '1px solid var(--color-divider)',
      }}
    >
      <div className="field">
        <label>{t('settings.user.name')}</label>
        <input
          className="input"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Full name"
        />
      </div>
      <div className="field">
        <label>{t('settings.user.username')}</label>
        <input
          className="input"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="off"
        />
      </div>
      <div className="field">
        <label>{t('settings.user.role')}</label>
        <Select
          value={role}
          onChange={setRole}
          style={{ width: '100%' }}
          options={(['SALESMAN', 'MANAGER', 'OWNER'] as Role[]).map((r) => ({ value: r, label: r }))}
        />
      </div>
      <div className="field">
        <label>{t('settings.user.pin')}</label>
        <input
          className="input jp-num"
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder="4+ digits"
          autoComplete="new-password"
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
      </div>
      <button className="btn btn-primary" disabled={create.isPending} onClick={submit}>
        {t('settings.user.add')}
      </button>
    </div>
  );
}

function ResetPinModal({ user, onClose }: { user: User | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();

  const reset = useMutation({
    mutationFn: (v: { newSecret: string }) =>
      api['users.resetPin']({ userId: user!.id, newSecret: v.newSecret }),
    onSuccess: () => {
      message.success(t('settings.user.pinReset'));
      form.resetFields();
      onClose();
    },
    onError: (e: Error) => message.error(e.message),
  });

  return (
    <Modal
      title={`${t('settings.user.resetPin')} — ${user?.displayName ?? ''}`}
      open={user != null}
      onOk={() => form.submit()}
      onCancel={onClose}
      confirmLoading={reset.isPending}
      okText={t('common.save')}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" onFinish={(v) => reset.mutate(v)}>
        <Form.Item name="newSecret" label={t('settings.newPin')} rules={[{ required: true, min: 4 }]}>
          <Input.Password className="jp-num" autoComplete="new-password" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
