import { toFiniteNumber } from './importerUtils';

export interface PricingCondition {
  actionType: 'fixed_add' | 'percent';
  actionValue: number;
  priceFrom: number;
  priceTo: number | null;
}

export interface PricingContext {
  markupPercent: number;
  minProfitEnabled: boolean;
  minProfitAmount: number;
  ruleSetId: number | null;
  conditions: PricingCondition[];
}

export function computeLegacyPrice(priceBase: number, context: PricingContext | null): number {
  const base = toFiniteNumber(priceBase, 0);
  const percent = toFiniteNumber(context?.markupPercent, 0);
  const minProfitAmount = toFiniteNumber(context?.minProfitAmount, 0);
  const candidate = base * (1 + percent / 100);
  if (context?.minProfitEnabled === true && candidate - base < minProfitAmount) {
    return base + minProfitAmount;
  }
  return candidate;
}

export function computePriceWithMarkup(priceBase: number, context: PricingContext | null): number | null {
  const base = toFiniteNumber(priceBase, 0);
  if (!Number.isFinite(base) || base <= 0) {
    return null;
  }

  const legacy = computeLegacyPrice(base, context);
  if (!context || !context.ruleSetId || !Array.isArray(context.conditions) || !context.conditions.length) {
    return roundTo2(legacy);
  }

  const matched = context.conditions.find((condition) => {
    if (base < condition.priceFrom) {
      return false;
    }
    if (condition.priceTo === null || !Number.isFinite(condition.priceTo)) {
      return true;
    }
    return base < condition.priceTo;
  });

  if (!matched) {
    return roundTo2(legacy);
  }

  if (matched.actionType === 'fixed_add') {
    return roundTo2(base + matched.actionValue);
  }
  if (matched.actionType === 'percent') {
    return roundTo2(base * (1 + matched.actionValue / 100));
  }

  return roundTo2(legacy);
}

export function roundTo2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
