import React, { useState, useEffect } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from 'recharts';
import type { PLReport } from '@bunqsy/shared';

function categoryLabel(cat: string): string {
  return cat.replace(/_/g, ' ').replace(/^(BIZ|PERSONAL|INCOME|TRANSFER|TAX) /i, '')
    .toLowerCase().replace(/\b\w/g, c => c.toUpperCase()).slice(0, 16);
}

function MetricCard({ label, value, color }: { label: string; value: number; color: string }): React.JSX.Element {
  const sign = value >= 0 ? '' : '-';
  return (
    <div style={{
      background: 'var(--ink-025)', border: `1px solid color-mix(in srgb, ${color} 16%, transparent)`,
      borderRadius: '14px', padding: '16px 18px', flex: 1,
    }}>
      <div style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.10em', textTransform: 'uppercase', color: 'var(--ink-350)', marginBottom: '8px' }}>
        {label}
      </div>
      <div style={{ fontSize: '20px', fontWeight: 800, color, letterSpacing: '-0.02em', fontFamily: "'Montserrat', sans-serif" }}>
        {sign}€{Math.abs(value).toFixed(2)}
      </div>
    </div>
  );
}

export function ProfitAndLoss(): React.JSX.Element {
  const [pl, setPl]         = useState<PLReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [year]              = useState(new Date().getFullYear());

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`/api/bookkeeping/pl?start=${year}-01-01&end=${year}-12-31`);
        if (res.ok) setPl(await res.json() as PLReport);
      } catch { /* daemon offline */ }
      setLoading(false);
    })();
  }, [year]);

  if (loading) {
    return (
      <div style={cardStyle}>
        <div style={{ padding: '40px', textAlign: 'center', color: 'var(--ink-300)', fontSize: '13px' }}>
          Loading P&L…
        </div>
      </div>
    );
  }

  if (!pl) {
    return (
      <div style={cardStyle}>
        <div style={sectionLabelStyle}>Profit & Loss</div>
        <div style={{ marginTop: '12px', fontSize: '12px', color: 'var(--ink-300)', fontStyle: 'italic' }}>
          No data yet. Transactions will appear here after auto-categorization runs.
        </div>
      </div>
    );
  }

  const top8Expenses = [...pl.expenseLines]
    .filter(l => l.amountEur > 0)
    .sort((a, b) => b.amountEur - a.amountEur)
    .slice(0, 8)
    .map(l => ({ name: categoryLabel(l.category), amount: l.amountEur }));

  const profitColor = pl.netProfit >= 0 ? 'var(--accent-green)' : '#ff1500';

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <div>
          <div style={sectionLabelStyle}>Profit & Loss</div>
          <div style={{ fontSize: '11px', color: 'var(--ink-350)', marginTop: '2px' }}>
            YTD {year} · {pl.periodStart} – {pl.periodEnd}
          </div>
        </div>
      </div>

      {/* KPI row */}
      <div style={{ display: 'flex', gap: '10px', marginBottom: '20px' }}>
        <MetricCard label="Revenue"   value={pl.totalIncome}    color="var(--accent-green)" />
        <MetricCard label="Expenses"  value={pl.totalExpenses}  color="var(--hue-orange)" />
        <MetricCard label="Net Profit" value={pl.netProfit}     color={profitColor} />
      </div>

      {/* Deductibility row */}
      <div style={{ display: 'flex', gap: '10px', marginBottom: '20px' }}>
        <div style={{
          flex: 1, background: 'rgba(0,191,255,0.04)', border: '1px solid rgba(0,191,255,0.12)',
          borderRadius: '12px', padding: '12px 14px',
        }}>
          <div style={{ fontSize: '10px', color: 'var(--ink-350)', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '4px' }}>
            Deductible
          </div>
          <div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--accent-cyan)' }}>
            €{pl.deductibleExpenses.toFixed(2)}
          </div>
        </div>
        <div style={{
          flex: 1, background: 'var(--ink-025)', border: '1px solid var(--ink-060)',
          borderRadius: '12px', padding: '12px 14px',
        }}>
          <div style={{ fontSize: '10px', color: 'var(--ink-350)', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '4px' }}>
            Personal spend
          </div>
          <div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--ink-550)' }}>
            €{pl.nonDeductibleExpenses.toFixed(2)}
          </div>
          <div style={{ fontSize: '9px', color: 'var(--ink-220)', marginTop: 2 }}>not tax-deductible</div>
        </div>
      </div>

      {/* Expense breakdown chart */}
      {top8Expenses.length > 0 && (
        <div>
          <div style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.10em', textTransform: 'uppercase', color: 'var(--ink-300)', marginBottom: '10px' }}>
            Top Expense Categories
          </div>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={top8Expenses} margin={{ top: 0, right: 0, bottom: 0, left: 0 }} barSize={16}>
              <XAxis dataKey="name" tick={{ fontSize: 9, fill: 'var(--ink-350)' }} axisLine={false} tickLine={false} />
              <YAxis hide />
              <Tooltip
                contentStyle={{ background: 'var(--bg-elevated)', border: '1px solid var(--ink-100)', borderRadius: '8px', fontSize: '11px' }}
                formatter={(val: unknown) => [`€${Number(val).toFixed(2)}`, 'Amount']}
                labelStyle={{ color: 'var(--ink-600)' }}
                itemStyle={{ color: 'var(--text-primary)' }}
              />
              <Bar dataKey="amount" radius={[4, 4, 0, 0]}>
                {top8Expenses.map((_, i) => (
                  <Cell key={i} fill={`hsl(${200 + i * 20}, 80%, 55%)`} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  background: 'var(--ink-040)',
  border: '1px solid var(--ink-080)',
  borderRadius: '20px',
  padding: '24px',
};

const sectionLabelStyle: React.CSSProperties = {
  fontSize: '11px', fontWeight: 700, letterSpacing: '0.10em',
  textTransform: 'uppercase', color: 'var(--ink-450)',
};
