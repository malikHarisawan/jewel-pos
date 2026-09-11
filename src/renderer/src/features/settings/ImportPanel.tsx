/**
 * Spreadsheet import — pick a file, check the preview, then commit.
 *
 * The flow is deliberately three explicit steps rather than one button. Bulk
 * inventory is the one operation where a wrong column silently wrecks the
 * shop's books, and the operator is the only one who can tell "Net Wt" from
 * "Stone Wt" in their own sheet. So nothing is written until they have seen
 * the parsed result and pressed Import.
 *
 * The file itself never enters the renderer: main opens the dialog, keeps the
 * path, and this screen passes that path back for analyse/commit.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Modal, Select, Spin, Switch, Tooltip } from 'antd';
import { api } from '../../lib/api.js';
import { gu, rs, trio } from '../../lib/format.js';
import type { AnalyseImportOutput } from '../../../../shared/contracts/index.js';
import type { z } from 'zod';

type WeightUnit = 'g' | 'mg' | 'tola';

/** One parsed row as the contract defines it — derived from the schema rather
 * than restated here, so a change to the DTO surfaces as a type error. */
type ImportRow = z.infer<typeof AnalyseImportOutput>['rows'][number];

interface PickedFile {
  path: string;
  name: string;
}

/** How many preview rows to render at once. A 5,000-row sheet would otherwise
 * put 5,000 table rows in the DOM and freeze the window; the counts above the
 * table still describe the whole file. */
const PREVIEW_LIMIT = 200;

