import type { LifeState } from '@/state/life';
import { JOB_SALARY, type JobName } from '@/config/jobs';

export type CreditTierName = 'EXCELLENT' | 'GOOD' | 'FAIR' | 'POOR' | 'BAD';

export interface CreditTier {
  tier: CreditTierName;
  aprAdj: number;
  canLease: boolean;
  color: string;
}

export function calcStartingCredit(age: number, money: number, jobName: string): number {
  let score = 650;
  score += (age - 25) * 6;
  score += Math.min(120, Math.floor(money / 1000) * 8);
  const stableJobs: Record<string, number> = {
    'OFFICE JOB': 40, 'PACKAGE COURIER': 30, 'TRUCK DRIVER': 30, 'FUEL TANKER': 35,
    'PARAMEDIC': 25, 'TRAFFIC COP': 25, 'TOW TRUCK': 15, 'AUTO PARTS RUN': 10,
    'FOOD DELIVERY': -10,
  };
  score += stableJobs[jobName] || 0;
  return Math.max(350, Math.min(850, score));
}

export function getCreditTier(score: number): CreditTier {
  if (score >= 720) return { tier: 'EXCELLENT', aprAdj: -0.005, canLease: true,  color: '#0f0' };
  if (score >= 660) return { tier: 'GOOD',      aprAdj: 0.0,    canLease: true,  color: '#8f0' };
  if (score >= 600) return { tier: 'FAIR',      aprAdj: 0.015,  canLease: false, color: '#ff0' };
  if (score >= 550) return { tier: 'POOR',      aprAdj: 0.03,   canLease: false, color: '#f80' };
  return            { tier: 'BAD',       aprAdj: 0.06,   canLease: false, color: '#f44' };
}

export interface CreditLogEntry {
  day: number;
  delta: number;
  reason: string;
  score: number;
}

export function adjustCredit(life: LifeState, delta: number, reason: string): number {
  if (typeof life.creditScore !== 'number') life.creditScore = 650;
  const old = life.creditScore as number;
  life.creditScore = Math.max(300, Math.min(850, (life.creditScore as number) + delta));
  const actual = (life.creditScore as number) - old;
  if (actual !== 0) {
    if (!life._creditLog) life._creditLog = [];
    const log = life._creditLog as CreditLogEntry[];
    log.unshift({ day: life.day, delta: actual, reason, score: life.creditScore as number });
    if (log.length > 10) log.length = 10;
  }
  return life.creditScore as number;
}

export function approxMonthlyIncome(jobName: JobName | string): number {
  return ((JOB_SALARY as Record<string, number>)[jobName] || 0) * 20;
}
