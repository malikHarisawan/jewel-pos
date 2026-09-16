import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Modal } from 'antd';
import { api } from '../../lib/api.js';
import { useSession } from '../../app/session.js';
import { useCatalog } from '../items/useCatalog.js';

/**
 * First-run setup, in four questions.
 *
 * Everything a Pakistani jewellery shop almost always wants — the FBR
 * gold-exempt tax base, rounding to the rupee, an 11.664g tola, the standard
 * purities — already ships correct. Asking the owner to decide all of that
 * before their first sale is what made day one feel like a two-week project.
 *
 * So this asks only what genuinely differs per shop, and everything else stays
 * editable in Settings. Narrowing the purity list matters most: every active
 * purity is one more rate the owner must post every morning before the app will
 * price anything.
 */

interface Draft {
  shopName: string;
  shopPhone: string;
  shopAddress: string;
  chargesTax: boolean;
  taxRatePct: string;
  activePurityIds: number[];
}

const STEPS = ['Shop', 'Tax', 'Purities', 'Done'] as const;

export function SetupWizard() {
  const { session } = useSession();
  const qc = useQueryClient();
  const { message } = AntApp.useApp();
  const catalog = useCatalog();

  const status = useQuery({
    queryKey: ['setup', 'status'],
    queryFn: () => api['setup.status']({}),
    enabled: session?.role === 'OWNER',
  });

  const [step, setStep] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [draft, setDraft] = useState<Draft>({
    shopName: '',
    shopPhone: '',
    shopAddress: '',
    chargesTax: false,
    taxRatePct: '3',
    activePurityIds: [],
  });

  /* Gold purities only. Silver and platinum are left alone: a shop that does
     not deal in them simply never posts a rate, and an unrated purity already
     stays out of the way. */
  const goldPurities = (catalog.data?.purities ?? []).filter((p) => {
    const gold = (catalog.data?.metals ?? []).find((m) => m.name === 'Gold');
    return gold && p.metalId === gold.id;
  });

  const apply = useMutation({
    mutationFn: () =>
      api['setup.apply']({
        shopName: draft.shopName.trim(),
        shopPhone: draft.shopPhone.trim(),
        shopAddress: draft.shopAddress.trim(),
        chargesTax: draft.chargesTax,
        taxRateBp: draft.chargesTax ? Math.round(parseFloat(draft.taxRatePct || '0') * 100) : 0,
        activePurityIds: draft.activePurityIds,
      }),
    onSuccess: () => {
      void qc.invalidateQueries();
      message.success('Your shop is set up.');
      setDismissed(true);
    },
    onError: (e: Error) => message.error(e.message),
  });

  // Only an owner on a genuinely fresh shop sees this.
  const open =
    session?.role === 'OWNER' &&
    !dismissed &&
    !!status.data &&
    !status.data.completed &&
    status.data.remaining.includes('SHOP_DETAILS');
  if (!open) return null;

  const canNext =
    step === 0 ? draft.shopName.trim().length > 0 : step === 2 ? draft.activePurityIds.length > 0 : true;

  const togglePurity = (id: number) =>
    setDraft((d) => ({
      ...d,
      activePurityIds: d.activePurityIds.includes(id)
        ? d.activePurityIds.filter((x) => x !== id)
        : [...d.activePurityIds, id],
    }));

  return (
    <Modal open footer={null} width={520} centered closable={false} maskClosable={false} title={null}>
      <div style={{ padding: '4px 2px' }}>
        <div className="jp-kicker" style={{ marginBottom: 4 }}>
          Setup · {step + 1} of {STEPS.length}
        </div>

        {step === 0 && (
          <>
            <h3 style={{ margin: '0 0 4px', fontSize: 21, fontFamily: 'var(--font-heading)' }}>
              What is your shop called?
            </h3>
            <p style={{ margin: '0 0 16px', fontSize: 12.5, opacity: 0.62, lineHeight: 1.5 }}>
              This prints at the top of every bill.
            </p>
            <div className="field" style={{ marginBottom: 12 }}>
              <label>Shop name</label>
              <input
                className="input"
                autoFocus
                value={draft.shopName}
                onChange={(e) => setDraft({ ...draft, shopName: e.target.value })}
                placeholder="Al-Madina Jewellers"
              />
            </div>
            <div className="field" style={{ marginBottom: 12 }}>
              <label>Phone</label>
              <input
                className="input jp-num"
                value={draft.shopPhone}
                onChange={(e) => setDraft({ ...draft, shopPhone: e.target.value })}
                placeholder="0300-1234567"
              />
            </div>
            <div className="field">
              <label>Address</label>
              <input
                className="input"
                value={draft.shopAddress}
                onChange={(e) => setDraft({ ...draft, shopAddress: e.target.value })}
                placeholder="Sarafa Bazaar, Lahore"
              />
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <h3 style={{ margin: '0 0 4px', fontSize: 21, fontFamily: 'var(--font-heading)' }}>
              Do you charge sales tax?
            </h3>
            <p style={{ margin: '0 0 16px', fontSize: 12.5, opacity: 0.62, lineHeight: 1.5 }}>
              Gold value is already set to be exempt, the FBR treatment — tax applies to making and
              stones only. You can change this later in Settings.
            </p>
            <div className="seg" style={{ marginBottom: 14 }}>
              <label className="seg-opt">
                <input
                  type="radio"
                  name="tax"
                  checked={!draft.chargesTax}
                  onChange={() => setDraft({ ...draft, chargesTax: false })}
                />
                No tax
              </label>
              <label className="seg-opt">
                <input
                  type="radio"
                  name="tax"
                  checked={draft.chargesTax}
                  onChange={() => setDraft({ ...draft, chargesTax: true })}
                />
                Yes
              </label>
            </div>
            {draft.chargesTax && (
              <div className="field">
                <label>Tax rate (%)</label>
                <input
                  className="input jp-num"
                  value={draft.taxRatePct}
                  onChange={(e) => setDraft({ ...draft, taxRatePct: e.target.value })}
                  placeholder="3"
                />
              </div>
            )}
          </>
        )}

        {step === 2 && (
          <>
            <h3 style={{ margin: '0 0 4px', fontSize: 21, fontFamily: 'var(--font-heading)' }}>
              Which gold do you deal in?
            </h3>
            <p style={{ margin: '0 0 16px', fontSize: 12.5, opacity: 0.62, lineHeight: 1.5 }}>
              Pick only what you actually sell. Each one you keep is a rate you would otherwise have
              to post every morning.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {goldPurities.map((p) => (
                <label
                  key={p.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    background: 'var(--color-bg)',
                    borderRadius: 14,
                    padding: '11px 14px',
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={draft.activePurityIds.includes(p.id)}
                    onChange={() => togglePurity(p.id)}
                  />
                  <span style={{ fontSize: 14.5 }}>{p.label}</span>
                </label>
              ))}
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <h3 style={{ margin: '0 0 4px', fontSize: 21, fontFamily: 'var(--font-heading)' }}>
              That is everything.
            </h3>
            <p style={{ margin: '0 0 14px', fontSize: 12.5, opacity: 0.62, lineHeight: 1.5 }}>
              Post today’s rate and you can start selling. Everything else — staff, discount limits,
              backups — is in Settings whenever you need it.
            </p>
            <div
              style={{
                background: 'var(--color-bg)',
                borderRadius: 16,
                padding: '13px 15px',
                fontSize: 13,
                lineHeight: 1.7,
              }}
            >
              <div>
                <strong>{draft.shopName || '—'}</strong>
              </div>
              <div style={{ opacity: 0.7 }}>
                {draft.chargesTax ? `Tax ${draft.taxRatePct}% (gold exempt)` : 'No sales tax'}
              </div>
              <div style={{ opacity: 0.7 }}>
                {draft.activePurityIds.length} gold{' '}
                {draft.activePurityIds.length === 1 ? 'purity' : 'purities'}
              </div>
            </div>
          </>
        )}

        <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
          {step > 0 && (
            <button className="btn" onClick={() => setStep(step - 1)} disabled={apply.isPending}>
              Back
            </button>
          )}
          {step < STEPS.length - 1 ? (
            <button
              className="btn btn-primary"
              style={{ flex: 1 }}
              disabled={!canNext}
              onClick={() => setStep(step + 1)}
            >
              Next
            </button>
          ) : (
            <button
              className="btn btn-primary"
              style={{ flex: 1 }}
              disabled={apply.isPending}
              onClick={() => apply.mutate()}
            >
              {apply.isPending ? 'Saving…' : 'Start selling'}
            </button>
          )}
        </div>

        <button
          className="btn"
          style={{
            width: '100%',
            marginTop: 8,
            background: 'transparent',
            fontSize: 12,
            opacity: 0.6,
          }}
          onClick={() => setDismissed(true)}
        >
          Skip — I’ll set this up in Settings
        </button>
      </div>
    </Modal>
  );
}
