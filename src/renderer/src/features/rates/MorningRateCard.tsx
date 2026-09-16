import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Modal, Spin } from 'antd';
import { api } from '../../lib/api.js';
import { useSession } from '../../app/session.js';
import { amount, parseRs } from '../../lib/format.js';
import {
  MG_PER_GRAM,
  TOLA_MG,
  rateDeltaBp,
  type RateBasis,
} from '../../../../shared/units/index.js';

/**
 * The first thing the owner sees each morning.
 *
 * Posting the day's rate is the one chore that freezes the whole app when it is
 * skipped — nothing can be priced or sold without it. So instead of leaving it
 * on a screen the owner has to remember to visit, the card comes to them, and
 * it collapses the job to a single number: type (or accept) 24K, and every
 * other gold purity follows by fineness ratio.
 *
 * The online suggestion is never authoritative. Public APIs compute spot x
 * USD/PKR, which drifts from the Sarafa Association bulletin the bazaar
 * actually follows, so the number arrives as a proposal the owner confirms or
 * overrides — and the card works identically with no internet at all.
 */

const BASIS_LABEL: Record<RateBasis, string> = {
  PER_GRAM: 'gram',
  PER_TOLA: 'tola',
  PER_10G: '10 g',
};

const UNAVAILABLE_NOTE: Record<string, string> = {
  NOT_CONFIGURED: 'No online source set up. Settings → Rates.',
  NO_API_KEY: 'Online source needs an API key. Settings → Rates.',
  OFFLINE: 'Could not reach the rate source — type today’s rate below.',
  BAD_RESPONSE: 'The rate source sent something unreadable. Type it below.',
  TIMEOUT: 'The rate source did not answer in time. Type it below.',
};