export function ImportPanel() {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const qc = useQueryClient();

  const [file, setFile] = useState<PickedFile | null>(null);
  const [sheetName, setSheetName] = useState<string | undefined>(undefined);
  const [weightUnit, setWeightUnit] = useState<WeightUnit>('g');
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [postOpeningStock, setPostOpeningStock] = useState(true);
  const [showMapping, setShowMapping] = useState(false);

  const fields = useQuery({
    queryKey: ['import.fields'],
    queryFn: () => api['import.fields']({}),
    staleTime: Infinity,
  });

  // Re-runs whenever the file, sheet, unit or mapping changes — this is the
  // preview, and it must always describe the settings currently on screen.
  const analysis = useQuery({
    queryKey: ['import.analyse', file?.path, sheetName, weightUnit, mapping],
    enabled: file !== null,
    queryFn: () =>
      api['import.analyse']({
        filePath: file!.path,
        sheetName,
        weightUnit,
        mapping,
      }),
    retry: false,
  });

  const pick = useMutation({
    mutationFn: () => api['import.pickFile']({}),
    onSuccess: (res) => {
      if (!res.path || !res.name) return; // cancelled — not an error
      // A new file invalidates every choice made about the old one.
      setFile({ path: res.path, name: res.name });
      setSheetName(undefined);
      setMapping({});
      setWeightUnit('g');
    },
    onError: (e: Error) => message.error(e.message),
  });

  const commit = useMutation({
    mutationFn: (rowNumbers: number[]) =>
      api['import.commit']({
        filePath: file!.path,
        sheetName,
        weightUnit,
        mapping,
        rowNumbers,
        postOpeningStock,
      }),
    onSuccess: (res) => {
      message.success(
        t('import.done', { items: res.imported, movements: res.openingMovements }),
      );
      // Stock, items and the dashboard all just changed.
      void qc.invalidateQueries();
      setFile(null);
      setMapping({});
    },
    onError: (e: Error) => message.error(e.message),
  });

  const data = analysis.data;
  const goodRows = useMemo(
    () => (data?.rows ?? []).filter((r) => r.ok).map((r) => r.rowNumber),
    [data],
  );

  const confirmImport = () => {
    if (!data) return;
    Modal.confirm({
      title: t('import.confirmTitle'),
      content: t('import.confirmBody', {
        count: goodRows.length,
        skipped: data.errorRows,
      }),
      okText: t('import.confirmOk'),
      onOk: () => commit.mutate(goodRows),
    });
  };

  const errorMessage = analysis.error instanceof Error ? analysis.error.message : null;

  return (
    <div className="jp-panel">
      <div className="jp-kicker">{t('import.title')}</div>
      <div style={{ fontSize: 11.5, opacity: 0.6, marginTop: 4 }}>{t('import.hint')}</div>

      <div style={{ marginTop: 12 }}>
        {/* Step 1 — choose the file */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            className="btn btn-secondary"
            onClick={() => pick.mutate()}
            disabled={pick.isPending || commit.isPending}
          >
            {pick.isPending ? <Spin size="small" /> : t('import.choose')}
          </button>
          {file && (
            <span style={{ fontSize: 12.5, opacity: 0.75 }} title={file.name}>
              {file.name}
            </span>
          )}
        </div>

        {file && analysis.isLoading && (
          <div style={{ marginTop: 14 }}>
            <Spin size="small" /> <span style={{ fontSize: 12.5 }}>{t('import.reading')}</span>
          </div>
        )}

        {errorMessage && (
          <div className="jp-alert-error" style={{ marginTop: 14, fontSize: 12.5 }}>
            {errorMessage}
          </div>
        )}

        {data && (
          <>
            {/* Step 2 — sheet, unit, and the column mapping */}
            <div
              style={{
                display: 'flex',
                gap: 16,
                flexWrap: 'wrap',
                alignItems: 'center',
                marginTop: 16,
              }}
            >
              {data.sheetNames.length > 1 && (
                <label style={{ fontSize: 12.5 }}>
                  {t('import.sheet')}{' '}
                  <Select
                    size="small"
                    style={{ minWidth: 140 }}
                    value={data.sheetName}
                    onChange={(v) => {
                      setSheetName(v);
                      // Columns differ per sheet; a mapping from the old one
                      // would silently point at the wrong data.
                      setMapping({});
                    }}
                    options={data.sheetNames.map((s) => ({ value: s, label: s }))}
                  />
                </label>
              )}

              <label style={{ fontSize: 12.5 }}>
                {t('import.weightUnit')}{' '}
                <Select<WeightUnit>
                  size="small"
                  style={{ minWidth: 110 }}
                  value={weightUnit}
                  onChange={setWeightUnit}
                  options={[
                    { value: 'g', label: t('import.unit.g') },
                    { value: 'tola', label: t('import.unit.tola') },
                    { value: 'mg', label: t('import.unit.mg') },
                  ]}
                />
              </label>

              <button className="btn btn-ghost" onClick={() => setShowMapping((v) => !v)}>
                {showMapping ? t('import.hideColumns') : t('import.showColumns')}
              </button>
            </div>

            {data.missingRequired.length > 0 && (
              <div className="jp-alert-error" style={{ marginTop: 12, fontSize: 12.5 }}>
                {t('import.missingRequired', {
                  fields: data.missingRequired
                    .map((k) => fields.data?.find((f) => f.key === k)?.label ?? k)
                    .join(', '),
                })}
              </div>
            )}

            {/* Weight is optional, but importing without it is a decision, not
                an accident — say so before they press Import, not after. */}
            {!data.mapping.grossWeight && !data.mapping.netWeight && data.totalRows > 0 && (
              <div style={{ marginTop: 12, fontSize: 12.5, opacity: 0.75 }}>
                {t('import.noWeightColumn')}
              </div>
            )}

            {showMapping && (
              <ColumnMapper
                headers={data.headers}
                mapping={data.mapping}
                fields={fields.data ?? []}
                onChange={(field, header) =>
                  setMapping((m) => ({ ...m, [field]: header }))
                }
              />
            )}

            {/* Step 3 — the preview and the commit */}
            <div
              style={{
                display: 'flex',
                gap: 14,
                alignItems: 'center',
                marginTop: 16,
                fontSize: 12.5,
                flexWrap: 'wrap',
              }}
            >
              <span>
                <strong>{data.okRows}</strong> {t('import.readyRows')}
              </span>
              {data.errorRows > 0 && (
                <span style={{ color: 'var(--danger, #d4380d)' }}>
                  <strong>{data.errorRows}</strong> {t('import.problemRows')}
                </span>
              )}
              <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <Switch
                  size="small"
                  checked={postOpeningStock}
                  onChange={setPostOpeningStock}
                />
                <Tooltip title={t('import.openingStockHint')}>
                  <span>{t('import.openingStock')}</span>
                </Tooltip>
              </label>
            </div>

            <PreviewTable rows={data.rows} />

            <div style={{ marginTop: 12 }}>
              <button
                className="btn btn-primary"
                onClick={confirmImport}
                disabled={commit.isPending || data.okRows === 0}
              >
                {commit.isPending ? (
                  <Spin size="small" />
                ) : (
                  t('import.run', { count: data.okRows })
                )}
              </button>
              {data.errorRows > 0 && (
                <div style={{ fontSize: 11.5, opacity: 0.7, marginTop: 8 }}>
                  {t('import.skipNote')}
                </div>
              )}
            </div>
          </>
        )}

        <div style={{ fontSize: 11.5, opacity: 0.6, marginTop: 14 }}>
          {t('import.warning')}
        </div>
      </div>
    </div>
  );
}

/** Field-to-column bindings, shown on demand. Each row is one importable field
 * and the spreadsheet column feeding it. */
function ColumnMapper({
  headers,
  mapping,
  fields,
  onChange,
}: {
  headers: string[];
  mapping: Record<string, string>;
  fields: Array<{ key: string; label: string; required: boolean }>;
  onChange: (field: string, header: string) => void;
}) {
  const { t } = useTranslation();
  const options = [
    { value: '', label: t('import.notImported') },
    ...headers.map((h) => ({ value: h, label: h })),
  ];

  return (
    <div
      style={{
        marginTop: 12,
        padding: 12,
        borderRadius: 8,
        background: 'var(--surface-2, rgba(0,0,0,0.03))',
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
        gap: 8,
      }}
    >
      {fields.map((f) => (
        <label
          key={f.key}
          style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}
        >
          <span style={{ minWidth: 108, opacity: 0.8 }}>
            {f.label}
            {f.required && <span style={{ color: 'var(--danger, #d4380d)' }}> *</span>}
          </span>
          <Select
            size="small"
            style={{ flex: 1, minWidth: 110 }}
            value={mapping[f.key] ?? ''}
            onChange={(v) => onChange(f.key, v)}
            options={options}
          />
        </label>
      ))}
    </div>
  );
}

