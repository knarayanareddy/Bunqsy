import type { OracleVote, OracleVerdict } from '@bunqsy/shared';

export function aggregate(votes: OracleVote[]): OracleVerdict {
  if (votes.length === 0) {
    return {
      votes:              [],
      aggregateRiskScore: 0,
      shouldIntervene:    false,
      rationale:          'No oracle agents returned votes',
    };
  }

  const sum = votes.reduce((s, v) => s + v.riskScore, 0);
  const aggregateRiskScore = Math.round(sum / votes.length);

  // Any agent voting shouldIntervene, combined with aggregate >= 50, triggers action.
  // "Opportunity" intervention types (positive signals like jar sweeps) bypass
  // the aggregate threshold — they should fire even when overall risk is low.
  const OPPORTUNITY_TYPES = new Set(['JAR_SWEEP']);
  const interventionVotes = votes.filter((v) => v.shouldIntervene);
  const hasOpportunityVote = interventionVotes.some(v => OPPORTUNITY_TYPES.has(v.suggestedType ?? ''));
  // High-risk single-agent veto: a single agent at >=85 can trigger even when mean <50.
  // Prevents a lone Fraud Shadow at 92 being muted by 6× CLEAR at 10 (mean ~22).
  const hasHighRiskVeto = interventionVotes.some(v => v.riskScore >= 85);
  const shouldIntervene = interventionVotes.length > 0 &&
    (aggregateRiskScore >= 50 || hasOpportunityVote || hasHighRiskVeto);

  // Highest-risk intervention vote determines the suggested type
  const triggerVote = [...interventionVotes].sort((a, b) => b.riskScore - a.riskScore)[0];

  // Top 3 agents by risk score form the rationale
  const topVotes = [...votes].sort((a, b) => b.riskScore - a.riskScore).slice(0, 3);
  const rationale = topVotes
    .map((v) => `${v.agentId}(${v.riskScore}): ${v.rationale}`)
    .join(' | ');

  return {
    votes,
    aggregateRiskScore,
    shouldIntervene,
    interventionType: triggerVote?.suggestedType,
    rationale,
  };
}
