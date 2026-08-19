import { useState, useRef, useCallback, useEffect } from 'react';
import type { ReceiptResult, ReceiptData, LineItem } from '@bunqsy/shared';

type LogState = 'idle' | 'loading' | 'done' | 'error';

type ScanState = 'idle' | 'scanning' | 'done' | 'error';

interface Props {
  onResult?: (result: ReceiptResult) => void;
  onExpenseLogged?: () => void;
}

export function ReceiptScanner({ onResult, onExpenseLogged }: Props): React.JSX.Element {
  const [scanState, setScanState] = useState<ScanState>('idle');
  const [preview, setPreview] = useState<string | null>(null);
  const [result, setResult] = useState<ReceiptResult | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const scannerRef = useRef<HTMLDivElement>(null);

  const processFile = useCallback(async (file: File) => {
    if (!file.type.startsWith('image/')) {
      setErrorMsg('Please upload an image file (JPEG, PNG, WebP)');
      setScanState('error');
      return;
    }

    // Show preview immediately
    const url = URL.createObjectURL(file);
    setPreview(url);
    setResult(null);
    setScanState('scanning');

    try {
      // Claude Vision limit: 5 MB base64 (~3.75 MB raw). Compress before upload.
      const compressed = file.size > 3 * 1024 * 1024
        ? await compressImage(file, 3 * 1024 * 1024)
        : file;

      const formData = new FormData();
      formData.append('image', compressed);

      const res = await fetch('/api/receipt', { method: 'POST', body: formData });
      const data = await res.json() as unknown;

      if (!res.ok) {
        throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
      }

      const receiptResult = data as ReceiptResult;
      setResult(receiptResult);
      setScanState('done');
      onResult?.(receiptResult);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Receipt scan failed');
      setScanState('error');
    }
  }, [onResult]);

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    if (file) void processFile(file);
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>): void {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) void processFile(file);
  }

  function handleDragOver(e: React.DragEvent): void {
    e.preventDefault();
    setDragging(true);
  }

  function handleDragLeave(): void {
    setDragging(false);
  }

  function handleReset(): void {
    setScanState('idle');
    setPreview(null);
    setResult(null);
    setErrorMsg('');
    if (inputRef.current) inputRef.current.value = '';
  }

  // Cleanup object URL on unmount or new preview
  useEffect(() => {
    return () => { if (preview) URL.revokeObjectURL(preview); };
  }, [preview]);

  return (
    <div className="glass" style={styles.card}>
      <div style={styles.header}>
        <span style={styles.title}>Receipt Scanner</span>
        {(scanState === 'done' || scanState === 'error') && (
          <button style={styles.resetBtn} onClick={handleReset}>↩ New Scan</button>
        )}
      </div>

      {/* Drop zone / preview */}
      {scanState === 'idle' && (
        <div
          style={{
            ...styles.dropZone,
            borderColor: dragging ? 'var(--hue-orange)' : 'var(--glass-border)',
            background: dragging
              ? 'color-mix(in srgb, var(--hue-orange) 8%, transparent)'
              : 'var(--bg-surface-alt)',
          }}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onClick={() => inputRef.current?.click()}
          role="button"
          aria-label="Upload receipt image"
        >
          <span style={styles.dropIcon}>🧾</span>
          <span style={styles.dropText}>Drop receipt here or click to select</span>
          <span style={styles.dropHint}>JPEG · PNG · WebP</span>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={handleFileInput}
          />
        </div>
      )}

      {/* Scanning state: image + laser animation */}
      {(scanState === 'scanning' || scanState === 'done') && preview && (
        <ScanPreview
          previewUrl={preview}
          scanning={scanState === 'scanning'}
          scannerRef={scannerRef}
        />
      )}

      {/* Error state */}
      {scanState === 'error' && (
        <div style={styles.errorBox}>
          <span style={styles.errorText}>{errorMsg || 'Scan failed — try a clearer photo'}</span>
          {preview && (
            <ScanPreview previewUrl={preview} scanning={false} scannerRef={scannerRef} />
          )}
        </div>
      )}

      {/* Results */}
      {scanState === 'done' && result && (
        <ReceiptBreakdown result={result} onExpenseLogged={onExpenseLogged} />
      )}
    </div>
  );
}

// ─── Scan preview with laser line ─────────────────────────────────────────────