/**
 * The parsed rows, laid out the way the Items screen lays out real stock —
 * same columns, same UNIQUE/LOT tag, same "Gross − Less = Net" trio.
 *
 * The resemblance is the point. The shopkeeper already knows how to read that
 * table, so they can check an import against a mental picture of their shelf
 * instead of learning a second, import-only layout. Rows show the RESOLVED
 * values ("22K / 916"), not what the sheet said ("22"), because the question
 * being answered is "is this what my stock will look like?"
 *
 * Bad rows sort first: burying them under 400 good ones means they are never
 * seen, and they are the only rows that need a decision.
 */
function PreviewTable({ rows }: { rows: ImportRow[] }) {
  const { t } = useTranslation();
  const ordered = useMemo(
    () => [...rows].sort((a, b) => Number(a.ok) - Number(b.ok) || a.rowNumber - b.rowNumber),
    [rows],
  );
  const shown = ordered.slice(0, PREVIEW_LIMIT);

  if (rows.length === 0) {
    return (
      <div style={{ fontSize: 12.5, opacity: 0.6, marginTop: 12 }}>{t('import.noRows')}</div>
    );
  }

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ maxHeight: 380, overflow: 'auto' }}>
        {/* Fixed widths rather than auto: the columns either side of the item
            name hold short, predictable values, so letting the browser
            distribute width by content squeezes the name into a four-line
            column while "UNIQUE" gets room it does not need. */}
        <table className="table jp-num" style={{ width: '100%', minWidth: 860 }}>
          <thead>
            <tr>
              <th style={{ width: 44 }}>{t('import.col.row')}</th>
              <th style={{ width: 90 }}>{t('import.col.tag')}</th>
              <th style={{ minWidth: 200 }}>{t('import.col.name')}</th>
              <th style={{ width: 84 }}>{t('import.col.mode')}</th>
              <th style={{ width: 190, whiteSpace: 'nowrap' }}>{t('import.col.weights')}</th>
              <th style={{ width: 120 }}>{t('import.col.making')}</th>
              <th>{t('import.col.status')}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <PreviewRow key={r.rowNumber} row={r} />
            ))}
          </tbody>
        </table>
      </div>
      {ordered.length > shown.length && (
        <div style={{ fontSize: 11.5, opacity: 0.6, padding: '8px 4px' }}>
          {t('import.moreRows', { count: ordered.length - shown.length })}
        </div>
      )}
    </div>
  );
}

