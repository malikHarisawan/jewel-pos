import { useMemo } from 'react';
import { barcodeRects, isEncodable } from '../../../../shared/barcode/code128.js';
import { gu } from '../../lib/format.js';

/**
 * Printable tag labels.
 *
 * The POS was built around scanning a tag, but without a way to print one there
 * was nothing to scan — the fast checkout could not actually be used. This
 * closes that loop with no new dependency: Code 128 is drawn as plain SVG, and
 * the sheet prints through the same `window.print()` path as the invoice.
 *
 * Labels are laid out as a grid of stickers on A4 rather than targeted at one
 * label printer, because a shop that owns a printer already owns A4 and sticker
 * sheets are sold in every stationery market.
 */

export interface LabelItem {
  id: number;
  name: string;
  tagNumber: string | null;
  netMg: number;
  purityLabel?: string;
}

const BAR_HEIGHT = 34;
const MODULE = 1.1;

function Barcode({ value }: { value: string }) {
  const bars = useMemo(() => {
    try {
      return barcodeRects(value, MODULE);
    } catch {
      return null;
    }
  }, [value]);

  if (!bars) return null;

  return (
    <svg
      viewBox={`0 0 ${bars.totalWidth} ${BAR_HEIGHT}`}
      width="100%"
      height={BAR_HEIGHT}
      preserveAspectRatio="none"
      shapeRendering="crispEdges"
      role="img"
      aria-label={`Barcode ${value}`}
    >
      {/* An explicit white ground matters: a scanner needs the quiet zone to be
          actually white on paper, not the page's theme colour. */}
      <rect x="0" y="0" width={bars.totalWidth} height={BAR_HEIGHT} fill="#fff" />
      {bars.rects.map((r, i) => (
        <rect key={i} x={r.x} y="0" width={r.width} height={BAR_HEIGHT} fill="#000" />
      ))}
    </svg>
  );
}

export function LabelSheet({
  items,
  shopName,
  onClose,
}: {
  items: LabelItem[];
  shopName: string;
  onClose: () => void;
}) {
  // A piece with no tag has nothing to encode, so it is reported rather than
  // printed blank — a blank sticker on a ring is a silent failure.
  const printable = items.filter((i) => i.tagNumber && isEncodable(i.tagNumber));
  const skipped = items.length - printable.length;

  return (
    <div className="jp-labels-root">
      <style>{`
        .jp-labels-grid {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 6mm;
        }
        .jp-label {
          border: 1px dashed #bbb;
          border-radius: 2mm;
          padding: 3mm;
          background: #fff;
          color: #000;
          break-inside: avoid;
          text-align: center;
        }
        .jp-label-name { font-size: 9pt; font-weight: 600; line-height: 1.2; }
        .jp-label-meta { font-size: 7.5pt; opacity: .75; margin-top: .5mm; }
        .jp-label-tag  { font-size: 8pt; font-family: monospace; letter-spacing: .04em; margin-top: 1mm; }

        @media print {
          /* Only the sheet prints: the app chrome, the toolbar and the dashed
             cutting guides are all screen aids. */
          body * { visibility: hidden !important; }
          .jp-labels-root, .jp-labels-root * { visibility: visible !important; }
          .jp-labels-root {
            position: absolute; inset: 0;
            padding: 8mm;
            background: #fff;
          }
          .jp-labels-toolbar { display: none !important; }
          .jp-label { border-color: transparent; }
          @page { size: A4 portrait; margin: 8mm; }
        }
      `}</style>

      <div
        className="jp-labels-toolbar"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginBottom: 16,
          flexWrap: 'wrap',
        }}
      >
        <button className="btn btn-primary" onClick={() => window.print()}>
          Print {printable.length} {printable.length === 1 ? 'label' : 'labels'}
        </button>
        <button className="btn" onClick={onClose}>
          Close
        </button>
        {skipped > 0 && (
          <span style={{ fontSize: 12.5, opacity: 0.7 }}>
            {skipped} {skipped === 1 ? 'piece has' : 'pieces have'} no tag number, so{' '}
            {skipped === 1 ? 'it is' : 'they are'} not printed. Add a tag on the item first.
          </span>
        )}
      </div>

      <div className="jp-labels-grid">
        {printable.map((i) => (
          <div className="jp-label" key={i.id}>
            <div className="jp-label-name">{i.name}</div>
            <div className="jp-label-meta">
              {i.purityLabel ? `${i.purityLabel} · ` : ''}
              {gu(i.netMg)}
            </div>
            <div style={{ marginTop: '1.5mm' }}>
              <Barcode value={i.tagNumber!} />
            </div>
            <div className="jp-label-tag">{i.tagNumber}</div>
            <div className="jp-label-meta" style={{ fontSize: '6.5pt', marginTop: '0.5mm' }}>
              {shopName}
            </div>
          </div>
        ))}
      </div>

      {printable.length === 0 && (
        <div style={{ opacity: 0.6, padding: 20, fontSize: 13 }}>
          None of the selected pieces have a tag number to print.
        </div>
      )}
    </div>
  );
}