function ScanPreview({
  previewUrl, scanning, scannerRef,
}: {
  previewUrl: string;
  scanning: boolean;
  scannerRef: React.RefObject<HTMLDivElement | null>;
}): React.JSX.Element {
  return (
    <div ref={scannerRef} style={previewStyles.wrap}>
      <img src={previewUrl} alt="Receipt preview" style={previewStyles.img} />
      {scanning && (
        <>
          <div style={previewStyles.overlay} />
          <div style={previewStyles.laser} />
          <div style={{ ...previewStyles.scanLabel, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span aria-hidden="true">✈︎</span> Analysing…
          </div>
        </>
      )}
    </div>
  );
}

// ─── Receipt breakdown ────────────────────────────────────────────────────────

function ReceiptBreakdown({
  result,
  onExpenseLogged,
}: {
  result: ReceiptResult;
  onExpenseLogged?: () => void;
}): React.JSX.Element {
  const { receiptId, receipt, lineItemSumValid, matched, matchedTransactionId, insight } = result;
  const [logState, setLogState] = useState<LogState>('idle');

  async function handleLogExpense(): Promise<void> {
    setLogState('loading');
    try {
      const res = await fetch(`/api/receipt/${receiptId}/log-expense`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setLogState('done');
      onExpenseLogged?.();
    } catch {
      setLogState('error');
    }
  }

  return (
    <div style={breakdownStyles.root}>
      {/* Merchant / meta row */}
      <div style={breakdownStyles.metaRow}>
        <div style={breakdownStyles.metaLeft}>
          <span style={breakdownStyles.merchant}>{receipt.merchant}</span>
          <span style={breakdownStyles.date}>{receipt.date}</span>
        </div>
        <div style={breakdownStyles.metaRight}>
          <CategoryBadge category={receipt.category} />
          <ConfidencePip confidence={receipt.confidence} />
        </div>
      </div>

      {/* Line items */}
      {receipt.lineItems.length > 0 && (
        <div style={breakdownStyles.itemList}>
          {receipt.lineItems.map((item, i) => (
            <LineItemRow key={i} item={item} receiptTotal={receipt.total} />
          ))}
        </div>
      )}

      {/* Total row */}
      <div style={breakdownStyles.totalRow}>
        <span style={breakdownStyles.totalLabel}>Total</span>
        <div style={breakdownStyles.totalRight}>
          {!lineItemSumValid && (
            <span style={breakdownStyles.mismatchBadge}>⚠ sum mismatch</span>
          )}
          <span style={breakdownStyles.totalAmount}>
            {receipt.currency} {receipt.total.toFixed(2)}
          </span>
        </div>
      </div>

      {/* Transaction match */}
      {matched && matchedTransactionId && (
        <div style={breakdownStyles.matchBadge}>
          ✓ Matched to bunq transaction · category updated to <em>{receipt.category}</em>
        </div>
      )}

      {/* BUNQSY insight */}
      {insight && <InsightCard insight={insight} />}

      {/* Action row */}
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        {matched ? (
          <div style={actionStyles.savedBadge}>
            ✓ Saved · transaction categorised as <em>{receipt.category}</em>
          </div>
        ) : logState === 'done' ? (
          <div style={actionStyles.savedBadge}>✓ Logged as expense</div>
        ) : (
          <button
            onClick={() => { void handleLogExpense(); }}
            disabled={logState === 'loading'}
            style={actionStyles.logBtn}
          >
            {logState === 'loading' ? 'Logging…' : logState === 'error' ? '⚠ Retry log' : '+ Log as Expense'}
          </button>
        )}
      </div>
    </div>
  );
}

function LineItemRow({ item, receiptTotal }: { item: LineItem; receiptTotal: number }): React.JSX.Element {
  const fraction = receiptTotal > 0 ? item.total / receiptTotal : 0;
  return (
    <div style={lineStyles.row}>
      <div style={lineStyles.left}>
        {item.quantity !== undefined && item.quantity !== 1 && (
          <span style={lineStyles.qty}>{item.quantity}×</span>
        )}
        <span style={lineStyles.desc}>{item.description}</span>
      </div>
      <div style={lineStyles.right}>
        <div style={lineStyles.bar}>
          <div
            style={{
              ...lineStyles.barFill,
              width: `${fraction * 100}%`,
              background: fraction > 0.5 ? 'var(--color-yellow)' : 'var(--accent-blue)',
            }}
          />
        </div>
        <span style={lineStyles.amount}>{item.total.toFixed(2)}</span>
      </div>
    </div>
  );
}

function CategoryBadge({ category }: { category: ReceiptData['category'] }): React.JSX.Element {
  const ICONS: Record<ReceiptData['category'], string> = {
    groceries:     '🛒',
    dining:        '🍽',
    transport:     '🚌',
    entertainment: '🎭',
    health:        '💊',
    shopping:      '🛍',
    utilities:     '⚡',
    other:         '📦',
  };
  return (
    <span style={breakdownStyles.categoryBadge}>
      {ICONS[category]} {category}
    </span>
  );
}

function ConfidencePip({ confidence }: { confidence: number }): React.JSX.Element {
  const color = confidence >= 0.85 ? 'var(--color-green)'
    : confidence >= 0.6           ? 'var(--color-yellow)'
    : 'var(--color-red)';
  return (
    <span style={{ ...breakdownStyles.confidencePip, color }}>
      {Math.round(confidence * 100)}% conf.
    </span>
  );
}

function InsightCard({ insight }: { insight: string }): React.JSX.Element {
  return (
    <div style={insightStyles.card}>
      <span style={insightStyles.icon}>💡</span>
      <p style={insightStyles.text}>{insight}</p>
    </div>
  );
}

// ─── Image compression ────────────────────────────────────────────────────────

async function compressImage(file: File, maxBytes: number): Promise<File> {
  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;

  // Scale down so the longer edge is ≤ 1920px, which is more than enough for OCR
  const maxEdge = 1920;
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);

  const canvas = document.createElement('canvas');
  canvas.width  = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  // Try decreasing quality until the blob fits
  for (const quality of [0.85, 0.75, 0.65, 0.5]) {
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        b => b ? resolve(b) : reject(new Error('canvas.toBlob returned null')),
        'image/jpeg',
        quality,
      ),
    );
    if (blob.size <= maxBytes) {
      return new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' });
    }
  }

  // Last resort: scale down further to 1280px and retry at 0.7
  const scale2 = Math.min(1, 1280 / Math.max(w, h));
  const canvas2 = document.createElement('canvas');
  canvas2.width  = Math.round(w * scale2);
  canvas2.height = Math.round(h * scale2);
  canvas2.getContext('2d')!.drawImage(canvas, 0, 0, canvas2.width, canvas2.height);
  const finalBlob = await new Promise<Blob>((resolve, reject) =>
    canvas2.toBlob(
      b => b ? resolve(b) : reject(new Error('canvas.toBlob returned null')),
      'image/jpeg',
      0.7,
    ),
  );
  return new File([finalBlob], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' });
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  card: {
    padding: '24px',
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
    animation: 'fadeSlideUp 0.5s 0.3s ease both',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: {
    fontSize: '0.75rem',
    fontWeight: 600,
    letterSpacing: '0.12em',
    textTransform: 'uppercase' as const,
    color: 'var(--text-secondary)',
  },
  resetBtn: {
    background: 'transparent',
    border: '1px solid var(--glass-border)',
    borderRadius: 'var(--radius-sm)',
    color: 'var(--text-secondary)',
    fontSize: '0.7rem',
    padding: '4px 10px',
    cursor: 'pointer',
  },
  dropZone: {
    border: '2px dashed',
    borderRadius: 'var(--radius-md)',
    padding: '32px 16px',
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 8,
    cursor: 'pointer',
    transition: 'var(--transition)',
  },
  dropIcon: { fontSize: '2.2rem', lineHeight: 1 },
  dropText: { fontSize: '0.85rem', color: 'var(--text-secondary)' },
  dropHint: { fontSize: '0.7rem', color: 'var(--text-muted)' },
  errorBox: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 12,
  },
  errorText: {
    fontSize: '0.8rem',
    color: 'var(--color-red)',
    textAlign: 'center' as const,
  },
};

const previewStyles: Record<string, React.CSSProperties> = {
  wrap: {
    position: 'relative',
    borderRadius: 'var(--radius-sm)',
    overflow: 'hidden',
    maxHeight: 220,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--bg-base)',
  },
  img: {
    width: '100%',
    height: '100%',
    objectFit: 'contain',
    maxHeight: 220,
    opacity: 0.85,
  },
  overlay: {
    position: 'absolute',
    inset: 0,
    background: 'rgba(99,102,241,0.06)',
  },
  laser: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 2,
    background: 'linear-gradient(90deg, transparent, var(--hue-orange), transparent)',
    boxShadow: '0 0 12px color-mix(in srgb, var(--hue-orange) 60%, transparent)',
    animation: 'laserScan 1.8s ease-in-out infinite',
  },
  scanLabel: {
    position: 'absolute',
    bottom: 8,
    left: '50%',
    transform: 'translateX(-50%)',
    fontSize: '0.7rem',
    letterSpacing: '0.12em',
    color: 'var(--accent-blue)',
    background: 'rgba(0,0,0,0.7)',
    padding: '3px 10px',
    borderRadius: 12,
  },
};

