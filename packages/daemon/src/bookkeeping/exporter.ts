import type Database from 'better-sqlite3';

interface JournalRow {
  date: string;
  description: string | null;
  amount_cents: number;
  vat_amount_cents: number;
  category: string;
  debit_account: string;
  credit_account: string;
  is_business_expense: number;
  counterparty_name: string | null;
}

export function exportToCSV(
  db: Database.Database,
  startDate: string,
  endDate: string,
): string {
  const rows = db.prepare(`
    SELECT j.date, j.description, j.amount_cents, j.vat_amount_cents,
           j.category, j.debit_account, j.credit_account, j.is_business_expense,
           t.counterparty_name
    FROM journal_entries j
    LEFT JOIN transactions t ON t.id = j.tx_id
    WHERE j.date BETWEEN ? AND ?
    ORDER BY j.date DESC
  `).all(startDate, endDate) as JournalRow[];

  const headers = [
    'Date', 'Counterparty', 'Description', 'Amount (EUR)', 'VAT (EUR)',
    'Category', 'Debit Account', 'Credit Account', 'Business Expense',
  ];

  const lines = [headers.join(',')];
  for (const row of rows) {
    const fields = [
      row.date,
      escapeCSV(row.counterparty_name ?? ''),
      escapeCSV(row.description ?? ''),
      (row.amount_cents / 100).toFixed(2),
      (row.vat_amount_cents / 100).toFixed(2),
      row.category,
      row.debit_account,
      row.credit_account,
      row.is_business_expense ? 'YES' : 'NO',
    ];
    lines.push(fields.join(','));
  }

  return lines.join('\r\n');
}

/**
 * CSV escaping *and* formula-injection neutralisation.
 *
 * Counterparty names and descriptions come from the payment network and from
 * Claude's receipt OCR — both attacker-influenced. A merchant called
 * `=HYPERLINK("http://evil","refund")` or `@SUM(1+1)*cmd|'/c calc'!A1` executes
 * when the accountant opens the export in Excel/Sheets/LibreOffice
 * (CWE-1236). Prefixing with a single quote makes the cell inert text, and
 * control characters are stripped so a value cannot forge new rows.
 */
export function escapeCSV(value: string): string {
  const cleaned = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  const neutralised = /^[=+\-@\t\r]/.test(cleaned) ? `'${cleaned}` : cleaned;

  if (/[",\n\r]/.test(neutralised)) {
    return `"${neutralised.replace(/"/g, '""')}"`;
  }
  return neutralised;
}

/** MT940 is newline-delimited: strip anything that could forge a field or record. */
export function mt940Field(value: string): string {
  return value.replace(/[\r\n:]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 64) || 'UNKNOWN';
}

export function exportToMT940(
  db: Database.Database,
  startDate: string,
  endDate: string,
  iban: string,
): string {
  const rows = db.prepare(`
    SELECT j.date, j.description, j.amount_cents, t.counterparty_name,
           t.counterparty_iban, j.category
    FROM journal_entries j
    LEFT JOIN transactions t ON t.id = j.tx_id
    WHERE j.date BETWEEN ? AND ?
    ORDER BY j.date ASC
  `).all(startDate, endDate) as (JournalRow & { counterparty_iban: string | null })[];

  // Opening balance
  const openingRow = db.prepare(`
    SELECT COALESCE(SUM(amount_cents), 0) as total
    FROM journal_entries j
    WHERE j.date < ?
  `).get(startDate) as { total: number };

  const openingBalance = openingRow.total / 100;

  const formatDate = (iso: string) =>
    iso.replace(/-/g, '').slice(2, 8); // YYMMDD

  const lines: string[] = [];
  lines.push(`:20:BUNQSY-EXPORT`);
  lines.push(`:25:${iban}`);
  lines.push(`:28C:00001/001`);

  const sign = openingBalance >= 0 ? 'C' : 'D';
  lines.push(`:60F:${sign}${formatDate(startDate)}EUR${Math.abs(openingBalance).toFixed(2)}`);

  let runningBalance = openingBalance;
  for (const row of rows) {
    const amount = row.amount_cents / 100;
    const cr = amount >= 0 ? 'C' : 'D';
    const absAmount = Math.abs(amount).toFixed(2);
    const dateStr   = formatDate(row.date);
    lines.push(`:61:${dateStr}${dateStr}${cr}${absAmount}NONREF`);
    lines.push(`:86:${mt940Field(row.category)}/${mt940Field(row.counterparty_name ?? 'UNKNOWN')}`);
    runningBalance += amount;
  }

  const closingSign = runningBalance >= 0 ? 'C' : 'D';
  lines.push(`:62F:${closingSign}${formatDate(endDate)}EUR${Math.abs(runningBalance).toFixed(2)}`);
  lines.push('-');

  return lines.join('\r\n');
}

export function generateTaxPackage(
  db: Database.Database,
  year: number,
  iban: string,
): { csv: string; mt940: string } {
  const start = `${year}-01-01`;
  const end   = `${year}-12-31`;
  return {
    csv:   exportToCSV(db, start, end),
    mt940: exportToMT940(db, start, end, iban),
  };
}