export function MorningRateCard() {
  const { t } = useTranslation();
  const { session } = useSession();
  const qc = useQueryClient();
  const { message } = AntApp.useApp();

  const canPost = session?.role === 'OWNER' || session?.role === 'MANAGER';

  const board = useQuery({
    queryKey: ['rates', 'morningBoard'],
    queryFn: () => api['rates.morningBoard']({ tzOffsetMinutes: new Date().getTimezoneOffset() }),
    enabled: canPost,
  });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api['settings.get']({}) });

  /* The suggestion is fetched only when the card is actually going to open, so
     a shop that already posted today never makes a network call at all. */
  const needsPosting = board.data?.needsPosting ?? false;
  const suggestion = useQuery({
    queryKey: ['rates', 'suggestion'],
    queryFn: () => api['rates.suggestion']({}),
    enabled: canPost && needsPosting,
    retry: false,
    staleTime: 10 * 60 * 1000,
  });

  const [dismissed, setDismissed] = useState(false);
  const [basis, setBasis] = useState<RateBasis>('PER_TOLA');
  const [value, setValue] = useState('');
  /** Set once the user edits, so an arriving suggestion never overwrites typing. */
  const [touched, setTouched] = useState(false);

  const tolaMg = Number(settings.data?.tola_mg) || TOLA_MG;
  const perTola = (perGram: number) => Math.round((perGram * tolaMg) / MG_PER_GRAM);

  const basisPurity = useMemo(
    () => board.data?.purities.find((p) => p.purityId === board.data?.basisPurityId),
    [board.data],
  );

  /* Prefill, in order of usefulness: today's online suggestion, else what was
     posted last. Either way the owner sees a number they can accept, so the
     common morning is one keystroke. */
  useEffect(() => {
    if (touched || !basisPurity) return;
    const suggested = suggestion.data?.suggestion?.ratePaisaPerGram;
    const fallback = basisPurity.lastRatePaisaPerGram;
    const perGram = suggested ?? fallback;
    if (perGram == null) return;
    const shown = basis === 'PER_TOLA' ? perTola(perGram) : basis === 'PER_10G' ? perGram * 10 : perGram;
    setValue(amount(shown));
  }, [suggestion.data, basisPurity, basis, touched, tolaMg]);

  const enteredPaisa = parseRs(value);

  const preview = useQuery({
    queryKey: ['rates', 'previewDerived', board.data?.basisPurityId, enteredPaisa, basis],
    queryFn: () =>
      api['rates.previewDerived']({
        basisPurityId: board.data!.basisPurityId!,
        enteredValuePaisa: enteredPaisa,
        enteredBasis: basis,
      }),
    enabled: canPost && !!board.data?.basisPurityId && enteredPaisa > 0,
  });

  const post = useMutation({
    mutationFn: (lines: Array<{ purityId: number; enteredValuePaisa: number; enteredBasis: RateBasis }>) =>
      api['rates.postMany']({ lines }),
    onSuccess: (rows) => {
      // Every price in the app derives from a rate, so the whole shelf re-prices.
      void qc.invalidateQueries({ queryKey: ['rates'] });
      void qc.invalidateQueries({ queryKey: ['items'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
      message.success(
        rows.length === 1 ? 'Today’s rate posted.' : `Today’s rates posted (${rows.length} purities).`,
      );
      setDismissed(true);
    },
    onError: (e: Error) => message.error(e.message),
  });

  const rows = preview.data ?? [];
  const derive = board.data?.derivePurities ?? true;
  /* With derivation off the owner is posting a single purity, so only the
     basis row is submitted and the rest keep whatever they had. */
  const toPost = derive ? rows : rows.filter((r) => r.isBasis);

  const jumpWarnBp = board.data?.jumpWarnBp ?? 500;
  const basisRow = rows.find((r) => r.isBasis);
  const basisDeltaBp = basisRow
    ? rateDeltaBp(basisRow.lastRatePaisaPerGram, basisRow.ratePaisaPerGram)
    : 0;
  const bigJump = basisDeltaBp >= jumpWarnBp;
  const rising =
    basisRow?.lastRatePaisaPerGram != null &&
    basisRow.ratePaisaPerGram > basisRow.lastRatePaisaPerGram;

  const submit = () => {
    if (!enteredPaisa) return message.error('Enter today’s rate.');
    if (toPost.length === 0) return message.error('Nothing to post.');
    post.mutate(
      toPost.map((r) => ({
        purityId: r.purityId,
        // Derived purities are posted per-gram because that is what they were
        // computed in; re-expressing them in the typed basis would round twice.
        enteredValuePaisa: r.isBasis ? enteredPaisa : r.ratePaisaPerGram,
        enteredBasis: r.isBasis ? basis : ('PER_GRAM' as RateBasis),
      })),
    );
  };

  const open = canPost && needsPosting && !dismissed && !board.isLoading;
  if (!open) return null;

  const note = suggestion.data?.unavailableReason
    ? UNAVAILABLE_NOTE[suggestion.data.unavailableReason]
    : null;

  return (
    <Modal
      open
      onCancel={() => setDismissed(true)}
      footer={null}
      width={520}
      centered
      maskClosable={false}
      title={null}
    >
      <div style={{ padding: '4px 2px' }}>
        <div className="jp-kicker" style={{ marginBottom: 4 }}>
          {t('rates.morning.kicker', 'Good morning')}
        </div>
        <h3 style={{ margin: '0 0 4px', fontSize: 21, fontFamily: 'var(--font-heading)' }}>
          {t('rates.morning.title', 'Post today’s rate')}
        </h3>
        <p style={{ margin: '0 0 16px', fontSize: 12.5, opacity: 0.62, lineHeight: 1.5 }}>
          {t(
            'rates.morning.subtitle',
            'Nothing can be priced or sold until today’s rate is posted.',
          )}
        </p>

        {/* Where the prefilled number came from. The shop must always be able to
            see the origin of a figure that is about to price real sales. */}
        {suggestion.isFetching && (
          <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 10 }}>
            <Spin size="small" /> <span style={{ marginInlineStart: 8 }}>Checking online rate…</span>
          </div>
        )}
        {suggestion.data?.suggestion && (
          <div
            style={{
              background: 'var(--color-bg)',
              borderRadius: 16,
              padding: '10px 13px',
              marginBottom: 12,
              fontSize: 12.5,
              lineHeight: 1.5,
            }}
          >
            <strong>
              Rs {amount(perTola(suggestion.data.suggestion.ratePaisaPerGram))} per tola
            </strong>{' '}
            suggested by {suggestion.data.suggestion.sourceLabel}.
            <div style={{ opacity: 0.6, marginTop: 2 }}>
              A suggestion only — check it against your bazaar rate before posting.
            </div>
          </div>
        )}
        {note && (
          <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 12, lineHeight: 1.5 }}>{note}</div>
        )}

        {basisPurity && (
          <>
            <label style={{ display: 'block', fontSize: 12, marginBottom: 6, opacity: 0.7 }}>
              {basisPurity.label} — quoted per
            </label>
            <div className="seg" style={{ marginBottom: 12 }}>
              {(['PER_GRAM', 'PER_TOLA', 'PER_10G'] as RateBasis[]).map((v) => (
                <label key={v} className="seg-opt">
                  <input
                    type="radio"
                    name="morning-basis"
                    checked={basis === v}
                    onChange={() => {
                      setBasis(v);
                      setTouched(false);
                    }}
                  />
                  {BASIS_LABEL[v]}
                </label>
              ))}
            </div>

            <input
              className="input jp-num"
              autoFocus
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setTouched(true);
              }}
              onKeyDown={(e) => e.key === 'Enter' && !bigJump && submit()}
              placeholder="447,500"
              style={{ fontSize: 20, padding: '10px 14px', width: '100%' }}
            />

            {basisPurity.lastRatePaisaPerGram != null && (
              <div style={{ fontSize: 11.5, opacity: 0.55, marginTop: 6 }}>
                Last posted: Rs {amount(perTola(basisPurity.lastRatePaisaPerGram))} per tola
                {basisPurity.lastEffectiveAt
                  ? ` · ${new Date(basisPurity.lastEffectiveAt).toLocaleDateString()}`
                  : ''}
              </div>
            )}
          </>
        )}

        {/* The whole board, so the owner sees every figure before confirming. */}
        {derive && rows.length > 1 && (
          <div style={{ marginTop: 14 }}>
            <div className="jp-kicker" style={{ marginBottom: 8 }}>
              Will post
            </div>
            <table className="table jp-num" style={{ width: '100%' }}>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.purityId}>
                    <td style={{ fontWeight: r.isBasis ? 600 : 400 }}>
                      {r.label}
                      {!r.isBasis && (
                        <span style={{ fontSize: 10.5, opacity: 0.5, marginInlineStart: 6 }}>
                          derived
                        </span>
                      )}
                    </td>
                    <td style={{ textAlign: 'end', fontWeight: r.isBasis ? 600 : 400 }}>
                      Rs {amount(perTola(r.ratePaisaPerGram))}
                      <span style={{ fontSize: 10.5, opacity: 0.5 }}> /tola</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* An extra typed zero is a 900% jump. Catch it before it prices a sale,
            because metal_rates is append-only — the mistake would be permanent. */}
        {bigJump && (
          <div
            style={{
              marginTop: 14,
              background: 'var(--color-bg)',
              borderInlineStart: '3px solid var(--color-warning, #b8860b)',
              borderRadius: 12,
              padding: '11px 14px',
              fontSize: 12.5,
              lineHeight: 1.5,
            }}
          >
            That is <strong>{(basisDeltaBp / 100).toFixed(1)}% {rising ? 'higher' : 'lower'}</strong>{' '}
            than the last posted rate. Check the figure before posting — a posted rate cannot be
            edited, only replaced.
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <button
            className="btn btn-primary"
            style={{ flex: 1 }}
            disabled={post.isPending || !enteredPaisa}
            onClick={submit}
          >
            {post.isPending
              ? 'Posting…'
              : bigJump
                ? 'Post anyway'
                : derive && toPost.length > 1
                  ? `Post all ${toPost.length}`
                  : 'Post rate'}
          </button>
          <button className="btn" onClick={() => setDismissed(true)}>
            Later
          </button>
        </div>

        <div style={{ fontSize: 11, opacity: 0.5, marginTop: 10, lineHeight: 1.45 }}>
          Posting never changes a finalised invoice. Bills already made keep the rate stamped on
          them.
        </div>
      </div>
    </Modal>
  );
}