const breakdownStyles: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    animation: 'fadeSlideUp 0.4s ease both',
  },
  metaRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  metaLeft: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 2,
  },
  merchant: {
    fontSize: '0.95rem',
    fontWeight: 600,
    color: 'var(--text-primary)',
  },
  date: {
    fontSize: '0.7rem',
    color: 'var(--text-muted)',
  },
  metaRight: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'flex-end',
    gap: 4,
  },
  categoryBadge: {
    fontSize: '0.7rem',
    padding: '3px 8px',
    borderRadius: 12,
    background: 'var(--bg-surface-alt)',
    border: '1px solid var(--glass-border)',
    color: 'var(--text-secondary)',
  },
  confidencePip: {
    fontSize: '0.65rem',
    fontWeight: 600,
  },
  itemList: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 4,
    maxHeight: 200,
    overflowY: 'auto' as const,
    paddingRight: 4,
  },
  totalRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: 8,
    borderTop: '1px solid var(--glass-border)',
    marginTop: 4,
  },
  totalLabel: {
    fontSize: '0.82rem',
    fontWeight: 700,
    color: 'var(--text-primary)',
  },
  totalRight: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  mismatchBadge: {
    fontSize: '0.65rem',
    color: 'var(--color-yellow)',
    padding: '2px 6px',
    borderRadius: 8,
    background: 'var(--color-yellow-glow)',
  },
  totalAmount: {
    fontSize: '0.95rem',
    fontWeight: 700,
    color: 'var(--text-primary)',
  },
  matchBadge: {
    fontSize: '0.72rem',
    color: 'var(--color-green)',
    padding: '6px 10px',
    borderRadius: 'var(--radius-sm)',
    background: 'var(--color-green-glow)',
  },
};