/** One row, rendered like an Items-screen row. Kept separate so the cell logic
 * for a half-parsed row (nulls everywhere) stays readable. */
function PreviewRow({ row }: { row: ImportRow }) {
  const { t } = useTranslation();
  const p = row.preview;

  // The sub-line under the name, exactly as the Items screen builds it.
  const detail = [p.productType, p.purity, p.location].filter(Boolean).join(' · ');

  const making =
    p.makingRatePaisa == null || p.makingRatePaisa === 0
      ? '—'
      : p.makingMode === 'PCT_OF_METAL'
        ? `${(p.makingRatePaisa / 100).toFixed(2)}%`
        : `${rs(p.makingRatePaisa)}${p.makingMode === 'PER_GRAM' ? '/g' : ''}`;

  return (
    <tr style={row.ok ? undefined : { background: 'rgba(212, 56, 13, 0.06)' }}>
      <td style={{ fontSize: 12, opacity: 0.55 }}>{row.rowNumber}</td>

      <td data-num style={{ fontSize: 12, opacity: 0.65, whiteSpace: 'nowrap' }}>
        {/* No tag in the sheet is not a gap to flag — one is allocated on
            import — so say what will happen rather than showing a bare dash. */}
        {p.tag || <span style={{ opacity: 0.6 }}>{t('import.tagAuto')}</span>}
      </td>

      <td>
        <div style={{ fontWeight: 600, fontSize: 12.5 }}>{p.name || '—'}</div>
        {detail && <div style={{ fontSize: 11, opacity: 0.5 }}>{detail}</div>}
      </td>

      <td>
        {p.trackingMode && (
          <span className={p.trackingMode === 'ITEM' ? 'tag tag-accent' : 'tag tag-accent-2'}>
            {p.trackingMode === 'ITEM' ? 'UNIQUE' : 'LOT'}
          </span>
        )}
      </td>

      <td data-num style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>
        {p.grossMg == null || p.lessMg == null ? (
          '—'
        ) : p.lessMg < 0 ? (
          // A negative "less" only arises on a row that already failed (net
          // heavier than gross). The trio would render "5.000 − -1.000" — a
          // double negative that reads as a formatting bug rather than as the
          // data problem the Result column is already naming. Show the two
          // weights the sheet actually gave and let the error do the talking.
          <span style={{ opacity: 0.7 }}>
            {gu(p.grossMg)} → {gu(p.netMg ?? 0)}
          </span>
        ) : (
          <>
            {trio(p.grossMg, p.lessMg)}
            {p.pieces != null && p.pieces > 1 && (
              <span style={{ opacity: 0.55 }}> × {p.pieces} pc</span>
            )}
          </>
        )}
      </td>

      <td data-num style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>
        {making}
        {p.wastageBp != null && p.wastageBp > 0 && (
          <span style={{ opacity: 0.55 }}> +{(p.wastageBp / 100).toFixed(2)}%</span>
        )}
      </td>

      <td style={{ fontSize: 11.5, maxWidth: 260 }}>
        {row.ok ? (
          row.warnings.length > 0 ? (
            <span style={{ opacity: 0.7 }}>{row.warnings.join('; ')}</span>
          ) : (
            <span className="tag tag-accent-2">{t('import.rowOk')}</span>
          )
        ) : (
          <span style={{ color: 'var(--danger, #d4380d)' }}>{row.errors.join('; ')}</span>
        )}
      </td>
    </tr>
  );
}