const lineStyles: Record<string, React.CSSProperties> = {
  row: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '5px 8px',
    borderRadius: 6,
    background: 'var(--bg-surface)',
  },
  left: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    flex: 1,
    minWidth: 0,
  },
  qty: {
    fontSize: '0.65rem',
    color: 'var(--text-muted)',
    flexShrink: 0,
  },
  desc: {
    fontSize: '0.75rem',
    color: 'var(--text-secondary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  right: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexShrink: 0,
  },
  bar: {
    width: 48,
    height: 3,
    borderRadius: 2,
    background: 'var(--ink-080)',
    overflow: 'hidden',
  },
  barFill: {
    height: '100%',
    borderRadius: 2,
    transition: 'width 0.6s ease',
  },
  amount: {
    fontSize: '0.72rem',
    color: 'var(--text-primary)',
    fontVariantNumeric: 'tabular-nums',
    width: 44,
    textAlign: 'right' as const,
  },
};

const actionStyles: Record<string, React.CSSProperties> = {
  savedBadge: {
    fontSize: '0.72rem',
    color: 'var(--color-green)',
    padding: '6px 10px',
    borderRadius: 'var(--radius-sm)',
    background: 'var(--color-green-glow)',
    flex: 1,
  },
  logBtn: {
    flex: 1,
    padding: '8px 14px',
    borderRadius: 'var(--radius-sm)',
    background: 'rgba(99,102,241,0.1)',
    border: '1px solid rgba(99,102,241,0.3)',
    color: '#818cf8',
    fontSize: '0.78rem',
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: "'Montserrat', sans-serif",
  },
};

const insightStyles: Record<string, React.CSSProperties> = {
  card: {
    display: 'flex',
    gap: 10,
    padding: '12px 14px',
    borderRadius: 'var(--radius-sm)',
    background: 'rgba(251,191,36,0.08)',
    border: '1px solid rgba(251,191,36,0.25)',
    animation: 'fadeSlideUp 0.4s 0.2s ease both',
  },
  icon: { fontSize: '1rem', flexShrink: 0 },
  text: {
    fontSize: '0.78rem',
    lineHeight: 1.55,
    color: 'var(--text-secondary)',
  },
};
